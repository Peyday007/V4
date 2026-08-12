import { z } from 'zod';
import { prisma } from '@/lib/db';
import { handleRouteError, json } from '@/lib/api';
import { requirePermission } from '@/lib/auth/session';
import { buildPacket } from '@/lib/caller/packets';
import { queryQueue } from '@/lib/demand/queue';

export const dynamic = 'force-dynamic';

const Body = z.object({
  callerId: z.string().min(1),
  name: z.string().min(1).max(200),
  routeIds: z.array(z.string().min(1)).min(1).max(500).optional(),
  /** Take the top N callable opportunities instead of naming them. */
  takeCallable: z.number().int().min(1).max(200).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  discoveryObjective: z.string().max(1000).nullable().optional(),
  experimentCohort: z.string().max(120).nullable().optional(),
  completionTarget: z.number().int().min(1).max(500).nullable().optional(),
  scriptVersion: z.string().max(60).nullable().optional(),
  processVersion: z.string().max(60).nullable().optional(),
  offerVersion: z.string().max(60).nullable().optional(),
});

/** Assigning work is a management action, not something a caller can do. */
export async function POST(request: Request) {
  try {
    const user = await requirePermission('call.assignment.write');
    const parsed = Body.safeParse(await request.json());
    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? 'Invalid packet.' }, 400);
    const input = parsed.data;

    // Either an explicit list, or the top of the callable queue. The second is
    // what an owner actually wants at nine in the morning, and it uses the
    // queue's own ordering rather than a second opinion about priority.
    let routeIds = input.routeIds ?? [];
    if (routeIds.length === 0) {
      const page = await queryQueue({
        orgId: user.orgId,
        filters: { view: 'call_now', limit: input.takeCallable ?? 25 },
      });
      routeIds = page.rows.map((r) => r.routeId);
    }
    if (routeIds.length === 0) {
      return json({ error: 'There is nothing callable to assign right now.' }, 409);
    }

    const plan = await buildPacket({
      orgId: user.orgId,
      callerId: input.callerId,
      name: input.name,
      routeIds,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      discoveryObjective: input.discoveryObjective ?? null,
      experimentCohort: input.experimentCohort ?? null,
      completionTarget: input.completionTarget ?? null,
      scriptVersion: input.scriptVersion ?? null,
      processVersion: input.processVersion ?? null,
      offerVersion: input.offerVersion ?? null,
      assignedByUserId: user.id,
    });

    return json(plan);
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Every caller's current load, for whoever hands out the work. */
export async function GET() {
  try {
    const user = await requirePermission('call.assignment.read.all');
    const rows = await prisma.$queryRaw<
      Array<{ callerId: string; name: string; email: string; hasPin: boolean; packets: bigint; waiting: bigint; worked: bigint }>
    >`
      SELECT u."id" AS "callerId", u."name" AS name, u."email" AS email,
             (cp."pinHash" IS NOT NULL AND cp."pinRevokedAt" IS NULL) AS "hasPin",
             COUNT(DISTINCT p."id") FILTER (WHERE p."status" = 'OPEN')::bigint AS packets,
             COUNT(pi."id") FILTER (WHERE pi."status" IN ('PENDING','IN_PROGRESS'))::bigint AS waiting,
             COUNT(pi."id") FILTER (WHERE pi."status" = 'WORKED')::bigint AS worked
      FROM "User" u
      LEFT JOIN "CallerProfile" cp ON cp."userId" = u."id"
      LEFT JOIN "WorkPacket" p ON p."callerId" = u."id"
      LEFT JOIN "PacketItem" pi ON pi."packetId" = p."id"
      WHERE u."orgId" = ${user.orgId} AND u."isActive" = TRUE
      GROUP BY u."id", u."name", u."email", cp."pinHash", cp."pinRevokedAt"
      ORDER BY u."name" ASC
    `;
    return json({
      callers: rows.map((r) => ({
        callerId: r.callerId,
        name: r.name,
        email: r.email,
        hasPin: r.hasPin,
        packets: Number(r.packets),
        waiting: Number(r.waiting),
        worked: Number(r.worked),
      })),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
