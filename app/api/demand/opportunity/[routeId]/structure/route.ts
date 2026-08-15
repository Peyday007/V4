import { z } from 'zod';
import { prisma } from '@/lib/db';
import { audit } from '@/lib/audit';
import { requirePermission } from '@/lib/auth/session';
import { handleRouteError, json } from '@/lib/api';
import { compareStructures, STRUCTURE_BY_KEY } from '@/lib/deal/structures';
import { structureContextFor } from '@/lib/deal/structureContext';
import { recordClaim } from '@/lib/evidence/ledger';

export const dynamic = 'force-dynamic';

/**
 * Choosing how a deal is transacted.
 *
 * A separate endpoint from the rest of the deal because this is a commitment,
 * not a field: it decides who signs with the buyer, who is liable when the work
 * is wrong, and whose money sits in the gap. It needs `deal.write` for that
 * reason, and it refuses a structure the deal cannot actually support rather
 * than storing whatever was posted.
 *
 * The choice is written to the route *and* to the claim ledger, because an
 * owner deciding to carry delivery risk is a claim about the deal with a person
 * and a date behind it — exactly the kind of thing the ledger exists to hold.
 */
const Body = z.object({
  structure: z.string().min(2).max(40),
  reason: z.string().min(1).max(2000),
});

export async function POST(request: Request, { params }: { params: { routeId: string } }) {
  try {
    const user = await requirePermission('deal.write');
    const parsed = Body.safeParse(await request.json());
    if (!parsed.success) return json({ error: 'Name the structure and why.' }, 400);

    const structure = STRUCTURE_BY_KEY.get(parsed.data.structure as never);
    if (!structure) return json({ error: 'That is not a commercial structure this system knows.' }, 400);

    const context = await structureContextFor({ orgId: user.orgId, routeId: params.routeId });
    if (!context) return json({ error: 'No such opportunity on this account.' }, 404);

    // Re-derived rather than trusted. The page may have been open for an hour,
    // and a structure that has become unavailable since is one an owner would
    // be choosing on stale information.
    const assessment = compareStructures(context.context).find((a) => a.structure.key === structure.key);
    if (!assessment?.available) {
      return json(
        { error: `That structure is not available on this deal. ${assessment?.because ?? ''}`.trim() },
        409,
      );
    }

    // The owner's own words, with the structure's caveats appended so the
    // record carries what they were told at the time rather than only what they
    // decided.
    const reason = [
      parsed.data.reason.trim(),
      ...assessment.cautions.map((c) => `Accepted knowing: ${c}`),
      ...assessment.unknowns.map((u) => `Chosen without knowing: ${u}`),
    ].join(' ');

    await prisma.routeHypothesis.update({
      where: { id: params.routeId },
      data: { commercialStructure: structure.key, structureReason: reason.slice(0, 4000) },
    });

    await recordClaim({
      orgId: user.orgId,
      claim: {
        routeId: params.routeId,
        about: 'STRUCTURE',
        key: 'structure.chosen',
        statement: `This deal will be transacted as ${structure.label.toLowerCase()}. ${structure.contractsWithBuyer}`,
        value: { structure: structure.key },
        standing: 'CONFIRMED',
        sourceKind: 'OPERATOR',
        sourceLabel: `Chosen by ${user.name} on ${new Date().toISOString().slice(0, 10)}. ${reason}`,
        observedAt: new Date(),
      },
    }).catch(() => {
      // The route is updated either way. A ledger fault must not lose a
      // decision somebody has made.
    });

    await audit({
      orgId: user.orgId,
      userId: user.id,
      action: 'deal.structure_chosen',
      entityType: 'RouteHypothesis',
      entityId: params.routeId,
      metadata: { structure: structure.key, cautions: assessment.cautions.length },
    });

    return json({ structure: structure.key, reason });
  } catch (error) {
    return handleRouteError(error);
  }
}
