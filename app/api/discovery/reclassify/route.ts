import { z } from 'zod';
import { requirePermission } from '@/lib/auth/session';
import { handleRouteError, json } from '@/lib/api';
import { reclassify } from '@/lib/discovery/reclassify';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Rebuilds accounts, hypotheses and scores for records already ingested, and
 * returns the before-and-after for every one.
 *
 * `dryRun` computes the report without writing, so the effect can be inspected
 * before it is applied — which matters here because the operation reclassifies
 * every live record in one go.
 */
const schema = z.object({ dryRun: z.boolean().default(true) });

export async function POST(request: Request) {
  try {
    const user = await requirePermission('discovery.review');
    const { dryRun } = schema.parse(await request.json().catch(() => ({})));
    const result = await reclassify({ orgId: user.orgId, userId: user.id, dryRun });
    return json(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
