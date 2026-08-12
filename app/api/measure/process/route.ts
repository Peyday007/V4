import { z } from 'zod';
import { requirePermission, requireUser } from '@/lib/auth/session';
import { handleRouteError, json, rateLimit } from '@/lib/api';
import { publishVersion, rollbackTo, preview, validateBody, versionHistory } from '@/lib/measure/versions';

export const dynamic = 'force-dynamic';

/**
 * The prompt, script and copy editor.
 *
 * `admin.config`, because a version published here influences every piece of
 * work that reads it. The refusals are the interesting part: an undeclared
 * variable or an instruction that tries to move a compliance rule is rejected
 * at save time with the reasons listed, rather than accepted and discovered in
 * front of a buyer.
 */
const Publish = z.object({
  action: z.literal('publish'),
  kind: z.enum(['CALL_SCRIPT', 'OUTREACH_COPY', 'PROOF_STEP_POLICY', 'BRIEF_PROMPT', 'SUMMARY_PROMPT']),
  key: z.string().min(1).max(80),
  label: z.string().min(1).max(200),
  body: z.string().min(1).max(20_000),
  declaredVariables: z.array(z.string().max(60)).max(40).default([]),
  notes: z.string().max(2000).optional(),
  activate: z.boolean().default(false),
});

const Check = z.object({
  action: z.literal('check'),
  body: z.string().max(20_000),
  declaredVariables: z.array(z.string().max(60)).max(40).default([]),
  examples: z.record(z.string().max(200)).optional(),
});

const Rollback = z.object({ action: z.literal('rollback'), versionId: z.string().min(1) });

const History = z.object({
  action: z.literal('history'),
  kind: z.enum(['CALL_SCRIPT', 'OUTREACH_COPY', 'PROOF_STEP_POLICY', 'BRIEF_PROMPT', 'SUMMARY_PROMPT']),
  key: z.string().min(1).max(80),
});

const Schema = z.discriminatedUnion('action', [Publish, Check, Rollback, History]);

export async function POST(request: Request) {
  try {
    await requireUser();
    const body = Schema.parse(await request.json());
    const user = await requirePermission('admin.config');
    await rateLimit(`measure.process:${user.id}`, 120, 60_000);

    if (body.action === 'check') {
      // Never writes. This is the preview: it renders with labelled example
      // data so nobody can mistake a preview for real content.
      return json({
        ok: true,
        problems: validateBody(body.body, body.declaredVariables),
        preview: preview(body.body, body.examples ?? {}),
      });
    }

    if (body.action === 'publish') {
      const { action, ...rest } = body;
      void action;
      const result = await publishVersion({ ...rest, orgId: user.orgId, actorId: user.id });
      if (!result.ok) return json({ error: result.message, kind: result.kind, detail: result.detail }, 422);
      return json({ ok: true, version: result.version });
    }

    if (body.action === 'rollback') {
      const result = await rollbackTo({ orgId: user.orgId, versionId: body.versionId, actorId: user.id });
      if (!result.ok) {
        return json({ error: result.message, kind: result.kind }, result.kind === 'not_found' ? 404 : 409);
      }
      return json({ ok: true, version: result.version });
    }

    const history = await versionHistory({ orgId: user.orgId, kind: body.kind, key: body.key });
    return json({ ok: true, history });
  } catch (error) {
    return handleRouteError(error);
  }
}
