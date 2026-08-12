import { z } from 'zod';
import { requirePermission } from '@/lib/auth/session';
import { handleRouteError, json, rateLimit } from '@/lib/api';
import { recordPayment, settlePayment, moneyFor } from '@/lib/deal/commit';
import { audit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/**
 * Money lines.
 *
 * `settledAt` is the only field here that turns a claim into money, and it is
 * deliberately not defaulted to now. Recording an invoice and recording a
 * payment are the same shape, and the difference between them has to be an
 * explicit act rather than a field somebody forgot to clear.
 */
const Record = z.object({
  action: z.literal('record'),
  dealId: z.string().min(1),
  direction: z.enum(['INBOUND', 'OUTBOUND']),
  kind: z.enum(['INVOICE', 'PAYMENT', 'REFUND', 'CHARGEBACK', 'WRITE_OFF']),
  amount: z.number().positive(),
  dueAt: z.string().optional(),
  settledAt: z.string().optional(),
  reference: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
});

const Settle = z.object({
  action: z.literal('settle'),
  paymentId: z.string().min(1),
  settledAt: z.string().optional(),
  reference: z.string().max(200).optional(),
});

const Schema = z.discriminatedUnion('action', [Record, Settle]);

export async function POST(request: Request) {
  try {
    const user = await requirePermission('deal.write');
    await rateLimit(`deal.payment:${user.id}`, 60, 60_000);
    const body = Schema.parse(await request.json());

    if (body.action === 'record') {
      const result = await recordPayment({
        orgId: user.orgId,
        dealId: body.dealId,
        direction: body.direction,
        kind: body.kind,
        amount: body.amount,
        dueAt: body.dueAt ? new Date(body.dueAt) : null,
        settledAt: body.settledAt ? new Date(body.settledAt) : null,
        reference: body.reference,
        notes: body.notes,
        actorId: user.id,
      });
      if (!result.ok) return json({ error: result.message }, 409);
      await audit({
        orgId: user.orgId, userId: user.id, action: 'deal.payment.recorded',
        entityType: 'DealPayment', entityId: result.id ?? null,
        metadata: { direction: body.direction, kind: body.kind, settled: Boolean(body.settledAt) },
      });
      return json({ ok: true, id: result.id, money: await moneyFor(body.dealId) });
    }

    const settled = await settlePayment({
      orgId: user.orgId,
      paymentId: body.paymentId,
      settledAt: body.settledAt ? new Date(body.settledAt) : undefined,
      reference: body.reference,
      actorId: user.id,
    });
    if (!settled.ok) return json({ error: settled.message }, 409);
    await audit({
      orgId: user.orgId, userId: user.id, action: 'deal.payment.settled',
      entityType: 'DealPayment', entityId: body.paymentId,
    });
    return json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
