import Link from 'next/link';
import type { PipelineStage, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { can, requireUser } from '@/lib/auth/session';
import { Badge, dueLabel, Empty, humanize, money, relativeDays } from '@/components/ui';

export const dynamic = 'force-dynamic';

/** Board columns, in operating order. Terminal stages sit in their own group. */
const ACTIVE_STAGES: PipelineStage[] = [
  'SIGNAL_DISCOVERED',
  'RESEARCHING',
  'QUALIFICATION_REQUIRED',
  'BUYER_NEED_CONFIRMED',
  'SUPPLIER_REQUIRED',
  'FULFILLMENT_CAPABILITY_CONFIRMED',
  'MATCH_BEING_CONFIGURED',
  'PRICING_REQUIRED',
  'QUOTE_BEING_PREPARED',
  'QUOTE_DELIVERED',
  'FOLLOW_UP_REQUIRED',
  'NEGOTIATION',
  'AWAITING_APPROVAL',
  'CONTRACTING',
  'FULFILLMENT_SCHEDULED',
  'ACTIVE_FULFILLMENT',
];

const CLOSED_STAGES: PipelineStage[] = ['COMPLETED', 'REPEAT_OR_EXPANSION', 'LOST', 'DORMANT', 'DISQUALIFIED'];

const FILTERS: Array<{ key: string; label: string; description: string }> = [
  { key: 'all', label: 'All active', description: 'Everything currently in flight.' },
  { key: 'no_next_action', label: 'No next action', description: 'Active work with nobody assigned a step — these drift and die.' },
  { key: 'overdue', label: 'Overdue', description: 'The next action passed its due date.' },
  { key: 'one_fact_away', label: 'One fact away', description: 'A single missing answer is holding the deal.' },
  { key: 'stale_pricing', label: 'Stale pricing', description: 'Pricing or availability has passed its re-verification date.' },
  { key: 'unverified_availability', label: 'Unverified availability', description: 'Capacity or inventory has not been confirmed.' },
  { key: 'needs_approval', label: 'Needs approval', description: 'High-value deals waiting on a human decision.' },
  { key: 'supply_gap', label: 'Supply gap', description: 'Confirmed demand with no capable provider.' },
  { key: 'compliance_verification', label: 'Compliance gaps', description: 'Insurance or licensing unverified on the chosen candidate.' },
  { key: 'likely_to_close', label: 'Likely to close', description: 'Closing probability above 50%.' },
  { key: 'neglected', label: 'Neglected', description: 'No activity in over a week.' },
  { key: 'high_risk', label: 'Excessive risk', description: 'Fulfillment confidence below 40%.' },
  { key: 'expansion', label: 'Ready to expand', description: 'Delivering accounts with room to grow.' },
  { key: 'closed', label: 'Closed', description: 'Won, lost, dormant and disqualified.' },
];

type BoardOpportunity = Prisma.OpportunityGetPayload<{
  include: {
    parties: { include: { company: true } };
    nextActions: { where: { isCurrent: true } };
    matches: true;
    owner: true;
    callAssignments: { include: { assignedTo: true } };
    escalations: true;
  };
}>;

export default async function BoardPage({
  searchParams,
}: {
  searchParams: { filter?: string; type?: string; owner?: string };
}) {
  const user = await requireUser();
  const showMoney = can(user, 'finance.margin.read');
  const filter = searchParams.filter ?? 'all';
  const now = new Date();

  const where: Prisma.OpportunityWhereInput = { orgId: user.orgId };
  if (filter === 'closed') {
    where.stage = { in: CLOSED_STAGES };
  } else {
    where.status = { notIn: ['WON', 'LOST', 'DISQUALIFIED'] };
  }
  if (searchParams.type) where.type = searchParams.type as never;
  if (searchParams.owner) where.ownerId = searchParams.owner;

  // Callers only ever see opportunities tied to their own assignments.
  if (user.roleKey === 'CALLER') {
    where.callAssignments = { some: { assignedToId: user.id } };
  }

  const all = (await prisma.opportunity.findMany({
    where,
    include: {
      parties: { include: { company: true } },
      nextActions: { where: { isCurrent: true } },
      matches: true,
      owner: true,
      callAssignments: { include: { assignedTo: true } },
      escalations: true,
    },
    orderBy: [{ priority: 'asc' }, { expectedValue: 'desc' }],
    take: 400,
  })) as BoardOpportunity[];

  const opportunities = all.filter((opportunity) => applyFilter(opportunity, filter, now));
  const stages = filter === 'closed' ? CLOSED_STAGES : ACTIVE_STAGES;
  const byStage = new Map<PipelineStage, BoardOpportunity[]>();
  for (const stage of stages) byStage.set(stage, []);
  for (const opportunity of opportunities) {
    byStage.get(opportunity.stage)?.push(opportunity);
  }

  const activeFilter = FILTERS.find((f) => f.key === filter) ?? FILTERS[0];
  const totalValue = opportunities.reduce((sum, o) => sum + Number(o.expectedValue ?? 0), 0);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Dispatch board</h1>
          <p>{activeFilter.description}</p>
        </div>
        <div className="row">
          <Badge>{opportunities.length} shown</Badge>
          {showMoney && <Badge tone="accent">{money(totalValue)} expected value</Badge>}
        </div>
      </div>

      <div className="filter-bar">
        {FILTERS.map((option) => (
          <Link
            key={option.key}
            href={`/board?filter=${option.key}`}
            className={`filter-chip${filter === option.key ? ' active' : ''}`}
          >
            {option.label}
          </Link>
        ))}
      </div>

      <div className="filter-bar">
        {['SUBCONTRACTING', 'BROKERAGE', 'DISTRIBUTION', 'HYBRID'].map((type) => (
          <Link
            key={type}
            href={`/board?filter=${filter}${searchParams.type === type ? '' : `&type=${type}`}`}
            className={`filter-chip${searchParams.type === type ? ' active' : ''}`}
          >
            {humanize(type)}
          </Link>
        ))}
      </div>

      {opportunities.length === 0 ? (
        <div className="card">
          <Empty>Nothing matches this view.</Empty>
        </div>
      ) : (
        <div className="board">
          {stages
            .filter((stage) => (byStage.get(stage)?.length ?? 0) > 0)
            .map((stage) => {
              const cards = byStage.get(stage) ?? [];
              const stageValue = cards.reduce((sum, o) => sum + Number(o.expectedValue ?? 0), 0);
              return (
                <div className="board-column" key={stage}>
                  <div className="board-column-header">
                    <span>{humanize(stage)}</span>
                    <span className="nav-count">
                      {cards.length}
                      {showMoney && stageValue > 0 ? ` · ${money(stageValue)}` : ''}
                    </span>
                  </div>
                  <div className="board-cards">
                    {cards.map((opportunity) => (
                      <DealCard key={opportunity.id} opportunity={opportunity} showMoney={showMoney} now={now} />
                    ))}
                  </div>
                </div>
              );
            })}
        </div>
      )}
    </>
  );
}

function DealCard({ opportunity, showMoney, now }: { opportunity: BoardOpportunity; showMoney: boolean; now: Date }) {
  const primary = opportunity.parties.find((p) => p.isPrimary)?.company;
  const action = opportunity.nextActions[0];
  const due = dueLabel(action?.dueDate ?? opportunity.dueDate);
  const caller = opportunity.callAssignments.find((a) => ['PENDING', 'ASSIGNED', 'IN_PROGRESS'].includes(a.status));
  const flags = boardFlags(opportunity, now);

  return (
    <Link href={`/opportunities/${opportunity.id}`} className={`deal-card p-${opportunity.priority}`}>
      <div className="deal-card-title">{opportunity.name}</div>
      <div className="deal-card-meta">
        <Badge tone={opportunity.type === 'SUBCONTRACTING' ? 'accent' : opportunity.type === 'BROKERAGE' ? 'success' : 'warning'}>
          {humanize(opportunity.type)}
        </Badge>
        {opportunity.status !== 'ACTIVE' && <Badge tone={opportunity.status === 'BLOCKED' ? 'warning' : 'danger'}>{humanize(opportunity.status)}</Badge>}
        {opportunity.escalations.some((e) => e.status === 'OPEN') && <Badge tone="critical">Escalated</Badge>}
      </div>

      <div className="deal-card-row">
        <span className="dim">{primary?.legalName ?? 'No company'}</span>
      </div>
      <div className="deal-card-row">
        <span className="dim">{opportunity.location ?? 'Location unknown'}</span>
        {showMoney && <span>{money(opportunity.expectedValue)}</span>}
      </div>
      <div className="deal-card-row">
        <span className="dim">
          P {Math.round(opportunity.closingProbability * 100)}% · Info {Math.round(opportunity.informationCompleteness * 100)}%
        </span>
        <span className={due.overdue ? 'badge danger' : 'dim'}>{due.text}</span>
      </div>

      {action ? (
        <div className="deal-card-action">
          <strong>{humanize(action.type)}</strong>
          <div className="dim tiny">{action.reason.slice(0, 110)}…</div>
        </div>
      ) : (
        <div className="deal-card-action">
          <span className="badge danger">No next action</span>
        </div>
      )}

      {caller?.assignedTo && <div className="deal-card-flag dim tiny">Caller: {caller.assignedTo.name}</div>}
      {flags.map((flag) => (
        <div className="deal-card-flag" key={flag}>
          ▲ {flag}
        </div>
      ))}
      <div className="tiny dim" style={{ marginTop: '0.25rem' }}>
        Last activity {relativeDays(opportunity.lastActivityAt)}
      </div>
    </Link>
  );
}

/** Surface conditions a manager needs to see without opening the record. */
function boardFlags(opportunity: BoardOpportunity, now: Date): string[] {
  const flags: string[] = [];
  const daysIdle = (now.getTime() - opportunity.lastActivityAt.getTime()) / 86_400_000;

  if (opportunity.nextActions.length === 0 && !['WON', 'LOST', 'DISQUALIFIED'].includes(opportunity.status)) {
    flags.push('No next action assigned');
  }
  if (daysIdle > 7) flags.push(`Neglected ${Math.round(daysIdle)} days`);
  if (opportunity.missingInformation.length === 1) flags.push(`One fact away: ${opportunity.missingInformation[0]}`);
  if (opportunity.matches.some((m) => m.missingInformation.some((mi) => /insurance|licen|certif/i.test(mi)))) {
    flags.push('Candidate compliance unverified');
  }
  if (opportunity.matches.length > 0 && opportunity.matches.every((m) => m.estimatedCost === null)) {
    flags.push('No pricing on any candidate');
  }
  if (opportunity.fulfillmentConfidence < 0.4 && opportunity.matches.length > 0) flags.push('High fulfillment risk');
  if (opportunity.closingProbability >= 0.5) flags.push('Likely to close');
  if (opportunity.stage === 'AWAITING_APPROVAL') flags.push('Waiting on approval');
  return flags;
}

function applyFilter(opportunity: BoardOpportunity, filter: string, now: Date): boolean {
  const action = opportunity.nextActions[0];
  const daysIdle = (now.getTime() - opportunity.lastActivityAt.getTime()) / 86_400_000;

  switch (filter) {
    case 'no_next_action':
      return opportunity.nextActions.length === 0;
    case 'overdue':
      return Boolean(action && action.dueDate < now);
    case 'one_fact_away':
      return opportunity.missingInformation.length === 1;
    case 'stale_pricing':
      return opportunity.matches.some((m) => m.missingInformation.some((mi) => /pricing|stale/i.test(mi)));
    case 'unverified_availability':
      return opportunity.matches.some((m) => m.missingInformation.some((mi) => /availability|capacity/i.test(mi)));
    case 'needs_approval':
      return opportunity.stage === 'AWAITING_APPROVAL';
    case 'supply_gap':
      return opportunity.stage === 'SUPPLIER_REQUIRED' || opportunity.matches.filter((m) => m.score >= 0.5).length === 0;
    case 'compliance_verification':
      return opportunity.matches.some((m) => m.missingInformation.some((mi) => /insurance|licen|certif/i.test(mi)));
    case 'likely_to_close':
      return opportunity.closingProbability >= 0.5;
    case 'neglected':
      return daysIdle > 7;
    case 'high_risk':
      return opportunity.fulfillmentConfidence < 0.4;
    case 'expansion':
      return opportunity.stage === 'REPEAT_OR_EXPANSION';
    default:
      return true;
  }
}
