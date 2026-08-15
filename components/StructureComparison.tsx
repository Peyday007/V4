'use client';

import { useState } from 'react';
import { Badge } from './ui';
import type { StructureAssessment } from '@/lib/deal/structures';

/**
 * How this deal would be transacted, all twelve ways, side by side.
 *
 * The old version chose one structure automatically and printed the word on a
 * record. That is the decision that determines who can be sued, who invoices,
 * and who is out of pocket for six weeks — and it was made by a heuristic that
 * could not know the two things that decide it: how much cash the owner can put
 * at risk, and how far they trust the provider.
 *
 * So nothing here is ranked. Structures that are genuinely unavailable say why
 * in one sentence; the rest are laid out with the same five questions answered
 * for each, and the choice is made by the person who carries it. Cautions are
 * shown *on the available ones*, because a warning attached only to the options
 * somebody has already discarded is decoration.
 */

const EXPOSURE_TONE: Record<string, string> = {
  NONE: 'success',
  SMALL: 'success',
  MODERATE: 'warning',
  LARGE: 'danger',
};

const EXPOSURE_LABEL: Record<string, string> = {
  NONE: 'none of your money',
  SMALL: 'a little of your money',
  MODERATE: 'some of your money',
  LARGE: 'a lot of your money',
};

export function StructureComparison({
  routeId,
  assessments,
  chosen,
  chosenReason,
  canWrite,
}: {
  routeId: string;
  assessments: StructureAssessment[];
  chosen: string | null;
  chosenReason: string | null;
  canWrite: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(chosen);
  const [reason, setReason] = useState<string | null>(chosenReason);
  const [expanded, setExpanded] = useState<string | null>(null);

  const available = assessments.filter((a) => a.available);
  const ruledOut = assessments.filter((a) => !a.available);

  async function choose(key: string, why: string) {
    setBusy(key);
    setError(null);
    try {
      const response = await fetch(`/api/demand/opportunity/${routeId}/structure`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ structure: key, reason: why }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status})`);
      setCurrent(key);
      setReason(body.reason ?? why);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card" data-testid="structure-comparison">
      <div className="card-title">
        <h2>How this deal would be structured</h2>
        <span className="tiny dim">Who signs, who invoices, who is liable, who funds the gap</span>
      </div>

      {current ? (
        <div className="alert info small" data-testid="structure-chosen">
          <strong>Chosen: {current.toLowerCase().replace(/_/g, ' ')}.</strong>{' '}
          {reason ?? 'No reason was recorded.'}
        </div>
      ) : (
        <div className="alert warning small" data-testid="structure-unchosen">
          <strong>No structure has been chosen.</strong> Until one is, nobody can say who would sign with the
          buyer, who carries the work, or whose money sits in the gap — and a quote sent without that settled is
          a promise nobody has decided how to keep.
        </div>
      )}
      {error && <div className="alert danger small mt">{error}</div>}

      <div className="table-scroll mt">
        <table className="table tiny">
          <thead>
            <tr>
              <th>Structure</th>
              <th>Signs with the buyer</th>
              <th>Gets paid first</th>
              <th>Carries the liability</th>
              <th>Funds the gap</th>
              <th>At risk</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {available.map(({ structure, cautions, unknowns }) => (
              <tr key={structure.key} data-testid={`structure-${structure.key}`}>
                <td>
                  <strong>{structure.label}</strong>
                  {current === structure.key && <> <Badge tone="success">chosen</Badge></>}
                  <div className="dim">{structure.plainDescription}</div>
                  {(cautions.length > 0 || unknowns.length > 0) && (
                    <div className="tiny mt">
                      {cautions.map((c) => (
                        <div key={c} data-testid={`structure-caution-${structure.key}`}>
                          <Badge tone="warning">careful</Badge> {c}
                        </div>
                      ))}
                      {unknowns.map((u) => (
                        <div key={u} data-testid={`structure-unknown-${structure.key}`}>
                          <Badge>not established</Badge> {u}
                        </div>
                      ))}
                    </div>
                  )}
                </td>
                <td className="tiny">{structure.contractsWithBuyer}</td>
                <td className="tiny">{structure.paidFirst}</td>
                <td className="tiny">{structure.carriesLiability}</td>
                <td className="tiny">{structure.fundsTheGap}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <Badge tone={EXPOSURE_TONE[structure.cashExposure]}>
                    {EXPOSURE_LABEL[structure.cashExposure]}
                  </Badge>
                </td>
                <td>
                  <button
                    className="btn secondary tiny"
                    onClick={() => setExpanded(expanded === structure.key ? null : structure.key)}
                  >
                    {expanded === structure.key ? 'Less' : 'More'}
                  </button>
                  {canWrite && current !== structure.key && (
                    <button
                      className="btn tiny"
                      style={{ marginLeft: '0.3rem' }}
                      disabled={busy !== null}
                      onClick={() => choose(structure.key, structure.fits)}
                    >
                      {busy === structure.key ? 'Choosing…' : 'Choose'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {expanded && (
        <div className="card mt" data-testid={`structure-detail-${expanded}`}>
          {available
            .filter((a) => a.structure.key === expanded)
            .map(({ structure }) => (
              <div key={structure.key}>
                <h3 style={{ marginTop: 0 }}>{structure.label}</h3>
                <p className="small">{structure.plainDescription}</p>
                <div className="grid grid-2">
                  <div>
                    <div className="tiny dim">Who invoices</div>
                    <p className="small">{structure.invoices}</p>
                    <div className="tiny dim">What the margin looks like</div>
                    <p className="small">{structure.marginShape}</p>
                    <div className="tiny dim">When it does not fit</div>
                    <p className="small">{structure.doesNotFit}</p>
                  </div>
                  <div>
                    <div className="tiny dim">What you must have first</div>
                    <ul className="small" style={{ paddingLeft: '1.1rem', lineHeight: 1.6 }}>
                      {structure.requires.map((r) => <li key={r}>{r}</li>)}
                    </ul>
                  </div>
                </div>
              </div>
            ))}
        </div>
      )}

      {/* Ruled out, with the reason, rather than hidden. An operator who cannot
          see why brokerage is unavailable will assume the product forgot it. */}
      {ruledOut.length > 0 && (
        <details className="mt" data-testid="structure-ruled-out">
          <summary className="small">
            <strong>{ruledOut.length} structure(s) are not available on this deal</strong>
            <span className="tiny dim"> — each with the reason</span>
          </summary>
          <ul className="list-reset small mt" style={{ lineHeight: 1.7 }}>
            {ruledOut.map(({ structure, because }) => (
              <li key={structure.key} data-testid={`structure-out-${structure.key}`}>
                <strong>{structure.label}</strong> — {because}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
