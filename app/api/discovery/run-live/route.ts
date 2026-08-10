import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { handleRouteError, json, rateLimit } from '@/lib/api';
import { runDiscoveryAcrossMarkets } from '@/lib/discovery/run';
import { processJobs } from '@/lib/jobs/runner';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Runs every enabled live source, once, and reports per source.
 *
 * The existing "Run discovery" button queues a job and drains the queue, which
 * runs fixtures too and reports a job count rather than what each source did.
 * Answering "is discovery working" needs the opposite: only real sources, and
 * a per-source outcome including the reason for each failure.
 */
export async function POST() {
  try {
    const user = await requirePermission('discovery.run');

    if (!rateLimit(`run-live:${user.orgId}`, 6, 60_000)) {
      return json({ error: 'Too many runs in a row. Wait a minute — the sources are rate limited too.' }, 429);
    }

    const results = await runDiscoveryAcrossMarkets({ orgId: user.orgId, liveOnly: true, maxRecordsPerRun: 25 });

    // Newly created signals still need promotion and scoring before they mean
    // anything on the board, and leaving that to the nightly cron makes a
    // successful run look like it did nothing.
    await processJobs(25);

    const sources = results.map((result) => {
      const error = result.errors[0] ?? null;
      return {
        name: result.dataSourceKey,
        fetched: result.recordsFetched,
        created: result.signalsCreated,
        // A skip is a configuration mismatch, not a fault — a jurisdiction
        // source pointed at a nationwide market. Shown differently.
        skipped: Boolean(error && error.includes('cannot serve a nationwide market')),
        error: error ? error.slice(0, 300) : null,
      };
    });

    return json({
      ranAt: new Date().toISOString(),
      totals: {
        fetched: results.reduce((sum, r) => sum + r.recordsFetched, 0),
        created: results.reduce((sum, r) => sum + r.signalsCreated, 0),
        duplicate: results.reduce((sum, r) => sum + r.signalsDuplicate, 0),
      },
      sources,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
