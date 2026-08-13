'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from './ui';

/**
 * The caller's whole screen.
 *
 * One opportunity, the handful of facts they will say out loud, and the fields
 * this outcome needs. Deliberately not a board: a caller choosing what to work
 * from a list of two hundred is a caller doing the routing engine's job badly,
 * and a screen that shows the routing is a screen that invites arguing with it.
 *
 * Everything the server refuses is shown as its own thing. "Not yours",
 * "incomplete" and "our fault" look different, because they call for three
 * different responses and one of them is not the caller's to make.
 */

type Field = { key: string; label: string; kind: string; hint?: string; choices?: string[] };
type Requirement = { because: string; needsFollowUpDate: boolean; required: string[] };

type Card = {
  routeId: string;
  organisation: string;
  location: string | null;
  phone: string | null;
  website: string | null;
  route: string;
  tier: string;
  eventLabel: string;
  eventDate: string | null;
  requiredCapability: string | null;
  needIsConfirmed: boolean;
  buyingWindow: string | null;
  windowClosesAt: string | null;
  supplySecured: boolean;
  fulfilmentReason: string | null;
  brief: {
    opening: string;
    askFor: string;
    discoveryObjective: string[];
    doNotClaim: string[];
    ourInferences: string[];
    offerDirection: string;
    supplyCaveat: string | null;
  };
  contactProvenance: {
    confidence: string | null;
    fields: Array<{ field: string; value: string; source: string; matchMethod: string | null; superseded: boolean }>;
  } | null;
  history: Array<{ id: string; disposition: string; notes: string | null; occurredAt: string }>;
};

type Served =
  | { served: true; because: string; localTime: string; remaining: number; card: Card; form: { route: string; fields: Field[]; dispositions: Array<{ value: string; label: string; group: string }>; requirements: Record<string, Requirement> } }
  | { served: false; reason: string; gate: Gate | null };

type Gate = {
  mayReceiveNew: boolean;
  message: string;
  blockingOrganisation: string | null;
  missingLabels: string[];
  needsFollowUpDate: boolean;
  correction: string | null;
  systemFault: boolean;
};

function humanise(value: string): string {
  return value.toLowerCase().replace(/_/g, ' ');
}

export function WorkWorkspace({ callerName }: { callerName: string }) {
  const [state, setState] = useState<Served | null>(null);
  const [loading, setLoading] = useState(false);
  const [disposition, setDisposition] = useState('');
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [notes, setNotes] = useState('');
  const [followUpAt, setFollowUpAt] = useState('');
  const [refusal, setRefusal] = useState<
    { kind: string; message: string; because?: string; missingLabels?: string[]; needsFollowUpDate?: boolean } | null
  >(null);
  const [saving, setSaving] = useState(false);

  const clearForm = () => {
    setDisposition('');
    setValues({});
    setNotes('');
    setFollowUpAt('');
    setRefusal(null);
  };

  const next = useCallback(async () => {
    setLoading(true);
    setRefusal(null);
    try {
      const response = await fetch('/api/work/next', { method: 'POST' });
      const body = (await response.json()) as Served;
      setState(body);
      clearForm();
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void next();
  }, [next]);

  async function save() {
    if (!state?.served) return;
    setSaving(true);
    setRefusal(null);
    try {
      const response = await fetch('/api/work/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          routeId: state.card.routeId,
          disposition,
          notes: notes || undefined,
          discovery: values,
          followUpAt: followUpAt || null,
          contextSnapshot: { phoneShown: state.card.phone, servedBecause: state.because },
        }),
      });
      const body = await response.json();
      if (!response.ok || body.ok === false) {
        // Nothing is cleared. Whatever they typed stays on screen, whether the
        // refusal was theirs to fix or ours.
        setRefusal(body);
        return;
      }
      await next();
    } catch (caught) {
      setRefusal({ kind: 'system', message: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setSaving(false);
    }
  }

  if (loading && !state) return <div className="card"><p className="small muted">Finding your next call…</p></div>;

  // --- nothing to serve ----------------------------------------------------
  if (state && !state.served) {
    const gate = state.gate;
    return (
      <div className="card">
        <h2 style={{ marginTop: 0 }}>{gate && !gate.mayReceiveNew ? 'One thing first' : 'Nothing to call'}</h2>
        {gate && !gate.mayReceiveNew ? (
          <div className={gate.systemFault ? 'alert warning' : 'alert'}>
            <strong>{gate.message}</strong>
            {gate.correction && <div style={{ marginTop: '0.3rem' }}>{gate.correction}</div>}
            {gate.systemFault && (
              <div className="tiny mt">
                This is a fault on our side. It is recorded as one and is not counted against you.
              </div>
            )}
          </div>
        ) : (
          <p className="small muted">{state.reason}</p>
        )}
        <button className="btn secondary" onClick={() => void next()} disabled={loading}>
          {loading ? 'Checking…' : 'Check again'}
        </button>
      </div>
    );
  }

  if (!state?.served) return null;
  const { card, form } = state;
  const requirement = disposition ? form.requirements[disposition] : null;
  const requiredKeys = new Set(requirement?.required ?? []);
  const phoneProvenance = card.contactProvenance?.fields.find((f) => f.field === 'phone' && !f.superseded);

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="tiny dim">
          {callerName} · {state.remaining} left in your packets
        </div>
        <div className="tiny dim">{state.localTime}</div>
      </div>

      {/* Why this one. A caller who knows why it was chosen opens better. */}
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h2 style={{ margin: 0 }}>{card.organisation}</h2>
            <div className="tiny dim">{card.location ?? 'location unknown'}</div>
            <div className="row mt" style={{ gap: '0.3rem' }}>
              <Badge tone={card.tier === 'ACTIVE_DEMAND' ? 'success' : 'warning'}>{humanise(card.tier)}</Badge>
              <Badge>{humanise(card.route)}</Badge>
              {!card.supplySecured && <Badge tone="warning">no provider secured</Badge>}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            {card.phone ? (
              <a className="btn" href={`tel:${card.phone.replace(/[^\d+]/g, '')}`}>☎ {card.phone}</a>
            ) : (
              <span className="tiny dim">no number</span>
            )}
            {phoneProvenance && (
              <div className="tiny dim mt" style={{ lineHeight: 1.5 }}>
                {card.contactProvenance?.confidence
                  ? humanise(card.contactProvenance.confidence)
                  : 'unverified'} · {humanise(phoneProvenance.source)}
                {phoneProvenance.matchMethod && <div>{phoneProvenance.matchMethod}</div>}
              </div>
            )}
          </div>
        </div>

        <div className="alert small mt" style={{ marginBottom: 0 }}>
          <strong>Why now:</strong> {state.because}
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <div className="tiny dim">Say something like</div>
          <p className="small" style={{ lineHeight: 1.65 }}>“{card.brief.opening}”</p>

          <div className="tiny dim mt">Ask for</div>
          <div className="small">{card.brief.askFor}</div>

          <div className="tiny dim mt">What you are trying to learn</div>
          <ul className="list-reset tiny muted" style={{ lineHeight: 1.6 }}>
            {card.brief.discoveryObjective.map((q) => <li key={q}>· {q}</li>)}
          </ul>

          <div className="tiny dim mt">Do not claim</div>
          <ul className="list-reset tiny muted" style={{ lineHeight: 1.6 }}>
            {card.brief.doNotClaim.map((c) => <li key={c}>· {c}</li>)}
          </ul>
          {card.brief.supplyCaveat && <div className="alert warning tiny mt">{card.brief.supplyCaveat}</div>}
        </div>

        <div className="card">
          <div className="tiny dim">The event behind this</div>
          <div className="small">
            {card.eventLabel}
            {card.eventDate && <> on <strong>{card.eventDate.slice(0, 10)}</strong></>}
          </div>
          <div className="tiny dim mt">Our inference, not their statement</div>
          <ul className="list-reset tiny muted" style={{ lineHeight: 1.6 }}>
            {card.brief.ourInferences.map((i) => <li key={i}>· {i}</li>)}
          </ul>
          {card.history.length > 0 && (
            <>
              <div className="tiny dim mt">Previously</div>
              <ul className="list-reset tiny muted" style={{ lineHeight: 1.6 }}>
                {card.history.slice(0, 3).map((h) => (
                  <li key={h.id}>· {h.occurredAt.slice(0, 10)} — {humanise(h.disposition)}{h.notes ? `: ${h.notes}` : ''}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>

      {/* --- what happened --------------------------------------------- */}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>What happened</h3>

        {/* Grouped, because seventeen chips in one row is a list nobody reads
            and the groups are the actual question: did you reach anybody. */}
        {[...new Set(form.dispositions.map((d) => d.group))].map((group) => (
          <div key={group} className="mt">
            <div className="tiny dim">{group}</div>
            <div className="filter-bar">
              {form.dispositions
                .filter((d) => d.group === group)
                .map((d) => (
                  <button
                    key={d.value}
                    data-testid={`disposition-${d.value}`}
                    className={`filter-chip${disposition === d.value ? ' active' : ''}`}
                    onClick={() => setDisposition(d.value)}
                  >
                    {d.label}
                  </button>
                ))}
            </div>
          </div>
        ))}

        {requirement && (
          <p className="tiny dim mt">{requirement.because}</p>
        )}

        {disposition && (
          <>
            <div className="grid grid-2 mt">
              {form.fields
                .filter((f) => requiredKeys.has(f.key) || Boolean(values[f.key]))
                .concat(form.fields.filter((f) => !requiredKeys.has(f.key) && !values[f.key]))
                .map((field) => {
                  const required = requiredKeys.has(field.key);
                  return (
                    <label key={field.key} className="field">
                      <span className="tiny dim">
                        {field.label}
                        {required && <strong> · required</strong>}
                      </span>
                      {field.kind === 'boolean' ? (
                        <input
                          type="checkbox"
                          checked={Boolean(values[field.key])}
                          onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.checked }))}
                        />
                      ) : field.kind === 'longtext' ? (
                        <textarea
                          className="input"
                          data-testid={`field-${field.key}`}
                          rows={2}
                          value={String(values[field.key] ?? '')}
                          onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                        />
                      ) : (
                        <input
                          className="input"
                          data-testid={`field-${field.key}`}
                          value={String(values[field.key] ?? '')}
                          onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                        />
                      )}
                      {field.hint && <span className="tiny dim">{field.hint}</span>}
                    </label>
                  );
                })}
            </div>

            {requirement?.needsFollowUpDate && (
              <label className="field mt">
                <span className="tiny dim">Follow up on · required</span>
                <input className="input" type="date" data-testid="follow-up" value={followUpAt} onChange={(e) => setFollowUpAt(e.target.value)} />
              </label>
            )}

            <label className="field mt">
              <span className="tiny dim">Anything else</span>
              <textarea className="input" rows={3} data-testid="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
          </>
        )}

        {refusal && (
          <div
            data-testid={`refusal-${refusal.kind}`}
            className={`alert ${refusal.kind === 'system' ? 'warning' : 'danger'} small mt`}
          >
            <strong>{refusal.message}</strong>
            {refusal.because && <div style={{ marginTop: '0.3rem' }}>{refusal.because}</div>}
            {refusal.kind === 'system' && (
              <div style={{ marginTop: '0.3rem' }}>
                Nothing you typed has been lost — it is all still on this screen and recorded with the fault.
              </div>
            )}
          </div>
        )}

        <div className="row mt">
          <button className="btn" data-testid="save-call" disabled={!disposition || saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save and get the next one'}
          </button>
        </div>
      </div>
    </>
  );
}
