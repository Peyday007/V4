import { z } from 'zod';
import { handleRouteError, json, rateLimit } from '@/lib/api';
import { requirePermission, requireUser } from '@/lib/auth/session';
import {
  createCaller, deactivateCaller, reactivateCaller, roster, updateCaller,
} from '@/lib/caller/roster';
import { CallerAuthError, issuePin, revokePin } from '@/lib/caller/identity';
import { confirmAssignment, previewAssignment } from '@/lib/caller/assignment';
import { ensureSandbox, resetSandbox, sandboxState } from '@/lib/caller/sandbox';
import { audit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/**
 * The owner's side of the calling floor.
 *
 * Every action here is a management action, and the permission is checked
 * server-side before anything is read or written. That matters more than usual
 * because the old page's protection was largely that a caller had no button:
 * the underlying `/api/work/pin` endpoint would happily create a caller profile
 * for any user id somebody put in a request body. Hiding a control is not a
 * permission, and this file is written as though the UI does not exist.
 *
 * Two permissions, deliberately different:
 *
 *   `admin.users` — creating people, changing their status, and handing over or
 *   taking away credentials. These change who can sign in.
 *
 *   `call.assignment.write` — handing out work. A deal manager schedules the
 *   floor without being able to mint logins.
 */

const Create = z.object({
  action: z.literal('create'),
  name: z.string().min(2).max(120),
  email: z.string().min(5).max(200),
  mode: z.enum(['PRODUCTION', 'TEST']).optional(),
  timezone: z.string().max(60).optional(),
  label: z.string().max(200).nullable().optional(),
  active: z.boolean().optional(),
});

const Update = z.object({
  action: z.literal('update'),
  callerId: z.string().min(1),
  name: z.string().min(2).max(120).optional(),
  label: z.string().max(200).nullable().optional(),
  timezone: z.string().max(60).optional(),
});

const SetStatus = z.object({
  action: z.enum(['deactivate', 'reactivate']),
  callerId: z.string().min(1),
  reason: z.string().max(500).optional(),
});

const Pin = z.object({
  action: z.enum(['issue_pin', 'revoke_pin']),
  callerId: z.string().min(1),
});

const Preview = z.object({
  action: z.literal('preview_assignment'),
  callerId: z.string().min(1),
  requested: z.number().int().min(1).max(200),
});

const Assign = z.object({
  action: z.literal('assign'),
  callerId: z.string().min(1),
  /** The exact routes the owner was shown. Never a count. */
  routeIds: z.array(z.string().min(1)).min(1).max(200),
  name: z.string().max(200).optional(),
});

const Sandbox = z.object({
  action: z.enum(['sandbox_create', 'sandbox_reset']),
});

const Schema = z.discriminatedUnion('action', [
  Create, Update, SetStatus, Pin, Preview, Assign, Sandbox,
]);

/** Actions that change who can sign in. */
const IDENTITY_ACTIONS = new Set([
  'create', 'update', 'deactivate', 'reactivate', 'issue_pin', 'revoke_pin', 'sandbox_create', 'sandbox_reset',
]);

export async function POST(request: Request) {
  try {
    // Authenticated before the body is parsed, so an anonymous request cannot
    // learn this route exists from the shape of a validation error.
    await requireUser();
    const parsed = Schema.safeParse(await request.json());
    if (!parsed.success) {
      return json({ error: parsed.error.issues[0]?.message ?? 'That request does not make sense.' }, 400);
    }
    const body = parsed.data;

    const user = IDENTITY_ACTIONS.has(body.action)
      ? await requirePermission('admin.users')
      : await requirePermission('call.assignment.write');

    await rateLimit(`callers:${user.id}`, 120, 60_000);

    switch (body.action) {
      case 'create': {
        const result = await createCaller({
          orgId: user.orgId, actorId: user.id,
          name: body.name, email: body.email, mode: body.mode,
          timezone: body.timezone, label: body.label, active: body.active,
        });
        if (!result.ok) return json({ error: result.message, field: result.field }, 409);
        return json({ ok: true, callerId: result.callerId });
      }

      case 'update': {
        const result = await updateCaller({
          orgId: user.orgId, actorId: user.id, callerId: body.callerId,
          name: body.name, label: body.label, timezone: body.timezone,
        });
        return json(result.ok ? { ok: true } : { error: result.message }, result.ok ? 200 : 409);
      }

      case 'deactivate': {
        const result = await deactivateCaller({
          orgId: user.orgId, actorId: user.id, callerId: body.callerId, reason: body.reason,
        });
        if (!result.ok) return json({ error: result.message }, 409);
        return json({
          ok: true,
          released: result.released,
          message: `Access revoked and ${result.released} unworked opportunit${result.released === 1 ? 'y' : 'ies'} returned to the pool. Their calls, notes and history are untouched.`,
        });
      }

      case 'reactivate': {
        const result = await reactivateCaller({
          orgId: user.orgId, actorId: user.id, callerId: body.callerId,
        });
        return json(
          result.ok
            ? { ok: true, message: 'Back on the floor. They still need a PIN before they can sign in.' }
            : { error: result.message },
          result.ok ? 200 : 409,
        );
      }

      case 'issue_pin': {
        const result = await issuePin({
          orgId: user.orgId, userId: body.callerId, issuedByUserId: user.id,
        });
        // The one moment the plaintext exists outside the caller's head. It is
        // returned, never logged, never stored, and never readable again.
        return json({
          ok: true,
          pin: result.pin,
          issuedAt: result.issuedAt.toISOString(),
          note: 'Give this to them now. Nobody — including you — can read it again. If it is lost, issue a new one.',
        });
      }

      case 'revoke_pin': {
        await revokePin({ orgId: user.orgId, userId: body.callerId, revokedByUserId: user.id });
        return json({ ok: true, message: 'That PIN stops working immediately. Their history is untouched.' });
      }

      case 'preview_assignment': {
        // A read. Nothing here consumes an opportunity or claims one, so an
        // owner can look as many times as they like.
        const preview = await previewAssignment({
          orgId: user.orgId, callerId: body.callerId, requested: body.requested,
        });
        if ('error' in preview) return json({ error: preview.error }, 409);
        return json({ ok: true, preview });
      }

      case 'assign': {
        const result = await confirmAssignment({
          orgId: user.orgId, actorId: user.id, callerId: body.callerId,
          routeIds: body.routeIds, name: body.name,
        });
        if (!result.ok) return json({ error: result.error }, 409);
        return json({ ok: true, plan: result.plan, dropped: result.dropped });
      }

      case 'sandbox_create': {
        const state = await ensureSandbox({ orgId: user.orgId, actorId: user.id });
        return json({ ok: true, sandbox: state });
      }

      case 'sandbox_reset': {
        const state = await resetSandbox({ orgId: user.orgId, actorId: user.id });
        await audit({
          orgId: user.orgId, userId: user.id, action: 'sandbox.reset_requested',
          entityType: 'Organization', entityId: user.orgId,
        });
        return json({
          ok: true,
          sandbox: state,
          message: 'Sandbox back to its starting state. Only test records were touched — production data is a different mode and cannot be reached from here.',
        });
      }
    }
  } catch (error) {
    if (error instanceof CallerAuthError) return json({ error: error.message }, error.statusCode);
    return handleRouteError(error);
  }
}

/** The floor, for anybody who may see who is calling. */
export async function GET(request: Request) {
  try {
    const user = await requirePermission('call.assignment.read.all');
    const url = new URL(request.url);
    const includeInactive = url.searchParams.get('inactive') === 'true';

    const [callers, sandbox] = await Promise.all([
      roster({ orgId: user.orgId, includeInactive }),
      sandboxState(user.orgId),
    ]);

    // No PIN, no hash, no token. The roster type has no field that could hold
    // one, which is the point.
    return json({ callers, sandbox });
  } catch (error) {
    return handleRouteError(error);
  }
}
