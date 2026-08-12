'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Badge } from './ui';

/**
 * What contact resolution is doing, for the person who has to answer "why is
 * Research needed still full".
 *
 * The six terminal states are shown separately because they call for six
 * different responses, and two of them are ours to fix rather than the
 * operator's: a provider outage and a missing key both look exactly like "this
 * business has no phone number" if they are not named. Every one of these
 * numbers comes from a stored result — there is no path through the worker that
 * ends without writing one.
 */

type Overview = {
  waiting: number;
  inProgress: number;
  resolved: number;
  ambiguous: number;
  unresolved: number;
  failed: number;
  stale: number;
  untracked: number;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  sourcesAttempted: Array<{ source: string; label: string; accounts: number }>;
  newlyCallable: number;
  recentlyReleased: Array<{ organisation: string; resolvedAt: string; routes: number; confidence: string | null }>;
  configurationProblems: Array<{ source: string; reason: string; fix: string; accounts: number }>;
  topBlockers: Array<{ blocker: string; accounts: number; status: string }>;
};

function when(iso: string | null): string {
  if (!iso) return 'never';
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 0) return `in ${Math.abs(minutes) < 60 ? `${Math.abs(minutes)}m` : `${Math.round(Math.abs(minutes) / 60)}h`}`;
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

export function EnrichmentPanel({ overview }: { overview: Overview }) {
  const [state, setState] = useState(overview);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function retryAll() {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch('/api/demand/enrichment', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ allBlocked: true }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error ?? `Request failed (${response.status})`);
      setNotice(
        `Tried ${result.attempted}: ${result.resolved} resolved, ${result.ambiguous} ambiguous, ` +
          `${result.unresolved} with nothing published, ${result.failed} failed. ${result.released} route(s) now callable.`,
      );
      if (result.overview) setState(result.overview);
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  const tiles: Array<{ label: string; value: number; tone?: string; hint: string }> = [
    { label: 'Waiting', value: state.waiting, hint: 'Scheduled, not yet attempted.' },
    { label: 'In progress', value: state.inProgress, tone: 'accent', hint: 'Being looked up now.' },
    { label: 'Resolved', value: state.resolved, tone: 'success', hint: 'A contact route was found and written.' },
    { label: 'Ambiguous', value: state.ambiguous, tone: 'warning', hint: 'Competing candidates. Needs a person.' },
    { label: 'Nothing published', value: state.unresolved, hint: 'Searched everywhere available; no contact exists to find.' },
    { label: 'Failed', value: state.failed, tone: 'danger', hint: 'Our lookup broke. Not a finding about the business.' },
    { label: 'Stale', value: state.stale, tone: 'warning', hint: 'Past the age its source can be relied on. Being re-checked.' },
    { label: 'Not scheduled', value: state.untracked, tone: state.untracked > 0 ? 'danger' : '', hint: 'Live demand with no resolution row. Should be zero.' },
  ];

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0 }}>Contact resolution</h2>
          <p className="small muted" style={{ maxWidth: '46rem' }}>
            Automatic. Every organisation behind a live opportunity is scheduled the moment its event is routed, worked in
            priority order — live demand first, then the closest buying window — and retried on a schedule chosen from why
            it did not settle. Nothing below needs a person to start it.
          </p>
        </div>
        <button className="btn secondary" disabled={busy} onClick={retryAll}>
          {busy ? 'Working…' : 'Retry everything blocked'}
        </button>
      </div>

      {notice && <div className="alert small">{notice}</div>}

      <div className="grid grid-4 mt">
        {tiles.map((tile) => (
          <div key={tile.label} className="stat">
            <div className="stat-label">{tile.label}</div>
            <div className="stat-value" style={{ fontSize: '1.4rem' }}>{tile.value}</div>
            <div className="tiny dim">{tile.hint}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-2 mt">
        <div>
          <div className="tiny dim">Timing</div>
          <div className="tiny muted" style={{ lineHeight: 1.7 }}>
            Last attempt: <strong>{when(state.lastAttemptAt)}</strong>
            <br />
            Next scheduled retry: <strong>{when(state.nextRetryAt)}</strong>
            <br />
            Routes released into Call now in the last day: <strong>{state.newlyCallable}</strong>
          </div>

          <div className="tiny dim mt">Sources attempted</div>
          {state.sourcesAttempted.length === 0 ? (
            <div className="tiny dim">Nothing consulted yet.</div>
          ) : (
            <ul className="list-reset tiny muted" style={{ lineHeight: 1.6 }}>
              {state.sourcesAttempted.map((s) => (
                <li key={s.source}>· {s.label} — {s.accounts} organisation(s)</li>
              ))}
            </ul>
          )}
        </div>

        <div>
          {state.configurationProblems.length > 0 && (
            <>
              <div className="tiny dim">Configuration stopping automatic enrichment</div>
              {state.configurationProblems.map((problem) => (
                <div key={problem.source} className="alert warning tiny">
                  <strong>{problem.source}</strong> — {problem.reason}
                  <br />
                  {problem.fix}
                </div>
              ))}
            </>
          )}

          <div className="tiny dim">Why records are still blocked</div>
          {state.topBlockers.length === 0 ? (
            <div className="tiny dim">Nothing blocked.</div>
          ) : (
            <ul className="list-reset tiny muted" style={{ lineHeight: 1.6 }}>
              {state.topBlockers.map((b) => (
                <li key={`${b.status}:${b.blocker}`} style={{ marginBottom: '0.3rem' }}>
                  <Badge tone={b.status === 'FAILED' ? 'danger' : b.status === 'AMBIGUOUS' ? 'warning' : ''}>
                    {b.accounts}
                  </Badge>{' '}
                  {b.blocker}
                </li>
              ))}
            </ul>
          )}

          {state.recentlyReleased.length > 0 && (
            <>
              <div className="tiny dim mt">Released into Call now</div>
              <ul className="list-reset tiny muted" style={{ lineHeight: 1.6 }}>
                {state.recentlyReleased.slice(0, 8).map((r) => (
                  <li key={r.organisation}>
                    · {r.organisation} — {r.routes} route(s), {String(r.confidence ?? 'unknown').toLowerCase()}
                  </li>
                ))}
              </ul>
              <Link href="/demand?view=call_now" className="btn tiny mt">Open Call now</Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
