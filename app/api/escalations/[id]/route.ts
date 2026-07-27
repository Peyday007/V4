import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { audit, recordActivity } from '@/lib/audit';
import { determineNextAction } from '@/lib/ai/nextAction';
import { handleRouteError, json } from '@/lib/api';

export const dynamic = 'force-dynamic';

const schema = z.object({
  status: z.enum(['ACKNOWLEDGED', 'RESOLVED', 'DISMISSED']),
  note: z.string().max(2000).optional(),
});

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requirePermission('escalation.resolve');
    const body = schema.parse(await request.json());

    const escalation = await prisma.escalation.findFirst({ where: { id: params.id, orgId: user.orgId } });
    if (!escalation) return json({ error: 'Escalation not found' }, 404);

    await prisma.escalation.update({
      where: { id: escalation.id },
      data: {
        status: body.status,
        assigneeId: user.id,
        resolutionNote: body.note ?? null,
        resolvedAt: body.status === 'RESOLVED' || body.status === 'DISMISSED' ? new Date() : null,
      },
    });

    if (escalation.opportunityId && (body.status === 'RESOLVED' || body.status === 'DISMISSED')) {
      const remaining = await prisma.escalation.count({
        where: { opportunityId: escalation.opportunityId, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
      });
      if (remaining === 0) {
        await prisma.opportunity.update({
          where: { id: escalation.opportunityId },
          data: { status: 'ACTIVE', primaryBlocker: null },
        });
      }
      await recordActivity({
        orgId: user.orgId,
        opportunityId: escalation.opportunityId,
        userId: user.id,
        actorType: 'user',
        verb: 'escalation.resolved',
        summary: `${escalation.title} — ${body.status.toLowerCase()}${body.note ? `: ${body.note}` : ''}`,
        payload: { escalationId: escalation.id },
      });
      await determineNextAction(escalation.opportunityId);
    }

    await audit({
      orgId: user.orgId,
      userId: user.id,
      action: 'escalation.updated',
      entityType: 'Escalation',
      entityId: escalation.id,
      metadata: { status: body.status },
    });

    return json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
