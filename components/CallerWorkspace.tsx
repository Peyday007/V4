'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Badge } from './ui';
import type { CallCard } from '@/lib/demand/callCard';
import { DISPOSITIONS } from '@/lib/demand/dispositionList';

/**
 * One opportunity at a time.
 *
 * The caller sees what they will say and what they must find out. The evidence
 * is behind a toggle — a person about to dial should not be scrolling past a
 * working-capital assessment to reach the phone number.
 *
 * Two rules shape the save behaviour, and both exist because losing a call is
 * worse than any other failure here:
 *
 *   A failed save does not advance and does not clear the form. Whatever was
 *   typed stays on screen with the error next to it.
 *
 *   Ids already worked are sent with each save, so the server excludes them
 *   when choosing the next card. A write that has not yet become visible to a
 *   following read cannot hand back the record just finished.
 */

type Props = { initial: CallCard | null; message: string | null };

const TIER_TONE: Record<string, string> = {
  ACTIVE_DEMAND: 'success',
  STRONG_TRIGGER: 'warning',
  PREDICTED_NEED: 'accent',
  DIRECTORY_PROSPECT: '',
};

const FRICTION_TONE: Record<string, string> = {
  LOW: 'success',
  MODERATE: 'warning',
  HIGH: 'danger',
  UNKNOWN_RESEARCH_REQUIRED: '',
};

function humanise(value: string): string {
  return value.toLowerCase().replace(/_/g, ' ');
}

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '—';
}

const EMPTY_FORM = {
  disposition: '',
  notes: '',
  contactName: '',
  contactRole: '',
  correctedPhone: '',
  correctedEmail: '',
  followUpAt: '',
  confirmedNeed: '',
  confirmedTiming: '',
  budgetNote: '',
  incumbentStatus: '',
  disqualifyReason: '',
};

export function CallerWorkspace({ initial, message }: Props) {
  const [card, setCard] = useState<CallCard | null>(initial);
  const [emptyMessage, setEmptyMessage] = useState<string | null>(message);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [done, setDone] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastEffect, setLastEffect] = useState<string | null>(null);
  const [showEvidence, setShowEvidence] = useState(false);
  const [evidence, setEvidence] = useState<Record<string, unknown> | null>(null);
  const [worked, setWorked] = useState(0);

  const set = (key: keyof typeof EMPTY_FORM) => (value: string) => setForm((f) => ({ ...f, [key]: value }));

  const loadNext = useCallback(
    async (excluding: string[]) => {
      setError(null);
      const params = new URLSearchParams();
      for (const id of excluding) params.append('done', id);
      const response = await fetch(`/api/demand/next?${params.toString()}`);
      const body = await response.json();
      if (!response.ok) {
        setError(body?.error ?? 'Could not load the next opportunity.');
        return;
      }
      setCard(body.card);
      setEmptyMessage(body.message ?? null);
      setForm({ ...EMPTY_FORM });
      setShowEvidence(false);
      setEvidence(null);
    },
    [],
  );

  async function save() {
    if (!card || !form.disposition) {
      setError('Pick what happened on the call before saving.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/demand/disposition', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          routeId: card.routeId,
          disposition: form.disposition,
          notes: form.notes || undefined,
          contactName: form.contactName || undefined,
          contactRole: form.contactRole || undefined,
          correctedPhone: form.correctedPhone || undefined,
          correctedEmail: form.correctedEmail || undefined,
          followUpAt: form.followUpAt ? new Date(form.followUpAt).toISOString() : undefined,
          confirmedNeed: form.confirmedNeed || undefined,
          confirmedTiming: form.confirmedTiming || undefined,
          budgetNote: form.budgetNote || undefined,
          incumbentStatus: form.incumbentStatus || undefined,
          disqualifyReason: form.disqualifyReason || undefined,
          done,
          contextSnapshot: {
            tier: card.tier,
            route: card.route,
            eventType: card.eventType,
            eventDate: card.eventDate,
            phoneShown: card.phone,
            supplySecured: card.supplySecured,
          },
        }),
      });

      const body = await response.json();
      if (!response.ok) {
        // Nothing is cleared and nothing advances. The notes stay exactly
        // where they were typed.
        throw new Error(body?.error ?? `Save failed (${response.status})`);
      }

      setLastEffect(body.saved.effect);
      setWorked((n) => n + 1);
      setDone(body.done);
      setCard(body.next);
      setEmptyMessage(body.next ? null : 'Nothing left in the calling queue.');
      setForm({ ...EMPTY_FORM });
      setShowEvidence(false);
      setEvidence(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  async function openEvidence() {
    if (!card) return;
    setShowEvidence((s) => !s);
    if (evidence) return;
    const response = await fetch(`/api/demand/evidence/${card.routeId}`);
    setEvidence(response.ok ? await response.json() : { error: 'Could not load evidence.' });
  }

  if (!card) {
    return (
      <div className="card">
        <h2>Queue clear</h2>
        <p className="small muted">{emptyMessage ?? 'Nothing left to call.'}</p>
        {worked > 0 && <p className="small">You worked {worked} opportunit{worked === 1 ? 'y' : 'ies'} this session.</p>}
        <div className="row mt">
          <Link className="btn" href="/demand">Back to the board</Link>
          <button className="btn secondary" onClick={() => loadNext([])}>Check again</button>
        </div>
      </div>
    );
  }

  const brief = card.brief;

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="tiny dim">
          {worked} worked this session · {done.length} skipped from the queue
        </div>
        <div className="row">
          <button className="btn secondary" disabled={saving} onClick={() => loadNext([...done, card.routeId])}>
            Skip
          </button>
          <Link className="btn secondary" href="/demand">Back to board</Link>
        </div>
      </div>

      {lastEffect && <div className="alert small">Saved. {lastEffect}</div>}

      {!card.callable && card.notCallableReason && (
        <div className="alert warning small">
          <strong>Not in the calling queue:</strong> {card.notCallableReason}
        </div>
      )}

      <div className="card">
        <div className="card-title">
          <div>
            <h2 style={{ marginBottom: '0.3rem' }}>{card.organisation}</h2>
            <div className="row">
              <Badge tone={TIER_TONE[card.tier] ?? ''}>{humanise(card.tier)}</Badge>
              <Badge>{humanise(card.route)}</Badge>
              <Badge tone={FRICTION_TONE[card.friction] ?? ''}>{humanise(card.friction)} friction</Badge>
              {/* Named plainly. "Blocked on supply" reads like a rejection; it
                  means the demand is real and nobody is lined up to do it. */}
              {!card.supplySecured && <Badge tone="warning">no provider secured</Badge>}
            </div>
            <div className="tiny dim mt">{card.location ?? 'location unknown'}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            {card.phone ? (
              <a className="btn" href={`tel:${card.phone.replace(/[^\d+]/g, '')}`}>☎ {card.phone}</a>
            ) : (
              <span className="tiny dim">no phone on file</span>
            )}
            <div className="tiny dim mt">
              {card.website && (
                <a href={card.website} target="_blank" rel="noreferrer noopener">website ↗</a>
              )}
              {card.email && <> · {card.email}</>}
            </div>
          </div>
        </div>

        <div className="grid grid-2 mt">
          <div>
            <div className="tiny dim">Say something like</div>
            <p className="small" style={{ lineHeight: 1.65 }}>“{brief.opening}”</p>

            <div className="tiny dim mt">Ask for</div>
            <div className="small">{brief.askFor}</div>

            <div className="tiny dim mt">What you need to find out</div>
            <ul className="list-reset small" style={{ lineHeight: 1.6 }}>
              {brief.discoveryObjective.map((q) => <li key={q}>· {q}</li>)}
            </ul>

            <div className="tiny dim mt">What you are exploring</div>
            <div className="small">{brief.offerDirection}</div>

            {brief.supplyCaveat && (
              <div className="alert warning tiny mt">{brief.supplyCaveat}</div>
            )}

            <div className="alert danger tiny mt">
              <strong>Do not claim:</strong> {brief.doNotClaim.join(' ')}
            </div>
          </div>

          <div>
            <div className="tiny dim">The event this came from</div>
            <div className="small" style={{ lineHeight: 1.6 }}>
              {card.eventLabel}
              {/* The source's date only. Our first-seen timestamp is a separate
                  line with different words, further down. */}
              {card.eventDate ? <> dated <strong>{day(card.eventDate)}</strong></> : ' — no date published'}
              {card.deadlineAt && <> · deadline <strong>{day(card.deadlineAt)}</strong></>}
            </div>
            <div className="tiny dim">
              Source: {card.connector}
              {card.sourceUrl && (
                <>
                  {' · '}
                  <a href={card.sourceUrl} target="_blank" rel="noreferrer noopener">open the record ↗</a>
                </>
              )}
            </div>
            <div className="tiny dim">We first saw this {day(card.discoveredAt)} — our timestamp, not an event.</div>

            <div className="tiny dim mt">Confirmed by the source</div>
            <ul className="list-reset tiny muted" style={{ lineHeight: 1.6 }}>
              {brief.sourcedFacts.map((f) => <li key={f}>· {f}</li>)}
            </ul>

            <div className="tiny dim mt">Our inference — they have not said this</div>
            <ul className="list-reset tiny muted" style={{ lineHeight: 1.6 }}>
              {brief.ourInferences.map((f) => <li key={f}>· {f}</li>)}
            </ul>

            <div className="tiny dim mt">Biggest uncertainty</div>
            <div className="tiny muted">{brief.keyUncertainty}</div>

            <div className="tiny dim mt">Buying window</div>
            <div className="tiny muted">
              {humanise(card.buyingWindow ?? 'unknown')}
              {card.windowClosesAt && ` · closes ${day(card.windowClosesAt)}`}
            </div>

            {card.siblingRoutes.length > 0 && (
              <>
                <div className="tiny dim mt">Other routes for this account</div>
                <div className="tiny muted">
                  {card.siblingRoutes.map((s) => (
                    <div key={s.routeId}>
                      · {humanise(s.route)}: {s.headline}
                      {s.sameEvent && <span className="dim"> (same event)</span>}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="mt">
          <button className="btn secondary tiny" onClick={openEvidence}>
            {showEvidence ? 'Hide full evidence' : 'View full evidence'}
          </button>
        </div>

        {showEvidence && (
          <pre className="tiny mono mt" style={{ maxHeight: '24rem', overflow: 'auto' }}>
            {evidence ? JSON.stringify(evidence, null, 2) : 'Loading…'}
          </pre>
        )}
      </div>

      {card.history.length > 0 && (
        <div className="card">
          <div className="tiny dim">Previous attempts</div>
          <ul className="list-reset tiny muted" style={{ lineHeight: 1.7 }}>
            {card.history.map((h) => (
              <li key={h.id}>
                {day(h.occurredAt)} · <strong>{humanise(h.disposition)}</strong>
                {h.by && ` · ${h.by}`}
                {h.notes && ` — ${h.notes}`}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <div className="tiny dim">What happened?</div>

        <div className="row mt" style={{ flexWrap: 'wrap', gap: '0.3rem' }}>
          {DISPOSITIONS.map((d) => (
            <button
              key={d.value}
              className={`filter-chip${form.disposition === d.value ? ' active' : ''}`}
              onClick={() => set('disposition')(d.value)}
              type="button"
            >
              {d.label}
            </button>
          ))}
        </div>

        <textarea
          className="input mt"
          rows={3}
          placeholder="Notes — what was said, who you spoke to, anything worth knowing next time."
          value={form.notes}
          onChange={(e) => set('notes')(e.target.value)}
        />

        <div className="grid grid-4 mt">
          <Field label="Contact name" value={form.contactName} onChange={set('contactName')} />
          <Field label="Their role" value={form.contactRole} onChange={set('contactRole')} />
          <Field label="Corrected phone" value={form.correctedPhone} onChange={set('correctedPhone')} />
          <Field label="Corrected email" value={form.correctedEmail} onChange={set('correctedEmail')} />
        </div>

        <div className="grid grid-4 mt">
          <Field label="Confirmed need" value={form.confirmedNeed} onChange={set('confirmedNeed')} />
          <Field label="Confirmed timing" value={form.confirmedTiming} onChange={set('confirmedTiming')} />
          <Field label="Budget / process" value={form.budgetNote} onChange={set('budgetNote')} />
          <Field label="Incumbent provider" value={form.incumbentStatus} onChange={set('incumbentStatus')} />
        </div>

        <div className="grid grid-2 mt">
          <div>
            <div className="tiny dim">Follow up on</div>
            <input
              className="input"
              type="datetime-local"
              value={form.followUpAt}
              onChange={(e) => set('followUpAt')(e.target.value)}
            />
          </div>
          <Field label="Reason, if disqualifying" value={form.disqualifyReason} onChange={set('disqualifyReason')} />
        </div>

        {error && <div className="alert danger small mt">{error}</div>}

        <div className="row mt">
          <button className="btn" disabled={saving || !form.disposition} onClick={save}>
            {saving ? 'Saving…' : 'Save and work next'}
          </button>
          <span className="tiny dim">
            {form.disposition ? 'Saving records the attempt and moves you on.' : 'Pick an outcome first.'}
          </span>
        </div>
      </div>
    </>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <div className="tiny dim">{label}</div>
      <input className="input" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
