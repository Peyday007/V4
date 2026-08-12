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

  const [org, startedForReal, myCalls, escalations, approvals, signals, liveLeads] = await Promise.all([
    prisma.organization.findUnique({ where: { id: user.orgId }, select: { name: true, slug: true } }),
    // Audit events outlive the data they describe — clearBusinessData does not
    // remove them — so this stays true once the operator has begun, rather
    // than flickering back on as soon as real companies exist again.
    prisma.auditEvent.count({
      where: { orgId: user.orgId, action: { in: ['data.cleared', 'import.csv'] } },
      take: 1,
    }),
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
    // Counted separately from all signals: the nav badge should reflect real
    // discovery, not seeded volume.
    can(user, 'discovery.read')
      ? prisma.discoverySignal.count({
          where: { orgId: user.orgId, status: { in: ['NEW', 'TRIAGED'] }, origin: 'LIVE_DISCOVERY' },
        })
      : Promise.resolve(0),
  ]);

  // The seed's organisation is still in place and nobody has cleared it or
  // imported anything, so every figure on screen is invented. Worth flagging
  // in the nav rather than only on the page itself.
  const onDemoData = org?.slug === 'meridian-ops' && startedForReal === 0;

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">
          Deal<span>Dispatch</span>
        </div>
        {org && <div className="tiny dim" style={{ padding: '0 0.6rem 0.5rem', marginTop: '-0.5rem' }}>{org.name}</div>}

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
              <>
                {/* Demand first: it is the queue with actual buyers in it. */}
                <NavLink href="/demand">Demand</NavLink>
                <NavLink href="/leads" count={liveLeads}>
                  Cold prospects
                </NavLink>
                <NavLink href="/signals" count={signals}>
                  Signals
                </NavLink>
              </>
            )}
          </>
        )}

        {(can(user, 'analytics.pipeline.read') || can(user, 'analytics.caller.read.own') || can(user, 'lane.read')) && (
          <>
            <div className="nav-section">Measure</div>
            <NavLink href="/analytics">{isCaller ? 'My performance' : 'Analytics'}</NavLink>
            {!isCaller && <NavLink href="/measure">What is working</NavLink>}
            {!isCaller && <NavLink href="/reviews">Call reviews</NavLink>}
            {can(user, 'analytics.caller.read.all') && <NavLink href="/manager">System manager</NavLink>}
            {can(user, 'analytics.pipeline.read') && <NavLink href="/outreach">Outreach channels</NavLink>}
            {can(user, 'analytics.pipeline.read') && <NavLink href="/ads">Advertising plan</NavLink>}
            {can(user, 'lane.read') && <NavLink href="/lanes">Deal lanes</NavLink>}
          </>
        )}

        {can(user, 'company.write') && (
          <>
            <div className="nav-section">Configure</div>
            <NavLink href="/import" alert={onDemoData} note={onDemoData ? 'demo' : undefined}>
              Your data
            </NavLink>
            {can(user, 'admin.config') && <NavLink href="/admin">Administration</NavLink>}
          </>
        )}
        {!can(user, 'company.write') && can(user, 'admin.config') && (
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
