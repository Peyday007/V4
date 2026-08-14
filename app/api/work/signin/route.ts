import { cookies } from 'next/headers';
import { z } from 'zod';
import { handleRouteError, json } from '@/lib/api';
import { SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth/session';
import { CallerAuthError, signInWithPin } from '@/lib/caller/identity';

export const dynamic = 'force-dynamic';

const Body = z.object({
  // Nothing but the PIN. Deliberately generous on length so an old six-digit
  // PIN issued before the change still reaches the same rejection as any other
  // wrong one, rather than being turned away by validation with a different
  // message — which would tell an attacker how long a live PIN is.
  pin: z.string().min(4).max(24),
});

/**
 * Caller sign-in with a personal PIN, and nothing else.
 *
 * Separate from `/api/auth/login` because the credential is different, not
 * because the session is: this issues the same `Session` row every other user
 * gets, so everything downstream — attribution, audit, permissions — works
 * without a second notion of who somebody is.
 *
 * The client address is passed through because it is the only thing this door
 * can rate-limit by. Without an identifier there is no account to lock, so the
 * counter in lib/caller/pinLookup is what stands between the PIN space and
 * somebody with time.
 */
export async function POST(request: Request) {
  try {
    const parsed = Body.safeParse(await request.json());
    if (!parsed.success) return json({ error: 'Enter your PIN.' }, 400);

    const result = await signInWithPin({
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
