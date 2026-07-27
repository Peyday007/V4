'use client';

import { useState } from 'react';
import type { OrgConfig } from '@/lib/config';

const NUMERIC_GROUPS: Array<{ key: keyof OrgConfig; label: string; hint: string }> = [
  { key: 'marginRules', label: 'Margin rules', hint: 'Percentages. The minimum floor drives margin-exception escalations.' },
  { key: 'approvalLimits', label: 'Approval limits', hint: 'Dollar thresholds above which a human must decide before anything goes out.' },
  { key: 'stalenessRules', label: 'Staleness rules', hint: 'Days before a fact must be re-verified rather than reused.' },
  { key: 'planning', label: 'Planning', hint: 'Caller capacity and the minimum sample before a lane recommendation is made.' },
  { key: 'scoringWeights', label: 'Scoring weights', hint: 'Relative weight of each dimension. Negative values penalise.' },
];

export function ConfigEditor({ initial }: { initial: OrgConfig }) {
  const [config, setConfig] = useState<OrgConfig>(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function update(group: keyof OrgConfig, field: string, value: string) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    setConfig((current) => ({
      ...current,
      [group]: { ...(current[group] as Record<string, unknown>), [field]: parsed },
    }));
  }

  async function save() {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const payload = Object.fromEntries(NUMERIC_GROUPS.map((g) => [g.key, config[g.key]]));
      const response = await fetch('/api/admin/config', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not save');
      setMessage('Saved. New thresholds apply to the next AI evaluation.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {message && <div className="alert success small">{message}</div>}
      {error && <div className="alert danger small">{error}</div>}

      <div className="grid grid-2">
        {NUMERIC_GROUPS.map((group) => {
          const values = config[group.key] as Record<string, number>;
          return (
            <div key={String(group.key)}>
              <h4>{group.label}</h4>
              <div className="tiny dim mb">{group.hint}</div>
              {Object.entries(values)
                .filter(([, value]) => typeof value === 'number')
                .map(([field, value]) => (
                  <div className="field" key={field}>
                    <label htmlFor={`${String(group.key)}-${field}`}>{field.replace(/([A-Z])/g, ' $1').toLowerCase()}</label>
                    <input
                      id={`${String(group.key)}-${field}`}
                      type="number"
                      step="any"
                      value={value}
                      onChange={(e) => update(group.key, field, e.target.value)}
                    />
                  </div>
                ))}
            </div>
          );
        })}
      </div>

      <div className="divider" />
      <h4>Calling rules (read-only here)</h4>
      <pre className="mono pre-wrap">{JSON.stringify(config.callingRules, null, 2)}</pre>
      <h4>Risk rules (read-only here)</h4>
      <pre className="mono pre-wrap">{JSON.stringify(config.riskRules, null, 2)}</pre>

      <button className="primary mt" onClick={save} disabled={busy}>
        {busy ? 'Saving…' : 'Save operating rules'}
      </button>
    </>
  );
}
