import { z } from 'zod';
import { requirePermission } from '@/lib/auth/session';
import { startCall } from '@/lib/calling';
import { handleRouteError, json, rateLimit } from '@/lib/api';

export const dynamic = 'force-dynamic';

const schema = z.object({ assignmentId: z.string().min(1) });

export async function POST(request: Request) {
  try {
    const user = await requirePermission('call.place');
    if (!rateLimit(`call:${user.id}`, 60, 60_000)) {
      return json({ error: 'Call rate limit reached' }, 429);
    }
    const { assignmentId } = schema.parse(await request.json());
    const result = await startCall({ orgId: user.orgId, assignmentId, callerId: user.id });
    return json({ ok: true, ...result });
  } catch (error) {
    return handleRouteError(error);
  }
}
