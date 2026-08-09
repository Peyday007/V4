import Link from 'next/link';
import { prisma } from '@/lib/db';
import { can } from '@/lib/auth/session';
import { requirePagePermission } from '@/lib/auth/page';
import { ImportConsole } from '@/components/ImportConsole';
import { OrgIdentityEditor } from '@/components/OrgIdentityEditor';

export const dynamic = 'force-dynamic';

/** The organisation the seed creates. Its presence means nothing here is real yet. */
const DEMO_SLUG = 'meridian-ops';

export default async function ImportPage() {
  const user = await requirePagePermission('company.write');
  const canClear = can(user, 'admin.config');

  const [org, startedForReal, companies, contacts, opportunities, calls, providers, buyers] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: user.orgId } }),
    prisma.auditEvent.count({ where: { orgId: user.orgId, action: { in: ['data.cleared', 'import.csv'] } }, take: 1 }),
    prisma.company.count({ where: { orgId: user.orgId } }),
    prisma.contact.count({ where: { orgId: user.orgId } }),
    prisma.opportunity.count({ where: { orgId: user.orgId } }),
    prisma.call.count({ where: { orgId: user.orgId } }),
    prisma.company.count({ where: { orgId: user.orgId, companyRole: { in: ['SUPPLIER', 'DISTRIBUTOR', 'SUBCONTRACTOR', 'CARRIER'] } } }),
    prisma.company.count({ where: { orgId: user.orgId, companyRole: 'BUYER' } }),
  ]);

  const looksSeeded = org.slug === DEMO_SLUG && companies > 0 && startedForReal === 0;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Start with your own data</h1>
          <p>
            Everything on the board right now came from the seed — fabricated companies, fabricated conversations,
            fabricated margins. It exists to show the loop working end to end, not to be worked. This page replaces it
            with yours.
          </p>
        </div>
      </div>

      {looksSeeded && (
        <div className="alert warning">
          This organisation is still the demonstration one (<span className="mono">{org.name}</span>), holding{' '}
          {companies} companies, {opportunities} opportunities and {calls} recorded calls. None of them exist. Clear
          them before you import, or your real providers will be mixed in with invented ones and the analytics will
          average across both.
        </div>
      )}

      <div className="card">
        <div className="card-title">
          <h2>What is in the database now</h2>
        </div>
        <div className="grid grid-4">
          <div className="stat">
            <div className="stat-label">Companies</div>
            <div className="stat-value">{companies}</div>
            <div className="stat-sub">{providers} providers · {buyers} buyers</div>
          </div>
          <div className="stat">
            <div className="stat-label">Contacts</div>
            <div className="stat-value">{contacts}</div>
            <div className="stat-sub">people who could be reached</div>
          </div>
          <div className="stat">
            <div className="stat-label">Opportunities</div>
            <div className="stat-value">{opportunities}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Calls</div>
            <div className="stat-value">{calls}</div>
          </div>
        </div>
      </div>

      {canClear && <OrgIdentityEditor name={org.name} timezone={org.timezone} />}

      <ImportConsole canClear={canClear} />

      <div className="card">
        <div className="card-title">
          <h2>What happens after the import</h2>
        </div>
        <ol className="small muted" style={{ paddingLeft: '1.1rem', lineHeight: 1.7 }}>
          <li>
            <strong>Providers first, buyers second.</strong> A buyer with no provider who can serve them produces an
            opportunity nobody can fulfil, and the system will correctly refuse to promote it.
          </li>
          <li>
            <strong>Capabilities are what matching runs on.</strong> Every service listed in the file becomes one. A
            provider imported with an empty services column can never be matched to anything.
          </li>
          <li>
            <strong>Nothing dials on its own.</strong> Imported companies enter at the discovered stage and appear as
            call assignments for a person to work. Compliance gates — calling hours, suppression, consent — apply from
            the first row.
          </li>
          <li>
            <strong>Then check <Link href="/ads">the advertising plan</Link>.</strong> It reads your real provider
            coverage and tells you whether you have enough of it to spend money on demand yet.
          </li>
        </ol>
      </div>
    </>
  );
}
