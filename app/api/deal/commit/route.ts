import { z } from 'zod';
import { requirePermission } from '@/lib/auth/session';
import { handleRouteError, json, rateLimit } from '@/lib/api';
import { advanceDeal, addMilestone, commitBuyer, commitProvider, completeMilestone } from '@/lib/deal/commit';
import { audit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/**
 * Commitment and delivery.
 *
 * Every action here requires a basis and evidence. Marking a deal won, or
 * delivered, by choosing a value from a dropdown is precisely the shortcut this
 * layer exists to prevent — the numbers that come out of it are the ones the
 * business is eventually run on.
 */
const CommitBuyer = z.object({
  action: z.literal('commit_buyer'),
  quoteId: z.string().min(1),
  basis: z.enum(['VERBAL', 'EMAIL', 'PURCHASE_ORDER', 'SIGNED_CONTRACT']),
  evidence: z.string().min(1).max(4000),
  buyerContactId: z.string().optional(),
  contractedValue: z.number().min(0).optional(),
});

const CommitProvider = z.object({
  action: z.literal('commit_provider'),
  dealId: z.string().min(1),
  providerCandidateId: z.string().min(1),
  basis: z.enum(['VERBAL', 'EMAIL', 'PURCHASE_ORDER', 'SIGNED_CONTRACT']),
  evidence: z.string().min(1).max(4000),
  contractedCost: z.number().min(0).optional(),
});

const Advance = z.object({
  action: z.literal('advance'),
  dealId: z.string().min(1),
  to: z.enum(['IN_DELIVERY', 'DELIVERED', 'INVOICED', 'PAID', 'CLOSED', 'CANCELLED', 'DISPUTED', 'LOST']),
  reason: z.string().min(1).max(2000),
  completionEvidence: z.string().max(4000).optional(),
  responsibility: z.enum(['ours', 'provider', 'buyer', 'external']).optional(),
});

const Milestone = z.object({
  action: z.literal('milestone'),
  dealId: z.string().min(1),
  label: z.string().min(1).max(300),
  dueAt: z.string().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
});

const CompleteMilestone = z.object({
  action: z.literal('complete_milestone'),
  milestoneId: z.string().min(1),
  evidence: z.string().min(1).max(4000),
});

const Schema = z.discriminatedUnion('action', [CommitBuyer, CommitProvider, Advance, Milestone, CompleteMilestone]);

export async function POST(request: Request) {
  try {
    const user = await requirePermission('deal.write');
    await rateLimit(`deal.commit:${user.id}`, 60, 60_000);
    const body = Schema.parse(await request.json());

    if (body.action === 'commit_buyer') {
      const result = await commitBuyer({
        orgId: user.orgId,
        quoteId: body.quoteId,
        basis: body.basis,
        evidence: body.evidence,
        buyerContactId: body.buyerContactId,
        contractedValue: body.contractedValue,
        actorId: user.id,
      });
      if (!result.ok) {
        return json({ error: result.message, kind: result.kind, detail: result.detail }, result.kind === 'not_found' ? 404 : 409);
      }
      await audit({
        orgId: user.orgId, userId: user.id, action: 'deal.buyer_committed',
        entityType: 'RouteDeal', entityId: result.deal.id, metadata: { basis: body.basis },
      });
      return json({ ok: true, deal: result.deal });
    }

    if (body.action === 'commit_provider') {
      const result = await commitProvider({
        orgId: user.orgId,
        dealId: body.dealId,
        providerCandidateId: body.providerCandidateId,
        basis: body.basis,
        evidence: body.evidence,
        contractedCost: body.contractedCost,
        actorId: user.id,
      });
      if (!result.ok) return json({ error: result.message, kind: result.kind, detail: result.detail }, 409);
      await audit({
        orgId: user.orgId, userId: user.id, action: 'deal.provider_committed',
        entityType: 'RouteDeal', entityId: result.deal.id,
      });
      return json({ ok: true, deal: result.deal });
    }

    if (body.action === 'advance') {
      const result = await advanceDeal({
        orgId: user.orgId,
        dealId: body.dealId,
        to: body.to,
        reason: body.reason,
        completionEvidence: body.completionEvidence,
        responsibility: body.responsibility,
        actorId: user.id,
      });
      if (!result.ok) return json({ error: result.message, kind: result.kind, detail: result.detail }, 409);
      await audit({
        orgId: user.orgId, userId: user.id, action: `deal.${body.to.toLowerCase()}`,
        entityType: 'RouteDeal', entityId: result.deal.id,
      });
      return json({ ok: true, deal: result.deal });
    }

    if (body.action === 'milestone') {
      const created = await addMilestone({
        orgId: user.orgId,
        dealId: body.dealId,
        label: body.label,
        dueAt: body.dueAt ? new Date(body.dueAt) : null,
        sortOrder: body.sortOrder,
        actorId: user.id,
      });
      if (!created) return json({ error: 'That deal is not on this account.' }, 404);
      return json({ ok: true, milestone: created });
    }

    const done = await completeMilestone({
      orgId: user.orgId,
      milestoneId: body.milestoneId,
      evidence: body.evidence,
      actorId: user.id,
    });
    if (!done.ok) return json({ error: done.message }, 409);
    return json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
