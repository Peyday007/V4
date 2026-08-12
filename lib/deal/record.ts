import type {
  Approval, BuyerRequirement, DealMilestone, DealPayment, ProviderCandidate,
  RouteDeal, RouteQuote,
} from '@prisma/client';
import { prisma } from '@/lib/db';
import { priceability } from './requirement';
import { supplyPosture, costIsUsable, STATE_LABELS, STATE_MEANING, type SupplyPosture } from './provider';
import { moneyPosition, type MoneyPosition } from './commit';
import { BASIS_LABELS } from './economics';

/**
 * Everything about where one route's deal has got to, in one read.
 *
 * The shape is deliberately opinionated: each section carries not only its data
 * but the sentence that should be said about it. Left to a template, "candidate
 * found" and "committed" render the same way with different words, and the
 * difference between them is the entire subject of this phase.
 */

export type DealRecord = {
  routeId: string;
  requirement: {
    current: BuyerRequirement | null;
    /** Older versions, newest first. History is never rewritten. */
    history: BuyerRequirement[];
    /** Which fields the buyer actually stated, versus our inference. */
    confirmed: string[];
    ready: boolean;
    missing: string[];
    headline: string;
  };
  supply: SupplyPosture & {
    candidates: Array<ProviderCandidate & { providerName: string; costUsable: boolean; label: string; meaning: string }>;
  };
  quotes: {
    live: RouteQuote | null;
    history: RouteQuote[];
    basisLabel: string | null;
    /** Approvals blocking the live quote, if any. */
    blocking: Approval[];
    headline: string;
  };
  deal: {
    record: (RouteDeal & { milestones: DealMilestone[]; payments: DealPayment[] }) | null;
    money: MoneyPosition | null;
    /** Reads plainly so nothing infers revenue from a stage name. */
    headline: string;
  };
  /** The prospect-facing page, and what they did with it. */
  room: {
    exists: boolean;
    state: string | null;
    proofStep: string | null;
    openCount: number;
    sentAt: Date | null;
    firstOpenAt: Date | null;
    expiresAt: Date | null;
    responseNote: string | null;
    /** Engagement, newest first. The token is never included. */
    engagement: Array<{ kind: string; detail: string | null; occurredAt: Date; agent: string | null }>;
    headline: string;
  };
  /** The append-only trail, newest first. */
  events: Array<{ id: string; kind: string; summary: string; occurredAt: Date; actorType: string }>;
};

export async function loadDealRecord(params: { orgId: string; routeId: string }): Promise<DealRecord> {
  const [requirements, candidates, quotes, deal, events, room] = await Promise.all([
    prisma.buyerRequirement.findMany({
      where: { orgId: params.orgId, routeId: params.routeId },
      orderBy: { version: 'desc' },
    }),
    prisma.providerCandidate.findMany({
      where: { orgId: params.orgId, routeId: params.routeId },
      include: { provider: { select: { legalName: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.routeQuote.findMany({
      where: { orgId: params.orgId, routeId: params.routeId },
      orderBy: { version: 'desc' },
    }),
    prisma.routeDeal.findUnique({
      where: { routeId: params.routeId },
      include: { milestones: { orderBy: { sortOrder: 'asc' } }, payments: { orderBy: { createdAt: 'asc' } } },
    }),
    prisma.dealEvent.findMany({
      where: { orgId: params.orgId, routeId: params.routeId },
      orderBy: { occurredAt: 'desc' },
      take: 40,
      select: { id: true, kind: true, summary: true, occurredAt: true, actorType: true },
    }),
    // The token is deliberately not selected. It is returned once, to the
    // person who created the room, and never again from a read path — an
    // owner-facing page that carries it is one screenshot away from being a
    // public one.
    prisma.dealRoom.findFirst({
      where: { orgId: params.orgId, routeId: params.routeId },
      orderBy: { createdAt: 'desc' },
      select: {
        state: true, proofStep: true, openCount: true, sentAt: true, firstOpenAt: true,
        expiresAt: true, responseNote: true,
        events: {
          orderBy: { occurredAt: 'desc' },
          take: 20,
          select: { kind: true, detail: true, occurredAt: true, userAgentClass: true },
        },
      },
    }),
  ]);

  const current = requirements.find((r) => r.state === 'CURRENT') ?? null;
  const withdrawn = requirements.find((r) => r.state === 'WITHDRAWN') ?? null;
  const ready = priceability(current);

  const posture = supplyPosture(candidates);
  // The quote worth showing: the one still working its way toward the buyer,
  // or — once they have accepted — the one they accepted.
  //
  // Falling back matters more than it looks. Acceptance moves a quote out of
  // the live states, so without this the price panel goes blank at the exact
  // moment the numbers start binding somebody, and the owner has to dig through
  // version history to find what was agreed.
  const live = quotes.find((q) => ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT'].includes(q.state))
    ?? quotes.find((q) => q.state === 'ACCEPTED')
    ?? null;

  const blocking = live
    ? await prisma.approval.findMany({
        where: { routeQuoteId: live.id, status: { in: ['PENDING', 'REJECTED', 'CHANGES_REQUESTED'] } },
        orderBy: { createdAt: 'asc' },
      })
    : [];

  return {
    routeId: params.routeId,
    requirement: {
      current,
      history: requirements.filter((r) => r.id !== current?.id),
      confirmed: current?.confirmedFields ?? [],
      ready: ready.ready,
      missing: ready.missing,
      headline: requirementHeadline(current, withdrawn),
    },
    supply: {
      ...posture,
      candidates: candidates.map((c) => ({
        ...c,
        providerName: c.provider.legalName,
        costUsable: costIsUsable(c),
        label: STATE_LABELS[c.state],
        meaning: STATE_MEANING[c.state],
      })),
    },
    quotes: {
      live,
      history: quotes.filter((q) => q.id !== live?.id),
      basisLabel: live ? BASIS_LABELS[live.basis] : null,
      blocking,
      headline: quoteHeadline(live, quotes.length, blocking.length),
    },
    deal: {
      record: deal,
      money: deal ? moneyPosition(deal.payments) : null,
      headline: dealHeadline(deal),
    },
    room: {
      exists: room !== null,
      state: room?.state ?? null,
      proofStep: room?.proofStep ?? null,
      openCount: room?.openCount ?? 0,
      sentAt: room?.sentAt ?? null,
      firstOpenAt: room?.firstOpenAt ?? null,
      expiresAt: room?.expiresAt ?? null,
      responseNote: room?.responseNote ?? null,
      engagement: (room?.events ?? []).map((e) => ({
        kind: e.kind,
        detail: e.detail,
        occurredAt: e.occurredAt,
        agent: e.userAgentClass,
      })),
      headline: roomHeadline(room),
    },
    events,
  };
}

function requirementHeadline(current: BuyerRequirement | null, withdrawn: BuyerRequirement | null): string {
  if (current) {
    const stated = current.confirmedFields.length;
    return stated > 0
      ? `Version ${current.version}. ${stated} field${stated === 1 ? '' : 's'} came from the buyer; everything else is ours.`
      : `Version ${current.version}, entirely our inference. Nothing here has been confirmed by the buyer.`;
  }
  if (withdrawn) {
    return `The buyer withdrew this requirement. ${withdrawn.withdrawnReason ?? ''}`.trim();
  }
  return 'No buyer requirement recorded. Nothing on this route has been described by the buyer yet.';
}

function quoteHeadline(live: RouteQuote | null, total: number, blocking: number): string {
  if (!live) {
    return total === 0
      ? 'Nothing has been priced on this route.'
      : `No live price. ${total} earlier version${total === 1 ? '' : 's'} on record.`;
  }
  if (blocking > 0) {
    return `Version ${live.version} is held for ${blocking} owner decision${blocking === 1 ? '' : 's'}. It has not gone out.`;
  }
  switch (live.state) {
    case 'SENT': return `Version ${live.version} is with the buyer. They have not responded.`;
    case 'APPROVED': return `Version ${live.version} is approved and has not been sent.`;
    case 'ACCEPTED': return `Version ${live.version} is what the buyer accepted. These are the agreed numbers, not what was collected.`;
    default: return `Version ${live.version} is a draft. Nothing has been sent.`;
  }
}

function roomHeadline(
  room: { state: string; openCount: number; sentAt: Date | null; responseNote: string | null } | null,
): string {
  if (!room) return 'No deal room. Nothing has been put in front of this prospect.';
  switch (room.state) {
    case 'DRAFT':
      return 'A room exists and has not been sent. Nobody outside has seen it.';
    case 'SENT':
      return 'Sent. Not opened — which is a fact about the message reaching them, not about their interest.';
    case 'DELIVERED':
      return 'Delivered to their mailbox and not opened.';
    case 'OPENED':
      return `Opened ${room.openCount} time${room.openCount === 1 ? '' : 's'}. Opening is not a reply.`;
    case 'RESPONDED':
      return room.responseNote
        ? `They replied through the room: “${room.responseNote.slice(0, 160)}”`
        : 'They acted on the room.';
    case 'DECLINED':
      return 'They declined through the room. Do not follow up on this.';
    case 'EXPIRED':
      return 'The room expired. The link no longer works.';
    default:
      return 'Room state unknown.';
  }
}

function dealHeadline(
  deal: (RouteDeal & { milestones: DealMilestone[]; payments: DealPayment[] }) | null,
): string {
  if (!deal) return 'No deal. Nothing has been committed to on either side.';

  const money = moneyPosition(deal.payments);
  const providerPart = deal.providerCommittedAt
    ? 'A provider has committed to deliver it.'
    : 'No provider has committed to deliver it yet.';

  switch (deal.stage) {
    case 'COMMITTED':
      return `The buyer committed. Nothing has been delivered and no money has moved. ${providerPart}`;
    case 'IN_DELIVERY':
      return `Work is under way. ${money.collected > 0 ? `${money.collected} collected so far.` : 'No money has been collected.'}`;
    case 'DELIVERED':
      return money.invoiced > 0
        ? 'Delivered and invoiced. Delivered is not paid.'
        : 'Delivered. Nothing has been invoiced yet, so nothing is owed on paper.';
    case 'INVOICED':
      return `Invoiced ${money.invoiced}. ${money.outstanding > 0 ? `${money.outstanding} still outstanding.` : 'Settled.'}`;
    case 'PAID':
      return `Paid. Collected gross profit ${money.collectedGrossProfit}.`;
    case 'CLOSED':
      return `Closed. Collected gross profit ${money.collectedGrossProfit}.`;
    case 'CANCELLED':
      return `Cancelled. ${deal.cancelReason ?? ''}`.trim();
    case 'DISPUTED':
      return `In dispute. ${deal.disputeNotes ?? ''}`.trim();
    case 'LOST':
      return `Lost after commitment. ${deal.lostReason ?? ''}`.trim();
    default:
      return 'Stage unknown.';
  }
}
