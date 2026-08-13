import { randomBytes } from 'node:crypto';
import type { DataMode } from '@prisma/client';
import { prisma } from '@/lib/db';
import { hashPassword } from '@/lib/auth/password';
import { audit } from '@/lib/audit';
import { CallerAuthError } from './identity';

/**
 * Who is actually a caller.
 *
 * The page this replaces listed every active user in the organisation — the
 * owner, the administrator, the finance reviewer, the researcher and the deal
 * manager all appeared on the calling floor with an "Issue PIN" button beside
 * them. Existing as a user is not the same as being a caller, and the fix is
 * not a role filter bolted onto the old query: it is that a caller is a person
 * with a `CallerProfile`, deliberately created by somebody, and nothing else
 * qualifies.
 *
 * That distinction is why creating a caller here creates the profile as well as
 * the login, and why there is no path in this file that gives an existing owner
 * or manager a caller profile as a side effect of anything. Converting a
 * finance reviewer into a caller because somebody clicked the wrong button is a
 * mistake that ends with a real buyer being rung by an accountant.
 */

/** The role every caller gets. Callers are not managers with a smaller screen. */
const CALLER_ROLE_KEY = 'CALLER';

export type CallerMode = DataMode;

export type PinStatus = 'NONE' | 'ACTIVE' | 'LOCKED' | 'REVOKED';

export type RosterCaller = {
  callerId: string;
  name: string;
  email: string;
  isActive: boolean;
  mode: CallerMode;
  label: string | null;
  timezone: string;
  pin: {
    status: PinStatus;
    issuedAt: string | null;
    issuedBy: string | null;
    lastUsedAt: string | null;
    lockedUntil: string | null;
    /** Never the PIN. There is no field here that could hold one. */
  };
  /** Work in hand. */
  openPackets: number;
  waiting: number;
  workedToday: number;
  overdueCallbacks: number;
  lastAttemptAt: string | null;
  lastSignInAt: string | null;
  openIncidents: number;
  /** Live restrictions from the system manager, if any. */
  restrictions: number;
};

/**
 * The floor.
 *
 * Only people with a caller profile, which is the whole point. `includeInactive`
 * is a separate switch rather than a default, because a deactivated caller on
 * the main list looks like somebody who should be given work.
 */
export async function roster(params: {
  orgId: string;
  mode?: CallerMode;
  includeInactive?: boolean;
  now?: Date;
}): Promise<RosterCaller[]> {
  const now = params.now ?? new Date();
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);

  const rows = await prisma.user.findMany({
    where: {
      orgId: params.orgId,
      // The line that fixes the reported bug. A user without a caller profile
      // is not on the floor, whatever their role says.
      callerProfile: { isNot: null },
      ...(params.mode ? { callerProfile: { dataMode: params.mode } } : {}),
      ...(params.includeInactive ? {} : { isActive: true }),
    },
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    select: {
      id: true, name: true, email: true, isActive: true, lastLoginAt: true,
      callerProfile: {
        select: {
          dataMode: true, label: true, timezone: true,
          pinHash: true, pinSetAt: true, pinRevokedAt: true,
          pinLockedUntil: true, pinLastUsedAt: true,
          pinIssuedBy: { select: { name: true } },
        },
      },
    },
  });

  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const [packets, items, workedToday, attempts, incidents, restrictions, callbacks] = await Promise.all([
    prisma.workPacket.groupBy({
      by: ['callerId'], where: { orgId: params.orgId, callerId: { in: ids }, status: 'OPEN' }, _count: true,
    }),
    prisma.packetItem.groupBy({
      by: ['callerId'],
      where: { orgId: params.orgId, callerId: { in: ids }, status: { in: ['PENDING', 'IN_PROGRESS'] } },
      _count: true,
    }),
    prisma.outreachAttempt.groupBy({
      by: ['userId'],
      where: { orgId: params.orgId, userId: { in: ids }, occurredAt: { gte: startOfDay } },
      _count: true,
    }),
    prisma.outreachAttempt.groupBy({
      by: ['userId'], where: { orgId: params.orgId, userId: { in: ids } }, _max: { occurredAt: true },
    }),
    prisma.workIncident.groupBy({
      by: ['callerId'],
      where: { orgId: params.orgId, callerId: { in: ids }, status: 'OPEN' },
      _count: true,
    }),
    prisma.intervention.groupBy({
      by: ['callerId'],
      where: { orgId: params.orgId, callerId: { in: ids }, state: 'ACTIVE', shadow: false },
      _count: true,
    }),
    // A promise whose date has passed, still sitting in this caller's packet.
    prisma.packetItem.findMany({
      where: {
        orgId: params.orgId, callerId: { in: ids }, status: { in: ['PENDING', 'IN_PROGRESS'] },
        route: { outreach: { snoozeUntil: { lte: now, not: null } } },
      },
      select: { callerId: true },
    }),
  ]);

  const count = <T extends { _count: unknown }>(rows: T[], key: keyof T) =>
    new Map(rows.map((r) => [r[key] as unknown as string, Number(r._count)]));

  const packetsBy = count(packets, 'callerId');
  const itemsBy = count(items, 'callerId');
  const workedBy = count(workedToday, 'userId');
  const incidentsBy = count(incidents, 'callerId');
  const restrictionsBy = count(restrictions, 'callerId');
  const lastAttemptBy = new Map(attempts.map((a) => [a.userId as string, a._max.occurredAt]));
  const callbacksBy = new Map<string, number>();
  for (const row of callbacks) {
    callbacksBy.set(row.callerId, (callbacksBy.get(row.callerId) ?? 0) + 1);
  }

  return rows.map((row) => {
    const profile = row.callerProfile!;
    return {
      callerId: row.id,
      name: row.name,
      email: row.email,
      isActive: row.isActive,
      mode: profile.dataMode,
      label: profile.label,
      timezone: profile.timezone,
      pin: {
        status: pinStatus(profile, now),
        issuedAt: profile.pinSetAt?.toISOString() ?? null,
        issuedBy: profile.pinIssuedBy?.name ?? null,
        lastUsedAt: profile.pinLastUsedAt?.toISOString() ?? null,
        lockedUntil: profile.pinLockedUntil?.toISOString() ?? null,
      },
      openPackets: packetsBy.get(row.id) ?? 0,
      waiting: itemsBy.get(row.id) ?? 0,
      workedToday: workedBy.get(row.id) ?? 0,
      overdueCallbacks: callbacksBy.get(row.id) ?? 0,
      lastAttemptAt: lastAttemptBy.get(row.id)?.toISOString() ?? null,
      lastSignInAt: row.lastLoginAt?.toISOString() ?? null,
      openIncidents: incidentsBy.get(row.id) ?? 0,
      restrictions: restrictionsBy.get(row.id) ?? 0,
    };
  });
}

/**
 * Four states, and the difference matters to whoever is trying to get somebody
 * working: no PIN was ever issued, one is live, they are locked out for a few
 * minutes, or access was taken away deliberately.
 */
function pinStatus(
  profile: { pinHash: string | null; pinRevokedAt: Date | null; pinLockedUntil: Date | null },
  now: Date,
): PinStatus {
  if (profile.pinRevokedAt) return 'REVOKED';
  if (!profile.pinHash) return 'NONE';
  if (profile.pinLockedUntil && profile.pinLockedUntil > now) return 'LOCKED';
  return 'ACTIVE';
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export type CreateCallerInput = {
  orgId: string;
  actorId: string;
  name: string;
  email: string;
  mode?: CallerMode;
  timezone?: string;
  label?: string | null;
  /** Off by default: a caller with no work and no PIN is a safe starting state. */
  active?: boolean;
};

export type CreateResult =
  | { ok: true; callerId: string }
  | { ok: false; message: string; field?: 'email' | 'name' };

/**
 * Creates a caller: a login and a caller profile, together.
 *
 * The password is random and never shown, because callers sign in with a PIN.
 * Setting one they could use would create a second credential nobody hands over
 * and nobody rotates — and the shared-password failure this whole layer exists
 * to prevent starts exactly there.
 */
export async function createCaller(input: CreateCallerInput): Promise<CreateResult> {
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();

  if (name.length < 2) return { ok: false, message: 'Give them a name somebody would recognise.', field: 'name' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, message: 'That is not an email address. It is their sign-in identity, so it has to be real.', field: 'email' };
  }

  const clash = await prisma.user.findFirst({
    where: { orgId: input.orgId, email: { equals: email, mode: 'insensitive' } },
    select: { id: true, callerProfile: { select: { id: true } } },
  });
  if (clash) {
    return {
      ok: false,
      field: 'email',
      message: clash.callerProfile
        ? 'Somebody with that email is already a caller here.'
        : 'That email already belongs to an account on this organisation. Callers are created fresh rather than converted — an owner or a finance reviewer who becomes a caller by accident is a real problem, so this refuses rather than guesses.',
    };
  }

  const role = await prisma.role.findFirst({
    where: { key: CALLER_ROLE_KEY, OR: [{ orgId: input.orgId }, { orgId: null }] },
    select: { id: true },
  });
  if (!role) return { ok: false, message: 'This organisation has no caller role configured.' };

  // Long, random, and discarded. The PIN is the credential; this exists only
  // because the column is not nullable.
  const passwordHash = await hashPassword(randomBytes(32).toString('base64url'));

  const created = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        orgId: input.orgId,
        email,
        name,
        passwordHash,
        roleId: role.id,
        isActive: input.active ?? true,
        timezone: input.timezone ?? 'America/New_York',
      },
      select: { id: true },
    });
    await tx.callerProfile.create({
      data: {
        userId: user.id,
        dataMode: input.mode ?? 'PRODUCTION',
        timezone: input.timezone ?? 'America/New_York',
        label: input.label?.trim() || null,
      },
    });
    return user;
  });

  await audit({
    orgId: input.orgId,
    userId: input.actorId,
    action: 'caller.created',
    entityType: 'User',
    entityId: created.id,
    metadata: { name, email, mode: input.mode ?? 'PRODUCTION' },
  });

  return { ok: true, callerId: created.id };
}

/** Fields an owner may change without touching identity or history. */
export async function updateCaller(params: {
  orgId: string;
  actorId: string;
  callerId: string;
  name?: string;
  label?: string | null;
  timezone?: string;
}): Promise<{ ok: boolean; message?: string }> {
  const caller = await requireCaller(params.orgId, params.callerId);
  if ('message' in caller) return { ok: false, message: caller.message };

  const name = params.name?.trim();
  if (name !== undefined && name.length < 2) return { ok: false, message: 'A name needs at least two characters.' };

  await prisma.$transaction(async (tx) => {
    if (name || params.timezone) {
      await tx.user.update({
        where: { id: params.callerId },
        data: { ...(name ? { name } : {}), ...(params.timezone ? { timezone: params.timezone } : {}) },
      });
    }
    await tx.callerProfile.update({
      where: { userId: params.callerId },
      data: {
        ...(params.label !== undefined ? { label: params.label?.trim() || null } : {}),
        ...(params.timezone ? { timezone: params.timezone } : {}),
      },
    });
  });

  await audit({
    orgId: params.orgId, userId: params.actorId, action: 'caller.updated',
    entityType: 'User', entityId: params.callerId,
    metadata: { fields: Object.keys(params).filter((k) => !['orgId', 'actorId', 'callerId'].includes(k)) },
  });

  return { ok: true };
}

/**
 * Removing a caller means taking access away, never deleting them.
 *
 * Their attempts, packets, calls and evidence are the record of work that
 * actually happened and of promises made to real buyers. Deleting the person
 * orphans all of it, and a deal that later goes wrong becomes unexplainable.
 * So: deactivate, revoke the PIN, and release the work they were holding so
 * somebody else can pick it up.
 */
export async function deactivateCaller(params: {
  orgId: string;
  actorId: string;
  callerId: string;
  reason?: string;
}): Promise<{ ok: boolean; message?: string; released: number }> {
  const caller = await requireCaller(params.orgId, params.callerId);
  if ('message' in caller) return { ok: false, message: caller.message, released: 0 };

  const released = await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: params.callerId }, data: { isActive: false } });
    await tx.callerProfile.update({
      where: { userId: params.callerId },
      data: { pinRevokedAt: new Date(), pinHash: null, pinFailedCount: 0, pinLockedUntil: null },
    });
    // Unworked records go back to the pool. Worked ones stay exactly where they
    // are: they are history now, not inventory.
    const returned = await tx.packetItem.updateMany({
      where: { orgId: params.orgId, callerId: params.callerId, status: { in: ['PENDING', 'IN_PROGRESS'] } },
      data: { status: 'RETURNED', returnedReason: 'The caller was deactivated.' },
    });
    // Cancelled rather than complete: nobody finished this work, and recording
    // it as complete would tell the measurement layer a packet was worked.
    await tx.workPacket.updateMany({
      where: { orgId: params.orgId, callerId: params.callerId, status: 'OPEN' },
      data: { status: 'CANCELLED' },
    });
    return returned.count;
  });

  await audit({
    orgId: params.orgId, userId: params.actorId, action: 'caller.deactivated',
    entityType: 'User', entityId: params.callerId,
    metadata: { reason: params.reason ?? null, releasedItems: released },
  });

  return { ok: true, released };
}

/** Back on the floor. Access still has to be handed over separately. */
export async function reactivateCaller(params: {
  orgId: string;
  actorId: string;
  callerId: string;
}): Promise<{ ok: boolean; message?: string }> {
  const caller = await requireCaller(params.orgId, params.callerId, { allowInactive: true });
  if ('message' in caller) return { ok: false, message: caller.message };

  await prisma.user.update({ where: { id: params.callerId }, data: { isActive: true } });

  await audit({
    orgId: params.orgId, userId: params.actorId, action: 'caller.reactivated',
    entityType: 'User', entityId: params.callerId,
    // Said out loud, because "reactivated" reads as "can work again" and they
    // cannot until somebody hands them a PIN.
    metadata: { note: 'Still has no PIN until one is issued.' },
  });

  return { ok: true };
}

/** One caller in full, for the manage screen. */
export async function callerDetail(params: {
  orgId: string;
  callerId: string;
}): Promise<(RosterCaller & {
  incidents: Array<{ id: string; kind: string; detail: string; createdAt: string }>;
  packets: Array<{ id: string; name: string; status: string; assignedAt: string; waiting: number; worked: number }>;
}) | null> {
  const [base] = await roster({ orgId: params.orgId, includeInactive: true }).then((rows) =>
    rows.filter((r) => r.callerId === params.callerId));
  if (!base) return null;

  const [incidents, packets] = await Promise.all([
    prisma.workIncident.findMany({
      where: { orgId: params.orgId, callerId: params.callerId, status: 'OPEN' },
      orderBy: { createdAt: 'desc' }, take: 20,
      select: { id: true, kind: true, detail: true, createdAt: true },
    }),
    prisma.workPacket.findMany({
      where: { orgId: params.orgId, callerId: params.callerId },
      orderBy: { assignedAt: 'desc' }, take: 20,
      select: {
        id: true, name: true, status: true, assignedAt: true,
        items: { select: { status: true } },
      },
    }),
  ]);

  return {
    ...base,
    incidents: incidents.map((i) => ({
      id: i.id, kind: i.kind, detail: i.detail, createdAt: i.createdAt.toISOString(),
    })),
    packets: packets.map((p) => ({
      id: p.id, name: p.name, status: p.status, assignedAt: p.assignedAt.toISOString(),
      waiting: p.items.filter((i) => i.status === 'PENDING' || i.status === 'IN_PROGRESS').length,
      worked: p.items.filter((i) => i.status === 'WORKED').length,
    })),
  };
}

/**
 * The guard every lifecycle action starts with.
 *
 * Refuses anybody who is not a caller. Without it, an "issue PIN" on a user id
 * typed into a request body would hand a calling credential to the finance
 * reviewer — which is the API-level form of the bug the page had visually.
 */
export async function requireCaller(
  orgId: string,
  callerId: string,
  options: { allowInactive?: boolean } = {},
): Promise<{ id: string; name: string; mode: CallerMode } | { message: string }> {
  const user = await prisma.user.findFirst({
    where: { id: callerId, orgId },
    select: { id: true, name: true, isActive: true, callerProfile: { select: { dataMode: true } } },
  });
  if (!user) return { message: 'That person is not in your organisation.' };
  if (!user.callerProfile) {
    return {
      message: 'That account is not a caller. Callers are created deliberately — existing owners, managers, finance and research accounts are not converted.',
    };
  }
  if (!user.isActive && !options.allowInactive) {
    return { message: 'That caller is deactivated. Reactivate them first.' };
  }
  return { id: user.id, name: user.name, mode: user.callerProfile.dataMode };
}

export { CallerAuthError };
