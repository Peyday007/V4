import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { audit, recordActivity } from '@/lib/audit';
import { recordDealEvent } from '@/lib/deal/events';
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

    // Deal-progression approvals sit on the live route path and have their own
    // append-only trail. Recorded here rather than left to the quote screen,
    // because the decision is the event — a decision only visible on the page
    // where it was made is a decision nobody can reconstruct afterwards.
    if (approval.routeId) {
      await prisma.$transaction(async (tx) => {
        await recordDealEvent(tx, {
          orgId: user.orgId,
          routeId: approval.routeId as string,
          kind: `approval.${body.decision.toLowerCase()}`,
          actorId: user.id,
          subjectType: 'Approval',
          subjectId: approval.id,
          summary: `${approval.title} — ${body.decision.toLowerCase().replace(/_/g, ' ')}${body.note ? `: ${body.note}` : ''}`,
          before: { status: 'PENDING' },
          after: { status: body.decision },
          evidence: body.note ?? null,
        });
      });

      // An approved quote becomes sendable. Anything else leaves it exactly
      // where it was, so a rejection cannot be walked past by reloading.
      if (approval.routeQuoteId && body.decision === 'APPROVED') {
        const stillPending = await prisma.approval.count({
          where: { routeQuoteId: approval.routeQuoteId, status: 'PENDING' },
        });
        if (stillPending === 0) {
          await prisma.routeQuote.updateMany({
            where: { id: approval.routeQuoteId, state: 'PENDING_APPROVAL' },
            data: { state: 'APPROVED' },
          });
        }
      }
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
