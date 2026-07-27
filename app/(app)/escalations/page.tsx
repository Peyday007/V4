import Link from 'next/link';
import { prisma } from '@/lib/db';
import { can } from '@/lib/auth/session';
import { requirePagePermission } from '@/lib/auth/page';
import { ActionButton } from '@/components/ActionButton';
import { Badge, Empty, humanize, relativeDays, StatusBadge } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function EscalationsPage({ searchParams }: { searchParams: { status?: string } }) {
  const user = await requirePagePermission('escalation.read');
  const canResolve = can(user, 'escalation.resolve');
  const status = searchParams.status ?? 'open';

  const escalations = await prisma.escalation.findMany({
    where: {
      orgId: user.orgId,
      status: status === 'open' ? { in: ['OPEN', 'ACKNOWLEDGED'] } : status === 'all' ? undefined : (status.toUpperCase() as never),
    },
    include: { opportunity: { include: { parties: { where: { isPrimary: true }, include: { company: true } } } }, assignee: true },
    orderBy: [{ severity: 'asc' }, { createdAt: 'asc' }],
    take: 200,
  });

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Escalations</h1>
          <p>
            The only things the AI will not decide on its own. Each one names the rule that fired and the evidence behind it,
            so a manager can rule on it without reconstructing the deal.
          </p>
        </div>
        <Badge tone={escalations.length > 0 ? 'danger' : 'success'}>{escalations.length} open</Badge>
      </div>

      <div className="filter-bar">
        {['open', 'resolved', 'dismissed', 'all'].map((option) => (
          <Link key={option} href={`/escalations?status=${option}`} className={`filter-chip${status === option ? ' active' : ''}`}>
            {humanize(option)}
          </Link>
        ))}
      </div>

      {escalations.length === 0 ? (
        <div className="card">
          <Empty>Nothing needs a human decision right now.</Empty>
        </div>
      ) : (
        escalations.map((escalation) => (
          <div className="card" key={escalation.id} style={{ borderLeft: `3px solid var(--${escalation.severity === 'CRITICAL' ? 'critical' : escalation.severity === 'HIGH' ? 'danger' : 'warning'})` }}>
            <div className="card-title">
              <div>
                <h2>{escalation.title}</h2>
                <div className="row">
                  <Badge tone={escalation.severity === 'CRITICAL' ? 'critical' : 'danger'}>{escalation.severity}</Badge>
                  <Badge>{humanize(escalation.reason)}</Badge>
                  <StatusBadge status={escalation.status} />
                  <span className="tiny dim">raised {relativeDays(escalation.createdAt)} by {escalation.raisedByProcess}</span>
                </div>
              </div>
              {escalation.opportunityId && (
                <Link href={`/opportunities/${escalation.opportunityId}`} className="btn sm">
                  Open deal
                </Link>
              )}
            </div>

            <p className="small pre-wrap">{escalation.detail}</p>

            {escalation.opportunity && (
              <div className="tiny dim">
                {escalation.opportunity.name} · {escalation.opportunity.parties[0]?.company.legalName ?? 'no company'}
              </div>
            )}

            {escalation.resolutionNote && (
              <div className="alert success small mt">
                Resolved: {escalation.resolutionNote}
              </div>
            )}

            {canResolve && (escalation.status === 'OPEN' || escalation.status === 'ACKNOWLEDGED') && (
              <div className="row mt">
                {escalation.status === 'OPEN' && (
                  <ActionButton endpoint={`/api/escalations/${escalation.id}`} body={{ status: 'ACKNOWLEDGED' }} className="sm">
                    Acknowledge
                  </ActionButton>
                )}
                <ActionButton
                  endpoint={`/api/escalations/${escalation.id}`}
                  body={{ status: 'RESOLVED' }}
                  className="sm success"
                  promptFor={{ key: 'note', label: 'How was this resolved?' }}
                >
                  Resolve
                </ActionButton>
                <ActionButton
                  endpoint={`/api/escalations/${escalation.id}`}
                  body={{ status: 'DISMISSED' }}
                  className="sm"
                  promptFor={{ key: 'note', label: 'Why dismiss this?' }}
                >
                  Dismiss
                </ActionButton>
              </div>
            )}
          </div>
        ))
      )}
    </>
  );
}
