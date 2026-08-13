'use client';

import { useState } from 'react';

/**
 * The controls that actually move a deal.
 *
 * Until this existed the commercial workflow had a complete set of endpoints,
 * a complete set of guards, and no way for anybody to reach them. The record
 * page rendered the state of a deal and offered no means of changing it, so
 * every stage past a phone call was reachable only with a shell and a session
 * cookie. Logic that no screen calls is not a feature.
 *
 * Two rules shape it.
 *
 * The action offered first is the action the plan says is next. A page that
 * lays out sixteen forms and lets you choose is a page that makes somebody
 * re-derive the state of the deal before they can act on it, which is the work
 * the plan just did. Everything else is still reachable, one disclosure away,
 * because real deals go sideways and the owner needs the whole board.
 *
 * Every field that carries evidence is required by the form as well as by the
 * endpoint. The endpoint refusing is correct and it is late: somebody has
 * already typed a commitment and pressed the button by then, and a refusal at
 * that point reads as the software being obstructive rather than as the
 * evidence being the point.
 */

type Field = {
  name: string;
  label: string;
  type?: 'text' | 'textarea' | 'number' | 'date' | 'select';
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
  required?: boolean;
  /** Why this field exists, said once, next to the field. */
  note?: string;
};

type ActionSpec = {
  key: string;
  /** The button an owner presses to open it. */
  label: string;
  /** One line about what pressing it will do. */
  intent: string;
  endpoint: string;
  /** Fixed values merged into the request body. */
  body: Record<string, unknown>;
  fields: Field[];
  /**
   * True for external communication, pricing, binding commitments and money.
   * Rendered differently and never the quiet default.
   */
  authority?: boolean;
};

export type DealActionContext = {
  routeId: string;
  /** What the plan says to do, so the two panels cannot disagree. */
  nextAction: string | null;
  nextOwner: string | null;
  quoteId: string | null;
  quoteState: string | null;
  dealId: string | null;
  candidates: Array<{ id: string; name: string; state: string }>;
  /** The stage the plan says is next, so the right form opens first. */
  nextStageKey: string | null;
  canWrite: boolean;
  canSend: boolean;
};

function specsFor(ctx: DealActionContext): Record<string, ActionSpec[]> {
  const candidateOptions = ctx.candidates.map((c) => ({ value: c.id, label: `${c.name} (${c.state.toLowerCase().replace(/_/g, ' ')})` }));

  const requirement: ActionSpec = {
    key: 'capture',
    label: 'Record what they asked for',
    intent: 'Creates a new version of the buyer requirement. Nothing is overwritten.',
    endpoint: '/api/deal/requirement',
    body: { action: 'capture', routeId: ctx.routeId },
    fields: [
      { name: 'summary', label: 'What they need', type: 'textarea', required: true, note: 'In their words where you have them.' },
      { name: 'quantity', label: 'How much' },
      { name: 'frequency', label: 'How often' },
      { name: 'locations', label: 'Where' },
      { name: 'timingNote', label: 'When they need it' },
      { name: 'decisionMakerRole', label: 'Who decides' },
      {
        name: 'budgetMechanism', label: 'How it gets paid for', type: 'select',
        options: [
          { value: 'UNKNOWN', label: 'not known' },
          { value: 'NO_BUDGET', label: 'no budget' },
          { value: 'BUDGET_STATED', label: 'budget stated' },
          { value: 'QUOTE_REQUESTED', label: 'quote requested' },
          { value: 'FORMAL_BID', label: 'formal bid' },
          { value: 'RENEWAL_CYCLE', label: 'renewal cycle' },
        ],
      },
      {
        name: 'confirmed', label: 'Which of these they actually said', type: 'text',
        placeholder: 'summary, quantity, frequency',
        note: 'Comma separated. Anything you leave out is recorded as our inference, not theirs.',
      },
    ],
  };

  const addProvider: ActionSpec = {
    key: 'provider_add',
    label: 'Add a provider candidate',
    intent: 'Names somebody who might do the work. A candidate is not fulfilment.',
    endpoint: '/api/deal/provider',
    body: { action: 'add', routeId: ctx.routeId },
    fields: [
      { name: 'providerCompanyId', label: 'Provider company id', required: true },
      { name: 'matchBasis', label: 'Why them', type: 'textarea', required: true, note: 'What makes you think they can do this.' },
    ],
  };

  const advance = (to: string, label: string, intent: string, extra: Field[]): ActionSpec => ({
    key: `provider_${to}`,
    label,
    intent,
    endpoint: '/api/deal/provider',
    body: { action: 'advance', to },
    fields: [
      { name: 'candidateId', label: 'Which candidate', type: 'select', options: candidateOptions, required: true },
      { name: 'reason', label: 'What happened', type: 'textarea', required: true, note: 'Who told you, and when.' },
      ...extra,
    ],
  });

  const quoteDraft: ActionSpec = {
    key: 'quote_draft',
    label: 'Draft a quote',
    intent: 'Prices the deal. Nothing is sent until you send it, and pricing may need approval.',
    endpoint: '/api/deal/quote',
    body: { action: 'draft', routeId: ctx.routeId },
    authority: true,
    fields: [
      { name: 'providerCandidateId', label: 'Costed against', type: 'select', options: candidateOptions },
      { name: 'providerCost', label: 'Provider cost', type: 'number' },
      { name: 'freight', label: 'Freight', type: 'number' },
      { name: 'fees', label: 'Fees', type: 'number' },
      { name: 'contingency', label: 'Contingency', type: 'number' },
      { name: 'buyerPrice', label: 'Buyer price', type: 'number', required: true },
      { name: 'validUntil', label: 'Good until', type: 'date' },
      { name: 'paymentTerms', label: 'Payment terms' },
      { name: 'reason', label: 'Why this price', type: 'textarea' },
    ],
  };

  const quoteSend: ActionSpec = {
    key: 'quote_send',
    label: 'Send the quote',
    intent: 'Puts a price in front of the buyer. This leaves the building.',
    endpoint: '/api/deal/quote',
    body: { action: 'send', quoteId: ctx.quoteId },
    authority: true,
    fields: [
      { name: 'channel', label: 'How you are sending it', required: true, placeholder: 'email to dana@…, or the deal room' },
    ],
  };

  const commitBuyer: ActionSpec = {
    key: 'commit_buyer',
    label: 'Record the buyer commitment',
    intent: 'Binds us. A verbal yes is a commitment and it is not a signed contract.',
    endpoint: '/api/deal/commit',
    body: { action: 'commit_buyer', quoteId: ctx.quoteId },
    authority: true,
    fields: [
      {
        name: 'basis', label: 'What it rests on', type: 'select', required: true,
        options: [
          { value: 'VERBAL', label: 'verbal' }, { value: 'EMAIL', label: 'email' },
          { value: 'PURCHASE_ORDER', label: 'purchase order' }, { value: 'SIGNED_CONTRACT', label: 'signed contract' },
        ],
      },
      { name: 'evidence', label: 'The evidence', type: 'textarea', required: true, note: 'Quote the email, name the PO, or say who said it and when.' },
      { name: 'contractedValue', label: 'Contracted value', type: 'number' },
    ],
  };

  const commitProvider: ActionSpec = {
    key: 'commit_provider',
    label: 'Record the provider commitment',
    intent: 'The other side of the exposure. Until this exists we owe work we have not secured.',
    endpoint: '/api/deal/commit',
    body: { action: 'commit_provider', dealId: ctx.dealId },
    authority: true,
    fields: [
      { name: 'providerCandidateId', label: 'Which provider', type: 'select', options: candidateOptions, required: true },
      {
        name: 'basis', label: 'What it rests on', type: 'select', required: true,
        options: [
          { value: 'VERBAL', label: 'verbal' }, { value: 'EMAIL', label: 'email' },
          { value: 'PURCHASE_ORDER', label: 'purchase order' }, { value: 'SIGNED_CONTRACT', label: 'signed contract' },
        ],
      },
      { name: 'evidence', label: 'The evidence', type: 'textarea', required: true },
      { name: 'contractedCost', label: 'Contracted cost', type: 'number' },
    ],
  };

  const dealAdvance = (to: string, label: string, intent: string, extra: Field[] = []): ActionSpec => ({
    key: `deal_${to}`,
    label,
    intent,
    endpoint: '/api/deal/commit',
    body: { action: 'advance', dealId: ctx.dealId, to },
    fields: [
      { name: 'evidence', label: 'Evidence', type: 'textarea', required: true, note: 'What makes this true.' },
      ...extra,
    ],
  });

  const invoice: ActionSpec = {
    key: 'invoice',
    label: 'Raise the invoice',
    intent: 'Records a claim on the buyer. A claim is not money.',
    endpoint: '/api/deal/payment',
    body: { action: 'record', dealId: ctx.dealId, direction: 'INBOUND', kind: 'INVOICE' },
    authority: true,
    fields: [
      { name: 'amount', label: 'Amount', type: 'number', required: true },
      { name: 'reference', label: 'Invoice reference', required: true },
      { name: 'dueAt', label: 'Due', type: 'date' },
    ],
  };

  const settle: ActionSpec = {
    key: 'settle',
    label: 'Record money that arrived',
    intent: 'Settles a line. Only settled inbound money counts as collected.',
    endpoint: '/api/deal/payment',
    body: { action: 'settle' },
    authority: true,
    fields: [
      { name: 'paymentId', label: 'Which line', required: true, note: 'The payment id from the money panel.' },
      { name: 'settledAt', label: 'When it settled', type: 'date' },
      { name: 'reference', label: 'Reference' },
    ],
  };

  const providerInvoice: ActionSpec = {
    key: 'provider_invoice',
    label: 'Record what we owe the provider',
    intent: 'The outbound side. Collected gross profit is not real until this settles too.',
    endpoint: '/api/deal/payment',
    body: { action: 'record', dealId: ctx.dealId, direction: 'OUTBOUND', kind: 'INVOICE' },
    authority: true,
    fields: [
      { name: 'amount', label: 'Amount', type: 'number', required: true },
      { name: 'reference', label: 'Reference', required: true },
      { name: 'dueAt', label: 'Due', type: 'date' },
    ],
  };

  return {
    REQUIREMENT: [requirement],
    PROVIDER: [
      addProvider,
      advance('CONTACTED', 'Log a provider conversation', 'Records that somebody spoke to them.', []),
      advance('CAPABILITY_VERIFIED', 'Verify they can do it', 'Moves a name to a verified provider.', [
        { name: 'capabilityEvidence', label: 'How you know', type: 'textarea', required: true },
        { name: 'credentialsEvidence', label: 'Credentials seen', type: 'textarea' },
      ]),
      advance('AVAILABILITY_VERIFIED', 'Confirm they are free', 'Availability for the window this deal needs.', [
        { name: 'availableFrom', label: 'Free from', type: 'date' },
        { name: 'availableUntil', label: 'Free until', type: 'date' },
        { name: 'capacityNotes', label: 'Capacity', type: 'textarea' },
      ]),
      advance('REJECTED', 'Rule a provider out', 'Keeps the record of why, so nobody re-runs the same call.', [
        { name: 'rejectedReason', label: 'Why not', type: 'textarea', required: true },
      ]),
    ],
    PROVIDER_COST: [
      advance('COST_RECEIVED', 'Record a provider cost', 'A cost with an expiry. Without the expiry it is not usable.', [
        { name: 'costAmount', label: 'Cost', type: 'number', required: true },
        { name: 'costUnit', label: 'Per', placeholder: 'site, month, job' },
        { name: 'costBasis', label: 'What it covers', type: 'textarea' },
        { name: 'costExpiresAt', label: 'Good until', type: 'date', required: true, note: 'A cost with no expiry is a number nobody stands behind.' },
      ]),
    ],
    OFFER: ctx.quoteId && ctx.quoteState !== 'DRAFT' ? [quoteSend, quoteDraft] : [quoteDraft, ...(ctx.quoteId ? [quoteSend] : [])],
    COMMITMENTS: ctx.dealId ? [commitProvider, commitBuyer] : [commitBuyer],
    DELIVERY: [
      dealAdvance('IN_DELIVERY', 'Start delivery', 'The provider has begun.'),
      dealAdvance('DELIVERED', 'Mark delivered', 'The work is done and the buyer accepts it.'),
    ],
    INVOICE: [invoice],
    PAYMENT: [settle],
    COLLECTED_PROFIT: [providerInvoice, settle],
  };
}

export function DealActions({ context }: { context: DealActionContext }) {
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (!context.canWrite) {
    return (
      <div className="card" data-testid="deal-actions-readonly">
        <h2 style={{ marginTop: 0 }}>Moving this deal</h2>
        <p className="small muted">
          You can see where this deal has got to but not change it. Somebody with deal permissions has to
          take the next step.
        </p>
      </div>
    );
  }

  const byStage = specsFor(context);
  const suggested = context.nextStageKey ? byStage[context.nextStageKey] ?? [] : [];
  const everythingElse = Object.entries(byStage)
    .filter(([key]) => key !== context.nextStageKey)
    .flatMap(([, specs]) => specs);

  async function submit(spec: ActionSpec, form: HTMLFormElement) {
    setBusy(true); setError(null); setDone(null);
    try {
      const data = new FormData(form);
      const payload: Record<string, unknown> = { ...spec.body };
      for (const field of spec.fields) {
        const raw = data.get(field.name);
        if (raw === null || String(raw).trim() === '') continue;
        const value = String(raw).trim();
        if (field.type === 'number') payload[field.name] = Number(value);
        else if (field.name === 'confirmed') payload[field.name] = value.split(',').map((v) => v.trim()).filter(Boolean);
        else payload[field.name] = value;
      }
      const response = await fetch(spec.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body?.error ?? `That did not work (HTTP ${response.status}).`);
        return;
      }
      setDone(body?.message ?? 'Done.');
      setOpen(null);
      window.location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  const renderSpec = (spec: ActionSpec) => (
    <div key={spec.key} style={{ marginTop: '0.4rem' }}>
      <button
        className={spec.authority ? 'btn' : 'btn secondary'}
        data-testid={`action-${spec.key}`}
        onClick={() => { setOpen(open === spec.key ? null : spec.key); setError(null); }}
      >
        {spec.label}
      </button>
      {spec.authority && <span className="tiny dim"> · needs authority</span>}

      {open === spec.key && (
        <form
          className="mt"
          data-testid={`form-${spec.key}`}
          onSubmit={(e) => { e.preventDefault(); void submit(spec, e.currentTarget); }}
        >
          <p className="tiny dim">{spec.intent}</p>
          {spec.fields.map((field) => (
            <label className="field" key={field.name}>
              <span className="tiny dim">{field.label}{field.required ? ' *' : ''}</span>
              {field.type === 'textarea' ? (
                <textarea className="input" name={field.name} rows={2} required={field.required} data-testid={`field-${spec.key}-${field.name}`} />
              ) : field.type === 'select' ? (
                <select className="input" name={field.name} required={field.required} data-testid={`field-${spec.key}-${field.name}`} defaultValue="">
                  <option value="">—</option>
                  {(field.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : (
                <input
                  className="input"
                  name={field.name}
                  type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                  step={field.type === 'number' ? 'any' : undefined}
                  placeholder={field.placeholder}
                  required={field.required}
                  data-testid={`field-${spec.key}-${field.name}`}
                />
              )}
              {field.note && <span className="tiny dim">{field.note}</span>}
            </label>
          ))}
          <div className="row" style={{ gap: '0.4rem', marginTop: '0.5rem' }}>
            <button className="btn" type="submit" disabled={busy} data-testid={`submit-${spec.key}`}>
              {busy ? 'Saving…' : spec.label}
            </button>
            <button className="btn secondary" type="button" onClick={() => setOpen(null)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );

  return (
    <div className="card" data-testid="deal-actions">
      <h2 style={{ marginTop: 0 }}>Move this deal</h2>

      {error && <div className="alert danger small" data-testid="action-error">{error}</div>}
      {done && <div className="alert small" data-testid="action-done">{done}</div>}

      {suggested.length > 0 ? (
        <>
          <p className="tiny dim">The plan says this is what happens next.</p>
          <div data-testid="suggested-actions">{suggested.map(renderSpec)}</div>
        </>
      ) : (
        <p className="small muted" data-testid="no-suggested-action">
          {context.nextAction
            // The next rung is real but it is not moved from this screen — a
            // conversation, a contact lookup. Saying "nothing to do" here while
            // the plan above says otherwise is how two panels on one page end
            // up contradicting each other.
            ? <>The next step is not taken from this page: {context.nextAction.toLowerCase()} That is {context.nextOwner ?? 'somebody else'}&rsquo;s to do.</>
            : <>Nothing is waiting on us here. Anything still open is with the buyer or the provider.</>}
        </p>
      )}

      <details className="mt" data-testid="all-actions">
        <summary className="small">Everything else that can be done to this deal</summary>
        <p className="tiny dim">
          Deals go sideways. These are out of order on purpose, and every one of them still demands its evidence.
        </p>
        {everythingElse.map(renderSpec)}
      </details>
    </div>
  );
}
