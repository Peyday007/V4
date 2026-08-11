import { z } from 'zod';
import { requirePermission } from '@/lib/auth/session';
import { handleRouteError, json, rateLimit } from '@/lib/api';
import { saveDisposition } from '@/lib/demand/outreach';
import { nextCallable } from '@/lib/demand/queue';
import { loadCallCard } from '@/lib/demand/callCard';

export const dynamic = 'force-dynamic';

/**
 * Saves one call outcome and hands back the next opportunity.
 *
 * Returning the next card from the same request is what makes consecutive
 * calling work: the operator never goes back to the board between calls, and
 * the record they just saved is excluded server-side rather than by the
 * browser remembering not to show it again.
 *
 * A failure here returns an error and no next card. The client keeps whatever
 * was typed and does not advance — losing a call's notes because a write timed
 * out is the one failure this workflow cannot absorb.
 */
const Schema = z.object({
  routeId: z.string().min(1),
  disposition: z.enum([
    'NO_ANSWER', 'LEFT_VOICEMAIL', 'GATEKEEPER', 'WRONG_NUMBER',
    'REACHED_DECISION_MAKER', 'INTERESTED', 'NEEDS_INFORMATION', 'FOLLOW_UP',
    'QUALIFIED_OPPORTUNITY', 'ALREADY_HANDLED', 'NOT_INTERESTED', 'BAD_FIT',
    'DO_NOT_CONTACT',
  ]),
  notes: z.string().max(4000).optional(),
  contactName: z.string().max(160).optional(),
  contactRole: z.string().max(160).optional(),
  correctedPhone: z.string().max(40).optional(),
  correctedEmail: z.string().max(200).optional(),
  followUpAt: z.string().optional(),
  confirmedNeed: z.string().max(1000).optional(),
  confirmedTiming: z.string().max(500).optional(),
  budgetNote: z.string().max(1000).optional(),
  incumbentStatus: z.string().max(500).optional(),
  preferredRoute: z.enum(['BROKERAGE', 'SUBCONTRACTING', 'DISTRIBUTION', 'GENERAL']).optional(),
  disqualifyReason: z.string().max(1000).optional(),
  /** Ids already worked this session, excluded from the next card. */
  done: z.array(z.string()).max(200).optional(),
  /** What was on screen, stored with the attempt. */
  contextSnapshot: z.record(z.unknown()).optional(),
});

export async function POST(request: Request) {
  try {
    const user = await requirePermission('discovery.run');

    if (!rateLimit(`demand-disposition:${user.id}`, 240, 60_000)) {
      return json({ error: 'Too many saves in a row. Give it a moment.' }, 429);
    }

    const parsed = Schema.safeParse(await request.json());
    if (!parsed.success) {
      return json({ error: 'Could not read that call outcome.', details: parsed.error.flatten() }, 400);
    }
    const input = parsed.data;

    const followUpAt = input.followUpAt ? new Date(input.followUpAt) : null;
    if (input.followUpAt && Number.isNaN(followUpAt?.getTime())) {
      return json({ error: 'That follow-up date could not be read.' }, 400);
    }

    const saved = await saveDisposition({
      orgId: user.orgId,
      userId: user.id,
      contextSnapshot: input.contextSnapshot,
      input: { ...input, followUpAt },
    });

    // Excluded explicitly rather than relying on the state write being visible
    // to this read: on a pooled connection it may not be yet.
    const done = [...(input.done ?? []), input.routeId];
    const next = await nextCallable({ orgId: user.orgId, excludeRouteIds: done });

    return json({
      saved,
      done,
      next: next ? await loadCallCard({ orgId: user.orgId, routeId: next.routeId }) : null,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
