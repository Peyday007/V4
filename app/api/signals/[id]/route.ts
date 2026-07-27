import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { audit } from '@/lib/audit';
import { promoteSignals } from '@/lib/discovery/promote';
import { handleRouteError, json } from '@/lib/api';

export const dynamic = 'force-dynamic';

const schema = z.object({ action: z.enum(['promote', 'dismiss']), reason: z.string().optional() });

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requirePermission('discovery.review');
    const body = schema.parse(await request.json());

    const signal = await prisma.discoverySignal.findFirst({ where: { id: params.id, orgId: user.orgId } });
    if (!signal) return json({ error: 'Signal not found' }, 404);

    if (body.action === 'dismiss') {
      await prisma.discoverySignal.update({ where: { id: signal.id }, data: { status: 'DISMISSED' } });
    } else {
      // Reset to NEW so the shared promotion path handles grouping and scoring.
      await prisma.discoverySignal.update({ where: { id: signal.id }, data: { status: 'NEW', strength: Math.max(signal.strength, 0.7) } });
      await promoteSignals({ orgId: user.orgId, limit: 50 });
    }

    await audit({
      orgId: user.orgId,
      userId: user.id,
      action: `signal.${body.action}`,
      entityType: 'DiscoverySignal',
      entityId: signal.id,
      metadata: { reason: body.reason },
    });

    return json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
