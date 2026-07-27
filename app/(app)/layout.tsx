import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { can, getSessionUser } from '@/lib/auth/session';
import { NavLink } from '@/components/NavLink';
import { LogoutButton } from '@/components/LogoutButton';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const isCaller = user.roleKey === 'CALLER';

  const [myCalls, escalations, approvals, signals] = await Promise.all([
    prisma.callAssignment.count({
      where: {
        orgId: user.orgId,
        status: { in: ['PENDING', 'ASSIGNED', 'RESCHEDULED'] },
        ...(isCaller ? { assignedToId: user.id } : {}),
      },
    }),
    can(user, 'escalation.read')
      ? prisma.escalation.count({ where: { orgId: user.orgId, status: { in: ['OPEN', 'ACKNOWLEDGED'] } } })
      : Promise.resolve(0),
    can(user, 'deal.approve') || can(user, 'finance.risk.review')
      ? prisma.approval.count({ where: { orgId: user.orgId, status: 'PENDING' } })
      : Promise.resolve(0),
    can(user, 'discovery.read')
      ? prisma.discoverySignal.count({ where: { orgId: user.orgId, status: { in: ['NEW', 'TRIAGED'] } } })
      : Promise.resolve(0),
  ]);

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">
          Deal<span>Dispatch</span>
        </div>

        {!isCaller && (
          <>
            <div className="nav-section">Operate</div>
            <NavLink href="/dashboard">Dashboard</NavLink>
            <NavLink href="/board">Dispatch board</NavLink>
            <NavLink href="/opportunities">Opportunities</NavLink>
          </>
        )}

        <div className="nav-section">Execute</div>
        <NavLink href="/calls" count={myCalls}>
          {isCaller ? 'My calls' : 'Call assignments'}
        </NavLink>
        {can(user, 'escalation.read') && (
          <NavLink href="/escalations" count={escalations} alert={escalations > 0}>
            Escalations
          </NavLink>
        )}
        {(can(user, 'deal.approve') || can(user, 'finance.risk.review')) && (
          <NavLink href="/approvals" count={approvals} alert={approvals > 0}>
            Approvals
          </NavLink>
        )}

        {(can(user, 'company.read') || can(user, 'discovery.read')) && (
          <>
            <div className="nav-section">Graph</div>
            {can(user, 'company.read') && <NavLink href="/companies">Companies</NavLink>}
            {can(user, 'discovery.read') && (
              <NavLink href="/signals" count={signals}>
                Signals
              </NavLink>
            )}
          </>
        )}

        {(can(user, 'analytics.pipeline.read') || can(user, 'analytics.caller.read.own') || can(user, 'lane.read')) && (
          <>
            <div className="nav-section">Measure</div>
            <NavLink href="/analytics">{isCaller ? 'My performance' : 'Analytics'}</NavLink>
            {can(user, 'lane.read') && <NavLink href="/lanes">Deal lanes</NavLink>}
          </>
        )}

        {can(user, 'admin.config') && (
          <>
            <div className="nav-section">Configure</div>
            <NavLink href="/admin">Administration</NavLink>
          </>
        )}

        <div style={{ marginTop: 'auto', paddingTop: '1rem' }}>
          <div className="tiny dim" style={{ padding: '0 0.6rem 0.35rem' }}>
            {user.name}
            <br />
            <span className="badge">{user.roleName}</span>
          </div>
          <LogoutButton />
        </div>
      </nav>

      <main className="main">{children}</main>
    </div>
  );
}
