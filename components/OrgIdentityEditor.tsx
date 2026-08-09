'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * The organisation still carries the seed's invented name until someone
 * changes it. Small thing, but it is the first signal that the numbers on
 * screen belong to somebody else.
 */

const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
];

export function OrgIdentityEditor({ name, timezone }: { name: string; timezone: string }) {
  const router = useRouter();
  const [value, setValue] = useState(name);
  const [zone, setZone] = useState(timezone);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const response = await fetch('/api/admin/config', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organization: { name: value, timezone: zone } }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? payload.details?.[0] ?? 'Could not save');
      setSaved(true);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card-title">
        <h2>Whose operation this is</h2>
      </div>
      <p className="small muted">
        The timezone is not cosmetic — calling hours, quiet hours and the daily plan are all evaluated against it.
      </p>
      {error && <div className="alert danger small">{error}</div>}
      {saved && <div className="alert success small">Saved.</div>}
      <div className="grid grid-2">
        <div className="field">
          <label htmlFor="org-name">Business name</label>
          <input id="org-name" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Your company name" />
        </div>
        <div className="field">
          <label htmlFor="org-tz">Operating timezone</label>
          <select id="org-tz" value={zone} onChange={(e) => setZone(e.target.value)}>
            {(TIMEZONES.includes(zone) ? TIMEZONES : [zone, ...TIMEZONES]).map((tz) => (
              <option key={tz} value={tz}>{tz.replace('America/', '').replace('_', ' ')}</option>
            ))}
          </select>
        </div>
      </div>
      <button className="primary" onClick={save} disabled={busy || value.trim().length === 0 || (value === name && zone === timezone)}>
        {busy ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}
