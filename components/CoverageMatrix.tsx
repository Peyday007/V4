import { Badge } from './ui';
import type { CoverageMatrix as Matrix } from '@/lib/demand/coverage';

/**
 * All fifty states, most of them empty.
 *
 * The temptation with a coverage map is to show the states that work and let
 * the reader infer the rest. That inference is always optimistic — three green
 * states on a map of the country reads as "expanding" rather than "three" — so
 * every state is listed, the uncovered ones say so, and each carries the
 * specific next action that would change it.
 *
 * Collapsed by default below the working states, because forty-seven rows of
 * "nothing here" is the truth and is also not what somebody opens this page to
 * read every morning.
 */
export function CoverageMatrixPanel({ matrix }: { matrix: Matrix }) {
  const working = matrix.states.filter((s) => s.status === 'WORKING');
  const blocked = matrix.states.filter((s) => s.status === 'BLOCKED');
  const uncovered = matrix.states.filter((s) => s.status === 'NOT_CONFIGURED');

  return (
    <div className="card" data-testid="coverage-matrix">
      <div className="card-title">
        <h2>Where demand can be collected</h2>
        <span className="tiny dim">All fifty states, including the ones with nothing</span>
      </div>

      <div className="alert info small" data-testid="coverage-verdict">
        {matrix.verdict}
      </div>

      <div className="grid grid-4 mb">
        <div className="stat" data-testid="coverage-count-working">
          <div className="stat-label">Working</div>
          <div className="stat-value">{matrix.working}</div>
          <div className="tiny dim">A configured source is answering.</div>
        </div>
        <div className="stat" data-testid="coverage-count-blocked">
          <div className="stat-label">Blocked</div>
          <div className="stat-value">{matrix.blocked}</div>
          <div className="tiny dim">Configured, and something is in the way. An owner action.</div>
        </div>
        <div className="stat" data-testid="coverage-count-none">
          <div className="stat-label">No source</div>
          <div className="stat-value">{matrix.notConfigured}</div>
          <div className="tiny dim">Nothing is configured. Engineering, not configuration.</div>
        </div>
        <div className="stat">
          <div className="stat-label">Of fifty</div>
          <div className="stat-value">{matrix.states.length}</div>
          <div className="tiny dim">Every state is listed so the gaps are visible rather than inferred.</div>
        </div>
      </div>

      {working.length > 0 && (
        <div className="table-scroll">
          <table className="table tiny">
            <thead>
              <tr>
                <th>State</th>
                <th>Sources</th>
                <th>Produces</th>
                <th className="num">Events</th>
                <th className="num">Routes</th>
                <th>Last event</th>
              </tr>
            </thead>
            <tbody>
              {working.map((state) => (
                <tr key={state.code} data-testid={`coverage-${state.code}`}>
                  <td><strong>{state.name}</strong> <span className="dim">{state.code}</span></td>
                  <td className="tiny">
                    {state.sources.map((s) => (
                      <div key={s.label}>
                        {s.status === 'WORKING' ? '✓' : '✗'} {s.label}
                        <span className="dim"> · {s.domain}</span>
                        {s.because && <div className="dim">{s.because}</div>}
                      </div>
                    ))}
                  </td>
                  <td className="tiny dim">
                    {state.produces.map((p) => p.toLowerCase().replace(/_/g, ' ')).join(', ')}
                  </td>
                  <td className="num">{state.observed.events}</td>
                  <td className="num">{state.observed.routes}</td>
                  <td className="tiny dim">
                    {state.observed.lastEventAt?.toISOString().slice(0, 10) ?? 'none yet'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {blocked.length > 0 && (
        <>
          <h4 className="mt">Configured and blocked</h4>
          <p className="tiny dim">
            These need an owner action rather than engineering — the dataset is known and something is stopping
            it.
          </p>
          <ul className="list-reset small">
            {blocked.map((state) => (
              <li key={state.code} data-testid={`coverage-${state.code}`} style={{ padding: '0.35rem 0' }}>
                <Badge tone="danger">{state.code}</Badge> <strong>{state.name}</strong>
                <div className="tiny dim">{state.toCover}</div>
              </li>
            ))}
          </ul>
        </>
      )}

      <details className="mt" data-testid="coverage-uncovered">
        <summary className="small">
          <strong>{uncovered.length} state(s) with no source at all</strong>
          <span className="tiny dim"> — each with the specific thing that would change it</span>
        </summary>
        <div className="table-scroll mt">
          <table className="table tiny">
            <tbody>
              {uncovered.map((state) => (
                <tr key={state.code} data-testid={`coverage-${state.code}`}>
                  <td style={{ width: '11rem' }}>
                    <strong>{state.name}</strong> <span className="dim">{state.code}</span>
                  </td>
                  <td className="tiny dim">{state.toCover}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="tiny dim mt">
          Nothing here proposes scraping. Fifty brittle scrapers to turn a map green would be worse than an
          honest map: they would break one at a time, silently, and the map would stay green.
        </p>
      </details>
    </div>
  );
}
