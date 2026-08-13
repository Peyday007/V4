import { Prisma } from '@prisma/client';
import type { CallDisposition, PacketItemStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { audit } from '@/lib/audit';
import { localHours } from './localTime';
import { validateDisposition } from './discovery';

/**
 * Handing work to a caller, one opportunity at a time.
 *
 * Two things have to be true at once and they pull against each other. The
 * order must adapt — a callback promised for eleven outranks a cold Tier A
 * record at eleven — and ownership must not, because two callers each being
 * told an organisation is theirs is how a prospect gets rung twice in an hour
 * by the same company.
 *
 * So ordering is computed at serve time and ownership is a row with a lease.
 * The route can move up and down the list freely; who owns it changes only
 * when somebody works it, skips it, or the lease expires.
 *
 * The lease is what makes a closed laptop harmless. A caller who claims a
 * record and disappears holds it for minutes rather than forever, and the
 * partial unique index in the migration means the reclaim cannot hand it to a
 * second caller while the first still has it.
 */

/** How long a caller holds a record after it is served to them. */
const LEASE_MS = 30 * 60_000;

// ---------------------------------------------------------------------------
// Building a packet
// ---------------------------------------------------------------------------

export type PacketPlan = {
  packetId: string;
  name: string;
  items: number;
  /** Routes that could not be added because somebody else owns them. */
  alreadyOwned: number;
  /** Routes that were not servable and were left out with a reason. */
  skipped: Array<{ routeId: string; because: string }>;
};

/**
 * Assigns a caller a portfolio of work.
 *
 * Deliberately not "the top N by score". A packet is a cohort: it records the
 * script, process and offer in force when it was built, so that a result can
 * later be compared against the conditions that produced it rather than
 * against a different experiment wearing the same name.
 */
export async function buildPacket(params: {
  orgId: string;
  callerId: string;
  name: string;
  /** Routes to include. Ordering within the packet is not the serve order. */
  routeIds: string[];
  /**
   * Which world this packet belongs to.
   *
   * Passed explicitly rather than inferred, and checked against the caller and
   * every route by database triggers. A packet is the object that joins a
   * person to real companies, so it is the last place to be relaxed about it.
   */
  dataMode?: 'PRODUCTION' | 'TEST';
  expiresAt?: Date | null;
  scriptVersion?: string | null;
  processVersion?: string | null;
  offerVersion?: string | null;
  discoveryObjective?: string | null;
  experimentCohort?: string | null;
  completionTarget?: number | null;
  assignedByUserId: string;
}): Promise<PacketPlan> {
  const caller = await prisma.user.findFirst({
    where: { id: params.callerId, orgId: params.orgId, isActive: true },
    select: { id: true, name: true, callerProfile: { select: { dataMode: true } } },
  });
  if (!caller) throw new Error('That caller is not in your organisation.');
  if (!caller.callerProfile) {
    throw new Error('That account is not a caller. Create a caller rather than assigning work to a user.');
  }

  // The caller's own world wins over anything the request asked for. A packet
  // built in the wrong mode is refused by a trigger anyway; taking it from the
  // profile means the refusal never has to fire.
  const dataMode = caller.callerProfile.dataMode;
  if (params.dataMode && params.dataMode !== dataMode) {
    throw new Error(
      `That caller works ${dataMode.toLowerCase()} opportunities, so a ${params.dataMode.toLowerCase()} packet cannot be handed to them.`,
    );
  }

  const routes = await prisma.routeHypothesis.findMany({
    where: { id: { in: params.routeIds }, orgId: params.orgId },
    select: { id: true, status: true, tier: true },
  });
  const known = new Map(routes.map((r) => [r.id, r]));

  const packet = await prisma.workPacket.create({
    data: {
      orgId: params.orgId,
      callerId: params.callerId,
      name: params.name.slice(0, 200),
      dataMode,
      expiresAt: params.expiresAt ?? null,
      scriptVersion: params.scriptVersion ?? null,
      processVersion: params.processVersion ?? null,
      offerVersion: params.offerVersion ?? null,
      discoveryObjective: params.discoveryObjective ?? null,
      experimentCohort: params.experimentCohort ?? null,
      completionTarget: params.completionTarget ?? null,
    },
    select: { id: true },
  });

  const skipped: PacketPlan['skipped'] = [];
  let added = 0;
  let alreadyOwned = 0;

  for (const [index, routeId] of params.routeIds.entries()) {
    const route = known.get(routeId);
    if (!route) {
      skipped.push({ routeId, because: 'not an opportunity in this organisation' });
      continue;
    }
    if (['EXPIRED', 'REJECTED'].includes(route.status)) {
      skipped.push({ routeId, because: `the opportunity is ${route.status.toLowerCase()}` });
      continue;
    }

    try {
      await prisma.packetItem.create({
        data: {
          orgId: params.orgId, packetId: packet.id, callerId: params.callerId,
          routeId, position: index, dataMode,
        },
      });
      added += 1;
    } catch (error) {
      // The partial unique index rejected it: somebody else actively owns this
      // route. That is the invariant working, not an error worth failing the
      // whole packet over.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        alreadyOwned += 1;
        skipped.push({ routeId, because: 'another caller is already working this organisation' });
        continue;
      }
      throw error;
    }
  }

  await audit({
    orgId: params.orgId,
    userId: params.assignedByUserId,
    action: 'packet.assigned',
    entityType: 'WorkPacket',
    entityId: packet.id,
    metadata: { caller: caller.name, items: added, alreadyOwned, skipped: skipped.length },
  });

  return { packetId: packet.id, name: params.name, items: added, alreadyOwned, skipped };
}

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------

export type ServableRow = {
  itemId: string;
  routeId: string;
  packetId: string;
  companyId: string;
  organisation: string;
  stateCode: string | null;
  cityName: string | null;
  tier: string;
  route: string;
  friction: string;
  fulfilmentStatus: string;
  windowClosesAt: Date | null;
  phone: string | null;
  attempts: number;
  snoozeUntil: Date | null;
  outreachStatus: string;
  contactVerified: boolean;
  hasDecisionMaker: boolean;
  itemStatus: PacketItemStatus;
  leaseExpiresAt: Date | null;
};

/**
 * Everything in this caller's packets that could be served right now.
 *
 * The eligibility half is SQL, because it must be identical to the queue's own
 * definition — a do-not-contact record excluded only by the ordering code is
 * one crafted request away from being dialled. The ordering half is below, in
 * TypeScript, because it depends on local business hours and that is not a
 * thing SQL should be asked to know.
 */
async function servableRows(params: { orgId: string; callerId: string; now: Date }): Promise<ServableRow[]> {
  return prisma.$queryRaw<ServableRow[]>`
    SELECT
      pi."id"            AS "itemId",
      r."id"             AS "routeId",
      p."id"             AS "packetId",
      r."companyId"      AS "companyId",
      c."legalName"      AS organisation,
      COALESCE(c."stateCode", e."stateCode") AS "stateCode",
      COALESCE(c."cityName", e."cityName")   AS "cityName",
      r."tier"::text     AS tier,
      r."route"::text    AS route,
      r."friction"::text AS friction,
      r."fulfilmentStatus" AS "fulfilmentStatus",
      r."windowClosesAt" AS "windowClosesAt",
      COALESCE(os."correctedPhone", c."phone", ct."phone", ct."mobile") AS phone,
      COALESCE(os."attempts", 0) AS attempts,
      os."snoozeUntil"   AS "snoozeUntil",
      COALESCE(os."status", 'NEW')::text AS "outreachStatus",
      (cr."confidence" IN ('VERIFIED','PROBABLE')) AS "contactVerified",
      (ct."isDecisionMaker" IS TRUE) AS "hasDecisionMaker",
      pi."status"        AS "itemStatus",
      pi."leaseExpiresAt" AS "leaseExpiresAt"
    FROM "PacketItem" pi
    JOIN "WorkPacket" p ON p."id" = pi."packetId"
    JOIN "RouteHypothesis" r ON r."id" = pi."routeId"
    JOIN "DemandEvent" e ON e."id" = r."eventId"
    JOIN "Company" c ON c."id" = r."companyId"
    LEFT JOIN "OutreachState" os ON os."routeId" = r."id"
    LEFT JOIN "ContactResolution" cr ON cr."companyId" = c."id"
    LEFT JOIN LATERAL (
      SELECT "phone", "mobile", "isDecisionMaker"
      FROM "Contact" WHERE "companyId" = c."id"
      ORDER BY "isDecisionMaker" DESC, "createdAt" ASC LIMIT 1
    ) ct ON TRUE
    WHERE p."orgId" = ${params.orgId}
      AND p."callerId" = ${params.callerId}
      AND p."status" = 'OPEN'
      AND (p."expiresAt" IS NULL OR p."expiresAt" > ${params.now})
      -- Waiting, or already claimed by this same caller and not yet expired.
      AND (
        pi."status" = 'PENDING'
        OR (pi."status" = 'IN_PROGRESS' AND pi."leaseExpiresAt" IS NOT NULL AND pi."leaseExpiresAt" > ${params.now})
      )
      -- The queue's own eligibility, restated here rather than trusted from
      -- the caller: live route, workable tier, nobody who has said no, nothing
      -- scheduled for later, and somebody to ring.
      AND r."status" NOT IN ('EXPIRED', 'REJECTED', 'COLD')
      AND r."tier" IN ('ACTIVE_DEMAND', 'STRONG_TRIGGER')
      AND COALESCE(os."status", 'NEW') NOT IN
        ('DO_NOT_CONTACT','CLOSED_HANDLED','CLOSED_NOT_INTERESTED','CLOSED_BAD_FIT','QUALIFIED')
      AND (os."snoozeUntil" IS NULL OR os."snoozeUntil" <= ${params.now})
      AND COALESCE(os."correctedPhone", c."phone", ct."phone", ct."mobile") IS NOT NULL
  `;
}

export type ServeDecision = {
  row: ServableRow;
  /** Why this one, in the operator's words. */
  because: string;
  localTime: string;
};

const TIER_RANK: Record<string, number> = { ACTIVE_DEMAND: 0, STRONG_TRIGGER: 1 };
const FRICTION_RANK: Record<string, number> = { LOW: 0, MODERATE: 1, HIGH: 2, UNKNOWN_RESEARCH_REQUIRED: 3 };

/**
 * The order the operator asked for, applied at serve time.
 *
 * Closed hours are removed before ranking rather than penalised inside it,
 * because a factor large enough to outrank everything else can always be
 * outweighed by enough of the others, and "enough of the others" is how a
 * record gets called at four in the morning.
 */
export function orderServable(rows: ServableRow[], now: Date): ServableRow[] {
  const open = rows.filter((row) => {
    const hours = localHours({ stateCode: row.stateCode, now });
    // Unknown location loses preference below, but is not excluded — a record
    // that can never be served is worse than one served at an odd hour.
    return hours.open || hours.timezone === null;
  });

  return open.sort((a, b) => {
    // 1. A record already claimed by this caller stays with them. Ownership is
    //    stable even though the order is not.
    const claimed = Number(b.itemStatus === 'IN_PROGRESS') - Number(a.itemStatus === 'IN_PROGRESS');
    if (claimed !== 0) return claimed;

    // 2. A promised callback that is due outranks all cold work. Somebody was
    //    told a time.
    const aDue = a.outreachStatus === 'FOLLOW_UP' && a.snoozeUntil !== null;
    const bDue = b.outreachStatus === 'FOLLOW_UP' && b.snoozeUntil !== null;
    if (aDue !== bDue) return aDue ? -1 : 1;
    if (aDue && bDue) return (a.snoozeUntil!.getTime() ?? 0) - (b.snoozeUntil!.getTime() ?? 0);

    // 3. Known local hours before unknown ones.
    const aKnown = localHours({ stateCode: a.stateCode, now }).timezone !== null;
    const bKnown = localHours({ stateCode: b.stateCode, now }).timezone !== null;
    if (aKnown !== bKnown) return aKnown ? -1 : 1;

    // 4. Tier, then the closest buying window.
    const tier = (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9);
    if (tier !== 0) return tier;

    const aCloses = a.windowClosesAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const bCloses = b.windowClosesAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (aCloses !== bCloses) return aCloses - bCloses;

    // 5. A verified contact and a named decision-maker are worth more than a
    //    number nobody has checked.
    const verified = Number(b.contactVerified) - Number(a.contactVerified);
    if (verified !== 0) return verified;
    const dm = Number(b.hasDecisionMaker) - Number(a.hasDecisionMaker);
    if (dm !== 0) return dm;

    // 6. Lower friction, then supply readiness.
    const friction = (FRICTION_RANK[a.friction] ?? 9) - (FRICTION_RANK[b.friction] ?? 9);
    if (friction !== 0) return friction;
    const supply = Number(b.fulfilmentStatus === 'AVAILABLE') - Number(a.fulfilmentStatus === 'AVAILABLE');
    if (supply !== 0) return supply;

    // 7. Attempt fatigue. A record tried four times is worth less of the next
    //    ten minutes than one nobody has rung.
    if (a.attempts !== b.attempts) return a.attempts - b.attempts;
    return a.routeId.localeCompare(b.routeId);
  });
}

export type ServeResult =
  | { served: true; item: ServableRow; because: string; localTime: string; remaining: number }
  | { served: false; reason: string; gate?: GateVerdict; remaining: number };

/**
 * Hands the caller their next opportunity, and claims it for them.
 *
 * The claim is a conditional update, so two tabs asking at the same moment
 * produce one winner and one caller who is handed the next record instead of
 * the same one twice.
 */
export async function serveNext(params: {
  orgId: string;
  callerId: string;
  now?: Date;
}): Promise<ServeResult> {
  const now = params.now ?? new Date();

  // Leases first. A record held by somebody who closed their laptop is not
  // available to anybody until it is released, so this runs before counting.
  await releaseExpiredLeases(params.orgId, now);

  // The gate. Checked on the server before anything is served, because a rule
  // enforced in the browser is a rule a refresh walks past.
  const gate = await afterCallGate({ orgId: params.orgId, callerId: params.callerId });
  if (!gate.mayReceiveNew) {
    return { served: false, reason: gate.message, gate, remaining: 0 };
  }

  const rows = await servableRows({ orgId: params.orgId, callerId: params.callerId, now });

  // Already holding one? Hand back the same record.
  //
  // One opportunity at a time is the workflow, and a second tab asking for the
  // next one is the same person asking the same question — not a request for a
  // second record. Claiming another would leave one of the two going cold
  // behind its lease while they work the other.
  const held = rows.find((row) => row.itemStatus === 'IN_PROGRESS');
  if (held) {
    return {
      served: true,
      item: held,
      because: reasonFor(held, now),
      localTime: localHours({ stateCode: held.stateCode, now }).reason,
      remaining: rows.length,
    };
  }

  const ordered = orderServable(rows, now);

  if (ordered.length === 0) {
    const closed = rows.length;
    return {
      served: false,
      remaining: 0,
      reason:
        closed > 0
          ? `You have ${closed} opportunit${closed === 1 ? 'y' : 'ies'} left, and every one of them is outside business hours where they are. They come back when their local morning does.`
          : 'Nothing left to call in your packets. Ask for more work.',
    };
  }

  for (const candidate of ordered) {
    try {
      const claimed = await prisma.packetItem.updateMany({
        where: { id: candidate.itemId, status: 'PENDING' },
        data: {
          status: 'IN_PROGRESS',
          claimedAt: now,
          leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
        },
      });
      if (claimed.count === 1) {
        return {
          served: true,
          item: { ...candidate, itemStatus: 'IN_PROGRESS' },
          because: reasonFor(candidate, now),
          localTime: localHours({ stateCode: candidate.stateCode, now }).reason,
          remaining: ordered.length,
        };
      }
      // Somebody claimed it between the read and the write. Try the next.
    } catch (error) {
      // The one-live-record index rejected it: a concurrent request of this
      // caller's won the race a moment ago. Hand back whatever they now hold
      // rather than failing — from their side they asked one question.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const theirs = await currentlyHeld(params.orgId, params.callerId, now);
        if (theirs) {
          return {
            served: true,
            item: theirs,
            because: reasonFor(theirs, now),
            localTime: localHours({ stateCode: theirs.stateCode, now }).reason,
            remaining: ordered.length,
          };
        }
        continue;
      }
      throw error;
    }
  }

  return { served: false, reason: 'Somebody else took the last available record.', remaining: 0 };
}

/** The record this caller currently holds, if any. */
async function currentlyHeld(orgId: string, callerId: string, now: Date): Promise<ServableRow | null> {
  const rows = await servableRows({ orgId, callerId, now });
  return rows.find((row) => row.itemStatus === 'IN_PROGRESS') ?? null;
}

/** Why this record and not another, said plainly. */
function reasonFor(row: ServableRow, now: Date): string {
  if (row.outreachStatus === 'FOLLOW_UP' && row.snoozeUntil && row.snoozeUntil <= now) {
    return 'You promised to call them back, and that is now due.';
  }
  if (row.tier === 'ACTIVE_DEMAND') {
    return row.windowClosesAt
      ? `Active demand, and the buying window closes ${row.windowClosesAt.toISOString().slice(0, 10)}.`
      : 'Active demand — they have asked for something.';
  }
  return row.windowClosesAt
    ? `Strong trigger, window closes ${row.windowClosesAt.toISOString().slice(0, 10)}.`
    : 'Strong trigger from a dated event.';
}

/** Hands back records whose lease ran out, so nobody holds work they left. */
export async function releaseExpiredLeases(orgId: string, now = new Date()): Promise<number> {
  const released = await prisma.packetItem.updateMany({
    where: { orgId, status: 'IN_PROGRESS', leaseExpiresAt: { lt: now } },
    data: { status: 'PENDING', claimedAt: null, leaseExpiresAt: null },
  });
  return released.count;
}

// ---------------------------------------------------------------------------
// The after-call gate
// ---------------------------------------------------------------------------

export type GateVerdict = {
  mayReceiveNew: boolean;
  message: string;
  /** The record holding them up, when there is one. */
  blockingRouteId: string | null;
  blockingOrganisation: string | null;
  missingLabels: string[];
  needsFollowUpDate: boolean;
  /** What to do about it. */
  correction: string | null;
  /** True when the hold is a system failure of ours rather than their omission. */
  systemFault: boolean;
};

const CLEAR: GateVerdict = {
  mayReceiveNew: true,
  message: 'Ready for the next one.',
  blockingRouteId: null,
  blockingOrganisation: null,
  missingLabels: [],
  needsFollowUpDate: false,
  correction: null,
  systemFault: false,
};

/**
 * Whether this caller may be handed a new opportunity.
 *
 * The rule is narrow on purpose: the *last* record they worked must carry its
 * outcome's minimum. It is not a productivity score and it does not accumulate
 * — one incomplete record blocks new work and nothing else does.
 *
 * Two things it deliberately does before it blames anybody:
 *
 *   An unresolved system incident on this caller's work holds them and says so
 *   as our fault. A failed save must never present as a caller who did not
 *   fill the form in.
 *
 *   It names the record, the missing fields and the way back. "Complete your
 *   last call" is not a correction anybody can act on at speed.
 */
export async function afterCallGate(params: { orgId: string; callerId: string }): Promise<GateVerdict> {
  const incident = await prisma.workIncident.findFirst({
    where: { orgId: params.orgId, callerId: params.callerId, status: 'OPEN', kind: 'SAVE_FAILURE' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, detail: true, routeId: true },
  });
  if (incident) {
    return {
      ...CLEAR,
      mayReceiveNew: false,
      systemFault: true,
      blockingRouteId: incident.routeId,
      message: 'A save failed on our side. That is our fault, not yours, and it is being held for somebody to fix.',
      correction: 'Nothing you typed was lost. Report it or try saving that record again.',
    };
  }

  const last = await prisma.outreachAttempt.findFirst({
    where: { orgId: params.orgId, userId: params.callerId },
    orderBy: { occurredAt: 'desc' },
    select: {
      routeId: true,
      disposition: true,
      discovery: true,
      route: { select: { route: true, company: { select: { legalName: true } }, outreach: { select: { snoozeUntil: true } } } },
    },
  });
  if (!last) return CLEAR;

  const result = validateDisposition({
    disposition: last.disposition,
    route: last.route.route,
    discovery: (last.discovery ?? {}) as Record<string, unknown>,
    followUpAt: last.route.outreach?.snoozeUntil ?? null,
  });
  if (result.ok) return CLEAR;

  return {
    mayReceiveNew: false,
    systemFault: false,
    blockingRouteId: last.routeId,
    blockingOrganisation: last.route.company.legalName,
    missingLabels: result.missingLabels,
    needsFollowUpDate: result.needsFollowUpDate,
    message:
      `Your last call — ${last.route.company.legalName} — is missing ` +
      `${[...result.missingLabels, ...(result.needsFollowUpDate ? ['a follow-up date'] : [])].join(', ')}.`,
    correction: `${result.because} Fill those in and the next opportunity is served automatically.`,
  };
}

// ---------------------------------------------------------------------------
// Completing an item
// ---------------------------------------------------------------------------

/** Marks the served record worked, once its attempt has been written. */
export async function markWorked(params: {
  orgId: string;
  callerId: string;
  routeId: string;
  now?: Date;
}): Promise<void> {
  const now = params.now ?? new Date();
  await prisma.packetItem.updateMany({
    where: {
      orgId: params.orgId,
      routeId: params.routeId,
      status: { in: ['PENDING', 'IN_PROGRESS'] },
      packet: { callerId: params.callerId },
    },
    data: { status: 'WORKED', workedAt: now, leaseExpiresAt: null },
  });
  await closeFinishedPackets(params.orgId, params.callerId, now);
}

/** Passes over a record without working it, with a reason on the row. */
export async function skipItem(params: {
  orgId: string;
  callerId: string;
  routeId: string;
  reason: string;
}): Promise<void> {
  await prisma.packetItem.updateMany({
    where: {
      orgId: params.orgId,
      routeId: params.routeId,
      status: { in: ['PENDING', 'IN_PROGRESS'] },
      packet: { callerId: params.callerId },
    },
    data: { status: 'SKIPPED', skippedReason: params.reason.slice(0, 500), leaseExpiresAt: null },
  });
}

/**
 * Closes packets whose work is done.
 *
 * A packet closes when nothing is left waiting, or when its completion target
 * is met. Completion never hides an unworked record: anything still PENDING
 * when the target is reached is returned with a reason, so it goes back into
 * the pool rather than disappearing inside a packet marked complete.
 */
export async function closeFinishedPackets(orgId: string, callerId: string, now = new Date()): Promise<number> {
  const packets = await prisma.workPacket.findMany({
    where: { orgId, callerId, status: 'OPEN' },
    select: {
      id: true,
      completionTarget: true,
      items: { select: { id: true, status: true } },
    },
  });

  let closed = 0;
  for (const packet of packets) {
    const waiting = packet.items.filter((i) => i.status === 'PENDING' || i.status === 'IN_PROGRESS');
    const worked = packet.items.filter((i) => i.status === 'WORKED').length;
    const targetMet = packet.completionTarget !== null && worked >= packet.completionTarget;

    if (waiting.length > 0 && !targetMet) continue;

    if (waiting.length > 0) {
      // Returned, not silently swallowed by a completed packet.
      await prisma.packetItem.updateMany({
        where: { id: { in: waiting.map((i) => i.id) } },
        data: {
          status: 'RETURNED',
          returnedReason: 'The packet met its completion target before this record was worked.',
          leaseExpiresAt: null,
        },
      });
    }

    await prisma.workPacket.update({
      where: { id: packet.id },
      data: { status: 'COMPLETE', completedAt: now },
    });
    closed += 1;
  }
  return closed;
}

/** Expires packets past their date, returning whatever was left in them. */
export async function expirePackets(orgId: string, now = new Date()): Promise<number> {
  const expired = await prisma.workPacket.findMany({
    where: { orgId, status: 'OPEN', expiresAt: { lt: now } },
    select: { id: true },
  });
  if (expired.length === 0) return 0;

  const ids = expired.map((p) => p.id);
  await prisma.packetItem.updateMany({
    where: { packetId: { in: ids }, status: { in: ['PENDING', 'IN_PROGRESS'] } },
    data: {
      status: 'RETURNED',
      returnedReason: 'The packet expired before this record was worked.',
      leaseExpiresAt: null,
    },
  });
  await prisma.workPacket.updateMany({ where: { id: { in: ids } }, data: { status: 'EXPIRED' } });
  return expired.length;
}

/** What is left, for the caller and for whoever assigned it. */
export async function packetProgress(orgId: string, callerId: string) {
  const rows = await prisma.$queryRaw<
    Array<{ packetId: string; name: string; status: string; expiresAt: Date | null; total: bigint; worked: bigint; waiting: bigint }>
  >`
    SELECT p."id" AS "packetId", p."name" AS name, p."status"::text AS status, p."expiresAt" AS "expiresAt",
           COUNT(pi."id")::bigint AS total,
           COUNT(pi."id") FILTER (WHERE pi."status" = 'WORKED')::bigint AS worked,
           COUNT(pi."id") FILTER (WHERE pi."status" IN ('PENDING','IN_PROGRESS'))::bigint AS waiting
    FROM "WorkPacket" p
    LEFT JOIN "PacketItem" pi ON pi."packetId" = p."id"
    WHERE p."orgId" = ${orgId} AND p."callerId" = ${callerId}
    GROUP BY p."id", p."name", p."status", p."expiresAt"
    ORDER BY p."assignedAt" DESC
    LIMIT 20
  `;
  return rows.map((r) => ({
    packetId: r.packetId,
    name: r.name,
    status: r.status,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    total: Number(r.total),
    worked: Number(r.worked),
    waiting: Number(r.waiting),
  }));
}

export { validateDisposition };
export type { CallDisposition };
