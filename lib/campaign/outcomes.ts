import type { CampaignComparator, CampaignMetric } from '@prisma/client';
import { prisma } from '@/lib/db';
import { grossProfitOf } from '@/lib/evidence/economics';

/**
 * What a campaign actually produced, all the way to money that arrived.
 *
 * A campaign is only worth the model behind it if its outcomes are measured
 * on the same chain everything else is: routes, conversations, confirmed
 * requirements, verified providers, quotes, commitments, collected gross
 * profit. Anything short of the last one is progress, not proof — and a
 * strategist that concludes from quotes sent is a strategist that will keep
 * recommending campaigns that quote well and collect nothing.
 *
 * Gross profit here runs through the same evidence rule as everywhere else:
 * only money resting on a real provider cost counts. A campaign cannot make
 * its own numbers look better by having priced optimistically.
 */

export type CampaignOutcome = {
  campaignId: string;
  routesGenerated: number;
  conversationsHeld: number;
  requirementsConfirmed: number;
  providersVerified: number;
  quotesSent: number;
  commitmentsWon: number;
  /** Collected, settled, and resting on a real cost side. */
  collectedGrossProfit: number;
  spendCents: number;
  daysRunning: number;
  /** Collected gross profit per pound spent. Null while nothing has been spent. */
  returnOnSpend: number | null;
  /** The first rung of the chain with nothing in it. */
  firstEmptyStage: string | null;
};

export async function campaignOutcome(params: {
  orgId: string;
  campaignId: string;
  now?: Date;
}): Promise<CampaignOutcome> {
  const now = params.now ?? new Date();
  const campaign = await prisma.campaign.findFirstOrThrow({
    where: { id: params.campaignId, orgId: params.orgId },
    select: { startedAt: true, channels: { select: { spentCents: true } } },
  });

  const routes = await prisma.routeHypothesis.findMany({
    where: { orgId: params.orgId, campaignId: params.campaignId },
    select: { id: true },
  });
  const routeIds = routes.map((r) => r.id);

  if (routeIds.length === 0) {
    const spendCents = campaign.channels.reduce((n, c) => n + c.spentCents, 0);
    return {
      campaignId: params.campaignId,
      routesGenerated: 0,
      conversationsHeld: 0,
      requirementsConfirmed: 0,
      providersVerified: 0,
      quotesSent: 0,
      commitmentsWon: 0,
      collectedGrossProfit: 0,
      spendCents,
      daysRunning: daysSince(campaign.startedAt, now),
      returnOnSpend: spendCents > 0 ? 0 : null,
      firstEmptyStage: 'routes generated',
    };
  }

  const [conversations, requirements, providers, quotes, deals, payments] = await Promise.all([
    prisma.outreachAttempt.findMany({
      where: {
        orgId: params.orgId,
        routeId: { in: routeIds },
        // An attempt that reached nobody is not a conversation, and counting
        // it as one is how a campaign looks busy while learning nothing.
        disposition: {
          in: ['NEED_CONFIRMED', 'DECISION_MAKER_IDENTIFIED', 'FOLLOW_UP', 'GATEKEEPER', 'NOT_INTERESTED', 'DO_NOT_CONTACT'],
        },
      },
      select: { routeId: true },
    }),
    prisma.buyerRequirement.findMany({
      where: { orgId: params.orgId, routeId: { in: routeIds }, state: 'CURRENT' },
      select: { confirmedFields: true },
    }),
    prisma.providerCandidate.count({
      where: { orgId: params.orgId, routeId: { in: routeIds }, capabilityVerifiedAt: { not: null } },
    }),
    prisma.routeQuote.findMany({
      where: { orgId: params.orgId, routeId: { in: routeIds } },
      select: { state: true },
    }),
    prisma.routeDeal.findMany({
      where: { orgId: params.orgId, routeId: { in: routeIds } },
      select: { id: true },
    }),
    prisma.routeQuote.findMany({
      where: { orgId: params.orgId, routeId: { in: routeIds }, state: 'ACCEPTED' },
      select: { basis: true, buyerPrice: true, providerCost: true, costSideMissing: true, routeId: true },
    }),
  ]);

  const dealIds = deals.map((d) => d.id);
  const settled = dealIds.length
    ? await prisma.dealPayment.findMany({
        where: {
          orgId: params.orgId,
          dealId: { in: dealIds },
          direction: 'INBOUND',
          settledAt: { not: null },
        },
        select: { dealId: true },
      })
    : [];

  // Only quotes behind a deal that has actually been paid, and only where the
  // cost side is real. The evidence rule is not relaxed because it is a
  // campaign being measured.
  const paidRoutes = new Set(
    (
      await prisma.routeDeal.findMany({
        where: { orgId: params.orgId, id: { in: settled.map((s) => s.dealId) } },
        select: { routeId: true },
      })
    ).map((d) => d.routeId),
  );

  const collectedGrossProfit = payments
    .filter((q) => paidRoutes.has(q.routeId))
    .map((q) =>
      grossProfitOf({
        basis: q.basis,
        buyerPrice: q.buyerPrice === null ? null : Number(q.buyerPrice),
        providerCost: q.providerCost === null ? null : Number(q.providerCost),
        costSideMissing: q.costSideMissing,
      }),
    )
    .filter((gp) => gp.value !== null && gp.evidence !== 'INFERRED' && gp.evidence !== 'UNKNOWN')
    .reduce((sum, gp) => sum + (gp.value as number), 0);

  const spendCents = campaign.channels.reduce((n, c) => n + c.spentCents, 0);
  const outcome: CampaignOutcome = {
    campaignId: params.campaignId,
    routesGenerated: routeIds.length,
    conversationsHeld: new Set(conversations.map((c) => c.routeId)).size,
    requirementsConfirmed: requirements.filter(
      (r) => Array.isArray(r.confirmedFields) && r.confirmedFields.length > 0,
    ).length,
    providersVerified: providers,
    quotesSent: quotes.filter((q) => q.state === 'SENT' || q.state === 'ACCEPTED').length,
    commitmentsWon: dealIds.length,
    collectedGrossProfit,
    spendCents,
    daysRunning: daysSince(campaign.startedAt, now),
    returnOnSpend: spendCents > 0 ? collectedGrossProfit / (spendCents / 100) : null,
    firstEmptyStage: null,
  };

  outcome.firstEmptyStage = firstEmpty(outcome);
  return outcome;
}

const CHAIN: Array<[string, (o: CampaignOutcome) => number]> = [
  ['routes generated', (o) => o.routesGenerated],
  ['conversations held', (o) => o.conversationsHeld],
  ['requirements confirmed', (o) => o.requirementsConfirmed],
  ['providers verified', (o) => o.providersVerified],
  ['quotes sent', (o) => o.quotesSent],
  ['commitments won', (o) => o.commitmentsWon],
  ['collected gross profit', (o) => o.collectedGrossProfit],
];

function firstEmpty(outcome: CampaignOutcome): string | null {
  for (const [label, read] of CHAIN) {
    if (read(outcome) === 0) return label;
  }
  return null;
}

function daysSince(from: Date | null, now: Date): number {
  if (!from) return 0;
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / 86_400_000));
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

/** The current value of a metric, in the unit the condition compares against. */
export function metricValue(metric: CampaignMetric, outcome: CampaignOutcome): number | null {
  switch (metric) {
    case 'ROUTES_GENERATED': return outcome.routesGenerated;
    case 'CONVERSATIONS_HELD': return outcome.conversationsHeld;
    case 'REQUIREMENTS_CONFIRMED': return outcome.requirementsConfirmed;
    case 'PROVIDERS_VERIFIED': return outcome.providersVerified;
    case 'QUOTES_SENT': return outcome.quotesSent;
    case 'COMMITMENTS_WON': return outcome.commitmentsWon;
    case 'COLLECTED_GROSS_PROFIT': return outcome.collectedGrossProfit;
    case 'SPEND': return outcome.spendCents;
    case 'DAYS_RUNNING': return outcome.daysRunning;
    // Null rather than zero: no spend means the ratio is undefined, and a
    // condition comparing against it must not fire on a division that never
    // happened.
    case 'RETURN_ON_SPEND': return outcome.returnOnSpend;
    default: return null;
  }
}

export function comparatorHolds(value: number, comparator: CampaignComparator, threshold: number): boolean {
  switch (comparator) {
    case 'BELOW': return value < threshold;
    case 'AT_OR_BELOW': return value <= threshold;
    case 'ABOVE': return value > threshold;
    case 'AT_OR_ABOVE': return value >= threshold;
    default: return false;
  }
}

/**
 * Whether a condition fires right now.
 *
 * Three things stop this being trigger-happy, and each corresponds to a way a
 * campaign could be killed unfairly. A grace period, so a quiet first morning
 * does not end it. A null metric that never fires, so an undefined ratio is
 * not read as zero. And evaluation only while the campaign is actually
 * running, so a paused campaign is not killed for producing nothing while
 * deliberately stopped.
 */
export function conditionFires(input: {
  condition: {
    metric: CampaignMetric;
    comparator: CampaignComparator;
    threshold: number;
    afterDays: number;
  };
  outcome: CampaignOutcome;
}): { fires: boolean; value: number | null; because: string } {
  const value = metricValue(input.condition.metric, input.outcome);

  if (input.outcome.daysRunning < input.condition.afterDays) {
    return {
      fires: false,
      value,
      because:
        `Only ${input.outcome.daysRunning} day(s) in; this condition waits for `
        + `${input.condition.afterDays}.`,
    };
  }
  if (value === null) {
    return {
      fires: false,
      value,
      because: `${input.condition.metric} has no value yet, so there is nothing to compare against.`,
    };
  }

  const fires = comparatorHolds(value, input.condition.comparator, input.condition.threshold);
  return {
    fires,
    value,
    because: fires
      ? `${input.condition.metric} is ${value}, which is ${describe(input.condition.comparator)} ${input.condition.threshold}.`
      : `${input.condition.metric} is ${value}, which is not ${describe(input.condition.comparator)} ${input.condition.threshold}.`,
  };
}

function describe(comparator: CampaignComparator): string {
  switch (comparator) {
    case 'BELOW': return 'below';
    case 'AT_OR_BELOW': return 'at or below';
    case 'ABOVE': return 'above';
    case 'AT_OR_ABOVE': return 'at or above';
    default: return String(comparator);
  }
}
