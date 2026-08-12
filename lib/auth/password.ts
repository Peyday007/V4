import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEYLEN = 64;

/**
 * scrypt with per-secret salt. Format: scrypt$<saltHex>$<hashHex>.
 *
 * The minimum length is a property of the credential, not of the hashing, so
 * it is a parameter. A password typed once a day should be long; a caller's
 * PIN, typed between calls on a shared machine, is short by design and is
 * protected by a lockout instead. Both go through the same scrypt — a short
 * credential is not a reason to hash it weakly.
 */
export async function hashSecret(secret: string, minimumLength: number): Promise<string> {
  if (secret.length < minimumLength) {
    throw new Error(`Secret must be at least ${minimumLength} characters`);
  }
  const salt = randomBytes(16);
  const derived = await scrypt(secret, salt, KEYLEN);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function hashPassword(password: string): Promise<string> {
  return hashSecret(password, 10);
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const derived = await scrypt(password, salt, expected.length);
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
