'use client';

import { useState } from 'react';
import { Badge } from './ui';
import type { ReconciliationPreview, RouteVerdict } from '@/lib/demand/reconcile';

/**
 * What the board would look like if it had been built under today's rule.
 *
 * Two hundred routes were created before one event was limited to one primary
 * thesis, and the refraction is still there — a single licence record wearing
 * four hypotheses, each of which looks like an opportunity.
 *
 * This shows what would change and changes nothing. The apply control sends the
 * ids the owner has actually ticked, never a filter, and the server re-checks
 * every one against the same safety rule before touching it: a route somebody
 * has called is refused even if it was ticked, because the preview may be an
 * hour old and a conversation may have happened since.
 */

const TONE: Record<RouteVerdict, string> = {
  RETAINED: 'success',
  SUPERSEDED: 'warning',
  WORKED: '',
  NO_CREDIBLE_READING: 'danger',
};

const LABEL: Record<RouteVerdict, string> = {
  RETAINED: 'keep',
  SUPERSEDED: 'superseded',
  WORKED: 'worked — untouchable',
  NO_CREDIBLE_READING: 'no credible reading',
};

export function Reconciliation({
  preview,
  canApply,
}: {
  preview: ReconciliationPreview;
  canApply: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ closed: number; refused: Array<{ routeId: string; because: string }> } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const closable = preview.groups.flatMap((g) =>
    g.rows.filter((r) => r.verdict === 'SUPERSEDED' || r.verdict === 'NO_CREDIBLE_READING'),
  );

  function toggle(routeId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(routeId)) next.delete(routeId);
      else next.add(routeId);
      return next;
    });
  }

  async function apply() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch('/api/demand/reconcile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ routeIds: [...selected], reason }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status})`);
      setResult(body);
      setSelected(new Set());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="reconciliation">
      <div className="alert info" data-testid="reconciliation-standing">
        {preview.standing}
      </div>

      <div className="grid grid-4 mb">
        <div className="stat" data-testid="reconcile-count-retained">
          <div className="stat-label">Would be kept</div>
          <div className="stat-value">{preview.counts.RETAINED}</div>
          <div className="tiny dim">The strongest reading of its event.</div>
        </div>
        <div className="stat" data-testid="reconcile-count-superseded">
          <div className="stat-label">Superseded</div>
          <div className="stat-value">{preview.counts.SUPERSEDED}</div>
          <div className="tiny dim">A weaker reading of an event that has a stronger one.</div>
        </div>
        <div className="stat" data-testid="reconcile-count-worked">
          <div className="stat-label">Worked</div>
          <div className="stat-value">{preview.counts.WORKED}</div>
          <div className="tiny dim">Somebody rang. Never proposed for closure.</div>
        </div>
        <div className="stat" data-testid="reconcile-count-nocredible">
          <div className="stat-label">No credible reading</div>
          <div className="stat-value">{preview.counts.NO_CREDIBLE_READING}</div>
          <div className="tiny dim">Nothing about the event clears the gate today.</div>
        </div>
      </div>

      {result && (
        <div className="alert success small" data-testid="reconcile-result">
          <strong>{result.closed} closed.</strong>
          {result.refused.length > 0 && (
            <ul className="list-reset tiny mt" style={{ paddingLeft: '1rem' }}>
              {result.refused.map((r) => <li key={r.routeId}>{r.routeId}: {r.because}</li>)}
            </ul>
          )}
        </div>
      )}
      {error && <div className="alert danger small" data-testid="reconcile-error">{error}</div>}

      {canApply && closable.length > 0 && (
        <div className="card" data-testid="reconcile-apply">
          <div className="card-title">
            <h2>Close the ones you have ticked</h2>
            <span className="tiny dim">{selected.size} of {closable.length} selected</span>
          </div>
          <p className="small">
            Only the opportunities you tick are touched. Nothing is closed by category, and the server refuses
            any of them that somebody has worked since this page loaded.
          </p>
          <div className="field">
            <label htmlFor="reconcile-reason">Why, in your own words</label>
            <input
              id="reconcile-reason"
              data-testid="reconcile-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Recorded on every opportunity closed, and readable a year from now."
            />
          </div>
          <button
            className="btn"
            data-testid="reconcile-apply-button"
            disabled={busy || selected.size === 0 || reason.trim().length < 10}
            onClick={apply}
          >
            {busy ? 'Closing…' : `Close ${selected.size} opportunity(ies)`}
          </button>
          {selected.size > 0 && reason.trim().length < 10 && (
            <div className="tiny dim mt">
              A bulk closure with no stated reason is not a decision anybody can review later.
            </div>
          )}
        </div>
      )}

      {preview.groups.length === 0 ? (
        <div className="card">
          <p className="small muted">
            No event on this board supports more than one route. There is nothing to reconcile, which is what
            the competition is for.
          </p>
        </div>
      ) : (
        preview.groups.map((group) => (
          <div className="card" key={group.eventId} data-testid={`reconcile-group-${group.eventId}`}>
            <div className="card-title">
              <h3 style={{ margin: 0 }}>{group.eventHeadline}</h3>
              <Badge tone={group.routeCount > 2 ? 'danger' : 'warning'}>
                {group.routeCount} routes from one event
              </Badge>
            </div>
            <div className="table-scroll">
              <table className="table tiny">
                <thead>
                  <tr>
                    <th style={{ width: '2rem' }} />
                    <th>Organisation</th>
                    <th>Reading</th>
                    <th>Verdict</th>
                    <th>What would happen</th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((row) => {
                    const selectable =
                      canApply && (row.verdict === 'SUPERSEDED' || row.verdict === 'NO_CREDIBLE_READING');
                    return (
                      <tr key={row.routeId} data-testid={`reconcile-row-${row.routeId}`}>
                        <td>
                          {selectable ? (
                            <input
                              type="checkbox"
                              aria-label={`Close ${row.organisation}`}
                              data-testid={`reconcile-select-${row.routeId}`}
                              checked={selected.has(row.routeId)}
                              onChange={() => toggle(row.routeId)}
                            />
                          ) : (
                            <span className="dim" title="Not proposed for closure">—</span>
                          )}
                        </td>
                        <td>
                          <a href={`/demand/opportunity/${row.routeId}`}>{row.organisation}</a>
                          <div className="dim">{row.headline}</div>
                        </td>
                        <td className="tiny dim">{row.playbookKey}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <Badge tone={TONE[row.verdict]}>{LABEL[row.verdict]}</Badge>
                        </td>
                        <td className="tiny">
                          {row.because}
                          <div className="dim">{row.proposedAction}</div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
