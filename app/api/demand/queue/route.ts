import { requirePermission } from '@/lib/auth/session';
import { handleRouteError, json } from '@/lib/api';
import { queryQueue, queueSummary, type QueueFilters, type QueueView } from '@/lib/demand/queue';

export const dynamic = 'force-dynamic';

/**
 * The work queue, paged.
 *
 * Every filter is applied in SQL. The browser is never trusted to narrow the
 * set — it decides what to ask for, not what it is allowed to see.
 */
export async function GET(request: Request) {
  try {
    const user = await requirePermission('discovery.read');
    const url = new URL(request.url);
    const list = (key: string) => url.searchParams.getAll(key).filter(Boolean);

    const filters: QueueFilters = {
      view: (url.searchParams.get('view') ?? 'call_now') as QueueView,
      tier: list('tier') as QueueFilters['tier'],
      route: list('route') as QueueFilters['route'],
      eventType: list('eventType'),
      friction: list('friction') as QueueFilters['friction'],
      fulfilment: list('fulfilment'),
      outreach: list('outreach') as QueueFilters['outreach'],
      state: list('state'),
      connector: list('connector'),
      urgency: url.searchParams.get('urgency') ?? undefined,
      contactable: (url.searchParams.get('contactable') as 'yes' | 'no' | null) ?? undefined,
      search: url.searchParams.get('q') ?? undefined,
      cursor: Number(url.searchParams.get('cursor') ?? 0) || 0,
      limit: Number(url.searchParams.get('limit') ?? 0) || undefined,
    };

    const [page, summary] = await Promise.all([
      queryQueue({ orgId: user.orgId, filters }),
      url.searchParams.get('summary') === 'skip' ? Promise.resolve(null) : queueSummary(user.orgId),
    ]);

    return json({ ...page, summary });
  } catch (error) {
    return handleRouteError(error);
  }
}
