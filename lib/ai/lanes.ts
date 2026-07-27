import type { LaneRecommendation } from '@prisma/client';
import { num0, prisma } from '@/lib/db';
import { getOrgConfig } from '@/lib/config';
import { clamp01, recordDecision, round } from './decisions';

export const LANES_VERSION = 'deal_lanes@2';

export type LaneMetrics = {
  opportunityFrequency: number;
  contactRate: number;
  qualificationRate: number;
  averageDealSize: number;
  averageGrossMarginPct: number;
  averageTimeToCloseDays: number;
  fulfillmentReliability: number;
  repeatFrequency: number;
  switchingFriction: number;
  competitiveIntensity: number;
  paymentBehavior: number;
  operationalComplexity: number;
  callerEffortPerDeal: number;
  managementEffortPerDeal: number;
  riskScore: number;
  wonCount: number;
  lostCount: number;
  sampleSize: number;
};

/**
 * Evaluates a repeatable deal lane.
 *
 * The guardrail that matters: below the configured sample size the system
 * refuses to make a strategic recommendation. Three wins in a row is noise,
 * and telling an operator to scale on noise is worse than saying nothing.
 */
export async function evaluateLane(laneId: string): Promise<{
  metrics: LaneMetrics;
  laneScore: number;
  recommendation: LaneRecommendation;
  reason: string;
}> {
  const lane = await prisma.dealLane.findUniqueOrThrow({
    where: { id: laneId },
    include: {
      opportunities: {
        include: {
          deal: true,
          callAssignments: { include: { calls: true } },
          matches: true,
          buyerNeed: true,
          parties: { include: { company: true } },
        },
      },
    },
  });
  const config = await getOrgConfig(lane.orgId);
  const opportunities = lane.opportunities;
  const sampleSize = opportunities.length;

  const won = opportunities.filter((o) => o.status === 'WON');
  const lost = opportunities.filter((o) => o.status === 'LOST');
  const closed = won.length + lost.length;
  const qualified = opportunities.filter((o) => o.buyerNeed?.status === 'CONFIRMED');
  const contacted = opportunities.filter((o) => o.callAssignments.some((a) => a.calls.some((c) => c.outcome === 'CONNECTED')));

  const totalCalls = opportunities.reduce((sum, o) => sum + o.callAssignments.reduce((s, a) => s + a.calls.length, 0), 0);
  const totalAttempts = opportunities.reduce((sum, o) => sum + o.callAssignments.length, 0);

  const dealSizes = opportunities.map((o) => num0(o.estimatedValue)).filter((v) => v > 0);
  const margins = opportunities.map((o) => o.deal?.grossMarginPct ?? 0).filter((v) => v > 0);
  const cycleDays = won
    .filter((o) => o.closedAt)
    .map((o) => (o.closedAt!.getTime() - o.createdAt.getTime()) / 86_400_000);

  const recurring = opportunities.filter((o) => o.buyerNeed?.frequency === 'recurring').length;
  const lockedAccounts = opportunities.filter((o) => o.parties.some((p) => p.company.movability === 'RELATIONSHIP_LOCKED')).length;
  const incumbentPresent = opportunities.filter((o) => Boolean(o.buyerNeed?.currentProvider)).length;
  const complianceHeavy = opportunities.filter((o) => o.matches.some((m) => m.missingInformation.some((mi) => /insurance|licen/i.test(mi)))).length;

  const metrics: LaneMetrics = {
    opportunityFrequency: sampleSize,
    contactRate: sampleSize ? round(contacted.length / sampleSize, 3) : 0,
    qualificationRate: sampleSize ? round(qualified.length / sampleSize, 3) : 0,
    averageDealSize: dealSizes.length ? round(dealSizes.reduce((a, b) => a + b, 0) / dealSizes.length) : 0,
    averageGrossMarginPct: margins.length ? round(margins.reduce((a, b) => a + b, 0) / margins.length, 1) : 0,
    averageTimeToCloseDays: cycleDays.length ? round(cycleDays.reduce((a, b) => a + b, 0) / cycleDays.length, 1) : 0,
    fulfillmentReliability: closed ? round(won.length / closed, 3) : 0,
    repeatFrequency: sampleSize ? round(recurring / sampleSize, 3) : 0,
    switchingFriction: sampleSize ? round(lockedAccounts / sampleSize, 3) : 0,
    competitiveIntensity: sampleSize ? round(incumbentPresent / sampleSize, 3) : 0,
    paymentBehavior: 0.7,
    operationalComplexity: sampleSize ? round(complianceHeavy / sampleSize, 3) : 0,
    callerEffortPerDeal: won.length ? round(totalCalls / won.length, 1) : totalCalls ? round(totalCalls, 1) : 0,
    managementEffortPerDeal: won.length ? round(totalAttempts / won.length, 1) : 0,
    riskScore: 0,
    wonCount: won.length,
    lostCount: lost.length,
    sampleSize,
  };
  metrics.riskScore = round(
    clamp01(metrics.operationalComplexity * 0.4 + metrics.switchingFriction * 0.3 + (1 - metrics.fulfillmentReliability) * 0.3),
    3,
  );

  // Lane score blends economics against effort and risk.
  const marginComponent = clamp01(metrics.averageGrossMarginPct / (config.marginRules.targetGrossMarginPct * 1.5));
  const sizeComponent = clamp01(metrics.averageDealSize / 50000);
  const speedComponent = metrics.averageTimeToCloseDays > 0 ? clamp01(1 - metrics.averageTimeToCloseDays / 120) : 0.4;
  const effortComponent = metrics.callerEffortPerDeal > 0 ? clamp01(1 - metrics.callerEffortPerDeal / 20) : 0.5;

  const laneScore = round(
    clamp01(
      marginComponent * 0.22 +
        sizeComponent * 0.14 +
        metrics.qualificationRate * 0.16 +
        metrics.fulfillmentReliability * 0.16 +
        metrics.repeatFrequency * 0.14 +
        speedComponent * 0.08 +
        effortComponent * 0.1 -
        metrics.riskScore * 0.2,
    ),
    3,
  );

  const { recommendation, reason } = recommendLane(metrics, laneScore, config.planning.minimumLaneSampleSize, config.marginRules.minimumGrossMarginPct);

  await prisma.dealLane.update({
    where: { id: laneId },
    data: { metrics: metrics as object, laneScore, recommendation, recommendationReason: reason, sampleSize, evaluatedAt: new Date() },
  });

  await recordDecision({
    orgId: lane.orgId,
    process: 'deal_lane_evaluation',
    decision: `${lane.name}: ${recommendation}`,
    reason,
    inputs: { sampleSize, wonCount: won.length, lostCount: lost.length },
    outputs: { laneScore, metrics: metrics as unknown as Record<string, unknown> },
    confidence: sampleSize >= config.planning.minimumLaneSampleSize ? 0.75 : 0.25,
    rulesApplied: ['minimum_sample_size', 'lane_score_weights'],
    modelName: 'deterministic',
    promptVersion: LANES_VERSION,
  });

  return { metrics, laneScore, recommendation, reason };
}

export function recommendLane(
  metrics: LaneMetrics,
  laneScore: number,
  minimumSample: number,
  minimumMarginPct: number,
): { recommendation: LaneRecommendation; reason: string } {
  if (metrics.sampleSize < minimumSample) {
    return {
      recommendation: 'INSUFFICIENT_DATA',
      reason:
        `Only ${metrics.sampleSize} opportunit${metrics.sampleSize === 1 ? 'y' : 'ies'} in this lane against a minimum sample of ${minimumSample}. ` +
        'Any strategic call at this volume would be reading noise. Keep running the lane and re-evaluate once the sample is large enough.',
    };
  }

  if (metrics.qualificationRate < 0.2) {
    return {
      recommendation: 'CHANGE_TARGET_PROFILE',
      reason:
        `Only ${(metrics.qualificationRate * 100).toFixed(0)}% of opportunities in this lane reach a confirmed need. ` +
        'The targeting is wrong, not the execution — the companies being discovered do not have the problem this lane solves.',
    };
  }
  if (metrics.contactRate < 0.3) {
    return {
      recommendation: 'IMPROVE_SCRIPT',
      reason:
        `Contact rate is ${(metrics.contactRate * 100).toFixed(0)}%. Opportunities are being created but conversations are not happening. ` +
        'Review the opener, the call timing and which contact is being targeted before changing anything else.',
    };
  }
  if (metrics.fulfillmentReliability < 0.35 && metrics.wonCount + metrics.lostCount >= minimumSample) {
    return {
      recommendation: 'IMPROVE_FULFILLMENT_COVERAGE',
      reason:
        `Only ${(metrics.fulfillmentReliability * 100).toFixed(0)}% of closed deals in this lane were won. ` +
        'Demand is being found and qualified, then lost at delivery. The gap is fulfillment capacity, not sales.',
    };
  }
  if (metrics.averageGrossMarginPct > 0 && metrics.averageGrossMarginPct < minimumMarginPct) {
    return {
      recommendation: 'PAUSE',
      reason:
        `Average gross margin is ${metrics.averageGrossMarginPct}% against a ${minimumMarginPct}% floor. ` +
        'This lane consumes caller and management capacity to produce deals that do not clear the margin bar. Pause it and redeploy the hours.',
    };
  }
  if (laneScore >= 0.65 && metrics.wonCount >= 2) {
    return {
      recommendation: 'SCALE',
      reason:
        `Lane score ${laneScore} on ${metrics.sampleSize} opportunities: ${metrics.averageGrossMarginPct}% average margin, ` +
        `${(metrics.fulfillmentReliability * 100).toFixed(0)}% win rate on closed deals, ${(metrics.repeatFrequency * 100).toFixed(0)}% recurring, ` +
        `${metrics.callerEffortPerDeal} calls per won deal. The economics hold at this volume — add discovery sources and caller hours here.`,
    };
  }
  if (laneScore < 0.25) {
    return {
      recommendation: 'ABANDON',
      reason:
        `Lane score ${laneScore} across ${metrics.sampleSize} opportunities with ${metrics.wonCount} win(s). ` +
        'The lane has had a fair sample and has not produced. Stop feeding it and move the capacity to a lane that is working.',
    };
  }
  return {
    recommendation: 'CONTINUE_TESTING',
    reason:
      `Lane score ${laneScore} on ${metrics.sampleSize} opportunities is neither clearly good nor clearly bad. ` +
      `Margin ${metrics.averageGrossMarginPct}%, win rate ${(metrics.fulfillmentReliability * 100).toFixed(0)}%, ` +
      `${metrics.callerEffortPerDeal} calls per deal. Keep running it and re-evaluate at double the sample.`,
  };
}

/** Assigns opportunities to lanes by matching the lane's target profile. */
export async function assignOpportunitiesToLanes(orgId: string): Promise<number> {
  const lanes = await prisma.dealLane.findMany({ where: { orgId, isActive: true } });
  const unassigned = await prisma.opportunity.findMany({
    where: { orgId, laneId: null },
    include: { parties: { include: { company: { include: { industries: { include: { industry: true } } } } } }, buyerNeed: true },
    take: 500,
  });

  let assigned = 0;
  for (const opportunity of unassigned) {
    const text = [
      opportunity.name,
      opportunity.summary,
      opportunity.buyerNeed?.scope ?? '',
      ...opportunity.parties.flatMap((p) => p.company.industries.map((i) => i.industry.key)),
    ]
      .join(' ')
      .toLowerCase();

    const candidate = lanes.find((lane) => {
      if (lane.opportunityType !== opportunity.type) return false;
      const profile = lane.targetProfile as { keywords?: string[] };
      const keywords = profile.keywords ?? [];
      return keywords.length > 0 && keywords.some((k) => text.includes(k.toLowerCase()));
    });

    if (candidate) {
      await prisma.opportunity.update({ where: { id: opportunity.id }, data: { laneId: candidate.id } });
      assigned += 1;
    }
  }
  return assigned;
}

export async function evaluateAllLanes(orgId: string): Promise<number> {
  const lanes = await prisma.dealLane.findMany({ where: { orgId, isActive: true }, select: { id: true } });
  for (const lane of lanes) {
    await evaluateLane(lane.id);
  }
  return lanes.length;
}
