'use client';

import { useState } from 'react';
import { Badge } from './ui';

/**
 * Handing a campaign's work to a caller.
 *
 * The gap this closes is small to describe and was the reason campaigns could
 * not be judged: the routes a campaign produced went onto the board like any
 * other, a caller worked whatever the queue served, and the campaign was then
 * measured on outcomes it had no way of causing.
 *
 * So this assigns *this campaign's* routes, and the packet carries the thesis
 * as its objective. A caller who knows what is being tested asks the question
 * that would disprove it; a caller who does not asks whether they need anything
 * today. That difference is most of what a campaign is worth.
 *
 * Everything withheld says why, on the same rule as every other preview in this
 * product: an operator who sees "4 of 19 assignable" and no reasons will assume
 * the other fifteen were lost.
 */
export function CampaignAssignment({
  campaignId,
  assignment,
  callers,
  canAssign,
}: {
  campaignId: string;
  assignment: {
    assignable: Array<{ routeId: string; organisation: string; headline: string; tier: string }>;
    withheld: Array<{ routeId: string; organisation: string; because: string }>;
    objective: string;
    blocker: string | null;
  } | null;
  callers: Array<{ id: string; name: string; mode: string }>;
  canAssign: boolean;
}) {
  const [callerId, setCallerId] = useState(callers[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!assignment) {
    return (
      <div className="card" data-testid="campaign-assignment">
        <div className="card-title"><h2>Getting this to somebody</h2></div>
        <p className="small muted">This campaign cannot be assigned from here.</p>
      </div>
    );
  }

  async function assign() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch(`/api/campaigns/${campaignId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'assign', callerId }),
      });
      const body = await response.json();
      if (!response.ok || body?.ok === false) throw new Error(body?.error ?? `Request failed (${response.status})`);
      setResult(`${body.assigned} opportunity(ies) assigned. ${body.withheld} withheld, each with a reason.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" data-testid="campaign-assignment">
      <div className="card-title">
        <h2>Getting this to somebody</h2>
        <span className="tiny dim">This campaign&apos;s own work, with the thesis attached</span>
      </div>

      {assignment.blocker ? (
        <div className="alert warning small" data-testid="assignment-blocker">{assignment.blocker}</div>
      ) : (
        <>
          <div className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
            <Badge tone={assignment.assignable.length > 0 ? 'success' : 'warning'}>
              {assignment.assignable.length} assignable
            </Badge>
            <Badge>{assignment.withheld.length} withheld</Badge>
          </div>

          {/* The objective the caller will see. Shown here so an owner can
              check what somebody will be told before they are told it. */}
          <div className="alert info small mt" data-testid="assignment-objective">
            <strong>What the caller is told they are testing:</strong> {assignment.objective}
          </div>

          {canAssign && assignment.assignable.length > 0 && (
            <div className="row mt" style={{ gap: '0.5rem', alignItems: 'center' }}>
              <select value={callerId} onChange={(e) => setCallerId(e.target.value)} disabled={busy}>
                {callers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.mode.toLowerCase()})
                  </option>
                ))}
              </select>
              <button className="btn" disabled={busy || !callerId} onClick={assign}>
                {busy ? 'Assigning…' : 'Assign this campaign’s work'}
              </button>
            </div>
          )}
          {callers.length === 0 && (
            <div className="alert small mt">
              No callers exist to assign to. A campaign with a calling channel and nobody to call it is a
              thesis nobody is testing.
            </div>
          )}

          {result && <div className="alert success small mt" data-testid="assignment-result">{result}</div>}
          {error && <div className="alert danger small mt" data-testid="assignment-error">{error}</div>}

          {assignment.withheld.length > 0 && (
            <details className="mt" data-testid="assignment-withheld">
              <summary className="small">
                <strong>{assignment.withheld.length} not assignable</strong>
                <span className="tiny dim"> — each with the reason</span>
              </summary>
              <ul className="list-reset tiny mt" style={{ lineHeight: 1.7 }}>
                {assignment.withheld.map((w) => (
                  <li key={w.routeId}>
                    <strong>{w.organisation}</strong> — {w.because}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}
