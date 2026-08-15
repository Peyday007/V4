import Link from 'next/link';
import { requirePagePermission } from '@/lib/auth/page';
import { universeReport, type MiniPathAssessment, type OperationalState } from '@/lib/universe/status';
import { COMMERCIAL_MODEL_BY_KEY, COMMERCIAL_MODELS, LANES } from '@/lib/universe/registry';
import { Badge, Empty, money } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Everything this business could commercially do, and what actually works.
 *
 * The page exists because of a specific complaint: the board only ever showed
 * janitorial work, and an owner reading it could not tell whether that was
 * because janitorial is the business or because janitorial is the only thing
 * the code knew how to see. It was the second.
 *
 * So the universe is shown in full — forty-odd paths across fourteen commercial
 * models — and every one carries a status derived from whether it has a
 * playbook, whether any working source can feed it, whether it knows both
 * commercial sides, whether there is a first action, and whether a real
 * production record has ever come through it. Most report that they are
 * declarations. That is the honest answer and the useful one: it turns "the
 * product does not do steel" from an impression into a line with a next action
 * against it.
 */
export default async function UniversePage({
  searchParams,
}: {
  searchParams: { state?: string; model?: string };
}) {
  const user = await requirePagePermission('discovery.read');
  const report = await universeReport({ orgId: user.orgId });

  const stateFilter = (searchParams.state ?? 'all').toUpperCase();
  const modelFilter = searchParams.model ?? 'all';

  const visible = report.assessments.filter((a) => {
    if (stateFilter !== 'ALL' && a.state !== stateFilter) return false;
    if (modelFilter !== 'all' && a.path.model !== modelFilter) return false;
    return true;
  });

  // Grouped by commercial model, because the models are what differ legally —
  // who contracts with whom, who carries the cash gap — and grouping by trade
  // would put a brokerage and a distribution deal side by side as though they
  // were the same kind of commitment.
  const byModel = new Map<string, MiniPathAssessment[]>();
  for (const assessment of visible) {
    const list = byModel.get(assessment.path.model) ?? [];
    list.push(assessment);
    byModel.set(assessment.path.model, list);
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Opportunity universe</h1>
          <p>
            Every commercial model, vertical and path this business could operate — including the ones that do
            not work yet. A path is only called operational when it has a playbook, a working source, both
            commercial sides, a first action a person can take, and a real record that has come through it.
          </p>
        </div>
        <Link href="/demand/sources" className="btn secondary">Source health</Link>
      </div>

      <div className="grid grid-4 mb" data-testid="universe-totals">
        <StateTile label="Operational" count={report.totals.OPERATIONAL} tone="success"
          meaning="Playbook, working source, both sides, an operator action, and a real record through it." />
        <StateTile label="Partial" count={report.totals.PARTIAL} tone="warning"
          meaning="Wired, but something is missing — usually a real record, sometimes a side of the deal." />
        <StateTile label="Needs configuration" count={report.totals.NEEDS_CONFIGURATION} tone="danger"
          meaning="The playbook is complete and every source that could feed it is blocked. An owner action." />
        <StateTile label="Taxonomy only" count={report.totals.TAXONOMY_ONLY} tone=""
          meaning="Declared so the universe is honest. No playbook, so nothing can qualify through it." />
      </div>

      {/* The three the owner named, pulled out so they cannot get lost in
          forty rows. */}
      <div className="card" data-testid="universe-named-paths">
        <div className="card-title">
          <h2>The three named paths</h2>
          <span className="tiny dim">These were promised end to end, so they are shown whatever the filter says</span>
        </div>
        <div className="table-scroll">
          <table className="table tiny">
            <tbody>
              {report.provenTargets.map((a) => (
                <tr key={a.path.key} data-testid={`named-${a.path.key}`}>
                  <td style={{ width: '18rem' }}>
                    <strong>{a.path.label}</strong>
                    <div className="dim">{a.path.vertical} · {a.path.subvertical}</div>
                  </td>
                  <td style={{ width: '10rem' }}><StateBadge state={a.state} /></td>
                  <td>
                    {a.because ?? 'Working end to end.'}
                    {a.toActivate && <div className="tiny mt"><strong>To fix:</strong> {a.toActivate}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="filter-bar">
        {['all', 'OPERATIONAL', 'PARTIAL', 'NEEDS_CONFIGURATION', 'TAXONOMY_ONLY', 'DISABLED'].map((option) => (
          <Link
            key={option}
            href={`/universe?state=${option}${modelFilter !== 'all' ? `&model=${modelFilter}` : ''}`}
            className={`filter-chip${stateFilter === option.toUpperCase() ? ' active' : ''}`}
          >
            {option === 'all' ? 'All' : option.toLowerCase().replace(/_/g, ' ')}
          </Link>
        ))}
      </div>

      <div className="filter-bar">
        <Link href={`/universe?state=${stateFilter}`} className={`filter-chip${modelFilter === 'all' ? ' active' : ''}`}>
          All models
        </Link>
        {COMMERCIAL_MODELS.map((model) => (
          <Link
            key={model.key}
            href={`/universe?state=${stateFilter}&model=${model.key}`}
            className={`filter-chip${modelFilter === model.key ? ' active' : ''}`}
          >
            {model.label}
          </Link>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="card"><Empty>No path matches this view.</Empty></div>
      ) : (
        [...byModel.entries()].map(([modelKey, assessments]) => {
          const model = COMMERCIAL_MODEL_BY_KEY.get(modelKey as never);
          return (
            <div className="card" key={modelKey} data-testid={`model-${modelKey}`}>
              <div className="card-title">
                <h2>{model?.label ?? modelKey}</h2>
                <span className="tiny dim">{assessments.length} path(s)</span>
              </div>
              {model && (
                <>
                  <p className="small muted">{model.plainDescription}</p>
                  <p className="tiny dim">
                    <strong>Who signs what:</strong> {model.contracting} <strong>Revenue:</strong>{' '}
                    {model.revenueBasis} <strong>What we carry:</strong> {model.exposure}
                  </p>
                </>
              )}

              <div className="table-scroll mt">
                <table className="table tiny">
                  <thead>
                    <tr>
                      <th>Path</th>
                      <th>Status</th>
                      <th>What it can discover</th>
                      <th>Real records</th>
                      <th>Reason and next action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {assessments.map((a) => (
                      <tr key={a.path.key} data-testid={`path-${a.path.key}`}>
                        <td style={{ minWidth: '14rem' }}>
                          <strong>{a.path.label}</strong>
                          <div className="dim">{a.path.plainDescription}</div>
                          <div className="tiny dim mt">
                            {a.path.lanes.map((l) => LANES[l].label).join(' · ')}
                          </div>
                        </td>
                        <td><StateBadge state={a.state} /></td>
                        <td className="tiny dim">{a.canDiscover}</td>
                        <td className="tiny">
                          {a.observed.routes === 0 ? (
                            <span className="dim">none</span>
                          ) : (
                            <>
                              {a.observed.routes} route(s)
                              <div className="dim">
                                {a.observed.quotes} quote(s) · {a.observed.wins} win(s)
                                {a.observed.collectedGrossProfit > 0 && (
                                  <> · {money(a.observed.collectedGrossProfit)} GP</>
                                )}
                              </div>
                            </>
                          )}
                        </td>
                        <td className="tiny">
                          {a.because ?? <span className="dim">Working.</span>}
                          {a.toActivate && (
                            <div className="mt"><strong>Next:</strong> {a.toActivate}</div>
                          )}
                          <details className="mt">
                            <summary className="dim">The five checks</summary>
                            <ul className="list-reset mt">
                              {a.requirements.map((r) => (
                                <li key={r.key}>
                                  {r.met ? '✓' : '✗'} <strong>{r.question}</strong>
                                  <div className="dim">{r.finding}</div>
                                </li>
                              ))}
                            </ul>
                          </details>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })
      )}
    </>
  );
}

function StateTile({
  label, count, tone, meaning,
}: { label: string; count: number; tone: string; meaning: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{count}</div>
      <div className="tiny dim">{meaning}</div>
      {tone && <Badge tone={tone}>{label.toLowerCase()}</Badge>}
    </div>
  );
}

function StateBadge({ state }: { state: OperationalState }) {
  const tone =
    state === 'OPERATIONAL' ? 'success'
      : state === 'PARTIAL' ? 'warning'
        : state === 'NEEDS_CONFIGURATION' ? 'danger'
          : '';
  return <Badge tone={tone}>{state.toLowerCase().replace(/_/g, ' ')}</Badge>;
}
