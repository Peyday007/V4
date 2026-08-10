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

type AuditResult = {
  signalsExamined: number;
  companiesBefore: number;
  companiesAfter: number;
  companiesMerged: number;
  hypothesesCreated: number;
  intentEventsFound: number;
  stageCounts: Record<string, number>;
  rows: Array<{
    company: string;
    cityState: string;
    before: { duplicateCards: number; score: number };
    after: { stage: string; accountFit: number; intent: number; contactability: number; priority: number; paths: string[]; missing: string[] };
  }>;
};

type RunResult = {
  ranAt: string;
  totals: { fetched: number; created: number; duplicate: number };
  sources: Array<{ name: string; fetched: number; created: number; error: string | null; skipped: boolean }>;
};

function humanStage(value: string): string {
  return value.toLowerCase().replace(/_/g, ' ');
}

export function DiscoveryStatus({ sources, liveLeads }: { sources: SourceStatus[]; liveLeads: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [audit, setAudit] = useState<AuditResult | null>(null);

  const enabled = sources.filter((s) => s.isEnabled);
  const working = enabled.filter((s) => s.lastRunAt && s.consecutiveFailures === 0 && (s.lastRecordCount ?? 0) > 0);
  const failing = enabled.filter((s) => s.consecutiveFailures > 0);
  const unconfigured = enabled.filter((s) => s.lastRunStatus?.startsWith('not configured'));
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
    setBusy('run');
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
      setBusy(null);
    }
  }

  /**
   * Re-derives accounts, hypotheses and scores from records already ingested.
   * Separate from a run because it fetches nothing — it corrects how what we
   * already hold is classified.
   */
  async function reclassifyAll() {
    setBusy('reclassify');
    setError(null);
    setAudit(null);
    try {
      const response = await fetch('/api/discovery/reclassify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dryRun: false }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? 'Reclassify failed');
      setAudit(payload as AuditResult);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Reclassify failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card">
      <div className="card-title">
        <h2>Discovery status</h2>
        <div className="row">
          <button onClick={reclassifyAll} disabled={busy !== null}>
            {busy === 'reclassify' ? 'Reclassifying…' : 'Re-audit existing records'}
          </button>
          <button className="primary" onClick={runAll} disabled={busy !== null}>
            {busy === 'run' ? 'Running…' : 'Run all live sources'}
          </button>
        </div>
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

      {audit && (
        <div className="alert info small">
          <strong>Re-audit:</strong> {audit.signalsExamined} record(s) examined · {audit.companiesBefore} company rows →{' '}
          {audit.companiesAfter} accounts ({audit.companiesMerged} merged) · {audit.hypothesesCreated} path hypothesis(es) ·{' '}
          {audit.intentEventsFound} intent event(s) found.
          <div className="tiny mt">
            Stages: {Object.entries(audit.stageCounts).map(([k, v]) => `${humanStage(k)} ${v}`).join(' · ')}
          </div>
          <div className="table-wrap mt">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>City, state</th>
                  <th>Was</th>
                  <th>Stage</th>
                  <th>Fit</th>
                  <th>Intent</th>
                  <th>Contact</th>
                  <th>Priority</th>
                  <th>Missing to qualify</th>
                </tr>
              </thead>
              <tbody>
                {audit.rows.map((row) => (
                  <tr key={row.company + row.cityState}>
                    <td className="small">{row.company}</td>
                    <td className="tiny">{row.cityState}</td>
                    <td className="tiny dim">{row.before.score}</td>
                    <td className="tiny">{humanStage(row.after.stage)}</td>
                    <td className="tiny">{row.after.accountFit}</td>
                    <td className="tiny" style={{ color: row.after.intent === 0 ? 'var(--text-dim)' : 'var(--success)' }}>
                      {row.after.intent}
                    </td>
                    <td className="tiny">{row.after.contactability}</td>
                    <td className="tiny">{row.after.priority}</td>
                    <td className="tiny dim">{row.after.missing.join('; ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
                  ) : source.lastRunStatus?.startsWith('not configured') ? (
                    <span className="badge">not set up</span>
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
                      {source.lastRunStatus.slice(0, 400)}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {unconfigured.length > 0 && (
        <div className="tiny dim mt">
          {unconfigured.length} source(s) have nothing configured for the markets they were pointed at. That is setup
          left undone, not a fault — the source works wherever it has been given a portal or dataset.
        </div>
      )}

      {(untested.length > 0 || emptyButOk.length > 0) && (
        <div className="tiny dim mt">
          A source that reached its API and returned nothing is not necessarily broken — a narrow market on a quiet
          week looks the same. A failing one always names its reason above.
        </div>
      )}
    </div>
  );
}
