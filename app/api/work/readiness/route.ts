import { handleRouteError, json } from '@/lib/api';
import { requireWorkspace, scopeFor } from '@/lib/caller/guard';
import { callerReadiness } from '@/lib/caller/identity';
import { afterCallGate, packetProgress } from '@/lib/caller/packets';

export const dynamic = 'force-dynamic';

/** The pre-shift check: can this person start, and if not, whose problem is it. */
export async function GET() {
  try {
    const user = await requireWorkspace();
    const scope = scopeFor(user);
    const [readiness, gate, packets] = await Promise.all([
      callerReadiness({ orgId: scope.orgId, userId: scope.callerId }),
      afterCallGate(scope),
      packetProgress(scope.orgId, scope.callerId),
    ]);
    return json({ caller: { name: user.name }, readiness, gate, packets });
  } catch (error) {
    return handleRouteError(error);
  }
}
