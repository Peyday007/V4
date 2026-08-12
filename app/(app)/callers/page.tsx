import { requirePageAny } from '@/lib/auth/page';
import { prisma } from '@/lib/db';
import { CallerAdmin } from '@/components/CallerAdmin';

export const dynamic = 'force-dynamic';

/**
 * Who is calling, what they have, and what is holding them up.
 *
 * The owner side of the caller workspace. Assigning work and issuing a PIN both
 * live here because they are the same job — a caller with a PIN and no packet
 * cannot work, and a packet assigned to somebody who cannot sign in is a packet
 * nobody will touch.
 */
export default async function CallersPage() {
  const user = await requirePageAny('call.assignment.read.all', 'admin.users');

  const [rows, incidents, callable] = await Promise.all([
    prisma.$queryRaw<
      Array<{ callerId: string; name: string; email: string; roleKey: string; hasPin: boolean;
              packets: bigint; waiting: bigint; worked: bigint; lastAttempt: Date | null }>
    >`
      SELECT u."id" AS "callerId", u."name" AS name, u."email" AS email, r."key" AS "roleKey",
             (cp."pinHash" IS NOT NULL AND cp."pinRevokedAt" IS NULL) AS "hasPin",
             COUNT(DISTINCT p."id") FILTER (WHERE p."status" = 'OPEN')::bigint AS packets,
             COUNT(pi."id") FILTER (WHERE pi."status" IN ('PENDING','IN_PROGRESS'))::bigint AS waiting,
             COUNT(pi."id") FILTER (WHERE pi."status" = 'WORKED')::bigint AS worked,
             MAX(oa."occurredAt") AS "lastAttempt"
      FROM "User" u
      JOIN "Role" r ON r."id" = u."roleId"
      LEFT JOIN "CallerProfile" cp ON cp."userId" = u."id"
      LEFT JOIN "WorkPacket" p ON p."callerId" = u."id"
      LEFT JOIN "PacketItem" pi ON pi."packetId" = p."id"
      LEFT JOIN "OutreachAttempt" oa ON oa."userId" = u."id"
      WHERE u."orgId" = ${user.orgId} AND u."isActive" = TRUE
      GROUP BY u."id", u."name", u."email", r."key", cp."pinHash", cp."pinRevokedAt"
      ORDER BY u."name" ASC
    `,
    prisma.workIncident.findMany({
      where: { orgId: user.orgId, status: 'OPEN' },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true, kind: true, detail: true, createdAt: true,
        caller: { select: { name: true } },
        route: { select: { company: { select: { legalName: true } } } },
      },
    }),
    prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count FROM "RouteHypothesis" r
      LEFT JOIN "PacketItem" pi ON pi."routeId" = r."id" AND pi."status" IN ('PENDING','IN_PROGRESS')
      WHERE r."orgId" = ${user.orgId} AND r."status" NOT IN ('EXPIRED','REJECTED','COLD')
        AND r."tier" IN ('ACTIVE_DEMAND','STRONG_TRIGGER') AND pi."id" IS NULL
    `,
  ]);

  return (
    <CallerAdmin
      callers={rows.map((r) => ({
        callerId: r.callerId,
        name: r.name,
        email: r.email,
        roleKey: r.roleKey,
        hasPin: r.hasPin,
        packets: Number(r.packets),
        waiting: Number(r.waiting),
        worked: Number(r.worked),
        lastAttempt: r.lastAttempt?.toISOString() ?? null,
      }))}
      incidents={incidents.map((i) => ({
        id: i.id,
        kind: i.kind,
        detail: i.detail,
        createdAt: i.createdAt.toISOString(),
        caller: i.caller?.name ?? null,
        organisation: i.route?.company.legalName ?? null,
      }))}
      unassignedCallable={Number(callable[0]?.count ?? 0)}
    />
  );
}
