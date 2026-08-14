import Link from 'next/link';
import { notFound } from 'next/navigation';
import { num, num0, prisma } from '@/lib/db';
import { can, requireUser } from '@/lib/auth/session';
import { getOrgConfig } from '@/lib/config';
import { ActionButton } from '@/components/ActionButton';
import { Badge, Empty, humanize, money } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Comparison workbench. Ranks candidates side by side and — more usefully —
 * calls out what is missing, stale, unverified or anomalous, since those are
 * what actually sink a deal after the fact.
 */
export default async function ComparePage({ params }: { params: { opportunityId: string } }) {
  const user = await requireUser();
  const showMoney = can(user, 'finance.margin.read');

  const opportunity = await prisma.opportunity.findFirst({
    where: { id: params.opportunityId, orgId: user.orgId },
    include: {
      buyerNeed: true,
      matches: {
        include: {
          candidate: { include: { locations: true, subCapacity: true, supplyOffers: true } },
          supply: true,
          capacity: true,
        },
        orderBy: { score: 'desc' },
      },
    },
  });

  if (!opportunity) notFound();
  const config = await getOrgConfig(user.orgId);
  const matches = opportunity.matches;

  const costs = matches.map((m) => num(m.estimatedCost)).filter((c): c is number => c !== null);
  const lowestCost = costs.length ? Math.min(...costs) : null;
  const highestCost = costs.length ? Math.max(...costs) : null;
  const medianCost = costs.length ? [...costs].sort((a, b) => a - b)[Math.floor(costs.length / 2)] : null;

  const bestOverall = matches[0] ?? null;
  const bestMargin = [...matches].sort((a, b) => num0(b.estimatedGrossProfit) - num0(a.estimatedGrossProfit))[0] ?? null;
  const lowestRisk = [...matches].sort((a, b) => a.fulfillmentRisk - b.fulfillmentRisk)[0] ?? null;
  const fastest = [...matches].sort(
    (a, b) => (a.supply?.leadTimeDays ?? 999) - (b.supply?.leadTimeDays ?? 999),
  )[0] ?? null;

  /** Anomalies a human should look at before choosing. */
  function anomalies(match: (typeof matches)[number]): string[] {
    const flags: string[] = [];
    const cost = num(match.estimatedCost);

    if (cost === null) flags.push('No price on file — cannot be compared on cost');
    if (cost !== null && medianCost !== null && medianCost > 0) {
      const deviation = ((cost - medianCost) / medianCost) * 100;
      if (deviation < -25) flags.push(`Priced ${Math.abs(deviation).toFixed(0)}% below the median — verify the scope matches`);
      if (deviation > 30) flags.push(`Priced ${deviation.toFixed(0)}% above the median`);
    }
    if (match.supply?.staleAfter && match.supply.staleAfter < new Date()) {
      flags.push(`Quote expired ${match.supply.staleAfter.toISOString().slice(0, 10)} — re-confirm before use`);
    }
    if (match.capacity?.staleAfter && match.capacity.staleAfter < new Date()) {
      flags.push('Capacity data is stale');
    }
    if (match.missingInformation.some((m) => /insurance|certificate/i.test(m))) flags.push('Insurance unverified — compliance gap');
    if (match.missingInformation.some((m) => /licen/i.test(m))) flags.push('Licensing unverified — compliance gap');
    if (match.missingInformation.some((m) => /freight/i.test(m))) flags.push('Freight not quoted — delivered cost unknown');
    if (match.capacity && match.capacity.status !== 'CONFIRMED') flags.push('Capacity is claimed, not confirmed');
    if (match.supply && match.supply.status !== 'CONFIRMED') flags.push('Availability is claimed, not confirmed');

    const gp = num(match.estimatedGrossProfit);
    const revenue = num(match.estimatedRevenue);
    if (gp !== null && revenue !== null && revenue > 0) {
      const marginPct = (gp / revenue) * 100;
      if (marginPct < config.marginRules.minimumGrossMarginPct) {
        flags.push(`Margin ${marginPct.toFixed(1)}% is below the ${config.marginRules.minimumGrossMarginPct}% floor`);
      }
    }
    return flags;
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Comparison workbench</h1>
          <p>
            <Link href={`/opportunities/${opportunity.id}`}>{opportunity.name}</Link>
            {opportunity.buyerNeed ? ` · ${opportunity.buyerNeed.scope}` : ''}
          </p>
        </div>
        <Badge>{matches.length} candidates</Badge>
      </div>

      {matches.length === 0 ? (
        <div className="card">
          <Empty>No candidates to compare. Run matching on the opportunity first.</Empty>
        </div>
      ) : (
        <>
          <div className="grid grid-4 mb">
            <div className="stat">
              <div className="stat-label">Best overall</div>
              <div className="stat-value" style={{ fontSize: '1rem' }}>{bestOverall?.candidate.legalName}</div>
              <div className="stat-sub">{Math.round((bestOverall?.score ?? 0) * 100)}% record match</div>
            </div>
            {showMoney && (
              <div className="stat">
                <div className="stat-label">Best margin</div>
                <div className="stat-value" style={{ fontSize: '1rem' }}>{bestMargin?.candidate.legalName}</div>
                <div className="stat-sub">
                  {bestMargin?.estimatedCost && bestMargin.estimatedGrossProfit
                    ? `${money(bestMargin.estimatedGrossProfit)} gross profit`
                    : 'no quoted cost behind any margin here'}
                </div>
              </div>
            )}
            <div className="stat">
              <div className="stat-label">Lowest risk</div>
              <div className="stat-value" style={{ fontSize: '1rem' }}>{lowestRisk?.candidate.legalName}</div>
              <div className="stat-sub">
                {lowestRisk && lowestRisk.missingInformation.length === 0
                  ? `${Math.round(lowestRisk.fulfillmentRisk * 100)}% fulfilment risk`
                  : 'risk is scored from what is known, and things are still unknown'}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">Fastest</div>
              <div className="stat-value" style={{ fontSize: '1rem' }}>{fastest?.candidate.legalName}</div>
              <div className="stat-sub">
                {fastest?.supply?.leadTimeDays !== null && fastest?.supply?.leadTimeDays !== undefined
                  ? `${fastest.supply.leadTimeDays} day lead time`
                  : 'lead time unknown'}
              </div>
            </div>
          </div>

          {showMoney && lowestCost !== null && highestCost !== null && highestCost > lowestCost * 1.3 && (
            <div className="alert warning">
              <strong>Wide cost spread.</strong> Candidate pricing ranges from {money(lowestCost)} to {money(highestCost)} — a{' '}
              {Math.round(((highestCost - lowestCost) / lowestCost) * 100)}% gap. Confirm every candidate priced the same scope
              before treating the low bid as a saving.
            </div>
          )}

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Attribute</th>
                  {matches.map((match) => (
                    <th key={match.id}>
                      {match.candidate.legalName}
                      {match.isSelected && <> <Badge tone="success">Selected</Badge></>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {/* A match score is how well two records line up. It was
                    labelled and read as a judgement that the provider can do
                    the work, which nothing here has established. */}
                <Row
                  label="Record match"
                  matches={matches}
                  render={(m) => (m.missingInformation.length === 0
                    ? `${Math.round(m.score * 100)}%`
                    : `${Math.round(m.score * 100)}% on what is known`)}
                />
                <Row label="Location" matches={matches} render={(m) => m.candidate.locations[0] ? [m.candidate.locations[0].city, m.candidate.locations[0].state].filter(Boolean).join(', ') : '—'} />
                <Row label="Territories" matches={matches} render={(m) => m.candidate.serviceTerritories.join(', ') || '—'} />
                <Row label="Capacity" matches={matches} render={(m) => (m.capacity?.crewCount ? `${m.capacity.crewCount} crew(s)` : m.supply?.quantity ? `${m.supply.quantity} ${m.supply.unit ?? ''}` : '—')} />
                <Row label="Availability" matches={matches} render={(m) => m.capacity?.earliestStart?.toISOString().slice(0, 10) ?? (m.supply?.leadTimeDays !== null && m.supply?.leadTimeDays !== undefined ? `${m.supply.leadTimeDays}d lead` : '—')} />
                <Row label="Licensing" matches={matches} render={(m) => m.capacity?.licenses.join(', ') || (m.candidate.licenses as unknown[]).length ? JSON.stringify(m.candidate.licenses).slice(0, 40) : '—'} />
                <Row label="Insurance" matches={matches} render={(m) => JSON.stringify(m.capacity?.insuranceLimits ?? m.candidate.insurance ?? {}).slice(0, 60)} />
                <Row label="Certifications" matches={matches} render={(m) => m.candidate.certifications.join(', ') || '—'} />
                {showMoney && (
                  <Row
                    label="Cost"
                    matches={matches}
                    render={(m) => (m.estimatedCost === null ? 'Nobody has priced it' : money(m.estimatedCost))}
                  />
                )}
                {showMoney && (
                  <Row
                    label="Revenue"
                    matches={matches}
                    render={(m) => (m.estimatedRevenue === null ? 'No price has been set' : money(m.estimatedRevenue))}
                  />
                )}
                {showMoney && (
                  <Row
                    label="Gross profit"
                    matches={matches}
                    // A margin is only real when both sides are. One quoted
                    // side and one assumed side is an assumption.
                    render={(m) => (m.estimatedCost === null || m.estimatedGrossProfit === null
                      ? 'No cost behind it'
                      : money(m.estimatedGrossProfit))}
                  />
                )}
                <Row
                  label="Fulfilment risk"
                  matches={matches}
                  render={(m) => (m.missingInformation.length > 0
                    ? 'Unassessed — things are still unknown'
                    : `${Math.round(m.fulfillmentRisk * 100)}%`)}
                />
                {/* Match.closingProbability defaults to 0.2 and is a claim about
                    this buyer, not this candidate. Comparing candidates on it
                    compares four copies of the same default. */}
                <Row
                  label="Relationship"
                  matches={matches}
                  render={(m) => (m.candidate.relationshipStrength > 0
                    ? `${Math.round(m.candidate.relationshipStrength * 100)}% strength`
                    : 'No history with them')}
                />
                <Row label="Payment terms" matches={matches} render={() => 'Not negotiated'} />
                <tr>
                  <td className="muted nowrap">Missing information</td>
                  {matches.map((match) => (
                    <td key={match.id} className="tiny">
                      {match.missingInformation.length === 0 ? (
                        <span className="badge success">Complete</span>
                      ) : (
                        <ul className="list-reset">
                          {match.missingInformation.map((item) => (
                            <li key={item}>• {item}</li>
                          ))}
                        </ul>
                      )}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="muted nowrap">Flags</td>
                  {matches.map((match) => {
                    const flags = anomalies(match);
                    return (
                      <td key={match.id} className="tiny">
                        {flags.length === 0 ? (
                          <span className="badge success">None</span>
                        ) : (
                          <ul className="list-reset">
                            {flags.map((flag) => (
                              <li key={flag} style={{ color: 'var(--warning)' }}>▲ {flag}</li>
                            ))}
                          </ul>
                        )}
                      </td>
                    );
                  })}
                </tr>
                <tr>
                  <td className="muted nowrap">Calls needed first</td>
                  {matches.map((match) => (
                    <td key={match.id} className="tiny">
                      {match.callsNeeded.length === 0 ? <span className="muted">None</span> : match.callsNeeded.map((c) => <div key={c}>• {c}</div>)}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="muted nowrap">Explanation</td>
                  {matches.map((match) => (
                    <td key={match.id} className="tiny muted">
                      {match.explanation}
                    </td>
                  ))}
                </tr>
                {can(user, 'deal.write') && (
                  <tr>
                    <td></td>
                    {matches.map((match) => (
                      <td key={match.id}>
                        {!match.isSelected && (
                          <ActionButton endpoint={`/api/matches/${match.id}/select`} className="sm primary">
                            Select
                          </ActionButton>
                        )}
                      </td>
                    ))}
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function Row<T>({ label, matches, render }: { label: string; matches: T[]; render: (m: T) => string }) {
  return (
    <tr>
      <td className="muted nowrap">{label}</td>
      {matches.map((match, index) => (
        <td key={index} className="small">
          {render(match)}
        </td>
      ))}
    </tr>
  );
}
