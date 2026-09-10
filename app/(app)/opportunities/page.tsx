import Link from 'next/link';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { can, requireUser } from '@/lib/auth/session';
import { Badge, dueLabel, Empty, humanize, PriorityBadge, relativeDays, StatusBadge, TypeBadge } from '@/components/ui';
import { FigureChip } from '@/components/Figure';
import { closedComparablesByType, gradeOpportunity, gradeOpportunityMoney } from '@/lib/evidence/opportunity';
import { presentMoney } from '@/lib/evidence/economics';
import { BrainCell, brainColumnLabel } from '@/components/BrainCell';
import { isConnected } from '@/lib/brain/config';

export const dynamic = 'force-dynamic';

const VIEWS = [
  { key: 'all', label: 'All' },
  { key: 'SUBCONTRACTING', label: 'Subcontracting' },
  { key: 'BROKERAGE', label: 'Brokerage' },
  { key: 'DISTRIBUTION', label: 'Distribution' },
  { key: 'HYBRID', label: 'Hybrid' },
  { key: 'raw_signals', label: 'Raw signals' },
  { key: 'active', label: 'Active' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'escalated', label: 'Escalations' },
  { key: 'won', label: 'Won' },
  { key: 'lost', label: 'Lost' },
  { key: 'expansion', label: 'Repeat / expansion' },
];

export default async function OpportunitiesPage({ searchParams }: { searchParams: { view?: string } }) {
  const user = await requireUser();
  const showMoney = can(user, 'finance.margin.read');
  const view = searchParams.view ?? 'all';

  const where: Prisma.OpportunityWhereInput = { orgId: user.orgId };
  if (['SUBCONTRACTING', 'BROKERAGE', 'DISTRIBUTION', 'HYBRID'].includes(view)) where.type = view as never;
  else if (view === 'raw_signals') where.stage = { in: ['SIGNAL_DISCOVERED', 'RESEARCHING'] };
  else if (view === 'active') where.status = 'ACTIVE';
  else if (view === 'waiting') where.status = 'WAITING';
  else if (view === 'blocked') where.status = 'BLOCKED';
  else if (view === 'escalated') where.status = 'ESCALATED';
  else if (view === 'won') where.status = 'WON';
  else if (view === 'lost') where.status = { in: ['LOST', 'DISQUALIFIED'] };
  else if (view === 'expansion') where.stage = 'REPEAT_OR_EXPANSION';

  if (user.roleKey === 'CALLER') where.callAssignments = { some: { assignedToId: user.id } };

  const brainConnected = isConnected();

  const [opportunities, closedByType] = await Promise.all([
    prisma.opportunity.findMany({
      where,
      include: {
        parties: { where: { isPrimary: true }, include: { company: true } },
        nextActions: { where: { isCurrent: true } },
        matches: { where: { isSelected: true }, include: { candidate: true } },
        scores: { select: { id: true }, take: 1 },
        /*
         * Brain's cached view, read from the local row rather than from Brain.
         *
         * A board of three hundred records is three hundred round trips if it
         * asks Brain per row, so this reads the cache the connector's bounded
         * pull keeps current. The detail page reads live; the board reads the
         * cache, and the cache says when it was last heard from.
         */
        brainLink: true,
        quotes: {
          // Superseded and declined revisions are history, not the live price.
          where: { direction: 'outbound', status: { notIn: ['SUPERSEDED', 'DECLINED', 'EXPIRED'] } },
          select: { total: true, costTotal: true, grossProfit: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      orderBy: [{ priority: 'asc' }, { expectedValue: 'desc' }],
      take: 300,
    }),
    closedComparablesByType(user.orgId),
  ]);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Opportunity centre</h1>
          <p>Every discovered situation, classified and owned. Views below match the operating model.</p>
        </div>
        <Badge>{opportunities.length} records</Badge>
      </div>

      <div className="filter-bar">
        {VIEWS.map((option) => (
          <Link key={option.key} href={`/opportunities?view=${option.key}`} className={`filter-chip${view === option.key ? ' active' : ''}`}>
            {option.label}
          </Link>
        ))}
      </div>

      {opportunities.length === 0 ? (
        <div className="card">
          <Empty>No opportunities in this view.</Empty>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Opportunity</th>
                <th>Type</th>
                <th>Stage</th>
                <th>Status</th>
                <th>Fulfillment</th>
                <th className="num">Closing rate</th>
                {showMoney && <th className="num">Value</th>}
                {showMoney && <th className="num">GP</th>}
                {brainConnected && <th>{brainColumnLabel()}</th>}
                <th>Next action</th>
                <th>Due</th>
                <th>Activity</th>
              </tr>
            </thead>
            <tbody>
              {opportunities.map((opportunity) => {
                const action = opportunity.nextActions[0];
                const due = dueLabel(action?.dueDate ?? opportunity.dueDate);
                const claims = gradeOpportunity({
                  opportunity: { ...opportunity, hasScore: opportunity.scores.length > 0 },
                  closedComparables: closedByType.get(String(opportunity.type)) ?? 0,
                });
                const cash = gradeOpportunityMoney({
                  estimatedValue: opportunity.estimatedValue,
                  estimatedGrossProfit: opportunity.estimatedGrossProfit,
                  quote: opportunity.quotes[0] ?? null,
                });
                return (
                  <tr key={opportunity.id}>
                    <td>
                      <Link href={`/opportunities/${opportunity.id}`}>{opportunity.name}</Link>
                      <div className="tiny dim">
                        {opportunity.parties[0]?.company.legalName ?? 'No company'} · {opportunity.location ?? 'Location unknown'}
                      </div>
                    </td>
                    <td><TypeBadge type={opportunity.type} /></td>
                    <td className="small nowrap">{humanize(opportunity.stage)}</td>
                    <td><StatusBadge status={opportunity.status} /></td>
                    <td className="small">{opportunity.matches[0]?.candidate.legalName ?? <span className="dim">Not selected</span>}</td>
                    <td className="num tiny">
                      <FigureChip presentation={claims.shown.closingProbability} />
                    </td>
                    {showMoney && (
                      <td className="num tiny"><FigureChip presentation={presentMoney(cash.value)} /></td>
                    )}
                    {showMoney && (
                      <td className="num tiny"><FigureChip presentation={presentMoney(cash.grossProfit)} /></td>
                    )}
                    {brainConnected && (
                      <td className="small">
                        <BrainCell link={opportunity.brainLink} />
                      </td>
                    )}
                    <td className="small">
                      {action ? humanize(action.type) : <Badge tone="danger">None</Badge>}
                      <div className="tiny dim">{<PriorityBadge priority={opportunity.priority} />}</div>
                    </td>
                    <td className={`small nowrap${due.overdue ? ' badge danger' : ''}`}>{due.text}</td>
                    <td className="tiny dim nowrap">{relativeDays(opportunity.lastActivityAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
