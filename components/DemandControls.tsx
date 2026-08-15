'use client';

import { useState } from 'react';
import { Badge } from './ui';

/**
 * Demand source health, and the two buttons that drive the engine by hand.
 *
 * The panel exists because "no demand found" and "the source is broken" look
 * identical from a lead count, and only one of them is a problem the operator
 * can fix. Every source reports when it last *attempted* a run separately from
 * when it last *succeeded* — a source failing every hour still has a recent
 * attempt, and reporting only that would hide a fortnight of silence.
 */

type SourceHealth = {
  connector: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  configurationNote: string;
  credentialEnvVar: string | null;
  credentialPresent: boolean;
  blockedExternally: { because: string; whatWouldUnblock: string } | null;
  eventFamilies: string[];
  pollIntervalMinutes: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastStatus: string | null;
  recordsExamined: number;
  eventsCreated: number;
  eventsUpdated: number;
  eventsRejected: number;
  error: string | null;
  nextScheduledAt: string | null;
  outcomeReason: string | null;
  funnel: Array<{
    scope: string;
    url: string | null;
    fetched: number;
    accepted: number;
    drops: Array<{ reason: string; count: number; example: string | null }>;
    failure: string | null;
  }>;
};

type FunnelStage = { stage: string; count: number };

type Scorecard = {
  connector: string;
  sourceRecords: number;
  events: number;
  verifiedLeads: number;
  quoted: number;
  won: number;
  paid: number;
  collectedGrossProfit: number;
  verdict: string;
};

export function DemandControls({
  health,
  totalEvents,
  actionable,
  funnel,
  scorecards,
}: {
  health: SourceHealth[];
  totalEvents: number;
  actionable: number;
  funnel: FunnelStage[];
  scorecards: Scorecard[];
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function post(path: string, label: string) {
    setBusy(label);
    setError(null);
    setResult(null);
    try {
      const response = await fetch(path, { method: 'POST' });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status})`);
      setResult(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  async function loadDiagnostic() {
    setBusy('diagnostic');
    setError(null);
    try {
      const response = await fetch('/api/demand/diagnostic');
      const body = await response.json();
      setDiagnostic(JSON.stringify(body, null, 2));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  const runnable = health.filter((h) => h.enabled);
  const unconfigured = health.filter((h) => !h.configured && !h.blockedExternally);
  const held = health.filter((h) => h.blockedExternally);

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div className="tiny dim">Demand sources</div>
          <div className="row mt">
            <Badge tone={runnable.length > 0 ? 'success' : 'danger'}>{runnable.length} running</Badge>
            <Badge>{totalEvents} events</Badge>
            <Badge tone={actionable > 0 ? 'success' : 'warning'}>{actionable} actionable</Badge>
          </div>
        </div>
        <div className="row">
          <button className="btn" disabled={busy !== null} onClick={() => post('/api/demand/run', 'run')}>
            {busy === 'run' ? 'Running…' : 'Run demand sources'}
          </button>
          <button className="btn secondary" disabled={busy !== null} onClick={() => loadDiagnostic()}>
            {busy === 'diagnostic' ? 'Loading…' : 'Diagnostic'}
          </button>
        </div>
      </div>

      {totalEvents === 0 && (
        <div className="alert warning small mt">
          <strong>No demand events yet.</strong> Directory sources cannot produce them — an organisation existing is
          not an event. Run the demand sources, or record something you already know about by hand.
        </div>
      )}

      <div className="table-scroll mt">
        <table className="table tiny">
          <thead>
            <tr>
              <th>Source</th>
              <th>State</th>
              <th>Last attempt</th>
              <th>Last success</th>
              <th>Examined</th>
              <th>Created</th>
              <th>Updated</th>
              <th>Rejected</th>
              <th>Next due</th>
            </tr>
          </thead>
          <tbody>
            {health.map((source) => (
              <tr key={source.connector}>
                <td>
                  <strong>{source.name}</strong>
                  <div className="dim">{source.eventFamilies.join(' · ')}</div>
                </td>
                <td>
                  <Badge
                    tone={
                      source.blockedExternally
                        ? 'warning'
                        : !source.configured
                          ? ''
                          : source.lastStatus === 'FAILED'
                            ? 'danger'
                            : source.enabled
                              ? 'success'
                              : ''
                    }
                  >
                    {source.blockedExternally
                      ? 'held'
                      : !source.configured
                        ? 'not configured'
                        : source.enabled
                          ? 'enabled'
                          : 'disabled'}
                  </Badge>
                </td>
                <td>{source.lastAttemptAt?.slice(0, 16).replace('T', ' ') ?? 'never'}</td>
                <td>{source.lastSuccessAt?.slice(0, 16).replace('T', ' ') ?? 'never'}</td>
                <td>{source.recordsExamined}</td>
                <td>{source.eventsCreated}</td>
                <td>{source.eventsUpdated}</td>
                <td>{source.eventsRejected}</td>
                <td>{source.nextScheduledAt?.slice(0, 16).replace('T', ' ') ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Where the records went — for every source, not only the ones that
          threw. A connector that fetches four hundred rows and creates no
          events raises no error at all, and it was the most common way for
          this board to be empty without anybody being able to say why. */}
      <div className="mt">
        <div className="tiny dim">Where the last run&apos;s records went</div>
        <ul className="list-reset tiny mt" style={{ lineHeight: 1.6 }} data-testid="source-outcomes">
          {health.map((s) => (
            <li key={s.connector} data-testid={`source-outcome-${s.connector}`} className="mt">
              <Badge
                tone={
                  s.blockedExternally
                    ? 'warning'
                    : !s.configured
                      ? ''
                      : s.lastStatus === 'FAILED'
                        ? 'danger'
                        : s.eventsCreated > 0
                          ? 'success'
                          : ''
                }
              >
                {s.blockedExternally
                  ? 'held'
                  : !s.configured
                    ? 'setup'
                    : s.lastStatus === 'FAILED'
                      ? 'error'
                      : s.lastStatus === 'OK'
                        ? 'ran'
                        : 'idle'}
              </Badge>{' '}
              <strong>{s.name}:</strong>{' '}
              {/* A held source keeps its diagnostic here rather than repeating
                  the same failure from its last attempt, which is the thing the
                  hold was put in place to stop. */}
              {s.blockedExternally
                ? `${s.blockedExternally.because} ${s.blockedExternally.whatWouldUnblock}`
                : s.outcomeReason ?? s.error ?? 'No run has been recorded yet.'}
              {s.funnel.length > 0 && (
                <details className="mt">
                  <summary className="dim">Per-dataset breakdown</summary>
                  <ul className="list-reset" style={{ paddingLeft: '1rem' }}>
                    {s.funnel.map((scope) => (
                      <li key={scope.scope} className="mt">
                        <strong>{scope.scope}</strong> — {scope.accepted} of {scope.fetched} row(s) kept
                        {scope.failure ? <> · failed: {scope.failure}</> : null}
                        {scope.drops.length > 0 && (
                          <ul className="list-reset dim" style={{ paddingLeft: '1rem' }}>
                            {scope.drops.map((d) => (
                              <li key={d.reason}>
                                {d.count} × {d.reason}
                                {d.example ? <> — e.g. {d.example}</> : null}
                              </li>
                            ))}
                          </ul>
                        )}
                        {scope.url && <div className="dim" style={{ wordBreak: 'break-all' }}>{scope.url}</div>}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          ))}
        </ul>
      </div>

      {unconfigured.length > 0 && (
        <div className="alert small mt">
          <strong>Optional sources not configured:</strong>{' '}
          {unconfigured.map((s) => `${s.name} (${s.credentialEnvVar})`).join(', ')}. The engine runs without them.
        </div>
      )}

      {/* Held sources are neither running nor broken, and collapsing them into
          either would be wrong. Nothing an owner types fixes one, so this is
          not a to-do list — it is the record of what this engine is not
          collecting and why, kept where it can be checked. */}
      {held.length > 0 && (
        <div className="alert warning small mt" data-testid="held-sources">
          <strong>Held, not retried:</strong>
          <ul className="list-reset mt" style={{ paddingLeft: '1rem' }}>
            {held.map((s) => (
              <li key={s.connector} data-testid={`held-source-${s.connector}`} className="mt">
                <strong>{s.name}</strong> — {s.blockedExternally!.because}{' '}
                <span className="dim">{s.blockedExternally!.whatWouldUnblock}</span>
              </li>
            ))}
          </ul>
          <div className="tiny dim mt">
            These are excluded from the recurring run so their failure stops burying sources that are genuinely
            misbehaving. Nothing elsewhere in the product claims their data.
          </div>
        </div>
      )}

      {/* The funnel, with its empty stages showing. A funnel that stops at
          "verified lead" is telling the truth about the business, and hiding
          the empty stages would make a source look better than it is. */}
      <div className="mt">
        <div className="tiny dim">Source to collected money</div>
        <div className="row tiny mt" style={{ flexWrap: 'wrap', gap: '0.4rem' }}>
          {funnel.map((stage) => (
            <span
              key={stage.stage}
              className="badge"
              style={{ opacity: stage.count === 0 ? 0.45 : 1 }}
            >
              {stage.stage.toLowerCase().replace(/_/g, ' ')}: <strong>{stage.count}</strong>
            </span>
          ))}
        </div>
      </div>

      {scorecards.length > 0 && (
        <div className="table-scroll mt">
          <table className="table tiny">
            <thead>
              <tr>
                <th>Source</th>
                <th>Records</th>
                <th>Events</th>
                <th>Leads</th>
                <th>Quoted</th>
                <th>Won</th>
                <th>Paid</th>
                <th>Collected GP</th>
                <th>Verdict</th>
              </tr>
            </thead>
            <tbody>
              {scorecards.map((s) => (
                <tr key={s.connector}>
                  <td>{s.connector}</td>
                  <td>{s.sourceRecords}</td>
                  <td>{s.events}</td>
                  <td>{s.verifiedLeads}</td>
                  <td>{s.quoted}</td>
                  <td>{s.won}</td>
                  <td>{s.paid}</td>
                  <td>${Math.round(s.collectedGrossProfit).toLocaleString()}</td>
                  <td className="dim">{s.verdict}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {error && <div className="alert danger small mt">{error}</div>}

      {result !== null && (
        <pre className="tiny mono mt" style={{ maxHeight: '22rem', overflow: 'auto' }}>
          {JSON.stringify(result, null, 2)}
        </pre>
      )}

      {diagnostic && (
        <div className="mt">
          <div className="row">
            <div className="tiny dim" style={{ flex: 1 }}>
              Read-only production diagnostic. Copy this and paste it back to get the live run diagnosed.
            </div>
            <button
              className="btn secondary tiny"
              onClick={() => {
                navigator.clipboard.writeText(diagnostic);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre className="tiny mono mt" style={{ maxHeight: '30rem', overflow: 'auto' }}>
            {diagnostic}
          </pre>
        </div>
      )}
    </div>
  );
}
