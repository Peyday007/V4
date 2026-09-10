import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireAny } from '@/lib/auth/session';
import { audit } from '@/lib/audit';
import { handleRouteError, json, rateLimit } from '@/lib/api';
import { isConnected } from '@/lib/brain/config';
import { describeFailure, readProjection, sendCommand } from '@/lib/brain/client';
import { applyProjection, pushChanges } from '@/lib/brain/sync';

export const dynamic = 'force-dynamic';

const schema = z.object({
  command: z.literal('RESEARCH_FURTHER'),
});

/**
 * The one command this site can issue to Brain.
 *
 * ---------------------------------------------------------------------------
 * Two authorizations, and they are not the same one
 * ---------------------------------------------------------------------------
 *
 * Here, the *person* is authenticated by their session and authorized by their
 * role against an opportunity scoped to their own organisation — the same
 * `requireAny` every other action on this page uses, and the same `orgId`
 * filter. A caller who is not signed in, or who is signed in to another
 * organisation, never gets past this function.
 *
 * There, the *site* is authenticated by a credential Brain issued to it and
 * authorized by Brain's own policy against one project and one scope. The
 * person's name travels as attribution and decides nothing: Brain does not know
 * this site's users and must not start taking decisions on the strength of a
 * name a remote system supplied.
 *
 * Neither check substitutes for the other, and neither can widen the other.
 *
 * ---------------------------------------------------------------------------
 * Pressing twice is one command
 * ---------------------------------------------------------------------------
 *
 * Brain derives the idempotency key from the record and the command, so a
 * second press, a retried request, a refresh mid-flight and a restart of either
 * service all resolve to the same operation. This route sends no key of its own
 * — Brain refuses one — and reports `replayed` so the interface can say "Brain
 * already has this" rather than implying a second thing happened.
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireAny('opportunity.write', 'deal.write');
    const body = schema.parse(await request.json());

    if (!isConnected()) {
      return json({ error: 'This site is not connected to a Brain.' }, 503);
    }

    // A person, a record, and a small budget. Not a security control — the two
    // authorizations above are — but a command that reaches a remote service
    // should not be pressable a thousand times a minute.
    if (!rateLimit(`brain-command:${user.id}:${params.id}`, 20, 60_000)) {
      return json({ error: 'Too many requests. Wait a moment and try again.' }, 429);
    }

    const opportunity = await prisma.opportunity.findFirst({
      where: { id: params.id, orgId: user.orgId },
      select: { id: true },
    });
    // The same answer a caller gets for an id that never existed. A different
    // one would let somebody discover another organisation's opportunities by
    // feeding this route ids.
    if (!opportunity) return json({ error: 'Opportunity not found' }, 404);

    /*
     * Make sure Brain has the record before commanding it.
     *
     * A person who has just created an opportunity and pressed the button
     * should not be told "Brain does not hold this" and asked to wait for a
     * cron. The push is bounded and deduplicated by content hash, so in the
     * ordinary case — the record is already there and unchanged — it makes no
     * request at all.
     */
    await pushChanges({ orgId: user.orgId, limit: 100 });

    const result = await sendCommand({
      sourceRecordId: params.id,
      command: body.command,
      actorLabel: `${user.name} (${user.roleName})`,
    });

    /*
     * The same command already running is not an error, and must not read as
     * one.
     *
     * §20's mechanism has three outcomes for an equivalent caller — replay,
     * wait, or refusal — and a person pressing the button twice quickly gets
     * the middle one. Reporting that as a 502 told them Brain was broken at
     * precisely the moment Brain was doing exactly what it promised: one
     * logical command, one outcome. So it answers 200 with the record as it
     * stands, and says which of the two it was rather than implying the second
     * press did something.
     */
    if (!result.ok && result.failure.kind === 'IN_FLIGHT') {
      const current = await readProjection(params.id);
      await audit({
        orgId: user.orgId,
        userId: user.id,
        action: 'brain.command',
        entityType: 'Opportunity',
        entityId: params.id,
        metadata: { command: body.command, replayed: true, inFlight: true },
      });
      if (current.ok) await applyProjection(user.orgId, current.value);
      return json({
        ok: true,
        replayed: true,
        inFlight: true,
        state: current.ok ? current.value.state : null,
        stateReason: current.ok
          ? current.value.stateReason
          : 'Brain already has this and is working on it.',
      });
    }

    if (!result.ok) {
      await audit({
        orgId: user.orgId,
        userId: user.id,
        action: 'brain.command.failed',
        entityType: 'Opportunity',
        entityId: params.id,
        metadata: { command: body.command, failure: result.failure.kind },
      });
      const status = result.failure.kind === 'NOT_FOUND' ? 404 : 502;
      return json({ error: describeFailure(result.failure) }, status);
    }

    // Write Brain's own answer straight into the cache, so the page the person
    // is about to see is the one Brain just described rather than the one the
    // last poll happened to leave behind.
    await applyProjection(user.orgId, result.value.record);
    await prisma.brainLink.updateMany({
      where: { opportunityId: params.id, orgId: user.orgId },
      data: {
        commandedAt: new Date(),
        commandedById: user.id,
        commandedByName: user.name,
      },
    });

    await audit({
      orgId: user.orgId,
      userId: user.id,
      action: 'brain.command',
      entityType: 'Opportunity',
      entityId: params.id,
      metadata: {
        command: body.command,
        replayed: result.value.replayed,
        brainId: result.value.record.brainId,
        state: result.value.record.state,
      },
    });

    return json({
      ok: true,
      replayed: result.value.replayed,
      state: result.value.record.state,
      stateReason: result.value.record.stateReason,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
