import Link from 'next/link';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { can, requireUser } from '@/lib/auth/session';
import { Badge, dueLabel, Empty, humanize, PriorityBadge, relativeDays, StatusBadge } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function CallsPage() {
  const user = await requireUser();
  const isCaller = user.roleKey === 'CALLER';
  const seesAll = can(user, 'call.assignment.read.all');

  const where: Prisma.CallAssignmentWhereInput = {
    orgId: user.orgId,
    status: { in: ['PENDING', 'ASSIGNED', 'IN_PROGRESS', 'RESCHEDULED'] },
  };
  // A caller sees only their own queue. This is enforced here, not in the UI.
  if (!seesAll) where.assignedToId = user.id;

  const assignments = await prisma.callAssignment.findMany({
    where,
    include: {
      company: { include: { locations: true } },
      contact: true,
      opportunity: true,
      assignedTo: true,
    },
    orderBy: [{ priority: 'asc' }, { dueDate: 'asc' }],
    take: 100,
  });

  const completedToday = await prisma.call.count({
    where: {
      orgId: user.orgId,
      ...(seesAll ? {} : { callerId: user.id }),
      startedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
    },
  });

  const next = assignments[0];

  return (
    <>
      <div className="page-header">
        <div>
          <h1>{isCaller ? 'Your call queue' : 'Call assignments'}</h1>
          <p>
            {isCaller
              ? 'Work top to bottom. Everything you need for each conversation is on the call screen — you do not need to update any records afterwards.'
              : 'Every assignment the AI has created, with the caller it was routed to and why.'}
          </p>
        </div>
        <div className="row">
          <Badge>{assignments.length} queued</Badge>
          <Badge tone="accent">{completedToday} calls today</Badge>
        </div>
      </div>

      {next && (
        <div className="card" style={{ borderColor: 'var(--accent)' }}>
          <div className="card-title">
            <h2>Next up</h2>
            <PriorityBadge priority={next.priority} />
          </div>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h3>{next.company.legalName}</h3>
              <div className="small muted">
                {next.contact ? `${next.contact.firstName} ${next.contact.lastName}${next.contact.title ? `, ${next.contact.title}` : ''}` : 'No named contact'}
                {' · '}
                {next.contact?.phone ?? next.company.phone ?? 'no phone on file'}
              </div>
              <div className="mt small">
                <strong>{humanize(next.callType)}</strong> — {next.objective}
              </div>
            </div>
            <Link href={`/calls/${next.id}`} className="btn primary">
              Open call screen
            </Link>
          </div>
        </div>
      )}

      {assignments.length === 0 ? (
        <div className="card">
          <Empty>No calls queued. The AI creates assignments as opportunities need information.</Empty>
        </div>
      ) : (
        <div className="table-wrap mt">
          <table>
            <thead>
              <tr>
                <th>Company</th>
                <th>Contact</th>
                <th>Call type</th>
                <th>Objective</th>
                <th>Status</th>
                <th>Due</th>
                {seesAll && <th>Caller</th>}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {assignments.map((assignment) => {
                const due = dueLabel(assignment.dueDate);
                return (
                  <tr key={assignment.id}>
                    <td>
                      <strong>{assignment.company.legalName}</strong>
                      <div className="tiny dim">{assignment.company.locations[0]?.city ?? ''}</div>
                    </td>
                    <td className="small">
                      {assignment.contact ? `${assignment.contact.firstName} ${assignment.contact.lastName}` : <span className="dim">Unknown</span>}
                      <div className="tiny dim">{assignment.contact?.title ?? ''}</div>
                    </td>
                    <td className="small nowrap">{humanize(assignment.callType)}</td>
                    <td className="small">{assignment.objective.slice(0, 140)}</td>
                    <td>
                      <StatusBadge status={assignment.status} />
                      {assignment.attemptCount > 0 && (
                        <div className="tiny dim">
                          {assignment.attemptCount}/{assignment.maxAttempts} attempts
                        </div>
                      )}
                    </td>
                    <td className={`small nowrap${due.overdue ? ' badge danger' : ''}`}>{due.text}</td>
                    {seesAll && (
                      <td className="small">
                        {assignment.assignedTo?.name ?? <span className="dim">Unassigned</span>}
                        {assignment.assignmentReason && <div className="tiny dim">{assignment.assignmentReason.slice(0, 90)}</div>}
                      </td>
                    )}
                    <td>
                      <Link href={`/calls/${assignment.id}`} className="btn sm">
                        Open
                      </Link>
                    </td>
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
