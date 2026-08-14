import { randomInt, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { hashSecret, verifyPassword } from '@/lib/auth/password';
import { createSession } from '@/lib/auth/session';
import { audit } from '@/lib/audit';
import { forgiveSource, pinLookupValue, recordAttempt } from './pinLookup';

/**
 * Caller sign-in.
 *
 * A PIN, because a VA signs in on a shared machine between calls and a
 * twenty-character password does not survive that. Everything else about it is
 * ordinary: the PIN belongs to one person, it hashes with the same function as
 * a password, and it resolves to the same `Session` every other user gets. It
 * is a shorter credential, not a weaker identity.
 *
 * What it is emphatically not is the previous system's shared passphrase. One
 * PIN for the whole team makes every read and write unattributable, which means
 * no measurement of any caller is defensible and no restriction can be aimed at
 * the person who earned it.
 *
 * A short credential needs a lockout that a long one does not, so failures are
 * counted and the account closes for a while. The count lives on the profile
 * rather than in memory because a serverless deployment has no memory to speak
 * of.
 */

/**
 * Ten digits, which is four more than it was.
 *
 * Six was long enough when sign-in also took an email: a guess had to be right
 * about a named person, and five wrong ones closed that person's account. With
 * the email gone every guess is aimed at whoever happens to hold that number,
 * so the space an attacker has to walk is not 10^6 but 10^6 divided by the
 * number of callers — and no individual profile ever accumulates the failures
 * that would trigger a lockout.
 *
 * Ten digits puts that back by four orders of magnitude, and the spray counter
 * in ./pinLookup covers the rest. It is still a number somebody can read off a
 * card and type.
 */
const PIN_LENGTH = 10;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60_000;

export class CallerAuthError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'CallerAuthError';
  }
}

/** A PIN nobody chose, so nobody chooses 123456. */
export function generatePin(): string {
  let pin = '';
  for (let i = 0; i < PIN_LENGTH; i += 1) pin += String(randomInt(0, 10));
  return pin;
}

/**
 * Issues a caller a new PIN and returns it once.
 *
 * Returned rather than stored in the clear, and returned exactly once — the
 * caller is told it, and after that only the hash exists. Re-issuing is how a
 * forgotten PIN is handled; there is no path that reads one back.
 */
export async function issuePin(params: {
  orgId: string;
  userId: string;
  issuedByUserId: string;
}): Promise<{ pin: string; issuedAt: Date }> {
  // Only somebody who is already a caller. This used to upsert a profile,
  // which meant that issuing a PIN to any user id — the owner, the finance
  // reviewer — silently turned them into a caller. A calling credential is not
  // something an account should acquire as a side effect of a button.
  const user = await prisma.user.findFirst({
    where: { id: params.userId, orgId: params.orgId },
    select: { id: true, name: true, isActive: true, callerProfile: { select: { id: true } } },
  });
  if (!user) throw new CallerAuthError('That person is not in your organisation.', 404);
  if (!user.callerProfile) {
    throw new CallerAuthError(
      'That account is not a caller, so it cannot be given a calling PIN. Create a caller instead.',
      409,
    );
  }
  if (!user.isActive) {
    throw new CallerAuthError('That caller is deactivated. Reactivate them before issuing a PIN.', 409);
  }

  // A PIN now has to be unique across the organisation, because it is the only
  // thing identifying its holder. The database enforces that; this retries
  // rather than handing somebody a PIN that silently failed to save. Ten digits
  // makes a collision vanishingly unlikely, which is exactly why it must not be
  // handled by hoping.
  const issuedAt = new Date();
  let pin = '';
  for (let attempt = 1; ; attempt += 1) {
    pin = generatePin();
    try {
      await prisma.callerProfile.update({
        where: { userId: params.userId },
        data: {
          pinHash: await hashSecret(pin, PIN_LENGTH),
          pinLookup: pinLookupValue(pin),
          pinSetAt: issuedAt,
          pinIssuedById: params.issuedByUserId,
          pinFailedCount: 0,
          pinLockedUntil: null,
          pinRevokedAt: null,
        },
      });
      break;
    } catch (error) {
      const collision =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
      if (!collision || attempt >= 5) throw error;
    }
  }

  await audit({
    orgId: params.orgId,
    userId: params.issuedByUserId,
    action: 'caller.pin_issued',
    entityType: 'User',
    entityId: params.userId,
    // The PIN itself never reaches the audit log.
    metadata: { caller: user.name },
  });

  return { pin, issuedAt };
}

/** Takes a caller's PIN away without touching them, their packets or history. */
export async function revokePin(params: {
  orgId: string;
  userId: string;
  revokedByUserId: string;
}): Promise<void> {
  const profile = await prisma.callerProfile.findFirst({
    where: { userId: params.userId, user: { orgId: params.orgId } },
    select: { id: true },
  });
  if (!profile) throw new CallerAuthError('That person has no caller profile.', 404);

  await prisma.callerProfile.update({
    where: { id: profile.id },
    data: { pinRevokedAt: new Date(), pinHash: null, pinFailedCount: 0, pinLockedUntil: null },
  });

  await audit({
    orgId: params.orgId,
    userId: params.revokedByUserId,
    action: 'caller.pin_revoked',
    entityType: 'User',
    entityId: params.userId,
  });
}

/**
 * Signs a caller in from a PIN and nothing else.
 *
 * There is no identifier field. A caller arriving for a shift has a number on a
 * card and no reason to remember which of an operator's email conventions their
 * account was created under, and an email box on this door was one more thing
 * to get wrong at the start of a shift.
 *
 * What that costs, stated plainly because it is a real cost: with no
 * identifier, a wrong guess is no longer a wrong guess *at somebody*. Every
 * attempt is aimed at whoever holds that number, so no single profile
 * accumulates the failures that trigger its lockout, and the space to search is
 * the PIN space divided by the number of callers. Three things answer that. The
 * PIN is ten digits rather than six. The database enforces that no two callers
 * share one, so a match is never ambiguous. And attempts are counted per source
 * and in total, durably, in ./pinLookup — which is the only counter that can
 * see somebody walking the number space rather than guessing at a person.
 *
 * Everything that made the old door work is kept: one message for every
 * rejection, the per-caller lockout for somebody who does know a PIN and keeps
 * mistyping it, revocation, rotation, and the same `Session` row every other
 * user gets, so attribution and permissions need no second notion of identity.
 */
export async function signInWithPin(params: {
  pin: string;
  ip?: string;
  userAgent?: string;
}): Promise<{ token: string; expiresAt: Date; userId: string; orgId: string; name: string }> {
  const pin = params.pin.trim();
  if (!pin) throw new CallerAuthError('Enter your PIN.', 400);

  // Counted before anything is looked up, so a wrong PIN and a right one cost
  // the attacker the same budget.
  const source = params.ip?.trim() || 'unknown';
  const budget = await recordAttempt(source);
  if (!budget.allowed) {
    throw new CallerAuthError(
      `Too many sign-in attempts. Try again in ${budget.retryInMinutes} minute`
        + `${budget.retryInMinutes === 1 ? '' : 's'}.`,
      429,
    );
  }

  // One message for every rejection below, so this endpoint cannot be used to
  // learn which PINs exist, which are revoked, or how many callers there are.
  const reject = () => new CallerAuthError('That PIN was not recognised.', 401);

  const profile = await prisma.callerProfile.findUnique({
    where: { pinLookup: pinLookupValue(pin) },
    include: { user: true },
  });

  const pinHash = profile?.pinHash ?? null;
  if (!profile || !pinHash || profile.pinRevokedAt || !profile.user.isActive) throw reject();

  if (profile.pinLockedUntil && profile.pinLockedUntil > new Date()) {
    const minutes = Math.ceil((profile.pinLockedUntil.getTime() - Date.now()) / 60_000);
    throw new CallerAuthError(
      `Too many wrong PINs. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or ask for a new one.`,
      429,
    );
  }

  // The index found a candidate; the slow hash still decides. Belt and braces
  // against a lookup collision or a stale index, and the only comparison that
  // is allowed to grant a session.
  const matches = await verifyPassword(pin, pinHash);
  if (!matches) {
    const failures = profile.pinFailedCount + 1;
    await prisma.callerProfile.update({
      where: { id: profile.id },
      data: {
        pinFailedCount: failures,
        pinLockedUntil: failures >= MAX_FAILURES ? new Date(Date.now() + LOCKOUT_MS) : null,
      },
    });
    throw reject();
  }

  await prisma.callerProfile.update({
    where: { id: profile.id },
    data: { pinFailedCount: 0, pinLockedUntil: null, pinLastUsedAt: new Date() },
  });
  // A floor signing in from one office must not lock itself out by lunchtime.
  await forgiveSource(source);

  const user = profile.user;
  const session = await createSession(user.id, { ip: params.ip, userAgent: params.userAgent });

  await audit({
    orgId: user.orgId,
    userId: user.id,
    action: 'caller.signed_in',
    entityType: 'User',
    entityId: user.id,
    metadata: { via: 'pin' },
  });

  return { ...session, userId: user.id, orgId: user.orgId, name: user.name };
}

export type CallerReadiness = {
  ready: boolean;
  /** Why they cannot start, in their own words. Null when they can. */
  blocker: string | null;
  /** Things worth telling them that do not stop them working. */
  notices: string[];
  openPackets: number;
  itemsWaiting: number;
  /** An unresolved system failure of ours, which is not their fault. */
  openIncidents: number;
};

/**
 * The pre-shift check.
 *
 * Answers one question — can this person start calling right now — and, where
 * the answer is no, says whose problem it is. An unresolved save failure blocks
 * work and is ours; an empty packet blocks work and is the owner's; neither is
 * the caller's, and a screen that just says "no work" invites them to assume it
 * is.
 */
export async function callerReadiness(params: {
  orgId: string;
  userId: string;
}): Promise<CallerReadiness> {
  const [packets, incidents] = await Promise.all([
    prisma.workPacket.findMany({
      where: { orgId: params.orgId, callerId: params.userId, status: 'OPEN' },
      select: {
        id: true,
        expiresAt: true,
        items: { where: { status: { in: ['PENDING', 'IN_PROGRESS'] } }, select: { id: true } },
        _count: { select: { items: true } },
      },
    }),
    prisma.workIncident.count({
      where: { orgId: params.orgId, callerId: params.userId, status: 'OPEN' },
    }),
  ]);

  const now = new Date();
  const live = packets.filter((p) => !p.expiresAt || p.expiresAt > now);
  const waiting = live.reduce((sum, p) => sum + p.items.length, 0);
  // A packet that was built empty is not a packet that has been worked. The
  // two produce the same "nothing waiting" and want opposite messages: one is
  // "well done", the other is "nobody actually gave you anything".
  const anyItems = live.reduce((sum, p) => sum + p._count.items, 0);
  const notices: string[] = [];

  const expired = packets.length - live.length;
  if (expired > 0) {
    notices.push(`${expired} packet(s) have expired and are no longer served. Nothing in them was lost.`);
  }
  if (incidents > 0) {
    notices.push(
      `${incidents} unresolved system incident(s) on your work. These are ours to fix and are not counted against you.`,
    );
  }
  if (waiting > 0 && waiting <= 5) {
    // Exhaustion visible before the shift rather than at the end of it.
    notices.push(`Only ${waiting} opportunit${waiting === 1 ? 'y' : 'ies'} left in your packets.`);
  }

  return {
    ready: waiting > 0,
    blocker:
      live.length === 0
        ? 'You have no open packet. Somebody needs to assign you work before you can start.'
        : anyItems === 0
          ? 'Your packet is empty — nothing was actually assigned to it. Ask for work.'
          : waiting === 0
            ? 'Everything in your packets has been worked. Ask for more.'
            : null,
    notices,
    openPackets: live.length,
    itemsWaiting: waiting,
    openIncidents: incidents,
  };
}

/** Constant-time compare, for anywhere a short code is checked directly. */
export function sameCode(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
