import { randomBytes, createHash } from 'node:crypto';
import type { DealRoom, Prisma, RoomEventKind, RoomState } from '@prisma/client';
import { prisma } from '@/lib/db';
import { recordDealEvent, newCorrelationId } from '@/lib/deal/events';
import { buildRoomContent, type RoomContent } from './content';
import { recordRoomOutcome } from '@/lib/measure/funnel';

/**
 * Creating, sending and tracking a Deal Room.
 *
 * The engagement ladder is append-only and idempotent. Both properties are
 * doing real work:
 *
 *   Append-only, because "they opened it twice on Tuesday" is a fact about the
 *   prospect and a status field would overwrite it with the latest thing.
 *
 *   Idempotent, because a page open is not a deliberate act by anybody. Mail
 *   clients prefetch links, security scanners follow them, and a prospect who
 *   refreshes three times has not become three times more interested. Without
 *   a dedupe key the engagement numbers are a measure of email infrastructure.
 *
 * The token is 32 bytes from a CSPRNG and is never derived from anything about
 * the prospect. The database refuses anything shorter, so a fixture cannot
 * quietly weaken it.
 */

const TOKEN_BYTES = 32;
const DEFAULT_LIFETIME_DAYS = 30;

/** States in which a room is still live, mirroring the partial unique index. */
export const LIVE_ROOM_STATES: RoomState[] = ['DRAFT', 'SENT', 'DELIVERED', 'OPENED', 'RESPONDED'];

export type RoomRefusal = {
  ok: false;
  kind: 'not_found' | 'too_thin' | 'already_live' | 'not_sendable' | 'no_contact' | 'expired';
  message: string;
  detail: string[];
};

export type RoomSuccess = { ok: true; room: DealRoom; content: RoomContent };
export type RoomResult = RoomSuccess | RoomRefusal;

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

export async function createRoom(options: {
  orgId: string;
  routeId: string;
  actorId?: string | null;
  lifetimeDays?: number;
  /** Send a room the builder considers too thin. Deliberate, recorded, rare. */
  force?: boolean;
  now?: Date;
}): Promise<RoomResult> {
  const now = options.now ?? new Date();

  const content = await buildRoomContent({ orgId: options.orgId, routeId: options.routeId });
  if (!content) {
    return { ok: false, kind: 'not_found', message: 'That route is not on this account.', detail: [] };
  }

  if (content.tooThinToSend && !options.force) {
    return {
      ok: false,
      kind: 'too_thin',
      message: 'There is not enough real material to put in front of this prospect yet.',
      detail: content.thinReasons,
    };
  }

  const existing = await prisma.dealRoom.findFirst({
    where: { routeId: options.routeId, state: { in: LIVE_ROOM_STATES } },
  });
  if (existing) {
    return {
      ok: false,
      kind: 'already_live',
      message: 'This route already has a live room.',
      detail: ['Two live links for one prospect is two different stories arriving in the same inbox. Expire the current one first.'],
    };
  }

  const requirement = await prisma.buyerRequirement.findFirst({
    where: { routeId: options.routeId, state: 'CURRENT' },
    select: { id: true },
  });
  const quote = await prisma.routeQuote.findFirst({
    where: { routeId: options.routeId, state: { in: ['SENT', 'ACCEPTED'] } },
    orderBy: { version: 'desc' },
    select: { id: true },
  });

  const expiresAt = new Date(now.getTime() + (options.lifetimeDays ?? DEFAULT_LIFETIME_DAYS) * 86_400_000);

  const room = await prisma.$transaction(async (tx) => {
    const created = await tx.dealRoom.create({
      data: {
        orgId: options.orgId,
        routeId: options.routeId,
        token: newToken(),
        state: 'DRAFT',
        // Snapshotted, not rendered live. A prospect who opens the link three
        // weeks later sees what we sent them, not what the engine believes
        // today — otherwise the page rewrites itself behind their back and a
        // conversation about what it said becomes unwinnable.
        content: content as unknown as Prisma.InputJsonValue,
        requirementId: requirement?.id ?? null,
        quoteId: quote?.id ?? null,
        proofStep: content.proofStep.kind,
        proofStepReason: content.proofStepReason,
        expiresAt,
        createdById: options.actorId ?? null,
      },
    });

    await tx.dealRoomEvent.create({
      data: {
        orgId: options.orgId,
        roomId: created.id,
        kind: 'CREATED',
        dedupeKey: 'created',
        detail: content.tooThinToSend ? 'Created over a thin-content warning.' : null,
      },
    });

    await recordDealEvent(tx, {
      orgId: options.orgId,
      routeId: options.routeId,
      kind: 'room.created',
      actorId: options.actorId,
      subjectType: 'RouteQuote',
      subjectId: created.id,
      summary: `Deal room created, offering: ${content.proofStep.kind.toLowerCase().replace(/_/g, ' ')}.`,
      after: { proofStep: content.proofStep.kind, expiresAt: expiresAt.toISOString() },
      correlationId: newCorrelationId(),
    });

    return created;
  });

  return { ok: true, room, content };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export async function markSent(options: {
  orgId: string;
  roomId: string;
  contactId: string;
  channel: string;
  actorId?: string | null;
  now?: Date;
}): Promise<RoomResult> {
  const now = options.now ?? new Date();
  const room = await prisma.dealRoom.findFirst({ where: { id: options.roomId, orgId: options.orgId } });
  if (!room) return { ok: false, kind: 'not_found', message: 'That room is not on this account.', detail: [] };
  if (room.state !== 'DRAFT') {
    return {
      ok: false,
      kind: 'not_sendable',
      message: `This room is already ${room.state.toLowerCase()}.`,
      detail: [],
    };
  }

  const contact = await prisma.contact.findFirst({
    where: { id: options.contactId, orgId: options.orgId },
    select: { id: true },
  });
  if (!contact) {
    return { ok: false, kind: 'no_contact', message: 'That contact is not on this account.', detail: [] };
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.dealRoom.update({
      where: { id: room.id },
      data: { state: 'SENT', sentAt: now, contactId: options.contactId, channel: options.channel },
    });
    await tx.dealRoomEvent.create({
      data: { orgId: options.orgId, roomId: room.id, kind: 'SENT', dedupeKey: 'sent', detail: options.channel },
    });
    await recordDealEvent(tx, {
      orgId: options.orgId,
      routeId: room.routeId,
      kind: 'room.sent',
      actorId: options.actorId,
      subjectType: 'RouteQuote',
      subjectId: room.id,
      summary: `Deal room sent via ${options.channel}.`,
      before: { state: 'DRAFT' },
      after: { state: 'SENT' },
      evidence: options.channel,
    });
    return row;
  });

  return { ok: true, room: updated, content: room.content as unknown as RoomContent };
}

/** The channel confirmed delivery. Distinct from sent, because not every channel can. */
export async function markDelivered(options: { orgId: string; roomId: string; now?: Date }): Promise<void> {
  const now = options.now ?? new Date();
  await prisma.$transaction(async (tx) => {
    const room = await tx.dealRoom.findFirst({ where: { id: options.roomId, orgId: options.orgId } });
    if (!room || room.deliveredAt) return;
    await tx.dealRoom.update({
      where: { id: room.id },
      // Only DRAFT and SENT step up to DELIVERED. A room already opened must
      // not be walked backwards by a delivery receipt that arrived late.
      data: { deliveredAt: now, state: room.state === 'SENT' ? 'DELIVERED' : room.state },
    });
    await tx.dealRoomEvent.create({
      data: { orgId: options.orgId, roomId: room.id, kind: 'DELIVERED', dedupeKey: 'delivered' },
    });
  });
}

// ---------------------------------------------------------------------------
// Reading, as the prospect
// ---------------------------------------------------------------------------

export type RoomView = {
  content: RoomContent;
  /** Whether the link still works. */
  live: boolean;
  /** Said to the prospect when it does not, without blaming them. */
  closedReason: string | null;
  /** Set only for the owner preview. The public page never sees an id. */
  roomId: string | null;
  state: RoomState;
  proofStepAlreadyRequested: boolean;
};

/**
 * Look up a room by its token, and record the open.
 *
 * `preview: true` is the admin path. It reads the same snapshot through the
 * same function and writes nothing, because an owner checking their own work
 * must not show up in the engagement history as the prospect reading it.
 */
export async function openRoom(options: {
  token: string;
  preview?: boolean;
  /** Coarse class only. Enough to tell a prefetch from a person. */
  userAgent?: string | null;
  now?: Date;
}): Promise<RoomView | null> {
  const now = options.now ?? new Date();

  // Looked up by token alone, with no org filter: the token *is* the
  // authorisation. Nothing about the response varies by who asks, so a wrong
  // or expired token is indistinguishable from one that never existed.
  const room = await prisma.dealRoom.findUnique({
    where: { token: options.token },
    include: { events: { where: { kind: 'PROOF_STEP_REQUESTED' }, take: 1 } },
  });
  if (!room) return null;

  const expired = room.expiresAt.getTime() <= now.getTime();
  const closed = expired || room.state === 'EXPIRED' || room.state === 'DECLINED';

  if (!options.preview && !closed) {
    await recordOpen(room.id, room.orgId, options.userAgent ?? null, now);
  }

  return {
    content: room.content as unknown as RoomContent,
    live: !closed,
    closedReason: closed
      ? (room.state === 'DECLINED'
          ? 'This page has been closed at your request.'
          : 'This link has expired. If you would still like the information, reply to the message it came in and we will send a current one.')
      : null,
    roomId: options.preview ? room.id : null,
    state: room.state,
    proofStepAlreadyRequested: room.events.length > 0,
  };
}

/**
 * One open per prospect per day, not one per HTTP request.
 *
 * The day bucket is the dedupe key. A prospect who reads it, forwards it to a
 * colleague and comes back after lunch has engaged once that day as far as any
 * decision we make from this is concerned, and the alternative — counting
 * requests — measures their mail client rather than them.
 */
async function recordOpen(roomId: string, orgId: string, userAgent: string | null, now: Date): Promise<void> {
  const agentClass = classifyAgent(userAgent);

  // A prefetch is recorded, and recorded as a prefetch. Dropping it would lose
  // the fact that the message reached a real mailbox; counting it as a read
  // would invent interest nobody expressed.
  const dedupeKey = `${now.toISOString().slice(0, 10)}:${agentClass}`;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.dealRoomEvent.create({
        data: { orgId, roomId, kind: 'OPENED', dedupeKey, userAgentClass: agentClass },
      });

      // Only a human open moves the state and the counter. An automated fetch
      // is history, not engagement.
      if (agentClass === 'human') {
        const room = await tx.dealRoom.findUniqueOrThrow({ where: { id: roomId } });
        await tx.dealRoom.update({
          where: { id: roomId },
          data: {
            firstOpenAt: room.firstOpenAt ?? now,
            lastOpenAt: now,
            openCount: { increment: 1 },
            state: room.state === 'SENT' || room.state === 'DELIVERED' || room.state === 'DRAFT'
              ? 'OPENED'
              : room.state,
          },
        });
        await recordDealEvent(tx, {
          orgId,
          routeId: room.routeId,
          kind: 'room.opened',
          actorType: 'system',
          subjectType: 'RouteQuote',
          subjectId: roomId,
          summary: room.firstOpenAt ? 'Deal room opened again.' : 'Deal room opened for the first time.',
          after: { openedAt: now.toISOString() },
        });
      }
    });
  } catch (error) {
    // The unique index on (room, kind, dedupeKey) is the idempotency: a repeat
    // open in the same bucket collides and is dropped. Swallowed on purpose —
    // failing to record a duplicate must never fail the page for the prospect.
    if (!isUniqueViolation(error)) throw error;
  }
}

/**
 * Coarse, and deliberately not identifying.
 *
 * Enough to tell a link prefetcher from a person, and nothing that could be
 * used to track anybody. No IP, no fingerprint, no full user-agent string.
 */
export function classifyAgent(userAgent: string | null): string {
  if (!userAgent) return 'unknown';
  const ua = userAgent.toLowerCase();
  if (/bot|crawler|spider|preview|scan|monitor|curl|wget|python-requests|okhttp|headless/.test(ua)) {
    return 'automated';
  }
  if (/slackbot|whatsapp|discord|telegram|facebookexternalhit|twitterbot|linkedinbot|skypeuripreview/.test(ua)) {
    return 'automated';
  }
  if (/mozilla|safari|chrome|firefox|edge/.test(ua)) return 'human';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// What the prospect does next
// ---------------------------------------------------------------------------

export type ProspectAction = 'RESPONDED' | 'INFORMATION_SUPPLIED' | 'NEXT_STEP_REQUESTED' | 'QUOTE_REQUESTED' | 'PROOF_STEP_REQUESTED' | 'DECLINED';

/**
 * Record something the prospect did, exactly once.
 *
 * Idempotent per action per room: a double-clicked button, a retried request
 * or a back-and-forward through the page produces one request for a price, not
 * three. The first one wins and later ones are accepted silently, because
 * telling a prospect "you already did that" is a worse experience than the
 * duplicate would have been.
 */
export async function recordProspectAction(options: {
  token: string;
  action: ProspectAction;
  note?: string | null;
  now?: Date;
}): Promise<{ ok: boolean; alreadyRecorded: boolean; message: string }> {
  const now = options.now ?? new Date();

  const room = await prisma.dealRoom.findUnique({ where: { token: options.token } });
  if (!room) return { ok: false, alreadyRecorded: false, message: 'This link is no longer valid.' };
  if (room.expiresAt.getTime() <= now.getTime() || room.state === 'EXPIRED') {
    return { ok: false, alreadyRecorded: false, message: 'This link has expired.' };
  }

  const note = options.note?.trim().slice(0, 4000) || null;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.dealRoomEvent.create({
        data: {
          orgId: room.orgId,
          roomId: room.id,
          kind: options.action as RoomEventKind,
          // One per action, for the life of the room.
          dedupeKey: options.action.toLowerCase(),
          detail: note,
        },
      });

      await tx.dealRoom.update({
        where: { id: room.id },
        data: {
          state: options.action === 'DECLINED' ? 'DECLINED' : 'RESPONDED',
          respondedAt: room.respondedAt ?? now,
          declinedAt: options.action === 'DECLINED' ? now : room.declinedAt,
          responseNote: note ?? room.responseNote,
        },
      });

      await recordDealEvent(tx, {
        orgId: room.orgId,
        routeId: room.routeId,
        kind: `room.${options.action.toLowerCase()}`,
        actorType: 'system',
        subjectType: 'RouteQuote',
        subjectId: room.id,
        summary: prospectSummary(options.action, note),
        after: { action: options.action },
        // Their words, kept as evidence rather than paraphrased into a status.
        evidence: note,
        confidence: 'stated_by_buyer',
        correlationId: newCorrelationId(),
      });
    });

    // A deliberate act by the prospect is a funnel rung. Recorded only on the
    // first one: the dedupe above means a second click never reaches here, so
    // the funnel counts prospects rather than button presses.
    await recordRoomOutcome({ routeId: room.routeId, action: options.action, occurredAt: now });

    return { ok: true, alreadyRecorded: false, message: acknowledgement(options.action) };
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Already recorded. The prospect gets the same acknowledgement they got
      // the first time; nothing about the duplicate is their problem.
      return { ok: true, alreadyRecorded: true, message: acknowledgement(options.action) };
    }
    throw error;
  }
}

/**
 * Close rooms whose date has passed.
 *
 * Run from the scheduler. A room that has expired in the database but still
 * renders is the worst of both: the prospect sees a live page and the owner
 * sees a dead one.
 */
export async function expireRooms(options: { orgId: string; now?: Date }): Promise<number> {
  const now = options.now ?? new Date();
  const stale = await prisma.dealRoom.findMany({
    where: { orgId: options.orgId, state: { in: LIVE_ROOM_STATES }, expiresAt: { lte: now } },
    select: { id: true, routeId: true },
  });

  for (const room of stale) {
    await prisma.$transaction(async (tx) => {
      await tx.dealRoom.update({ where: { id: room.id }, data: { state: 'EXPIRED' } });
      await tx.dealRoomEvent.create({
        data: { orgId: options.orgId, roomId: room.id, kind: 'EXPIRED', dedupeKey: 'expired' },
      });
      await recordDealEvent(tx, {
        orgId: options.orgId,
        routeId: room.routeId,
        kind: 'room.expired',
        actorType: 'system',
        subjectType: 'RouteQuote',
        subjectId: room.id,
        summary: 'Deal room reached its expiry date and stopped serving.',
        after: { state: 'EXPIRED' },
      });
    });
  }

  return stale.length;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * 32 bytes from a CSPRNG, base64url.
 *
 * Never derived from the company, the route or the date. A token anybody can
 * guess from what they already know is a public page with extra steps.
 */
export function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Compared in constant time nowhere, because equality here is a database index lookup. */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}

function prospectSummary(action: ProspectAction, note: string | null): string {
  const base: Record<ProspectAction, string> = {
    RESPONDED: 'The prospect replied through the room.',
    INFORMATION_SUPPLIED: 'The prospect supplied information through the room.',
    NEXT_STEP_REQUESTED: 'The prospect asked to arrange the next step.',
    QUOTE_REQUESTED: 'The prospect asked for a price.',
    PROOF_STEP_REQUESTED: 'The prospect accepted the proposed first step.',
    DECLINED: 'The prospect declined.',
  };
  return note ? `${base[action]} “${note.slice(0, 200)}”` : base[action];
}

function acknowledgement(action: ProspectAction): string {
  switch (action) {
    case 'DECLINED':
      return 'Understood — we will not follow up on this. Thank you for telling us.';
    case 'QUOTE_REQUESTED':
      return 'Thank you. We will come back with a price, and with the questions we need answered to make it a real one.';
    case 'PROOF_STEP_REQUESTED':
      return 'Thank you. Somebody will be in touch to arrange it.';
    case 'INFORMATION_SUPPLIED':
      return 'Thank you — that is exactly what we needed.';
    default:
      return 'Thank you. We have this and somebody will come back to you.';
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'P2002';
}
