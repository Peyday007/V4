import { cookies } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { verifyPassword } from '@/lib/auth/password';
import { createSession, SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth/session';
import { audit } from '@/lib/audit';
import { clientIp, handleRouteError, json, rateLimit } from '@/lib/api';

export const dynamic = 'force-dynamic';

const schema = z.object({ email: z.string().email(), password: z.string().min(1) });

export async function POST(request: Request) {
  try {
    const ip = clientIp(request);
    if (!rateLimit(`login:${ip}`, 10, 60_000)) {
      return json({ error: 'Too many sign-in attempts. Try again shortly.' }, 429);
    }

    const { email, password } = schema.parse(await request.json());

    const user = await prisma.user.findFirst({
      where: { email: email.toLowerCase() },
      include: { role: true },
    });

    // Same response and comparable timing whether or not the account exists.
    const valid = user ? await verifyPassword(password, user.passwordHash) : false;
    if (!user || !valid || !user.isActive) {
      if (user) {
        await audit({
          orgId: user.orgId,
          userId: user.id,
          action: 'auth.login_failed',
          entityType: 'User',
          entityId: user.id,
          ip,
          metadata: { reason: valid ? 'inactive' : 'bad_password' },
        });
      }
      return json({ error: 'Invalid email or password' }, 401);
    }

    const { token, expiresAt } = await createSession(user.id, {
      ip,
      userAgent: request.headers.get('user-agent') ?? undefined,
    });
    cookies().set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt));

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await audit({ orgId: user.orgId, userId: user.id, action: 'auth.login', entityType: 'User', entityId: user.id, ip });

    return json({ ok: true, redirectTo: user.role.key === 'CALLER' ? '/calls' : '/dashboard' });
  } catch (error) {
    return handleRouteError(error);
  }
}
