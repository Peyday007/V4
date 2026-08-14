import Link from 'next/link';
import type { PipelineStage, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { can, requireUser } from '@/lib/auth/session';
import { Badge, dueLabel, Empty, humanize, money, relativeDays } from '@/components/ui';
import {
  closedComparablesByType, gradeOpportunity, claimsChip, STAGE_ORDER, type OpportunityClaims,
} from '@/lib/evidence/opportunity';
import { totalOf } from '@/lib/evidence/class';

export const dynamic = 'force-dynamic';

/**
 * Board columns, in operating order. Terminal stages sit in their own group.
 *
 * Taken from the canonical order rather than restated, so the column layout and
 * anything that ranks by depth cannot drift apart.
 */
const ACTIVE_STAGES = STAGE_ORDER.slice(0, STAGE_ORDER.indexOf('COMPLETED')) as PipelineStage[];

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
  {
    key: 'likely_to_close',
    label: 'Likely to close',
    description:
      'Closing rate above 50% — and only where there is enough closed history for a rate to exist. Deals whose '
      + 'probability is still the column default are not "unlikely", they are unmeasured, and they are not here.',
  },
  { key: 'neglected', label: 'Neglected', description: 'No activity in over a week.' },
  {
    key: 'high_risk',
    label: 'Excessive risk',
    description:
      'Fulfilment confidence below 40%, where enough of the provider side is established for that figure to '
      + 'mean something. An unscored deal is not low-risk; it is unassessed.',
  },
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
    // One row is enough to know the scorer has run. Selecting the whole history
    // for four hundred cards would be a page load spent proving a boolean.
    scores: { select: { id: true }; take: 1 };
  };
}>;

/** An opportunity with its headline numbers already graded. */
type Graded = { opportunity: BoardOpportunity; claims: OpportunityClaims };

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

  const [all, closedByType] = await Promise.all([
    prisma.opportunity.findMany({
      where,
      include: {
        parties: { include: { company: true } },
        nextActions: { where: { isCurrent: true } },
        matches: true,
        owner: true,
        callAssignments: { include: { assignedTo: true } },
        escalations: true,
        scores: { select: { id: true }, take: 1 },
      },
      orderBy: [{ priority: 'asc' }, { expectedValue: 'desc' }],
      take: 400,
    }) as Promise<BoardOpportunity[]>,
    // One query for the whole board rather than one per card.
    closedComparablesByType(user.orgId),
  ]);

  // Graded once, up front, so the filter, the flags and the card cannot each
  // decide for themselves whether a number is real.
  const graded: Graded[] = all.map((opportunity) => ({
    opportunity,
    claims: gradeOpportunity({
      opportunity: { ...opportunity, hasScore: opportunity.scores.length > 0 },
      closedComparables: closedByType.get(String(opportunity.type)) ?? 0,
    }),
  }));

  const opportunities = graded.filter((g) => applyFilter(g, filter, now));
  const stages = filter === 'closed' ? CLOSED_STAGES : ACTIVE_STAGES;
  const byStage = new Map<PipelineStage, Graded[]>();
  for (const stage of stages) byStage.set(stage, []);
  for (const g of opportunities) {
    byStage.get(g.opportunity.stage)?.push(g);
  }

  const activeFilter = FILTERS.find((f) => f.key === filter) ?? FILTERS[0];
  // Expected value is gross profit times a closing probability. Where the
  // probability is a column default the product is arithmetic over a guess, so
  // the header total counts only the rows that survive the rule and says how
  // many it left out.
  const totalValue = totalOf(opportunities.map((g) => g.claims.expectedValue));

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Dispatch board</h1>
          <p>{activeFilter.description}</p>
        </div>
        <div className="row">
          <Badge>{opportunities.length} shown</Badge>
          {showMoney && (
            <span title={totalValue.note}>
              {totalValue.counted > 0
                ? <Badge tone="accent">{money(totalValue.total)} expected value ({totalValue.counted} of {opportunities.length})</Badge>
                : <Badge tone="warning">No defensible expected value</Badge>}
            </span>
          )}
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
          <Empty>
            {/* Two of these views select on a graded figure, so "nothing here"
                can mean "nothing qualifies" or "nothing has been measured".
                They are different problems and want different actions. */}
            {filter === 'likely_to_close' || filter === 'high_risk'
              ? `Nothing matches, and on ${graded.length} active deal(s) that may be because the figure this view `
                + 'selects on has not been established rather than because no deal qualifies. A closing rate needs '
                + 'closed deals behind it; fulfilment confidence needs a provider on the record.'
              : 'Nothing matches this view.'}
          </Empty>
        </div>
      ) : (
        <div className="board">
          {stages
            .filter((stage) => (byStage.get(stage)?.length ?? 0) > 0)
            .map((stage) => {
              const cards = byStage.get(stage) ?? [];
              const stageValue = totalOf(cards.map((g) => g.claims.expectedValue));
              return (
                <div className="board-column" key={stage}>
                  <div className="board-column-header">
                    <span>{humanize(stage)}</span>
                    <span className="nav-count" title={showMoney ? stageValue.note : undefined}>
                      {cards.length}
                      {showMoney && stageValue.counted > 0 ? ` · ${money(stageValue.total)}` : ''}
                    </span>
                  </div>
                  <div className="board-cards">
                    {cards.map((g) => (
                      <DealCard key={g.opportunity.id} graded={g} showMoney={showMoney} now={now} />
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

function DealCard({ graded, showMoney, now }: { graded: Graded; showMoney: boolean; now: Date }) {
  const { opportunity, claims } = graded;
  const primary = opportunity.parties.find((p) => p.isPrimary)?.company;
  const action = opportunity.nextActions[0];
  const due = dueLabel(action?.dueDate ?? opportunity.dueDate);
  const caller = opportunity.callAssignments.find((a) => ['PENDING', 'ASSIGNED', 'IN_PROGRESS'].includes(a.status));
  const flags = boardFlags(graded, now);

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
        {showMoney && (
          claims.expectedValue.value !== null
            ? <span>{money(claims.expectedValue.value)}</span>
            : <span className="dim tiny">no defensible value</span>
        )}
      </div>
      <div className="deal-card-row">
        {/* Was "P 10% · Info 35%" on every card, both figures column defaults
            on anything the scorer had not touched. A card has room for a
            fragment; the fragment has to be true. */}
        <span className="dim tiny">{claimsChip(claims)}</span>
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

/**
 * Surface conditions a manager needs to see without opening the record.
 *
 * Every flag here has to be a fact about the deal. "Likely to close" and "high
 * fulfilment risk" were assertions built on column defaults, so they now only
 * appear when the figure behind them survived the evidence rule — and when it
 * did not, the card says the figure is missing rather than saying nothing,
 * because a missing assessment on a live deal is itself worth seeing.
 */
function boardFlags(graded: Graded, now: Date): string[] {
  const { opportunity, claims } = graded;
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
  const fulfilment = claims.fulfillmentConfidence;
  if (fulfilment.value !== null && fulfilment.value < 0.4 && opportunity.matches.length > 0) {
    flags.push('High fulfillment risk');
  } else if (opportunity.matches.length > 0 && fulfilment.value === null) {
    flags.push('Provider side unassessed');
  }

  const closing = claims.closingProbability;
  if (closing.value !== null && closing.value >= 0.5) flags.push('Likely to close');

  if (opportunity.stage === 'AWAITING_APPROVAL') flags.push('Waiting on approval');
  return flags;
}

function applyFilter(graded: Graded, filter: string, now: Date): boolean {
  const { opportunity, claims } = graded;
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
    // Both of these select on a graded figure. An opportunity whose figure did
    // not survive the rule is excluded rather than compared against — comparing
    // a column default to a threshold produces a confident answer to a question
    // nothing has asked.
    case 'likely_to_close':
      return claims.closingProbability.value !== null && claims.closingProbability.value >= 0.5;
    case 'neglected':
      return daysIdle > 7;
    case 'high_risk':
      return claims.fulfillmentConfidence.value !== null && claims.fulfillmentConfidence.value < 0.4;
    case 'expansion':
      return opportunity.stage === 'REPEAT_OR_EXPANSION';
    default:
      return true;
  }
}
