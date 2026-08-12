import { z } from 'zod';
import { requirePermission, requireUser } from '@/lib/auth/session';
import { handleRouteError, json, rateLimit } from '@/lib/api';
import { answerCase, askCase, resolveCase, sweepConsistency } from '@/lib/manager/cases';
import { applyForCase, enforceIntervention, liftIntervention, overrideIntervention } from '@/lib/manager/interventions';
import { closeBreaker, evaluateBreakers } from '@/lib/manager/breakers';
import { acknowledgeReadiness, recordReadiness } from '@/lib/manager/readiness';
import { generateBrief } from '@/lib/manager/brief';
import { audit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/**
 * The System Manager's write surface.
 *
 * The permissions here are the argument of the whole layer, so they are worth
 * setting out:
 *
 *   A caller may see and answer a question about their own work, and may run
 *   their own readiness check. Nothing else. Answering is deliberately open to
 *   them, because the person who was on the call is the cheapest and most
 *   accurate source of the explanation, and a process that collects evidence
 *   about somebody without ever asking them is not an investigation.
 *
 *   Resolving a case — the only path in this codebase by which anything becomes
 *   somebody's fault — needs `analytics.caller.read.all`, the supervisor
 *   permission. No rule can reach it.
 *
 *   Enforcing an intervention needs the same, except for the two rungs that
 *   touch a person's standing rather than their workflow, which need
 *   `admin.config` and are checked separately below.
 *
 *   Running the sweep and closing a breaker are operational, and need
 *   `admin.config`.
 */

const Sweep = z.object({ action: z.literal('sweep'), lookbackDays: z.number().int().min(1).max(90).optional() });
const Ask = z.object({ action: z.literal('ask_case'), caseId: z.string().min(1) });
const Answer = z.object({ action: z.literal('answer_case'), caseId: z.string().min(1), answer: z.string().min(1).max(4000) });
const Resolve = z.object({
  action: z.literal('resolve_case'),
  caseId: z.string().min(1),
  state: z.enum(['EXPLAINED', 'SYSTEM_FAULT', 'CONFIRMED', 'DISMISSED']),
  resolution: z.string().min(1).max(2000),
});
const Apply = z.object({
  action: z.literal('apply_intervention'),
  caseId: z.string().min(1),
  rung: z.enum([
    'INLINE_GUIDANCE', 'REQUIRED_CORRECTION', 'MICRO_COACHING', 'WARNING',
    'RESTRICTED_MODE', 'CAPABILITY_PAUSE', 'SECURITY_RESTRICTION', 'OWNER_ESCALATION',
  ]).optional(),
});
const Enforce = z.object({
  action: z.literal('enforce_intervention'),
  interventionId: z.string().min(1),
  note: z.string().max(1000).optional(),
});
const Lift = z.object({
  action: z.literal('lift_intervention'),
  interventionId: z.string().min(1),
  because: z.string().min(1).max(2000),
  evidence: z.array(z.object({ label: z.string().max(200), ref: z.string().max(200) })).max(20).optional(),
});
const Override = z.object({
  action: z.literal('override_intervention'),
  interventionId: z.string().min(1),
  reason: z.string().min(1).max(2000),
  withdraw: z.boolean().optional(),
});
const CloseBreaker = z.object({
  action: z.literal('close_breaker'),
  breakerId: z.string().min(1),
  because: z.string().min(1).max(2000),
});
const Readiness = z.object({ action: z.literal('readiness') });
const Acknowledge = z.object({ action: z.literal('acknowledge_readiness') });
const Brief = z.object({ action: z.literal('brief'), period: z.enum(['DAILY', 'WEEKLY']).optional() });

const Schema = z.discriminatedUnion('action', [
  Sweep, Ask, Answer, Resolve, Apply, Enforce, Lift, Override, CloseBreaker, Readiness, Acknowledge, Brief,
]);

/** Rungs an owner alone may switch on, whatever the operating rules say. */
const OWNER_ONLY = new Set(['SECURITY_RESTRICTION', 'OWNER_ESCALATION']);

export async function POST(request: Request) {
  try {
    // Authenticated before the body is read, so an anonymous request cannot
    // learn the route exists from the shape of a validation error.
    await requireUser();
    const body = Schema.parse(await request.json());

    // A caller's own two actions. Everything else is a supervisor's.
    const own = body.action === 'answer_case'
      || body.action === 'readiness'
      || body.action === 'acknowledge_readiness';

    const operational = body.action === 'sweep'
      || body.action === 'close_breaker'
      || body.action === 'brief';

    const user = own
      ? await requirePermission('call.place')
      : operational
        ? await requirePermission('admin.config')
        : await requirePermission('analytics.caller.read.all');

    await rateLimit(`manager:${user.id}`, 120, 60_000);

    switch (body.action) {
      case 'sweep': {
        const result = await sweepConsistency({ orgId: user.orgId, lookbackDays: body.lookbackDays });
        await audit({
          orgId: user.orgId, userId: user.id, action: 'manager.sweep',
          entityType: 'Organization', entityId: user.orgId, metadata: { ...result },
        });
        return json({ ok: true, ...result });
      }

      case 'ask_case': {
        const result = await askCase({ orgId: user.orgId, caseId: body.caseId });
        if (!result.ok) return json({ error: result.message }, 409);
        return json({ ok: true });
      }

      case 'answer_case': {
        // Scoped to their own case. A caller answering somebody else's is a
        // 404, not a 403 — the existence of a case about another person is
        // itself information they should not have.
        const result = await answerCase({
          orgId: user.orgId, caseId: body.caseId, callerId: user.id, answer: body.answer,
        });
        if (!result.ok) return json({ error: result.message }, 404);
        return json({ ok: true });
      }

      case 'resolve_case': {
        const result = await resolveCase({
          orgId: user.orgId, caseId: body.caseId, resolvedById: user.id,
          state: body.state, resolution: body.resolution,
        });
        if (!result.ok) return json({ error: result.message }, 409);
        return json({ ok: true });
      }

      case 'apply_intervention': {
        if (body.rung && OWNER_ONLY.has(body.rung)) {
          await requirePermission('admin.config');
        }
        const result = await applyForCase({
          orgId: user.orgId, caseId: body.caseId, overrideRung: body.rung, actorId: user.id,
        });
        return json({
          ok: result.applied,
          message: result.message,
          intervention: result.intervention,
          recommendation: result.recommendation,
        }, result.applied ? 200 : 409);
      }

      case 'enforce_intervention': {
        // Whether this needs the owner depends on the rung, which is on the
        // row rather than in the request — so the check happens inside, with
        // the authority this session actually holds handed to it.
        const owner = await hasOwnerAuthority();
        const result = await enforceIntervention({
          orgId: user.orgId, interventionId: body.interventionId, actorId: user.id,
          authority: owner ? 'owner' : 'manager', note: body.note,
        });
        return json(result.ok ? { ok: true, message: result.message } : { error: result.message }, result.ok ? 200 : 409);
      }

      case 'lift_intervention': {
        const result = await liftIntervention({
          orgId: user.orgId, interventionId: body.interventionId, actorId: user.id,
          because: body.because, evidence: body.evidence,
        });
        return json(result.ok ? { ok: true, message: result.message } : { error: result.message }, result.ok ? 200 : 409);
      }

      case 'override_intervention': {
        const result = await overrideIntervention({
          orgId: user.orgId, interventionId: body.interventionId, actorId: user.id,
          reason: body.reason, withdraw: body.withdraw,
        });
        return json(result.ok ? { ok: true, message: result.message } : { error: result.message }, result.ok ? 200 : 409);
      }

      case 'close_breaker': {
        const result = await closeBreaker({
          orgId: user.orgId, breakerId: body.breakerId, actorId: user.id, because: body.because,
        });
        return json(result.ok ? { ok: true, message: result.message } : { error: result.message }, result.ok ? 200 : 409);
      }

      case 'readiness': {
        const { readiness } = await recordReadiness({ orgId: user.orgId, callerId: user.id });
        return json({ ok: true, readiness });
      }

      case 'acknowledge_readiness': {
        const result = await acknowledgeReadiness({ orgId: user.orgId, callerId: user.id });
        if (!result.ok) return json({ error: 'There is no readiness check to acknowledge today. Run one first.' }, 409);
        return json({ ok: true });
      }

      case 'brief': {
        const brief = await generateBrief({ orgId: user.orgId, period: body.period ?? 'DAILY' });
        return json({ ok: true, briefId: brief.id, headline: brief.headline });
      }
    }
  } catch (error) {
    return handleRouteError(error);
  }
}

/** True when this session may apply the two owner-only rungs. */
async function hasOwnerAuthority(): Promise<boolean> {
  try {
    await requirePermission('admin.config');
    return true;
  } catch {
    return false;
  }
}

/** Evaluate the circuit breakers. Called by the cron, and by the manager page. */
export async function PUT() {
  try {
    const user = await requirePermission('admin.config');
    await rateLimit(`manager.breakers:${user.id}`, 30, 60_000);
    const result = await evaluateBreakers({ orgId: user.orgId });
    return json({ ok: true, opened: result.opened, closed: result.closed, readings: result.readings });
  } catch (error) {
    return handleRouteError(error);
  }
}
