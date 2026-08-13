'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Badge, Empty } from './ui';

/**
 * The calling floor, as something an owner acts on.
 *
 * The table this replaces listed every user in the organisation with two
 * buttons — "Issue PIN" and "Assign 25" — and no way to create a caller, take
 * access away, or see what was about to be handed over. It was a report with
 * controls bolted on.
 *
 * The order here is the order of the questions an owner actually asks at nine
 * in the morning: is anything broken, is there work, who is on, and what is
 * each of them holding. Everything destructive says what it will do before it
 * does it, and the assignment path shows the records before it commits them.
 */

type Caller = {
  callerId: string;
  name: string;
  email: string;
  isActive: boolean;
  mode: 'PRODUCTION' | 'TEST';
  label: string | null;
  timezone: string;
  pin: {
    status: 'NONE' | 'ACTIVE' | 'LOCKED' | 'REVOKED';
    issuedAt: string | null;
    issuedBy: string | null;
    lastUsedAt: string | null;
    lockedUntil: string | null;
  };
  openPackets: number;
  waiting: number;
  workedToday: number;
  overdueCallbacks: number;
  lastAttemptAt: string | null;
  lastSignInAt: string | null;
  openIncidents: number;
  restrictions: number;
};

type Bucket = { key: string; label: string; because: string; count: number };

type Preview = {
  callerId: string;
  callerName: string;
  mode: 'PRODUCTION' | 'TEST';
  requested: number;
  routeIds: string[];
  rows: Array<{
    routeId: string; organisation: string; headline: string;
    tier: string; route: string; stateCode: string | null; capability: string | null;
  }>;
  excluded: Array<{ bucket: string; label: string; because: string; count: number }>;
  mix: { tier: Record<string, number>; route: Record<string, number>; state: Record<string, number> };
  versions: { script: string | null; process: string | null; offer: string | null };
  shortfall: string | null;
};

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

const PIN_TONE: Record<Caller['pin']['status'], string | undefined> = {
  ACTIVE: 'success', NONE: undefined, LOCKED: 'warning', REVOKED: 'danger',
};

const PIN_WORDS: Record<Caller['pin']['status'], string> = {
  ACTIVE: 'PIN active', NONE: 'no PIN yet', LOCKED: 'locked out', REVOKED: 'access revoked',
};

export function CallerFloor({
  callers,
  buckets,
  callableUnassigned,
  sandbox,
  canManageUsers,
  canAssign,
}: {
  callers: Caller[];
  buckets: Bucket[];
  callableUnassigned: number;
  sandbox: { companies: number; routes: number; callers: number; waiting: number };
  canManageUsers: boolean;
  canAssign: boolean;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ name: string; pin: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [addMode, setAddMode] = useState<'PRODUCTION' | 'TEST'>('PRODUCTION');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [size, setSize] = useState(25);
  const [showInactive, setShowInactive] = useState(false);

  const production = callers.filter((c) => c.mode === 'PRODUCTION' && c.isActive);
  const test = callers.filter((c) => c.mode === 'TEST' && c.isActive);
  const inactive = callers.filter((c) => !c.isActive);
  const blocked = callers.filter((c) => c.isActive && (c.openIncidents > 0 || c.restrictions > 0));
  const waiting = callers.reduce((sum, c) => sum + c.waiting, 0);
  const callbacks = callers.reduce((sum, c) => sum + c.overdueCallbacks, 0);

  async function call(body: Record<string, unknown>, key: string): Promise<Record<string, unknown> | null> {
    setBusy(key); setError(null); setNotice(null);
    try {
      const response = await fetch('/api/callers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) { setError(payload?.error ?? 'That did not work.'); return null; }
      return payload;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function addCaller(form: FormData) {
    const payload = await call({
      action: 'create',
      name: String(form.get('name') ?? ''),
      email: String(form.get('email') ?? ''),
      mode: addMode,
      timezone: String(form.get('timezone') ?? 'America/New_York'),
      label: String(form.get('label') ?? '') || null,
    }, 'create');
    if (payload) {
      setShowAdd(false);
      setNotice(`${form.get('name')} added. They cannot sign in until you issue a PIN.`);
      window.location.reload();
    }
  }

  async function issuePin(caller: Caller) {
    const payload = await call({ action: 'issue_pin', callerId: caller.callerId }, caller.callerId);
    if (payload) { setIssued({ name: caller.name, pin: String(payload.pin) }); setCopied(false); }
  }

  async function runPreview(caller: Caller) {
    const payload = await call(
      { action: 'preview_assignment', callerId: caller.callerId, requested: size },
      caller.callerId,
    );
    if (payload) setPreview(payload.preview as Preview);
  }

  async function confirm() {
    if (!preview) return;
    const payload = await call({
      action: 'assign', callerId: preview.callerId, routeIds: preview.routeIds,
    }, preview.callerId);
    if (payload) {
      const plan = payload.plan as { items: number };
      setPreview(null);
      setNotice(`Assigned ${plan.items} to ${preview.callerName}.`);
      window.location.reload();
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Calling floor</h1>
          <p>
            Who is on, what they are holding, and what is actually callable right now.
          </p>
        </div>
        <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
          <Link href="/work" className="btn" data-testid="open-workspace">Open caller workspace</Link>
          <Link href="/callers/preview" className="btn secondary" data-testid="preview-workspace">
            Preview as test caller
          </Link>
          {canManageUsers && (
            <button className="btn" data-testid="add-caller" onClick={() => { setAddMode('PRODUCTION'); setShowAdd(true); }}>
              Add caller
            </button>
          )}
        </div>
      </div>

      {error && <div className="alert danger small" data-testid="error">{error}</div>}
      {notice && <div className="alert small" data-testid="notice">{notice}</div>}

      {/* --- the PIN, shown exactly once ---------------------------------- */}
      {issued && (
        <div className="alert warning" data-testid="issued-pin">
          <strong>{issued.name}&rsquo;s PIN is <code data-testid="pin-value">{issued.pin}</code></strong>
          <div className="row" style={{ gap: '0.4rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
            <button
              className="btn tiny"
              data-testid="copy-pin"
              onClick={() => {
                void navigator.clipboard?.writeText(issued.pin);
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : 'Copy PIN'}
            </button>
            <button className="btn secondary tiny" onClick={() => setIssued(null)}>Done</button>
          </div>
          <div className="tiny mt">
            Give it to them now. Nobody can read it again — not you, not an administrator, not the database.
            If it is lost, issue a new one; the old one stops working the moment you do.
          </div>
        </div>
      )}

      {/* --- the floor at a glance ---------------------------------------- */}
      <div className="card" data-testid="floor-summary">
        <div className="row" style={{ flexWrap: 'wrap', gap: '1.5rem' }}>
          <Stat label="Active callers" value={production.length} />
          <Stat label="Test callers" value={test.length} />
          <Stat label="Callable now, unassigned" value={callableUnassigned} testid="callable-unassigned" />
          <Stat label="Waiting in packets" value={waiting} />
          <Stat label="Callbacks due" value={callbacks} tone={callbacks > 0 ? 'warning' : undefined} />
          <Stat label="Blocked callers" value={blocked.length} tone={blocked.length > 0 ? 'danger' : undefined} />
        </div>

        {/* The exclusions, in full. An owner who sees a small callable number
            is owed the reason rather than left to assume the engine is dry. */}
        <details data-testid="eligibility-breakdown" style={{ marginTop: '0.75rem' }}>
          <summary className="small">Why is that the number?</summary>
          <table className="table tiny" style={{ marginTop: '0.5rem' }}>
            <thead><tr><th>State</th><th style={{ textAlign: 'right' }}>Records</th><th>What it means</th></tr></thead>
            <tbody>
              {buckets.map((b) => (
                <tr key={b.key} data-testid="bucket-row">
                  <td><strong>{b.label}</strong></td>
                  <td style={{ textAlign: 'right' }} data-testid={`bucket-${b.key}`}>{b.count}</td>
                  <td className="dim">{b.because}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="tiny dim">
            One definition, used by this page, the demand board, the assignment preview and the caller workspace.
            A record having a route does not make it callable.
          </p>
        </details>
      </div>

      {/* --- add a caller -------------------------------------------------- */}
      {showAdd && canManageUsers && (
        <div className="card" data-testid="add-caller-form">
          <h2 style={{ marginTop: 0 }}>{addMode === 'TEST' ? 'New test caller' : 'New caller'}</h2>
          <p className="small muted">
            {addMode === 'TEST'
              ? 'A test caller only ever sees sandbox opportunities. They cannot be handed real work, and nothing they do reaches production numbers.'
              : 'A new login and a caller profile. Existing owner, manager, finance and research accounts are never converted into callers.'}
          </p>
          <form action={addCaller}>
            <div className="row" style={{ gap: '0.6rem', flexWrap: 'wrap' }}>
              <label className="tiny">Name<br /><input className="input" name="name" required minLength={2} data-testid="new-name" /></label>
              <label className="tiny">Sign-in email<br /><input className="input" name="email" type="email" required data-testid="new-email" /></label>
              <label className="tiny">Timezone<br /><input className="input" name="timezone" defaultValue="America/New_York" /></label>
              <label className="tiny">Note (optional)<br /><input className="input" name="label" placeholder="Evening shift" /></label>
            </div>
            <div className="row" style={{ gap: '0.4rem', marginTop: '0.6rem' }}>
              <button className="btn" type="submit" disabled={busy === 'create'} data-testid="save-caller">
                {busy === 'create' ? 'Creating…' : 'Create caller'}
              </button>
              <button className="btn secondary" type="button" onClick={() => setShowAdd(false)}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      {/* --- assignment preview -------------------------------------------- */}
      {preview && (
        <div className="card" data-testid="assignment-preview">
          <h2 style={{ marginTop: 0 }}>
            About to assign {preview.rows.length} to {preview.callerName}
            {preview.mode === 'TEST' && <> <Badge tone="warning">TEST</Badge></>}
          </h2>
          {preview.shortfall && <div className="alert small" data-testid="shortfall">{preview.shortfall}</div>}

          {preview.rows.length === 0 ? (
            <Empty>Nothing is callable for this caller right now. The reasons are listed below.</Empty>
          ) : (
            <table className="table tiny">
              <thead><tr><th>Organisation</th><th>Why</th><th>Tier</th><th>Route</th><th>State</th></tr></thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.routeId} data-testid="preview-row">
                    <td>{r.organisation}</td>
                    <td className="dim">{r.headline}</td>
                    <td>{r.tier.toLowerCase().replace(/_/g, ' ')}</td>
                    <td>{r.route.toLowerCase()}</td>
                    <td>{r.stateCode ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {preview.excluded.length > 0 && (
            <details data-testid="preview-exclusions">
              <summary className="small">What was left out, and why</summary>
              <ul className="tiny">
                {preview.excluded.map((x) => (
                  <li key={x.bucket}><strong>{x.count} — {x.label}.</strong> {x.because}</li>
                ))}
              </ul>
            </details>
          )}

          <p className="tiny dim">
            Script {preview.versions.script ?? 'unversioned'} · offer {preview.versions.offer ?? 'unversioned'}.
            Recorded on the packet so the result can be read against what was in force.
          </p>

          <div className="row" style={{ gap: '0.4rem' }}>
            <button
              className="btn"
              data-testid="confirm-assignment"
              disabled={preview.rows.length === 0 || busy === preview.callerId}
              onClick={() => void confirm()}
            >
              Assign these {preview.rows.length}
            </button>
            <button className="btn secondary" onClick={() => setPreview(null)}>Cancel — nothing assigned</button>
          </div>
        </div>
      )}

      {/* --- the callers --------------------------------------------------- */}
      <CallerList
        title="Production callers"
        callers={production}
        testid="production-callers"
        empty="Nobody is on the production floor. Add a caller to start."
        {...{ busy, canManageUsers, canAssign, size, setSize, issuePin, runPreview, call, setNotice }}
      />

      <div className="card" data-testid="sandbox-card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ margin: 0 }}>Sandbox</h2>
            <p className="small muted" style={{ marginBottom: 0 }}>
              {sandbox.routes} practice opportunit{sandbox.routes === 1 ? 'y' : 'ies'} across distribution, brokerage
              and subcontracting. Test callers cannot be handed real work, and nothing done here reaches production
              counts, measurement or the manager&rsquo;s judgements.
            </p>
          </div>
          {canManageUsers && (
            <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
              <button
                className="btn secondary tiny"
                data-testid="create-test-caller"
                onClick={() => { setAddMode('TEST'); setShowAdd(true); }}
              >
                Create test caller
              </button>
              <button
                className="btn secondary tiny"
                data-testid="sandbox-create"
                disabled={busy === 'sandbox'}
                onClick={async () => {
                  const r = await call({ action: 'sandbox_create' }, 'sandbox');
                  if (r) { setNotice('Sandbox ready.'); window.location.reload(); }
                }}
              >
                Create sandbox data
              </button>
              <button
                className="btn secondary tiny"
                data-testid="sandbox-reset"
                disabled={busy === 'sandbox'}
                onClick={async () => {
                  const r = await call({ action: 'sandbox_reset' }, 'sandbox');
                  if (r) { setNotice(String(r.message)); window.location.reload(); }
                }}
              >
                Reset sandbox
              </button>
            </div>
          )}
        </div>

        {test.length > 0 && (
          <CallerList
            title=""
            callers={test}
            testid="test-callers"
            empty=""
            {...{ busy, canManageUsers, canAssign, size, setSize, issuePin, runPreview, call, setNotice }}
          />
        )}
      </div>

      {inactive.length > 0 && (
        <div className="card" data-testid="inactive-callers">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ margin: 0 }}>Deactivated ({inactive.length})</h2>
            <button className="btn secondary tiny" onClick={() => setShowInactive(!showInactive)}>
              {showInactive ? 'Hide' : 'Show'}
            </button>
          </div>
          <p className="small muted">
            Access removed, history kept. Their calls, notes and evidence are still on the record — deactivating
            a caller never deletes what they did.
          </p>
          {showInactive && (
            <table className="table tiny">
              <thead><tr><th>Caller</th><th>Last call</th><th /></tr></thead>
              <tbody>
                {inactive.map((c) => (
                  <tr key={c.callerId}>
                    <td>{c.name}<div className="dim">{c.email}</div></td>
                    <td className="dim">{ago(c.lastAttemptAt)}</td>
                    <td>
                      {canManageUsers && (
                        <button
                          className="btn secondary tiny"
                          disabled={busy === c.callerId}
                          onClick={async () => {
                            const r = await call({ action: 'reactivate', callerId: c.callerId }, c.callerId);
                            if (r) { setNotice(String(r.message)); window.location.reload(); }
                          }}
                        >
                          Reactivate
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  );
}

function Stat({ label, value, tone, testid }: { label: string; value: number; tone?: string; testid?: string }) {
  return (
    <div>
      <div className="tiny dim">{label}</div>
      <div style={{ fontSize: '1.5rem', fontWeight: 600 }} data-testid={testid}>
        {tone ? <Badge tone={tone}>{value}</Badge> : value}
      </div>
    </div>
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function CallerList({
  title, callers, empty, testid, busy, canManageUsers, canAssign, size, setSize, issuePin, runPreview, call, setNotice,
}: any) {
  if (callers.length === 0 && empty) {
    return <div className="card"><h2 style={{ marginTop: 0 }}>{title}</h2><Empty>{empty}</Empty></div>;
  }
  if (callers.length === 0) return null;

  return (
    <div className={title ? 'card' : ''} data-testid={testid}>
      {title && (
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <label className="tiny dim">
            Packet size{' '}
            <input
              className="input" type="number" min={1} max={200} value={size}
              style={{ width: '4.5rem' }}
              onChange={(e: any) => setSize(Number(e.target.value) || 25)}
            />
          </label>
        </div>
      )}

      <div className="caller-grid">
        {callers.map((c: Caller) => (
          <div className="caller-card" key={c.callerId} data-testid="caller-card">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <strong>{c.name}</strong>
                {c.mode === 'TEST' && <> <Badge tone="warning">TEST</Badge></>}
                <div className="dim tiny">{c.email}</div>
                {c.label && <div className="dim tiny">{c.label}</div>}
              </div>
              <Badge tone={PIN_TONE[c.pin.status]}>{PIN_WORDS[c.pin.status]}</Badge>
            </div>

            <div className="row tiny" style={{ gap: '0.9rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
              <span><strong>{c.waiting}</strong> waiting</span>
              <span><strong>{c.workedToday}</strong> today</span>
              {c.overdueCallbacks > 0 && <span className="warn"><strong>{c.overdueCallbacks}</strong> callbacks due</span>}
              <span className="dim">last call {ago(c.lastAttemptAt)}</span>
              <span className="dim">signed in {ago(c.lastSignInAt)}</span>
            </div>

            {(c.openIncidents > 0 || c.restrictions > 0) && (
              <div className="alert small" style={{ marginTop: '0.5rem' }} data-testid="caller-blocker">
                {c.openIncidents > 0 && <>{c.openIncidents} unresolved system failure(s) on their work — ours, not theirs. </>}
                {c.restrictions > 0 && <>{c.restrictions} capability restriction(s) in force.</>}
              </div>
            )}

            {c.pin.status === 'ACTIVE' && c.pin.issuedAt && (
              <div className="tiny dim" style={{ marginTop: '0.35rem' }}>
                PIN issued {ago(c.pin.issuedAt)}{c.pin.issuedBy ? ` by ${c.pin.issuedBy}` : ''}. The PIN itself is not stored.
              </div>
            )}

            <div className="row" style={{ gap: '0.3rem', marginTop: '0.6rem', flexWrap: 'wrap' }}>
              {canAssign && (
                <button
                  className="btn tiny" disabled={busy === c.callerId}
                  data-testid="preview-assignment"
                  onClick={() => void runPreview(c)}
                >
                  Preview {size} to assign
                </button>
              )}
              {canManageUsers && (
                <>
                  <button
                    className="btn secondary tiny" disabled={busy === c.callerId}
                    data-testid="issue-pin"
                    onClick={() => void issuePin(c)}
                  >
                    {c.pin.status === 'ACTIVE' ? 'Rotate PIN' : 'Issue PIN'}
                  </button>
                  {c.pin.status === 'ACTIVE' && (
                    <button
                      className="btn secondary tiny" disabled={busy === c.callerId}
                      data-testid="revoke-pin"
                      onClick={async () => {
                        const r = await call({ action: 'revoke_pin', callerId: c.callerId }, c.callerId);
                        if (r) { setNotice(String(r.message)); window.location.reload(); }
                      }}
                    >
                      Revoke
                    </button>
                  )}
                  <button
                    className="btn secondary tiny" disabled={busy === c.callerId}
                    data-testid="deactivate"
                    onClick={async () => {
                      const r = await call({ action: 'deactivate', callerId: c.callerId }, c.callerId);
                      if (r) { setNotice(String(r.message)); window.location.reload(); }
                    }}
                  >
                    Deactivate
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
