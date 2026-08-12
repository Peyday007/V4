import { z } from 'zod';
import { prisma } from '@/lib/db';
import { can, requirePermission, requireUser } from '@/lib/auth/session';
import { handleRouteError, json, rateLimit } from '@/lib/api';
import { reviewInsight } from '@/lib/calls/analysis';
import { completeReview, openReviewIfNeeded } from '@/lib/calls/review';
import { audit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/**
 * Reviewing what the analysis concluded.
 *
 * Judging a review needs `analytics.caller.read.all`, not the transcript
 * permission. That looked like the obvious gate and was wrong: callers hold
 * `call.transcript.read` so they can read their own calls, and the review queue
 * carries script observations about *other* callers — conclusions that feed
 * performance and standing. A caller reading those is the same disclosure as
 * handing them everybody's appraisal.
 *
 * Flagging is different and deliberately stays open to callers, scoped to their
 * own call. Somebody who thinks the analysis got their call wrong should be
 * able to say so; that is the cheapest correction signal this system has.
 *
 * Corrections are stored beside the original rather than over it. What the
 * analysis said is the only signal that says whether auto-fill is worth
 * keeping, and overwriting it would destroy the measurement while looking tidy.
 */
const Decide = z.object({
  action: z.literal('decide'),
  insightId: z.string().min(1),
  decision: z.enum(['CONFIRMED', 'CORRECTED', 'REJECTED']),
  correctedValue: z.string().max(2000).optional(),
  note: z.string().max(2000).optional(),
});

const Complete = z.object({
  action: z.literal('complete'),
  sessionId: z.string().min(1),
  notes: z.string().max(4000).optional(),
  abandoned: z.boolean().optional(),
});

const Flag = z.object({
  action: z.literal('flag'),
  sessionId: z.string().min(1),
});

const Schema = z.discriminatedUnion('action', [Decide, Complete, Flag]);

export async function POST(request: Request) {
  try {
    await requireUser();
    const body = Schema.parse(await request.json());

    // Flagging your own call is not the same act as judging somebody's work.
    const user = body.action === 'flag'
      ? await requirePermission('call.place')
      : await requirePermission('analytics.caller.read.all');
    await rateLimit(`calls.review:${user.id}`, 240, 60_000);

    if (body.action === 'decide') {
      const result = await reviewInsight({
        orgId: user.orgId,
        insightId: body.insightId,
        decision: body.decision,
        correctedValue: body.correctedValue,
        note: body.note,
        reviewerId: user.id,
      });
      if (!result.ok) return json({ error: result.message }, 409);
      await audit({
        orgId: user.orgId, userId: user.id, action: `call.insight_${body.decision.toLowerCase()}`,
        entityType: 'CallInsight', entityId: body.insightId,
      });
      return json({ ok: true });
    }

    if (body.action === 'flag') {
      // Their own call, or one they supervise. A caller flagging somebody
      // else's session would be able to enumerate which sessions exist.
      const session = await prisma.callSession.findFirst({
        where: { id: body.sessionId, orgId: user.orgId },
        select: { callerId: true },
      });
      const supervises = can(user, 'analytics.caller.read.all');
      if (!session || (!supervises && session.callerId !== user.id)) {
        return json({ error: 'That call is not one you can flag.' }, 404);
      }

      const result = await openReviewIfNeeded({
        orgId: user.orgId, sessionId: body.sessionId, flagged: true,
      });
      return json({ ok: true, opened: result.opened, because: result.because });
    }

    const result = await completeReview({
      orgId: user.orgId,
      sessionId: body.sessionId,
      reviewerId: user.id,
      notes: body.notes,
      abandoned: body.abandoned,
    });
    // 409 rather than 400: the request is well-formed and the review is not in
    // a state that allows closing, which is a different fix.
    if (!result.ok) return json({ error: result.message }, 409);

    await audit({
      orgId: user.orgId, userId: user.id,
      action: body.abandoned ? 'call.review_abandoned' : 'call.review_completed',
      entityType: 'CallReview', entityId: body.sessionId,
    });
    return json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
