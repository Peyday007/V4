import type { CallDisposition } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * When we said we would come back, and how urgent that actually is.
 *
 * The previous system had one number — ten minutes — applied to everything. It
 * is roughly right for an inbound web enquiry and absurd for a contract that
 * renews in March, and the effect of applying it everywhere was that the queue
 * was permanently red, so nobody read the colour. A deadline everything misses
 * is not a deadline.
 *
 * Two things set the clock here:
 *
 *   What was promised. "I'll send you a price this afternoon" and "call me
 *   after the budget meeting" are different obligations, and the first one is
 *   broken by tomorrow morning.
 *
 *   The buying window. A promise that lands after the decision is made has been
 *   kept and wasted, so a closing window pulls everything forward.
 *
 * And one rule about ordering: a promise we made outranks cold work we did not.
 * Somebody waiting on us because we said we would call is the cheapest deal in
 * the queue and the easiest to lose.
 */

export type PromiseKind =
  | 'SEND_PRICE'
  | 'SEND_INFORMATION'
  | 'CALL_BACK'
  | 'ARRANGE_VISIT'
  | 'CHASE_DECISION'
  | 'NONE';

export type FollowUp = {
  kind: PromiseKind;
  /** When it is due. Null when nothing was promised. */
  dueAt: Date | null;
  /** Said to the operator, so a date on a screen carries its reason. */
  because: string;
  /**
   * Higher sorts first. A kept promise is worth more than a new cold call, and
   * this is where that belief becomes an ordering.
   */
  priority: number;
  /** True when we told somebody we would do this. */
  isPromise: boolean;
};

/**
 * The default clock for each kind of promise, in hours.
 *
 * Deliberately short for things we said we would send, and long for things
 * that depend on somebody else's calendar. Being early on a price costs
 * nothing; being early on a decision they have not made yet is a nuisance call.
 */
const HOURS: Record<PromiseKind, number | null> = {
  SEND_PRICE: 24,
  SEND_INFORMATION: 24,
  CALL_BACK: 48,
  ARRANGE_VISIT: 72,
  CHASE_DECISION: 168,
  NONE: null,
};

/** Base priorities. A promise starts above any cold work. */
const PRIORITY: Record<PromiseKind, number> = {
  SEND_PRICE: 90,
  SEND_INFORMATION: 80,
  CALL_BACK: 75,
  ARRANGE_VISIT: 70,
  CHASE_DECISION: 50,
  NONE: 0,
};

/**
 * What the outcome of a call obliges us to do.
 *
 * Read from the disposition and from what the caller wrote in `nextStep`,
 * because the disposition says what happened and the free text says what was
 * promised — and it is the promise that creates the obligation.
 */
export function promiseFromCall(input: {
  disposition: CallDisposition;
  /** Exactly what the caller said they would do. */
  nextStep?: string | null;
}): PromiseKind {
  const said = (input.nextStep ?? '').toLowerCase();

  // The caller's own words come first. A disposition is a category; this is
  // what they actually committed us to.
  if (/\b(price|quote|quotation|proposal|estimate)\b/.test(said)) return 'SEND_PRICE';
  if (/\b(send|email|forward)\b/.test(said)) return 'SEND_INFORMATION';
  if (/\b(visit|walk\s?through|walkthrough|site|survey|assessment)\b/.test(said)) return 'ARRANGE_VISIT';
  if (/\b(call|ring|phone|speak)\b/.test(said)) return 'CALL_BACK';

  switch (input.disposition) {
    case 'QUOTE_REQUESTED':
      return 'SEND_PRICE';
    case 'NEEDS_INFORMATION':
      return 'SEND_INFORMATION';
    case 'FOLLOW_UP':
    case 'INTERESTED':
    case 'REACHED_DECISION_MAKER':
    case 'QUALIFIED_OPPORTUNITY':
      return 'CALL_BACK';
    case 'NEED_CONFIRMED':
      return 'CHASE_DECISION';
    default:
      // No answer, wrong number, do-not-contact and the rest promise nothing,
      // because nobody was told anything.
      return 'NONE';
  }
}

/**
 * Turn a promise into a dated obligation.
 *
 * `promisedFor` wins over everything: if the caller wrote down a date the
 * prospect asked for, that is the date, and a policy default that overrides it
 * is the system telling a customer it knows better than they do.
 */
export function scheduleFollowUp(input: {
  kind: PromiseKind;
  now: Date;
  /** A date the prospect actually named. */
  promisedFor?: Date | null;
  /** When their buying window closes, if known. */
  windowClosesAt?: Date | null;
}): FollowUp {
  const { kind, now } = input;

  if (kind === 'NONE') {
    return {
      kind,
      dueAt: null,
      because: 'Nothing was promised on this call, so nothing is owed.',
      priority: 0,
      isPromise: false,
    };
  }

  if (input.promisedFor) {
    return {
      kind,
      dueAt: input.promisedFor,
      because: 'This is the date they asked for. It is not ours to move.',
      priority: PRIORITY[kind] + 5,
      isPromise: true,
    };
  }

  const hours = HOURS[kind] ?? 48;
  let dueAt = new Date(now.getTime() + hours * 3_600_000);
  let because = `We said we would ${describe(kind)}. That is owed within ${hours} hours of saying it.`;
  let priority = PRIORITY[kind];

  // A promise landing after the decision has been made has been kept and
  // wasted. The window pulls it forward rather than the other way around.
  if (input.windowClosesAt && input.windowClosesAt.getTime() > now.getTime()) {
    const halfway = new Date(now.getTime() + (input.windowClosesAt.getTime() - now.getTime()) / 2);
    if (halfway.getTime() < dueAt.getTime()) {
      dueAt = halfway;
      because = `We said we would ${describe(kind)}, and their window closes ${input.windowClosesAt.toISOString().slice(0, 10)} — so this is due sooner than the usual ${hours} hours.`;
      priority += 10;
    }
  }

  return { kind, dueAt, because, priority, isPromise: true };
}

/**
 * How overdue work ranks against everything else.
 *
 * An overdue promise gains priority with every hour it stays overdue, and does
 * so without limit, because the alternative — capping it — lets a promise from
 * last week sit permanently behind whatever is merely urgent today.
 */
export function overduePriority(followUp: FollowUp, now: Date): number {
  if (!followUp.dueAt) return followUp.priority;
  const overdueHours = (now.getTime() - followUp.dueAt.getTime()) / 3_600_000;
  if (overdueHours <= 0) return followUp.priority;
  return followUp.priority + Math.round(overdueHours);
}

function describe(kind: PromiseKind): string {
  switch (kind) {
    case 'SEND_PRICE': return 'send them a price';
    case 'SEND_INFORMATION': return 'send them information';
    case 'CALL_BACK': return 'call them back';
    case 'ARRANGE_VISIT': return 'arrange a visit';
    case 'CHASE_DECISION': return 'come back to them about the decision';
    default: return 'follow up';
  }
}

// ---------------------------------------------------------------------------
// Reading the queue
// ---------------------------------------------------------------------------

export type OwedItem = {
  routeId: string;
  organisation: string;
  kind: PromiseKind;
  dueAt: Date;
  overdueHours: number;
  priority: number;
  because: string;
};

/**
 * Everything we owe somebody, worst first.
 *
 * Read from the outreach state's own follow-up date rather than recomputed, so
 * a promise made on Tuesday keeps Tuesday's deadline even if the policy
 * changes on Wednesday.
 */
export async function owedFollowUps(params: {
  orgId: string;
  now?: Date;
  limit?: number;
}): Promise<OwedItem[]> {
  const now = params.now ?? new Date();

  const states = await prisma.outreachState.findMany({
    where: {
      orgId: params.orgId,
      snoozeUntil: { not: null, lte: now },
      // Qualified work has left cold outreach and is tracked by the deal
      // layer instead; the closed states and do-not-contact are owed nothing.
      status: {
        notIn: ['DO_NOT_CONTACT', 'CLOSED_HANDLED', 'CLOSED_NOT_INTERESTED', 'CLOSED_BAD_FIT', 'QUALIFIED'],
      },
    },
    select: {
      routeId: true,
      snoozeUntil: true,
      lastDisposition: true,
      route: {
        select: {
          company: { select: { legalName: true } },
          windowClosesAt: true,
        },
      },
    },
    take: params.limit ?? 200,
  });

  const items = states
    .filter((state) => state.snoozeUntil !== null)
    .map((state) => {
      const kind = state.lastDisposition
        ? promiseFromCall({ disposition: state.lastDisposition })
        : 'CALL_BACK';
      const followUp = scheduleFollowUp({
        kind,
        now,
        promisedFor: state.snoozeUntil,
        windowClosesAt: state.route.windowClosesAt,
      });
      const overdueHours = Math.max(0, (now.getTime() - state.snoozeUntil!.getTime()) / 3_600_000);

      return {
        routeId: state.routeId,
        organisation: state.route.company.legalName,
        kind,
        dueAt: state.snoozeUntil!,
        overdueHours: Math.round(overdueHours),
        priority: overduePriority(followUp, now),
        because: followUp.because,
      };
    });

  return items.sort((a, b) => b.priority - a.priority || a.dueAt.getTime() - b.dueAt.getTime());
}
