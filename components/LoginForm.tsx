'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

const DEMO_ACCOUNTS = [
  { email: 'owner@dealdispatch.test', label: 'Owner — full access' },
  { email: 'manager@dealdispatch.test', label: 'Deal Manager — approvals & pipeline' },
  { email: 'dana@dealdispatch.test', label: 'Caller — assigned calls only' },
  { email: 'research@dealdispatch.test', label: 'Research Reviewer — signals' },
  { email: 'finance@dealdispatch.test', label: 'Finance & Compliance' },
  { email: 'admin@dealdispatch.test', label: 'Administrator — configuration' },
];

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('owner@dealdispatch.test');
  const [password, setPassword] = useState('demo-password-123');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Sign in failed');
      router.push(body.redirectTo ?? '/');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Sign in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </div>
      {error && <div className="alert danger">{error}</div>}
      <button type="submit" className="primary" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>

      <div className="divider" />
      <div className="login-accounts">
        <div className="mb tiny dim">Seeded demo accounts (password: demo-password-123)</div>
        {DEMO_ACCOUNTS.map((account) => (
          <button
            key={account.email}
            type="button"
            className="sm"
            onClick={() => {
              setEmail(account.email);
              setPassword('demo-password-123');
            }}
          >
            <span>{account.label}</span>
            <span className="dim mono">{account.email.split('@')[0]}</span>
          </button>
        ))}
      </div>
    </form>
  );
}
