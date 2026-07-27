'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

const OUTCOMES = [
  'CONNECTED',
  'NO_ANSWER',
  'VOICEMAIL',
  'GATEKEEPER',
  'WRONG_NUMBER',
  'CALLBACK_SCHEDULED',
  'REFUSED',
  'DO_NOT_CALL',
] as const;

/**
 * The dialer. Start places the call through the telephony provider; End logs
 * the outcome and hands the conversation to the analysis pipeline.
 *
 * The transcript box exists because a call can happen outside the dialer, and
 * because the mock provider produces no audio. Either way the same extraction
 * runs, so the caller never edits a record by hand.
 */
export function CallConsole({
  assignmentId,
  activeCallId,
  phone,
  blocked,
}: {
  assignmentId: string;
  activeCallId: string | null;
  phone: string | null;
  blocked: boolean;
}) {
  const router = useRouter();
  const [callId, setCallId] = useState<string | null>(activeCallId);
  const [startedAt, setStartedAt] = useState<number | null>(activeCallId ? Date.now() : null);
  const [elapsed, setElapsed] = useState(0);
  const [outcome, setOutcome] = useState<(typeof OUTCOMES)[number]>('CONNECTED');
  const [notes, setNotes] = useState('');
  const [transcriptText, setTranscriptText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);

  useEffect(() => {
    if (!startedAt) return;
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/calls/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assignmentId }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not start the call');
      setCallId(body.callId);
      setStartedAt(Date.now());
      setAnnouncement(body.announcement ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start the call');
    } finally {
      setBusy(false);
    }
  }

  async function end() {
    if (!callId) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/calls/end', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          callId,
          outcome,
          notes: notes || undefined,
          transcriptText: outcome === 'CONNECTED' && transcriptText ? transcriptText : undefined,
          durationSec: elapsed > 0 ? elapsed : undefined,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not end the call');

      setResult(
        body.queuedAnalysis
          ? `Call logged. The transcript was analysed and ${body.jobsProcessed} downstream job(s) ran — facts extracted, records updated, next action set.`
          : 'Call logged. No transcript supplied, so no facts were extracted.',
      );
      setCallId(null);
      setStartedAt(null);
      setElapsed(0);
      setTranscriptText('');
      setNotes('');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not end the call');
    } finally {
      setBusy(false);
    }
  }

  const mmss = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;

  return (
    <div className="card" style={{ borderColor: callId ? 'var(--success)' : 'var(--border)' }}>
      <div className="card-title">
        <h2>Dialer</h2>
        {callId && <span className="badge success">Live · {mmss}</span>}
      </div>

      {announcement && <div className="alert info small">Read now: &ldquo;{announcement}&rdquo;</div>}
      {error && <div className="alert danger small">{error}</div>}
      {result && <div className="alert success small">{result}</div>}

      {!callId ? (
        <>
          <p className="small muted">
            {phone ? `Dialing ${phone}` : 'No phone number on file — find one before calling.'}
          </p>
          <button className="primary" onClick={start} disabled={busy || blocked || !phone}>
            {busy ? 'Connecting…' : 'Start call'}
          </button>
          {blocked && <div className="tiny dim mt">Blocked by the compliance check above.</div>}
        </>
      ) : (
        <>
          <div className="field">
            <label htmlFor="outcome">Outcome</label>
            <select id="outcome" value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)}>
              {OUTCOMES.map((option) => (
                <option key={option} value={option}>
                  {option.replace(/_/g, ' ').toLowerCase()}
                </option>
              ))}
            </select>
          </div>

          {outcome === 'CONNECTED' && (
            <div className="field">
              <label htmlFor="transcript">
                Conversation transcript — speaker-labelled lines. Leave blank if the provider is recording.
              </label>
              <textarea
                id="transcript"
                rows={10}
                placeholder={'Caller: Hi, this is Dana...\nContact: We use Nationwide right now, but they missed two shifts last month.'}
                value={transcriptText}
                onChange={(e) => setTranscriptText(e.target.value)}
              />
              <div className="tiny dim">
                Everything the other party says is parsed for scope, pricing, dates, capacity, incumbents, objections and
                commitments. You do not need to update any record afterwards.
              </div>
            </div>
          )}

          <div className="field">
            <label htmlFor="notes">Caller notes (optional)</label>
            <input id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything the transcript would not capture" />
          </div>

          <button className="primary" onClick={end} disabled={busy}>
            {busy ? 'Saving…' : 'End call and log outcome'}
          </button>
        </>
      )}
    </div>
  );
}
