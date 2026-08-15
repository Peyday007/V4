import { prisma } from '@/lib/db';
import { can, requireUser } from '@/lib/auth/session';
import { computeCallerMetrics, computePipelineAnalytics, recommendCoaching } from '@/lib/ai/analytics';
import { computePipelineMetrics } from '@/lib/ai/planner';
import { Badge, Empty, humanize, money, Stat } from '@/components/ui';
import { FigureChip, GradedStat } from '@/components/Figure';
import { gradeRate, presentPercent } from '@/lib/evidence/claims';
import { presentMoney } from '@/lib/evidence/economics';
import { inferred, unknown, type Evidenced } from '@/lib/evidence/class';
import { boardLearning } from '@/lib/caller/learning';

export const dynamic = 'force-dynamic';

/**
 * A pipeline total summed from per-opportunity estimates.
 *
 * Every row under it is a playbook range rather than a quoted price, so the
 * sum is an inference however many rows went into it. Shown as what it is
 * rather than as money, with the quote-backed figure a click away on the
 * dashboard.
 */
function estimateTotal(value: number, what: string): Evidenced<number> {
  if (!value) {
    return unknown<number>(
      `Nothing has been estimated, so there is no ${what} pipeline to show.`,
      'It fills in as opportunities are scored.',
    );
  }
  return inferred(
    value,
    `Summed from per-opportunity ${what} estimates, which are playbook ranges rather than quoted prices.`,
    'Quote the work against provider costs; the quote-backed total is on the dashboard.',
  );
}

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

  // What the calling has taught the engine. Distinct from every other figure
  // on this page: those measure the pipeline, this measures what the pipeline
  // learned, and a playbook that keeps producing routes disqualified for the
  // same reason is a playbook to change rather than a conversion rate to fret
  // about.
  const learning = await boardLearning({ orgId: user.orgId, since: periodStart });

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

      {/* --- what the calling taught the engine --------------------------- */}
      <div className="card" data-testid="board-learning">
        <div className="card-title">
          <h2>What the calling has taught the engine</h2>
          <span className="tiny dim">Facts on the record because somebody rang and asked</span>
        </div>
        <p className="small" data-testid="board-learning-sentence">{learning.sentence}</p>

        {learning.whyTheyFail.length > 0 ? (
          <>
            <div className="tiny dim mt">Why hypotheses close</div>
            <p className="tiny dim">
              Grouped by outcome rather than by wording, so two callers describing the same reason in their own
              words still group. A playbook that keeps producing routes closed for the same reason is a playbook
              to change.
            </p>
            <div className="table-scroll">
              <table className="table tiny">
                <thead>
                  <tr><th>Reason</th><th className="num">Times</th><th>What they said</th></tr>
                </thead>
                <tbody>
                  {learning.whyTheyFail.map((row) => (
                    <tr key={row.reason} data-testid={`learning-reason-${row.reason.replace(/\s+/g, '-')}`}>
                      <td>{row.reason}</td>
                      <td className="num">{row.count}</td>
                      <td className="tiny dim">{row.examples.join(' · ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p className="tiny dim">
            No hypothesis has been closed by an answer yet. Until one is, every route on the board is still the
            engine&apos;s reading of a public record rather than anything a person checked.
          </p>
        )}

        {learning.openDisputes > 0 && (
          <div className="alert warning small mt" data-testid="board-learning-disputes">
            {learning.openDisputes} claim(s) are disputed by two sources. Each is settled by one call, and
            nothing resting on them is safe to quote until they are.
          </div>
        )}
      </div>
        <Badge>Last 90 days</Badge>
      </div>

      {pipeline && analytics && (
        <>
          <div className="grid grid-4 mb">
            <Stat label="Active opportunities" value={pipeline.activeOpportunities} />
            {/* Both of these sum per-opportunity estimates. The gross-profit
                figure with a cost behind it lives on the quotes, so these say
                what they are summing rather than presenting it as money in
                hand. */}
            {showMoney && (
              <GradedStat
                label="GP pipeline"
                presentation={presentMoney(estimateTotal(pipeline.grossProfitPipeline, 'gross profit'))}
              />
            )}
            {showMoney && (
              <GradedStat
                label="Expected value"
                presentation={presentMoney(estimateTotal(pipeline.expectedValuePipeline, 'expected value'))}
              />
            )}
            <GradedStat
              label="Quote-to-close"
              presentation={presentPercent(gradeRate({
                numerator: analytics.quotesAccepted,
                denominator: analytics.quotesSent,
                what: 'quote-to-close rate',
              }))}
            />
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
                    {/* Each of these was a percentage with its denominator out
                        of reach, so 100% over two facts and 100% over two
                        hundred read the same — and these numbers get people
                        praised or managed. Below the floor the counts show
                        instead. */}
                    <td className="num tiny">
                      <FigureChip presentation={presentPercent(gradeRate({
                        numerator: Math.round(caller.qualificationRate * caller.denominators.opportunities),
                        denominator: caller.denominators.opportunities,
                        what: 'qualification rate',
                      }))} />
                    </td>
                    <td className="num">{caller.pricingObtained}</td>
                    <td className="num">{caller.matchesEnabled}</td>
                    <td className="num">{caller.dealsInfluenced}</td>
                    {showMoney && <td className="num">{money(caller.grossProfitInfluenced)}</td>}
                    <td className="num tiny">
                      <FigureChip presentation={presentPercent(gradeRate({
                        numerator: Math.round(caller.scriptCompliance * caller.denominators.requiredQuestions),
                        denominator: caller.denominators.requiredQuestions,
                        what: 'question-coverage rate',
                      }))} />
                    </td>
                    <td className="num tiny">
                      <FigureChip presentation={presentPercent(gradeRate({
                        numerator: Math.round(caller.informationAccuracy * caller.denominators.facts),
                        denominator: caller.denominators.facts,
                        what: 'accuracy rate',
                      }))} />
                    </td>
                    <td className="num tiny">
                      {caller.denominators.talkRatios === 0
                        ? <span className="dim">no measured calls</span>
                        : `${Math.round(caller.averageTalkRatio * 100)}% over ${caller.denominators.talkRatios}`}
                    </td>
                    <td className="num">
                      {caller.unauthorizedPromises > 0
                        ? <Badge tone="critical">{caller.unauthorizedPromises}</Badge>
                        : <span className="dim">none</span>}
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
                        <td className="num tiny">
                          <FigureChip presentation={presentPercent(gradeRate({
                            numerator: stats.connected,
                            denominator: stats.attempted,
                            what: 'connect rate',
                          }))} />
                        </td>
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
