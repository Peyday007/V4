import Link from 'next/link';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { can } from '@/lib/auth/session';
import { requirePagePermission } from '@/lib/auth/page';
import { ActionButton } from '@/components/ActionButton';
import { Badge, Empty, humanize, relativeDays } from '@/components/ui';

export const dynamic = 'force-dynamic';

const STATUSES = ['NEW', 'TRIAGED', 'PROMOTED', 'DISMISSED', 'DUPLICATE'];

export default async function SignalsPage({ searchParams }: { searchParams: { status?: string; category?: string } }) {
  const user = await requirePagePermission('discovery.read');
  const canReview = can(user, 'discovery.review');

  const where: Prisma.DiscoverySignalWhereInput = { orgId: user.orgId };
  if (searchParams.status) where.status = searchParams.status as never;
  else where.status = { in: ['NEW', 'TRIAGED'] };
  if (searchParams.category) where.category = searchParams.category as never;

  const [signals, sources] = await Promise.all([
    prisma.discoverySignal.findMany({
      where,
      include: { company: true, evidence: true, dataSource: true },
      orderBy: [{ strength: 'desc' }, { observedAt: 'desc' }],
      take: 200,
    }),
    prisma.dataSource.findMany({ where: { orgId: user.orgId }, orderBy: { name: 'asc' } }),
  ]);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Discovery signals</h1>
          <p>
            Raw evidence of a possible deal. Nothing here is a confirmed business fact — a signal is a reason to look, and
            weak ones are held for human triage rather than turned into opportunities automatically.
          </p>
        </div>
        {can(user, 'discovery.run') && (
          <ActionButton endpoint="/api/discovery/run" body={{ inline: true }} className="primary">
            Run all sources
          </ActionButton>
        )}
      </div>

      <div className="filter-bar">
        {STATUSES.map((status) => (
          <Link key={status} href={`/signals?status=${status}`} className={`filter-chip${searchParams.status === status ? ' active' : ''}`}>
            {humanize(status)}
          </Link>
        ))}
        {['SUBCONTRACTING', 'BROKERAGE', 'DISTRIBUTION', 'GENERAL'].map((category) => (
          <Link
            key={category}
            href={`/signals?category=${category}`}
            className={`filter-chip${searchParams.category === category ? ' active' : ''}`}
          >
            {humanize(category)}
          </Link>
        ))}
      </div>

      <div className="card mb">
        <h2>Configured sources</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Type</th>
                <th>Access basis</th>
                <th>Last run</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <tr key={source.id}>
                  <td>
                    <strong>{source.name}</strong>
                    <div className="tiny dim mono">{source.connector}</div>
                  </td>
                  <td className="small">{humanize(source.sourceType)}</td>
                  <td className="tiny muted">{source.accessBasis}</td>
                  <td className="tiny dim">{source.lastRunAt ? relativeDays(source.lastRunAt) : 'never'}</td>
                  <td>
                    <Badge tone={source.isEnabled ? 'success' : ''}>{source.isEnabled ? source.lastRunStatus ?? 'enabled' : 'disabled'}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {signals.length === 0 ? (
        <div className="card">
          <Empty>No signals in this view.</Empty>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Signal</th>
                <th>Company</th>
                <th>Category</th>
                <th className="num">Strength</th>
                <th className="num">Confidence</th>
                <th>Source</th>
                <th>Status</th>
                {canReview && <th></th>}
              </tr>
            </thead>
            <tbody>
              {signals.map((signal) => (
                <tr key={signal.id}>
                  <td>
                    <strong>{signal.headline}</strong>
                    <div className="tiny dim">{signal.detail.slice(0, 220)}</div>
                  </td>
                  <td className="small">
                    {signal.company ? <Link href={`/companies/${signal.companyId}`}>{signal.company.legalName}</Link> : <span className="dim">Unresolved</span>}
                  </td>
                  <td><Badge>{humanize(signal.category)}</Badge></td>
                  <td className="num">{Math.round(signal.strength * 100)}%</td>
                  <td className="num">{Math.round(signal.confidence * 100)}%</td>
                  <td className="tiny dim">
                    {signal.dataSource?.name}
                    {signal.evidence?.sourceUrl && (
                      <div>
                        <a href={signal.evidence.sourceUrl} target="_blank" rel="noreferrer noopener">
                          source
                        </a>
                      </div>
                    )}
                  </td>
                  <td><Badge tone={signal.status === 'PROMOTED' ? 'success' : signal.status === 'DISMISSED' ? '' : 'warning'}>{humanize(signal.status)}</Badge></td>
                  {canReview && (
                    <td>
                      {(signal.status === 'NEW' || signal.status === 'TRIAGED') && (
                        <div className="row">
                          <ActionButton endpoint={`/api/signals/${signal.id}`} body={{ action: 'promote' }} className="sm">
                            Promote
                          </ActionButton>
                          <ActionButton endpoint={`/api/signals/${signal.id}`} body={{ action: 'dismiss' }} className="sm">
                            Dismiss
                          </ActionButton>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
