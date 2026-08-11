import { requirePermission } from '@/lib/auth/session';
import { handleRouteError, json } from '@/lib/api';
import { loadEvidence } from '@/lib/demand/callCard';

export const dynamic = 'force-dynamic';

/**
 * The full dossier for one route, on request.
 *
 * Separate from the queue and the caller view on purpose: the evidence is
 * large, it is needed rarely, and loading it with every row is what made the
 * board unusable. Nothing here is new — it is the same reasoning the engine
 * already recorded, fetched when somebody asks to see it.
 */
export async function GET(_request: Request, { params }: { params: { routeId: string } }) {
  try {
    const user = await requirePermission('discovery.read');
    const evidence = await loadEvidence({ orgId: user.orgId, routeId: params.routeId });
    if (!evidence) return json({ error: 'Not found in your organisation.' }, 404);
    return json(evidence);
  } catch (error) {
    return handleRouteError(error);
  }
}
