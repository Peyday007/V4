import { z } from 'zod';
import { requirePermission, requireUser } from '@/lib/auth/session';
import { handleRouteError, json, rateLimit } from '@/lib/api';
import { createRoom, markSent, expireRooms } from '@/lib/room/rooms';
import { sendRoomEmail } from '@/lib/room/email';
import { capabilityGate } from '@/lib/manager/gate';
import { audit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/**
 * The owner's side of a Deal Room.
 *
 * Creating one needs `deal.write`; putting it in front of a prospect is an
 * external act and needs `document.send`, the same permission that gates
 * sending a quote. Authentication happens before the body is parsed, so an
 * anonymous request cannot learn that this route exists by the shape of its
 * validation error.
 */
const Create = z.object({
  action: z.literal('create'),
  routeId: z.string().min(1),
  lifetimeDays: z.number().int().min(1).max(180).optional(),
  /** Deliberately override a thin-content refusal. Recorded on the room. */
  force: z.boolean().optional(),
});

const Send = z.object({
  action: z.literal('send'),
  roomId: z.string().min(1),
  contactId: z.string().min(1),
  channel: z.string().min(1).max(60),
  /** When true the email is actually sent; otherwise only the link is marked out. */
  deliver: z.boolean().optional(),
});

const Expire = z.object({
  action: z.literal('expire'),
});

const Schema = z.discriminatedUnion('action', [Create, Send, Expire]);

export async function POST(request: Request) {
  try {
    await requireUser();
    const body = Schema.parse(await request.json());

    const user = body.action === 'send'
      ? await requirePermission('document.send')
      : await requirePermission('deal.write');
    await rateLimit(`deal.room:${user.id}`, 60, 60_000);

    // Only the outward act is gated. Somebody restricted from sending rooms can
    // still build one and have it reviewed, which is usually the point of the
    // restriction rather than an oversight in it.
    if (body.action === 'send') {
      const gate = await capabilityGate({
        orgId: user.orgId, userId: user.id, capability: 'DEAL_ROOM_SENDING',
      });
      if (!gate.allowed) {
        return json({ error: gate.message, kind: gate.kind, restorationRule: gate.restorationRule }, 423);
      }
    }

    if (body.action === 'create') {
      const result = await createRoom({
        orgId: user.orgId,
        routeId: body.routeId,
        lifetimeDays: body.lifetimeDays,
        force: body.force,
        actorId: user.id,
      });
      if (!result.ok) {
        return json(
          { error: result.message, kind: result.kind, detail: result.detail },
          result.kind === 'not_found' ? 404 : 409,
        );
      }
      await audit({
        orgId: user.orgId, userId: user.id, action: 'room.created',
        entityType: 'DealRoom', entityId: result.room.id,
        metadata: { proofStep: result.room.proofStep, forced: Boolean(body.force) },
      });
      // The token is returned once, to the person who created it. It is not
      // logged, not audited, and not included in any list endpoint.
      return json({ ok: true, roomId: result.room.id, token: result.room.token, proofStep: result.room.proofStep });
    }

    if (body.action === 'send') {
      const result = await markSent({
        orgId: user.orgId,
        roomId: body.roomId,
        contactId: body.contactId,
        channel: body.channel,
        actorId: user.id,
      });
      if (!result.ok) {
        return json(
          { error: result.message, kind: result.kind, detail: result.detail },
          result.kind === 'not_found' ? 404 : 409,
        );
      }

      // Actually putting it in a mailbox is a separate, explicit step. Marking
      // a room sent because somebody read it out over the phone is legitimate,
      // and must not silently email anybody.
      let delivery: { sent: boolean; reason?: string } = { sent: false, reason: 'Marked sent without emailing.' };
      if (body.deliver) {
        delivery = await sendRoomEmail({
          orgId: user.orgId,
          roomId: result.room.id,
          contactId: body.contactId,
          senderId: user.id,
        });
      }

      await audit({
        orgId: user.orgId, userId: user.id, action: 'room.sent',
        entityType: 'DealRoom', entityId: result.room.id,
        metadata: { channel: body.channel, emailed: delivery.sent },
      });
      return json({ ok: true, roomId: result.room.id, delivery });
    }

    const expired = await expireRooms({ orgId: user.orgId });
    return json({ ok: true, expired });
  } catch (error) {
    return handleRouteError(error);
  }
}
