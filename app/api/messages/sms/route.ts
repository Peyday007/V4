import { z } from 'zod';
import { requirePermission } from '@/lib/auth/session';
import { checkSmsAllowed, recordInboundSms, sendSms } from '@/lib/messaging';
import { handleRouteError, json, rateLimit } from '@/lib/api';

export const dynamic = 'force-dynamic';

const sendSchema = z.object({
  contactId: z.string().min(1),
  body: z.string().min(1).max(1600),
  purpose: z.enum([
    'BUYER_QUALIFICATION', 'PRIME_QUALIFICATION', 'SUBCONTRACTOR_RECRUITMENT', 'SUPPLIER_QUALIFICATION',
    'AVAILABILITY_CONFIRMATION', 'PRICING_REQUEST', 'QUOTE_FOLLOW_UP', 'TRIAL_ORDER_REQUEST',
    'BACKUP_PROVIDER_POSITIONING', 'NEGOTIATION_SUPPORT', 'EXPANSION_REQUEST', 'RELATIONSHIP_REACTIVATION',
    'FULFILLMENT_ISSUE',
  ]),
  opportunityId: z.string().optional(),
  /** Runs the compliance gate and reports back without sending. */
  dryRun: z.boolean().default(false),
});

export async function POST(request: Request) {
  try {
    const user = await requirePermission('document.send');
    if (!rateLimit(`sms:${user.orgId}`, 120, 60_000)) {
      return json({ error: 'SMS rate limit reached' }, 429);
    }
    const body = sendSchema.parse(await request.json());

    if (body.dryRun) {
      return json(await checkSmsAllowed({ orgId: user.orgId, contactId: body.contactId }));
    }

    const result = await sendSms({
      orgId: user.orgId,
      contactId: body.contactId,
      body: body.body,
      purpose: body.purpose,
      opportunityId: body.opportunityId ?? null,
      senderId: user.id,
    });
    return json({ ok: true, ...result });
  } catch (error) {
    return handleRouteError(error);
  }
}

const inboundSchema = z.object({
  fromNumber: z.string().min(5),
  body: z.string().min(1).max(2000),
});

/**
 * Logs an inbound reply. A real provider posts here via webhook; until one is
 * connected this accepts an authenticated manual entry so the reply data —
 * which is what makes channel comparison meaningful — can still be captured.
 */
export async function PUT(request: Request) {
  try {
    const user = await requirePermission('document.send');
    const body = inboundSchema.parse(await request.json());
    const result = await recordInboundSms({ orgId: user.orgId, fromNumber: body.fromNumber, body: body.body });
    return json({ ok: true, ...result });
  } catch (error) {
    return handleRouteError(error);
  }
}
