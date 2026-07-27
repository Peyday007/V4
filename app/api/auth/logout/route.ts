import { cookies } from 'next/headers';
import { destroySession, getSessionUser, SESSION_COOKIE } from '@/lib/auth/session';
import { audit } from '@/lib/audit';
import { handleRouteError, json } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const user = await getSessionUser();
    const token = cookies().get(SESSION_COOKIE)?.value;
    if (token) await destroySession(token);
    cookies().delete(SESSION_COOKIE);
    if (user) {
      await audit({ orgId: user.orgId, userId: user.id, action: 'auth.logout', entityType: 'User', entityId: user.id });
    }
    return json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
