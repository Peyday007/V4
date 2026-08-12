import Link from 'next/link';
import type { DealRecord } from '@/lib/deal/record';
import { Badge } from '@/components/ui';

/**
 * The deal panels on the opportunity record.
 *
 * Read-mostly by design. The actions that change a deal all demand evidence,
 * and evidence is not something to collect through a row of buttons — the
 * buttons here start those flows, and the flows refuse without the evidence.
 *
 * The thing this component is most careful about is language. A provider
 * candidate never renders in the same visual register as a committed one, an
 * estimate never renders as money, and every number carries the label of where
 * it came from. Somebody skim-reading this page under time pressure must not be
 * able to come away believing a deal is further along than it is.
 */

function currency(value: unknown, fallback = '—'): string {
  if (value === null || value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function day(value: Date | string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toISOString().slice(0, 10);
}

export function DealProgress({ record, canSeeMargin }: { record: DealRecord; canSeeMargin: boolean }) {
  return (
    <>
      <div className="grid grid-2">
        <BuyerPanel record={record} />
        <SupplyPanel record={record} />
      </div>
      <div className="grid grid-2">
        <QuotePanel record={record} canSeeMargin={canSeeMargin} />
        <MoneyPanel record={record} canSeeMargin={canSeeMargin} />
      </div>
      <RoomPanel record={record} />
      <TrailPanel record={record} />
    </>
  );
}

function BuyerPanel({ record }: { record: DealRecord }) {
  const { current, history, ready, missing, headline, confirmed } = record.requirement;

  return (
    <div className="card" data-testid="buyer-panel">
      <h2 style={{ marginTop: 0 }}>What the buyer asked for</h2>
      <p className="tiny dim">{headline}</p>

      {!current ? (
        <p className="small muted">
          Nothing yet. This gets recorded automatically from the first call where somebody describes what they need.
        </p>
      ) : (
        <table className="table tiny">
          <tbody>
            <Field label="Summary" value={current.summary} confirmed={confirmed.includes('summary')} />
            <Field label="Specification" value={current.specification} confirmed={confirmed.includes('specification')} />
            <Field label="Quantity" value={current.quantity} confirmed={confirmed.includes('quantity')} />
            <Field label="Frequency" value={current.frequency} confirmed={confirmed.includes('frequency')} />
            <Field label="Locations" value={current.locations} confirmed={confirmed.includes('locations')} />
            <Field label="Timing" value={current.timingNote} confirmed={confirmed.includes('timingNote')} />
            <Field label="Incumbent" value={current.incumbent} confirmed={confirmed.includes('incumbent')} />
            <Field label="Who decides" value={current.decisionMakerRole} confirmed={current.authorityConfirmed} />
            <Field
              label="Budget"
              value={current.budgetMechanism === 'UNKNOWN' ? null : current.budgetMechanism.toLowerCase().replace(/_/g, ' ')}
              confirmed={confirmed.includes('budgetMechanism')}
            />
          </tbody>
        </table>
      )}

      {current && current.constraints.length > 0 && (
        <>
          <h3>Constraints they named</h3>
          <ul className="list-reset small muted" style={{ lineHeight: 1.7 }}>
            {current.constraints.map((c) => <li key={c}>· {c}</li>)}
          </ul>
        </>
      )}

      <h3>Ready to price</h3>
      {ready ? (
        <p className="small muted">Yes — enough is known to put a price against this.</p>
      ) : (
        <>
          <p className="tiny dim">Not yet. A price sent against an assumed scope is our guess with a number on it.</p>
          <ul className="list-reset small muted" style={{ lineHeight: 1.7 }}>
            {missing.map((m) => <li key={m}>· {m}</li>)}
          </ul>
        </>
      )}

      {history.length > 0 && (
        <div className="tiny dim mt">
          {history.length} earlier version{history.length === 1 ? '' : 's'} kept:{' '}
          {history.map((h) => `v${h.version} (${h.state.toLowerCase()})`).join(', ')}. Nothing is overwritten.
        </div>
      )}
    </div>
  );
}

function Field({ label, value, confirmed }: { label: string; value: string | null; confirmed: boolean }) {
  return (
    <tr>
      <td style={{ whiteSpace: 'nowrap' }}><strong>{label}</strong></td>
      <td>
        {value ?? <span className="dim">not known</span>}
        {value && (
          <div className="tiny dim">
            {confirmed ? 'they said this' : 'our inference — not confirmed by them'}
          </div>
        )}
      </td>
    </tr>
  );
}

function SupplyPanel({ record }: { record: DealRecord }) {
  const { candidates, secured, headline, staleCostIds, overduePromiseIds } = record.supply;

  return (
    <div className="card" data-testid="supply-panel">
      <h2 style={{ marginTop: 0 }}>Who would actually do the work</h2>
      <p className="tiny dim">{headline}</p>

      {!secured && candidates.length > 0 && (
        <div className="alert warning small" data-testid="not-secured">
          Fulfilment is not secured. Nothing below is a promise anybody has made to us.
        </div>
      )}

      {candidates.length === 0 ? (
        <p className="small muted">
          No provider candidate. The demand is still real — this is a supply gap, and a sourcing task has been raised
          against it rather than the opportunity being dropped.
        </p>
      ) : (
        <table className="table tiny">
          <thead>
            <tr><th>Provider</th><th>State</th><th>Cost</th></tr>
          </thead>
          <tbody>
            {candidates.map((c) => (
              <tr key={c.id}>
                <td>
                  {c.providerName}
                  {c.conflictNote && <div className="tiny dim" data-testid="conflict-note">⚠ {c.conflictNote}</div>}
                </td>
                <td>
                  <Badge tone={c.state === 'COMMITTED' ? 'success' : c.state === 'REJECTED' || c.state === 'WITHDRAWN' ? 'muted' : 'warning'}>
                    {c.label}
                  </Badge>
                  <div className="tiny dim">{c.meaning}</div>
                </td>
                <td>
                  {c.costAmount === null ? <span className="dim">none</span> : currency(c.costAmount)}
                  {c.costAmount !== null && (
                    <div className="tiny dim">
                      {c.costExpiresAt === null
                        ? 'no expiry recorded — treat as unverified'
                        : c.costUsable
                          ? `holds until ${day(c.costExpiresAt)}`
                          : `expired ${day(c.costExpiresAt)}`}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {staleCostIds.length > 0 && (
        <div className="alert small mt">
          {staleCostIds.length} provider cost{staleCostIds.length === 1 ? '' : 's'} passed the expiry date. Any price
          built on those is out of date.
        </div>
      )}
      {overduePromiseIds.length > 0 && (
        <div className="alert small mt">
          {overduePromiseIds.length} provider promise{overduePromiseIds.length === 1 ? '' : 's'} now overdue.
        </div>
      )}
    </div>
  );
}

function QuotePanel({ record, canSeeMargin }: { record: DealRecord; canSeeMargin: boolean }) {
  const { live, history, basisLabel, blocking, headline } = record.quotes;

  return (
    <div className="card" data-testid="quote-panel">
      <h2 style={{ marginTop: 0 }}>Price</h2>
      <p className="tiny dim">{headline}</p>

      {!live ? (
        <p className="small muted">
          No live price. Pricing needs a current buyer requirement and a provider cost behind it.
        </p>
      ) : (
        <>
          {blocking.length > 0 && (
            <div className="alert warning small" data-testid="approval-block">
              <strong>Held for an owner decision.</strong>
              <ul className="list-reset" style={{ lineHeight: 1.6 }}>
                {blocking.map((a) => (
                  <li key={a.id}>
                    · {a.title} — {a.summary}
                    {a.status !== 'PENDING' && <> <Badge tone="danger">{a.status.toLowerCase()}</Badge></>}
                  </li>
                ))}
              </ul>
              <Link href="/approvals" className="tiny">Open the approvals queue →</Link>
            </div>
          )}

          <table className="table tiny">
            <tbody>
              <tr><td><strong>Version</strong></td><td>v{live.version} · {live.state.toLowerCase().replace(/_/g, ' ')}</td></tr>
              <tr>
                <td><strong>Basis</strong></td>
                <td>{basisLabel}<div className="tiny dim">confidence: {live.confidence.toLowerCase()}</div></td>
              </tr>
              <tr><td><strong>Buyer price</strong></td><td>{currency(live.buyerPrice)}</td></tr>
              {canSeeMargin && (
                <>
                  <tr>
                    <td><strong>Provider cost</strong></td>
                    <td>
                      {live.costSideMissing
                        ? <span className="dim">none — the margin on this is unknown, not thin</span>
                        : currency(live.providerCost)}
                    </td>
                  </tr>
                  <tr>
                    <td><strong>Gross profit</strong></td>
                    <td>
                      {live.grossProfit === null
                        ? <span className="dim">cannot be calculated</span>
                        : <>{currency(live.grossProfit)}{live.grossMarginPct !== null && ` (${live.grossMarginPct.toFixed(1)}%)`}</>}
                      <div className="tiny dim">estimated, not realised</div>
                    </td>
                  </tr>
                  <tr>
                    <td><strong>Our cash at risk</strong></td>
                    <td>
                      {live.workingCapitalAmount === null
                        ? <span className="dim">not sized</span>
                        : <>{currency(live.workingCapitalAmount)}{live.workingCapitalDays !== null && ` for ~${live.workingCapitalDays} days`}</>}
                    </td>
                  </tr>
                </>
              )}
              <tr><td><strong>Terms</strong></td><td>{live.paymentTerms ?? <span className="dim">not agreed</span>}</td></tr>
              <tr><td><strong>Valid until</strong></td><td>{day(live.validUntil)}</td></tr>
            </tbody>
          </table>

          {live.assumptions.length > 0 && (
            <>
              <h3>What this price assumes</h3>
              <ul className="list-reset small muted" style={{ lineHeight: 1.7 }}>
                {live.assumptions.map((a) => <li key={a}>· {a}</li>)}
              </ul>
            </>
          )}
          {live.downsideNotes && (
            <>
              <h3>Downside</h3>
              <p className="small muted">{live.downsideNotes}</p>
            </>
          )}
        </>
      )}

      {history.length > 0 && (
        <div className="tiny dim mt">
          {history.length} earlier version{history.length === 1 ? '' : 's'}:{' '}
          {history.map((h) => `v${h.version} ${h.state.toLowerCase()}${h.buyerPrice ? ` at ${currency(h.buyerPrice)}` : ''}`).join(', ')}.
        </div>
      )}
    </div>
  );
}

function MoneyPanel({ record, canSeeMargin }: { record: DealRecord; canSeeMargin: boolean }) {
  const { record: deal, money, headline } = record.deal;

  return (
    <div className="card" data-testid="money-panel">
      <h2 style={{ marginTop: 0 }}>Commitment, delivery and money</h2>
      <p className="tiny dim">{headline}</p>

      {!deal ? (
        <p className="small muted">
          Nobody has committed to anything. A deal opens when the buyer accepts a price, with a basis and evidence
          recorded against it.
        </p>
      ) : (
        <>
          <table className="table tiny">
            <tbody>
              <tr>
                <td><strong>Buyer committed</strong></td>
                <td>
                  {day(deal.buyerCommittedAt)} · {deal.buyerCommitmentBasis.toLowerCase().replace(/_/g, ' ')}
                  <div className="tiny dim">{deal.buyerCommitmentEvidence}</div>
                </td>
              </tr>
              <tr>
                <td><strong>Provider committed</strong></td>
                <td>
                  {deal.providerCommittedAt
                    ? <>{day(deal.providerCommittedAt)} · {deal.providerCommitmentBasis?.toLowerCase().replace(/_/g, ' ')}</>
                    : <span className="dim">not yet — we owe the buyer work nobody has agreed to do</span>}
                </td>
              </tr>
              <tr><td><strong>Delivered</strong></td><td>{deal.deliveryCompletedAt ? day(deal.deliveryCompletedAt) : <span className="dim">no</span>}</td></tr>
              {canSeeMargin && money && (
                <>
                  <tr><td><strong>Invoiced</strong></td><td>{currency(money.invoiced)}<div className="tiny dim">a claim, not money</div></td></tr>
                  <tr><td><strong>Collected</strong></td><td>{currency(money.collected)}</td></tr>
                  <tr><td><strong>Paid out</strong></td><td>{currency(money.paidOut)}</td></tr>
                  <tr>
                    <td><strong>Collected gross profit</strong></td>
                    <td data-testid="collected-gp">
                      {currency(money.collectedGrossProfit)}
                      <div className="tiny dim">settled money only — the only profit figure here that is not an estimate</div>
                    </td>
                  </tr>
                </>
              )}
            </tbody>
          </table>

          {deal.milestones.length > 0 && (
            <>
              <h3>Milestones</h3>
              <ul className="list-reset small muted" style={{ lineHeight: 1.7 }}>
                {deal.milestones.map((m) => (
                  <li key={m.id}>
                    · {m.label} — {m.completedAt ? `done ${day(m.completedAt)}` : m.dueAt ? `due ${day(m.dueAt)}` : 'no date'}
                    {m.evidence && <div className="tiny dim" style={{ paddingLeft: '0.8rem' }}>{m.evidence}</div>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The prospect-facing page, and what they did with it.
 *
 * The token is not on this screen and is not in the data behind it. It is
 * returned once, to the person who creates the room, and an owner page carrying
 * it is one screenshot away from being a public one.
 */
function RoomPanel({ record }: { record: DealRecord }) {
  const { room } = record;

  return (
    <div className="card" data-testid="room-panel">
      <h2 style={{ marginTop: 0 }}>Deal room</h2>
      <p className="tiny dim">{room.headline}</p>

      {!room.exists ? (
        <p className="small muted">
          Nothing has been put in front of this prospect. A room is built from the dated event, what they have told
          us, and the smallest reversible step we could actually deliver — so it can only be created once there is
          something real to say.
        </p>
      ) : (
        <>
          <table className="table tiny">
            <tbody>
              <tr><td><strong>State</strong></td><td>{room.state?.toLowerCase()}</td></tr>
              <tr><td><strong>Offering</strong></td><td>{room.proofStep?.toLowerCase().replace(/_/g, ' ')}</td></tr>
              <tr>
                <td><strong>Sent</strong></td>
                <td>{room.sentAt ? day(room.sentAt) : <span className="dim">not sent</span>}</td>
              </tr>
              <tr>
                <td><strong>Opened</strong></td>
                <td>
                  {room.firstOpenAt
                    ? <>{day(room.firstOpenAt)} · {room.openCount} time{room.openCount === 1 ? '' : 's'}</>
                    : <span className="dim">not opened</span>}
                  <div className="tiny dim">Automated fetches are recorded separately and never counted here.</div>
                </td>
              </tr>
              <tr><td><strong>Expires</strong></td><td>{day(room.expiresAt)}</td></tr>
            </tbody>
          </table>

          {room.responseNote && (
            <>
              <h3>What they wrote back</h3>
              <p className="small muted">{room.responseNote}</p>
            </>
          )}

          {room.engagement.length > 0 && (
            <>
              <h3>Engagement</h3>
              <table className="table tiny">
                <tbody>
                  {room.engagement.map((e, index) => (
                    <tr key={`${e.kind}-${index}`}>
                      <td style={{ whiteSpace: 'nowrap' }} className="dim">{day(e.occurredAt)}</td>
                      <td><code>{e.kind.toLowerCase()}</code>{e.agent && e.agent !== 'human' && <span className="dim"> ({e.agent})</span>}</td>
                      <td>{e.detail ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}

      <p className="tiny dim mt">
        <Link href={`/demand/opportunity/${record.routeId}/room`}>Preview exactly what they see →</Link>
      </p>
    </div>
  );
}

function TrailPanel({ record }: { record: DealRecord }) {
  if (record.events.length === 0) return null;

  return (
    <div className="card" data-testid="deal-trail">
      <h2 style={{ marginTop: 0 }}>What happened, in order</h2>
      <p className="tiny dim">
        Append-only. Written in the same transaction as the change it describes, so nothing here can disagree with the
        record it belongs to.
      </p>
      <table className="table tiny">
        <tbody>
          {record.events.map((e) => (
            <tr key={e.id}>
              <td style={{ whiteSpace: 'nowrap' }} className="dim">{day(e.occurredAt)}</td>
              <td style={{ whiteSpace: 'nowrap' }}><code>{e.kind}</code></td>
              <td>{e.summary}<div className="tiny dim">by {e.actorType}</div></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
