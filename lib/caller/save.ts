import type { CallDisposition } from '@prisma/client';
import { prisma } from '@/lib/db';
import { saveDisposition } from '@/lib/demand/outreach';
import { sanitiseDiscovery, validateDisposition } from './discovery';
import { markWorked } from './packets';
import { progressFromCall, type ProgressResult } from '@/lib/deal/fromCall';

/**
 * Saving a caller's call.
 *
 * A thin layer over the canonical `saveDisposition`, and thin on purpose — the
 * append-only attempt, the state transition and the outcome chain all belong to
 * the demand workflow and are not reimplemented here. What this adds is the
 * three things that are specific to a caller working an assignment: that the
 * record is actually theirs, that the outcome carries its minimum, and that a
 * failure is recorded as ours rather than left looking like theirs.
 *
 * The ordering of those checks matters and is the operator's rule: system
 * health is evaluated before caller compliance. A save that fails because the
 * database was unreachable must never surface as a caller who did not fill the
 * form in, and must never lose what they typed.
 */

export type CallerSaveInput = {
  routeId: string;
  disposition: CallDisposition;
  notes?: string;
  discovery?: Record<string, unknown>;
  followUpAt?: string | null;
  contactName?: string;
  contactRole?: string;
  correctedPhone?: string;
  correctedEmail?: string;
};

export type CallerSaveResult =
  | {
      ok: true;
      attemptId: string;
      status: string;
      effect: string;
      attempts: number;
      /**
       * What the call did to the deal underneath it. Reported back so the
       * caller sees that their answers went somewhere, rather than
       * disappearing into a form.
       */
      progress?: ProgressResult;
    }
  | {
      ok: false;
      /** Which of the three refusals this is, so the interface can react. */
      kind: 'not_yours' | 'incomplete' | 'system';
      message: string;
      missingLabels?: string[];
      needsFollowUpDate?: boolean;
      because?: string;
      /** Set when an incident was raised. Nothing they typed was lost. */
      incidentId?: string;
    };

export async function saveCallerCall(params: {
  orgId: string;
  callerId: string;
  input: CallerSaveInput;
  contextSnapshot?: Record<string, unknown>;
  now?: Date;
}): Promise<CallerSaveResult> {
  const now = params.now ?? new Date();
  const { input } = params;

  // --- is it theirs? ------------------------------------------------------
  //
  // Asked of the database, not taken from the request. A caller posting
  // another caller's route id gets the same answer as one posting a route id
  // that does not exist, so this endpoint cannot be used to discover what
  // other people are working on.
  const item = await prisma.packetItem.findFirst({
    where: {
      orgId: params.orgId,
      routeId: input.routeId,
      status: { in: ['PENDING', 'IN_PROGRESS'] },
      packet: { callerId: params.callerId, status: 'OPEN' },
    },
    select: { id: true, route: { select: { route: true } } },
  });

  if (!item) {
    return {
      ok: false,
      kind: 'not_yours',
      message: 'That opportunity is not currently assigned to you.',
    };
  }

  // --- does the outcome carry its minimum? --------------------------------
  const discovery = sanitiseDiscovery(item.route.route, input.discovery);
  const followUpAt = input.followUpAt ? new Date(input.followUpAt) : null;
  const validation = validateDisposition({
    disposition: input.disposition,
    route: item.route.route,
    discovery,
    followUpAt,
  });

  if (!validation.ok) {
    return {
      ok: false,
      kind: 'incomplete',
      message: `This outcome needs ${[
        ...validation.missingLabels,
        ...(validation.needsFollowUpDate ? ['a follow-up date'] : []),
      ].join(', ')}.`,
      missingLabels: validation.missingLabels,
      needsFollowUpDate: validation.needsFollowUpDate,
      because: validation.because,
    };
  }

  // --- write it -----------------------------------------------------------
  try {
    const saved = await saveDisposition({
      orgId: params.orgId,
      userId: params.callerId,
      input: {
        routeId: input.routeId,
        disposition: input.disposition,
        notes: input.notes,
        discovery,
        followUpAt: followUpAt && !Number.isNaN(followUpAt.getTime()) ? followUpAt : undefined,
        contactName: input.contactName,
        contactRole: input.contactRole,
        correctedPhone: input.correctedPhone,
        correctedEmail: input.correctedEmail,
        // Mirrored onto the mutable state so the queue and the next brief can
        // read them without opening the attempt history.
        confirmedNeed: typeof discovery.confirmedNeed === 'string' ? discovery.confirmedNeed : undefined,
        confirmedTiming: typeof discovery.timing === 'string' ? discovery.timing : undefined,
        incumbentStatus:
          typeof discovery.incumbent === 'string'
            ? discovery.incumbent
            : typeof discovery.currentSupplier === 'string'
              ? discovery.currentSupplier
              : undefined,
        disqualifyReason:
          typeof discovery.disqualifyReason === 'string' ? discovery.disqualifyReason : undefined,
      },
      contextSnapshot: params.contextSnapshot,
      now,
    });

    await markWorked({ orgId: params.orgId, callerId: params.callerId, routeId: input.routeId, now });

    // Downstream of the attempt, and deliberately after `markWorked`: the call
    // is recorded and the caller is released whatever happens next. This step
    // raises its own incident rather than throwing, so a failure here can never
    // hold a caller at a gate for something that is not theirs to fix.
    const progress = await progressFromCall({
      orgId: params.orgId,
      routeId: input.routeId,
      route: item.route.route,
      disposition: input.disposition,
      discovery,
      attemptId: saved.attemptId,
      actorId: params.callerId,
      now,
    });

    return {
      ok: true,
      attemptId: saved.attemptId,
      status: saved.status,
      effect: saved.effect,
      attempts: saved.attempts,
      progress,
    };
  } catch (error) {
    // --- ours, not theirs -------------------------------------------------
    //
    // Everything the caller entered is preserved on the incident. The record
    // is not marked worked, the caller is not advanced, and the gate will hold
    // them with a message that says whose fault this is.
    const incident = await prisma.workIncident.create({
      data: {
        orgId: params.orgId,
        callerId: params.callerId,
        routeId: input.routeId,
        kind: 'SAVE_FAILURE',
        detail: String(error).slice(0, 2000),
        preserved: {
          disposition: input.disposition,
          notes: input.notes ?? null,
          discovery,
          followUpAt: input.followUpAt ?? null,
          contactName: input.contactName ?? null,
          contactRole: input.contactRole ?? null,
          correctedPhone: input.correctedPhone ?? null,
        },
      },
      select: { id: true },
    });

    return {
      ok: false,
      kind: 'system',
      message:
        'The save failed on our side. Nothing you entered has been lost, and this is not counted against you.',
      incidentId: incident.id,
    };
  }
}

/**
 * Resolves a system incident.
 *
 * By a person looking at it, never by time passing. An incident that ages out
 * on its own is a failure nobody investigated, and the caller it was blocking
 * learns that reporting problems achieves nothing.
 */
export async function resolveIncident(params: {
  orgId: string;
  incidentId: string;
  resolvedByUserId: string;
  resolution: string;
}): Promise<void> {
  await prisma.workIncident.updateMany({
    where: { id: params.incidentId, orgId: params.orgId, status: 'OPEN' },
    data: {
      status: 'RESOLVED',
      resolvedAt: new Date(),
      resolvedBy: params.resolvedByUserId,
      resolution: params.resolution.slice(0, 2000),
    },
  });
}
