import { z } from 'zod';
import { handleRouteError, json } from '@/lib/api';
import { requirePermission } from '@/lib/auth/session';
import { CallerAuthError, issuePin, revokePin } from '@/lib/caller/identity';

export const dynamic = 'force-dynamic';

const Body = z.object({ userId: z.string().min(1) });

/**
 * Issues a caller a PIN, returned exactly once.
 *
 * There is no endpoint that reads a PIN back. A forgotten one is replaced, not
 * recovered, because a credential a manager can look up is a credential the
 * person it belongs to cannot be held to.
 */
export async function POST(request: Request) {
  try {
    const user = await requirePermission('admin.users');
    const parsed = Body.safeParse(await request.json());
    if (!parsed.success) return json({ error: 'Name the person.' }, 400);
    const result = await issuePin({
      orgId: user.orgId,
      userId: parsed.data.userId,
      issuedByUserId: user.id,
    });
    return json({ pin: result.pin, note: 'Give this to them now. It cannot be read again.' });
  } catch (error) {
    if (error instanceof CallerAuthError) return json({ error: error.message }, error.statusCode);
    return handleRouteError(error);
  }
}

/** Takes the PIN away without touching the person, their packets or history. */
export async function DELETE(request: Request) {
  try {
    const user = await requirePermission('admin.users');
    const parsed = Body.safeParse(await request.json());
    if (!parsed.success) return json({ error: 'Name the person.' }, 400);
    await revokePin({ orgId: user.orgId, userId: parsed.data.userId, revokedByUserId: user.id });
    return json({ ok: true });
  } catch (error) {
    if (error instanceof CallerAuthError) return json({ error: error.message }, error.statusCode);
    return handleRouteError(error);
  }
}
