import type { ApprovalType, Prisma, ProviderCandidate, RouteQuote } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { OrgConfig } from '@/lib/config';
import type { Economics } from './economics';
import { paymentTermDays } from './economics';
import { costIsUsable } from './provider';
import { recordDealEvent } from './events';

/**
 * What an owner has to see before it leaves the building.
 *
 * The gate is computed and stored when a quote is saved, not when a screen
 * renders it. A rule that only runs in the browser is a rule that a second tab,
 * a refresh or a direct API call walks straight past — and the whole point of
 * an approval is that it cannot be walked past.
 *
 * These rules are conservative by construction. Every one of them describes a
 * way the business can lose money it cannot get back: a margin below the floor,
 * a price with no cost behind it, more cash out than the account can carry,
 * terms nobody agreed to, or a promise resting on a provider who has not agreed
 * to anything.
 */

export type ApprovalRequirement = {
  type: ApprovalType;
  title: string;
  /** Why, in the owner's language. Shown on the approval itself. */
  summary: string;
  amount: number | null;
};

export type ApprovalContext = {
  economics: Economics;
  config: OrgConfig;
  /** The provider this price is built on, if any. */
  provider: ProviderCandidate | null;
  buyerPaymentTerms: string | null;
  providerPaymentTerms: string | null;
  /** Requirements we cannot currently satisfy. Non-empty is always an escalation. */
  complianceGaps: string[];
  /** Set when the quote is being turned into a signed commitment. */
  legalCommitment?: boolean;
  now?: Date;
};

/** Terms we will send without asking. Anything longer is the owner's call. */
const ORDINARY_BUYER_TERM_DAYS = 30;

export function approvalsRequired(context: ApprovalContext): ApprovalRequirement[] {
  const { economics, config } = context;
  const now = context.now ?? new Date();
  const out: ApprovalRequirement[] = [];

  const floor = config.marginRules.minimumGrossMarginPct;
  const limits = config.approvalLimits;

  // 1. Margin below the floor. A negative margin is the same rule, said louder.
  if (economics.grossMarginPct !== null && economics.grossMarginPct < floor) {
    out.push({
      type: 'MARGIN_EXCEPTION',
      title: `Margin ${economics.grossMarginPct.toFixed(1)}% is below the ${floor}% floor`,
      summary: economics.grossProfit !== null && economics.grossProfit < 0
        ? `This price is below cost. It loses ${money(Math.abs(economics.grossProfit))} on the deal as priced.`
        : `Gross profit is ${money(economics.grossProfit)} at ${economics.grossMarginPct.toFixed(1)}%, under the configured floor of ${floor}%.`,
      amount: economics.grossProfit,
    });
  }

  // 2. A price with nothing behind it. The margin is not low here — it is unknown,
  //    which is a different and worse thing to send.
  if (economics.costSideMissing) {
    out.push({
      type: 'PRICING',
      title: 'Priced without a provider cost',
      summary: 'No provider has given us a cost for this work, so the margin on this price is unknown rather than thin. Sending it commits us to a number we cannot yet stand behind.',
      amount: null,
    });
  }

  // 3. Cash out before cash in.
  if (economics.workingCapitalAmount !== null && economics.workingCapitalAmount > limits.cashExposureLimit) {
    out.push({
      type: 'WORKING_CAPITAL',
      title: `${money(economics.workingCapitalAmount)} of our own cash at risk`,
      summary: economics.workingCapitalDays !== null
        ? `We would be out ${money(economics.workingCapitalAmount)} for about ${economics.workingCapitalDays} days before the buyer pays. The configured limit is ${money(limits.cashExposureLimit)}.`
        : `We would be out ${money(economics.workingCapitalAmount)} before the buyer pays, and the duration is unknown. The configured limit is ${money(limits.cashExposureLimit)}.`,
      amount: economics.workingCapitalAmount,
    });
  }

  // 4. Terms nobody has agreed to carry.
  const buyerDays = paymentTermDays(context.buyerPaymentTerms);
  if (context.buyerPaymentTerms && buyerDays === null) {
    out.push({
      type: 'CREDIT_TERMS',
      title: 'Payment terms are not standard',
      summary: `The buyer terms read "${context.buyerPaymentTerms}", which is not one of the terms this system knows how to size exposure against. Somebody has to decide whether we can carry them.`,
      amount: null,
    });
  } else if (buyerDays !== null && buyerDays > ORDINARY_BUYER_TERM_DAYS) {
    out.push({
      type: 'CREDIT_TERMS',
      title: `Buyer terms of ${buyerDays} days`,
      summary: `Longer than the ${ORDINARY_BUYER_TERM_DAYS}-day terms we send without asking. Every extra day is our cash, not theirs.`,
      amount: null,
    });
  }

  // 5. Fulfilment we cannot yet stand behind.
  const fulfilmentProblems = fulfilmentRisks(context.provider, context.complianceGaps, now);
  if (fulfilmentProblems.length > 0) {
    out.push({
      type: 'HIGH_RISK_FULFILMENT',
      title: 'Fulfilment is not secured',
      summary: `${fulfilmentProblems.join(' ')} A buyer who accepts this expects the work to happen.`,
      amount: null,
    });
  }

  // 6. Size. Below the auto-approve line this is skipped — but only this one.
  //    A small deal with a negative margin still needs a decision.
  const value = economics.grossProfit !== null && economics.totalCost !== null
    ? economics.totalCost + economics.grossProfit
    : null;
  if (value !== null && value >= limits.autoApproveBelowValue) {
    if (value > limits.dealValueRequiringApproval) {
      out.push({
        type: 'DEAL_TERMS',
        title: `Deal value ${money(value)}`,
        summary: `Above the ${money(limits.dealValueRequiringApproval)} threshold at which deals are approved rather than sent.`,
        amount: value,
      });
    } else if (economics.grossProfit !== null && economics.grossProfit > limits.grossProfitRequiringApproval) {
      out.push({
        type: 'DEAL_TERMS',
        title: `Gross profit ${money(economics.grossProfit)}`,
        summary: `Above the ${money(limits.grossProfitRequiringApproval)} threshold at which deals are approved rather than sent.`,
        amount: economics.grossProfit,
      });
    }
  }

  // 7. Anything that binds us legally.
  if (context.legalCommitment) {
    out.push({
      type: 'CONTRACT_EXECUTION',
      title: 'Signing a contract',
      summary: 'This commitment is a signed agreement rather than an order. The obligations in it outlive the deal.',
      amount: value,
    });
  }

  return out;
}

/** The specific reasons fulfilment is not something to promise on. */
function fulfilmentRisks(provider: ProviderCandidate | null, complianceGaps: string[], now: Date): string[] {
  const problems: string[] = [];

  if (complianceGaps.length > 0) {
    problems.push(`We do not currently satisfy: ${complianceGaps.join(', ')}.`);
  }

  if (!provider) {
    problems.push('No provider is attached to this price.');
    return problems;
  }

  if (provider.state !== 'COMMITTED' && provider.state !== 'SELECTED') {
    problems.push(`The provider is at "${provider.state.toLowerCase().replace(/_/g, ' ')}", which is not an agreement to do the work.`);
  }
  if (!costIsUsable(provider, now)) {
    problems.push(
      provider.costExpiresAt === null
        ? 'Their cost has no expiry date, so we do not know whether it still holds.'
        : 'Their cost has expired.',
    );
  }
  if (provider.credentialsVerifiedAt === null) {
    problems.push('Their credentials have not been verified.');
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Raising them
// ---------------------------------------------------------------------------

/**
 * Write the approvals a quote needs, and retire the ones it no longer does.
 *
 * Idempotent by (quote, type): recomputing after an edit updates the existing
 * pending approval rather than stacking a second one, and a requirement that
 * has stopped applying is expired rather than left sitting in the owner's
 * queue as a decision about a number that no longer exists.
 *
 * Decisions already made are never touched. An owner who approved a 12% margin
 * has approved it; a later save that recomputes the same requirement does not
 * silently reopen the question, and a save that changes the numbers materially
 * is handled upstream by writing a new quote version instead.
 */
export async function syncQuoteApprovals(
  tx: Prisma.TransactionClient,
  options: {
    orgId: string;
    routeId: string;
    quoteId: string;
    requirements: ApprovalRequirement[];
    actorId?: string | null;
  },
): Promise<{ opened: number; updated: number; expired: number }> {
  const existing = await tx.approval.findMany({
    where: { routeQuoteId: options.quoteId, status: 'PENDING' },
  });

  const wanted = new Map(options.requirements.map((r) => [r.type, r]));
  let opened = 0;
  let updated = 0;
  let expired = 0;

  for (const approval of existing) {
    const still = wanted.get(approval.type);
    if (!still) {
      await tx.approval.update({
        where: { id: approval.id },
        data: { status: 'EXPIRED', decisionNote: 'No longer required — the numbers behind it changed.' },
      });
      expired += 1;
      continue;
    }
    if (approval.title !== still.title || approval.summary !== still.summary) {
      await tx.approval.update({
        where: { id: approval.id },
        data: { title: still.title, summary: still.summary, amount: still.amount },
      });
      updated += 1;
    }
    wanted.delete(approval.type);
  }

  for (const requirement of wanted.values()) {
    // An approval of this type already decided on this quote is not reopened.
    const decided = await tx.approval.findFirst({
      where: { routeQuoteId: options.quoteId, type: requirement.type, status: { in: ['APPROVED', 'REJECTED'] } },
    });
    if (decided) continue;

    const created = await tx.approval.create({
      data: {
        orgId: options.orgId,
        routeId: options.routeId,
        routeQuoteId: options.quoteId,
        type: requirement.type,
        status: 'PENDING',
        title: requirement.title,
        summary: requirement.summary,
        amount: requirement.amount,
        requestedById: options.actorId ?? null,
      },
    });
    opened += 1;

    await recordDealEvent(tx, {
      orgId: options.orgId,
      routeId: options.routeId,
      kind: 'approval.required',
      actorType: 'system',
      subjectType: 'Approval',
      subjectId: created.id,
      summary: `${requirement.title} — ${requirement.summary}`,
      after: { type: requirement.type, amount: requirement.amount },
    });
  }

  return { opened, updated, expired };
}

/**
 * Whether every approval this quote needs has been granted.
 *
 * Read from the approvals themselves rather than from a flag on the quote, so a
 * stale flag cannot let something out. Returns the outstanding ones, because an
 * operator blocked by "approval required" with no list has nowhere to go.
 */
export async function approvalGate(quote: Pick<RouteQuote, 'id' | 'approvalRequired'>): Promise<{
  cleared: boolean;
  pending: Array<{ id: string; type: ApprovalType; title: string }>;
  rejected: Array<{ id: string; type: ApprovalType; title: string; note: string | null }>;
}> {
  if (!quote.approvalRequired) return { cleared: true, pending: [], rejected: [] };

  const approvals = await prisma.approval.findMany({
    where: { routeQuoteId: quote.id, status: { in: ['PENDING', 'REJECTED', 'CHANGES_REQUESTED'] } },
    select: { id: true, type: true, title: true, status: true, decisionNote: true },
  });

  const pending = approvals
    .filter((a) => a.status === 'PENDING')
    .map((a) => ({ id: a.id, type: a.type, title: a.title }));
  const rejected = approvals
    .filter((a) => a.status === 'REJECTED' || a.status === 'CHANGES_REQUESTED')
    .map((a) => ({ id: a.id, type: a.type, title: a.title, note: a.decisionNote }));

  return { cleared: pending.length === 0 && rejected.length === 0, pending, rejected };
}

function money(value: number | null): string {
  if (value === null) return 'an unknown amount';
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}
