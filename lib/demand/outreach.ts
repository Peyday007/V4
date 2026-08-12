import type { CallDisposition, OutreachStatus, Prisma, SignalCategory } from '@prisma/client';
import { prisma } from '@/lib/db';
import { recordOutcome } from './performance';
import { recordOperatorContact, rejectContactValue } from '@/lib/enrichment/schedule';

/**
 * Saving what happened on a call.
 *
 * Two things are kept strictly apart. `OutreachAttempt` is append-only: every
 * attempt is inserted and nothing ever updates or deletes one, so the history
 * of what was tried survives every later correction. `OutreachState` is the
 * current position, updated in place, and it is what the queue reads.
 *
 * Neither touches `DemandEvent`. A corrected phone number goes on the outreach
 * state, not over the source's record — the source published what it published,
 * and an operator learning better does not make the original wrong.
 */

export type DispositionInput = {
  routeId: string;
  disposition: CallDisposition;
  notes?: string;
  contactName?: string;
  contactRole?: string;
  correctedPhone?: string;
  correctedEmail?: string;
  followUpAt?: Date | null;
  confirmedNeed?: string;
  confirmedTiming?: string;
  budgetNote?: string;
  incumbentStatus?: string;
  preferredRoute?: SignalCategory | null;
  disqualifyReason?: string;
};

/**
 * Retry policy for the two dispositions that are not really outcomes.
 *
 * Deliberately widening: a fourth voicemail on the same day as the third is
 * not persistence, it is a way to get blocked. After the sixth attempt the
 * record leaves the calling queue and becomes somebody's decision rather than
 * an endless loop.
 */
const RETRY_DAYS = [1, 2, 4, 7, 14];
const MAX_ATTEMPTS = 6;

export type Transition = {
  status: OutreachStatus;
  snoozeUntil: Date | null;
  /** Plain-language note about what the queue will now do. */
  effect: string;
};

/**
 * What a disposition does to the record's position in the queue.
 *
 * Pure, so the rules can be tested without a database and so the caller view
 * can tell the operator what will happen before they press save.
 */
export function transitionFor(input: {
  disposition: CallDisposition;
  attempts: number;
  followUpAt?: Date | null;
  now?: Date;
}): Transition {
  const now = input.now ?? new Date();
  const attempts = input.attempts + 1;

  const scheduleRetry = (): Transition => {
    if (attempts >= MAX_ATTEMPTS) {
      return {
        status: 'CLOSED_NOT_INTERESTED',
        snoozeUntil: null,
        effect: `${attempts} attempts with no contact. Closed — not a rejection, just not reachable this way.`,
      };
    }
    const days = RETRY_DAYS[Math.min(attempts - 1, RETRY_DAYS.length - 1)];
    const until = new Date(now.getTime() + days * 86_400_000);
    return {
      status: 'ATTEMPTED',
      snoozeUntil: until,
      effect: `Back in the queue in ${days} day${days === 1 ? '' : 's'} (${until.toISOString().slice(0, 10)}).`,
    };
  };

  switch (input.disposition) {
    case 'NO_ANSWER':
    case 'LEFT_VOICEMAIL':
      return scheduleRetry();

    case 'GATEKEEPER':
      // Reached a person, just not the right one. Worth another try sooner.
      return {
        status: 'IN_CONVERSATION',
        snoozeUntil: new Date(now.getTime() + 2 * 86_400_000),
        effect: 'Back in two days. Ask for the named person next time.',
      };

    case 'WRONG_NUMBER':
      // Out of the calling queue until somebody finds a working number. If a
      // correction was saved alongside, the queue picks it up immediately.
      return {
        status: 'ATTEMPTED',
        snoozeUntil: null,
        effect: 'Stays in the queue only if you saved a corrected number; otherwise it moves to Research.',
      };

    case 'REACHED_DECISION_MAKER':
    case 'NEEDS_INFORMATION':
    case 'INTERESTED':
      return {
        status: 'FOLLOW_UP',
        snoozeUntil: input.followUpAt ?? new Date(now.getTime() + 3 * 86_400_000),
        effect: input.followUpAt
          ? `Follow up on ${input.followUpAt.toISOString().slice(0, 10)}. Hidden from Call now until then.`
          : 'Follow up in three days. Hidden from Call now until then.',
      };

    case 'FOLLOW_UP':
      return {
        status: 'FOLLOW_UP',
        snoozeUntil: input.followUpAt ?? new Date(now.getTime() + 7 * 86_400_000),
        effect: input.followUpAt
          ? `Hidden from Call now until ${input.followUpAt.toISOString().slice(0, 10)}.`
          : 'Hidden from Call now for a week.',
      };

    case 'QUALIFIED_OPPORTUNITY':
      return {
        status: 'QUALIFIED',
        snoozeUntil: null,
        effect: 'Moved to Qualified. Out of cold calling.',
      };

    case 'ALREADY_HANDLED':
      return { status: 'CLOSED_HANDLED', snoozeUntil: null, effect: 'Closed — somebody already has this.' };
    case 'NOT_INTERESTED':
      return { status: 'CLOSED_NOT_INTERESTED', snoozeUntil: null, effect: 'Closed. Out of the calling queue.' };
    case 'BAD_FIT':
      return { status: 'CLOSED_BAD_FIT', snoozeUntil: null, effect: 'Closed as a bad fit. Out of the calling queue.' };
    case 'DO_NOT_CONTACT':
      return {
        status: 'DO_NOT_CONTACT',
        snoozeUntil: null,
        effect: 'Do not contact. Permanently excluded from every calling queue.',
      };
  }
}

export type SaveResult = {
  attemptId: string;
  status: OutreachStatus;
  snoozeUntil: Date | null;
  effect: string;
  attempts: number;
};

/**
 * Records one attempt and moves the record.
 *
 * One transaction: the append-only attempt and the state change land together
 * or not at all, so a failure never leaves an attempt with no consequence or a
 * state change with no record of why.
 */
export async function saveDisposition(params: {
  orgId: string;
  userId?: string | null;
  input: DispositionInput;
  /** What the operator had on screen, stored with the attempt. */
  contextSnapshot?: Record<string, unknown>;
  now?: Date;
}): Promise<SaveResult> {
  const { orgId, input } = params;
  const now = params.now ?? new Date();

  // The route must belong to this organisation. Checked here rather than
  // trusted from the request, because the route id arrives from a browser.
  const route = await prisma.routeHypothesis.findFirst({
    where: { id: input.routeId, orgId },
    select: {
      id: true,
      playbookKey: true,
      route: true,
      eventId: true,
      companyId: true,
      event: { select: { connector: true } },
      company: {
        select: {
          phone: true,
          contacts: { select: { phone: true, mobile: true }, orderBy: { createdAt: 'asc' }, take: 1 },
        },
      },
    },
  });
  if (!route) throw new Error('That opportunity does not exist in your organisation.');

  const existing = await prisma.outreachState.findUnique({ where: { routeId: input.routeId } });
  const transition = transitionFor({
    disposition: input.disposition,
    attempts: existing?.attempts ?? 0,
    followUpAt: input.followUpAt,
    now,
  });

  const result = await prisma.$transaction(async (tx) => {
    const attempt = await tx.outreachAttempt.create({
      data: {
        orgId,
        routeId: input.routeId,
        userId: params.userId ?? null,
        disposition: input.disposition,
        notes: input.notes?.slice(0, 4000) ?? null,
        contextSnapshot: (params.contextSnapshot ?? {}) as Prisma.InputJsonValue,
        occurredAt: now,
      },
      select: { id: true },
    });

    // Only fields the operator actually filled in are written. An empty box is
    // not an instruction to erase what a previous call established.
    const learned = {
      ...(input.contactName ? { contactName: input.contactName.slice(0, 160) } : {}),
      ...(input.contactRole ? { contactRole: input.contactRole.slice(0, 160) } : {}),
      ...(input.correctedPhone ? { correctedPhone: input.correctedPhone.slice(0, 40) } : {}),
      ...(input.correctedEmail ? { correctedEmail: input.correctedEmail.slice(0, 200) } : {}),
      ...(input.confirmedNeed ? { confirmedNeed: input.confirmedNeed.slice(0, 1000) } : {}),
      ...(input.confirmedTiming ? { confirmedTiming: input.confirmedTiming.slice(0, 500) } : {}),
      ...(input.budgetNote ? { budgetNote: input.budgetNote.slice(0, 1000) } : {}),
      ...(input.incumbentStatus ? { incumbentStatus: input.incumbentStatus.slice(0, 500) } : {}),
      ...(input.preferredRoute ? { preferredRoute: input.preferredRoute } : {}),
      ...(input.disqualifyReason ? { disqualifyReason: input.disqualifyReason.slice(0, 1000) } : {}),
    };

    const state = await tx.outreachState.upsert({
      where: { routeId: input.routeId },
      create: {
        orgId,
        routeId: input.routeId,
        status: transition.status,
        snoozeUntil: transition.snoozeUntil,
        attempts: 1,
        lastAttemptAt: now,
        lastDisposition: input.disposition,
        ...learned,
      },
      update: {
        status: transition.status,
        snoozeUntil: transition.snoozeUntil,
        attempts: { increment: 1 },
        lastAttemptAt: now,
        lastDisposition: input.disposition,
        ...learned,
      },
      select: { attempts: true },
    });

    return { attemptId: attempt.id, attempts: state.attempts };
  });

  // The outcome chain, so a source's worth can eventually be measured in
  // completed work rather than in records discovered.
  const stage = OUTCOME_FOR_DISPOSITION[input.disposition];
  if (stage) {
    await recordOutcome({
      orgId,
      connector: route.event.connector,
      playbookKey: route.playbookKey,
      route: route.route,
      eventId: route.eventId,
      routeId: route.id,
      stage,
      occurredAt: now,
    });
  }

  // What the caller learned feeds straight back into contact resolution, in
  // both directions.
  //
  // A number reported wrong is taken off the account and added to the rejected
  // list, so the queue drops the route out of Call now on the next read and the
  // resolver looks for another route without re-proposing the one that failed.
  // A number the caller typed is the strongest evidence there is — somebody
  // spoke to the business — and nothing a provider finds later displaces it.
  if (input.disposition === 'WRONG_NUMBER') {
    const dialled =
      existing?.correctedPhone ??
      route.company.phone ??
      route.company.contacts[0]?.phone ??
      route.company.contacts[0]?.mobile ??
      null;
    // A corrected number saved in the same breath is the replacement, not a
    // rejection of itself.
    if (dialled && dialled !== input.correctedPhone) {
      await rejectContactValue({
        orgId,
        companyId: route.companyId,
        value: dialled,
        reason: `A caller dialled this number on ${now.toISOString().slice(0, 10)} and it was not the business.`,
      });
    }
  }

  for (const [field, value] of [
    ['phone', input.correctedPhone],
    ['email', input.correctedEmail],
    ['contactName', input.contactName],
    ['contactRole', input.contactRole],
  ] as const) {
    if (value) {
      await recordOperatorContact({ orgId, companyId: route.companyId, field, value });
    }
  }

  return {
    attemptId: result.attemptId,
    attempts: result.attempts,
    status: transition.status,
    snoozeUntil: transition.snoozeUntil,
    effect: transition.effect,
  };
}

/**
 * Which funnel milestone each disposition represents.
 *
 * Only the ones that genuinely moved the record forward. A voicemail is an
 * attempt, not a response, and counting it as one would flatter every source
 * equally.
 */
const OUTCOME_FOR_DISPOSITION: Partial<Record<CallDisposition, 'CONTACTED' | 'RESPONDED' | 'QUALIFIED_CONVERSATION' | 'LOST'>> = {
  NO_ANSWER: 'CONTACTED',
  LEFT_VOICEMAIL: 'CONTACTED',
  GATEKEEPER: 'CONTACTED',
  WRONG_NUMBER: 'CONTACTED',
  REACHED_DECISION_MAKER: 'RESPONDED',
  INTERESTED: 'RESPONDED',
  NEEDS_INFORMATION: 'RESPONDED',
  FOLLOW_UP: 'RESPONDED',
  QUALIFIED_OPPORTUNITY: 'QUALIFIED_CONVERSATION',
  NOT_INTERESTED: 'LOST',
  BAD_FIT: 'LOST',
  ALREADY_HANDLED: 'LOST',
  DO_NOT_CONTACT: 'LOST',
};

export { DISPOSITIONS } from './dispositionList';

/** Previous attempts on one route, newest first. */
export async function attemptHistory(orgId: string, routeId: string) {
  return prisma.outreachAttempt.findMany({
    where: { orgId, routeId },
    orderBy: { occurredAt: 'desc' },
    take: 20,
    select: {
      id: true,
      disposition: true,
      notes: true,
      occurredAt: true,
      user: { select: { name: true, email: true } },
    },
  });
}
