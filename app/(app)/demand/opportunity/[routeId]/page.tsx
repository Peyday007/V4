import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { requirePagePermission } from '@/lib/auth/page';
import { loadOpportunityRecord } from '@/lib/demand/opportunityRecord';
import { loadDealRecord } from '@/lib/deal/record';
import { DealProgress } from '@/components/DealProgress';
import { OpportunityStanding } from '@/components/OpportunityStanding';
import { buildOpportunityView } from '@/lib/deal/opportunityView';
import { loadDealPlan } from '@/lib/deal/plan';
import { DealActions } from '@/components/DealActions';
import { can } from '@/lib/auth/session';
import { Badge } from '@/components/ui';
import { ClaimLedger, ContradictionAlert } from '@/components/ClaimLedger';
import { currentClaims } from '@/lib/evidence/ledger';

export const dynamic = 'force-dynamic';

function humanise(value: string): string {
  return value.toLowerCase().replace(/_/g, ' ');
}

/**
 * The canonical opportunity record.
 *
 * Assembled, not summarised. Every section below is a set of rows that already
 * existed somewhere, and the five categories are kept apart structurally rather
 * than by styling — because "confirmed by the source", "confirmed by a person",
 * "calculated", "our hypothesis" and "unknown" are the difference between a
 * record somebody can act on and a paragraph that reads well.
 */
export default async function OpportunityRecordPage({ params }: { params: { routeId: string } }) {
  const user = await requirePagePermission('discovery.read');
  const record = await loadOpportunityRecord({ orgId: user.orgId, routeId: params.routeId });
  if (!record) notFound();

  // Loaded after the record exists, so a bad route id is a 404 rather than an
  // empty deal panel on a page for an opportunity that is not on this account.
  const deal = await loadDealRecord({ orgId: user.orgId, routeId: params.routeId });

  // The chain, decided from the record that was just loaded. Everything below
  // the plan is evidence for it rather than a second opinion.
  const plan = await loadDealPlan({ orgId: user.orgId, routeId: params.routeId, record: deal });

  // Two fields the assembled record does not carry, read directly rather than
  // threaded through two layers that have no other use for them.
  const routeFields = await prisma.routeHypothesis.findFirst({
    where: { id: params.routeId, orgId: user.orgId },
    select: { friction: true, requiredCapability: true },
  });

  // The ledger. Everything this system claims about the deal, and what each
  // claim rests on — read here rather than reconstructed from side channels on
  // the way to the screen.
  const claims = await currentClaims(params.routeId);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>{record.organisation}</h1>
          <p>
            {record.location ?? 'location unknown'} · {humanise(record.standing.tier)} ·{' '}
            {humanise(record.standing.status)}
            {record.standing.assignedTo && <> · being worked by {record.standing.assignedTo}</>}
          </p>
        </div>
        <Link href="/demand" className="btn secondary">Back to the board</Link>
      </div>

      {record.standing.statusReason && <div className="alert small">{record.standing.statusReason}</div>}

      {/* Standing, the one blocker, the money path, the two tracks and the
          plan — in that order, because that is the order somebody working the
          deal needs them in. Every value has been through the evidence test on
          the server, so nothing here can print a number that is not supported. */}
      {plan && (
        <OpportunityStanding
          {...buildOpportunityView({
            organisation: record.organisation,
            plan,
            record: deal,
            closedComparables: 0,
            // Fields the explanations read, so "strong trigger" can be
            // explained as this record's strong trigger rather than as a
            // definition of the phrase.
            tier: record.standing.tier,
            friction: routeFields?.friction ?? null,
            requiredCapability: routeFields?.requiredCapability ?? null,
            sourceUrl: record.event.sourceUrl,
          })}
        />
      )}

      {/* A disagreement between two sources sits above the actions, because it
          makes every action below it unsafe and it is settled by one call. */}
      <ContradictionAlert claims={claims} />

      <DealActions
        context={{
          routeId: params.routeId,
          quoteId: deal.quotes.live?.id ?? null,
          quoteState: deal.quotes.live?.state ?? null,
          dealId: deal.deal.record?.id ?? null,
          candidates: deal.supply.candidates.map((c) => ({
            id: c.id, name: c.providerName, state: c.state,
          })),
          // The action offered first is the one the plan says is next, so the
          // screen and the instruction above it cannot disagree.
          nextStageKey: plan?.firstBroken?.key ?? null,
          nextAction: plan?.firstBroken?.nextAction ?? null,
          nextOwner: plan?.firstBroken?.owner ?? null,
          canWrite: can(user, 'deal.write'),
          canSend: can(user, 'document.send'),
        }}
      />

      <DealProgress record={deal} canSeeMargin={can(user, 'finance.margin.read')} />

      <ClaimLedger claims={claims} />

      <details className="card" data-testid="evidence-detail">
        <summary>
          <strong>Why we believe any of this</strong>
          <span className="tiny dim"> — the source, what a person confirmed, our hypothesis, and the gaps</span>
        </summary>

      <div className="grid grid-2">
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Confirmed by the source</h2>
          <p className="tiny dim">{record.event.label} · {record.event.connector}
            {record.event.externalDate && <> · {record.event.externalDate.slice(0, 10)}</>}
          </p>
          {record.confirmedBySource.length === 0 ? (
            <p className="small muted">The source stated nothing beyond the event itself.</p>
          ) : (
            <ul className="list-reset small muted" style={{ lineHeight: 1.7 }}>
              {record.confirmedBySource.map((f) => <li key={f}>· {f}</li>)}
            </ul>
          )}
          <div className="tiny dim mt">
            First seen by us {record.event.firstSeenByUs.slice(0, 10)} — our timestamp, not an event.
            {record.event.sourceUrl && (
              <> · <a href={record.event.sourceUrl} target="_blank" rel="noreferrer noopener">open the record ↗</a></>
            )}
          </div>
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>Confirmed by a person</h2>
          {record.confirmedByPerson.length === 0 ? (
            <p className="small muted">
              Nobody has told us anything yet. Everything below the source line is still our hypothesis.
            </p>
          ) : (
            <table className="table tiny">
              <tbody>
                {record.confirmedByPerson.map((c) => (
                  <tr key={c.field}>
                    <td style={{ whiteSpace: 'nowrap' }}><strong>{c.field}</strong></td>
                    <td>
                      {c.value}
                      <div className="dim">{c.by ?? 'unattributed'} · {c.on.slice(0, 10)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Our hypothesis</h2>
          <p className="tiny dim">Ours, not theirs. Nothing here has been confirmed by anybody.</p>
          <ul className="list-reset small muted" style={{ lineHeight: 1.7 }}>
            {record.inferred.map((i) => <li key={i}>· {i}</li>)}
          </ul>

          <h3>Calculated</h3>
          {record.calculated.length === 0 ? (
            <p className="tiny dim">Nothing can be calculated yet.</p>
          ) : (
            record.calculated.map((c) => (
              <div key={c.label} className="small muted" style={{ lineHeight: 1.6 }}>
                <strong>{c.label}:</strong> {c.value}
                <div className="tiny dim">from {c.from}</div>
              </div>
            ))
          )}
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>Unknown, and blocking</h2>
          <p className="tiny dim">A gap nobody names is a gap nobody goes and closes.</p>
          {record.unknown.length === 0 ? (
            <p className="small muted">Nothing outstanding.</p>
          ) : (
            <ul className="list-reset small muted" style={{ lineHeight: 1.7 }}>
              {record.unknown.map((u) => <li key={u}>· {u}</li>)}
            </ul>
          )}

          <h3>Supply</h3>
          <div className="small muted">
            {record.supply.secured
              ? <Badge tone="success">verified provider</Badge>
              : <Badge tone="warning">{record.supply.providerCount > 0 ? 'candidate only' : 'nobody yet'}</Badge>}
            <div className="tiny dim mt">{record.supply.reason ?? 'Not assessed.'}</div>
          </div>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Contact, and where it came from</h2>
        {record.contacts.phone ? (
          <p className="small">
            <strong>{record.contacts.phone}</strong>{' '}
            <Badge tone={record.contacts.confidence === 'VERIFIED' ? 'success' : 'warning'}>
              {humanise(record.contacts.confidence ?? 'unverified')}
            </Badge>
          </p>
        ) : (
          <p className="small muted">{record.contacts.blocker ?? 'No contact route yet.'}</p>
        )}
        {record.contacts.provenance.length > 0 && (
          <table className="table tiny">
            <thead><tr><th>Field</th><th>Value</th><th>Source</th><th>How</th><th>Retrieved</th></tr></thead>
            <tbody>
              {record.contacts.provenance.map((p) => (
                <tr key={`${p.field}:${p.value}`} style={p.superseded ? { opacity: 0.5 } : undefined}>
                  <td>{p.field}</td>
                  <td>{p.value}{p.superseded && <span className="dim"> · superseded</span>}</td>
                  <td className="dim">{humanise(p.source)}</td>
                  <td className="dim">{p.matchMethod ?? '—'}</td>
                  <td className="dim">{p.retrievedAt.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      </details>

      {record.siblingRoutes.length > 0 && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Other routes on this account</h2>
          <p className="tiny dim">One business, several commercial routes. Not several businesses.</p>
          <ul className="list-reset small muted" style={{ lineHeight: 1.7 }}>
            {record.siblingRoutes.map((s) => (
              <li key={s.routeId}>
                · <Link href={`/demand/opportunity/${s.routeId}`}>{s.headline}</Link>{' '}
                <span className="dim">({humanise(s.status)})</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Everything that happened</h2>
        <p className="tiny dim">Append-only. Nothing here is ever edited or removed.</p>
        <table className="table tiny">
          <tbody>
            {record.timeline.map((entry, index) => (
              <tr key={`${entry.at}-${index}`}>
                <td style={{ whiteSpace: 'nowrap' }} className="dim">{entry.at.slice(0, 10)}</td>
                <td><Badge>{entry.kind}</Badge></td>
                <td>
                  {entry.summary}
                  {entry.detail && <div className="dim" style={{ lineHeight: 1.5 }}>{entry.detail}</div>}
                </td>
                <td className="dim">{entry.actor ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
