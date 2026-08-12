import { cookies } from 'next/headers';
import { z } from 'zod';
import { handleRouteError, json } from '@/lib/api';
import { SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth/session';
import { CallerAuthError, signInWithPin } from '@/lib/caller/identity';

export const dynamic = 'force-dynamic';

const Body = z.object({
  identifier: z.string().min(1).max(200),
  pin: z.string().min(4).max(12),
});

/**
 * Caller sign-in with a personal PIN.
 *
 * Separate from `/api/auth/login` because the credential is different, not
 * because the session is: this issues the same `Session` row every other user
 * gets, so everything downstream — attribution, audit, permissions — works
 * without a second notion of who somebody is.
 */
export async function POST(request: Request) {
  try {
    const parsed = Body.safeParse(await request.json());
    if (!parsed.success) return json({ error: 'Enter your email and your PIN.' }, 400);

    const result = await signInWithPin({
      identifier: parsed.data.identifier,
      pin: parsed.data.pin,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim(),
      userAgent: request.headers.get('user-agent') ?? undefined,
    });

    cookies().set(SESSION_COOKIE, result.token, sessionCookieOptions(result.expiresAt));
    return json({ ok: true, name: result.name });
  } catch (error) {
    if (error instanceof CallerAuthError) return json({ error: error.message }, error.statusCode);
    return handleRouteError(error);
  }
}
