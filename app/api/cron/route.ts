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
      if (mode === 'daily') {
        // Idempotency keys are date-stamped so a retried cron on the same day
        // does not stack duplicate sweeps.
        const day = new Date().toISOString().slice(0, 10);
        const jobs = [
          { kind: 'discovery.run_all' as const, priority: 20 },
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
