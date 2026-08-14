import { Badge } from './ui';

/**
 * What the portfolio actually is, and what it could be.
 *
 * Two panels rather than one because they answer different questions and the
 * second has to be read first. Concentration says how balanced the live work
 * is; coverage says how balanced it *could* be. A board that is entirely
 * Illinois is not a discipline problem when Illinois is the only state a
 * working source covers, and showing the first figure without the second sends
 * an owner hunting for a fault in how work is chosen when the fault is in what
 * arrives.
 */
export function PortfolioShape({
  shape,
  coverage,
}: {
  shape: {
    routes: number;
    opportunities: number;
    refraction: number;
    verdict: string;
    exposures: Array<{ dimension: string; largest: string; share: number; count: number; total: number; ifItGoes: string; material: boolean }>;
  };
  coverage: {
    reachable: string[];
    unreachable: Array<{ state: string; label: string; because: string }>;
    verdict: string;
  };
}) {
  return (
    <div className="card" data-testid="portfolio-shape">
      <div className="card-title">
        <h2>Shape of the portfolio</h2>
        <span className="tiny dim">
          {shape.routes} route(s) on {shape.opportunities} event(s)
        </span>
      </div>

      {/* Coverage leads. It is the constraint every figure below sits inside. */}
      <div className="alert info small" data-testid="coverage">
        <strong>What the sources can reach:</strong> {coverage.verdict}
      </div>

      <p className="small">{shape.verdict}</p>

      {shape.exposures.length > 0 && (
        <div className="table-scroll mt">
          <table className="table tiny">
            <thead>
              <tr>
                <th>Dimension</th>
                <th>Largest</th>
                <th className="num">Share</th>
                <th>If it goes</th>
              </tr>
            </thead>
            <tbody>
              {shape.exposures.map((e) => (
                <tr key={e.dimension}>
                  <td>
                    {e.dimension}{' '}
                    {e.material && <Badge tone="warning">material</Badge>}
                  </td>
                  <td>{e.largest}</td>
                  <td className="num">
                    {(e.share * 100).toFixed(0)}% ({e.count}/{e.total})
                  </td>
                  <td className="small">{e.ifItGoes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {coverage.unreachable.length > 0 && (
        <details className="mt">
          <summary className="tiny dim">
            {coverage.unreachable.length} configured jurisdiction(s) produce nothing
          </summary>
          <ul className="list-reset tiny mt" style={{ lineHeight: 1.6 }}>
            {coverage.unreachable.map((u) => (
              <li key={u.label} className="mt">
                <strong>{u.label} ({u.state}):</strong> {u.because}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
