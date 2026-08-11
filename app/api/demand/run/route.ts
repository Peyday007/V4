import { requirePermission } from '@/lib/auth/session';
import { handleRouteError, json, rateLimit } from '@/lib/api';
import { runAllDemandSources } from '@/lib/demand/run';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Manual demand refresh.
 *
 * The same code the recurring worker runs — `runAllDemandSources` — rather
 * than a parallel implementation. A manual path that behaved differently from
 * the scheduled one would mean the button and the cron could disagree about
 * what the pipeline does, and the button is what people trust.
 */
export async function POST() {
  try {
    const user = await requirePermission('discovery.run');

    if (!rateLimit(`demand-run:${user.orgId}`, 4, 60_000)) {
      return json({ error: 'Too many runs in a row. Wait a minute — the portals are rate limited too.' }, 429);
    }

    const { sources, pipeline } = await runAllDemandSources({
      orgId: user.orgId,
      userId: user.id,
      maxRecordsPerSource: 120,
    });

    return json({
      ranAt: new Date().toISOString(),
      sources,
      events: {
        verified: pipeline.verification.verified,
        expired: pipeline.verification.expired,
        quarantined: pipeline.verification.quarantined,
      },
      accounts: pipeline.resolution,
      routes: {
        created: pipeline.routes.routesCreated,
        updated: pipeline.routes.routesUpdated,
        expired: pipeline.routes.routesExpired,
        byRoute: pipeline.routes.byRoute,
        byTier: pipeline.routes.byTier,
        byFriction: pipeline.routes.byFriction,
        lowFrictionQueue: pipeline.routes.lowFrictionQueue,
        // Why a playbook did not fire is as useful as why one did, and is the
        // thing that shows the engine is not inventing routes.
        skipped: pipeline.routes.skipped.slice(0, 40),
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
