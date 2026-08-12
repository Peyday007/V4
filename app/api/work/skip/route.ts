import { z } from 'zod';
import { handleRouteError, json } from '@/lib/api';
import { requireWorkspace, scopeFor } from '@/lib/caller/guard';
import { skipItem } from '@/lib/caller/packets';

export const dynamic = 'force-dynamic';

const Body = z.object({ routeId: z.string().min(1), reason: z.string().min(3).max(500) });

/**
 * Passes over a record without working it.
 *
 * The reason is required. A skip with no reason is indistinguishable from a
 * record nobody got to, and the difference decides whether it goes back into
 * the pool or gets looked at.
 */
export async function POST(request: Request) {
  try {
    const user = await requireWorkspace();
    const parsed = Body.safeParse(await request.json());
    if (!parsed.success) return json({ error: 'Say why you are skipping it.' }, 400);
    await skipItem({ ...scopeFor(user), ...parsed.data });
    return json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
