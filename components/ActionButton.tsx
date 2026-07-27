'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function ActionButton({
  endpoint,
  body,
  children,
  className,
  confirm,
  promptFor,
  onDone,
}: {
  endpoint: string;
  body?: Record<string, unknown>;
  children: React.ReactNode;
  className?: string;
  confirm?: string;
  /** Prompts for a free-text value merged into the body under this key. */
  promptFor?: { key: string; label: string };
  onDone?: (result: unknown) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (confirm && !window.confirm(confirm)) return;
    const payload = { ...(body ?? {}) };
    if (promptFor) {
      const value = window.prompt(promptFor.label);
      if (value === null) return;
      payload[promptFor.key] = value;
    }

    setBusy(true);
    setError(null);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Action failed');
      onDone?.(result);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className={className} onClick={run} disabled={busy}>
        {busy ? 'Working…' : children}
      </button>
      {error && (
        <div className="alert danger tiny" style={{ marginTop: '0.4rem' }}>
          {error}
        </div>
      )}
    </>
  );
}
