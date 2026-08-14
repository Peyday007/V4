import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { can, requireUser } from '@/lib/auth/session';
import { computePipelineAnalytics } from '@/lib/ai/analytics';
import { computePipelineMetrics, generateDailyPlan } from '@/lib/ai/planner';
import { grossProfitPipeline } from '@/lib/evidence/economics';
import { boardEmptiness } from '@/lib/demand/emptyState';
import { ActionButton } from '@/components/ActionButton';
import { Badge, Empty, humanize, money, PriorityBadge, relativeDays, Stat, TypeBadge } from '@/components/ui';
import { FigureChip } from '@/components/Figure';
import { closedComparablesByType, gradeOpportunity, STAGE_ORDER } from '@/lib/evidence/opportunity';
import { presentMoney } from '@/lib/evidence/economics';
import { gradeRate, presentPercent } from '@/lib/evidence/claims';

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

  const [metrics, analytics, pipeline, emptiness, closest, blocked, noAction, movable, supplyGaps] = await Promise.all([
    computePipelineMetrics(user.orgId),
    computePipelineAnalytics(user.orgId),
    grossProfitPipeline({ orgId: user.orgId }),
    boardEmptiness(user.orgId),
    // Was ordered by closingProbability, which on most rows is the column
    // default — so "closest to closing" was returning whichever six rows the
    // database happened to hand back, presented as a ranking. Ordered by how
    // far the deal has actually got instead, which is a fact about the record.
    prisma.opportunity.findMany({
      where: { orgId: user.orgId, status: { in: ['ACTIVE', 'WAITING'] } },
      orderBy: [{ stageEnteredAt: 'desc' }],
      take: 40,
      include: {
        parties: { where: { isPrimary: true }, include: { company: true } },
        nextActions: { where: { isCurrent: true } },
        scores: { select: { id: true }, take: 1 },
      },
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

  // Stage order is the operating order, so position in it is how far a deal
  // has genuinely got. Ties break on the deal that has sat there longest,
  // because that is the one most likely to be stuck.
  const closedByType = await closedComparablesByType(user.orgId);
  const furthest = closest
    .map((opportunity) => ({
      opportunity,
      depth: STAGE_ORDER.indexOf(opportunity.stage),
      claims: gradeOpportunity({
        opportunity: { ...opportunity, hasScore: opportunity.scores.length > 0 },
        closedComparables: closedByType.get(String(opportunity.type)) ?? 0,
      }),
    }))
    .sort((a, b) => b.depth - a.depth || a.opportunity.stageEnteredAt.getTime() - b.opportunity.stageEnteredAt.getTime())
    .slice(0, 6);

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
            {/* The figure that used to sit here was the sum of every open
                opportunity's `estimatedGrossProfit` — a playbook's typical
                range for a category, times an assumed margin, added up. It is
                the number in this product most likely to be repeated out loud
                as though it were revenue, and there was nothing under it.

                Now only quotes with a real provider cost are totalled, and
                when none qualifies the space says so rather than showing a
                zero, because zero is itself a claim about the business. */}
            <Stat
              label="Gross-profit pipeline"
              value={pipeline.showable ? money(pipeline.total) : <span className="dim">not yet priced</span>}
              sub={pipeline.note}
            />
            <Stat
              label="Quotes with a cost side"
              value={`${pipeline.counted} of ${pipeline.counted + pipeline.excluded}`}
              sub={
                pipeline.excluded > 0
                  ? `${pipeline.excluded} priced from an assumption, so excluded from the total`
                  : 'Every quote rests on a provider price'
              }
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
              /* "Run discovery to create work" is advice for an engine that is
                 working and idle. When the collection chain is broken it sends
                 the owner to press a button that will fail again, so the
                 broken stage is named here instead. */
              emptiness.brokenStage ? (
                <div className="alert warning small" data-testid="dashboard-broken-stage">
                  <strong>No work, and it is not because the day is quiet.</strong>
                  <div className="mt">
                    First broken stage: {emptiness.brokenStage.stage}. {emptiness.brokenStage.detail}
                  </div>
                  <div className="mt">{emptiness.brokenStage.fix}</div>
                  <Link href="/demand/sources" className="btn secondary mt">Source health</Link>
                </div>
              ) : (
                <Empty>
                  Nothing requires attention. Every source ran and reported no fault; there is genuinely
                  nothing waiting.
                </Empty>
              )
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
            <div className="card-title">
              <h2>Furthest along</h2>
              <span className="tiny dim">By stage reached, not by a predicted probability</span>
            </div>
            {furthest.length === 0 ? (
              <Empty>No active opportunities yet.</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Opportunity</th>
                      <th>Stage</th>
                      <th className="num">Closing rate</th>
                      {showMoney && <th className="num">Expected</th>}
                      <th>Next action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {furthest.map(({ opportunity, claims }) => (
                      <tr key={opportunity.id}>
                        <td>
                          <Link href={`/opportunities/${opportunity.id}`}>{opportunity.name}</Link>
                          <div className="tiny dim">
                            {opportunity.parties[0]?.company.legalName} · <TypeBadge type={opportunity.type} />
                          </div>
                        </td>
                        <td className="small nowrap">{humanize(opportunity.stage)}</td>
                        <td className="num tiny"><FigureChip presentation={claims.shown.closingProbability} /></td>
                        {showMoney && (
                          <td className="num tiny">
                            <FigureChip presentation={presentMoney(claims.expectedValue)} />
                          </td>
                        )}
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
                      {/* The score is weighted from signals that fired with a
                          quote attached. With no signals it is zero, and a
                          zero shown as "0%" reads as an assessment rather than
                          as the absence of one. */}
                      <Badge tone={company.movability === 'ACTIVELY_MOVABLE' ? 'success' : 'warning'}>
                        {company.movabilityReasons.length > 0
                          ? `${Math.round(company.movabilityScore * 100)}% · ${company.movabilityReasons.length} signal(s)`
                          : 'no signals on file'}
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
                  <td className="num tiny">
                    {/* A rate over three quotes is arithmetic, not a
                        measurement. Below the floor the counts are shown, which
                        say the same thing without the false precision. */}
                    <FigureChip presentation={presentPercent(gradeRate({
                      numerator: analytics.quotesAccepted,
                      denominator: analytics.quotesSent,
                      what: 'quote-to-close rate',
                    }))} />
                  </td>
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
                  {/* The model's own confidence in itself, averaged. A real
                      average of really-recorded numbers, and not a measure of
                      whether any of them were right — so it is labelled as the
                      self-report it is. */}
                  <td className="muted">AI self-reported confidence</td>
                  <td className="num tiny">
                    {analytics.totalAIDecisions === 0
                      ? <span className="dim">no decisions recorded</span>
                      : `${Math.round(analytics.averageAIConfidence * 100)}% over ${analytics.totalAIDecisions}`}
                  </td>
                </tr>
                <tr>
                  <td className="muted">Escalation rate</td>
                  <td className="num tiny">
                    <FigureChip presentation={presentPercent(gradeRate({
                      numerator: analytics.totalEscalations,
                      denominator: analytics.totalAIDecisions,
                      what: 'escalation rate',
                    }))} />
                  </td>
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
