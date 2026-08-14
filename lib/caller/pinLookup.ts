import { createHmac, timingSafeEqual } from 'node:crypto';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';

/**
 * Finding a caller from a PIN and nothing else.
 *
 * Sign-in used to take an email and a PIN, and the email did the finding. With
 * the email gone the PIN has to do both jobs, and a scrypt hash cannot do the
 * first — it is designed not to. The two obvious alternatives are both wrong:
 * storing the PIN in the clear puts every caller's credential in the database,
 * and verifying a submitted PIN against every profile in turn is a linear scan
 * of a deliberately slow hash, which is also a timing oracle for how many
 * callers exist.
 *
 * So the PIN is indexed by a keyed HMAC. The key lives in the environment and
 * not in the table, so a copy of the database is not a list of PINs — without
 * the key an attacker holding `pinLookup` has to break the HMAC, and with a
 * ten-digit space and no key that is not a table they can build. The slow hash
 * still does the actual verification; this only does the finding.
 *
 * The index is unique, which is the requirement's other half. Two callers with
 * one PIN is a PIN that identifies neither, and every call outcome, every
 * packet, every "who said this" downstream would be a coin toss.
 */

/**
 * A PIN's lookup value.
 *
 * Keyed off `SESSION_SECRET`, which the deployment already has and already
 * treats as a signing key, so no new secret has to be minted, distributed or
 * remembered. Rotating it invalidates every lookup — PINs would have to be
 * re-issued — which is the same blast radius rotating it already has for
 * sessions.
 */
export function pinLookupValue(pin: string): string {
  return createHmac('sha256', env().SESSION_SECRET).update(`caller-pin:${pin.trim()}`).digest('hex');
}

/** Constant-time compare, so a partial match leaks nothing through timing. */
export function lookupMatches(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

// ---------------------------------------------------------------------------
// Spray protection
// ---------------------------------------------------------------------------

/**
 * The per-caller lockout cannot see this attack.
 *
 * With an identifier, a wrong guess is a wrong guess *at somebody*, and five of
 * them close that person's account. Without one, every guess is aimed at
 * whoever happens to hold that PIN — so an attacker walking the number space
 * accumulates no failures anywhere, and the lockout that made a six-digit PIN
 * defensible never fires.
 *
 * Attempts are therefore also counted by source and in total. Durably: the
 * in-process limiter in lib/api is per-instance, and a serverless deployment
 * has as many instances as it feels like having, which makes an in-memory
 * counter a suggestion.
 */
const WINDOW_MS = 15 * 60_000;
/** Per client address. Generous for a person; nowhere near enough to walk. */
const PER_SOURCE_LIMIT = 10;
/**
 * Across everybody. A real floor of callers signing in for a shift is dozens
 * of attempts an hour; a number far above that and still far below what a
 * search needs is the right place to stop and make somebody look.
 */
const GLOBAL_LIMIT = 200;

function windowStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / WINDOW_MS) * WINDOW_MS);
}

export type SprayVerdict = { allowed: true } | { allowed: false; retryInMinutes: number };

/** Whether this attempt may proceed, counting it against both buckets. */
export async function recordAttempt(scope: string, now = new Date()): Promise<SprayVerdict> {
  const windowAt = windowStart(now);
  const retryInMinutes = Math.max(1, Math.ceil((windowAt.getTime() + WINDOW_MS - now.getTime()) / 60_000));

  const [source, global] = await Promise.all([
    bump(scope, windowAt),
    bump('global', windowAt),
  ]);

  if (source > PER_SOURCE_LIMIT || global > GLOBAL_LIMIT) return { allowed: false, retryInMinutes };
  return { allowed: true };
}

async function bump(scope: string, windowAt: Date): Promise<number> {
  const row = await prisma.pinAttempt.upsert({
    where: { scope_windowAt: { scope, windowAt } },
    create: { scope, windowAt, count: 1 },
    update: { count: { increment: 1 } },
    select: { count: true },
  });
  return row.count;
}

/**
 * A successful sign-in clears that source's budget.
 *
 * Otherwise a busy floor signing in from one office locks itself out by
 * lunchtime, which is a denial of service the operator inflicts on themselves.
 * The global bucket is deliberately not cleared: it exists to notice a walk
 * through the number space, and a walk that happens to find a live PIN
 * partway is exactly when it should still be counting.
 */
export async function forgiveSource(scope: string, now = new Date()): Promise<void> {
  await prisma.pinAttempt
    .delete({ where: { scope_windowAt: { scope, windowAt: windowStart(now) } } })
    .catch(() => undefined);
}

/** Old windows are noise. Called from the same sweep that trims sessions. */
export async function purgeOldAttempts(before = new Date(Date.now() - 24 * 3_600_000)): Promise<number> {
  const result = await prisma.pinAttempt.deleteMany({ where: { windowAt: { lt: before } } });
  return result.count;
}
