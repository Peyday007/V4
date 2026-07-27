import { requirePermission } from '@/lib/auth/session';
import { processJobs } from '@/lib/jobs/runner';
import { handleRouteError, json, rateLimit } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Drives the job queue on demand.
 *
 * Deployments that run a dedicated worker do not need this; it exists so a
 * scheduler (or the demo UI) can advance the operating loop without one.
 */
export async function POST(request: Request) {
  try {
    const user = await requirePermission('admin.jobs');
    if (!rateLimit(`tick:${user.orgId}`, 30, 60_000)) {
      return json({ error: 'Tick rate limit reached' }, 429);
    }
    const url = new URL(request.url);
    const max = Math.min(50, Number(url.searchParams.get('max') ?? 15));
    return json(await processJobs(max));
  } catch (error) {
    return handleRouteError(error);
  }
}
