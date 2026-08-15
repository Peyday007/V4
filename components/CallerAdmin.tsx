'use client';

import { useState } from 'react';
import { Badge } from './ui';

/**
 * The owner's view of the calling floor.
 *
 * Three things, and the third is the one that is usually missing: who can sign
 * in, what work they hold, and which of them is blocked by a failure of ours.
 * A caller who has gone quiet because a save kept failing looks identical to a
 * caller who has gone quiet, right up until somebody looks at the incident.
 */

type Caller = {
  callerId: string;
  name: string;
  email: string;
  roleKey: string;
  hasPin: boolean;
  packets: number;
  waiting: number;
  worked: number;
  lastAttempt: string | null;
};

type Incident = {
  id: string;
  kind: string;
  detail: string;
  createdAt: string;
  caller: string | null;
  organisation: string | null;
};

function humanise(value: string): string {
  return value.toLowerCase().replace(/_/g, ' ');
}

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const hours = Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function CallerAdmin({
  callers,
  incidents,
  unassignedCallable,
}: {
  callers: Caller[];
  incidents: Incident[];
  unassignedCallable: number;
}) {
  const [issued, setIssued] = useState<{ name: string; pin: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [size, setSize] = useState(25);

  async function issuePin(caller: Caller) {
    setBusy(caller.callerId);
    setNotice(null);
    try {
      const response = await fetch('/api/work/pin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: caller.callerId }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error ?? 'Could not issue a PIN.');
      setIssued({ name: caller.name, pin: body.pin });
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  async function assign(caller: Caller) {
    setBusy(caller.callerId);
    setNotice(null);
    try {
      const response = await fetch('/api/work/packets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          callerId: caller.callerId,
          name: `${caller.name.split(' ')[0]} — ${new Date().toISOString().slice(0, 10)}`,
          takeCallable: size,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error ?? 'Could not assign work.');
      setNotice(
        `Assigned ${body.items} opportunit${body.items === 1 ? 'y' : 'ies'} to ${caller.name}.` +
          (body.alreadyOwned > 0
            ? ` ${body.alreadyOwned} were already being worked by somebody else and were left alone.`
            : ''),
      );
      window.location.reload();
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Callers</h1>
          <p>
            Who can sign in, what they are holding, and anything of ours that is stopping them.
            {' '}{unassignedCallable} callable opportunit{unassignedCallable === 1 ? 'y is' : 'ies are'} unassigned.
          </p>
        </div>
      </div>

      {notice && <div className="alert small">{notice}</div>}

      {/* Shown once and never again. There is no endpoint that reads it back. */}
      {issued && (
        <div className="alert warning" data-testid="roster-issued-pin">
          <strong>{issued.name}&rsquo;s new PIN is {issued.pin}</strong>
          {/* The address beside the credential. Read from the browser rather
              than configured, so it is right on a preview deployment and on a
              custom domain without a setting that would be wrong on one of
              them. A PIN alone leaves the owner reciting a URL down the phone. */}
          <div className="small mt" data-testid="roster-handover">
            Tell them: go to{' '}
            <code data-testid="roster-signin-url">
              {typeof window === 'undefined' ? '/work' : `${window.location.origin}/work`}
            </code>{' '}
            and enter <code>{issued.pin}</code>. No email address and no password — the PIN is the whole
            sign-in.
          </div>
          <div className="tiny mt">
            Give it to them now — it cannot be read again, by you or by anybody else. Re-issuing replaces it.
          </div>
          <button className="btn secondary tiny mt" onClick={() => setIssued(null)}>Done</button>
        </div>
      )}

      {incidents.length > 0 && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>System failures blocking callers</h2>
          <p className="small muted">
            Ours, not theirs. A caller with an open save failure is held out of new work and is not counted as idle.
          </p>
          <table className="table tiny">
            <thead><tr><th>When</th><th>Caller</th><th>Record</th><th>What broke</th></tr></thead>
            <tbody>
              {incidents.map((i) => (
                <tr key={i.id}>
                  <td className="dim">{ago(i.createdAt)}</td>
                  <td>{i.caller ?? '—'}</td>
                  <td>{i.organisation ?? '—'}</td>
                  <td>
                    <Badge tone="danger">{humanise(i.kind)}</Badge>
                    <div className="dim" style={{ lineHeight: 1.4 }}>{i.detail.slice(0, 160)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>The floor</h2>
          <label className="tiny dim">
            Packet size{' '}
            <input
              className="input"
              type="number"
              min={1}
              max={200}
              value={size}
              style={{ width: '5rem' }}
              onChange={(e) => setSize(Number(e.target.value) || 25)}
            />
          </label>
        </div>

        <table className="table tiny">
          <thead>
            <tr><th>Caller</th><th>Sign-in</th><th>Open packets</th><th>Waiting</th><th>Worked</th><th>Last call</th><th /></tr>
          </thead>
          <tbody>
            {callers.map((caller) => (
              <tr key={caller.callerId}>
                <td>
                  <strong>{caller.name}</strong>
                  <div className="dim">{caller.email} · {humanise(caller.roleKey)}</div>
                </td>
                <td>
                  {caller.hasPin
                    ? <Badge tone="success">PIN set</Badge>
                    : <Badge>no PIN</Badge>}
                </td>
                <td>{caller.packets}</td>
                <td>{caller.waiting}</td>
                <td>{caller.worked}</td>
                <td className="dim">{ago(caller.lastAttempt)}</td>
                <td>
                  <div className="row" style={{ gap: '0.3rem' }}>
                    <button
                      className="btn secondary tiny"
                      disabled={busy === caller.callerId}
                      onClick={() => void issuePin(caller)}
                    >
                      {caller.hasPin ? 'New PIN' : 'Issue PIN'}
                    </button>
                    <button
                      className="btn tiny"
                      disabled={busy === caller.callerId || unassignedCallable === 0}
                      onClick={() => void assign(caller)}
                      title={unassignedCallable === 0 ? 'Nothing callable is unassigned' : undefined}
                    >
                      Assign {size}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
