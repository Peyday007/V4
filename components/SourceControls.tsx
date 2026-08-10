'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Enable, disable and test-run a data source.
 *
 * The test is the important one. "The key is set" and "leads are arriving" are
 * different claims, and only a real run against the live API distinguishes
 * them — so the button reports a record count, not a green tick.
 */

export type SourceRow = {
  id: string;
  name: string;
  connector: string;
  isLive: boolean;
  isEnabled: boolean;
  credentialEnvVar: string | null;
  credentialPresent: boolean;
  rateLimitPerMin: number;
  lastRunStatus: string | null;
  lastRecordCount: number | null;
  consecutiveFailures: number;
};

type TestResult = {
  market?: string | null;
  fetched?: number;
  signalsCreated?: number;
  signalsDuplicate?: number;
  companiesCreated?: number;
  errors?: string[];
};

export function SourceControls({ source }: { source: SourceRow }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);

  async function run(action: 'enable' | 'disable' | 'test') {
    setBusy(action);
    setError(null);
    setResult(null);
    try {
      const response = await fetch('/api/admin/sources', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceId: source.id, action }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? 'Request failed');
      if (action === 'test') setResult(payload as TestResult);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Request failed');
    } finally {
      setBusy(null);
    }
  }

  const blocked = source.isLive && source.credentialEnvVar !== null && !source.credentialPresent;

  return (
    <div>
      <div className="row">
        {source.isEnabled ? (
          <button className="sm" onClick={() => run('disable')} disabled={busy !== null}>
            {busy === 'disable' ? '…' : 'Disable'}
          </button>
        ) : (
          <button className="sm primary" onClick={() => run('enable')} disabled={busy !== null || blocked}>
            {busy === 'enable' ? '…' : 'Enable'}
          </button>
        )}
        {source.isLive && (
          <button className="sm" onClick={() => run('test')} disabled={busy !== null || blocked}>
            {busy === 'test' ? 'Running…' : 'Test run'}
          </button>
        )}
      </div>

      {blocked && (
        <div className="tiny" style={{ color: 'var(--warning)', marginTop: '0.3rem' }}>
          Needs <span className="mono">{source.credentialEnvVar}</span> in the environment. Add it and redeploy.
        </div>
      )}

      {error && (
        <div className="alert danger tiny" style={{ marginTop: '0.35rem' }}>
          {error}
        </div>
      )}

      {result && (
        <div
          className={`alert tiny ${result.errors && result.errors.length > 0 ? 'warning' : result.fetched ? 'success' : 'info'}`}
          style={{ marginTop: '0.35rem' }}
        >
          {result.fetched === 0 && (!result.errors || result.errors.length === 0) ? (
            <>
              Reached the source, got 0 records. Not necessarily broken — a narrow market on a quiet week looks like
              this — but check the market covers somewhere with activity.
            </>
          ) : (
            <>
              {result.fetched} record(s) from {result.market ?? 'no market'} → {result.signalsCreated} new lead(s),{' '}
              {result.signalsDuplicate} already known, {result.companiesCreated} new companies.
            </>
          )}
          {result.errors?.map((e) => (
            <div key={e} className="mono" style={{ marginTop: '0.25rem' }}>
              {e}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Re-reads connector definitions and reports which credentials are still missing. */
export function ReinstallSources() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/admin/sources', { method: 'PUT' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? 'Failed');
      const missing: string[] = payload.disabledMissingCredential ?? [];
      setMessage(
        missing.length > 0
          ? `Refreshed. Still missing credentials: ${missing.join(', ')}.`
          : 'Refreshed. Every live source has its credential.',
      );
      router.refresh();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="sm" onClick={run} disabled={busy}>
        {busy ? 'Refreshing…' : 'Refresh sources'}
      </button>
      {message && <div className="tiny dim mt">{message}</div>}
    </>
  );
}
