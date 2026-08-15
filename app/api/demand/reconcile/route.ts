import { z } from 'zod';
import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/session';
import { handleRouteError, json } from '@/lib/api';
import { applyReconciliation, reconciliationPreview } from '@/lib/demand/reconcile';

export const dynamic = 'force-dynamic';

/**
 * Reconciling the board built before one event meant one thesis.
 *
 * `GET` writes nothing and needs only read access: seeing what would happen is
 * not an act. `POST` closes routes and needs `deal.write` *and* an explicit
 * list of ids the owner has read — there is no "apply everything you proposed"
 * parameter, because the preview an owner read and the board at the moment they
 * press the button are not the same thing, and the gap is exactly where a
 * tidy-up destroys something.
 */
export async function GET(request: Request) {
  try {
    const user = await requirePermission('discovery.read');
    const url = new URL(request.url);
    const dataMode = url.searchParams.get('dataMode') === 'TEST' ? 'TEST' : 'PRODUCTION';
    return json(await reconciliationPreview({ orgId: user.orgId, dataMode }));
  } catch (error) {
    return handleRouteError(error);
  }
}

const Body = z.object({
  routeIds: z.array(z.string().min(1)).min(1).max(500),
  reason: z.string().min(10).max(2000),
});

export async function POST(request: Request) {
  try {
    const user = await requirePermission('deal.write');
    // Closing records in bulk is an owner's decision, not a manager's.
    if (!can(user, 'campaign.authorise')) {
      return json(
        { error: 'Closing opportunities in bulk needs owner authority, separately from writing to a deal.' },
        403,
      );
    }

    const parsed = Body.safeParse(await request.json());
    if (!parsed.success) {
      return json(
        { error: 'Name the opportunities to close and say why. A bulk closure with no stated reason is not one.' },
        400,
      );
    }

    const result = await applyReconciliation({
      orgId: user.orgId,
      actorId: user.id,
      routeIds: parsed.data.routeIds,
      reason: parsed.data.reason,
    });
    return json(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
