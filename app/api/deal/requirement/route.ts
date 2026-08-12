import { z } from 'zod';
import { requirePermission } from '@/lib/auth/session';
import { handleRouteError, json, rateLimit } from '@/lib/api';
import { captureRequirement, withdrawRequirement } from '@/lib/deal/requirement';
import { audit } from '@/lib/audit';
import { capabilityGate } from '@/lib/manager/gate';

export const dynamic = 'force-dynamic';

/**
 * Owner-side edits to a buyer requirement.
 *
 * Callers do not use this — their requirement is captured automatically from
 * the call they just saved. This is for the owner correcting or completing a
 * requirement afterwards, and it goes through exactly the same versioning path,
 * so an owner edit to a priced requirement produces a new version like anybody
 * else's would.
 */
const Capture = z.object({
  action: z.literal('capture'),
  routeId: z.string().min(1),
  summary: z.string().min(1).max(2000).optional(),
  specification: z.string().max(4000).optional(),
  quantity: z.string().max(200).optional(),
  unit: z.string().max(60).optional(),
  frequency: z.string().max(200).optional(),
  locationCount: z.number().int().min(0).max(100_000).optional(),
  locations: z.string().max(1000).optional(),
  startsAt: z.string().optional(),
  decisionBy: z.string().optional(),
  timingNote: z.string().max(500).optional(),
  processNotes: z.string().max(4000).optional(),
  constraints: z.array(z.string().max(500)).max(30).optional(),
  incumbent: z.string().max(300).optional(),
  incumbentNotes: z.string().max(2000).optional(),
  decisionMakerContactId: z.string().optional(),
  decisionMakerRole: z.string().max(200).optional(),
  authorityConfirmed: z.boolean().optional(),
  budgetMechanism: z.enum(['UNKNOWN', 'NO_BUDGET', 'BUDGET_STATED', 'QUOTE_REQUESTED', 'FORMAL_BID', 'RENEWAL_CYCLE']).optional(),
  budgetAmount: z.number().min(0).optional(),
  budgetBasis: z.string().max(1000).optional(),
  /**
   * Which of the above the buyer actually said. Everything omitted is recorded
   * as ours, and a later capture that does say it will be allowed to replace it.
   */
  confirmed: z.array(z.string().max(60)).max(40).default([]),
});

const Withdraw = z.object({
  action: z.literal('withdraw'),
  routeId: z.string().min(1),
  reason: z.string().min(1).max(2000),
});

const Schema = z.discriminatedUnion('action', [Capture, Withdraw]);

export async function POST(request: Request) {
  try {
    const user = await requirePermission('deal.write');
    await rateLimit(`deal.requirement:${user.id}`, 120, 60_000);

    const gate = await capabilityGate({
      orgId: user.orgId, userId: user.id, capability: 'REQUIREMENT_CAPTURE',
    });
    if (!gate.allowed) {
      return json({ error: gate.message, kind: gate.kind, restorationRule: gate.restorationRule }, 423);
    }

    const body = Schema.parse(await request.json());

    if (body.action === 'withdraw') {
      const withdrawn = await withdrawRequirement({
        orgId: user.orgId,
        routeId: body.routeId,
        reason: body.reason,
        actorId: user.id,
      });
      if (!withdrawn) return json({ error: 'There is no current requirement on that route.' }, 404);
      await audit({
        orgId: user.orgId, userId: user.id, action: 'deal.requirement.withdrawn',
        entityType: 'BuyerRequirement', entityId: withdrawn.id,
      });
      return json({ ok: true, requirement: withdrawn });
    }

    const { action, routeId, confirmed, startsAt, decisionBy, ...rest } = body;
    void action;

    const result = await captureRequirement({
      orgId: user.orgId,
      routeId,
      input: {
        ...rest,
        startsAt: startsAt ? new Date(startsAt) : undefined,
        decisionBy: decisionBy ? new Date(decisionBy) : undefined,
        confirmed,
      },
      actorId: user.id,
      capturedBy: 'owner',
      evidence: 'Entered by the owner.',
    });

    await audit({
      orgId: user.orgId, userId: user.id, action: `deal.requirement.${result.action}`,
      entityType: 'BuyerRequirement', entityId: result.requirement.id,
    });

    return json({
      ok: true,
      action: result.action,
      requirement: result.requirement,
      // Surfaced rather than swallowed: an operator whose edit was refused
      // because the buyer's own words already sat in that field needs to know,
      // or they will keep retyping it and assume the system is broken.
      declinedOverwrites: result.declinedOverwrites,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
