import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { can } from '@/lib/auth/session';
import { requirePagePermission } from '@/lib/auth/page';
import { recommendExpansion, recommendWedge } from '@/lib/ai/vulnerability';
import { Badge, Empty, humanize, Meter, money, relativeDays, Stat } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function CompanyPage({ params }: { params: { id: string } }) {
  const user = await requirePagePermission('company.read');
  const showMoney = can(user, 'finance.margin.read');

  const company = await prisma.company.findFirst({
    where: { id: params.id, orgId: user.orgId },
    include: {
      locations: true,
      contacts: { orderBy: { influenceLevel: 'desc' } },
      capabilities: { include: { capability: true } },
      products: { include: { product: true } },
      industries: { include: { industry: true } },
      subCapacity: true,
      supplyOffers: true,
      buyerNeeds: true,
      relationshipsFrom: { include: { toCompany: true } },
      relationshipsTo: { include: { fromCompany: true } },
      opportunityParties: { include: { opportunity: true } },
      matchesAsCandidate: { include: { opportunity: true } },
      evidence: { orderBy: { discoveredAt: 'desc' }, take: 10 },
      signals: { orderBy: { observedAt: 'desc' }, take: 10 },
      activityEvents: { orderBy: { createdAt: 'desc' }, take: 15 },
    },
  });

  if (!company) notFound();

  const completedDeals = company.opportunityParties.filter((p) => p.opportunity.status === 'WON').length;
  const expansion = recommendExpansion({
    currentStage: company.accountStage,
    completedDeals,
    totalLocations: company.locations.length,
    servedLocations: completedDeals,
    categoriesServed: company.capabilities.length,
  });
  const wedge = recommendWedge(
    company.movability,
    company.movabilityReasons.map((r) => ({ key: r.split(':')[0].toLowerCase().replace(/\s+/g, '_') })),
    company.locations.length,
  );

  return (
    <>
      <div className="page-header">
        <div>
          <div className="row mb">
            <Badge>{humanize(company.companyRole)}</Badge>
            <Badge
              tone={
                company.movability === 'ACTIVELY_MOVABLE' ? 'success' : company.movability === 'CONDITIONALLY_MOVABLE' ? 'warning' : company.movability === 'RELATIONSHIP_LOCKED' ? 'danger' : ''
              }
            >
              {humanize(company.movability)}
            </Badge>
            <Badge tone="accent">{humanize(company.accountStage)}</Badge>
          </div>
          <h1>{company.legalName}</h1>
          <p>
            {company.website && (
              <a href={company.website} target="_blank" rel="noreferrer noopener">
                {company.website.replace(/^https?:\/\//, '')}
              </a>
            )}
            {company.description ? ` · ${company.description.slice(0, 180)}` : ''}
          </p>
        </div>
      </div>

      <div className="grid grid-4 mb">
        <Stat label="Movability" value={`${Math.round(company.movabilityScore * 100)}%`} sub={<Meter value={company.movabilityScore} />} />
        <Stat label="Relationship strength" value={`${Math.round(company.relationshipStrength * 100)}%`} sub={<Meter value={company.relationshipStrength} />} />
        <Stat label="Open opportunities" value={company.opportunityParties.filter((p) => !['WON', 'LOST', 'DISQUALIFIED'].includes(p.opportunity.status)).length} />
        <Stat label="Contacts" value={company.contacts.length} sub={`${company.contacts.filter((c) => c.consentToCall).length} callable`} />
        {showMoney && company.estimatedLifetimeValue && <Stat label="Lifetime value" value={money(company.estimatedLifetimeValue)} />}
        <Stat label="Last verified" value={company.lastVerifiedAt ? relativeDays(company.lastVerifiedAt) : 'never'} />
      </div>

      <div className="two-col">
        <div>
          <div className="card">
            <h2>Why this account is movable</h2>
            {company.movabilityReasons.length === 0 ? (
              <Empty>No vulnerability signals recorded. The first call should establish their current arrangement.</Empty>
            ) : (
              <ul className="checklist">
                {company.movabilityReasons.map((reason, index) => (
                  <li key={index} className="missing">
                    {reason}
                  </li>
                ))}
              </ul>
            )}
            <div className="alert info small mt">
              <strong>Recommended wedge:</strong> {wedge}
            </div>
            {expansion && (
              <div className="alert success small">
                <strong>Expansion — next stage {humanize(expansion.nextStage)}:</strong> {expansion.recommendation}
              </div>
            )}
          </div>

          <div className="card">
            <h2>Contacts</h2>
            {company.contacts.length === 0 ? (
              <Empty>No contacts. A research task is needed before anything can be called.</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Title</th>
                      <th>Authority</th>
                      <th>Phone</th>
                      <th>Consent</th>
                      <th>Last contact</th>
                    </tr>
                  </thead>
                  <tbody>
                    {company.contacts.map((contact) => (
                      <tr key={contact.id}>
                        <td>
                          {contact.firstName} {contact.lastName}
                        </td>
                        <td className="small">{contact.title ?? '—'}</td>
                        <td className="small">{humanize(contact.decisionAuthority)}</td>
                        <td className="mono">{contact.phone ?? '—'}</td>
                        <td>
                          <Badge tone={contact.consentToCall ? 'success' : 'danger'}>{contact.consentToCall ? 'callable' : 'suppressed'}</Badge>
                        </td>
                        <td className="tiny dim">{contact.lastInteractionAt ? relativeDays(contact.lastInteractionAt) : 'never'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="card">
            <h2>Capabilities and supply</h2>
            <div className="grid grid-2">
              <div>
                <h4>Capabilities</h4>
                {company.capabilities.length === 0 ? (
                  <div className="small muted">None recorded.</div>
                ) : (
                  <ul className="checklist">
                    {company.capabilities.map((capability) => (
                      <li key={capability.id} className={capability.status === 'CONFIRMED' ? 'done' : ''}>
                        {capability.capability.name} <span className="tiny dim">({humanize(capability.status)})</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <h4>Territories</h4>
                <div className="small">{company.serviceTerritories.join(', ') || <span className="muted">Not documented</span>}</div>
                <h4 className="mt">Certifications</h4>
                <div className="small">{company.certifications.join(', ') || <span className="muted">None</span>}</div>
                <h4 className="mt">Insurance on file</h4>
                <div className="small mono">{JSON.stringify(company.insurance)}</div>
              </div>
            </div>

            {company.subCapacity.length > 0 && (
              <>
                <h4 className="mt">Subcontractor capacity</h4>
                {company.subCapacity.map((capacity) => (
                  <div key={capacity.id} className="small">
                    {capacity.crewCount ?? '?'} crew(s) · territories {capacity.territories.join(', ') || '?'} · minimum{' '}
                    {money(capacity.minimumContract)} · shifts {capacity.shiftAvailability.join(', ') || '?'} ·{' '}
                    <Badge tone={capacity.status === 'CONFIRMED' ? 'success' : 'warning'}>{humanize(capacity.status)}</Badge>
                  </div>
                ))}
              </>
            )}

            {company.supplyOffers.length > 0 && (
              <>
                <h4 className="mt">Available supply</h4>
                {company.supplyOffers.map((supply) => (
                  <div key={supply.id} className="small">
                    {supply.description} · {supply.quantity ? `${supply.quantity} ${supply.unit ?? ''}` : 'quantity unknown'} ·{' '}
                    {showMoney && supply.unitCost ? `${money(supply.unitCost)}/${supply.unit ?? 'unit'}` : ''} ·{' '}
                    <Badge tone={supply.status === 'CONFIRMED' ? 'success' : 'warning'}>{humanize(supply.status)}</Badge>
                    {supply.staleAfter && supply.staleAfter < new Date() && <Badge tone="danger">stale</Badge>}
                  </div>
                ))}
              </>
            )}
          </div>

          <div className="card">
            <h2>Opportunities</h2>
            {company.opportunityParties.length === 0 && company.matchesAsCandidate.length === 0 ? (
              <Empty>Not involved in any opportunity yet.</Empty>
            ) : (
              <ul className="list-reset">
                {company.opportunityParties.map((party) => (
                  <li key={party.id} style={{ padding: '0.35rem 0', borderBottom: '1px solid var(--border)' }}>
                    <Link href={`/opportunities/${party.opportunityId}`} className="small">
                      {party.opportunity.name}
                    </Link>{' '}
                    <Badge>{humanize(party.role)}</Badge> <Badge>{humanize(party.opportunity.status)}</Badge>
                  </li>
                ))}
                {company.matchesAsCandidate.map((match) => (
                  <li key={match.id} style={{ padding: '0.35rem 0', borderBottom: '1px solid var(--border)' }}>
                    <Link href={`/opportunities/${match.opportunityId}`} className="small">
                      {match.opportunity.name}
                    </Link>{' '}
                    <Badge tone="accent">candidate {Math.round(match.score * 100)}%</Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div>
          <div className="card">
            <h2>Relationships</h2>
            {company.relationshipsFrom.length === 0 && company.relationshipsTo.length === 0 ? (
              <Empty>No known relationships.</Empty>
            ) : (
              <ul className="list-reset">
                {company.relationshipsFrom.map((relationship) => (
                  <li key={relationship.id} className="small" style={{ padding: '0.3rem 0' }}>
                    {humanize(relationship.kind)} →{' '}
                    <Link href={`/companies/${relationship.toCompanyId}`}>{relationship.toCompany.legalName}</Link>{' '}
                    <span className="tiny dim">({humanize(relationship.status)})</span>
                  </li>
                ))}
                {company.relationshipsTo.map((relationship) => (
                  <li key={relationship.id} className="small" style={{ padding: '0.3rem 0' }}>
                    <Link href={`/companies/${relationship.fromCompanyId}`}>{relationship.fromCompany.legalName}</Link> →{' '}
                    {humanize(relationship.kind)} <span className="tiny dim">({humanize(relationship.status)})</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card">
            <h2>Locations</h2>
            <ul className="list-reset">
              {company.locations.map((location) => (
                <li key={location.id} className="small" style={{ padding: '0.25rem 0' }}>
                  {location.label}: {[location.line1, location.city, location.state, location.postalCode].filter(Boolean).join(', ')}
                </li>
              ))}
            </ul>
          </div>

          <div className="card">
            <h2>Source evidence</h2>
            {company.evidence.length === 0 ? (
              <Empty>No evidence on file.</Empty>
            ) : (
              <ul className="timeline">
                {company.evidence.map((evidence) => (
                  <li key={evidence.id}>
                    <time>
                      {humanize(evidence.sourceType)} · {evidence.discoveredAt.toISOString().slice(0, 10)} ·{' '}
                      {humanize(evidence.status)}
                    </time>
                    <div className="small">{evidence.title}</div>
                    {evidence.sourceUrl && (
                      <a href={evidence.sourceUrl} className="tiny" target="_blank" rel="noreferrer noopener">
                        {evidence.sourceUrl}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card">
            <h2>Signals</h2>
            <ul className="timeline">
              {company.signals.map((signal) => (
                <li key={signal.id}>
                  <time>
                    {relativeDays(signal.observedAt)} · {humanize(signal.status)}
                  </time>
                  <div className="small">{signal.headline}</div>
                </li>
              ))}
            </ul>
          </div>

          <div className="card">
            <h2>Activity</h2>
            <ul className="timeline">
              {company.activityEvents.map((event) => (
                <li key={event.id}>
                  <time>{relativeDays(event.createdAt)}</time>
                  <div className="small">{event.summary}</div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </>
  );
}
