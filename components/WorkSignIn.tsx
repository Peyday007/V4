'use client';

import { useState } from 'react';

/**
 * Caller sign-in.
 *
 * Email and PIN, not PIN alone. Six digits across a team collide, and a
 * credential that is also the identity logs somebody in as somebody else —
 * which is the shared-passphrase problem reached by a different route.
 */
export function WorkSignIn() {
  const [identifier, setIdentifier] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/work/signin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identifier, pin }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body?.error ?? 'Could not sign you in.');
        return;
      }
      window.location.href = '/work';
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ maxWidth: '24rem', margin: '4rem auto' }}>
      <h1 style={{ marginTop: 0 }}>Work</h1>
      <p className="small muted">Sign in with your own PIN. It is yours, not the team&rsquo;s.</p>
      <form onSubmit={submit}>
        <label className="field">
          <span className="tiny dim">Email</span>
          <input
            className="input"
            type="email"
            autoComplete="username"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            required
          />
        </label>
        <label className="field mt">
          <span className="tiny dim">PIN</span>
          <input
            className="input"
            type="password"
            inputMode="numeric"
            autoComplete="current-password"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            required
          />
        </label>
        {error && <div className="alert danger small mt">{error}</div>}
        <button className="btn mt" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Start work'}
        </button>
      </form>
    </div>
  );
}
