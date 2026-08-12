import type { OutcomeStage, SignalCategory } from '@prisma/client';
import { prisma } from '@/lib/db';
import { rate, compareAdjusted, type Rate, type Stratum } from './stats';
import { FUNNEL, STAGE_LABELS, MIN_SAMPLE_FOR_RATES } from './funnel';

/**
 * Who and what is actually producing completed, paid work.
 *
 * Read from the live path — routes, attempts, packets, deals — rather than the
 * older Call/Opportunity layer, and measured from evidence rather than from
 * activity. A caller who makes twenty calls and produces six confirmed needs is
 * worth more than one who makes sixty and produces none, and every number here
 * is chosen so that comes out right.
 *
 * Two rules the whole file is built around:
 *
 *   Never compare people given different work. A caller handed active demand
 *   will out-convert one handed directory prospects at any skill level, so
 *   comparisons are stratified by tier and the correction is visible rather
 *   than buried.
 *
 *   A weak sample produces "not enough evidence", never a recommendation. The
 *   previous system's coaching told people to change their behaviour on the
 *   strength of eleven calls, and the fastest way to make a caller ignore
 *   coaching is to give them some that is wrong.
 */

export type CallerScorecard = {
  callerId: string;
  name: string;
  /** Work handed to them. */
  assigned: number;
  worked: number;
  untouched: number;
  /** Organisations, not attempts: ringing one company four times is one. */
  organisationsContacted: number;
  attempts: number;
  /** Somebody picked up. */
  answered: Rate;
  /** Somebody who could speak to the requirement. */
  relevantPerson: Rate;
  needConfirmed: Rate;
  quoteRequested: Rate;
  /** Promises made, and promises kept. */
  promisesMade: number;
  promisesKept: number;
  /** How complete their structured discovery is where it was required. */
  discoveryCompleteness: Rate;
  /** Records they left with nothing recorded. */
  emptyOutcomes: number;
  /** Deals that reached a commitment on routes they worked. */
  dealsInfluenced: number;
  collectedGrossProfitInfluenced: number;
  /** The mix they were handed, so nobody reads the rates without it. */
  mix: Record<string, number>;
  /** Set when nothing here should be used to judge them. */
  insufficientEvidence: string | null;
  /**
   * Failures that were the system's, not theirs. Subtracted from every
   * denominator: a caller blocked by a save failure has not underperformed.
   */
  systemIncidents: number;
};

export async function callerScorecards(params: {
  orgId: string;
  since: Date;
  until?: Date;
}): Promise<CallerScorecard[]> {
  const until = params.until ?? new Date();
  const window = { gte: params.since, lte: until };

  const callers = await prisma.user.findMany({
    where: { orgId: params.orgId, callerProfile: { isNot: null } },
    select: { id: true, name: true },
  });

  const scorecards: CallerScorecard[] = [];

  for (const caller of callers) {
    const attempts = await prisma.outreachAttempt.findMany({
      where: { orgId: params.orgId, userId: caller.id, occurredAt: window },
      select: {
        routeId: true, disposition: true, discovery: true,
        route: { select: { tier: true, route: true } },
      },
    });

    const items = await prisma.packetItem.findMany({
      where: { orgId: params.orgId, packet: { callerId: caller.id }, createdAt: window },
      select: { status: true, routeId: true },
    });

    const incidents = await prisma.workIncident.count({
      where: { orgId: params.orgId, callerId: caller.id, createdAt: window },
    });

    const routeIds = Array.from(new Set(attempts.map((a) => a.routeId)));

    const answered = attempts.filter((a) => !['NO_ANSWER', 'LEFT_VOICEMAIL', 'WRONG_NUMBER'].includes(a.disposition));
    const relevant = attempts.filter((a) => RELEVANT.includes(a.disposition));
    const confirmed = attempts.filter((a) => CONFIRMED.includes(a.disposition));
    const quoteAsked = attempts.filter((a) => a.disposition === 'QUOTE_REQUESTED');

    // Promises: outcomes that create an obligation, against follow-ups that
    // actually happened afterwards.
    const promisesMade = attempts.filter((a) => PROMISING.includes(a.disposition)).length;
    const promisesKept = await countKeptPromises(params.orgId, caller.id, routeIds, window);

    const withDiscovery = attempts.filter((a) => {
      const fields = a.discovery as Record<string, unknown>;
      return Object.values(fields ?? {}).some((v) => typeof v === 'string' && v.trim().length > 0);
    });
    const shouldHaveDiscovery = attempts.filter((a) => RELEVANT.includes(a.disposition));

    const deals = routeIds.length > 0
      ? await prisma.routeDeal.findMany({
          where: { orgId: params.orgId, routeId: { in: routeIds } },
          include: { payments: { select: { direction: true, kind: true, amount: true, settledAt: true } } },
        })
      : [];

    const collected = deals.reduce((sum, deal) => {
      const inbound = deal.payments
        .filter((p) => p.direction === 'INBOUND' && p.kind === 'PAYMENT' && p.settledAt)
        .reduce((n, p) => n + Number(p.amount), 0);
      const outbound = deal.payments
        .filter((p) => p.direction === 'OUTBOUND' && p.kind === 'PAYMENT' && p.settledAt)
        .reduce((n, p) => n + Number(p.amount), 0);
      return sum + (inbound - outbound);
    }, 0);

    const mix: Record<string, number> = {};
    for (const attempt of attempts) {
      const key = attempt.route.tier;
      mix[key] = (mix[key] ?? 0) + 1;
    }

    scorecards.push({
      callerId: caller.id,
      name: caller.name,
      assigned: items.length,
      worked: items.filter((i) => i.status === 'WORKED').length,
      untouched: items.filter((i) => i.status === 'PENDING').length,
      organisationsContacted: routeIds.length,
      attempts: attempts.length,
      answered: rate(answered.length, attempts.length),
      relevantPerson: rate(relevant.length, attempts.length),
      needConfirmed: rate(confirmed.length, attempts.length),
      quoteRequested: rate(quoteAsked.length, attempts.length),
      promisesMade,
      promisesKept,
      discoveryCompleteness: rate(withDiscovery.length, shouldHaveDiscovery.length),
      emptyOutcomes: attempts.length - withDiscovery.length - attempts.filter((a) => !RELEVANT.includes(a.disposition)).length,
      dealsInfluenced: deals.length,
      collectedGrossProfitInfluenced: round2(collected),
      mix,
      insufficientEvidence: attempts.length < MIN_SAMPLE_FOR_RATES
        ? `${attempts.length} attempts in this window. Too few to judge anything — shown so the work is visible, not so it can be scored.`
        : null,
      systemIncidents: incidents,
    });
  }

  return scorecards.sort((a, b) => b.attempts - a.attempts);
}

/** Dispositions that mean somebody who could speak to the requirement was reached. */
const RELEVANT = [
  'REACHED_RELEVANT_PERSON', 'REACHED_DECISION_MAKER', 'NEED_CONFIRMED', 'NEED_UNCONFIRMED',
  'QUOTE_REQUESTED', 'QUALIFIED_OPPORTUNITY', 'INTERESTED', 'NEEDS_INFORMATION', 'FOLLOW_UP',
  'NOT_INTERESTED', 'BAD_FIT', 'ALREADY_HANDLED',
];

const CONFIRMED = ['NEED_CONFIRMED', 'QUALIFIED_OPPORTUNITY', 'QUOTE_REQUESTED'];

/** Outcomes where the caller told somebody we would do something. */
const PROMISING = ['FOLLOW_UP', 'NEEDS_INFORMATION', 'QUOTE_REQUESTED', 'INTERESTED'];

/**
 * Promises kept: a later attempt on the same route, after the one that made
 * the promise.
 *
 * Approximate, and the approximation is in the safe direction — it counts a
 * later call as keeping the promise without checking it was the promised
 * thing. A stricter version needs the promise text matched to the action, and
 * inventing that precision from a free-text field would produce a number that
 * looks exact and is not.
 */
async function countKeptPromises(
  orgId: string,
  callerId: string,
  routeIds: string[],
  window: { gte: Date; lte: Date },
): Promise<number> {
  if (routeIds.length === 0) return 0;

  const attempts = await prisma.outreachAttempt.findMany({
    where: { orgId, routeId: { in: routeIds }, occurredAt: window },
    orderBy: { occurredAt: 'asc' },
    select: { routeId: true, userId: true, disposition: true, occurredAt: true },
  });

  const byRoute = new Map<string, typeof attempts>();
  for (const attempt of attempts) {
    const list = byRoute.get(attempt.routeId) ?? [];
    list.push(attempt);
    byRoute.set(attempt.routeId, list);
  }

  let kept = 0;
  for (const list of byRoute.values()) {
    for (let i = 0; i < list.length - 1; i += 1) {
      if (list[i].userId === callerId && PROMISING.includes(list[i].disposition)) kept += 1;
    }
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Comparing callers without comparing their luck
// ---------------------------------------------------------------------------

export type CallerComparison = {
  callerId: string;
  name: string;
  against: string;
  stage: OutcomeStage;
  verdict: string;
  because: string;
  difference: number | null;
};

/**
 * One caller against the rest, stratified by tier.
 *
 * The stratification is the whole point. Without it this reports who was given
 * the best leads.
 */
export async function compareCaller(params: {
  orgId: string;
  callerId: string;
  since: Date;
  stage?: OutcomeStage;
}): Promise<CallerComparison | null> {
  const stage = params.stage ?? 'NEED_CONFIRMED';
  const caller = await prisma.user.findFirst({
    where: { id: params.callerId, orgId: params.orgId },
    select: { name: true },
  });
  if (!caller) return null;

  const attempts = await prisma.outreachAttempt.findMany({
    where: { orgId: params.orgId, occurredAt: { gte: params.since } },
    select: { userId: true, disposition: true, route: { select: { tier: true } } },
  });

  const successFor = (disposition: string): boolean => {
    switch (stage) {
      case 'RESPONDED': return !['NO_ANSWER', 'LEFT_VOICEMAIL', 'WRONG_NUMBER'].includes(disposition);
      case 'RELEVANT_PERSON': return RELEVANT.includes(disposition);
      case 'QUOTE_REQUESTED': return disposition === 'QUOTE_REQUESTED';
      default: return CONFIRMED.includes(disposition);
    }
  };

  const strata = new Map<string, Stratum>();
  for (const attempt of attempts) {
    const key = attempt.route.tier;
    const stratum = strata.get(key) ?? {
      key,
      treatment: { successes: 0, trials: 0 },
      control: { successes: 0, trials: 0 },
    };
    const side = attempt.userId === params.callerId ? stratum.treatment : stratum.control;
    side.trials += 1;
    if (successFor(attempt.disposition)) side.successes += 1;
    strata.set(key, stratum);
  }

  const result = compareAdjusted(Array.from(strata.values()));

  return {
    callerId: params.callerId,
    name: caller.name,
    against: 'everybody else in the same tiers',
    stage,
    verdict: result.verdict,
    because: result.because,
    difference: result.difference,
  };
}

// ---------------------------------------------------------------------------
// Sources and routes
// ---------------------------------------------------------------------------

export type SourceRow = {
  connector: string;
  /** Records is not performance, and it is first so nobody mistakes it for the answer. */
  records: number;
  verifiedLeads: number;
  contacted: Rate;
  needConfirmed: Rate;
  quoted: Rate;
  won: Rate;
  paid: Rate;
  collectedGrossProfit: number;
  /** Per lead. The only ranking that survives a source with volume and no revenue. */
  profitPerLead: number | null;
  insufficientEvidence: string | null;
};

/**
 * What each source is actually worth.
 *
 * Ranked on collected gross profit per verified lead, and refusing to rank at
 * all below a sample floor. A connector that produced fifty thousand records
 * and no revenue looks productive on any count of records and looks like what
 * it is here.
 */
export async function sourcePerformance(params: {
  orgId: string;
  since?: Date;
}): Promise<SourceRow[]> {
  const grouped = await prisma.demandOutcome.groupBy({
    by: ['connector', 'stage'],
    where: { orgId: params.orgId, ...(params.since ? { occurredAt: { gte: params.since } } : {}) },
    _count: true,
    _sum: { collectedGrossProfit: true },
  });

  const byConnector = new Map<string, { counts: Map<OutcomeStage, number>; profit: number }>();
  for (const row of grouped) {
    const entry = byConnector.get(row.connector) ?? { counts: new Map(), profit: 0 };
    entry.counts.set(row.stage, row._count);
    entry.profit += Number(row._sum.collectedGrossProfit ?? 0);
    byConnector.set(row.connector, entry);
  }

  const rows: SourceRow[] = [];
  for (const [connector, entry] of byConnector) {
    const leads = entry.counts.get('VERIFIED_LEAD') ?? 0;
    const records = entry.counts.get('SOURCE_RECORD') ?? entry.counts.get('DEMAND_EVENT') ?? 0;

    rows.push({
      connector,
      records,
      verifiedLeads: leads,
      contacted: rate(entry.counts.get('CONTACTED') ?? 0, leads),
      needConfirmed: rate(entry.counts.get('NEED_CONFIRMED') ?? 0, leads),
      quoted: rate(entry.counts.get('QUOTED') ?? 0, leads),
      won: rate(entry.counts.get('WON') ?? 0, leads),
      paid: rate(entry.counts.get('PAID') ?? 0, leads),
      collectedGrossProfit: round2(entry.profit),
      profitPerLead: leads >= MIN_SAMPLE_FOR_RATES ? round2(entry.profit / leads) : null,
      insufficientEvidence: leads < MIN_SAMPLE_FOR_RATES
        ? `${leads} verified lead${leads === 1 ? '' : 's'}. Not enough to compare this source against another.`
        : null,
    });
  }

  // Sorted by profit per lead where it can be read, and by lead count
  // otherwise — never by record count, which is the number that flatters a
  // source that produces nothing.
  return rows.sort((a, b) => {
    if (a.profitPerLead !== null && b.profitPerLead !== null) return b.profitPerLead - a.profitPerLead;
    if (a.profitPerLead !== null) return -1;
    if (b.profitPerLead !== null) return 1;
    return b.verifiedLeads - a.verifiedLeads;
  });
}

export type RouteRow = {
  route: SignalCategory;
  verifiedLeads: number;
  stages: Array<{ stage: OutcomeStage; label: string; count: number }>;
  collectedGrossProfit: number;
  insufficientEvidence: string | null;
};

export async function routePerformance(params: { orgId: string; since?: Date }): Promise<RouteRow[]> {
  const grouped = await prisma.demandOutcome.groupBy({
    by: ['route', 'stage'],
    where: { orgId: params.orgId, route: { not: null }, ...(params.since ? { occurredAt: { gte: params.since } } : {}) },
    _count: true,
    _sum: { collectedGrossProfit: true },
  });

  const byRoute = new Map<SignalCategory, { counts: Map<OutcomeStage, number>; profit: number }>();
  for (const row of grouped) {
    if (!row.route) continue;
    const entry = byRoute.get(row.route) ?? { counts: new Map(), profit: 0 };
    entry.counts.set(row.stage, row._count);
    entry.profit += Number(row._sum.collectedGrossProfit ?? 0);
    byRoute.set(row.route, entry);
  }

  return Array.from(byRoute.entries())
    .map(([route, entry]) => {
      const leads = entry.counts.get('VERIFIED_LEAD') ?? 0;
      return {
        route,
        verifiedLeads: leads,
        stages: FUNNEL.map((stage) => ({
          stage,
          label: STAGE_LABELS[stage],
          count: entry.counts.get(stage) ?? 0,
        })),
        collectedGrossProfit: round2(entry.profit),
        insufficientEvidence: leads < MIN_SAMPLE_FOR_RATES
          ? `${leads} verified lead${leads === 1 ? '' : 's'} on this route. Too few to draw a conclusion from.`
          : null,
      };
    })
    .sort((a, b) => b.collectedGrossProfit - a.collectedGrossProfit || b.verifiedLeads - a.verifiedLeads);
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
