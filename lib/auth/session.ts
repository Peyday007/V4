import { createHash, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { prisma } from '@/lib/db';
import { isProduction } from '@/lib/env';
import type { PermissionKey } from './rbac';
import { roleHasPermission } from './rbac';

export const SESSION_COOKIE = 'dd_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

export type SessionUser = {
  id: string;
  orgId: string;
  email: string;
  name: string;
  roleKey: string;
  roleName: string;
  timezone: string;
};

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(
  userId: string,
  meta: { ip?: string; userAgent?: string } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await prisma.session.create({
    data: { userId, tokenHash: hashToken(token), expiresAt, ip: meta.ip, userAgent: meta.userAgent },
  });
  return { token, expiresAt };
}

export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: isProduction(),
    sameSite: 'lax' as const,
    path: '/',
    expires: expiresAt,
  };
}

export async function destroySession(token: string): Promise<void> {
  await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}

/** Resolve the current user from the session cookie, or null. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { include: { role: true } } },
  });

  if (!session || session.expiresAt < new Date()) return null;
  if (!session.user.isActive) return null;

  return {
    id: session.user.id,
    orgId: session.user.orgId,
    email: session.user.email,
    name: session.user.name,
    roleKey: session.user.role.key,
    roleName: session.user.role.name,
    timezone: session.user.timezone,
  };
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new AuthError('Authentication required', 401);
  return user;
}

export async function requirePermission(permission: PermissionKey): Promise<SessionUser> {
  const user = await requireUser();
  if (!roleHasPermission(user.roleKey, permission)) {
    throw new AuthError(`Missing permission: ${permission}`, 403);
  }
  return user;
}

/** Non-throwing check for conditional UI. Never use as the only gate. */
export function can(user: SessionUser | null, permission: PermissionKey): boolean {
  if (!user) return false;
  return roleHasPermission(user.roleKey, permission);
}

/** Requires any one of the listed permissions. */
export async function requireAny(...permissions: PermissionKey[]): Promise<SessionUser> {
  const user = await requireUser();
  if (!permissions.some((p) => roleHasPermission(user.roleKey, p))) {
    throw new AuthError(`Missing one of: ${permissions.join(', ')}`, 403);
  }
  return user;
}
