import Link from 'next/link';
import { notFound } from 'next/navigation';
import { num, prisma } from '@/lib/db';
import { can, requireUser } from '@/lib/auth/session';
import { ActionButton } from '@/components/ActionButton';
import { Badge, dueLabel, Empty, humanize, Meter, money, PriorityBadge, relativeDays, Stat, StatusBadge, TypeBadge } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function OpportunityWorkspace({ params }: { params: { id: string } }) {
  const user = await requireUser();
  const showMoney = can(user, 'finance.margin.read');
  const canAct = can(user, 'opportunity.write') || can(user, 'deal.write');

  const opportunity = await prisma.opportunity.findFirst({
    where: {
      id: params.id,
      orgId: user.orgId,
      // Callers only reach opportunities connected to their own assignments.
      ...(user.roleKey === 'CALLER' ? { callAssignments: { some: { assignedToId: user.id } } } : {}),
    },
    include: {
      parties: { include: { company: { include: { contacts: true, locations: true } } } },
      buyerNeed: true,
      deal: { include: { costs: true, margins: { orderBy: { computedAt: 'desc' }, take: 1 } } },
      matches: { include: { candidate: true }, orderBy: { score: 'desc' } },
      quotes: { include: { lineItems: true } },
      nextActions: { orderBy: { createdAt: 'desc' }, take: 5 },
      escalations: { orderBy: { createdAt: 'desc' } },
      approvals: { orderBy: { createdAt: 'desc' } },
      documents: { orderBy: { createdAt: 'desc' } },
      tasks: { where: { status: { in: ['OPEN', 'IN_PROGRESS'] } } },
      callAssignments: { include: { assignedTo: true, calls: { include: { transcript: true } } }, orderBy: { createdAt: 'desc' } },
      scores: { orderBy: { createdAt: 'desc' }, take: 1 },
      statusHistory: { orderBy: { createdAt: 'desc' }, take: 12 },
      activityEvents: { orderBy: { createdAt: 'desc' }, take: 20 },
      facts: { orderBy: { capturedAt: 'desc' }, take: 40 },
      commitments: true,
      signal: { include: { evidence: true } },
      lane: true,
      owner: true,
    },
  });

  if (!opportunity) notFound();

  const primary = opportunity.parties.find((p) => p.isPrimary)?.company ?? null;
  const currentAction = opportunity.nextActions.find((a) => a.isCurrent) ?? null;
  const score = opportunity.scores[0];
  const reasons = (score?.reasons ?? []) as Array<{ dimension: string; value: number; because: string }>;
  const deal = opportunity.deal;
  const selectedMatch = opportunity.matches.find((m) => m.isSelected) ?? null;
  const openEscalations = opportunity.escalations.filter((e) => e.status === 'OPEN' || e.status === 'ACKNOWLEDGED');
  const due = dueLabel(currentAction?.dueDate);

  return (
    <>
      <div className="page-header">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row mb">
            <TypeBadge type={opportunity.type} />
            <StatusBadge status={opportunity.status} />
            <PriorityBadge priority={opportunity.priority} />
            <Badge>{humanize(opportunity.stage)}</Badge>
            {opportunity.lane && <Badge tone="accent">Lane: {opportunity.lane.name}</Badge>}
          </div>
          <h1>{opportunity.name}</h1>
          <p>{primary?.legalName ?? 'No company attached'} · {opportunity.location ?? 'Location unknown'}</p>
        </div>
        {canAct && (
          <div className="row">
            <ActionButton endpoint={`/api/opportunities/${opportunity.id}/actions`} body={{ action: 'run_full_loop' }} className="primary">
              Re-run AI loop
            </ActionButton>
            <ActionButton endpoint={`/api/opportunities/${opportunity.id}/actions`} body={{ action: 'generate_document', documentKind: 'OPPORTUNITY_BRIEF' }}>
              Brief
            </ActionButton>
            <Link href={`/compare/${opportunity.id}`} className="btn">
              Compare candidates
            </Link>
          </div>
        )}
      </div>

      {openEscalations.length > 0 && (
        <div className="alert danger">
          <strong>{openEscalations.length} open escalation(s).</strong> The AI has stopped advancing this deal until a human decides.
          <ul className="list-reset" style={{ marginTop: '0.4rem' }}>
            {openEscalations.map((escalation) => (
              <li key={escalation.id} className="small">
                • <strong>{humanize(escalation.reason)}:</strong> {escalation.title}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-4 mb">
        <Stat label="Closing probability" value={`${Math.round(opportunity.closingProbability * 100)}%`} sub={<Meter value={opportunity.closingProbability} />} />
        <Stat label="Fulfillment confidence" value={`${Math.round(opportunity.fulfillmentConfidence * 100)}%`} sub={<Meter value={opportunity.fulfillmentConfidence} tone={opportunity.fulfillmentConfidence < 0.4 ? 'danger' : 'success'} />} />
        <Stat label="Information completeness" value={`${Math.round(opportunity.informationCompleteness * 100)}%`} sub={<Meter value={opportunity.informationCompleteness} tone={opportunity.informationCompleteness < 0.5 ? 'warning' : 'success'} />} />
        <Stat label="Relationship vulnerability" value={`${Math.round(opportunity.relationshipVulnerability * 100)}%`} sub={<Meter value={opportunity.relationshipVulnerability} />} />
        {showMoney && (
          <>
            <Stat label="Estimated value" value={money(opportunity.estimatedValue)} />
            <Stat label="Gross profit" value={money(opportunity.estimatedGrossProfit)} sub={deal?.grossMarginPct ? `${deal.grossMarginPct}% margin` : undefined} />
            <Stat label="Expected value" value={money(opportunity.expectedValue)} sub="GP × P(close) × fulfillment confidence" />
          </>
        )}
      </div>

      <div className="two-col">
        <div>
          {/* ---------- State of the deal ---------- */}
          <div className="card">
            <h2>State of the deal</h2>
            <p className="pre-wrap small">{opportunity.aiExplanation ?? opportunity.summary}</p>
            {opportunity.primaryBlocker && (
              <div className="alert warning small">
                <strong>Primary blocker:</strong> {opportunity.primaryBlocker}
              </div>
            )}
          </div>

          {/* ---------- Next action ---------- */}
          <div className="card">
            <div className="card-title">
              <h2>Next action</h2>
              {currentAction && <span className={due.overdue ? 'badge danger' : 'badge'}>{due.text}</span>}
            </div>
            {!currentAction ? (
              <Empty>No next action set. Re-run the AI loop to assign one.</Empty>
            ) : (
              <>
                <div className="row mb">
                  <Badge tone="accent">{humanize(currentAction.type)}</Badge>
                  <Badge>{currentAction.ownerRole ? humanize(currentAction.ownerRole) : 'Unassigned'}</Badge>
                </div>
                <p className="small">{currentAction.reason}</p>
                <table>
                  <tbody>
                    <tr>
                      <td className="muted nowrap">Expected result</td>
                      <td>{currentAction.expectedResult}</td>
                    </tr>
                    <tr>
                      <td className="muted nowrap">Done when</td>
                      <td>{currentAction.completionCriteria}</td>
                    </tr>
                    <tr>
                      <td className="muted nowrap">Inputs required</td>
                      <td>{currentAction.inputsRequired.join(', ') || '—'}</td>
                    </tr>
                    <tr>
                      <td className="muted nowrap">Fallback</td>
                      <td>{currentAction.fallbackAction ? humanize(currentAction.fallbackAction) : '—'}</td>
                    </tr>
                    <tr>
                      <td className="muted nowrap">Escalate if</td>
                      <td>{currentAction.escalationCondition ?? '—'}</td>
                    </tr>
                  </tbody>
                </table>
              </>
            )}
          </div>

          {/* ---------- Requirements ---------- */}
          <div className="card">
            <h2>Requirements</h2>
            {!opportunity.buyerNeed ? (
              <Empty>No buyer need recorded yet. A qualification call has to establish one before anything can be priced.</Empty>
            ) : (
              <>
                <div className="row mb">
                  <Badge tone={opportunity.buyerNeed.status === 'CONFIRMED' ? 'success' : 'warning'}>
                    {humanize(opportunity.buyerNeed.status)}
                  </Badge>
                  <Badge>confidence {Math.round(opportunity.buyerNeed.confidence * 100)}%</Badge>
                </div>
                <table>
                  <tbody>
                    <tr><td className="muted nowrap">Scope</td><td>{opportunity.buyerNeed.scope}</td></tr>
                    <tr><td className="muted nowrap">Location</td><td>{opportunity.buyerNeed.location ?? '—'}</td></tr>
                    <tr><td className="muted nowrap">Frequency</td><td>{humanize(opportunity.buyerNeed.frequency)}</td></tr>
                    <tr><td className="muted nowrap">Start</td><td>{opportunity.buyerNeed.startDate?.toISOString().slice(0, 10) ?? '—'}</td></tr>
                    <tr><td className="muted nowrap">Deadline</td><td>{opportunity.buyerNeed.deadline?.toISOString().slice(0, 10) ?? '—'}</td></tr>
                    <tr><td className="muted nowrap">Quantity</td><td>{opportunity.buyerNeed.quantity ? `${opportunity.buyerNeed.quantity} ${opportunity.buyerNeed.unit ?? ''}` : '—'}</td></tr>
                    {showMoney && <tr><td className="muted nowrap">Estimated value</td><td>{money(opportunity.buyerNeed.estimatedValue)}</td></tr>}
                    <tr><td className="muted nowrap">Capabilities</td><td>{opportunity.buyerNeed.requiredCapabilities.join(', ') || '—'}</td></tr>
                    <tr><td className="muted nowrap">Current provider</td><td>{opportunity.buyerNeed.currentProvider ?? '—'}</td></tr>
                    <tr><td className="muted nowrap">Provider issues</td><td>{opportunity.buyerNeed.currentProviderIssues.join('; ') || '—'}</td></tr>
                    <tr><td className="muted nowrap">Open to alternatives</td><td>{opportunity.buyerNeed.openToAlternatives === null ? 'Unknown' : opportunity.buyerNeed.openToAlternatives ? 'Yes' : 'No'}</td></tr>
                  </tbody>
                </table>
              </>
            )}

            <h4 className="mt">Still missing</h4>
            {opportunity.missingInformation.length === 0 ? (
              <div className="small muted">Nothing outstanding.</div>
            ) : (
              <ul className="checklist">
                {opportunity.missingInformation.map((item) => (
                  <li key={item} className="missing">{item}</li>
                ))}
              </ul>
            )}
          </div>

          {/* ---------- Candidates ---------- */}
          <div className="card">
            <div className="card-title">
              <h2>Fulfillment candidates</h2>
              <span className="tiny dim">Ranked for outreach — not proof of suitability</span>
            </div>
            {opportunity.matches.length === 0 ? (
              <Empty>No candidates found. This deal has demand but no way to deliver it.</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Candidate</th>
                      <th className="num">Score</th>
                      {showMoney && <th className="num">Cost</th>}
                      {showMoney && <th className="num">GP</th>}
                      <th className="num">Risk</th>
                      <th>Outstanding</th>
                      {can(user, 'deal.write') && <th></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {opportunity.matches.map((match) => (
                      <tr key={match.id}>
                        <td>
                          <Link href={`/companies/${match.candidateCompanyId}`}>{match.candidate.legalName}</Link>
                          {match.isSelected && <> <Badge tone="success">Selected</Badge></>}
                          <div className="tiny dim">{match.explanation.slice(0, 180)}</div>
                        </td>
                        <td className="num">{Math.round(match.score * 100)}%</td>
                        {showMoney && <td className="num">{money(match.estimatedCost)}</td>}
                        {showMoney && <td className="num">{money(match.estimatedGrossProfit)}</td>}
                        <td className="num">{Math.round(match.fulfillmentRisk * 100)}%</td>
                        <td className="tiny">{match.missingInformation.join(', ') || <span className="muted">None</span>}</td>
                        {can(user, 'deal.write') && (
                          <td>
                            {!match.isSelected && (
                              <ActionButton endpoint={`/api/matches/${match.id}/select`} className="sm">
                                Select
                              </ActionButton>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ---------- Deal configuration ---------- */}
          <div className="card">
            <div className="card-title">
              <h2>Deal configuration</h2>
              {deal && <Badge tone={deal.isConfigurable ? 'success' : 'warning'}>{deal.isConfigurable ? 'Configurable' : 'Incomplete'}</Badge>}
            </div>
            {!deal ? (
              <Empty>Not yet attempted. Select a fulfillment candidate first.</Empty>
            ) : (
              <>
                {!deal.isConfigurable && (
                  <div className="alert warning small">
                    <strong>This deal cannot be configured yet.</strong> The following terms are unknown and will not be assumed:
                    <ul className="list-reset" style={{ marginTop: '0.3rem' }}>
                      {deal.missingTerms.map((term) => (
                        <li key={term}>• {term}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {showMoney && (
                  <div className="grid grid-4 mb">
                    <Stat label="Buyer price" value={money(deal.buyerPrice)} />
                    <Stat label="Cost" value={money(deal.supplierCost)} />
                    <Stat label="Freight" value={money(deal.freightCost)} />
                    <Stat label="Gross profit" value={money(deal.grossProfit)} sub={deal.grossMarginPct ? `${deal.grossMarginPct}%` : undefined} />
                  </div>
                )}
                <details>
                  <summary className="small muted">Full configuration</summary>
                  <pre className="mono pre-wrap" style={{ overflowX: 'auto' }}>
                    {JSON.stringify(deal.configuration, null, 2)}
                  </pre>
                </details>
                {deal.risks.length > 0 && (
                  <>
                    <h4 className="mt">Risks</h4>
                    <ul className="checklist">
                      {deal.risks.map((risk) => (
                        <li key={risk} className="missing">{risk}</li>
                      ))}
                    </ul>
                  </>
                )}
                {deal.requiredApprovals.length > 0 && (
                  <>
                    <h4 className="mt">Requires approval</h4>
                    <ul className="checklist">
                      {deal.requiredApprovals.map((approval) => (
                        <li key={approval}>{approval}</li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}
          </div>

          {/* ---------- Calls & transcripts ---------- */}
          <div className="card">
            <h2>Calls</h2>
            {opportunity.callAssignments.length === 0 ? (
              <Empty>No call assignments yet.</Empty>
            ) : (
              <ul className="list-reset">
                {opportunity.callAssignments.map((assignment) => (
                  <li key={assignment.id} style={{ padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <Link href={`/calls/${assignment.id}`}>{humanize(assignment.callType)}</Link>
                      <StatusBadge status={assignment.status} />
                    </div>
                    <div className="small muted">{assignment.objective}</div>
                    <div className="tiny dim">
                      {assignment.assignedTo?.name ?? 'Unassigned'} · {assignment.calls.length} call(s) · {relativeDays(assignment.createdAt)}
                    </div>
                    {assignment.calls.map((call) => call.transcript?.summary && (
                      <div key={call.id} className="tiny muted" style={{ marginTop: '0.25rem' }}>
                        {call.transcript.summary.slice(0, 220)}…
                      </div>
                    ))}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* ---------- Fact ledger ---------- */}
          {can(user, 'call.transcript.read') && (
            <div className="card">
              <div className="card-title">
                <h2>Fact ledger</h2>
                <span className="tiny dim">Every fact carries its source, confidence and status</span>
              </div>
              {opportunity.facts.length === 0 ? (
                <Empty>No facts captured yet.</Empty>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Fact</th>
                        <th>Value</th>
                        <th>Status</th>
                        <th className="num">Conf.</th>
                        <th>Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {opportunity.facts.map((fact) => (
                        <tr key={fact.id}>
                          <td className="mono">{fact.factKey}</td>
                          <td>{fact.factValue}</td>
                          <td>
                            <Badge tone={fact.status === 'CONFIRMED' ? 'success' : fact.status === 'CONTRADICTED' ? 'danger' : fact.status === 'STALE' ? 'warning' : ''}>
                              {humanize(fact.status)}
                            </Badge>
                          </td>
                          <td className="num">{Math.round(fact.confidence * 100)}%</td>
                          <td className="tiny dim">{fact.sourceQuote?.slice(0, 90) ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ---------- Sidebar ---------- */}
        <div>
          <div className="card">
            <h2>Parties</h2>
            <ul className="list-reset">
              {opportunity.parties.map((party) => (
                <li key={party.id} style={{ padding: '0.4rem 0', borderBottom: '1px solid var(--border)' }}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <Link href={`/companies/${party.companyId}`} className="small">
                      {party.company.legalName}
                    </Link>
                    <Badge tone={party.isPrimary ? 'accent' : ''}>{humanize(party.role)}</Badge>
                  </div>
                  {party.company.contacts.slice(0, 2).map((contact) => (
                    <div className="tiny dim" key={contact.id}>
                      {contact.firstName} {contact.lastName}
                      {contact.title ? `, ${contact.title}` : ''} · {contact.phone ?? 'no phone'}
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          </div>

          {score && (
            <div className="card">
              <h2>Why this score</h2>
              <div className="small muted mb">Composite {Math.round(score.compositeScore * 100)}%</div>
              <ul className="list-reset">
                {reasons.slice(0, 12).map((reason, index) => (
                  <li key={index} style={{ padding: '0.35rem 0', borderBottom: '1px solid var(--border)' }}>
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <span className="small mono">{reason.dimension}</span>
                      <span className="tiny dim">{typeof reason.value === 'number' ? reason.value.toFixed(2) : ''}</span>
                    </div>
                    <div className="tiny muted">{reason.because}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {opportunity.signal && (
            <div className="card">
              <h2>Source evidence</h2>
              <div className="small">
                <Badge>{humanize(opportunity.signal.category)}</Badge> {opportunity.signal.headline}
              </div>
              <div className="tiny muted mt">{opportunity.signal.detail}</div>
              {opportunity.signal.evidence && (
                <div className="tiny dim mt">
                  {opportunity.signal.evidence.sourceUrl && (
                    <a href={opportunity.signal.evidence.sourceUrl} target="_blank" rel="noreferrer noopener">
                      {opportunity.signal.evidence.sourceUrl}
                    </a>
                  )}
                  <div>
                    {humanize(opportunity.signal.evidence.sourceType)} · discovered{' '}
                    {opportunity.signal.evidence.discoveredAt.toISOString().slice(0, 10)} · last checked{' '}
                    {opportunity.signal.evidence.lastCheckedAt.toISOString().slice(0, 10)}
                  </div>
                  <div>Status: {humanize(opportunity.signal.evidence.status)} · via {opportunity.signal.evidence.createdByProcess}</div>
                </div>
              )}
            </div>
          )}

          {opportunity.approvals.length > 0 && (
            <div className="card">
              <h2>Approvals</h2>
              <ul className="list-reset">
                {opportunity.approvals.map((approval) => (
                  <li key={approval.id} style={{ padding: '0.4rem 0', borderBottom: '1px solid var(--border)' }}>
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <span className="small">{approval.title}</span>
                      <StatusBadge status={approval.status} />
                    </div>
                    <div className="tiny dim">{approval.summary}</div>
                    {approval.status === 'PENDING' && can(user, 'deal.approve') && (
                      <div className="row" style={{ marginTop: '0.3rem' }}>
                        <ActionButton endpoint={`/api/approvals/${approval.id}`} body={{ decision: 'APPROVED' }} className="sm success">
                          Approve
                        </ActionButton>
                        <ActionButton
                          endpoint={`/api/approvals/${approval.id}`}
                          body={{ decision: 'REJECTED' }}
                          className="sm danger"
                          promptFor={{ key: 'note', label: 'Reason for rejecting?' }}
                        >
                          Reject
                        </ActionButton>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {opportunity.documents.length > 0 && can(user, 'document.read') && (
            <div className="card">
              <h2>Documents</h2>
              <ul className="list-reset">
                {opportunity.documents.map((document) => (
                  <li key={document.id} style={{ padding: '0.4rem 0', borderBottom: '1px solid var(--border)' }}>
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <span className="small">{document.title}</span>
                      <StatusBadge status={document.status} />
                    </div>
                    <details>
                      <summary className="tiny dim">View draft</summary>
                      <pre className="mono pre-wrap" style={{ maxHeight: 320, overflow: 'auto' }}>{document.body}</pre>
                    </details>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {opportunity.commitments.length > 0 && (
            <div className="card">
              <h2>Commitments</h2>
              <ul className="list-reset">
                {opportunity.commitments.map((commitment) => (
                  <li key={commitment.id} className="small" style={{ padding: '0.35rem 0', borderBottom: '1px solid var(--border)' }}>
                    <Badge tone={commitment.isAuthorized ? '' : 'critical'}>{commitment.madeBy === 'us' ? 'We said' : 'They said'}</Badge>{' '}
                    {commitment.text}
                    {!commitment.isAuthorized && <div className="tiny danger">Exceeded caller authority</div>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="card">
            <h2>Stage history</h2>
            <ul className="timeline">
              {opportunity.statusHistory.map((entry) => (
                <li key={entry.id}>
                  <time>{entry.createdAt.toISOString().replace('T', ' ').slice(0, 16)} · {entry.actorType}</time>
                  <div className="small">
                    {entry.fromStage ? `${humanize(entry.fromStage)} → ` : ''}
                    <strong>{humanize(entry.toStage)}</strong>
                  </div>
                  <div className="tiny muted">{entry.reason}</div>
                </li>
              ))}
            </ul>
          </div>

          <div className="card">
            <h2>Activity</h2>
            <ul className="timeline">
              {opportunity.activityEvents.map((event) => (
                <li key={event.id}>
                  <time>{relativeDays(event.createdAt)} · {event.actorType}</time>
                  <div className="small">{event.summary}</div>
                </li>
              ))}
            </ul>
          </div>

          {can(user, 'opportunity.stage.override') && (
            <div className="card">
              <h2>Manager overrides</h2>
              <div className="row">
                <ActionButton
                  endpoint={`/api/opportunities/${opportunity.id}/actions`}
                  body={{ action: 'mark_won' }}
                  className="sm success"
                  confirm="Mark this opportunity as won?"
                  promptFor={{ key: 'reason', label: 'Note for the record?' }}
                >
                  Mark won
                </ActionButton>
                <ActionButton
                  endpoint={`/api/opportunities/${opportunity.id}/actions`}
                  body={{ action: 'mark_lost' }}
                  className="sm danger"
                  promptFor={{ key: 'reason', label: 'Loss reason?' }}
                >
                  Mark lost
                </ActionButton>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
