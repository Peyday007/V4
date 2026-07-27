import { z } from 'zod';
import { requirePermission } from '@/lib/auth/session';
import { audit } from '@/lib/audit';
import { enqueue } from '@/lib/jobs/queue';
import { processJobs } from '@/lib/jobs/runner';
import { handleRouteError, json, rateLimit } from '@/lib/api';

export const dynamic = 'force-dynamic';

const schema = z.object({
  dataSourceId: z.string().optional(),
  /** Run inline instead of queuing — used by the demo and by admin triggers. */
  inline: z.boolean().default(true),
});

export async function POST(request: Request) {
  try {
    const user = await requirePermission('discovery.run');
    if (!rateLimit(`discovery:${user.orgId}`, 12, 60_000)) {
      return json({ error: 'Discovery runs are rate limited. Wait a moment before running again.' }, 429);
    }

    const { dataSourceId, inline } = schema.parse(await request.json().catch(() => ({})));

    const job = await enqueue({
      orgId: user.orgId,
      kind: dataSourceId ? 'discovery.run_source' : 'discovery.run_all',
      payload: dataSourceId ? { dataSourceId } : {},
      priority: 30,
    });

    await audit({
      orgId: user.orgId,
      userId: user.id,
      action: 'discovery.run_requested',
      entityType: 'DataSource',
      entityId: dataSourceId ?? null,
    });

    if (!inline) return json({ queued: true, jobId: job?.id });

    // Drain enough of the queue to carry a fresh signal all the way through
    // promotion, scoring, matching, configuration and next-action selection.
    const results = [];
    for (let pass = 0; pass < 6; pass++) {
      const tick = await processJobs(25);
      results.push(tick);
      if (tick.processed === 0) break;
    }

    return json({
      queued: true,
      jobId: job?.id,
      passes: results.length,
      processed: results.reduce((sum, r) => sum + r.processed, 0),
      failed: results.reduce((sum, r) => sum + r.failed, 0),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
