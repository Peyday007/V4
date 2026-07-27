import { requireUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { getStorage } from '@/lib/providers/storage';
import { audit } from '@/lib/audit';
import { handleRouteError, json } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Authorised file access. Stored objects are never publicly readable: every
 * fetch is authenticated, scoped to the caller's org, and audited.
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const url = new URL(request.url);
    const key = url.searchParams.get('key');
    if (!key) return json({ error: 'key is required' }, 400);

    const expires = Number(url.searchParams.get('expires') ?? 0);
    if (expires && expires < Date.now()) return json({ error: 'Link expired' }, 410);

    // The key must belong to a record inside the caller's organisation.
    const owned =
      key.startsWith(`recordings/${user.orgId}/`) ||
      (await prisma.document.findFirst({ where: { orgId: user.orgId, storageKey: key }, select: { id: true } })) !== null;
    if (!owned) return json({ error: 'Not found' }, 404);

    const buffer = await getStorage().get(key);

    await audit({
      orgId: user.orgId,
      userId: user.id,
      action: 'file.downloaded',
      entityType: 'File',
      entityId: key,
    });

    return new Response(new Uint8Array(buffer), {
      headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, no-store' },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
