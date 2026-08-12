import type { CommitmentBasis, DealStage, Prisma, RouteDeal } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getOrgConfig } from '@/lib/config';
import { approvalsRequired, syncQuoteApprovals, approvalGate } from './approval';
import { economicsOf } from './quote';
import { recordDealEvent, newCorrelationId } from './events';
import { recordDealOutcome } from '@/lib/measure/funnel';

/**
 * Commitment, delivery and money.
 *
 * This is the layer the previous system never had, and its absence is why that
 * system could not tell a good source from a bad one: everything it learned
 * stopped at "appointment booked". Nothing downstream of that — whether the
 * work happened, whether we were paid, whether we made anything — ever came
 * back to the thing that produced the lead.
 *
 * Four facts are kept apart here on purpose, because collapsing any two of them
 * produces a number that reads as revenue and is not:
 *
 *   The buyer committed. Somebody said yes, on a date, with something backing it.
 *   The provider committed. A separate promise, which may lag or never arrive.
 *   The work was delivered. Evidenced, not asserted.
 *   The money settled. An invoice is a claim; only a settled payment is money.
 *
 * `collectedGrossProfit` reads the fourth and only the fourth.
 */

export type CommitRefusal = {
  ok: false;
  kind: 'not_found' | 'not_sendable' | 'approval_pending' | 'approval_rejected' | 'already_committed' | 'no_price' | 'no_evidence';
  message: string;
  detail: string[];
};

export type CommitSuccess = { ok: true; deal: RouteDeal };
export type CommitResult = CommitSuccess | CommitRefusal;

// ---------------------------------------------------------------------------
// Buyer commitment
// ---------------------------------------------------------------------------

/**
 * The buyer said yes.
 *
 * Requires a basis and evidence, so nothing can be marked won by flipping a
 * status. A signed contract additionally raises its own approval before it can
 * be treated as executed — the obligations in one outlive the deal.
 */
export async function commitBuyer(options: {
  orgId: string;
  quoteId: string;
  basis: CommitmentBasis;
  evidence: string;
  buyerContactId?: string | null;
  /** What was actually agreed, which is not always what was quoted. */
  contractedValue?: number | null;
  actorId?: string | null;
  now?: Date;
}): Promise<CommitResult> {
  const now = options.now ?? new Date();
  const correlationId = newCorrelationId();

  // Checked here and not only in the request schema. The schema guards one
  // door; this guards the room. Anything calling this from a job, a script or
  // a later feature gets the same refusal, which is the point of putting the
  // rule where the write is.
  if (!options.evidence.trim()) {
    return {
      ok: false,
      kind: 'no_evidence',
      message: 'A commitment needs evidence: what the buyer actually said or sent.',
      detail: ['A PO number, the email, the line on the call. Something a person could check in six months.'],
    };
  }

  const quote = await prisma.routeQuote.findFirst({
    where: { id: options.quoteId, orgId: options.orgId },
    include: { providerCandidate: true, route: { select: { complianceGaps: true } } },
  });
  if (!quote) return { ok: false, kind: 'not_found', message: 'That quote is not on this account.', detail: [] };

  const existing = await prisma.routeDeal.findUnique({ where: { routeId: quote.routeId } });
  if (existing) {
    return {
      ok: false,
      kind: 'already_committed',
      message: 'This route already has a committed deal.',
      detail: [`Deal opened ${existing.buyerCommittedAt.toISOString().slice(0, 10)} against quote version in force at the time.`],
    };
  }

  if (quote.state !== 'SENT' && quote.state !== 'APPROVED') {
    return {
      ok: false,
      kind: 'not_sendable',
      message: `A buyer cannot commit to a quote that is ${quote.state.toLowerCase().replace(/_/g, ' ')}.`,
      detail: ['Send the quote first, so what they agreed to is on record.'],
    };
  }

  if (quote.buyerPrice === null) {
    return {
      ok: false,
      kind: 'no_price',
      message: 'This quote has no buyer price, so there is nothing for them to have agreed to.',
      detail: [],
    };
  }

  // A signed contract is a separate authority question from the price, and it
  // is asked here rather than at quote time because that is when it becomes true.
  if (options.basis === 'SIGNED_CONTRACT') {
    const config = await getOrgConfig(options.orgId);
    const required = approvalsRequired({
      economics: economicsOf(quote),
      config,
      provider: quote.providerCandidate,
      buyerPaymentTerms: quote.paymentTerms,
      providerPaymentTerms: quote.providerCandidate?.costTerms ?? null,
      complianceGaps: quote.route.complianceGaps,
      legalCommitment: true,
      now,
    });
    await prisma.$transaction(async (tx) => {
      await syncQuoteApprovals(tx, {
        orgId: options.orgId,
        routeId: quote.routeId,
        quoteId: quote.id,
        requirements: required,
        actorId: options.actorId,
      });
      await tx.routeQuote.update({
        where: { id: quote.id },
        data: { approvalRequired: required.length > 0, approvalReasons: required.map((r) => r.title) },
      });
    });
  }

  const gate = await approvalGate(await prisma.routeQuote.findUniqueOrThrow({
    where: { id: quote.id },
    select: { id: true, approvalRequired: true },
  }));
  if (!gate.cleared) {
    return gate.rejected.length > 0
      ? {
          ok: false,
          kind: 'approval_rejected',
          message: 'This deal was not approved, so it cannot be committed.',
          detail: gate.rejected.map((r) => `${r.title}${r.note ? ` — ${r.note}` : ''}`),
        }
      : {
          ok: false,
          kind: 'approval_pending',
          message: 'This deal is waiting on an owner decision before it can be committed.',
          detail: gate.pending.map((p) => p.title),
        };
  }

  const deal = await prisma.$transaction(async (tx) => {
    await tx.routeQuote.update({
      where: { id: quote.id },
      data: { state: 'ACCEPTED', acceptedAt: now, respondedAt: now },
    });

    const created = await tx.routeDeal.create({
      data: {
        orgId: options.orgId,
        routeId: quote.routeId,
        quoteId: quote.id,
        stage: 'COMMITTED',
        buyerCommittedAt: now,
        buyerCommitmentBasis: options.basis,
        buyerCommitmentEvidence: options.evidence,
        buyerContactId: options.buyerContactId ?? null,
        contractedValue: options.contractedValue ?? Number(quote.buyerPrice),
        providerCandidateId: quote.providerCandidateId,
        createdById: options.actorId ?? null,
      },
    });

    await recordDealEvent(tx, {
      orgId: options.orgId,
      routeId: quote.routeId,
      kind: 'deal.buyer_committed',
      actorId: options.actorId,
      subjectType: 'RouteDeal',
      subjectId: created.id,
      summary: `Buyer committed on quote v${quote.version} (${options.basis.toLowerCase().replace(/_/g, ' ')}).`,
      before: { stage: null },
      after: { stage: 'COMMITTED', contractedValue: String(created.contractedValue) },
      evidence: options.evidence,
      confidence: 'committed',
      correlationId,
    });

    return created;
  });

  // The funnel reads the deal rather than being told about it, so WON is
  // always backed by a dated commitment with evidence on it.
  await recordDealOutcome({ routeId: deal.routeId });

  return { ok: true, deal };
}

/**
 * The provider agreed to do the work.
 *
 * A separate fact with its own date and evidence. A deal can sit committed on
 * the buyer side with no provider commitment for days, and that gap is exactly
 * what an owner needs to see rather than have averaged away.
 */
export async function commitProvider(options: {
  orgId: string;
  dealId: string;
  providerCandidateId: string;
  basis: CommitmentBasis;
  evidence: string;
  contractedCost?: number | null;
  actorId?: string | null;
  now?: Date;
}): Promise<CommitResult> {
  const now = options.now ?? new Date();

  if (!options.evidence.trim()) {
    return {
      ok: false,
      kind: 'no_evidence',
      message: 'A provider commitment needs evidence: what they agreed to, and how they said it.',
      detail: [],
    };
  }

  const deal = await prisma.routeDeal.findFirst({ where: { id: options.dealId, orgId: options.orgId } });
  if (!deal) return { ok: false, kind: 'not_found', message: 'That deal is not on this account.', detail: [] };

  const candidate = await prisma.providerCandidate.findFirst({
    where: { id: options.providerCandidateId, orgId: options.orgId, routeId: deal.routeId },
  });
  if (!candidate) {
    return { ok: false, kind: 'not_found', message: 'That provider is not a candidate on this route.', detail: [] };
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.routeDeal.update({
      where: { id: deal.id },
      data: {
        providerCandidateId: candidate.id,
        providerCommittedAt: now,
        providerCommitmentBasis: options.basis,
        providerCommitmentEvidence: options.evidence,
        contractedCost: options.contractedCost ?? (candidate.costAmount === null ? null : Number(candidate.costAmount)),
      },
    });

    await recordDealEvent(tx, {
      orgId: options.orgId,
      routeId: deal.routeId,
      kind: 'deal.provider_committed',
      actorId: options.actorId,
      subjectType: 'RouteDeal',
      subjectId: deal.id,
      summary: `Provider committed to deliver (${options.basis.toLowerCase().replace(/_/g, ' ')}).`,
      before: { providerCommittedAt: null },
      after: { providerCommittedAt: now.toISOString(), contractedCost: String(row.contractedCost) },
      evidence: options.evidence,
      confidence: 'committed',
      correlationId: newCorrelationId(),
    });

    return row;
  });

  return { ok: true, deal: updated };
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/** Forward-only, except into the states that describe something going wrong. */
const STAGE_RANK: Record<DealStage, number> = {
  COMMITTED: 1,
  IN_DELIVERY: 2,
  DELIVERED: 3,
  INVOICED: 4,
  PAID: 5,
  CLOSED: 6,
  CANCELLED: 0,
  DISPUTED: 0,
  LOST: 0,
};

const OFF_LADDER: DealStage[] = ['CANCELLED', 'DISPUTED', 'LOST'];

export async function advanceDeal(options: {
  orgId: string;
  dealId: string;
  to: DealStage;
  reason: string;
  /** Required to reach DELIVERED. A tick with no evidence is an opinion. */
  completionEvidence?: string | null;
  responsibility?: string | null;
  actorId?: string | null;
  now?: Date;
}): Promise<CommitResult | { ok: false; kind: 'backwards' | 'missing_evidence'; message: string; detail: string[] }> {
  const now = options.now ?? new Date();

  const deal = await prisma.routeDeal.findFirst({ where: { id: options.dealId, orgId: options.orgId } });
  if (!deal) return { ok: false, kind: 'not_found', message: 'That deal is not on this account.', detail: [] };

  if (!OFF_LADDER.includes(options.to) && STAGE_RANK[options.to] < STAGE_RANK[deal.stage]) {
    return {
      ok: false,
      kind: 'backwards',
      message: `This deal is already ${label(deal.stage)}. Moving it back to ${label(options.to)} would erase what happened — record a dispute or a cancellation instead.`,
      detail: [],
    };
  }

  if (options.to === 'DELIVERED' && !options.completionEvidence?.trim()) {
    return {
      ok: false,
      kind: 'missing_evidence',
      message: 'Delivered needs evidence: what proves the work happened.',
      detail: ['A sign-off, a photo set, a completion note from the buyer — anything a person could check later.'],
    };
  }

  const data: Prisma.RouteDealUpdateInput = { stage: options.to };
  if (options.to === 'IN_DELIVERY' && deal.deliveryStartedAt === null) data.deliveryStartedAt = now;
  if (options.to === 'DELIVERED') {
    data.deliveryCompletedAt = now;
    data.completionEvidence = options.completionEvidence ?? null;
  }
  if (options.to === 'CANCELLED') {
    data.cancelledAt = now;
    data.cancelReason = options.reason;
    data.responsibility = options.responsibility ?? null;
  }
  if (options.to === 'DISPUTED') {
    data.disputeOpenedAt = now;
    data.disputeNotes = options.reason;
    data.responsibility = options.responsibility ?? null;
  }
  if (options.to === 'LOST') data.lostReason = options.reason;

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.routeDeal.update({ where: { id: deal.id }, data });
    await recordDealEvent(tx, {
      orgId: options.orgId,
      routeId: deal.routeId,
      kind: `deal.${options.to.toLowerCase()}`,
      actorId: options.actorId,
      subjectType: 'RouteDeal',
      subjectId: deal.id,
      summary: `${label(deal.stage)} → ${label(options.to)}. ${options.reason}`,
      before: { stage: deal.stage },
      after: { stage: options.to },
      evidence: options.completionEvidence ?? options.reason,
      correlationId: newCorrelationId(),
    });
    return row;
  });

  // Delivery and loss are funnel rungs. Recorded from the row rather than from
  // the request, so a stage that failed to persist records nothing.
  await recordDealOutcome({ routeId: deal.routeId });

  return { ok: true, deal: updated };
}

export async function addMilestone(options: {
  orgId: string;
  dealId: string;
  label: string;
  dueAt?: Date | null;
  sortOrder?: number;
  actorId?: string | null;
}): Promise<{ id: string } | null> {
  const deal = await prisma.routeDeal.findFirst({ where: { id: options.dealId, orgId: options.orgId } });
  if (!deal) return null;

  return prisma.$transaction(async (tx) => {
    const created = await tx.dealMilestone.create({
      data: {
        dealId: deal.id,
        label: options.label,
        dueAt: options.dueAt ?? null,
        sortOrder: options.sortOrder ?? 0,
      },
    });
    await recordDealEvent(tx, {
      orgId: options.orgId,
      routeId: deal.routeId,
      kind: 'deal.milestone_added',
      actorId: options.actorId,
      subjectType: 'DealMilestone',
      subjectId: created.id,
      summary: `Milestone added: ${options.label}`,
      after: { label: options.label, dueAt: options.dueAt?.toISOString() ?? null },
    });
    return { id: created.id };
  });
}

export async function completeMilestone(options: {
  orgId: string;
  milestoneId: string;
  evidence: string;
  actorId?: string | null;
  now?: Date;
}): Promise<{ ok: boolean; message?: string }> {
  const now = options.now ?? new Date();
  if (!options.evidence.trim()) {
    return { ok: false, message: 'A completed milestone needs evidence. Without it there is nothing to check later.' };
  }

  const milestone = await prisma.dealMilestone.findFirst({
    where: { id: options.milestoneId, deal: { orgId: options.orgId } },
    include: { deal: { select: { id: true, routeId: true } } },
  });
  if (!milestone) return { ok: false, message: 'That milestone is not on this account.' };

  await prisma.$transaction(async (tx) => {
    await tx.dealMilestone.update({
      where: { id: milestone.id },
      data: { completedAt: now, evidence: options.evidence },
    });
    await recordDealEvent(tx, {
      orgId: options.orgId,
      routeId: milestone.deal.routeId,
      kind: 'deal.milestone_completed',
      actorId: options.actorId,
      subjectType: 'DealMilestone',
      subjectId: milestone.id,
      summary: `Milestone completed: ${milestone.label}`,
      after: { completedAt: now.toISOString() },
      evidence: options.evidence,
    });
  });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export type PaymentInput = {
  orgId: string;
  dealId: string;
  direction: 'INBOUND' | 'OUTBOUND';
  kind: 'INVOICE' | 'PAYMENT' | 'REFUND' | 'CHARGEBACK' | 'WRITE_OFF';
  amount: number;
  dueAt?: Date | null;
  /** Null until the money actually moves. Nothing unsettled counts as money. */
  settledAt?: Date | null;
  reference?: string | null;
  notes?: string | null;
  actorId?: string | null;
};

export async function recordPayment(input: PaymentInput): Promise<{ ok: boolean; message?: string; id?: string }> {
  if (!(input.amount > 0)) {
    return { ok: false, message: 'Amounts are positive. Direction and kind carry the sign, so a refund is a REFUND, not a negative payment.' };
  }

  const deal = await prisma.routeDeal.findFirst({ where: { id: input.dealId, orgId: input.orgId } });
  if (!deal) return { ok: false, message: 'That deal is not on this account.' };

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.dealPayment.create({
      data: {
        orgId: input.orgId,
        dealId: deal.id,
        direction: input.direction,
        kind: input.kind,
        amount: input.amount,
        dueAt: input.dueAt ?? null,
        settledAt: input.settledAt ?? null,
        reference: input.reference ?? null,
        notes: input.notes ?? null,
        recordedById: input.actorId ?? null,
      },
    });

    await recordDealEvent(tx, {
      orgId: input.orgId,
      routeId: deal.routeId,
      kind: input.settledAt ? 'payment.settled' : 'payment.recorded',
      actorId: input.actorId,
      subjectType: 'DealPayment',
      subjectId: row.id,
      summary: `${input.direction === 'INBOUND' ? 'From buyer' : 'To provider'}: ${input.kind.toLowerCase()} of ${input.amount}${input.settledAt ? ' (settled)' : ' (not settled)'}.`,
      after: { direction: input.direction, kind: input.kind, amount: input.amount, settledAt: input.settledAt?.toISOString() ?? null },
      evidence: input.reference ?? null,
      confidence: input.settledAt ? 'realised' : 'claimed',
      correlationId: newCorrelationId(),
    });

    return row;
  });

  return { ok: true, id: created.id };
}

/** Mark an existing invoice or payment as having settled. */
export async function settlePayment(options: {
  orgId: string;
  paymentId: string;
  settledAt?: Date;
  reference?: string | null;
  actorId?: string | null;
}): Promise<{ ok: boolean; message?: string }> {
  const now = options.settledAt ?? new Date();
  const payment = await prisma.dealPayment.findFirst({
    where: { id: options.paymentId, orgId: options.orgId },
    include: { deal: { select: { routeId: true } } },
  });
  if (!payment) return { ok: false, message: 'That payment line is not on this account.' };
  if (payment.settledAt) return { ok: false, message: 'That line has already settled.' };

  await prisma.$transaction(async (tx) => {
    await tx.dealPayment.update({
      where: { id: payment.id },
      data: { settledAt: now, reference: options.reference ?? payment.reference },
    });
    await recordDealEvent(tx, {
      orgId: options.orgId,
      routeId: payment.deal.routeId,
      kind: 'payment.settled',
      actorId: options.actorId,
      subjectType: 'DealPayment',
      subjectId: payment.id,
      summary: `${payment.kind.toLowerCase()} of ${payment.amount} settled.`,
      before: { settledAt: null },
      after: { settledAt: now.toISOString() },
      evidence: options.reference ?? payment.reference,
      confidence: 'realised',
    });
  });

  // Money moving is the last rung, and the only one that can carry a profit
  // figure. Recorded here rather than at invoice time, because an invoice is a
  // claim and this function is where it stops being one.
  await recordDealOutcome({ routeId: payment.deal.routeId });

  return { ok: true };
}

export type MoneyPosition = {
  /** Billed to the buyer, settled or not. A claim. */
  invoiced: number;
  /** Actually received. */
  collected: number;
  /** Actually paid out. */
  paidOut: number;
  /** Owed to us and not yet settled. */
  outstanding: number;
  /**
   * Collected minus paid out. The only profit figure in this system that
   * describes money rather than intent.
   */
  collectedGrossProfit: number;
  /** True only when every inbound line has settled and nothing is disputed. */
  fullySettled: boolean;
};

/**
 * What actually happened financially on one deal.
 *
 * Invoices are excluded from every figure except `invoiced` and `outstanding`.
 * A refund or chargeback subtracts from what we collected rather than being
 * recorded as a separate positive number somewhere else, so the totals cannot
 * be made to look better by choosing which column to read.
 */
export function moneyPosition(
  payments: Array<{ direction: string; kind: string; amount: Prisma.Decimal | number; settledAt: Date | null }>,
): MoneyPosition {
  let invoiced = 0;
  let collected = 0;
  let paidOut = 0;

  for (const line of payments) {
    const amount = Number(line.amount);
    if (line.direction === 'INBOUND') {
      if (line.kind === 'INVOICE') invoiced += amount;
      if (!line.settledAt) continue;
      if (line.kind === 'PAYMENT') collected += amount;
      if (line.kind === 'REFUND' || line.kind === 'CHARGEBACK') collected -= amount;
    } else {
      if (!line.settledAt) continue;
      if (line.kind === 'PAYMENT') paidOut += amount;
      if (line.kind === 'REFUND') paidOut -= amount;
    }
  }

  const outstanding = Math.max(invoiced - collected, 0);

  return {
    invoiced: round(invoiced),
    collected: round(collected),
    paidOut: round(paidOut),
    outstanding: round(outstanding),
    collectedGrossProfit: round(collected - paidOut),
    fullySettled: invoiced > 0 && outstanding === 0,
  };
}

export async function moneyFor(dealId: string): Promise<MoneyPosition> {
  const payments = await prisma.dealPayment.findMany({
    where: { dealId },
    select: { direction: true, kind: true, amount: true, settledAt: true },
  });
  return moneyPosition(payments);
}

function label(stage: DealStage): string {
  return stage.toLowerCase().replace(/_/g, ' ');
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
