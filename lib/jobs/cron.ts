import { timingSafeEqual } from 'node:crypto';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { audit } from '@/lib/audit';
import { enqueue } from './queue';
import { processJobs } from './runner';
import { drainContactResolution } from '@/lib/enrichment/schedule';
import { resolveSupplyIfCatalogueChanged } from '@/lib/enrichment/supply';
import { expireQuotes } from '@/lib/deal/quote';
import { expireRooms } from '@/lib/room/rooms';
import { evaluateBreakers } from '@/lib/manager/breakers';
import { handleRouteError, json } from '@/lib/api';

export type CronMode = 'tick' | 'daily';

/**
 * The slice reserved for turning demand into something callable.
 *
 * Deliberately most of the invocation. Discovery finding more opportunities
 * nobody can ring is worth less than making the ones already found reachable,
 * and discovery has its own daily job that is not on this critical path.
 */
const BACKLOG_BUDGET_MS = 20_000;

/**
 * The operating loop, run by whatever is scheduling us.
 *
 * A cron has no session, so this authenticates with a shared secret instead of
 * the RBAC path used everywhere else. It is read-limited to running the loop —
 * it cannot approve, send or decide anything a human must.
 *
 * Shared between the query-string route and the path-based ones so all three
 * do exactly the same thing. The path-based routes exist because a scheduler
 * that drops or mangles a query string would silently downgrade `daily` to
 * `tick`, and that is not a failure anybody would notice.
 */
/**
 * What is actually running, as far as the running code can tell.
 *
 * Every field is absent rather than guessed when the platform does not supply
 * it, so a self-hosted deployment reports `{}` instead of a plausible lie.
 */
function buildIdentity(): Record<string, string> {
  const identity: Record<string, string> = {};
  const commit = process.env.VERCEL_GIT_COMMIT_SHA;
  const branch = process.env.VERCEL_GIT_COMMIT_REF;
  const environment = process.env.VERCEL_ENV;
  if (commit) identity.commit = commit.slice(0, 12);
  if (branch) identity.branch = branch;
  if (environment) identity.environment = environment;
  return identity;
}

export async function runCron(request: Request, mode: CronMode) {
  try {
    const config = env();
    if (!config.CRON_SECRET) {
      return json({ error: 'CRON_SECRET is not configured; scheduled runs are disabled.' }, 503);
    }
    if (!isAuthorised(request, config.CRON_SECRET)) {
      return json({ error: 'Unauthorised' }, 401);
    }

    const startedAt = Date.now();

    // Everything this invocation does has to fit inside the platform's function
    // timeout with room to write its results. Held as an absolute deadline
    // rather than a per-step budget so every step measures against the same
    // clock.
    const deadline = startedAt + (mode === 'daily' ? 45_000 : 25_000);

    const orgs = await prisma.organization.findMany({ select: { id: true, name: true } });
    const results: Array<{ org: string; queued: number; processed: number; failed: number }> = [];
    const enrichment: Array<{
      org: string;
      scheduled: number;
      attempted: number;
      resolved: number;
      released: number;
      stillQueued: number;
      unscheduled: number;
      /** Routes whose supply status moved because the catalogue changed. */
      supplyRematched?: number;
      quotesExpired?: number;
      roomsExpired?: number;
      breakersOpened?: number;
      breakersClosed?: number;
    }> = [];

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

      // Contact resolution is not enqueued and hoped for — it runs here, first,
      // with a budget of its own.
      //
      // It used to be a job at priority 35, behind discovery and source polling.
      // Both of those do live HTTP with retries and twenty-second timeouts, the
      // whole invocation is capped at sixty seconds by the platform, and the
      // budget is only checked between batches. So in production the function
      // was killed inside discovery every single time and the enrichment job
      // was never claimed — which is why an existing backlog of a hundred and
      // fifty opportunities sat reading "Not scheduled" indefinitely while the
      // cron reported success every day.
      //
      // Reserved rather than prioritised, because reordering would only move
      // the starvation onto whatever came last. The backlog gets its slice
      // before anything else can spend it; what it does not finish, it leaves
      // in the table for the next invocation.
      const backlog = await drainContactResolution({
        orgId: org.id,
        budgetMs: Math.min(BACKLOG_BUDGET_MS, deadline - Date.now()),
      });
      enrichment.push({
        org: org.name,
        scheduled: backlog.scheduled,
        attempted: backlog.attempted,
        resolved: backlog.resolved,
        released: backlog.released,
        stillQueued: backlog.remaining,
        unscheduled: backlog.unscheduledRemaining,
      });

      // Supply is re-matched the moment the provider catalogue changes rather
      // than only on the daily sweep, so a route stops reading "blocked on
      // supply" the same tick somebody who can do the work is added. When
      // nothing has changed this costs one aggregate query.
      const supply = await resolveSupplyIfCatalogueChanged({ orgId: org.id });
      if (supply.changed && supply.outcome) {
        enrichment[enrichment.length - 1].supplyRematched = supply.outcome.changed;
      }

      // A price with a passed validity date is worse than no price: somebody
      // reads it as current and commits to it. Retiring them is two indexed
      // queries and belongs on the tick rather than the daily sweep, because
      // the window between "expired" and "shown as expired" is the window in
      // which the mistake gets made.
      const expired = await expireQuotes({ orgId: org.id });
      if (expired > 0) enrichment[enrichment.length - 1].quotesExpired = expired;

      // Same reasoning for deal rooms. A room that has expired in the database
      // but still renders is the worst of both: the prospect sees a live page
      // about their company and the owner sees a dead one.
      const roomsClosed = await expireRooms({ orgId: org.id });
      if (roomsClosed > 0) enrichment[enrichment.length - 1].roomsExpired = roomsClosed;

      // Capability health, every tick. A breaker that only trips on the daily
      // sweep is a breaker that lets a whole day of calls fail into a dialer
      // that is down — the window between "broken" and "stopped" is the only
      // thing this mechanism exists to shorten.
      const breakers = await evaluateBreakers({ orgId: org.id });
      if (breakers.opened.length > 0 || breakers.closed.length > 0) {
        enrichment[enrichment.length - 1].breakersOpened = breakers.opened.length;
        enrichment[enrichment.length - 1].breakersClosed = breakers.closed.length;
      }

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
          // Recordings of named people are deleted on schedule rather than
          // when somebody remembers. Daily is the right cadence: retention is
          // measured in months, and a sweep that runs every ten minutes would
          // scan the same rows a hundred and forty times a day to find nothing.
          { kind: 'call.expire_recordings' as const, priority: 85 },
          // The consistency sweep and the owner's brief, in that order: the
          // brief reports the questions the sweep opened, and running them the
          // other way round would report yesterday's.
          { kind: 'manager.sweep' as const, priority: 60 },
          { kind: 'manager.brief' as const, priority: 96 },
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

      // Whatever budget the backlog did not need goes to the rest of the queue.
      // The deadline is passed down so a slow connector stops the loop claiming
      // more work rather than running past the platform's timeout with jobs
      // half-finished.
      let processed = 0;
      let failed = 0;
      while (Date.now() < deadline) {
        const tick = await processJobs(10, undefined, deadline);
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
        metadata: { queued, processed, failed, enrichment: enrichment.at(-1) ?? null },
      });
    }

    // The enrichment numbers are reported separately and always, so a run that
    // scheduled nothing is visibly distinguishable from one that had nothing to
    // schedule. `unscheduled` above zero means the backlog is not yet covered
    // and the next invocation still has organisations to bring in.
    // Which build answered, and whether its migrations are the ones in the
    // branch. Deployment lag is not hypothetical here: this project spent a
    // day on a scheduler reporting success against a build several commits
    // old, and "is the deployment current?" had no answer that did not involve
    // a dashboard. The commit is public information — it is in the repository —
    // and it is the only reliable way to tell a stale deployment from a
    // healthy one from the outside.
    return json({
      ok: true,
      mode,
      durationMs: Date.now() - startedAt,
      build: buildIdentity(),
      results,
      enrichment,
    });
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
