import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePagePermission } from '@/lib/auth/page';
import { campaignOutcome } from '@/lib/campaign/outcomes';
import { campaignReadiness } from '@/lib/campaign/model';
import { configuredCoverage } from '@/lib/portfolio/concentration';
import { Badge, Empty, money } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Commercial campaigns.
 *
 * Each row carries its outcome through to collected gross profit, and the
 * first empty rung of that chain. A campaign list that shows activity and not
 * money is exactly how a campaign that quotes beautifully and collects nothing
 * survives three quarters — the number that matters is the last one, and the
 * useful number is which rung before it is empty.
 */
export default async function CampaignsPage() {
  const user = await requirePagePermission('campaign.read');
  const coverage = configuredCoverage();

  const campaigns = await prisma.campaign.findMany({
    where: { orgId: user.orgId, dataMode: 'PRODUCTION' },
    orderBy: [{ state: 'asc' }, { createdAt: 'desc' }],
    include: { evidence: true, channels: true, conditions: true },
  });

  const rows = await Promise.all(
    campaigns.map(async (c) => ({
      campaign: c,
      outcome: await campaignOutcome({ orgId: user.orgId, campaignId: c.id }),
      readiness: campaignReadiness({
        draft: {
          name: c.name, thesis: c.thesis, whyNow: c.whyNow, route: c.route,
          targetStates: c.targetStates, buyerProfile: c.buyerProfile,
          providerProfile: c.providerProfile, requiredCapability: c.requiredCapability,
          testingHours: c.testingHours, testingCostCents: c.testingCostCents,
          testingCostBasis: c.testingCostBasis, budgetCents: c.budgetCents,
          authorityGrantedById: c.authorityGrantedById,
          evidence: c.evidence.map((e) => ({
            kind: e.kind as 'SUPPORTING' | 'CONTRARY',
            claim: e.claim, evidenceClass: e.evidenceClass, sourceUrl: e.sourceUrl,
          })),
          channels: c.channels.map((ch) => ({
            kind: ch.kind, enabled: ch.enabled, budgetCents: ch.budgetCents,
            authorisedById: ch.authorisedById, outcomeMetric: ch.outcomeMetric,
          })),
          conditions: c.conditions.map((cd) => ({
            kind: cd.kind, metric: cd.metric, comparator: cd.comparator,
            threshold: cd.threshold, afterDays: cd.afterDays, statement: cd.statement,
          })),
        },
        reachableStates: coverage.reachable,
      }),
    })),
  );

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Commercial campaigns</h1>
          <p>
            A campaign is a thesis about where money is, and the machinery to find out whether it is there.
            Each one says what it believes, what would make it wrong, what finding out costs, who authorised
            that cost, and what came back.
          </p>
        </div>
        <Link href="/demand/sources" className="btn secondary">Source health</Link>
      </div>

      <div className="alert info small" data-testid="campaign-coverage">
        <strong>What campaigns can currently reach:</strong> {coverage.verdict}
      </div>

      {rows.length === 0 ? (
        <div className="card">
          <Empty>
            No campaigns yet. A campaign is how a new market, trade or commercial route enters the system —
            without one, the engine can only produce the shapes of work its existing plays already cover.
          </Empty>
        </div>
      ) : (
        <div className="table-scroll">
          <table className="table tiny" data-testid="campaign-table">
            <thead>
              <tr>
                <th>Campaign</th>
                <th>State</th>
                <th>Route</th>
                <th>Where</th>
                <th className="num">Routes</th>
                <th className="num">Spoken to</th>
                <th className="num">Quotes</th>
                <th className="num">Collected GP</th>
                <th>First empty rung</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ campaign, outcome, readiness }) => (
                <tr key={campaign.id} data-testid={`campaign-${campaign.id}`}>
                  <td>
                    <Link href={`/campaigns/${campaign.id}`}><strong>{campaign.name}</strong></Link>
                    <div className="dim">{campaign.thesis.slice(0, 90)}…</div>
                    {!readiness.ready && campaign.state === 'DRAFT' && (
                      <div className="tiny">
                        <Badge tone="warning">{readiness.blockers.length} thing(s) missing</Badge>
                      </div>
                    )}
                  </td>
                  <td>
                    <Badge
                      tone={
                        campaign.state === 'RUNNING' ? 'success'
                          : campaign.state === 'KILLED' ? 'danger'
                            : campaign.state === 'AWAITING_AUTHORITY' ? 'warning' : ''
                      }
                    >
                      {campaign.state.toLowerCase().replace(/_/g, ' ')}
                    </Badge>
                  </td>
                  <td className="dim">{campaign.route.toLowerCase().replace(/_/g, ' ')}</td>
                  <td className="dim">{campaign.targetStates.join(', ') || '—'}</td>
                  <td className="num">{outcome.routesGenerated}</td>
                  <td className="num">{outcome.conversationsHeld}</td>
                  <td className="num">{outcome.quotesSent}</td>
                  {/* The only figure that settles anything. Everything to its
                      left is progress; this is proof. */}
                  <td className="num">
                    {outcome.collectedGrossProfit > 0
                      ? <strong>{money(outcome.collectedGrossProfit)}</strong>
                      : <span className="dim">none yet</span>}
                  </td>
                  <td className="dim">{outcome.firstEmptyStage ?? 'complete'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
