import type { ReadinessState, ShiftReadiness } from '@prisma/client';
import { prisma } from '@/lib/db';
import { queueSummary } from '@/lib/demand/queue';
import { stopsFor } from './gate';
import { ALL_CAPABILITIES, PRODUCED_BY, RULE_VERSION } from './rules';

/**
 * What a caller needs to know before they start.
 *
 * The point of doing this at the start of a shift rather than at the moment
 * somebody presses a button is that the answer is often "nothing you can do
 * anything about". A caller who finds out at half past nine that recording has
 * been down since seven has already made a dozen calls whose audio does not
 * exist; a caller who is told at seven has lost nothing.
 *
 * Blockers carry an explicit `whose` on every entry, and the readiness state
 * distinguishes BLOCKED_BY_SYSTEM from BLOCKED_BY_RESTRICTION for the same
 * reason. They look identical on a dashboard and they are opposite messages to
 * the person reading them.
 */

export type Blocker = {
  /** Whose problem it is. The field the whole check exists to carry. */
  whose: 'ours' | 'yours';
  what: string;
  /** What happens next, and who does it. */
  next: string;
};

export type Readiness = {
  state: ReadinessState;
  blockers: Blocker[];
  warnings: Blocker[];
  workReady: number;
  duePromises: number;
  openCases: number;
  /** The one line the caller reads. */
  headline: string;
};

export async function assessReadiness(params: {
  orgId: string;
  callerId: string;
  now?: Date;
}): Promise<Readiness> {
  const now = params.now ?? new Date();

  const [queue, stops, incidents, cases, duePromises] = await Promise.all([
    queueSummary(params.orgId),
    stopsFor({ orgId: params.orgId, userId: params.callerId, capabilities: ALL_CAPABILITIES, now }),
    prisma.workIncident.findMany({
      where: { orgId: params.orgId, callerId: params.callerId, status: 'OPEN' },
      select: { id: true, kind: true, detail: true },
      take: 5,
    }),
    prisma.consistencyCase.count({
      where: { orgId: params.orgId, callerId: params.callerId, state: 'OPEN', askedAt: { not: null } },
    }),
    prisma.outreachState.count({
      where: { orgId: params.orgId, snoozeUntil: { lte: now }, status: { in: ['NEW', 'ATTEMPTED', 'IN_CONVERSATION', 'FOLLOW_UP', 'QUALIFIED'] } },
    }),
  ]);

  const blockers: Blocker[] = [];
  const warnings: Blocker[] = [];

  for (const stop of stops) {
    if (stop.kind === 'system') {
      blockers.push({
        whose: 'ours',
        what: stop.message,
        next: 'Somebody is on it. Nothing here is counted against you and nothing you did is lost.',
      });
    } else {
      blockers.push({
        whose: 'yours',
        what: stop.message,
        next: stop.restorationRule
          ? `It ends when: ${stop.restorationRule}`
          : 'A manager will review it with you.',
      });
    }
  }

  for (const incident of incidents) {
    blockers.push({
      whose: 'ours',
      what: `An unresolved incident on your work: ${incident.detail.slice(0, 200)}`,
      next: 'Everything you had entered was preserved. This is ours to clear before you carry on with that record.',
    });
  }

  if (cases > 0) {
    warnings.push({
      whose: 'yours',
      what: `${cases} question${cases === 1 ? '' : 's'} waiting on you about ${cases === 1 ? 'a call' : 'some calls'} from earlier.`,
      next: 'They are questions, not findings. Answering them is usually the end of it.',
    });
  }

  const systemBlocked = blockers.some((b) => b.whose === 'ours');
  const restricted = blockers.some((b) => b.whose === 'yours');

  const state: ReadinessState = systemBlocked
    ? 'BLOCKED_BY_SYSTEM'
    : restricted
      ? 'BLOCKED_BY_RESTRICTION'
      : queue.call_now === 0 && queue.follow_up === 0
        ? 'NOTHING_TO_DO'
        : warnings.length > 0
          ? 'READY_WITH_WARNINGS'
          : 'READY';

  return {
    state,
    blockers,
    warnings,
    workReady: queue.call_now,
    duePromises,
    openCases: cases,
    headline: headlineFor(state, queue.call_now, duePromises),
  };
}

function headlineFor(state: ReadinessState, workReady: number, duePromises: number): string {
  switch (state) {
    case 'BLOCKED_BY_SYSTEM':
      return 'Something on our side is down. This is not your fault and none of it counts against you.';
    case 'BLOCKED_BY_RESTRICTION':
      return 'Part of your account is paused. What it is and how it ends are below.';
    case 'NOTHING_TO_DO':
      return 'Nothing is waiting to be called. That is a demand problem, not yours — tell somebody rather than sitting on it.';
    case 'READY_WITH_WARNINGS':
      return `${workReady} ready to call and ${duePromises} promise(s) due. A couple of things want your attention first.`;
    default:
      return `${workReady} ready to call, ${duePromises} promise(s) due. Start with the promises.`;
  }
}

/**
 * Write the check for the day.
 *
 * One row per caller per shift date, so a caller reloading the page does not
 * produce a fresh assessment every time and the day's record is stable.
 */
export async function recordReadiness(params: {
  orgId: string;
  callerId: string;
  now?: Date;
}): Promise<{ readiness: Readiness; row: ShiftReadiness }> {
  const now = params.now ?? new Date();
  const shiftDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const readiness = await assessReadiness(params);

  const row = await prisma.shiftReadiness.upsert({
    where: { callerId_shiftDate: { callerId: params.callerId, shiftDate } },
    create: {
      orgId: params.orgId,
      callerId: params.callerId,
      shiftDate,
      state: readiness.state,
      blockers: readiness.blockers as object,
      warnings: readiness.warnings as object,
      workReady: readiness.workReady,
      duePromises: readiness.duePromises,
      openCases: readiness.openCases,
      checkedAt: now,
      producedBy: PRODUCED_BY,
      ruleVersion: RULE_VERSION,
    },
    update: {
      state: readiness.state,
      blockers: readiness.blockers as object,
      warnings: readiness.warnings as object,
      workReady: readiness.workReady,
      duePromises: readiness.duePromises,
      openCases: readiness.openCases,
      checkedAt: now,
    },
  });

  return { readiness, row };
}

/** The caller saying they have read it. Never a substitute for fixing anything. */
export async function acknowledgeReadiness(params: {
  orgId: string;
  callerId: string;
  now?: Date;
}): Promise<{ ok: boolean }> {
  const now = params.now ?? new Date();
  const shiftDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const updated = await prisma.shiftReadiness.updateMany({
    where: { orgId: params.orgId, callerId: params.callerId, shiftDate },
    data: { acknowledgedAt: now },
  });
  return { ok: updated.count > 0 };
}
