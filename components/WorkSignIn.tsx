'use client';

import { useState } from 'react';

/**
 * Caller sign-in: one field.
 *
 * A caller arriving for a shift has a number on a card. They have no reason to
 * remember which of an operator's email conventions their account was created
 * under, and the email box was one more thing to get wrong before the first
 * call of the day.
 *
 * What makes one field safe is not on this screen. The PIN is ten digits and
 * unique across the organisation — enforced by the database, so a match is
 * never ambiguous — and attempts are counted per source and in total, because
 * without an identifier there is no account to lock and a per-caller lockout
 * cannot see somebody walking the number space. See lib/caller/pinLookup.
 */
export function WorkSignIn() {
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
        body: JSON.stringify({ pin }),
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
      <p className="small muted">Enter your PIN. It is yours, not the team&rsquo;s.</p>
      <form onSubmit={submit}>
        <label className="field">
          <span className="tiny dim">PIN</span>
          <input
            className="input"
            type="password"
            inputMode="numeric"
            // "one-time-code" rather than "current-password": there is no
            // username beside it, so a password manager offering to fill a
            // saved pair here has nothing to match on and gets it wrong.
            autoComplete="one-time-code"
            data-testid="pin"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            required
            autoFocus
          />
        </label>
        {error && <div className="alert danger small mt" data-testid="signin-error">{error}</div>}
        <button className="btn mt" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Start work'}
        </button>
      </form>
    </div>
  );
}
