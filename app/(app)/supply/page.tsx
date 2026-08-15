import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePagePermission } from '@/lib/auth/page';
import { reverseSearch } from '@/lib/supply/reverse';
import { ReverseSearchPanel } from '@/components/ReverseSearch';
import { Badge, Empty } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Working from the supply side.
 *
 * Everything else in this engine starts with a published record and looks for a
 * provider afterwards. That works for the paths where somebody publishes the
 * trigger, and it cannot work at all for the ones where the demand is real,
 * recurring and invisible — nobody files a permit when their warehouse gets
 * full.
 *
 * This page is the other direction, and it is deliberately small. It lists the
 * providers whose capability a person has actually established, and for each one
 * it will say which commercial paths that capacity could serve, who buys that,
 * and what has to be asked before any of it is a requirement rather than a
 * guess. A provider nobody has verified appears here too, with the one thing
 * that would change it, because a directory entry is a company describing
 * itself and building a week of calling on it would be a hypothesis resting on
 * a hypothesis.
 */
export default async function SupplyPage({ searchParams }: { searchParams: { provider?: string } }) {
  const user = await requirePagePermission('discovery.read');

  // Providers, verified first. The order is the point: this page is about
  // capacity somebody has established, and the unverified ones are shown
  // underneath as work rather than as options.
  const providers = await prisma.company.findMany({
    where: {
      orgId: user.orgId,
      dataMode: 'PRODUCTION',
      OR: [
        { companyRole: { in: ['SUPPLIER', 'SUBCONTRACTOR', 'DISTRIBUTOR', 'MANUFACTURER', 'CARRIER', 'HYBRID'] } },
        // A company somebody has verified a capability against is a provider
        // whatever its role says. The role is a classification we inferred; the
        // verified capability is a fact, and the fact wins.
        { capabilities: { some: { verifiedAt: { not: null }, status: 'CONFIRMED' } } },
      ],
    },
    orderBy: { legalName: 'asc' },
    take: 200,
    select: {
      id: true,
      legalName: true,
      cityName: true,
      stateCode: true,
      capabilities: {
        select: { status: true, verifiedAt: true, capability: { select: { name: true } } },
      },
    },
  });

  const rows = providers
    .map((p) => {
      const verified = p.capabilities.filter((c) => c.verifiedAt !== null && c.status === 'CONFIRMED');
      return {
        id: p.id,
        name: p.legalName,
        location: [p.cityName, p.stateCode].filter(Boolean).join(', ') || null,
        verified: verified.map((c) => c.capability.name),
        claimed: p.capabilities.length - verified.length,
      };
    })
    .sort((a, b) => b.verified.length - a.verified.length || a.name.localeCompare(b.name));

  // Falls back to the first provider rather than to nothing. When no capacity
  // has been verified the refusal — with the one call that would change it — is
  // the most useful thing this page can show, and an empty box is the least.
  const selectedId = searchParams.provider ?? rows.find((r) => r.verified.length > 0)?.id ?? rows[0]?.id ?? null;
  const result = selectedId ? await reverseSearch({ orgId: user.orgId, companyId: selectedId }) : null;

  const verifiedCount = rows.filter((r) => r.verified.length > 0).length;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Working from supply</h1>
          <p>
            Start with a provider whose capacity somebody has actually checked, and work outwards to who would
            buy it. This produces questions, never opportunities — nobody has said they need anything.
          </p>
        </div>
        <Link href="/universe" className="btn secondary">The whole universe</Link>
      </div>

      <div className="alert info small" data-testid="supply-standing">
        {verifiedCount} of {rows.length} provider(s) on this account have a capability a person established.
        The rest list capabilities they claim about themselves, which is not the same thing and is not enough
        to build a week of calling on.
      </div>

      <div className="grid grid-2">
        <div className="card" data-testid="supply-roster">
          <div className="card-title">
            <h2>Providers</h2>
            <span className="tiny dim">Verified capacity first</span>
          </div>
          {rows.length === 0 ? (
            <Empty>
              No providers on this account. Nothing can be sold from the supply side until somebody is on the
              supply side.
            </Empty>
          ) : (
            <div className="table-scroll">
              <table className="table tiny">
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} data-testid={`supply-provider-${row.id}`}>
                      <td>
                        <Link href={`/supply?provider=${row.id}`}>
                          <strong>{row.name}</strong>
                        </Link>
                        <div className="dim">{row.location ?? 'location unknown'}</div>
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {row.verified.length > 0 ? (
                          <Badge tone="success">{row.verified.length} verified</Badge>
                        ) : (
                          <Badge>nothing verified</Badge>
                        )}
                        {row.claimed > 0 && <div className="tiny dim">{row.claimed} claimed, unchecked</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div>
          {result === null ? (
            <div className="card">
              <Empty>
                Reverse search starts from one provider&apos;s verified capacity. Choose one on the left.
              </Empty>
            </div>
          ) : (
            <ReverseSearchPanel result={result} />
          )}
        </div>
      </div>
    </>
  );
}
