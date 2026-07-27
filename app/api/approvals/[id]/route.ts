import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { audit, recordActivity } from '@/lib/audit';
import { determineNextAction } from '@/lib/ai/nextAction';
import { handleRouteError, json } from '@/lib/api';

export const dynamic = 'force-dynamic';

const schema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED', 'CHANGES_REQUESTED']),
  note: z.string().max(2000).optional(),
});

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requirePermission('deal.approve');
    const body = schema.parse(await request.json());

    const approval = await prisma.approval.findFirst({
      where: { id: params.id, orgId: user.orgId },
      include: { document: true },
    });
    if (!approval) return json({ error: 'Approval not found' }, 404);
    if (approval.status !== 'PENDING') return json({ error: 'This approval has already been decided' }, 409);

    await prisma.approval.update({
      where: { id: approval.id },
      data: { status: body.decision, decidedById: user.id, decisionNote: body.note ?? null, decidedAt: new Date() },
    });

    // An approved document becomes sendable; anything else stays locked down.
    if (approval.documentId) {
      await prisma.document.update({
        where: { id: approval.documentId },
        data: { status: body.decision === 'APPROVED' ? 'APPROVED' : 'DRAFT' },
      });
    }

    if (approval.opportunityId) {
      await recordActivity({
        orgId: user.orgId,
        opportunityId: approval.opportunityId,
        userId: user.id,
        actorType: 'user',
        verb: 'approval.decided',
        summary: `${approval.title} — ${body.decision.toLowerCase().replace(/_/g, ' ')}${body.note ? `: ${body.note}` : ''}`,
        payload: { approvalId: approval.id, decision: body.decision },
      });

      if (body.decision === 'APPROVED') {
        await prisma.opportunity.update({
          where: { id: approval.opportunityId },
          data: { status: 'ACTIVE', primaryBlocker: null },
        });
      }
      await determineNextAction(approval.opportunityId);
    }

    await audit({
      orgId: user.orgId,
      userId: user.id,
      action: 'approval.decided',
      entityType: 'Approval',
      entityId: approval.id,
      metadata: { decision: body.decision },
    });

    return json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
