import { num0, prisma } from '@/lib/db';
import { clamp01, round } from './decisions';

export const ANALYTICS_VERSION = 'caller_analytics@2';

export type CallerMetrics = {
  userId: string;
  name: string;
  callsAttempted: number;
  contactsReached: number;
  meaningfulConversations: number;
  requiredQuestionsCompletionRate: number;
  informationAccuracy: number;
  qualificationRate: number;
  opportunitiesCreated: number;
  pricingObtained: number;
  matchesEnabled: number;
  quotesEnabled: number;
  followUpsCompleted: number;
  trialsSecured: number;
  dealsInfluenced: number;
  grossProfitInfluenced: number;
  scriptCompliance: number;
  unauthorizedPromises: number;
  averageTalkRatio: number;
  averageCallDurationSec: number;
  connectRate: number;
  byCallType: Record<string, { attempted: number; connected: number; connectRate: number }>;
  byHour: Record<string, { attempted: number; connected: number }>;
  byWeekday: Record<string, { attempted: number; connected: number }>;
  /**
   * What each rate above was divided by.
   *
   * Every ratio here was rendered as a percentage with no denominator in
   * reach, so an accuracy of 100% over two facts and one over two hundred read
   * identically — and the first is the one that gets somebody praised or
   * managed. A rate cannot be judged without the count under it, so the count
   * travels with it.
   */
  denominators: {
    /** Facts captured, for informationAccuracy. */
    facts: number;
    /** Required questions across the calls, for scriptCompliance. */
    requiredQuestions: number;
    /** Calls with a measurable talk ratio, for averageTalkRatio. */
    talkRatios: number;
    /** Opportunities touched, for qualificationRate. */
    opportunities: number;
  };
};

export type CoachingRecommendation = {
  kind: 'coaching' | 'script' | 'assignment' | 'training' | 'permission' | 'review';
  severity: 'info' | 'warning' | 'critical';
  headline: string;
  detail: string;
};

/**
 * Caller performance measured by business outcomes, not dials.
 *
 * A caller who makes 20 calls and produces six confirmed needs is worth more
 * than one who makes 60 and produces none, and the metrics say so.
 */
export async function computeCallerMetrics(params: {
  orgId: string;
  userId: string;
  periodStart: Date;
  periodEnd: Date;
}): Promise<CallerMetrics> {
  const { orgId, userId, periodStart, periodEnd } = params;

  const user = await prisma.user.findFirstOrThrow({ where: { id: userId, orgId }, select: { name: true } });

  const calls = await prisma.call.findMany({
    where: { orgId, callerId: userId, startedAt: { gte: periodStart, lte: periodEnd } },
    include: {
      assignment: { include: { opportunity: { include: { deal: true, buyerNeed: true, matches: true, quotes: true } } } },
      transcript: { include: { facts: true } },
      commitments: true,
    },
  });

  const connected = calls.filter((c) => c.outcome === 'CONNECTED');
  const meaningful = connected.filter((c) => (c.durationSec ?? 0) >= 60 || (c.transcript?.facts.length ?? 0) >= 3);

  // Question coverage: did the call actually collect what it was sent to collect?
  let requiredQuestionsAsked = 0;
  let requiredQuestionsTotal = 0;
  for (const call of connected) {
    const required = (call.assignment?.requiredQuestions as Array<{ factKey: string }> | null) ?? [];
    requiredQuestionsTotal += required.length;
    const capturedKeys = new Set((call.transcript?.facts ?? []).map((f) => f.factKey));
    requiredQuestionsAsked += required.filter((q) => capturedKeys.has(q.factKey)).length;
  }

  const allFacts = calls.flatMap((c) => c.transcript?.facts ?? []);
  const contradicted = allFacts.filter((f) => f.status === 'CONTRADICTED').length;
  const informationAccuracy = allFacts.length ? round(1 - contradicted / allFacts.length, 3) : 1;

  const opportunityIds = [...new Set(calls.map((c) => c.assignment?.opportunityId).filter(Boolean) as string[])];
  const opportunities = calls
    .map((c) => c.assignment?.opportunity)
    .filter((o): o is NonNullable<typeof o> => Boolean(o));
  const unique = new Map(opportunities.map((o) => [o.id, o]));

  const qualified = [...unique.values()].filter((o) => o.buyerNeed?.status === 'CONFIRMED').length;
  const pricingObtained = allFacts.filter((f) => f.factKey.startsWith('pricing.') || f.factKey === 'supply.unit_cost').length;
  const matchesEnabled = [...unique.values()].reduce((sum, o) => sum + o.matches.filter((m) => m.score >= 0.5).length, 0);
  const quotesEnabled = [...unique.values()].reduce((sum, o) => sum + o.quotes.length, 0);
  const trials = allFacts.filter((f) => f.factKey.startsWith('trial.') && /yes|open|willing/i.test(f.factValue)).length;
  const followUps = calls.filter((c) => c.assignment?.callType === 'QUOTE_FOLLOW_UP' && c.outcome === 'CONNECTED').length;

  const wonOrConfigured = [...unique.values()].filter((o) => o.deal?.isConfigurable || o.status === 'WON');
  const grossProfitInfluenced = wonOrConfigured.reduce((sum, o) => sum + num0(o.deal?.grossProfit ?? o.estimatedGrossProfit), 0);

  const unauthorized = calls.flatMap((c) => c.commitments).filter((c) => !c.isAuthorized).length;
  const scriptCompliance = requiredQuestionsTotal > 0 ? round(requiredQuestionsAsked / requiredQuestionsTotal, 3) : 1;

  const talkRatios = calls.map((c) => c.talkRatio).filter((r): r is number => r !== null);
  const durations = calls.map((c) => c.durationSec).filter((d): d is number => d !== null);

  const byCallType: CallerMetrics['byCallType'] = {};
  const byHour: CallerMetrics['byHour'] = {};
  const byWeekday: CallerMetrics['byWeekday'] = {};

  for (const call of calls) {
    const type = call.assignment?.callType ?? 'UNKNOWN';
    byCallType[type] ??= { attempted: 0, connected: 0, connectRate: 0 };
    byCallType[type].attempted += 1;
    if (call.outcome === 'CONNECTED') byCallType[type].connected += 1;

    const hour = String(call.startedAt.getUTCHours()).padStart(2, '0');
    byHour[hour] ??= { attempted: 0, connected: 0 };
    byHour[hour].attempted += 1;
    if (call.outcome === 'CONNECTED') byHour[hour].connected += 1;

    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][call.startedAt.getUTCDay()];
    byWeekday[weekday] ??= { attempted: 0, connected: 0 };
    byWeekday[weekday].attempted += 1;
    if (call.outcome === 'CONNECTED') byWeekday[weekday].connected += 1;
  }
  for (const stats of Object.values(byCallType)) {
    stats.connectRate = stats.attempted ? round(stats.connected / stats.attempted, 3) : 0;
  }

  return {
    userId,
    name: user.name,
    callsAttempted: calls.length,
    contactsReached: connected.length,
    meaningfulConversations: meaningful.length,
    requiredQuestionsCompletionRate: scriptCompliance,
    informationAccuracy,
    qualificationRate: opportunityIds.length ? round(qualified / opportunityIds.length, 3) : 0,
    opportunitiesCreated: opportunityIds.length,
    pricingObtained,
    matchesEnabled,
    quotesEnabled,
    followUpsCompleted: followUps,
    trialsSecured: trials,
    dealsInfluenced: wonOrConfigured.length,
    grossProfitInfluenced: round(grossProfitInfluenced),
    scriptCompliance,
    unauthorizedPromises: unauthorized,
    averageTalkRatio: talkRatios.length ? round(talkRatios.reduce((a, b) => a + b, 0) / talkRatios.length, 3) : 0,
    averageCallDurationSec: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
    connectRate: calls.length ? round(connected.length / calls.length, 3) : 0,
    byCallType,
    byHour,
    byWeekday,
    denominators: {
      facts: allFacts.length,
      requiredQuestions: requiredQuestionsTotal,
      talkRatios: talkRatios.length,
      opportunities: opportunityIds.length,
    },
  };
}

/**
 * Turns metrics into recommendations. Deliberately advisory only — the system
 * flags evidence for a manager and never takes employment action itself.
 */
export function recommendCoaching(metrics: CallerMetrics): CoachingRecommendation[] {
  const recommendations: CoachingRecommendation[] = [];

  if (metrics.unauthorizedPromises > 0) {
    recommendations.push({
      kind: 'review',
      severity: 'critical',
      headline: `${metrics.unauthorizedPromises} unauthorised commitment(s) detected`,
      detail:
        'Statements exceeding caller authority were made on recorded calls. A manager should review the recordings, decide whether anything ' +
        'needs correcting with the contact, and re-brief the caller on what may and may not be offered. This is flagged for human review — ' +
        'the system takes no action against a worker on its own.',
    });
  }

  if (metrics.callsAttempted >= 10 && metrics.scriptCompliance < 0.6) {
    recommendations.push({
      kind: 'coaching',
      severity: 'warning',
      headline: `Only ${(metrics.scriptCompliance * 100).toFixed(0)}% of required questions are being answered`,
      detail:
        'Calls are happening but coming back without the facts they were sent to collect, which forces a second call for the same information. ' +
        'Work through the required-question list with the caller and confirm they know why each one blocks the deal.',
    });
  }

  if (metrics.averageTalkRatio > 0.65 && metrics.callsAttempted >= 5) {
    recommendations.push({
      kind: 'coaching',
      severity: 'warning',
      headline: `Talking ${(metrics.averageTalkRatio * 100).toFixed(0)}% of the call`,
      detail:
        'Qualification calls are about extraction, not presentation. A caller doing most of the talking is not collecting facts. ' +
        'Target under 45% and coach on open questions and silence after asking.',
    });
  }

  if (metrics.informationAccuracy < 0.8 && metrics.callsAttempted >= 10) {
    recommendations.push({
      kind: 'training',
      severity: 'warning',
      headline: `${((1 - metrics.informationAccuracy) * 100).toFixed(0)}% of captured facts were later contradicted`,
      detail:
        'Facts recorded from this caller are being overturned by later evidence. Coach on confirming and reading back key numbers ' +
        '(price, quantity, dates, insurance limits) before ending the call.',
    });
  }

  const typeEntries = Object.entries(metrics.byCallType).filter(([, s]) => s.attempted >= 5);
  if (typeEntries.length >= 2) {
    const sorted = [...typeEntries].sort((a, b) => b[1].connectRate - a[1].connectRate);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    if (best[1].connectRate - worst[1].connectRate > 0.25) {
      recommendations.push({
        kind: 'assignment',
        severity: 'info',
        headline: `Much stronger on ${best[0].replace(/_/g, ' ').toLowerCase()} than ${worst[0].replace(/_/g, ' ').toLowerCase()}`,
        detail:
          `${(best[1].connectRate * 100).toFixed(0)}% connect rate on ${best[0].replace(/_/g, ' ').toLowerCase()} against ` +
          `${(worst[1].connectRate * 100).toFixed(0)}% on ${worst[0].replace(/_/g, ' ').toLowerCase()}. ` +
          'Route more of the former to this caller and pair them with someone stronger on the latter.',
      });
    }
  }

  const hourEntries = Object.entries(metrics.byHour).filter(([, s]) => s.attempted >= 4);
  if (hourEntries.length >= 3) {
    const sorted = [...hourEntries].sort((a, b) => b[1].connected / b[1].attempted - a[1].connected / a[1].attempted);
    recommendations.push({
      kind: 'assignment',
      severity: 'info',
      headline: `Best connect window is around ${sorted[0][0]}:00 UTC`,
      detail:
        `${((sorted[0][1].connected / sorted[0][1].attempted) * 100).toFixed(0)}% connect rate at ${sorted[0][0]}:00 against ` +
        `${((sorted[sorted.length - 1][1].connected / sorted[sorted.length - 1][1].attempted) * 100).toFixed(0)}% at ${sorted[sorted.length - 1][0]}:00. ` +
        'Weight this caller\'s queue toward their strong window.',
    });
  }

  if (metrics.callsAttempted >= 15 && metrics.qualificationRate < 0.15) {
    recommendations.push({
      kind: 'script',
      severity: 'warning',
      headline: `Qualification rate ${(metrics.qualificationRate * 100).toFixed(0)}% across ${metrics.callsAttempted} calls`,
      detail:
        'Conversations are happening but needs are not being confirmed. Before assuming a caller problem, check whether the target profile ' +
        'is wrong — the same symptom appears when discovery is surfacing the wrong companies.',
    });
  }

  if (metrics.dealsInfluenced > 0 && metrics.grossProfitInfluenced > 0 && metrics.callsAttempted > 0) {
    recommendations.push({
      kind: 'coaching',
      severity: 'info',
      headline: `$${Math.round(metrics.grossProfitInfluenced / metrics.callsAttempted).toLocaleString()} of gross profit influenced per call`,
      detail:
        `${metrics.dealsInfluenced} deal(s) influenced across ${metrics.callsAttempted} calls. ` +
        'This is the number that matters — measure and rank on it rather than on dial counts.',
    });
  }

  return recommendations;
}

/** Persists a metrics snapshot for the period. */
export async function snapshotCallerMetrics(orgId: string, periodStart: Date, periodEnd: Date): Promise<number> {
  const callers = await prisma.user.findMany({
    where: { orgId, isActive: true, role: { key: 'CALLER' } },
    select: { id: true },
  });

  for (const caller of callers) {
    const metrics = await computeCallerMetrics({ orgId, userId: caller.id, periodStart, periodEnd });
    await prisma.performanceMetric.create({
      data: {
        orgId,
        userId: caller.id,
        periodStart,
        periodEnd,
        scope: 'caller',
        metrics: { ...metrics, recommendations: recommendCoaching(metrics) } as object,
      },
    });
  }
  return callers.length;
}

/** Pipeline-level analytics for the management dashboard. */
export async function computePipelineAnalytics(orgId: string) {
  const opportunities = await prisma.opportunity.findMany({
    where: { orgId },
    include: { deal: true, statusHistory: { orderBy: { createdAt: 'asc' } }, lane: true, parties: { include: { company: true } } },
  });

  const byStage: Record<string, { count: number; grossProfit: number }> = {};
  const byType: Record<string, { count: number; grossProfit: number; won: number; lost: number }> = {};
  const lossReasons: Record<string, number> = {};
  const stageDurations: Record<string, number[]> = {};
  const byMovability: Record<string, number> = {};

  for (const opportunity of opportunities) {
    byStage[opportunity.stage] ??= { count: 0, grossProfit: 0 };
    byStage[opportunity.stage].count += 1;
    byStage[opportunity.stage].grossProfit += num0(opportunity.estimatedGrossProfit);

    byType[opportunity.type] ??= { count: 0, grossProfit: 0, won: 0, lost: 0 };
    byType[opportunity.type].count += 1;
    byType[opportunity.type].grossProfit += num0(opportunity.estimatedGrossProfit);
    if (opportunity.status === 'WON') byType[opportunity.type].won += 1;
    if (opportunity.status === 'LOST') byType[opportunity.type].lost += 1;

    if (opportunity.lostReason) lossReasons[opportunity.lostReason] = (lossReasons[opportunity.lostReason] ?? 0) + 1;

    for (const party of opportunity.parties) {
      if (party.isPrimary) {
        byMovability[party.company.movability] = (byMovability[party.company.movability] ?? 0) + 1;
      }
    }

    const history = opportunity.statusHistory;
    for (let i = 0; i < history.length; i++) {
      const from = history[i];
      const next = history[i + 1];
      const endTime = next ? next.createdAt.getTime() : Date.now();
      const days = (endTime - from.createdAt.getTime()) / 86_400_000;
      stageDurations[from.toStage] ??= [];
      stageDurations[from.toStage].push(days);
    }
  }

  const averageStageDays: Record<string, number> = {};
  for (const [stage, durations] of Object.entries(stageDurations)) {
    averageStageDays[stage] = round(durations.reduce((a, b) => a + b, 0) / durations.length, 1);
  }

  const quotes = await prisma.quote.findMany({ where: { orgId, direction: 'outbound' } });
  const sent = quotes.filter((q) => q.sentAt !== null).length;
  const accepted = quotes.filter((q) => q.status === 'ACCEPTED').length;

  const companies = await prisma.company.findMany({
    where: { orgId },
    select: { companyRole: true, serviceTerritories: true, accountStage: true, locations: { select: { state: true } } },
  });
  const coverage: Record<string, number> = {};
  for (const company of companies) {
    for (const state of new Set(company.locations.map((l) => l.state).filter(Boolean) as string[])) {
      coverage[state] = (coverage[state] ?? 0) + 1;
    }
  }

  const supplyCapacity = companies.filter((c) => ['SUBCONTRACTOR', 'SUPPLIER', 'DISTRIBUTOR', 'MANUFACTURER', 'CARRIER'].includes(c.companyRole)).length;
  const demandSide = companies.filter((c) => ['BUYER', 'PRIME_CONTRACTOR'].includes(c.companyRole)).length;

  const decisions = await prisma.aIDecision.findMany({
    where: { orgId },
    select: { confidence: true, process: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  const escalationCount = await prisma.escalation.count({ where: { orgId } });

  return {
    byStage,
    byType,
    lossReasons,
    averageStageDays,
    byMovability,
    quoteToCloseRate: sent > 0 ? round(accepted / sent, 3) : 0,
    quotesSent: sent,
    quotesAccepted: accepted,
    geographicCoverage: coverage,
    supplySideCompanies: supplyCapacity,
    demandSideCompanies: demandSide,
    supplyDemandRatio: demandSide > 0 ? round(supplyCapacity / demandSide, 2) : 0,
    averageAIConfidence: decisions.length ? round(decisions.reduce((s, d) => s + d.confidence, 0) / decisions.length, 3) : 0,
    totalAIDecisions: decisions.length,
    totalEscalations: escalationCount,
    escalationRate: decisions.length ? round(escalationCount / decisions.length, 3) : 0,
  };
}

export { clamp01 };
