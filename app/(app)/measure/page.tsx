import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePageAny } from '@/lib/auth/page';
import { can } from '@/lib/auth/session';
import { funnelReport } from '@/lib/measure/funnel';
import { sourcePerformance, routePerformance, callerScorecards } from '@/lib/measure/analytics';
import { readOut } from '@/lib/measure/experiments';
import { pct } from '@/lib/measure/stats';
import { Badge, Empty, money } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * What is actually working.
 *
 * The organising rule of this page: every rate is shown with the sample it came
 * from, and anything below the floor says so instead of showing a number. The
 * previous system's dashboards were confident about everything, which is how a
 * source with four leads and one lucky conversion got more budget.
 */
export default async function MeasurePage({ searchParams }: { searchParams: { days?: string } }) {
  const user = await requirePageAny('analytics.pipeline.read', 'analytics.caller.read.all');
  const showMoney = can(user, 'finance.margin.read');
  const showCallers = can(user, 'analytics.caller.read.all');

  const days = Math.min(Math.max(Number(searchParams.days ?? '90') || 90, 7), 365);
  const since = new Date(Date.now() - days * 86_400_000);

  const [funnel, sources, routes, experiments] = await Promise.all([
    funnelReport({ orgId: user.orgId, since }),
    sourcePerformance({ orgId: user.orgId, since }),
    routePerformance({ orgId: user.orgId, since }),
    prisma.experiment.findMany({
      where: { orgId: user.orgId, state: { in: ['RUNNING', 'CONCLUDED', 'HALTED'] } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true },
    }),
  ]);

  const callers = showCallers ? await callerScorecards({ orgId: user.orgId, since }) : [];
  const readouts = await Promise.all(
    experiments.map((e) => readOut({ orgId: user.orgId, experimentId: e.id })),
  );

  return (
    <>
      <div className="page-header">
        <div>
          <h1>What is working</h1>
          <p>
            Measured to money that arrived, not to appointments booked. Every rate carries the sample it came from;
            anything below the floor says so rather than showing a number.
          </p>
        </div>
        <div className="filter-bar">
          {[30, 90, 365].map((option) => (
            <Link key={option} href={`/measure?days=${option}`} className={`filter-chip${days === option ? ' active' : ''}`}>
              {option} days
            </Link>
          ))}
        </div>
      </div>

      <div className="card" data-testid="funnel">
        <h2 style={{ marginTop: 0 }}>Source record to collected gross profit</h2>
        {funnel.tooEarly && (
          <div className="alert small" data-testid="funnel-too-early">
            Fewer than 20 verified leads in this window, so no conversion rates are shown. The counts are real; the
            percentages would not be.
          </div>
        )}
        {funnel.firstBreak && (
          <div className="alert warning small" data-testid="funnel-break">{funnel.firstBreak}</div>
        )}
        <table className="table tiny">
          <thead>
            <tr><th>Stage</th><th>Count</th><th>From the stage above</th><th>From verified leads</th></tr>
          </thead>
          <tbody>
            {funnel.rows.map((row) => (
              <tr key={row.stage}>
                <td>{row.label}</td>
                <td><strong>{row.count}</strong></td>
                <td className="dim">{row.fromPrevious === null ? '—' : pct(row.fromPrevious)}</td>
                <td className="dim">{row.fromLeads === null ? '—' : pct(row.fromLeads)}</td>
              </tr>
            ))}
            <tr>
              <td className="dim">Lost</td>
              <td className="dim">{funnel.lost}</td>
              <td colSpan={2} className="dim">Off the ladder, and a real outcome.</td>
            </tr>
          </tbody>
        </table>
        {showMoney && (
          <p className="small muted" data-testid="funnel-money">
            <strong>Collected gross profit: {money(funnel.collectedGrossProfit)}</strong>{' '}
            <span className="dim">— settled money in minus settled money out. Not quoted, not contracted.</span>
          </p>
        )}
      </div>

      <div className="card" data-testid="sources">
        <h2 style={{ marginTop: 0 }}>Sources</h2>
        <p className="tiny dim">
          Ranked on collected gross profit per verified lead. Record volume is shown first so it cannot be mistaken
          for performance — a connector producing fifty thousand records and no revenue looks productive on any count
          of records.
        </p>
        {sources.length === 0 ? (
          <Empty>No source has produced a measurable outcome yet.</Empty>
        ) : (
          <table className="table tiny">
            <thead>
              <tr>
                <th>Connector</th><th>Records</th><th>Verified leads</th>
                <th>Need confirmed</th><th>Quoted</th><th>Paid</th>
                {showMoney && <th>Profit per lead</th>}
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <tr key={source.connector}>
                  <td>
                    {source.connector}
                    {source.insufficientEvidence && (
                      <div className="tiny dim" data-testid="source-insufficient">{source.insufficientEvidence}</div>
                    )}
                  </td>
                  <td className="dim">{source.records}</td>
                  <td>{source.verifiedLeads}</td>
                  <td>{rateCell(source.needConfirmed)}</td>
                  <td>{rateCell(source.quoted)}</td>
                  <td>{rateCell(source.paid)}</td>
                  {showMoney && (
                    <td>{source.profitPerLead === null ? <span className="dim">—</span> : money(source.profitPerLead)}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card" data-testid="routes">
        <h2 style={{ marginTop: 0 }}>Routes</h2>
        {routes.length === 0 ? (
          <Empty>No route has produced a measurable outcome yet.</Empty>
        ) : (
          routes.map((route) => (
            <div key={route.route} className="mb">
              <strong>{route.route}</strong>{' '}
              {showMoney && <Badge>{money(route.collectedGrossProfit)} collected</Badge>}
              {route.insufficientEvidence && (
                <div className="tiny dim">{route.insufficientEvidence}</div>
              )}
              <div className="tiny dim">
                {route.stages.filter((s) => s.count > 0).map((s) => `${s.label} ${s.count}`).join(' · ') || 'nothing recorded'}
              </div>
            </div>
          ))
        )}
      </div>

      {showCallers && (
        <div className="card" data-testid="callers">
          <h2 style={{ marginTop: 0 }}>Callers</h2>
          <p className="tiny dim">
            Rates are shown against the mix of work each person was handed. Nobody is compared to anybody else on this
            table — a caller given active demand will out-convert one given directory prospects at any skill level.
          </p>
          {callers.length === 0 ? (
            <Empty>No caller activity in this window.</Empty>
          ) : (
            <table className="table tiny">
              <thead>
                <tr>
                  <th>Caller</th><th>Attempts</th><th>Answered</th><th>Relevant person</th>
                  <th>Need confirmed</th><th>Promises</th><th>Work handed to them</th>
                </tr>
              </thead>
              <tbody>
                {callers.map((caller) => (
                  <tr key={caller.callerId}>
                    <td>
                      {caller.name}
                      {caller.insufficientEvidence && (
                        <div className="tiny dim" data-testid="caller-insufficient">{caller.insufficientEvidence}</div>
                      )}
                      {caller.systemIncidents > 0 && (
                        <div className="tiny dim">
                          {caller.systemIncidents} system incident{caller.systemIncidents === 1 ? '' : 's'} — ours, not theirs.
                        </div>
                      )}
                    </td>
                    <td>{caller.attempts}</td>
                    <td>{rateCell(caller.answered)}</td>
                    <td>{rateCell(caller.relevantPerson)}</td>
                    <td>{rateCell(caller.needConfirmed)}</td>
                    <td className="dim">{caller.promisesKept}/{caller.promisesMade}</td>
                    <td className="dim">
                      {Object.entries(caller.mix).map(([tier, n]) => `${tier.toLowerCase().replace(/_/g, ' ')} ${n}`).join(', ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <div className="card" data-testid="experiments">
        <h2 style={{ marginTop: 0 }}>Experiments</h2>
        {readouts.filter(Boolean).length === 0 ? (
          <Empty>Nothing is being tested.</Empty>
        ) : (
          readouts.filter((r): r is NonNullable<typeof r> => r !== null).map((readout) => (
            <div key={readout.experimentId} className="mb" data-testid="experiment-readout">
              <div className="row">
                <strong>{readout.name}</strong>
                <Badge tone={readout.blocked ? 'danger' : readout.verdict === 'better' ? 'success' : 'warning'}>
                  {readout.blocked ? 'blocked' : readout.verdict.replace(/_/g, ' ')}
                </Badge>
                <span className="tiny dim">{readout.state.toLowerCase()}</span>
              </div>
              <div className="tiny dim">Declared outcome: {readout.primaryLabel}</div>
              <p className="small muted">{readout.because}</p>

              <table className="table tiny">
                <tbody>
                  {readout.arms.map((arm) => (
                    <tr key={arm.key}>
                      <td>{arm.label}{arm.isControl && <span className="dim"> (control)</span>}</td>
                      <td>{arm.reached}/{arm.assigned}</td>
                      <td>{rateCell(arm.rate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {readout.guardrails.length > 0 && (
                <div className="tiny dim">
                  Guardrails:{' '}
                  {readout.guardrails.map((g) => (
                    <span key={g.stage}>
                      {g.label} — {g.regressed ? <strong>regressed</strong> : g.verdict.replace(/_/g, ' ')}.{' '}
                    </span>
                  ))}
                </div>
              )}

              <p className="small" data-testid="experiment-recommendation"><strong>{readout.recommendation}</strong></p>
            </div>
          ))
        )}
      </div>
    </>
  );
}

/**
 * A rate, its interval and its sample, together.
 *
 * Never a bare percentage. The interval is what stops "50%" from four calls
 * reading like "50%" from four hundred.
 */
function rateCell(value: { rate: number | null; low: number | null; high: number | null; trials: number; weak: boolean }) {
  if (value.rate === null) return <span className="dim">no data</span>;
  if (value.weak) {
    return (
      <span className="dim" title={`${value.trials} observations`}>
        {pct(value.rate)} <span className="tiny">(n={value.trials}, too few)</span>
      </span>
    );
  }
  return (
    <>
      {pct(value.rate)}
      <div className="tiny dim">{pct(value.low)}–{pct(value.high)} · n={value.trials}</div>
    </>
  );
}
