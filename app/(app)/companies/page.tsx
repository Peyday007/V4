import Link from 'next/link';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requirePagePermission } from '@/lib/auth/page';
import { Badge, Empty, humanize, money, relativeDays } from '@/components/ui';

export const dynamic = 'force-dynamic';

const ROLE_FILTERS = ['all', 'BUYER', 'PRIME_CONTRACTOR', 'SUBCONTRACTOR', 'SUPPLIER', 'DISTRIBUTOR', 'MANUFACTURER', 'CARRIER', 'HYBRID', 'UNKNOWN'];

export default async function CompaniesPage({ searchParams }: { searchParams: { role?: string; movability?: string; q?: string } }) {
  const user = await requirePagePermission('company.read');

  const where: Prisma.CompanyWhereInput = { orgId: user.orgId };
  if (searchParams.role && searchParams.role !== 'all') where.companyRole = searchParams.role as never;
  if (searchParams.movability === 'movable') where.movability = { in: ['ACTIVELY_MOVABLE', 'CONDITIONALLY_MOVABLE'] };
  if (searchParams.q) where.legalName = { contains: searchParams.q, mode: 'insensitive' };

  const companies = await prisma.company.findMany({
    where,
    include: {
      locations: true,
      contacts: true,
      _count: { select: { opportunityParties: true, matchesAsCandidate: true } },
    },
    orderBy: [{ movabilityScore: 'desc' }, { legalName: 'asc' }],
    take: 200,
  });

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Business graph</h1>
          <p>
            Every company the system knows, classified by its role in a deal. Movability tells you which buyers will actually
            take a call about switching.
          </p>
        </div>
        <Badge>{companies.length} companies</Badge>
      </div>

      <div className="filter-bar">
        {ROLE_FILTERS.map((role) => (
          <Link
            key={role}
            href={`/companies?role=${role}`}
            className={`filter-chip${(searchParams.role ?? 'all') === role ? ' active' : ''}`}
          >
            {role === 'all' ? 'All roles' : humanize(role)}
          </Link>
        ))}
        <Link href="/companies?movability=movable" className={`filter-chip${searchParams.movability === 'movable' ? ' active' : ''}`}>
          Movable accounts
        </Link>
      </div>

      {companies.length === 0 ? (
        <div className="card">
          <Empty>No companies match.</Empty>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Company</th>
                <th>Role</th>
                <th>Location</th>
                <th>Movability</th>
                <th>Account stage</th>
                <th className="num">Contacts</th>
                <th className="num">Deals</th>
                <th>Verified</th>
              </tr>
            </thead>
            <tbody>
              {companies.map((company) => (
                <tr key={company.id}>
                  <td>
                    <Link href={`/companies/${company.id}`}>{company.legalName}</Link>
                    {company.website && <div className="tiny dim">{company.website.replace(/^https?:\/\//, '')}</div>}
                  </td>
                  <td>
                    <Badge>{humanize(company.companyRole)}</Badge>
                  </td>
                  <td className="small">
                    {company.locations[0] ? [company.locations[0].city, company.locations[0].state].filter(Boolean).join(', ') : '—'}
                  </td>
                  <td>
                    <Badge
                      tone={
                        company.movability === 'ACTIVELY_MOVABLE'
                          ? 'success'
                          : company.movability === 'CONDITIONALLY_MOVABLE'
                            ? 'warning'
                            : company.movability === 'RELATIONSHIP_LOCKED'
                              ? 'danger'
                              : ''
                      }
                    >
                      {humanize(company.movability)}
                    </Badge>
                    {company.movabilityScore > 0 && <div className="tiny dim">{Math.round(company.movabilityScore * 100)}%</div>}
                  </td>
                  <td className="small">{humanize(company.accountStage)}</td>
                  <td className="num">{company.contacts.length}</td>
                  <td className="num">{company._count.opportunityParties + company._count.matchesAsCandidate}</td>
                  <td className="tiny dim nowrap">{company.lastVerifiedAt ? relativeDays(company.lastVerifiedAt) : 'never'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
