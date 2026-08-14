import type { OutcomeStage, CallDisposition, DataMode } from '@prisma/client';
import { prisma } from '@/lib/db';
import { recordOutcome } from '@/lib/demand/performance';
import { moneyPosition } from '@/lib/deal/commit';

/**
 * The chain from a source record to money that arrived.
 *
 * The previous system's learning stopped at "appointment booked" — not because
 * nobody wanted the rest, but because nothing downstream of the appointment
 * ever wrote back to the thing that produced the lead. Every comparison it
 * could make was therefore between counts of records, and record volume is
 * never source performance.
 *
 * So each layer records its own rung as it happens. Nothing sweeps, nothing
 * reconstructs, and no rung is inferred from another: a route can be quoted
 * without having been asked for a price, and the gap between "they asked" and
 * "we sent one" is one of the more useful numbers in the building.
 *
 * Milestones, not activity. `recordOutcome` is keyed on (route, stage), so a
 * lead contacted three times has one contacted milestone.
 */

/**
 * The funnel's order.
 *
 * Held here rather than taken from the enum, because the four rungs added in
 * this phase were appended to the Postgres type and its declaration order no
 * longer matches the funnel's. Anything that sorts by the enum is wrong; a
 * test asserts this array covers every value.
 */
export const FUNNEL: OutcomeStage[] = [
  'SOURCE_RECORD',
  'DEMAND_EVENT',
  'VERIFIED_LEAD',
  'CONTACTED',
  'RESPONDED',
  'RELEVANT_PERSON',
  'NEED_CONFIRMED',
  'QUALIFIED_CONVERSATION',
  'QUOTE_REQUESTED',
  'QUOTED',
  'PROOF_STEP_ACCEPTED',
  'WON',
  'COMPLETED',
  'PAID',
];

/** Off the ladder: a real outcome, and not a rung anything progresses through. */
export const TERMINAL_STAGES: OutcomeStage[] = ['LOST'];

export function stageRank(stage: OutcomeStage): number {
  const index = FUNNEL.indexOf(stage);
  return index === -1 ? -1 : index;
}

/** Human labels, so no screen invents its own and two disagree. */
export const STAGE_LABELS: Record<OutcomeStage, string> = {
  SOURCE_RECORD: 'Source record',
  DEMAND_EVENT: 'Demand event',
  VERIFIED_LEAD: 'Verified lead',
  CONTACTED: 'Contacted',
  RESPONDED: 'Someone answered',
  RELEVANT_PERSON: 'Reached a relevant person',
  NEED_CONFIRMED: 'Need confirmed',
  QUALIFIED_CONVERSATION: 'Qualified conversation',
  QUOTE_REQUESTED: 'They asked for a price',
  QUOTED: 'Price sent',
  PROOF_STEP_ACCEPTED: 'First step accepted',
  WON: 'Buyer committed',
  COMPLETED: 'Work delivered',
  PAID: 'Money collected',
  LOST: 'Lost',
};

// ---------------------------------------------------------------------------
// Recording, from wherever the thing actually happened
// ---------------------------------------------------------------------------

/**
 * Everything a route needs to be attributed to its source.
 *
 * Looked up once per record rather than threaded through five call sites,
 * because a milestone missing its connector is a milestone that cannot be
 * attributed, which makes it worth roughly nothing.
 */
async function attribution(routeId: string): Promise<{
  orgId: string;
  connector: string;
  playbookKey: string;
  route: string;
  eventId: string;
  dataMode: DataMode;
} | null> {
  const row = await prisma.routeHypothesis.findUnique({
    where: { id: routeId },
    select: {
      orgId: true, playbookKey: true, route: true, eventId: true, dataMode: true,
      event: { select: { connector: true } },
    },
  });
  if (!row) return null;
  return {
    orgId: row.orgId,
    connector: row.event.connector,
    playbookKey: row.playbookKey,
    route: row.route,
    eventId: row.eventId,
    // Carried from the route rather than defaulted, so a practice call cannot
    // land in the numbers the business is steered by.
    dataMode: row.dataMode,
  };
}

/**
 * Record one rung for one route.
 *
 * Never throws at the caller. These are measurement writes sitting behind
 * operational ones, and a funnel row failing must not fail a saved call or a
 * settled payment — but it is logged rather than swallowed, because a funnel
 * that quietly stops recording looks exactly like a business that stopped
 * selling.
 */
export async function recordStage(input: {
  routeId: string;
  stage: OutcomeStage;
  occurredAt?: Date;
  collectedRevenue?: number | null;
  collectedGrossProfit?: number | null;
  note?: string;
}): Promise<boolean> {
  try {
    const where = await attribution(input.routeId);
    if (!where) return false;

    await recordOutcome({
      orgId: where.orgId,
      connector: where.connector,
      playbookKey: where.playbookKey,
      route: where.route as never,
      eventId: where.eventId,
      routeId: input.routeId,
      dataMode: where.dataMode,
      stage: input.stage,
      occurredAt: input.occurredAt,
      collectedRevenue: input.collectedRevenue ?? null,
      collectedGrossProfit: input.collectedGrossProfit ?? null,
      note: input.note,
    });
    return true;
  } catch (error) {
    console.error(`[funnel] could not record ${input.stage} for ${input.routeId}:`, String(error));
    return false;
  }
}

/**
 * The rungs a call outcome establishes.
 *
 * Several at once, deliberately. Somebody who confirms a need has also been
 * reached and is also a relevant person, and recording only the furthest rung
 * would leave holes that read as drop-off between stages nobody skipped.
 */
export function stagesForDisposition(disposition: CallDisposition): OutcomeStage[] {
  const reached: OutcomeStage[] = ['CONTACTED'];

  switch (disposition) {
    case 'NO_ANSWER':
    case 'LEFT_VOICEMAIL':
    case 'WRONG_NUMBER':
      // An attempt, and nothing was learned. Contacted means we tried.
      return reached;

    case 'GATEKEEPER':
    case 'DO_NOT_CONTACT':
      return [...reached, 'RESPONDED'];

    case 'DECISION_MAKER_IDENTIFIED':
      return [...reached, 'RESPONDED'];

    case 'REACHED_RELEVANT_PERSON':
    case 'REACHED_DECISION_MAKER':
    case 'NEEDS_INFORMATION':
    case 'FOLLOW_UP':
    case 'INTERESTED':
      return [...reached, 'RESPONDED', 'RELEVANT_PERSON'];

    case 'NEED_CONFIRMED':
      return [...reached, 'RESPONDED', 'RELEVANT_PERSON', 'NEED_CONFIRMED'];

    case 'QUALIFIED_OPPORTUNITY':
      return [...reached, 'RESPONDED', 'RELEVANT_PERSON', 'NEED_CONFIRMED', 'QUALIFIED_CONVERSATION'];

    case 'QUOTE_REQUESTED':
      return [...reached, 'RESPONDED', 'RELEVANT_PERSON', 'NEED_CONFIRMED', 'QUALIFIED_CONVERSATION', 'QUOTE_REQUESTED'];

    case 'NEED_UNCONFIRMED':
    case 'NOT_INTERESTED':
    case 'BAD_FIT':
    case 'ALREADY_HANDLED':
      // A negative answer is a finding, and the person still answered.
      return [...reached, 'RESPONDED', 'RELEVANT_PERSON', 'LOST'];

    default: {
      // Exhaustiveness: a new disposition added without a decision here is a
      // compile error rather than a silently unmeasured outcome.
      const never: never = disposition;
      return [never];
    }
  }
}

/** Called after every saved call. */
export async function recordCallOutcome(input: {
  routeId: string;
  disposition: CallDisposition;
  occurredAt?: Date;
}): Promise<number> {
  let written = 0;
  for (const stage of stagesForDisposition(input.disposition)) {
    if (await recordStage({ routeId: input.routeId, stage, occurredAt: input.occurredAt })) written += 1;
  }
  return written;
}

/**
 * The money rungs, read from the deal rather than asserted.
 *
 * `WON` comes from a buyer commitment, `COMPLETED` from delivery, and `PAID`
 * from settled payments only — never from a stage name. A deal marked paid
 * with nothing settled records no money, because there is none.
 */
export async function recordDealOutcome(input: { routeId: string }): Promise<OutcomeStage[]> {
  const deal = await prisma.routeDeal.findUnique({
    where: { routeId: input.routeId },
    include: { payments: { select: { direction: true, kind: true, amount: true, settledAt: true } } },
  });
  if (!deal) return [];

  const written: OutcomeStage[] = [];

  if (deal.buyerCommittedAt) {
    if (await recordStage({ routeId: input.routeId, stage: 'WON', occurredAt: deal.buyerCommittedAt })) {
      written.push('WON');
    }
  }

  if (deal.deliveryCompletedAt) {
    if (await recordStage({ routeId: input.routeId, stage: 'COMPLETED', occurredAt: deal.deliveryCompletedAt })) {
      written.push('COMPLETED');
    }
  }

  const money = moneyPosition(deal.payments);
  if (money.collected > 0) {
    if (await recordStage({
      routeId: input.routeId,
      stage: 'PAID',
      collectedRevenue: money.collected,
      // Settled money in, minus settled money out. Not the quoted margin, not
      // the contracted one — the only profit figure that describes money.
      collectedGrossProfit: money.collectedGrossProfit,
      note: money.outstanding > 0 ? `${money.outstanding} still outstanding.` : undefined,
    })) {
      written.push('PAID');
    }
  }

  if (deal.stage === 'LOST' || deal.stage === 'CANCELLED') {
    if (await recordStage({ routeId: input.routeId, stage: 'LOST', note: deal.lostReason ?? deal.cancelReason ?? undefined })) {
      written.push('LOST');
    }
  }

  return written;
}

/** Called when a quote is actually sent. */
export async function recordQuoteSent(input: { routeId: string; occurredAt?: Date }): Promise<void> {
  await recordStage({ routeId: input.routeId, stage: 'QUOTED', occurredAt: input.occurredAt });
}

/** Called when a prospect acts in a deal room. */
export async function recordRoomOutcome(input: {
  routeId: string;
  action: 'QUOTE_REQUESTED' | 'PROOF_STEP_REQUESTED' | 'DECLINED' | 'NEXT_STEP_REQUESTED' | 'INFORMATION_SUPPLIED' | 'RESPONDED';
  occurredAt?: Date;
}): Promise<void> {
  // Every one of these is somebody deliberately doing something, which means
  // the room reached a relevant person whatever else it establishes.
  await recordStage({ routeId: input.routeId, stage: 'RESPONDED', occurredAt: input.occurredAt });
  await recordStage({ routeId: input.routeId, stage: 'RELEVANT_PERSON', occurredAt: input.occurredAt });

  if (input.action === 'QUOTE_REQUESTED') {
    await recordStage({ routeId: input.routeId, stage: 'NEED_CONFIRMED', occurredAt: input.occurredAt });
    await recordStage({ routeId: input.routeId, stage: 'QUOTE_REQUESTED', occurredAt: input.occurredAt });
  }
  if (input.action === 'PROOF_STEP_REQUESTED') {
    await recordStage({ routeId: input.routeId, stage: 'NEED_CONFIRMED', occurredAt: input.occurredAt });
    await recordStage({ routeId: input.routeId, stage: 'PROOF_STEP_ACCEPTED', occurredAt: input.occurredAt });
  }
  if (input.action === 'DECLINED') {
    await recordStage({ routeId: input.routeId, stage: 'LOST', occurredAt: input.occurredAt, note: 'Declined through the deal room.' });
  }
}

// ---------------------------------------------------------------------------
// Reading it back
// ---------------------------------------------------------------------------

export type FunnelRow = {
  stage: OutcomeStage;
  label: string;
  count: number;
  /** Conversion from the rung above. Null when the sample is too small to mean anything. */
  fromPrevious: number | null;
  /** Conversion from verified leads, the first rung we control. */
  fromLeads: number | null;
};

export type FunnelReport = {
  rows: FunnelRow[];
  lost: number;
  collectedRevenue: number;
  collectedGrossProfit: number;
  /** True until enough has been through to read a rate off it. */
  tooEarly: boolean;
  /** Where the chain stops. Written for somebody deciding what to fix. */
  firstBreak: string | null;
};

/** Below this many leads, a percentage is a story about four data points. */
export const MIN_SAMPLE_FOR_RATES = 20;

export async function funnelReport(params: {
  orgId: string;
  connector?: string;
  route?: string;
  since?: Date;
  /** Which world to report on. Production by default; nothing renders a rehearsal. */
  dataMode?: 'PRODUCTION' | 'TEST';
}): Promise<FunnelReport> {
  const filters = {
    orgId: params.orgId,
    ...(params.connector ? { connector: params.connector } : {}),
    ...(params.route ? { route: params.route as never } : {}),
    ...(params.since ? { occurredAt: { gte: params.since } } : {}),
  };

  const grouped = await prisma.demandOutcome.groupBy({
    by: ['stage'],
    // Practice is not performance, and the filter is written at the query
    // rather than assembled above it. A scoping rule hidden inside a variable
    // is one a reader has to go and check; a test scans for it here.
    where: { ...filters, dataMode: params.dataMode ?? 'PRODUCTION' },
    _count: true,
    _sum: { collectedRevenue: true, collectedGrossProfit: true },
  });

  const counts = new Map(grouped.map((g) => [g.stage, g._count]));
  const leads = counts.get('VERIFIED_LEAD') ?? 0;
  const enough = leads >= MIN_SAMPLE_FOR_RATES;

  const rows: FunnelRow[] = FUNNEL.map((stage, index) => {
    const count = counts.get(stage) ?? 0;
    const previous = index === 0 ? null : counts.get(FUNNEL[index - 1]) ?? 0;
    return {
      stage,
      label: STAGE_LABELS[stage],
      count,
      fromPrevious: enough && previous !== null && previous > 0 ? round3(count / previous) : null,
      fromLeads: enough && leads > 0 ? round3(count / leads) : null,
    };
  });

  const money = grouped.reduce(
    (acc, g) => ({
      revenue: acc.revenue + Number(g._sum.collectedRevenue ?? 0),
      profit: acc.profit + Number(g._sum.collectedGrossProfit ?? 0),
    }),
    { revenue: 0, profit: 0 },
  );

  // Where it stops: the first rung after verified leads with nothing in it.
  // Named plainly, because "conversion is low" is not something anybody can act
  // on and "nothing has ever been quoted" is.
  const start = FUNNEL.indexOf('VERIFIED_LEAD');
  let firstBreak: string | null = null;
  for (let i = start + 1; i < FUNNEL.length; i += 1) {
    if ((counts.get(FUNNEL[i]) ?? 0) === 0) {
      firstBreak = `Nothing has reached "${STAGE_LABELS[FUNNEL[i]]}". Everything below it is unmeasured, not zero.`;
      break;
    }
  }

  return {
    rows,
    lost: counts.get('LOST') ?? 0,
    collectedRevenue: round2(money.revenue),
    collectedGrossProfit: round2(money.profit),
    tooEarly: !enough,
    firstBreak,
  };
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function round3(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}
