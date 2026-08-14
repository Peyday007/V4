import { prisma } from '@/lib/db';
import { callableRouteIds } from '@/lib/demand/eligibility';
import { confirmAssignment } from './assignment';
import { audit } from '@/lib/audit';

/**
 * Keeping a caller's floor stocked without anybody watching it.
 *
 * A packet is a fixed set of records. A caller works through it and then has
 * nothing, and the only thing standing between them and an idle afternoon is
 * an owner noticing and assigning more. That is a person doing a job a
 * scheduler can do, and it is the job they will be doing at the exact moment
 * they are least able to — mid-morning, on the phone themselves.
 *
 * Three rules keep this from being a tap that floods.
 *
 * It tops up to a floor rather than assigning a batch. A caller with two items
 * left gets enough to reach the floor, not another full packet on top of the
 * one they have — otherwise a slow morning leaves somebody holding forty
 * records nobody else can work.
 *
 * It only takes what is callable now, through the same query the owner's
 * preview uses, which means it inherits the one-route-per-organisation rule
 * and the calling-window check rather than reimplementing either. An automatic
 * process that could assign work a person would have been refused is worse
 * than no automatic process.
 *
 * And it never invents work. When there is nothing callable, the floor stays
 * short and says why — an empty replenishment is a fact about the demand
 * engine, and covering it up by relaxing eligibility would turn an empty board
 * into a full one made of records nobody should ring.
 */

/** Items in hand below which a caller is about to run dry. */
const DEFAULT_FLOOR = 12;
/** Never hand somebody more than this in one go, however short they are. */
const MAX_PER_TOP_UP = 15;

export type Replenishment = {
  callerId: string;
  callerName: string;
  /** Open items before the top-up. */
  had: number;
  /** How many were added. Zero is a normal outcome, not a failure. */
  added: number;
  /** Why nothing was added, when nothing was. */
  because: string | null;
};

export type ReplenishReport = {
  considered: number;
  toppedUp: number;
  itemsAdded: number;
  /** Callers who were short and could not be filled, which is the useful list. */
  stillShort: Replenishment[];
  results: Replenishment[];
};

/**
 * Tops up every caller whose open work has fallen below the floor.
 *
 * Callers are handled in order of who is shortest, so a scarce supply of
 * callable work reaches whoever is closest to idle rather than whoever the
 * database happened to return first.
 */
export async function replenishFloor(params: {
  orgId: string;
  actorId: string;
  /** Which world to fill. Practice callers get practice work, always. */
  dataMode: 'PRODUCTION' | 'TEST';
  floor?: number;
  now?: Date;
}): Promise<ReplenishReport> {
  const floor = params.floor ?? DEFAULT_FLOOR;

  const callers = await prisma.callerProfile.findMany({
    where: {
      dataMode: params.dataMode,
      user: { orgId: params.orgId, isActive: true },
      // Somebody with no PIN cannot sign in, so filling their floor moves work
      // out of everybody else's reach to no purpose.
      pinHash: { not: null },
      pinRevokedAt: null,
    },
    select: { userId: true, user: { select: { name: true } } },
  });

  const withCounts = await Promise.all(
    callers.map(async (c) => ({
      callerId: c.userId,
      callerName: c.user.name,
      open: await prisma.packetItem.count({
        where: {
          orgId: params.orgId,
          status: { in: ['PENDING', 'IN_PROGRESS'] },
          packet: { callerId: c.userId },
        },
      }),
    })),
  );

  const short = withCounts
    .filter((c) => c.open < floor)
    .sort((a, b) => a.open - b.open);

  const results: Replenishment[] = [];

  for (const caller of short) {
    const want = Math.min(floor - caller.open, MAX_PER_TOP_UP);

    // Fetched inside the loop on purpose: the previous caller's top-up has
    // already claimed its records, and asking once up front would hand the
    // same route to two people and let the unique index sort it out.
    const available = await callableRouteIds({
      orgId: params.orgId,
      mode: params.dataMode,
      limit: want,
      unassignedOnly: true,
      now: params.now,
    });

    if (available.length === 0) {
      results.push({
        callerId: caller.callerId,
        callerName: caller.callerName,
        had: caller.open,
        added: 0,
        because:
          'Nothing is callable right now. That is the demand engine or the clock, not this caller — '
          + 'the floor stays short rather than being filled with records nobody should ring.',
      });
      continue;
    }

    const assigned = await confirmAssignment({
      orgId: params.orgId,
      actorId: params.actorId,
      callerId: caller.callerId,
      routeIds: available,
      name: `Top-up — ${new Date().toISOString().slice(0, 10)}`,
      now: params.now,
    });

    if (!assigned.ok) {
      results.push({
        callerId: caller.callerId,
        callerName: caller.callerName,
        had: caller.open,
        added: 0,
        because: assigned.error,
      });
      continue;
    }

    results.push({
      callerId: caller.callerId,
      callerName: caller.callerName,
      had: caller.open,
      added: assigned.plan.items,
      because: assigned.plan.items === 0 ? 'Everything offered was claimed by somebody else first.' : null,
    });
  }

  const itemsAdded = results.reduce((n, r) => n + r.added, 0);

  if (itemsAdded > 0) {
    await audit({
      orgId: params.orgId,
      userId: params.actorId,
      actorType: 'system',
      action: 'caller.floor_replenished',
      entityType: 'Organization',
      entityId: params.orgId,
      metadata: {
        dataMode: params.dataMode,
        floor,
        toppedUp: results.filter((r) => r.added > 0).length,
        itemsAdded,
      },
    });
  }

  return {
    considered: withCounts.length,
    toppedUp: results.filter((r) => r.added > 0).length,
    itemsAdded,
    stillShort: results.filter((r) => r.added === 0),
    results,
  };
}
