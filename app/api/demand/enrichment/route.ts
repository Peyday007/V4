import { z } from 'zod';
import { requirePermission } from '@/lib/auth/session';
import { handleRouteError, json } from '@/lib/api';
import { prisma } from '@/lib/db';
import { retryContactResolution } from '@/lib/enrichment/schedule';
import { contactProvenanceFor, enrichmentOverview } from '@/lib/enrichment/report';

export const dynamic = 'force-dynamic';

/**
 * Contact resolution, seen and nudged.
 *
 * The POST here is a recovery tool and nothing more. Nothing on this route is
 * required for an opportunity to be enriched — the worker does that on its own
 * — and it exists for the case where somebody has just fixed a configuration
 * problem and would rather not wait six hours to find out whether it worked.
 */
export async function GET(request: Request) {
  try {
    const user = await requirePermission('discovery.read');
    const companyId = new URL(request.url).searchParams.get('companyId');

    if (companyId) {
      const provenance = await contactProvenanceFor(user.orgId, companyId);
      return json({ provenance });
    }
    return json({ overview: await enrichmentOverview(user.orgId) });
  } catch (error) {
    return handleRouteError(error);
  }
}

const RetrySchema = z
  .object({
    /** One record: the row-level retry button. */
    routeId: z.string().min(1).optional(),
    companyId: z.string().min(1).optional(),
    /** Everything currently blocked: the bulk button. */
    allBlocked: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .refine((v) => v.routeId || v.companyId || v.allBlocked, {
    message: 'Name a route, a company, or ask for everything blocked.',
  });

export async function POST(request: Request) {
  try {
    // Retrying spends a provider call, so it needs the same permission that
    // running a source does rather than plain read access.
    const user = await requirePermission('discovery.run');
    const parsed = RetrySchema.safeParse(await request.json());
    if (!parsed.success) {
      return json({ error: parsed.error.issues[0]?.message ?? 'Invalid request.' }, 400);
    }
    const input = parsed.data;

    // A route id is resolved to its account here rather than trusted from the
    // browser, and the lookup is scoped to the caller's organisation.
    let companyIds: string[] | undefined;
    if (input.routeId) {
      const route = await prisma.routeHypothesis.findFirst({
        where: { id: input.routeId, orgId: user.orgId },
        select: { companyId: true },
      });
      if (!route) return json({ error: 'That opportunity does not exist in your organisation.' }, 404);
      companyIds = [route.companyId];
    } else if (input.companyId) {
      const company = await prisma.company.findFirst({
        where: { id: input.companyId, orgId: user.orgId },
        select: { id: true },
      });
      if (!company) return json({ error: 'That organisation does not exist in your organisation.' }, 404);
      companyIds = [company.id];
    }

    const result = await retryContactResolution({
      orgId: user.orgId,
      companyIds,
      allBlocked: input.allBlocked,
      limit: input.limit,
    });

    return json({
      requeued: result.requeued,
      attempted: result.worked.attempted,
      resolved: result.worked.resolved,
      ambiguous: result.worked.ambiguous,
      unresolved: result.worked.unresolved,
      failed: result.worked.failed,
      released: result.worked.released,
      remaining: result.worked.remaining,
      overview: await enrichmentOverview(user.orgId),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
