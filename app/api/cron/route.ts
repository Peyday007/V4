import { timingSafeEqual } from 'node:crypto';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { audit } from '@/lib/audit';
import { enqueue } from '@/lib/jobs/queue';
import { processJobs } from '@/lib/jobs/runner';
import { handleRouteError, json } from '@/lib/api';

export const dynamic = 'force-dynamic';
// Vercel serverless functions are capped; 60s is the Hobby ceiling.
export const maxDuration = 60;

/**
 * Scheduler entry point.
 *
 * A cron has no session, so this authenticates with a shared secret instead of
 * the RBAC path used everywhere else. It is the only route that does, and it
 * is read-limited to running the operating loop — it cannot approve, send or
 * decide anything a human must.
 *
 *   GET /api/cron?mode=tick   drain the queue (frequent, cheap)
 *   GET /api/cron?mode=daily  full sweep: discovery, follow-ups, plan, metrics
 */
export async function GET(request: Request) {
  try {
    const config = env();
    if (!config.CRON_SECRET) {
      return json({ error: 'CRON_SECRET is not configured; scheduled runs are disabled.' }, 503);
    }
    if (!isAuthorised(request, config.CRON_SECRET)) {
      return json({ error: 'Unauthorised' }, 401);
    }

    const url = new URL(request.url);
    const mode = url.searchParams.get('mode') === 'daily' ? 'daily' : 'tick';
    const startedAt = Date.now();

    const orgs = await prisma.organization.findMany({ select: { id: true, name: true } });
    const results: Array<{ org: string; queued: number; processed: number; failed: number }> = [];

    for (const org of orgs) {
      let queued = 0;

      // Demand polling runs on every tick, not only the daily sweep. The
      // connectors decide their own cadence — `demand.poll_sources` only runs
      // the ones whose interval has elapsed — so asking often is cheap, and it
      // means an inbound request entered at nine is routed by nine-fifteen
      // rather than waiting for tomorrow's sweep.
      const pollQueued = await enqueue({
        orgId: org.id,
        kind: 'demand.poll_sources',
        priority: 25,
        // One in flight at a time. A slow portal must not stack polls.
        idempotencyKey: `cron:demand.poll_sources:${new Date().toISOString().slice(0, 13)}`,
        skipIfCompleted: false,
      });
      if (pollQueued) queued += 1;

      // Contact resolution runs on every tick too, and for the same reason.
      // An opportunity the engine created at nine with nobody to ring is worth
      // nothing until somebody can ring it, so the gap between "discovered"
      // and "callable" is measured in minutes rather than in days. The worker
      // schedules what is missing and works a bounded batch, so asking often
      // costs two queries when there is nothing to do.
      const enrichQueued = await enqueue({
        orgId: org.id,
        kind: 'enrichment.resolve_contacts',
        priority: 35,
        // One in flight. A slow provider must not stack workers that would all
        // claim from the same table.
        idempotencyKey: 'cron:enrichment.resolve_contacts',
        skipIfCompleted: false,
      });
      if (enrichQueued) queued += 1;

      if (mode === 'daily') {
        // Idempotency keys are date-stamped so a retried cron on the same day
        // does not stack duplicate sweeps.
        const day = new Date().toISOString().slice(0, 10);
        const jobs = [
          { kind: 'discovery.run_all' as const, priority: 20 },
          // Revalidation: re-checks every live event's window so a deadline
          // that passed overnight stops being presented as work.
          { kind: 'demand.run_pipeline' as const, priority: 30 },
          // Supply is re-matched daily rather than per tick: recruiting a
          // provider is a slower thing than discovering an event, and a route
          // blocked on supply should stop being blocked the day somebody who
          // can do the work is added to the catalogue.
          { kind: 'supply.match_routes' as const, priority: 38 },
          { kind: 'followup.generate' as const, priority: 40 },
          { kind: 'planning.daily' as const, priority: 90 },
          { kind: 'analytics.snapshot' as const, priority: 95 },
        ];
        for (const job of jobs) {
          const created = await enqueue({
            orgId: org.id,
            kind: job.kind,
            priority: job.priority,
            idempotencyKey: `cron:${job.kind}:${day}`,
            skipIfCompleted: true,
          });
          if (created) queued += 1;
        }
      }

      // Drain until the chain settles or the function runs out of budget.
      let processed = 0;
      let failed = 0;
      const budgetMs = mode === 'daily' ? 45_000 : 25_000;
      while (Date.now() - startedAt < budgetMs) {
        const tick = await processJobs(10);
        processed += tick.processed;
        failed += tick.failed;
        if (tick.processed === 0) break;
      }

      results.push({ org: org.name, queued, processed, failed });
      await audit({
        orgId: org.id,
        actorType: 'system',
        action: `cron.${mode}`,
        entityType: 'Job',
        metadata: { queued, processed, failed },
      });
    }

    return json({ ok: true, mode, durationMs: Date.now() - startedAt, results });
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * Accepts Vercel Cron's `Authorization: Bearer <CRON_SECRET>` header, or an
 * `x-cron-secret` header for other schedulers. Compared in constant time.
 */
function isAuthorised(request: Request, secret: string): boolean {
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  const header = request.headers.get('x-cron-secret');
  const presented = bearer || header;
  if (!presented) return false;

  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
