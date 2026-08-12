import { z } from 'zod';
import { requirePermission, requireUser } from '@/lib/auth/session';
import { handleRouteError, json, rateLimit } from '@/lib/api';
import { draftQuote, sendQuote, declineQuote } from '@/lib/deal/quote';
import { capabilityGate } from '@/lib/manager/gate';
import { audit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/**
 * Pricing.
 *
 * Sending is a separate permission from drafting. Anybody who can work a deal
 * can put a price together; putting one in front of a buyer is an external act
 * with the same weight as sending a document, and it is gated the same way.
 */
const Draft = z.object({
  action: z.literal('draft'),
  routeId: z.string().min(1),
  providerCandidateId: z.string().optional(),
  providerCost: z.number().min(0).optional(),
  freight: z.number().min(0).optional(),
  fees: z.number().min(0).optional(),
  contingency: z.number().min(0).optional(),
  buyerPrice: z.number().min(0).optional(),
  currency: z.string().length(3).optional(),
  paymentTerms: z.string().max(200).optional(),
  deliveryTerms: z.string().max(500).optional(),
  downsideNotes: z.string().max(4000).optional(),
  assumptions: z.array(z.string().max(500)).max(30).optional(),
  validUntil: z.string().optional(),
  workingCapitalAmount: z.number().min(0).optional(),
  workingCapitalDays: z.number().int().min(0).max(3650).optional(),
  deliveryDays: z.number().int().min(0).max(3650).optional(),
  reason: z.string().max(1000).optional(),
});

const Send = z.object({
  action: z.literal('send'),
  quoteId: z.string().min(1),
  channel: z.string().min(1).max(200),
});

const Decline = z.object({
  action: z.literal('decline'),
  quoteId: z.string().min(1),
  reason: z.string().min(1).max(2000),
  negotiationNote: z.string().max(4000).optional(),
});

const Schema = z.discriminatedUnion('action', [Draft, Send, Decline]);

export async function POST(request: Request) {
  try {
    // Authenticated before the body is read, not after. Which permission this
    // needs depends on the action, so the action has to be parsed first — but
    // parsing first would answer an anonymous request with a validation error,
    // which tells a stranger the route exists and processes what they send it.
    // A session is established here; the specific permission is checked below.
    await requireUser();
    const body = Schema.parse(await request.json());

    // Sending needs the external-send permission; the rest needs deal.write.
    const user = body.action === 'send'
      ? await requirePermission('document.send')
      : await requirePermission('deal.write');
    await rateLimit(`deal.quote:${user.id}`, 60, 60_000);

    // A permission says what this role may do; the gate says what this person
    // may do today. They are different questions, and a restriction that only
    // showed up on a manager's screen would not be a restriction at all.
    //
    // Scoped to drafting. Declining a quote is how a mistake gets withdrawn,
    // and a restriction that stopped somebody undoing their own bad price would
    // leave the price in front of the buyer.
    if (body.action === 'draft') {
      const gate = await capabilityGate({
        orgId: user.orgId, userId: user.id, capability: 'QUOTE_DRAFTING',
      });
      if (!gate.allowed) {
        return json({ error: gate.message, kind: gate.kind, restorationRule: gate.restorationRule }, 423);
      }
    }

    if (body.action === 'draft') {
      const { action, routeId, validUntil, reason, ...inputs } = body;
      void action;
      const result = await draftQuote({
        orgId: user.orgId,
        routeId,
        inputs: { ...inputs, validUntil: validUntil ? new Date(validUntil) : undefined },
        actorId: user.id,
        reason,
      });
      if (!result.ok) {
        return json({ error: result.message, kind: result.kind, detail: result.detail }, result.kind === 'not_found' ? 404 : 409);
      }
      await audit({
        orgId: user.orgId, userId: user.id, action: 'deal.quote.drafted',
        entityType: 'RouteQuote', entityId: result.quote.id,
      });
      return json({
        ok: true,
        quote: result.quote,
        economics: result.economics,
        approvalsOpened: result.approvalsOpened,
      });
    }

    if (body.action === 'send') {
      const result = await sendQuote({
        orgId: user.orgId, quoteId: body.quoteId, channel: body.channel, actorId: user.id,
      });
      if (!result.ok) {
        return json({ error: result.message, kind: result.kind, detail: result.detail }, result.kind === 'not_found' ? 404 : 409);
      }
      await audit({
        orgId: user.orgId, userId: user.id, action: 'deal.quote.sent',
        entityType: 'RouteQuote', entityId: result.quote.id, metadata: { channel: body.channel },
      });
      return json({ ok: true, quote: result.quote });
    }

    const result = await declineQuote({
      orgId: user.orgId,
      quoteId: body.quoteId,
      reason: body.reason,
      negotiationNote: body.negotiationNote,
      actorId: user.id,
    });
    if (!result.ok) {
      return json({ error: result.message, kind: result.kind, detail: result.detail }, result.kind === 'not_found' ? 404 : 409);
    }
    await audit({
      orgId: user.orgId, userId: user.id, action: 'deal.quote.declined',
      entityType: 'RouteQuote', entityId: result.quote.id,
    });
    return json({ ok: true, quote: result.quote });
  } catch (error) {
    return handleRouteError(error);
  }
}
