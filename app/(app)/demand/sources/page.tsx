import Link from 'next/link';
import { requirePagePermission } from '@/lib/auth/page';
import { prisma } from '@/lib/db';
import { demandSourceHealth } from '@/lib/demand/run';
import { funnelTotals, sourceScorecards } from '@/lib/demand/performance';
import { DemandControls } from '@/components/DemandControls';
import { EnrichmentPanel } from '@/components/EnrichmentPanel';
import { enrichmentOverview } from '@/lib/enrichment/report';

export const dynamic = 'force-dynamic';

/**
 * Source health and the outcome funnel.
 *
 * Moved off the calling board on purpose. A connector warning is worth seeing
 * and is not worth putting between an operator and their first call of the
 * day — it belongs where somebody goes to ask why the queue is thin, not in
 * front of the queue itself.
 */
export default async function SourcesPage() {
  const user = await requirePagePermission('discovery.read');

  const [health, funnel, scorecards, events, actionable, enrichment] = await Promise.all([
    demandSourceHealth(user.orgId),
    funnelTotals(user.orgId),
    sourceScorecards(user.orgId),
    prisma.demandEvent.count({ where: { orgId: user.orgId } }),
    prisma.routeHypothesis.count({
      where: { orgId: user.orgId, tier: { in: ['ACTIVE_DEMAND', 'STRONG_TRIGGER'] }, status: { not: 'EXPIRED' } },
    }),
    enrichmentOverview(user.orgId),
  ]);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Source health</h1>
          <p>Where the demand comes from, whether each source is running, and what it has produced so far.</p>
        </div>
        <Link href="/demand" className="btn secondary">Back to the queue</Link>
      </div>

      <EnrichmentPanel overview={enrichment} />

      <DemandControls
        health={health}
        totalEvents={events}
        actionable={actionable}
        funnel={funnel}
        scorecards={scorecards.map((s) => ({
          connector: s.connector,
          sourceRecords: s.counts.SOURCE_RECORD,
          events: s.counts.DEMAND_EVENT,
          verifiedLeads: s.counts.VERIFIED_LEAD,
          quoted: s.counts.QUOTED,
          won: s.counts.WON,
          paid: s.counts.PAID,
          collectedGrossProfit: s.collectedGrossProfit,
          verdict: s.verdict,
        }))}
      />
    </>
  );
}
