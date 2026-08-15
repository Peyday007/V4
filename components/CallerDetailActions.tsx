'use client';

import { useState } from 'react';

/**
 * The lifecycle controls on one caller.
 *
 * Separated from the page so the page can stay a server component and read
 * straight from the database. Every button here posts to the same authorised
 * endpoint the floor uses — there is no second, looser path just because this
 * screen is about one person.
 */
export function CallerDetailActions({
  callerId,
  name,
  isActive,
  pinStatus,
}: {
  callerId: string;
  name: string;
  isActive: boolean;
  pinStatus: 'NONE' | 'ACTIVE' | 'LOCKED' | 'REVOKED';
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pin, setPin] = useState<string | null>(null);
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  const [copiedHandover, setCopiedHandover] = useState<'idle' | 'done' | 'failed'>('idle');

  /**
   * Where the caller actually signs in.
   *
   * Read from the browser rather than configured, so it is right on a
   * preview deployment, on a custom domain, and on somebody's laptop, without
   * a setting that would be wrong on two of the three. A PIN with no address
   * beside it is a credential nobody can use, and the owner ends up guessing
   * the URL down the phone.
   */
  const signInUrl = typeof window === 'undefined' ? '/work' : `${window.location.origin}/work`;

  async function act(body: Record<string, unknown>, onOk?: (payload: Record<string, unknown>) => void) {
    setBusy(true); setError(null); setNotice(null);
    try {
      const response = await fetch('/api/callers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, callerId }),
      });
      const payload = await response.json();
      if (!response.ok) { setError(payload?.error ?? 'That did not work.'); return; }
      if (onOk) onOk(payload); else window.location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  /** Reports what actually happened. See the note on the floor's copy control. */
  async function copyPin(value: string) {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(value);
      setCopied('done');
    } catch {
      setCopied('failed');
    }
  }

  /** The address and the credential together, in the words to send. */
  async function copyHandover(url: string, value: string) {
    const message =
      `Sign in at ${url} and enter ${value}. That is the whole sign-in — no email address and no password. `
      + 'The PIN is yours alone; everything you record is attributed to you.';
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(message);
      setCopiedHandover('done');
    } catch {
      setCopiedHandover('failed');
    }
  }

  return (
    <div className="card" data-testid="detail-actions">
      <h2 style={{ marginTop: 0 }}>Access and status</h2>

      {error && <div className="alert danger small" data-testid="detail-error">{error}</div>}
      {notice && <div className="alert small" data-testid="detail-notice">{notice}</div>}

      {pin && (
        <div className="alert warning" data-testid="detail-pin">
          <strong>{name}&rsquo;s PIN is <code data-testid="detail-pin-value">{pin}</code></strong>
          <div className="row" style={{ gap: '0.4rem', marginTop: '0.5rem' }}>
            <button
              className="btn tiny"
              data-testid="detail-copy-pin"
              onClick={() => void copyPin(pin)}
            >
              {copied === 'done' ? 'Copied' : copied === 'failed' ? 'Copy it by hand' : 'Copy PIN'}
            </button>
            <button className="btn secondary tiny" onClick={() => { setPin(null); window.location.reload(); }}>Done</button>
          </div>
          {copied === 'failed' && (
            <div className="tiny mt warn" data-testid="detail-copy-pin-failed">
              The browser refused clipboard access, so nothing was copied. Read the PIN above and pass it on
              yourself.
            </div>
          )}
          <div className="tiny mt">
            Hand it over now. It cannot be read again by anybody, including you. Rotating replaces it and the old
            one stops working immediately.
          </div>

          {/* The address, beside the credential. A PIN on its own leaves the
              owner reciting a URL down the phone and getting it wrong. */}
          <div className="mt" data-testid="detail-handover">
            <div className="tiny dim">Everything {name} needs</div>
            <div className="small">
              Go to <code data-testid="detail-signin-url">{signInUrl}</code> and enter{' '}
              <code>{pin}</code>. No email address, no password — the PIN is the whole sign-in.
            </div>
            <button
              className="btn tiny mt"
              data-testid="detail-copy-handover"
              onClick={() => void copyHandover(signInUrl, pin)}
            >
              {copiedHandover === 'done'
                ? 'Copied'
                : copiedHandover === 'failed'
                  ? 'Copy it by hand'
                  : 'Copy the whole message'}
            </button>
            {copiedHandover === 'failed' && (
              <div className="tiny mt warn" data-testid="detail-copy-handover-failed">
                The browser refused clipboard access, so nothing was copied. Read it out yourself.
              </div>
            )}
          </div>
        </div>
      )}

      <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
        <button
          className="btn" disabled={busy || !isActive}
          data-testid="detail-issue-pin"
          title={isActive ? undefined : 'Reactivate them first'}
          onClick={() => void act({ action: 'issue_pin' }, (p) => { setPin(String(p.pin)); setCopied('idle'); })}
        >
          {pinStatus === 'ACTIVE' ? 'Rotate PIN' : 'Issue PIN'}
        </button>

        {pinStatus === 'ACTIVE' && (
          <button
            className="btn secondary" disabled={busy}
            data-testid="detail-revoke-pin"
            onClick={() => void act({ action: 'revoke_pin' })}
          >
            Revoke PIN
          </button>
        )}

        {isActive ? (
          <button
            className="btn secondary" disabled={busy}
            data-testid="detail-deactivate"
            onClick={() => void act({ action: 'deactivate', reason: 'Deactivated from the caller screen.' })}
          >
            Deactivate
          </button>
        ) : (
          <button
            className="btn secondary" disabled={busy}
            data-testid="detail-reactivate"
            onClick={() => void act({ action: 'reactivate' })}
          >
            Reactivate
          </button>
        )}
      </div>

      <p className="tiny dim" style={{ marginBottom: 0 }}>
        Deactivating revokes access and returns any unworked opportunities to the pool. It never deletes the
        person: their calls, notes, evidence and audit history stay exactly where they are, because a deal that
        goes wrong six months from now has to remain explainable.
      </p>
    </div>
  );
}
