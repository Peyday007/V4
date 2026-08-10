'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * "Is discovery working?" answered in one line.
 *
 * Source health was only visible as a stored status string per row, which is
 * stale until something re-runs — so redeploying and reloading showed the same
 * error indefinitely and looked like nothing had changed. This states the
 * answer plainly and gives one button that actually re-runs everything.
 */

export type SourceStatus = {
  id: string;
  name: string;
  isEnabled: boolean;
  credentialMissing: boolean;
  lastRunAt: string | null;
  lastRecordCount: number | null;
  lastRunStatus: string | null;
  consecutiveFailures: number;
};

type RunResult = {
  ranAt: string;
  totals: { fetched: number; created: number; duplicate: number };
  sources: Array<{ name: string; fetched: number; created: number; error: string | null; skipped: boolean }>;
};

export function DiscoveryStatus({ sources, liveLeads }: { sources: SourceStatus[]; liveLeads: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const enabled = sources.filter((s) => s.isEnabled);
  const working = enabled.filter((s) => s.lastRunAt && s.consecutiveFailures === 0 && (s.lastRecordCount ?? 0) > 0);
  const failing = enabled.filter((s) => s.consecutiveFailures > 0);
  const untested = enabled.filter((s) => !s.lastRunAt);
  const emptyButOk = enabled.filter((s) => s.lastRunAt && s.consecutiveFailures === 0 && (s.lastRecordCount ?? 0) === 0);

  const verdict =
    liveLeads > 0 && working.length > 0
      ? { tone: 'success', text: `Working. ${liveLeads} live lead(s) from ${working.length} of ${enabled.length} source(s).` }
      : liveLeads > 0
        ? { tone: 'warning', text: `${liveLeads} live lead(s) found, but no source succeeded on its last run.` }
        : failing.length === enabled.length && enabled.length > 0
          ? { tone: 'danger', text: 'Not working. Every enabled source failed its last run.' }
          : { tone: 'info', text: 'No live leads yet. Run the sources to find out where it stands.' };

  async function runAll() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch('/api/discovery/run-live', { method: 'POST' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? 'Run failed');
      setResult(payload as RunResult);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Run failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card-title">
        <h2>Discovery status</h2>
        <button className="primary" onClick={runAll} disabled={busy}>
          {busy ? 'Running…' : 'Run all live sources'}
        </button>
      </div>

      <div className={`alert ${verdict.tone} small`}>{verdict.text}</div>

      <p className="tiny dim">
        Deploying does not re-run anything — the status below is from the last actual run. Press the button above to
        re-check.
      </p>

      {error && <div className="alert danger small">{error}</div>}

      {result && (
        <div className="alert info small">
          <strong>Just ran:</strong> {result.totals.fetched} record(s) fetched, {result.totals.created} new lead(s),{' '}
          {result.totals.duplicate} already known.
          <ul className="list-reset tiny" style={{ marginTop: '0.4rem', lineHeight: 1.6 }}>
            {result.sources.map((s) => (
              <li key={s.name}>
                <strong>{s.name}:</strong>{' '}
                {s.error ? (
                  <span style={{ color: s.skipped ? 'var(--text-muted)' : 'var(--danger)' }}>{s.error}</span>
                ) : (
                  `${s.fetched} record(s), ${s.created} new`
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="table-wrap mt">
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>State</th>
              <th>Last run</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((source) => (
              <tr key={source.id}>
                <td className="small">{source.name}</td>
                <td>
                  {!source.isEnabled ? (
                    <span className="badge">off</span>
                  ) : source.credentialMissing ? (
                    <span className="badge warning">no key</span>
                  ) : source.consecutiveFailures > 0 ? (
                    <span className="badge danger">failing</span>
                  ) : !source.lastRunAt ? (
                    <span className="badge">not run</span>
                  ) : (source.lastRecordCount ?? 0) > 0 ? (
                    <span className="badge success">working</span>
                  ) : (
                    <span className="badge warning">no results</span>
                  )}
                </td>
                <td className="tiny dim">
                  {source.lastRunAt ? new Date(source.lastRunAt).toLocaleString() : 'never'}
                  {source.lastRecordCount !== null && ` · ${source.lastRecordCount} record(s)`}
                  {source.lastRunStatus && source.lastRunStatus !== 'ok' && (
                    <div className="mono" style={{ color: 'var(--warning)' }}>
                      {source.lastRunStatus.slice(0, 160)}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(untested.length > 0 || emptyButOk.length > 0) && (
        <div className="tiny dim mt">
          A source that reached its API and returned nothing is not necessarily broken — a narrow market on a quiet
          week looks the same. A failing one always names its reason above.
        </div>
      )}
    </div>
  );
}
