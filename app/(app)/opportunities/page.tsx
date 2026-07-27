import Link from 'next/link';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { can, requireUser } from '@/lib/auth/session';
import { Badge, dueLabel, Empty, humanize, money, PriorityBadge, relativeDays, StatusBadge, TypeBadge } from '@/components/ui';

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

  const opportunities = await prisma.opportunity.findMany({
    where,
    include: {
      parties: { where: { isPrimary: true }, include: { company: true } },
      nextActions: { where: { isCurrent: true } },
      matches: { where: { isSelected: true }, include: { candidate: true } },
    },
    orderBy: [{ priority: 'asc' }, { expectedValue: 'desc' }],
    take: 300,
  });

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
                <th className="num">P(close)</th>
                {showMoney && <th className="num">Value</th>}
                {showMoney && <th className="num">GP</th>}
                <th>Next action</th>
                <th>Due</th>
                <th>Activity</th>
              </tr>
            </thead>
            <tbody>
              {opportunities.map((opportunity) => {
                const action = opportunity.nextActions[0];
                const due = dueLabel(action?.dueDate ?? opportunity.dueDate);
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
                    <td className="num">{Math.round(opportunity.closingProbability * 100)}%</td>
                    {showMoney && <td className="num">{money(opportunity.estimatedValue)}</td>}
                    {showMoney && <td className="num">{money(opportunity.estimatedGrossProfit)}</td>}
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
