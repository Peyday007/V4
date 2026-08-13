'use client';

import { useState } from 'react';

/**
 * Closing a system failure on somebody's work.
 *
 * This exists because the gate that holds a caller after a failed save has no
 * timer on it. An open incident blocks them from being handed anything new —
 * which is right, because the alternative is quietly losing what they typed —
 * but it means the only way back onto the floor is a person saying what was
 * done about it. Without this control that person had no button, and a single
 * broken save would end a caller's day permanently.
 *
 * The resolution text is required and free-form on purpose. A dropdown of
 * causes would be filled in by reflex; a sentence has to be written by somebody
 * who looked.
 */
export function IncidentResolution({
  callerId,
  incidentId,
}: {
  callerId: string;
  incidentId: string;
}) {
  const [open, setOpen] = useState(false);
  const [resolution, setResolution] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true); setError(null);
    try {
      const response = await fetch('/api/callers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'resolve_incident', callerId, incidentId, resolution }),
      });
      const payload = await response.json();
      if (!response.ok) { setError(payload?.error ?? 'That did not work.'); return; }
      window.location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        className="btn secondary tiny"
        data-testid={`resolve-incident-${incidentId}`}
        onClick={() => setOpen(true)}
      >
        Mark fixed
      </button>
    );
  }

  return (
    <div data-testid="resolve-incident-form">
      {error && <div className="alert danger small" data-testid="resolve-error">{error}</div>}
      <textarea
        className="input tiny"
        rows={2}
        placeholder="What was wrong, and what did you do about it?"
        data-testid="resolution-text"
        value={resolution}
        onChange={(e) => setResolution(e.target.value)}
      />
      <div className="row" style={{ gap: '0.4rem', marginTop: '0.4rem' }}>
        <button
          className="btn tiny"
          disabled={busy || resolution.trim().length < 4}
          data-testid="confirm-resolve"
          onClick={() => void submit()}
        >
          Release them
        </button>
        <button className="btn secondary tiny" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
      </div>
      <div className="tiny dim mt">
        This unblocks new work for them. What they typed stays on the record either way.
      </div>
    </div>
  );
}
