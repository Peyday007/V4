import { z } from 'zod';
import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/session';
import { handleRouteError, json } from '@/lib/api';
import { loadCampaign, transitionCampaign, recordChannelSpend } from '@/lib/campaign/service';
import { generateCampaignWork, runCampaignTasks } from '@/lib/campaign/execute';

export const dynamic = 'force-dynamic';

/** One campaign: its thesis, its evidence, what it produced, and where it stands. */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requirePermission('campaign.read');
    const loaded = await loadCampaign({ orgId: user.orgId, campaignId: params.id });
    return json(loaded);
  } catch (error) {
    return handleRouteError(error);
  }
}

const Action = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('transition'),
    to: z.enum(['AWAITING_AUTHORITY', 'RUNNING', 'PAUSED', 'KILLED', 'EXPANDED', 'CONCLUDED', 'DRAFT']),
    reason: z.string().max(2000).optional(),
  }),
  z.object({ action: z.literal('generate_work'), limit: z.number().int().min(1).max(100).optional() }),
  z.object({ action: z.literal('run_tasks'), limit: z.number().int().min(1).max(100).optional() }),
  z.object({
    action: z.literal('record_spend'),
    kind: z.string().min(3).max(40),
    amountCents: z.number().int().min(1),
  }),
  z.object({ action: z.literal('conclude'), learning: z.string().min(20).max(4000) }),
]);

/**
 * The things that can be done to a campaign.
 *
 * Each carries its own refusal. Starting one needs `campaign.authorise`, not
 * `campaign.write` — drafting a thesis and committing money to it are
 * different acts, and every product that ever had a single "save and launch"
 * button conflated them.
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requirePermission('campaign.write');
    const parsed = Action.safeParse(await request.json());
    if (!parsed.success) return json({ error: 'Unrecognised action.' }, 400);
    const body = parsed.data;

    if (body.action === 'transition') {
      const result = await transitionCampaign({
        orgId: user.orgId,
        campaignId: params.id,
        actorId: user.id,
        actorMayAuthorise: can(user, 'campaign.authorise'),
        to: body.to,
        reason: body.reason,
      });
      return json(result, result.ok ? 200 : 409);
    }

    if (body.action === 'generate_work') {
      const report = await generateCampaignWork({
        orgId: user.orgId,
        campaignId: params.id,
        actorId: user.id,
        limit: body.limit,
      });
      return json(report);
    }

    if (body.action === 'run_tasks') {
      const results = await runCampaignTasks({
        orgId: user.orgId,
        campaignId: params.id,
        limit: body.limit,
      });
      return json({ ran: results.length, results });
    }

    if (body.action === 'record_spend') {
      // Spending is the one action here that moves money, so it needs the
      // authority permission even though it is not a state change.
      if (!can(user, 'campaign.authorise')) {
        return json({ error: 'Recording spend needs campaign authority.' }, 403);
      }
      const result = await recordChannelSpend({
        orgId: user.orgId,
        campaignId: params.id,
        kind: body.kind,
        amountCents: body.amountCents,
        actorId: user.id,
      });
      return json(result, result.ok ? 200 : 409);
    }

    if (body.action === 'conclude') {
      const result = await transitionCampaign({
        orgId: user.orgId,
        campaignId: params.id,
        actorId: user.id,
        actorMayAuthorise: can(user, 'campaign.authorise'),
        to: 'CONCLUDED',
        reason: body.learning,
      });
      return json(result, result.ok ? 200 : 409);
    }

    return json({ error: 'Unrecognised action.' }, 400);
  } catch (error) {
    return handleRouteError(error);
  }
}
