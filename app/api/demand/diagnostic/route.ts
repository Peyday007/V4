import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { handleRouteError, json } from '@/lib/api';
import { demandSourceHealth } from '@/lib/demand/run';
import { describeDistribution, inspectDistribution } from '@/lib/discovery/diagnostics';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Read-only production diagnostic.
 *
 * The development environment cannot reach the owner's database or the live
 * portals, so nothing here can be verified from a sandbox. This endpoint is
 * how that gap closes: it runs where the real data is, reads and never writes,
 * and returns everything needed to judge whether the demand engine is actually
 * producing demand — source health, event counts by type and date coverage,
 * tier and friction distributions, route counts by commercial route, the
 * reasons events were rejected or quarantined, fulfilment gaps, and the
 * evidence behind each live route.
 *
 * It reports what is there. It makes no claim that the numbers are good.
 */
export async function GET() {
  try {
    const user = await requirePermission('discovery.read');
    const orgId = user.orgId;
    const now = new Date();

    const [
      health,
      rawSignals,
      events,
      eventsByType,
      eventsByLifecycle,
      routes,
      accounts,
      recentRuns,
      opportunities,
      quotes,
    ] = await Promise.all([
      demandSourceHealth(orgId),
      prisma.discoverySignal.count({ where: { orgId } }),
      prisma.demandEvent.findMany({
        where: { orgId },
        select: {
          id: true,
          type: true,
          lifecycle: true,
          verification: true,
          connector: true,
          eventDate: true,
          discoveredAt: true,
          deadlineAt: true,
          sourceUrl: true,
          headline: true,
          cityName: true,
          stateCode: true,
          dedupeKey: true,
          expiredReason: true,
          quarantineReason: true,
          confidence: true,
        },
        orderBy: { discoveredAt: 'desc' },
        take: 500,
      }),
      prisma.demandEvent.groupBy({ by: ['type'], where: { orgId }, _count: true }),
      prisma.demandEvent.groupBy({ by: ['lifecycle'], where: { orgId }, _count: true }),
      prisma.routeHypothesis.findMany({
        where: { orgId },
        include: {
          event: { select: { type: true, eventDate: true, sourceUrl: true, headline: true, confirmedFacts: true, inferredFacts: true } },
          company: { select: { legalName: true, cityName: true, stateCode: true } },
        },
        orderBy: [{ tier: 'asc' }, { friction: 'asc' }],
        take: 400,
      }),
      prisma.company.count({ where: { orgId } }),
      prisma.sourceRun.findMany({
        where: { orgId },
        orderBy: { startedAt: 'desc' },
        take: 30,
      }),
      prisma.opportunity.count({ where: { orgId } }),
      prisma.quote.count({ where: { orgId } }),
    ]);

    // Event-date coverage is the single most diagnostic number here: an event
    // without a source date cannot legitimately reach tier A or B, so a low
    // figure explains an empty demand board on its own.
    const withEventDate = events.filter((e) => e.eventDate).length;
    const withSourceUrl = events.filter((e) => e.sourceUrl).length;

    const tierCounts = tally(routes.map((r) => r.tier));
    const frictionCounts = tally(routes.map((r) => r.friction));
    const routeCounts = tally(routes.map((r) => r.route));
    const statusCounts = tally(routes.map((r) => r.status));
    const structureCounts = tally(routes.map((r) => r.commercialStructure ?? 'UNSET'));

    // Component distributions, so a dimension that has quietly become a
    // constant is visible without anybody doing arithmetic by hand.
    const providerCounts = routes.map((r) => Math.round(r.providerCount * 100) / 100);
    const grossProfits = routes
      .map((r) => (r.estimatedGrossProfit === null ? null : Number(r.estimatedGrossProfit)))
      .filter((v): v is number => v !== null);
    const humanMinutes = routes.map((r) => r.estimatedHumanMinutes ?? 0);

    const distributions = [
      describeDistribution('providerCount', providerCounts),
      describeDistribution('estimatedGrossProfit', grossProfits),
      describeDistribution('estimatedHumanMinutes', humanMinutes),
    ];
    const warnings = distributions.flatMap(inspectDistribution);

    const actionable = routes.filter(
      (r) => (r.tier === 'ACTIVE_DEMAND' || r.tier === 'STRONG_TRIGGER') && r.status !== 'EXPIRED',
    );

    // Duplicate detection reported, never acted on. Collapsing an uncertain
    // pair would fuse two real openings at neighbouring addresses.
    const keyCounts = new Map<string, number>();
    for (const e of events) keyCounts.set(e.dedupeKey, (keyCounts.get(e.dedupeKey) ?? 0) + 1);
    const duplicateKeys = [...keyCounts.entries()].filter(([, n]) => n > 1);

    return json({
      generatedAt: now.toISOString(),
      environment: {
        // Whether a key is present, never its value.
        samGovConfigured: Boolean(process.env.SAM_GOV_API_KEY),
        socrataAppTokenPresent: Boolean(process.env.SOCRATA_APP_TOKEN),
        googlePlacesConfigured: Boolean(process.env.GOOGLE_PLACES_API_KEY),
      },

      sourceHealth: health,

      recentRuns: recentRuns.map((r) => ({
        connector: r.connector,
        status: r.status,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        recordsExamined: r.recordsExamined,
        eventsCreated: r.eventsCreated,
        eventsUpdated: r.eventsUpdated,
        eventsRejected: r.eventsRejected,
        cursor: r.cursor,
        error: r.error,
        details: r.details,
      })),

      // The funnel, in terms that cannot flatter it.
      pipelineTruth: {
        rawSourceRecords: rawSignals,
        demandEvents: events.length,
        accounts,
        routeHypotheses: routes.length,
        verifiedLeads: actionable.length,
        qualifiedOpportunities: routes.filter((r) => r.status === 'PURSUE').length,
        pursuits: opportunities,
        quotes,
        // Nothing downstream exists yet, and saying zero is the honest answer.
        awards: 0,
        activeJobs: 0,
        completedJobs: 0,
        paidJobs: 0,
      },

      events: {
        byType: Object.fromEntries(eventsByType.map((r) => [r.type, r._count])),
        byLifecycle: Object.fromEntries(eventsByLifecycle.map((r) => [r.lifecycle, r._count])),
        dateCoverage: {
          total: events.length,
          withExternalEventDate: withEventDate,
          withoutExternalEventDate: events.length - withEventDate,
          withDurableSourceUrl: withSourceUrl,
          note:
            'An event without an external date cannot reach tier A or B by design. A high "without" count is the ' +
            'explanation for an empty demand board, not a bug in scoring.',
        },
        expired: events
          .filter((e) => e.lifecycle === 'EXPIRED')
          .slice(0, 25)
          .map((e) => ({ headline: e.headline, reason: e.expiredReason })),
        quarantined: events
          .filter((e) => e.lifecycle === 'QUARANTINED')
          .slice(0, 25)
          .map((e) => ({ headline: e.headline, reason: e.quarantineReason })),
        duplicateKeys: duplicateKeys.slice(0, 25).map(([key, count]) => ({ key, count })),
      },

      routes: {
        byTier: tierCounts,
        byFriction: frictionCounts,
        byRoute: routeCounts,
        byStatus: statusCounts,
        byCommercialStructure: structureCounts,
        lowFrictionQueue: routes.filter((r) => r.friction === 'LOW' && r.status !== 'EXPIRED').length,
        fulfilmentGaps: routes.filter((r) => r.fulfilmentStatus !== 'AVAILABLE').length,
      },

      scoreDistributions: distributions,
      distributionWarnings: warnings,

      credibility: verdict({ actionable: actionable.length, events: events.length, withEventDate, warnings: warnings.length }),

      // Everything behind each live route, so any number on the board can be
      // traced to the record it came from.
      liveRoutes: actionable.slice(0, 60).map((r) => ({
        account: r.company.legalName,
        location: [r.company.cityName, r.company.stateCode].filter(Boolean).join(', ') || null,
        route: r.route,
        playbook: r.playbookKey,
        headline: r.headline,
        tier: r.tier,
        friction: r.friction,
        frictionReason: r.frictionReason,
        needIsConfirmed: r.needIsConfirmed,
        rationale: r.rationale,
        event: {
          type: r.event.type,
          externalDate: r.event.eventDate?.toISOString() ?? null,
          sourceUrl: r.event.sourceUrl,
          headline: r.event.headline,
          confirmedFacts: r.event.confirmedFacts,
          inferredFacts: r.event.inferredFacts,
        },
        window: {
          label: r.buyingWindow,
          opensAt: r.windowOpensAt?.toISOString() ?? null,
          closesAt: r.windowClosesAt?.toISOString() ?? null,
        },
        fulfilment: { status: r.fulfilmentStatus, providerCount: r.providerCount },
        economics: {
          buyerPrice: r.estimatedBuyerPrice,
          providerCost: r.estimatedProviderCost,
          grossProfit: r.estimatedGrossProfit,
          humanMinutes: r.estimatedHumanMinutes,
          basis: r.economicsBasis,
        },
        commercialStructure: r.commercialStructure,
        structureReason: r.structureReason,
        status: r.status,
        statusReason: r.statusReason,
        missingInfo: r.missingInfo,
        nextAction: r.nextAction,
      })),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

function tally<T extends string>(values: T[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

/**
 * Whether this output can be acted on.
 *
 * "No demand found" is a legitimate and important verdict, distinct from
 * "something is broken". Reporting the two the same way is what let a board of
 * directory listings pass for a pipeline.
 */
function verdict(input: {
  actionable: number;
  events: number;
  withEventDate: number;
  warnings: number;
}): { verdict: string; reason: string } {
  if (input.events === 0) {
    return {
      verdict: 'NO_EVENTS',
      reason:
        'No demand events have been ingested at all. Check source health above: a source reporting ' +
        'NOT_CONFIGURED needs configuration, and one reporting FAILED needs its error read.',
    };
  }
  if (input.withEventDate === 0) {
    return {
      verdict: 'NOT_CREDIBLE',
      reason:
        'Events exist but not one carries an external date, so none can legitimately be tier A or B. ' +
        'This is a connector problem — a source date is being dropped somewhere in ingestion.',
    };
  }
  if (input.actionable === 0) {
    return {
      verdict: 'NO_DEMAND_FOUND',
      reason:
        'Events were ingested and dated, but none is currently within a buying window with a resolved account. ' +
        'This is an honest empty result, not a fault. More jurisdictions or an inbound channel would widen it.',
    };
  }
  if (input.warnings > 0) {
    return {
      verdict: 'SUSPECT',
      reason: 'Actionable demand exists, but at least one score dimension looks degenerate. Read the warnings.',
    };
  }
  return { verdict: 'CREDIBLE', reason: `${input.actionable} route(s) carry dated demand inside an open window.` };
}
