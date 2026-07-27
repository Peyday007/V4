import { num0, prisma } from '@/lib/db';
import { getOrgConfig } from '@/lib/config';
import { recordDecision } from './decisions';

export const PLANNER_VERSION = 'daily_plan@2';

export type PlanPriority = {
  rank: number;
  headline: string;
  detail: string;
  count: number;
  category: string;
  expectedValue: number;
  opportunityIds: string[];
  link: string;
};

export type DailyPlanResult = {
  planDate: string;
  narrative: string;
  priorities: PlanPriority[];
  metrics: Record<string, number>;
};

/**
 * The daily operating plan.
 *
 * It is built around completed deals and profitable capacity, not call volume:
 * priorities are ranked by the expected value sitting behind each cluster of
 * work, and each one names the specific records to act on.
 */
export async function generateDailyPlan(orgId: string, forDate = new Date()): Promise<DailyPlanResult> {
  const config = await getOrgConfig(orgId);
  const planDate = new Date(Date.UTC(forDate.getUTCFullYear(), forDate.getUTCMonth(), forDate.getUTCDate()));
  const now = new Date();
  const priorities: PlanPriority[] = [];

  const opportunities = await prisma.opportunity.findMany({
    where: { orgId, status: { in: ['ACTIVE', 'WAITING', 'BLOCKED', 'ESCALATED'] } },
    include: {
      nextActions: { where: { isCurrent: true } },
      parties: { include: { company: true } },
      matches: true,
      buyerNeed: true,
      quotes: true,
    },
  });

  const cluster = (
    filter: (o: (typeof opportunities)[number]) => boolean,
    category: string,
    headline: (n: number, ev: number) => string,
    detail: string,
    link: string,
  ) => {
    const matched = opportunities.filter(filter);
    if (matched.length === 0) return;
    const ev = matched.reduce((sum, o) => sum + num0(o.expectedValue), 0);
    priorities.push({
      rank: 0,
      headline: headline(matched.length, ev),
      detail,
      count: matched.length,
      category,
      expectedValue: Math.round(ev),
      opportunityIds: matched.slice(0, 25).map((o) => o.id),
      link,
    });
  };

  // 1. Overdue actions — the fastest way to lose a deal is to let it sit.
  cluster(
    (o) => o.nextActions.some((a) => a.dueDate < now),
    'overdue',
    (n, ev) => `Clear ${n} overdue next action${n === 1 ? '' : 's'}`,
    'These opportunities have a defined next action whose due date has passed. Nothing else moves until they do.',
    '/board?filter=overdue',
  );

  // 2. Deals waiting on exactly one fact — cheapest wins available.
  cluster(
    (o) => o.missingInformation.length === 1,
    'one_fact_away',
    (n, ev) => `Close ${n} opportunit${n === 1 ? 'y' : 'ies'} waiting on a single missing fact`,
    'Each of these needs one answer to advance. One call each, highest return per minute on the board.',
    '/board?filter=one_fact_away',
  );

  // 3. Quotes needing follow-up.
  cluster(
    (o) => o.quotes.some((q) => q.direction === 'outbound' && q.status === 'SENT' && q.sentAt !== null && (now.getTime() - q.sentAt.getTime()) / 86_400_000 >= 2),
    'quote_follow_up',
    (n, ev) => `Follow up ${n} quote${n === 1 ? '' : 's'} sent in the last few days ($${Math.round(ev).toLocaleString()} expected)`,
    'Quotes that go unchased go cold. Confirm receipt, surface objections and get a decision date.',
    '/board?filter=quote_follow_up',
  );

  // 4. Confirmed demand with no fulfillment path — the supply gap.
  cluster(
    (o) => o.buyerNeed?.status === 'CONFIRMED' && o.matches.filter((m) => m.score >= 0.5).length === 0,
    'supply_gap',
    (n, ev) => `Source fulfillment capacity for ${n} confirmed need${n === 1 ? '' : 's'}`,
    'Real, confirmed demand that nobody in the graph can deliver. Finding capable providers here converts directly into deals.',
    '/board?filter=supply_gap',
  );

  // 5. Candidates whose claims need verifying before they can be presented.
  cluster(
    (o) => o.matches.some((m) => m.missingInformation.some((mi) => /insurance|licen|certif/i.test(mi))),
    'compliance_verification',
    (n) => `Verify insurance or licensing on ${n} candidate${n === 1 ? '' : 's'}`,
    'These candidates cannot be put in front of a buyer until their coverage and licensure are verified.',
    '/board?filter=compliance_verification',
  );

  // 6. Movable accounts nobody has approached.
  const movable = await prisma.company.findMany({
    where: {
      orgId,
      movability: { in: ['ACTIVELY_MOVABLE', 'CONDITIONALLY_MOVABLE'] },
      accountStage: { in: ['DISCOVERED', 'CONTACTED', 'QUALIFIED'] },
    },
    orderBy: { movabilityScore: 'desc' },
    take: 25,
  });
  if (movable.length > 0) {
    const actively = movable.filter((c) => c.movability === 'ACTIVELY_MOVABLE').length;
    priorities.push({
      rank: 0,
      headline: `Approach ${movable.length} movable account${movable.length === 1 ? '' : 's'} (${actively} actively movable)`,
      detail:
        'These accounts have documented problems with their current arrangement and no deal in flight yet. ' +
        'Actively movable accounts get a direct ask; conditionally movable accounts get a backup or overflow ask, which is a cheap yes.',
      count: movable.length,
      category: 'movable_accounts',
      expectedValue: 0,
      opportunityIds: [],
      link: '/companies?movability=movable',
    });
  }

  // 7. Neglected high-value work.
  const neglectDays = config.riskRules.neglectDays;
  cluster(
    (o) => (now.getTime() - o.lastActivityAt.getTime()) / 86_400_000 > neglectDays && num0(o.expectedValue) > 2000,
    'neglected',
    (n, ev) => `Revive ${n} neglected high-value opportunit${n === 1 ? 'y' : 'ies'} ($${Math.round(ev).toLocaleString()})`,
    `No activity in over ${neglectDays} days on work that is still worth real money. Either move it or close it.`,
    '/board?filter=neglected',
  );

  // 8. Escalations.
  const escalations = await prisma.escalation.findMany({
    where: { orgId, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
    orderBy: { createdAt: 'asc' },
    take: config.planning.maxEscalationsPerDay,
  });
  if (escalations.length > 0) {
    const critical = escalations.filter((e) => e.severity === 'CRITICAL').length;
    priorities.push({
      rank: 0,
      headline: `Resolve ${escalations.length} escalation${escalations.length === 1 ? '' : 's'}${critical ? ` (${critical} critical)` : ''}`,
      detail: escalations.slice(0, 4).map((e) => `• ${e.title}`).join('\n'),
      count: escalations.length,
      category: 'escalations',
      expectedValue: 0,
      opportunityIds: escalations.map((e) => e.opportunityId).filter(Boolean) as string[],
      link: '/escalations',
    });
  }

  // 9. Approvals holding deals hostage.
  const approvals = await prisma.approval.findMany({ where: { orgId, status: 'PENDING' }, take: 25 });
  if (approvals.length > 0) {
    priorities.push({
      rank: 0,
      headline: `Decide ${approvals.length} pending approval${approvals.length === 1 ? '' : 's'}`,
      detail: 'Configured deals are sitting still until these are decided. Each one is blocking a specific opportunity.',
      count: approvals.length,
      category: 'approvals',
      expectedValue: Math.round(approvals.reduce((sum, a) => sum + num0(a.amount), 0)),
      opportunityIds: approvals.map((a) => a.opportunityId).filter(Boolean) as string[],
      link: '/approvals',
    });
  }

  // 10. Expansion on accounts that already work.
  cluster(
    (o) => o.stage === 'REPEAT_OR_EXPANSION' || (o.status === 'WON' && num0(o.expectedValue) > 0),
    'expansion',
    (n) => `Pursue expansion on ${n} delivering account${n === 1 ? '' : 's'}`,
    'We have already proven delivery at these accounts. Ask for the next location or the next category.',
    '/board?filter=expansion',
  );

  // Rank by expected value, then by volume of blocked work.
  priorities.sort((a, b) => b.expectedValue - a.expectedValue || b.count - a.count);
  const categoryOrder: Record<string, number> = { escalations: -3, overdue: -2, approvals: -1 };
  priorities.sort((a, b) => (categoryOrder[a.category] ?? 0) - (categoryOrder[b.category] ?? 0));
  priorities.forEach((p, index) => {
    p.rank = index + 1;
  });

  const metrics = await computePipelineMetrics(orgId);
  const narrative = buildNarrative(priorities, metrics);

  await prisma.dailyPlan.upsert({
    where: { orgId_planDate: { orgId, planDate } },
    create: { orgId, planDate, priorities: priorities as object, narrative, metrics: metrics as object },
    update: { priorities: priorities as object, narrative, metrics: metrics as object },
  });

  await recordDecision({
    orgId,
    process: 'daily_planning',
    decision: `Generated a ${priorities.length}-priority operating plan`,
    reason: narrative.slice(0, 800),
    inputs: { activeOpportunities: opportunities.length },
    outputs: { priorities: priorities.map((p) => ({ rank: p.rank, category: p.category, count: p.count })) },
    confidence: 0.8,
    rulesApplied: ['expected_value_ranking', 'blocker_first_ordering'],
    modelName: 'deterministic',
    promptVersion: PLANNER_VERSION,
  });

  return { planDate: planDate.toISOString().slice(0, 10), narrative, priorities, metrics };
}

function buildNarrative(priorities: PlanPriority[], metrics: Record<string, number>): string {
  if (priorities.length === 0) {
    return 'Nothing requires attention today. No overdue actions, no escalations, no stalled deals. Feed the discovery engine or import accounts to create new work.';
  }
  const totalEv = priorities.reduce((sum, p) => sum + p.expectedValue, 0);
  const lines = [
    `${priorities.length} clusters of work today across ${metrics.activeOpportunities} active opportunities, ` +
      `carrying $${Math.round(metrics.grossProfitPipeline).toLocaleString()} of gross-profit pipeline ` +
      `and $${Math.round(metrics.expectedValuePipeline).toLocaleString()} of expected value after probability and fulfillment confidence.`,
    '',
    "Today's priorities:",
    ...priorities.map((p) => `${p.rank}. ${p.headline}${p.expectedValue > 0 ? ` — $${p.expectedValue.toLocaleString()} expected value` : ''}`),
  ];
  if (totalEv > 0) {
    lines.push('', `Working this list in order puts roughly $${totalEv.toLocaleString()} of expected value in play.`);
  }
  return lines.join('\n');
}

export async function computePipelineMetrics(orgId: string): Promise<Record<string, number>> {
  const [active, opportunities, escalations, approvals, assignments, calls, wonDeals, lostDeals] = await Promise.all([
    prisma.opportunity.count({ where: { orgId, status: { in: ['ACTIVE', 'WAITING', 'BLOCKED', 'ESCALATED'] } } }),
    prisma.opportunity.findMany({
      where: { orgId },
      select: {
        id: true, type: true, stage: true, status: true, estimatedGrossProfit: true, expectedValue: true,
        closingProbability: true, createdAt: true, closedAt: true, stageEnteredAt: true, missingInformation: true,
        lastActivityAt: true,
      },
    }),
    prisma.escalation.count({ where: { orgId, status: { in: ['OPEN', 'ACKNOWLEDGED'] } } }),
    prisma.approval.count({ where: { orgId, status: 'PENDING' } }),
    prisma.callAssignment.count({ where: { orgId, status: { in: ['PENDING', 'ASSIGNED'] } } }),
    prisma.call.count({ where: { orgId } }),
    prisma.opportunity.count({ where: { orgId, status: 'WON' } }),
    prisma.opportunity.count({ where: { orgId, status: 'LOST' } }),
  ]);

  const openOpportunities = opportunities.filter((o) => !['WON', 'LOST', 'DISQUALIFIED'].includes(o.status));
  const grossProfitPipeline = openOpportunities.reduce((sum, o) => sum + num0(o.estimatedGrossProfit), 0);
  const expectedValuePipeline = openOpportunities.reduce((sum, o) => sum + num0(o.expectedValue), 0);
  const withNoNextAction = await prisma.opportunity.count({
    where: { orgId, status: { in: ['ACTIVE', 'WAITING'] }, nextActions: { none: { isCurrent: true } } },
  });
  const blocked = opportunities.filter((o) => o.status === 'BLOCKED').length;
  const closed = wonDeals + lostDeals;

  const ageDays = openOpportunities.length
    ? openOpportunities.reduce((sum, o) => sum + (Date.now() - o.createdAt.getTime()) / 86_400_000, 0) / openOpportunities.length
    : 0;

  return {
    activeOpportunities: active,
    totalOpportunities: opportunities.length,
    grossProfitPipeline: Math.round(grossProfitPipeline),
    expectedValuePipeline: Math.round(expectedValuePipeline),
    openEscalations: escalations,
    pendingApprovals: approvals,
    openCallAssignments: assignments,
    totalCalls: calls,
    wonDeals,
    lostDeals,
    winRate: closed > 0 ? Math.round((wonDeals / closed) * 100) : 0,
    blockedOpportunities: blocked,
    opportunitiesWithoutNextAction: withNoNextAction,
    averageAgeDays: Math.round(ageDays * 10) / 10,
    callsPerQualifiedOpportunity:
      openOpportunities.length > 0 ? Math.round((calls / Math.max(1, openOpportunities.length)) * 10) / 10 : 0,
  };
}
