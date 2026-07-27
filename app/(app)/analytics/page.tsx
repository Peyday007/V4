import { prisma } from '@/lib/db';
import { can, requireUser } from '@/lib/auth/session';
import { computeCallerMetrics, computePipelineAnalytics, recommendCoaching } from '@/lib/ai/analytics';
import { computePipelineMetrics } from '@/lib/ai/planner';
import { Badge, Empty, humanize, money, Stat } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function AnalyticsPage() {
  const user = await requireUser();
  const seesAll = can(user, 'analytics.caller.read.all');
  const seesPipeline = can(user, 'analytics.pipeline.read');
  const showMoney = can(user, 'finance.margin.read');

  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - 90 * 86_400_000);

  const callers = seesAll
    ? await prisma.user.findMany({ where: { orgId: user.orgId, isActive: true, role: { key: 'CALLER' } }, select: { id: true } })
    : [{ id: user.id }];

  const metrics = await Promise.all(
    callers.map((caller) => computeCallerMetrics({ orgId: user.orgId, userId: caller.id, periodStart, periodEnd })),
  );
  metrics.sort((a, b) => b.grossProfitInfluenced - a.grossProfitInfluenced);

  const [pipeline, analytics] = seesPipeline
    ? await Promise.all([computePipelineMetrics(user.orgId), computePipelineAnalytics(user.orgId)])
    : [null, null];

  return (
    <>
      <div className="page-header">
        <div>
          <h1>{seesAll ? 'Analytics' : 'Your performance'}</h1>
          <p>
            Callers are measured on outcomes, not dials: confirmed needs, pricing obtained, matches enabled and gross profit
            influenced. Coaching notes below are advisory — the system flags evidence for a manager and takes no action on its
            own.
          </p>
        </div>
        <Badge>Last 90 days</Badge>
      </div>

      {pipeline && analytics && (
        <>
          <div className="grid grid-4 mb">
            <Stat label="Active opportunities" value={pipeline.activeOpportunities} />
            {showMoney && <Stat label="GP pipeline" value={money(pipeline.grossProfitPipeline)} />}
            {showMoney && <Stat label="Expected value" value={money(pipeline.expectedValuePipeline)} />}
            <Stat label="Quote-to-close" value={`${Math.round(analytics.quoteToCloseRate * 100)}%`} sub={`${analytics.quotesSent} sent`} />
            <Stat label="Average age" value={`${pipeline.averageAgeDays}d`} />
            <Stat label="Calls per opportunity" value={pipeline.callsPerQualifiedOpportunity} />
          </div>

          <div className="grid grid-2 mb">
            <div className="card">
              <h2>Average days in stage</h2>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Stage</th>
                      <th className="num">Avg days</th>
                      <th className="num">Open</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(analytics.averageStageDays)
                      .sort((a, b) => b[1] - a[1])
                      .map(([stage, days]) => (
                        <tr key={stage}>
                          <td className="small">{humanize(stage)}</td>
                          <td className="num">{days}</td>
                          <td className="num">{analytics.byStage[stage]?.count ?? 0}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card">
              <h2>Relationship vulnerability distribution</h2>
              <table>
                <tbody>
                  {Object.entries(analytics.byMovability).map(([movability, count]) => (
                    <tr key={movability}>
                      <td className="small">{humanize(movability)}</td>
                      <td className="num">{count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h4 className="mt">Coverage</h4>
              <div className="small muted">
                {analytics.supplySideCompanies} supply-side vs {analytics.demandSideCompanies} demand-side companies (ratio{' '}
                {analytics.supplyDemandRatio}). Geographic footprint:{' '}
                {Object.entries(analytics.geographicCoverage)
                  .map(([state, count]) => `${state} (${count})`)
                  .join(', ') || 'none recorded'}
                .
              </div>
              {Object.keys(analytics.lossReasons).length > 0 && (
                <>
                  <h4 className="mt">Loss reasons</h4>
                  <ul className="list-reset small">
                    {Object.entries(analytics.lossReasons).map(([reason, count]) => (
                      <li key={reason}>
                        • {reason} ({count})
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
        </>
      )}

      <div className="card">
        <h2>Caller outcomes</h2>
        {metrics.length === 0 ? (
          <Empty>No caller data yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Caller</th>
                  <th className="num">Calls</th>
                  <th className="num">Reached</th>
                  <th className="num">Meaningful</th>
                  <th className="num">Qualified</th>
                  <th className="num">Pricing</th>
                  <th className="num">Matches</th>
                  <th className="num">Deals</th>
                  {showMoney && <th className="num">GP influenced</th>}
                  <th className="num">Q coverage</th>
                  <th className="num">Accuracy</th>
                  <th className="num">Talk %</th>
                  <th className="num">Flags</th>
                </tr>
              </thead>
              <tbody>
                {metrics.map((caller) => (
                  <tr key={caller.userId}>
                    <td>{caller.name}</td>
                    <td className="num">{caller.callsAttempted}</td>
                    <td className="num">{caller.contactsReached}</td>
                    <td className="num">{caller.meaningfulConversations}</td>
                    <td className="num">{Math.round(caller.qualificationRate * 100)}%</td>
                    <td className="num">{caller.pricingObtained}</td>
                    <td className="num">{caller.matchesEnabled}</td>
                    <td className="num">{caller.dealsInfluenced}</td>
                    {showMoney && <td className="num">{money(caller.grossProfitInfluenced)}</td>}
                    <td className="num">{Math.round(caller.scriptCompliance * 100)}%</td>
                    <td className="num">{Math.round(caller.informationAccuracy * 100)}%</td>
                    <td className="num">{Math.round(caller.averageTalkRatio * 100)}%</td>
                    <td className="num">
                      {caller.unauthorizedPromises > 0 ? <Badge tone="critical">{caller.unauthorizedPromises}</Badge> : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {metrics.map((caller) => {
        const recommendations = recommendCoaching(caller);
        if (recommendations.length === 0) return null;
        return (
          <div className="card" key={`coaching-${caller.userId}`}>
            <h2>Recommendations — {caller.name}</h2>
            {recommendations.map((recommendation, index) => (
              <div
                key={index}
                className={`alert ${recommendation.severity === 'critical' ? 'danger' : recommendation.severity === 'warning' ? 'warning' : 'info'} small`}
              >
                <strong>
                  [{recommendation.kind}] {recommendation.headline}
                </strong>
                <div>{recommendation.detail}</div>
              </div>
            ))}
            {Object.keys(caller.byCallType).length > 0 && (
              <div className="table-wrap mt">
                <table>
                  <thead>
                    <tr>
                      <th>Call type</th>
                      <th className="num">Attempted</th>
                      <th className="num">Connected</th>
                      <th className="num">Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(caller.byCallType).map(([type, stats]) => (
                      <tr key={type}>
                        <td className="small">{humanize(type)}</td>
                        <td className="num">{stats.attempted}</td>
                        <td className="num">{stats.connected}</td>
                        <td className="num">{Math.round(stats.connectRate * 100)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
