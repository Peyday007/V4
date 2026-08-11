import { requirePermission } from '@/lib/auth/session';
import { handleRouteError, json } from '@/lib/api';
import { nextCallable } from '@/lib/demand/queue';
import { loadCallCard } from '@/lib/demand/callCard';

export const dynamic = 'force-dynamic';

/**
 * The next opportunity to work.
 *
 * Eligibility is decided here, against the database, using the same clause as
 * the Call now view. The caller sends the ids it has just finished with so a
 * write that has not yet become visible to a following read cannot hand the
 * same record back twice.
 */
export async function GET(request: Request) {
  try {
    const user = await requirePermission('discovery.read');
    const url = new URL(request.url);
    const done = url.searchParams.getAll('done').filter(Boolean);

    const row = await nextCallable({ orgId: user.orgId, excludeRouteIds: done });
    if (!row) {
      return json({
        card: null,
        message: 'Nothing left in the calling queue. Check Follow-ups, or Research for records with no number.',
      });
    }

    return json({ card: await loadCallCard({ orgId: user.orgId, routeId: row.routeId }) });
  } catch (error) {
    return handleRouteError(error);
  }
}
