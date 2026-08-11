import type { OutcomeStage, Prisma, SignalCategory } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * Source performance, measured to collected money.
 *
 * The chain is recorded from the first day even though most of it will be
 * empty for months:
 *
 *   source record → demand event → verified lead → contacted → responded
 *   → qualified conversation → quoted → won → completed → paid
 *
 * It is recorded early because the alternative is measuring what is easy to
 * measure. A source that produces fifty thousand records and no revenue looks
 * productive on any count of records, and looks like exactly what it is on a
 * count of paid jobs. Waiting until there are paid jobs to start counting
 * means never being able to attribute them.
 *
 * Nothing is invented. A stage with no rows reports zero and the dashboard
 * says the sample is too small to judge, rather than showing a conversion rate
 * derived from four data points.
 */

/** Below this many verified leads, a conversion rate is noise. */
const MIN_SAMPLE_FOR_RATES = 20;

export async function recordOutcome(input: {
  orgId: string;
  connector: string;
  playbookKey?: string | null;
  route?: SignalCategory | null;
  eventId?: string | null;
  routeId?: string | null;
  stage: OutcomeStage;
  occurredAt?: Date;
  collectedRevenue?: number | null;
  collectedGrossProfit?: number | null;
  humanMinutes?: number | null;
  note?: string;
}): Promise<void> {
  // Milestones, not activity: a lead contacted three times has one contacted
  // milestone, so the funnel counts leads rather than phone calls.
  if (input.routeId) {
    await prisma.demandOutcome.upsert({
      where: { routeId_stage: { routeId: input.routeId, stage: input.stage } },
      create: {
        orgId: input.orgId,
        connector: input.connector,
        playbookKey: input.playbookKey ?? null,
        route: input.route ?? null,
        eventId: input.eventId ?? null,
        routeId: input.routeId,
        stage: input.stage,
        occurredAt: input.occurredAt ?? new Date(),
        collectedRevenue: input.collectedRevenue ?? null,
        collectedGrossProfit: input.collectedGrossProfit ?? null,
        humanMinutes: input.humanMinutes ?? null,
        note: input.note ?? null,
      },
      update: {
        // Money is allowed to arrive later than the milestone.
        collectedRevenue: input.collectedRevenue ?? undefined,
        collectedGrossProfit: input.collectedGrossProfit ?? undefined,
        humanMinutes: input.humanMinutes ?? undefined,
      },
    });
    return;
  }

  await prisma.demandOutcome.create({
    data: {
      orgId: input.orgId,
      connector: input.connector,
      playbookKey: input.playbookKey ?? null,
      route: input.route ?? null,
      eventId: input.eventId ?? null,
      stage: input.stage,
      occurredAt: input.occurredAt ?? new Date(),
      collectedRevenue: input.collectedRevenue ?? null,
      collectedGrossProfit: input.collectedGrossProfit ?? null,
      humanMinutes: input.humanMinutes ?? null,
      note: input.note ?? null,
    },
  });
}

export type SourceScorecard = {
  connector: string;
  counts: Record<OutcomeStage, number>;
  collectedRevenue: number;
  collectedGrossProfit: number;
  humanMinutes: number;
  /** Null until the sample is big enough to mean anything. */
  leadToQuoteRate: number | null;
  quoteToWinRate: number | null;
  profitPerHumanHour: number | null;
  /** What the numbers can and cannot yet support. */
  verdict: string;
};

const STAGES: OutcomeStage[] = [
  'SOURCE_RECORD',
  'DEMAND_EVENT',
  'VERIFIED_LEAD',
  'CONTACTED',
  'RESPONDED',
  'QUALIFIED_CONVERSATION',
  'QUOTED',
  'WON',
  'LOST',
  'COMPLETED',
  'PAID',
];

export async function sourceScorecards(orgId: string): Promise<SourceScorecard[]> {
  const rows = await prisma.demandOutcome.groupBy({
    by: ['connector', 'stage'],
    where: { orgId },
    _count: true,
    _sum: { collectedRevenue: true, collectedGrossProfit: true, humanMinutes: true },
  });

  const byConnector = new Map<string, typeof rows>();
  for (const row of rows) byConnector.set(row.connector, [...(byConnector.get(row.connector) ?? []), row]);

  return [...byConnector.entries()].map(([connector, connectorRows]) => {
    const counts = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<OutcomeStage, number>;
    let revenue = 0;
    let profit = 0;
    let minutes = 0;

    for (const row of connectorRows) {
      counts[row.stage] = row._count;
      revenue += Number(row._sum.collectedRevenue ?? 0);
      profit += Number(row._sum.collectedGrossProfit ?? 0);
      minutes += row._sum.humanMinutes ?? 0;
    }

    const leads = counts.VERIFIED_LEAD;
    const enoughSample = leads >= MIN_SAMPLE_FOR_RATES;

    return {
      connector,
      counts,
      collectedRevenue: revenue,
      collectedGrossProfit: profit,
      humanMinutes: minutes,
      // A rate from four leads is noise dressed as a measurement.
      leadToQuoteRate: enoughSample && leads > 0 ? counts.QUOTED / leads : null,
      quoteToWinRate: enoughSample && counts.QUOTED > 0 ? counts.WON / counts.QUOTED : null,
      profitPerHumanHour: minutes > 0 && profit > 0 ? Math.round((profit / minutes) * 60) : null,
      verdict: verdictFor({ leads, paid: counts.PAID, profit, enoughSample }),
    };
  });
}

function verdictFor(input: { leads: number; paid: number; profit: number; enoughSample: boolean }): string {
  if (input.paid > 0) {
    return `${input.paid} paid job(s), $${Math.round(input.profit).toLocaleString()} collected gross profit. This is the number that decides whether the source stays.`;
  }
  if (input.leads === 0) {
    return 'No verified leads yet. Nothing to judge.';
  }
  if (!input.enoughSample) {
    return `${input.leads} verified lead(s) and no completed jobs. Too few to judge — conversion rates from a sample this size would be noise.`;
  }
  return `${input.leads} verified leads and no paid jobs yet. Worth watching: a source that keeps producing leads that never convert is worse than one producing none, because it consumes attention.`;
}

/**
 * A view of the whole funnel across every source.
 *
 * Deliberately shows the empty stages. A funnel that stops at "verified lead"
 * is a funnel telling you something true about the state of the business.
 */
export async function funnelTotals(orgId: string): Promise<Array<{ stage: OutcomeStage; count: number }>> {
  const rows = await prisma.demandOutcome.groupBy({
    by: ['stage'],
    where: { orgId },
    _count: true,
  });
  const counts = new Map(rows.map((r) => [r.stage, r._count]));
  return STAGES.map((stage) => ({ stage, count: counts.get(stage) ?? 0 }));
}

export type { OutcomeStage };
export const OUTCOME_STAGES = STAGES;

/** Milestone rows written by the pipeline itself, so the chain starts full. */
export async function recordPipelineMilestones(input: {
  orgId: string;
  routes: Array<{
    id: string;
    eventId: string;
    connector: string;
    playbookKey: string;
    route: SignalCategory;
    tier: string;
    status: string;
  }>;
}): Promise<number> {
  let written = 0;
  for (const route of input.routes) {
    // A verified lead is a route on a verified event at tier A or B. Anything
    // weaker is a record, not a lead, and counting it as one is how a funnel
    // starts lying at the top.
    if (route.tier !== 'ACTIVE_DEMAND' && route.tier !== 'STRONG_TRIGGER') continue;
    if (route.status === 'EXPIRED') continue;

    await recordOutcome({
      orgId: input.orgId,
      connector: route.connector,
      playbookKey: route.playbookKey,
      route: route.route,
      eventId: route.eventId,
      routeId: route.id,
      stage: 'VERIFIED_LEAD',
    });
    written += 1;
  }
  return written;
}

export type OutcomeInput = Prisma.DemandOutcomeCreateInput;
