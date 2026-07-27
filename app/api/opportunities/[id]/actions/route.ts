import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireAny, requirePermission } from '@/lib/auth/session';
import { audit } from '@/lib/audit';
import { configureDeal } from '@/lib/ai/dealConfig';
import { generateDocument } from '@/lib/ai/documents';
import { findMatches } from '@/lib/ai/matching';
import { determineNextAction } from '@/lib/ai/nextAction';
import { scoreOpportunity } from '@/lib/ai/scoring';
import { evaluateGovernance } from '@/lib/ai/escalation';
import { handleRouteError, json } from '@/lib/api';

export const dynamic = 'force-dynamic';

const schema = z.object({
  action: z.enum(['rescore', 'rematch', 'configure', 'next_action', 'run_full_loop', 'generate_document', 'mark_lost', 'mark_won']),
  documentKind: z.string().optional(),
  reason: z.string().optional(),
});

/** Runs an AI process against one opportunity, on request from the UI. */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireAny('opportunity.write', 'deal.write');
    const body = schema.parse(await request.json());

    const opportunity = await prisma.opportunity.findFirst({
      where: { id: params.id, orgId: user.orgId },
      select: { id: true },
    });
    if (!opportunity) return json({ error: 'Opportunity not found' }, 404);

    let result: unknown;

    switch (body.action) {
      case 'rescore':
        result = await scoreOpportunity(params.id);
        break;
      case 'rematch':
        result = await findMatches(params.id);
        break;
      case 'configure':
        result = await configureDeal(params.id);
        break;
      case 'next_action':
        result = await determineNextAction(params.id);
        break;
      case 'run_full_loop': {
        await scoreOpportunity(params.id);
        await findMatches(params.id);
        await configureDeal(params.id);
        await evaluateGovernance(params.id);
        await scoreOpportunity(params.id);
        result = await determineNextAction(params.id);
        break;
      }
      case 'generate_document': {
        await requirePermission('document.write');
        if (!body.documentKind) return json({ error: 'documentKind is required' }, 400);
        result = await generateDocument({ orgId: user.orgId, opportunityId: params.id, kind: body.documentKind as never });
        break;
      }
      case 'mark_won': {
        await requirePermission('opportunity.stage.override');
        await prisma.dealStatusHistory.create({
          data: {
            opportunityId: params.id,
            toStage: 'COMPLETED',
            toStatus: 'WON',
            reason: body.reason ?? 'Marked won by manager',
            actorType: 'user',
            actorId: user.id,
          },
        });
        result = await prisma.opportunity.update({
          where: { id: params.id },
          data: { stage: 'COMPLETED', status: 'WON', closedAt: new Date(), stageEnteredAt: new Date() },
        });
        break;
      }
      case 'mark_lost': {
        await requirePermission('opportunity.stage.override');
        await prisma.dealStatusHistory.create({
          data: {
            opportunityId: params.id,
            toStage: 'LOST',
            toStatus: 'LOST',
            reason: body.reason ?? 'Marked lost by manager',
            actorType: 'user',
            actorId: user.id,
          },
        });
        result = await prisma.opportunity.update({
          where: { id: params.id },
          data: { stage: 'LOST', status: 'LOST', closedAt: new Date(), lostReason: body.reason ?? 'Not specified', stageEnteredAt: new Date() },
        });
        break;
      }
    }

    await audit({
      orgId: user.orgId,
      userId: user.id,
      action: `opportunity.${body.action}`,
      entityType: 'Opportunity',
      entityId: params.id,
      metadata: { reason: body.reason },
    });

    return json({ ok: true, result });
  } catch (error) {
    return handleRouteError(error);
  }
}
