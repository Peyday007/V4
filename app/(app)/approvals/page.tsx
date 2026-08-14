import Link from 'next/link';
import { prisma } from '@/lib/db';
import { can } from '@/lib/auth/session';
import { requirePageAny } from '@/lib/auth/page';
import { ActionButton } from '@/components/ActionButton';
import { Badge, Empty, humanize, money, relativeDays, StatusBadge } from '@/components/ui';
import { GradedStat } from '@/components/Figure';
import { buyerPriceOf, providerCostOf, grossProfitOf, presentMoney } from '@/lib/evidence/economics';

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage({ searchParams }: { searchParams: { status?: string } }) {
  const user = await requirePageAny('deal.approve', 'finance.risk.review');
  const canDecide = can(user, 'deal.approve');
  const status = searchParams.status ?? 'PENDING';

  const approvals = await prisma.approval.findMany({
    where: { orgId: user.orgId, ...(status === 'all' ? {} : { status: status as never }) },
    include: {
      opportunity: { include: { parties: { where: { isPrimary: true }, include: { company: true } } } },
      deal: true,
      document: true,
      decidedBy: true,
      // Deal-progression approvals live on the route path. Included here rather
      // than given a queue of their own: an owner should have one list of
      // decisions waiting on them, not two that each look complete.
      route: { select: { id: true, headline: true, company: { select: { legalName: true } } } },
      routeQuote: {
        select: {
          id: true, version: true, basis: true, buyerPrice: true, providerCost: true,
          grossProfit: true, grossMarginPct: true, costSideMissing: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
    take: 200,
  });

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Approvals</h1>
          <p>
            Commitments the system will not make on its own: pricing, contract value, margin exceptions, credit and anything
            that leaves the building. Each item shows the figures and the rule that triggered the review.
          </p>
        </div>
        <Badge tone={approvals.length > 0 ? 'warning' : 'success'}>{approvals.length}</Badge>
      </div>

      <div className="filter-bar">
        {['PENDING', 'APPROVED', 'REJECTED', 'all'].map((option) => (
          <Link key={option} href={`/approvals?status=${option}`} className={`filter-chip${status === option ? ' active' : ''}`}>
            {humanize(option)}
          </Link>
        ))}
      </div>

      {approvals.length === 0 ? (
        <div className="card">
          <Empty>Nothing waiting on a decision.</Empty>
        </div>
      ) : (
        approvals.map((approval) => (
          <div className="card" key={approval.id}>
            <div className="card-title">
              <div>
                <h2>{approval.title}</h2>
                <div className="row">
                  <Badge tone="accent">{humanize(approval.type)}</Badge>
                  <StatusBadge status={approval.status} />
                  {approval.amount && <Badge>{money(approval.amount)}</Badge>}
                  <span className="tiny dim">requested {relativeDays(approval.createdAt)}</span>
                </div>
              </div>
              {approval.routeId ? (
                <Link href={`/demand/opportunity/${approval.routeId}`} className="btn sm">
                  Open the opportunity
                </Link>
              ) : approval.opportunityId ? (
                <Link href={`/opportunities/${approval.opportunityId}`} className="btn sm">
                  Open deal
                </Link>
              ) : null}
            </div>

            <p className="small">{approval.summary}</p>

            {approval.route && (
              <p className="tiny dim">
                {approval.route.company.legalName} — {approval.route.headline}
              </p>
            )}

            {approval.routeQuote && (() => {
              // The one screen where a number decides whether money is
              // committed, so it goes through the same rule as everywhere else
              // — and here a dash was the failure mode: an owner reading "—"
              // beside a buyer price has no idea whether the margin is thin or
              // simply unknown.
              const q = {
                basis: approval.routeQuote.basis,
                buyerPrice: approval.routeQuote.buyerPrice === null ? null : Number(approval.routeQuote.buyerPrice),
                providerCost: approval.routeQuote.providerCost === null ? null : Number(approval.routeQuote.providerCost),
                costSideMissing: approval.routeQuote.costSideMissing,
              };
              return (
                <div className="grid grid-4 mb">
                  <GradedStat label="Buyer price" presentation={presentMoney(buyerPriceOf(q))} />
                  <GradedStat label="Provider cost" presentation={presentMoney(providerCostOf(q))} />
                  <GradedStat label="Gross profit" presentation={presentMoney(grossProfitOf(q))} />
                  <div className="stat">
                    <div className="stat-label">Quote version</div>
                    <div className="stat-value">v{approval.routeQuote.version}</div>
                    <div className="tiny dim">
                      {approval.routeQuote.grossMarginPct === null || q.costSideMissing
                        ? 'No margin can be stated without a provider cost.'
                        : `${approval.routeQuote.grossMarginPct.toFixed(1)}% margin`}
                    </div>
                  </div>
                </div>
              );
            })()}

            {approval.deal && (
              <div className="grid grid-4 mb">
                <div className="stat">
                  <div className="stat-label">Buyer price</div>
                  <div className="stat-value">{money(approval.deal.buyerPrice)}</div>
                </div>
                <div className="stat">
                  <div className="stat-label">Cost</div>
                  <div className="stat-value">{money(approval.deal.supplierCost)}</div>
                </div>
                <div className="stat">
                  <div className="stat-label">Gross profit</div>
                  <div className="stat-value">{money(approval.deal.grossProfit)}</div>
                </div>
                <div className="stat">
                  <div className="stat-label">Margin</div>
                  <div className="stat-value">{approval.deal.grossMarginPct !== null ? `${approval.deal.grossMarginPct}%` : '—'}</div>
                </div>
              </div>
            )}

            {approval.deal && approval.deal.risks.length > 0 && (
              <div className="alert warning small">
                <strong>Risks:</strong>
                <ul className="list-reset">
                  {approval.deal.risks.map((risk) => (
                    <li key={risk}>• {risk}</li>
                  ))}
                </ul>
              </div>
            )}

            {approval.document && (
              <details>
                <summary className="small muted">Review the document being approved</summary>
                <pre className="mono pre-wrap" style={{ maxHeight: 400, overflow: 'auto' }}>{approval.document.body}</pre>
              </details>
            )}

            {approval.status === 'PENDING' && canDecide && (
              <div className="row mt">
                <ActionButton endpoint={`/api/approvals/${approval.id}`} body={{ decision: 'APPROVED' }} className="success">
                  Approve
                </ActionButton>
                <ActionButton
                  endpoint={`/api/approvals/${approval.id}`}
                  body={{ decision: 'CHANGES_REQUESTED' }}
                  promptFor={{ key: 'note', label: 'What needs to change?' }}
                >
                  Request changes
                </ActionButton>
                <ActionButton
                  endpoint={`/api/approvals/${approval.id}`}
                  body={{ decision: 'REJECTED' }}
                  className="danger"
                  promptFor={{ key: 'note', label: 'Reason for rejecting?' }}
                >
                  Reject
                </ActionButton>
              </div>
            )}

            {approval.decidedBy && (
              <div className="tiny dim mt">
                {humanize(approval.status)} by {approval.decidedBy.name} {relativeDays(approval.decidedAt)}
                {approval.decisionNote ? ` — ${approval.decisionNote}` : ''}
              </div>
            )}
          </div>
        ))
      )}
    </>
  );
}
