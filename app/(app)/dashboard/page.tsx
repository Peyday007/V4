import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { can, requireUser } from '@/lib/auth/session';
import { computePipelineAnalytics } from '@/lib/ai/analytics';
import { computePipelineMetrics, generateDailyPlan } from '@/lib/ai/planner';
import { ActionButton } from '@/components/ActionButton';
import { Badge, Empty, humanize, money, PriorityBadge, relativeDays, Stat, TypeBadge } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const user = await requireUser();
  if (!can(user, 'analytics.pipeline.read') && !can(user, 'opportunity.read')) redirect('/calls');
  const showMoney = can(user, 'finance.margin.read');

  const today = new Date();
  const planDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

  let plan = await prisma.dailyPlan.findUnique({ where: { orgId_planDate: { orgId: user.orgId, planDate } } });
  if (!plan) {
    await generateDailyPlan(user.orgId, today);
    plan = await prisma.dailyPlan.findUnique({ where: { orgId_planDate: { orgId: user.orgId, planDate } } });
  }

  const [metrics, analytics, closest, blocked, noAction, movable, supplyGaps] = await Promise.all([
    computePipelineMetrics(user.orgId),
    computePipelineAnalytics(user.orgId),
    prisma.opportunity.findMany({
      where: { orgId: user.orgId, status: { in: ['ACTIVE', 'WAITING'] } },
      orderBy: [{ closingProbability: 'desc' }, { expectedValue: 'desc' }],
      take: 6,
      include: { parties: { where: { isPrimary: true }, include: { company: true } }, nextActions: { where: { isCurrent: true } } },
    }),
    prisma.opportunity.findMany({
      where: { orgId: user.orgId, status: { in: ['BLOCKED', 'ESCALATED'] } },
      orderBy: { expectedValue: 'desc' },
      take: 6,
      include: { parties: { where: { isPrimary: true }, include: { company: true } } },
    }),
    prisma.opportunity.count({
      where: { orgId: user.orgId, status: { in: ['ACTIVE', 'WAITING'] }, nextActions: { none: { isCurrent: true } } },
    }),
    prisma.company.findMany({
      where: { orgId: user.orgId, movability: { in: ['ACTIVELY_MOVABLE', 'CONDITIONALLY_MOVABLE'] } },
      orderBy: { movabilityScore: 'desc' },
      take: 6,
    }),
    prisma.opportunity.findMany({
      where: { orgId: user.orgId, stage: 'SUPPLIER_REQUIRED' },
      include: { parties: { where: { isPrimary: true }, include: { company: true } } },
      take: 5,
    }),
  ]);

  const priorities = (plan?.priorities ?? []) as Array<{
    rank: number;
    headline: string;
    detail: string;
    count: number;
    category: string;
    expectedValue: number;
    link: string;
  }>;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Operations dashboard</h1>
          <p>
            What should happen today, what is blocked, and where the money is. The AI ranks work by expected value, not by
            volume — the list below is the order to work in.
          </p>
        </div>
        <div className="row">
          {can(user, 'discovery.run') && (
            <ActionButton endpoint="/api/discovery/run" body={{ inline: true }} className="primary">
              Run discovery
            </ActionButton>
          )}
          <Link href="/board" className="btn">
            Open dispatch board
          </Link>
        </div>
      </div>

      <div className="grid grid-4 mb">
        <Stat label="Active opportunities" value={metrics.activeOpportunities} sub={`${metrics.totalOpportunities} total`} />
        {showMoney && (
          <>
            <Stat
              label="Gross-profit pipeline"
              value={money(metrics.grossProfitPipeline)}
              sub="Sum of estimated gross profit on open deals"
            />
            <Stat
              label="Expected value"
              value={money(metrics.expectedValuePipeline)}
              sub="After closing probability and fulfillment confidence"
            />
          </>
        )}
        <Stat
          label="Needs a human"
          value={metrics.openEscalations + metrics.pendingApprovals}
          sub={`${metrics.openEscalations} escalation(s), ${metrics.pendingApprovals} approval(s)`}
        />
        <Stat label="Win rate" value={`${metrics.winRate}%`} sub={`${metrics.wonDeals} won / ${metrics.lostDeals} lost`} />
        <Stat
          label="Without a next action"
          value={noAction}
          sub={noAction > 0 ? 'These are drifting — run the planner' : 'Every active deal has an owner and a step'}
        />
      </div>

      <div className="two-col">
        <div>
          <div className="card">
            <div className="card-title">
              <h2>Today&rsquo;s operating plan</h2>
              <span className="tiny dim">{plan?.createdAt ? `generated ${relativeDays(plan.createdAt)}` : ''}</span>
            </div>
            {priorities.length === 0 ? (
              <Empty>Nothing requires attention. Run discovery or import accounts to create work.</Empty>
            ) : (
              <ol className="list-reset">
                {priorities.map((priority) => (
                  <li key={priority.rank} style={{ padding: '0.6rem 0', borderBottom: '1px solid var(--border)' }}>
                    <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <Link href={priority.link} style={{ fontWeight: 600 }}>
                          {priority.rank}. {priority.headline}
                        </Link>
                        <div className="small muted pre-wrap" style={{ marginTop: '0.2rem' }}>
                          {priority.detail}
                        </div>
                      </div>
                      {showMoney && priority.expectedValue > 0 && (
                        <span className="badge accent nowrap">{money(priority.expectedValue)}</span>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            )}
            {plan?.narrative && (
              <div className="alert info small pre-wrap" style={{ marginTop: '0.75rem', marginBottom: 0 }}>
                {plan.narrative}
              </div>
            )}
          </div>

          <div className="card">
            <h2>Closest to closing</h2>
            {closest.length === 0 ? (
              <Empty>No active opportunities yet.</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Opportunity</th>
                      <th>Type</th>
                      <th className="num">P(close)</th>
                      {showMoney && <th className="num">Expected</th>}
                      <th>Next action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {closest.map((opportunity) => (
                      <tr key={opportunity.id}>
                        <td>
                          <Link href={`/opportunities/${opportunity.id}`}>{opportunity.name}</Link>
                          <div className="tiny dim">{opportunity.parties[0]?.company.legalName}</div>
                        </td>
                        <td>
                          <TypeBadge type={opportunity.type} />
                        </td>
                        <td className="num">{Math.round(opportunity.closingProbability * 100)}%</td>
                        {showMoney && <td className="num">{money(opportunity.expectedValue)}</td>}
                        <td className="small">
                          {opportunity.nextActions[0] ? humanize(opportunity.nextActions[0].type) : <span className="dim">None set</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="card">
            <h2>Blocked and escalated</h2>
            {blocked.length === 0 ? (
              <Empty>Nothing blocked. Every active deal has a path forward.</Empty>
            ) : (
              <ul className="list-reset">
                {blocked.map((opportunity) => (
                  <li key={opportunity.id} style={{ padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <Link href={`/opportunities/${opportunity.id}`}>{opportunity.name}</Link>
                      <PriorityBadge priority={opportunity.priority} />
                    </div>
                    <div className="small muted">{opportunity.primaryBlocker ?? 'Blocker not recorded'}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div>
          <div className="card">
            <h2>Where fulfillment is missing</h2>
            <p className="small muted">
              Confirmed demand with no capable provider in the graph. Sourcing capacity here converts directly into deals.
            </p>
            {supplyGaps.length === 0 ? (
              <Empty>No coverage gaps.</Empty>
            ) : (
              <ul className="list-reset">
                {supplyGaps.map((opportunity) => (
                  <li key={opportunity.id} style={{ padding: '0.4rem 0', borderBottom: '1px solid var(--border)' }}>
                    <Link href={`/opportunities/${opportunity.id}`} className="small">
                      {opportunity.name}
                    </Link>
                    <div className="tiny dim">{opportunity.location ?? 'Location unknown'}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card">
            <h2>Most movable accounts</h2>
            {movable.length === 0 ? (
              <Empty>No vulnerability assessments yet.</Empty>
            ) : (
              <ul className="list-reset">
                {movable.map((company) => (
                  <li key={company.id} style={{ padding: '0.4rem 0', borderBottom: '1px solid var(--border)' }}>
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <Link href={`/companies/${company.id}`} className="small">
                        {company.legalName}
                      </Link>
                      <Badge tone={company.movability === 'ACTIVELY_MOVABLE' ? 'success' : 'warning'}>
                        {Math.round(company.movabilityScore * 100)}%
                      </Badge>
                    </div>
                    <div className="tiny dim">{company.movabilityReasons[0] ?? humanize(company.movability)}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card">
            <h2>Pipeline health</h2>
            <table>
              <tbody>
                <tr>
                  <td className="muted">Quote-to-close</td>
                  <td className="num">{Math.round(analytics.quoteToCloseRate * 100)}%</td>
                </tr>
                <tr>
                  <td className="muted">Quotes sent</td>
                  <td className="num">{analytics.quotesSent}</td>
                </tr>
                <tr>
                  <td className="muted">Average opportunity age</td>
                  <td className="num">{metrics.averageAgeDays}d</td>
                </tr>
                <tr>
                  <td className="muted">Calls per open opportunity</td>
                  <td className="num">{metrics.callsPerQualifiedOpportunity}</td>
                </tr>
                <tr>
                  <td className="muted">Supply / demand ratio</td>
                  <td className="num">{analytics.supplyDemandRatio}</td>
                </tr>
                <tr>
                  <td className="muted">Average AI confidence</td>
                  <td className="num">{Math.round(analytics.averageAIConfidence * 100)}%</td>
                </tr>
                <tr>
                  <td className="muted">Escalation rate</td>
                  <td className="num">{Math.round(analytics.escalationRate * 100)}%</td>
                </tr>
              </tbody>
            </table>
          </div>

          {showMoney && (
            <div className="card">
              <h2>By deal model</h2>
              <table>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th className="num">Open</th>
                    <th className="num">GP</th>
                    <th className="num">W/L</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(analytics.byType).map(([type, stats]) => (
                    <tr key={type}>
                      <td>
                        <TypeBadge type={type} />
                      </td>
                      <td className="num">{stats.count}</td>
                      <td className="num">{money(stats.grossProfit)}</td>
                      <td className="num">
                        {stats.won}/{stats.lost}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
