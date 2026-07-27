import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { audit } from '@/lib/audit';
import { selectMatch } from '@/lib/ai/matching';
import { configureDeal } from '@/lib/ai/dealConfig';
import { determineNextAction } from '@/lib/ai/nextAction';
import { handleRouteError, json } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requirePermission('deal.write');
    const match = await prisma.match.findFirst({ where: { id: params.id, orgId: user.orgId } });
    if (!match) return json({ error: 'Match not found' }, 404);

    await selectMatch(match.opportunityId, match.id, user.id);
    const deal = await configureDeal(match.opportunityId);
    const next = await determineNextAction(match.opportunityId);

    await audit({
      orgId: user.orgId,
      userId: user.id,
      action: 'match.selected',
      entityType: 'Match',
      entityId: match.id,
      metadata: { opportunityId: match.opportunityId, score: match.score },
    });

    return json({ ok: true, deal, nextAction: next.type });
  } catch (error) {
    return handleRouteError(error);
  }
}
