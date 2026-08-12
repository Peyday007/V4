import type { Prisma, RouteQuote, QuoteState } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getOrgConfig } from '@/lib/config';
import { computeEconomics, exposureDays, type Economics } from './economics';
import { approvalsRequired, syncQuoteApprovals, approvalGate } from './approval';
import { costIsUsable } from './provider';
import { priceability } from './requirement';
import { recordDealEvent, diffOf, newCorrelationId } from './events';

/**
 * Priced offers to the buyer, as versions.
 *
 * Nothing here edits a price in place once it exists. A revision writes a new
 * version and supersedes the old one, so "what did we send them in March"
 * survives every later negotiation — which matters most in exactly the argument
 * where it is hardest to reconstruct.
 *
 * The database enforces one live quote per route through a partial unique
 * index, so the ordering below is not stylistic: the outgoing version is
 * retired before the new one is written, because Postgres checks that index at
 * the end of each statement rather than the end of the transaction.
 */

/** States in which a quote is still working its way toward the buyer. */
export const LIVE_STATES: QuoteState[] = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT'];

export type QuoteInputs = {
  providerCandidateId?: string | null;
  providerCost?: number | null;
  freight?: number | null;
  fees?: number | null;
  contingency?: number | null;
  buyerPrice?: number | null;
  currency?: string;
  paymentTerms?: string | null;
  deliveryTerms?: string | null;
  downsideNotes?: string | null;
  assumptions?: string[];
  validUntil?: Date | null;
  workingCapitalAmount?: number | null;
  workingCapitalDays?: number | null;
  /** Days between us paying the provider and the work being delivered. */
  deliveryDays?: number | null;
};

export type QuoteRefusal = {
  ok: false;
  kind: 'no_requirement' | 'not_found' | 'not_live' | 'approval_pending' | 'approval_rejected' | 'nothing_to_price' | 'raced';
  message: string;
  detail: string[];
};

export type QuoteSuccess = { ok: true; quote: RouteQuote; economics: Economics; approvalsOpened: number };
export type QuoteResult = QuoteSuccess | QuoteRefusal;

// ---------------------------------------------------------------------------
// Drafting and revising
// ---------------------------------------------------------------------------

/**
 * Write a new version of the price for this route.
 *
 * The same call handles the first quote and every revision, because they are
 * the same operation: the previous live version, if there is one, is retired
 * and the new one takes its place at version N+1.
 */
export async function draftQuote(options: {
  orgId: string;
  routeId: string;
  inputs: QuoteInputs;
  actorId?: string | null;
  reason?: string;
  now?: Date;
}): Promise<QuoteResult> {
  const now = options.now ?? new Date();
  const config = await getOrgConfig(options.orgId);
  const correlationId = newCorrelationId();

  const route = await prisma.routeHypothesis.findFirst({
    where: { id: options.routeId, orgId: options.orgId },
    select: { id: true, complianceGaps: true },
  });
  if (!route) {
    return { ok: false, kind: 'not_found', message: 'That route is not on this account.', detail: [] };
  }

  const requirement = await prisma.buyerRequirement.findFirst({
    where: { routeId: options.routeId, state: 'CURRENT' },
  });
  if (!requirement) {
    return {
      ok: false,
      kind: 'no_requirement',
      message: 'There is no current buyer requirement on this route, so there is nothing to price.',
      detail: ['Record what the buyer said they need first. A price written against an assumed scope is our guess with a number on it.'],
    };
  }

  const provider = options.inputs.providerCandidateId
    ? await prisma.providerCandidate.findFirst({
        where: { id: options.inputs.providerCandidateId, orgId: options.orgId, routeId: options.routeId },
      })
    : null;

  // The provider's own cost wins over a typed one when we hold a usable quote
  // from them, so a stale number cannot be re-entered by hand and look fresh.
  const providerCost = provider && costIsUsable(provider, now)
    ? Number(provider.costAmount)
    : options.inputs.providerCost ?? null;

  if (providerCost === null && (options.inputs.buyerPrice === null || options.inputs.buyerPrice === undefined)) {
    return {
      ok: false,
      kind: 'nothing_to_price',
      message: 'A quote needs at least one real number.',
      detail: ['Neither a provider cost nor a buyer price was given.'],
    };
  }

  // Aliased so the narrowing above survives into the closure below. Without
  // this the compiler widens it back to nullable and the version pointer could
  // silently be written as null.
  const currentRequirement = requirement;

  const ready = priceability(currentRequirement);
  const workingCapitalDays = options.inputs.workingCapitalDays
    ?? exposureDays({
      buyerTerms: options.inputs.paymentTerms,
      providerTerms: provider?.costTerms ?? null,
      deliveryDays: options.inputs.deliveryDays ?? null,
    });

  const economics = computeEconomics({
    providerCost,
    freight: options.inputs.freight ?? null,
    fees: options.inputs.fees ?? null,
    contingency: options.inputs.contingency ?? null,
    buyerPrice: options.inputs.buyerPrice ?? null,
    costIsQuoted: provider !== null && costIsUsable(provider, now),
    requirementReady: ready.ready,
    workingCapitalAmount: options.inputs.workingCapitalAmount ?? null,
    workingCapitalDays,
  });

  const required = approvalsRequired({
    economics,
    config,
    provider,
    buyerPaymentTerms: options.inputs.paymentTerms ?? null,
    providerPaymentTerms: provider?.costTerms ?? null,
    complianceGaps: route.complianceGaps,
    now,
  });

  try {
    return await writeQuote();
  } catch (error) {
    // Two people repricing the same route in the same second. One of them wins
    // on the partial unique index, and the other has to be told what happened
    // rather than shown a database error — their numbers are still in the form,
    // and the right next step is to look at what the other person wrote.
    if (isUniqueViolation(error)) {
      return {
        ok: false,
        kind: 'raced',
        message: 'Somebody else revised this price a moment ago.',
        detail: ['Reload the opportunity to see their version before you replace it. Nothing you typed has been sent anywhere.'],
      };
    }
    throw error;
  }

  function writeQuote(): Promise<QuoteResult> {
  return prisma.$transaction(async (tx) => {
    const live = await tx.routeQuote.findFirst({
      where: { routeId: options.routeId, state: { in: LIVE_STATES } },
    });

    // Retire first. See the note at the top of this file.
    if (live) {
      await tx.routeQuote.update({
        where: { id: live.id },
        data: { state: 'SUPERSEDED', supersededAt: now },
      });

      // And retire what it was waiting on. An approval outlives its quote
      // otherwise, and the owner is asked to decide about a margin on a price
      // nobody is offering any more — which trains them to approve without
      // reading, because half the queue is about numbers that changed.
      await tx.approval.updateMany({
        where: { routeQuoteId: live.id, status: 'PENDING' },
        data: {
          status: 'EXPIRED',
          decisionNote: `Quote v${live.version} was superseded before this was decided.`,
        },
      });
    }

    const highest = await tx.routeQuote.findFirst({
      where: { routeId: options.routeId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });

    const created = await tx.routeQuote.create({
      data: {
        orgId: options.orgId,
        routeId: options.routeId,
        version: (highest?.version ?? 0) + 1,
        requirementId: currentRequirement.id,
        providerCandidateId: provider?.id ?? null,
        state: required.length > 0 ? 'PENDING_APPROVAL' : 'DRAFT',
        currency: options.inputs.currency ?? 'USD',
        providerCost,
        freight: options.inputs.freight ?? null,
        fees: options.inputs.fees ?? null,
        contingency: options.inputs.contingency ?? null,
        buyerPrice: options.inputs.buyerPrice ?? null,
        grossProfit: economics.grossProfit,
        grossMarginPct: economics.grossMarginPct,
        basis: economics.basis,
        confidence: economics.confidence,
        costSideMissing: economics.costSideMissing,
        workingCapitalAmount: economics.workingCapitalAmount,
        workingCapitalDays: economics.workingCapitalDays,
        paymentTerms: options.inputs.paymentTerms ?? null,
        deliveryTerms: options.inputs.deliveryTerms ?? null,
        downsideNotes: options.inputs.downsideNotes ?? null,
        assumptions: [...(options.inputs.assumptions ?? []), ...ready.missing.map((m) => `Assumed: ${m}`)],
        validUntil: options.inputs.validUntil ?? null,
        approvalRequired: required.length > 0,
        approvalReasons: required.map((r) => r.title),
        createdById: options.actorId ?? null,
      },
    });

    if (live) {
      await tx.routeQuote.update({ where: { id: live.id }, data: { supersededById: created.id } });
    }

    const { opened } = await syncQuoteApprovals(tx, {
      orgId: options.orgId,
      routeId: options.routeId,
      quoteId: created.id,
      requirements: required,
      actorId: options.actorId,
    });

    const delta = diffOf(live as unknown as Record<string, unknown> | null, {
      buyerPrice: created.buyerPrice,
      providerCost: created.providerCost,
      grossProfit: created.grossProfit,
      state: created.state,
    });

    await recordDealEvent(tx, {
      orgId: options.orgId,
      routeId: options.routeId,
      kind: live ? 'quote.revised' : 'quote.drafted',
      actorId: options.actorId,
      subjectType: 'RouteQuote',
      subjectId: created.id,
      summary: live
        ? `Quote v${live.version} superseded by v${created.version}. ${options.reason ?? 'Revised.'}`
        : `Quote v${created.version} drafted against requirement v${currentRequirement.version}.`,
      before: delta.before,
      after: delta.after,
      confidence: economics.basis,
      correlationId,
    });

    return { ok: true as const, quote: created, economics, approvalsOpened: opened };
  });
  }
}

/** Postgres unique violation, as Prisma reports it. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'P2002';
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * Send a quote to the buyer, or refuse and name what is blocking it.
 *
 * The approval check reads the approvals themselves rather than the flag on the
 * quote. A flag can go stale; the rows cannot.
 */
export async function sendQuote(options: {
  orgId: string;
  quoteId: string;
  actorId?: string | null;
  /** How it went out — an email, a portal upload, read out on a call. */
  channel: string;
  now?: Date;
}): Promise<QuoteResult> {
  const now = options.now ?? new Date();

  const quote = await prisma.routeQuote.findFirst({
    where: { id: options.quoteId, orgId: options.orgId },
  });
  if (!quote) return { ok: false, kind: 'not_found', message: 'That quote is not on this account.', detail: [] };

  if (quote.state !== 'DRAFT' && quote.state !== 'APPROVED' && quote.state !== 'PENDING_APPROVAL') {
    return {
      ok: false,
      kind: 'not_live',
      message: `This quote is ${quote.state.toLowerCase().replace(/_/g, ' ')} and cannot be sent.`,
      detail: ['Draft a new version if the buyer needs a fresh price.'],
    };
  }

  const gate = await approvalGate(quote);
  if (!gate.cleared) {
    if (gate.rejected.length > 0) {
      return {
        ok: false,
        kind: 'approval_rejected',
        message: 'This quote was not approved.',
        detail: gate.rejected.map((r) => `${r.title}${r.note ? ` — ${r.note}` : ''}`),
      };
    }
    return {
      ok: false,
      kind: 'approval_pending',
      message: 'This quote is waiting on an owner decision.',
      detail: gate.pending.map((p) => p.title),
    };
  }

  const sent = await prisma.$transaction(async (tx) => {
    const updated = await tx.routeQuote.update({
      where: { id: quote.id },
      data: { state: 'SENT', sentAt: now },
    });
    await recordDealEvent(tx, {
      orgId: options.orgId,
      routeId: quote.routeId,
      kind: 'quote.sent',
      actorId: options.actorId,
      subjectType: 'RouteQuote',
      subjectId: quote.id,
      summary: `Quote v${quote.version} sent to the buyer via ${options.channel}.`,
      before: { state: quote.state },
      after: { state: 'SENT', sentAt: now.toISOString() },
      evidence: options.channel,
      correlationId: newCorrelationId(),
    });
    return updated;
  });

  return { ok: true, quote: sent, economics: economicsOf(sent), approvalsOpened: 0 };
}

/**
 * The buyer said no, or came back wanting something different.
 *
 * Acceptance is deliberately not handled here. A buyer saying yes is a
 * commitment with a basis and evidence behind it, and it lives in `commit.ts`
 * where those are required — so nothing can mark a deal won by flipping a
 * status.
 */
export async function declineQuote(options: {
  orgId: string;
  quoteId: string;
  reason: string;
  negotiationNote?: string | null;
  actorId?: string | null;
  now?: Date;
}): Promise<QuoteResult> {
  const now = options.now ?? new Date();
  const quote = await prisma.routeQuote.findFirst({ where: { id: options.quoteId, orgId: options.orgId } });
  if (!quote) return { ok: false, kind: 'not_found', message: 'That quote is not on this account.', detail: [] };
  if (!LIVE_STATES.includes(quote.state)) {
    return {
      ok: false,
      kind: 'not_live',
      message: `This quote is already ${quote.state.toLowerCase().replace(/_/g, ' ')}.`,
      detail: [],
    };
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.routeQuote.update({
      where: { id: quote.id },
      data: {
        state: 'DECLINED',
        declinedAt: now,
        respondedAt: now,
        declineReason: options.reason,
        negotiationNote: options.negotiationNote ?? null,
      },
    });
    await recordDealEvent(tx, {
      orgId: options.orgId,
      routeId: quote.routeId,
      kind: 'quote.declined',
      actorId: options.actorId,
      subjectType: 'RouteQuote',
      subjectId: quote.id,
      summary: `Buyer declined quote v${quote.version}: ${options.reason}`,
      before: { state: quote.state },
      after: { state: 'DECLINED' },
      evidence: options.negotiationNote ?? null,
      correlationId: newCorrelationId(),
    });
    return row;
  });

  return { ok: true, quote: updated, economics: economicsOf(updated), approvalsOpened: 0 };
}

/**
 * Retire quotes whose validity date has passed.
 *
 * A price with a stale date on it is worse than no price: somebody reads it as
 * current and commits to it. Run from the scheduler alongside the other sweeps.
 */
export async function expireQuotes(options: { orgId: string; now?: Date }): Promise<number> {
  const now = options.now ?? new Date();
  const stale = await prisma.routeQuote.findMany({
    where: { orgId: options.orgId, state: { in: LIVE_STATES }, validUntil: { not: null, lte: now } },
    select: { id: true, routeId: true, version: true, state: true },
  });

  for (const quote of stale) {
    await prisma.$transaction(async (tx) => {
      await tx.routeQuote.update({ where: { id: quote.id }, data: { state: 'EXPIRED' } });
      await recordDealEvent(tx, {
        orgId: options.orgId,
        routeId: quote.routeId,
        kind: 'quote.expired',
        actorType: 'system',
        subjectType: 'RouteQuote',
        subjectId: quote.id,
        summary: `Quote v${quote.version} passed its validity date and is no longer current.`,
        before: { state: quote.state },
        after: { state: 'EXPIRED' },
      });
    });
  }

  return stale.length;
}

/** Read the stored economics back off a quote row, without recomputing them. */
export function economicsOf(quote: RouteQuote): Economics {
  return {
    totalCost: quote.providerCost === null
      ? null
      : num(quote.providerCost) + num(quote.freight) + num(quote.fees) + num(quote.contingency),
    grossProfit: quote.grossProfit === null ? null : Number(quote.grossProfit),
    grossMarginPct: quote.grossMarginPct,
    basis: quote.basis,
    confidence: quote.confidence,
    costSideMissing: quote.costSideMissing,
    workingCapitalAmount: quote.workingCapitalAmount === null ? null : Number(quote.workingCapitalAmount),
    workingCapitalDays: quote.workingCapitalDays,
    warnings: [],
  };
}

function num(value: Prisma.Decimal | null): number {
  return value === null ? 0 : Number(value);
}
