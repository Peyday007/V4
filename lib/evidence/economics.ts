import type { EconomicsBasis } from '@prisma/client';
import {
  calculate,
  confirmed,
  inferred,
  observed,
  present,
  unknown,
  type Evidenced,
  type EvidenceClass,
  type Presentation,
} from './class';

/**
 * The money on a route, graded by what is actually under it.
 *
 * This reads the grading the system already records — the quote's basis, whether
 * the cost side is missing, whether a payment settled — and turns it into the
 * one question a screen needs answered. Nothing new is stored and nothing is
 * re-judged: `EconomicsBasis` already distinguishes a playbook prior from a
 * received quote, and the failure was never that the distinction did not exist.
 * It was that a number derived from a prior and a number that had been invoiced
 * were rendered the same way, in the same row, and read out loud as one figure.
 */

/**
 * What each basis means about the evidence under it.
 *
 * PRIOR is the engine's own range for a category before anybody spoke to
 * anybody, and ESTIMATE has one side still assumed — neither is something an
 * owner should be shown as money. QUOTE has a provider's real cost and a price
 * we set; COMMITMENT has both sides agreed; REALISED has moved.
 */
const BASIS_EVIDENCE: Record<EconomicsBasis, EvidenceClass> = {
  PRIOR: 'INFERRED',
  ESTIMATE: 'INFERRED',
  QUOTE: 'EXTERNALLY_OBSERVED',
  COMMITMENT: 'CONFIRMED_BY_PERSON',
  REALISED: 'CONFIRMED_BY_PERSON',
};

const BASIS_SOURCE: Record<EconomicsBasis, string> = {
  PRIOR: 'The playbook\'s typical range for this kind of work, before anybody was spoken to.',
  ESTIMATE: 'One side of this is a real number and the other is still assumed.',
  QUOTE: 'A provider quoted the cost and a price was set against it.',
  COMMITMENT: 'Both sides committed at agreed numbers.',
  REALISED: 'Money that actually moved.',
};

const BASIS_TO_CONFIRM: Record<EconomicsBasis, string | null> = {
  PRIOR: 'Get a provider to price the work, and ask the buyer what they need.',
  ESTIMATE: 'Fill in whichever side is still assumed.',
  QUOTE: null,
  COMMITMENT: null,
  REALISED: null,
};

export type RouteMoney = {
  basis: EconomicsBasis;
  buyerPrice: number | null;
  providerCost: number | null;
  /** True when there is no provider cost behind the price at all. */
  costSideMissing: boolean;
};

/** The buyer price, graded. */
export function buyerPriceOf(money: RouteMoney): Evidenced<number> {
  if (money.buyerPrice === null) {
    return unknown('No price has been set for this buyer.', 'Set a price once a provider has quoted.');
  }
  const evidence = BASIS_EVIDENCE[money.basis];
  if (evidence === 'CONFIRMED_BY_PERSON') return confirmed(money.buyerPrice, BASIS_SOURCE[money.basis]);
  if (evidence === 'EXTERNALLY_OBSERVED') return observed(money.buyerPrice, BASIS_SOURCE[money.basis]);
  return inferred(money.buyerPrice, BASIS_SOURCE[money.basis], BASIS_TO_CONFIRM[money.basis] ?? '');
}

/** The provider cost, graded. */
export function providerCostOf(money: RouteMoney): Evidenced<number> {
  if (money.costSideMissing || money.providerCost === null) {
    return unknown(
      'No provider has priced this work, so there is no cost side.',
      'Ask a provider who can actually do it for a price, with an expiry.',
    );
  }
  const evidence = BASIS_EVIDENCE[money.basis];
  if (evidence === 'CONFIRMED_BY_PERSON') return confirmed(money.providerCost, BASIS_SOURCE[money.basis]);
  if (evidence === 'EXTERNALLY_OBSERVED') return observed(money.providerCost, BASIS_SOURCE[money.basis]);
  return inferred(money.providerCost, BASIS_SOURCE[money.basis], BASIS_TO_CONFIRM[money.basis] ?? '');
}

/**
 * Gross profit, which is where the rule earns its keep.
 *
 * A price minus a cost is a subtraction anybody can do. What makes the answer
 * meaningful is that both sides are real, and the composition rule enforces
 * exactly that: a real cost minus an assumed price yields an assumption, and
 * an assumption is not shown as money however carefully it was arrived at.
 */
export function grossProfitOf(money: RouteMoney): Evidenced<number> {
  return calculate(
    [buyerPriceOf(money), providerCostOf(money)],
    ([price, cost]) => price - cost,
    ([priceSource, costSource]) => `${priceSource} ${costSource}`,
  );
}

const currency = (n: number) => `$${Math.round(n).toLocaleString()}`;

/** Ready for a screen: a figure, or what is missing and what would fix it. */
export function presentMoney(value: Evidenced<number>): Presentation {
  return present(value, currency);
}

/**
 * The gross-profit pipeline, with the estimates left out of it.
 *
 * The dashboard has been showing this as a single number under the words
 * "Gross-profit pipeline", summed from every open opportunity's
 * `estimatedGrossProfit` — a figure produced by taking the midpoint of a
 * playbook's typical range for a category and multiplying by an assumed margin.
 * It is the number in this product most likely to be repeated out loud as
 * though it were revenue, and there was nothing under it at all.
 *
 * A total is now shown only for the quotes and deals whose cost side is real,
 * and it always says how many rows it excluded. When nothing qualifies the
 * answer is not zero — zero is a claim about the business — it is that there is
 * no total to show and why.
 */
export async function grossProfitPipeline(params: {
  prisma: {
    routeQuote: {
      findMany: (args: unknown) => Promise<Array<{
        basis: EconomicsBasis;
        buyerPrice: unknown;
        providerCost: unknown;
        costSideMissing: boolean;
      }>>;
    };
  };
  orgId: string;
  dataMode?: 'PRODUCTION' | 'TEST';
}): Promise<{
  total: number;
  counted: number;
  excluded: number;
  note: string;
  /** True when a figure may be shown at all. */
  showable: boolean;
}> {
  const quotes = await params.prisma.routeQuote.findMany({
    where: {
      orgId: params.orgId,
      dataMode: params.dataMode ?? 'PRODUCTION',
      // Superseded revisions are history, not pipeline; counting them would
      // add every price we have ever floated to the total.
      state: { in: ['DRAFT', 'SENT', 'ACCEPTED'] },
    },
    select: { basis: true, buyerPrice: true, providerCost: true, costSideMissing: true },
  });

  const rows = quotes.map((q) =>
    grossProfitOf({
      basis: q.basis,
      buyerPrice: q.buyerPrice === null ? null : Number(q.buyerPrice),
      providerCost: q.providerCost === null ? null : Number(q.providerCost),
      costSideMissing: q.costSideMissing,
    }),
  );

  const supported = rows.filter((r) => r.value !== null && r.evidence !== 'INFERRED' && r.evidence !== 'UNKNOWN');
  const total = supported.reduce((sum, r) => sum + (r.value as number), 0);

  return {
    total,
    counted: supported.length,
    excluded: rows.length - supported.length,
    showable: supported.length > 0,
    note:
      rows.length === 0
        ? 'No quote has been raised yet, so there is no pipeline to value.'
        : supported.length === 0
          ? `${rows.length} quote(s) exist and none has a provider cost behind it, so there is no gross `
            + 'profit to total. A figure here would be the sum of a set of assumptions.'
          : `From ${supported.length} quote(s) with a real provider cost`
            + (rows.length - supported.length > 0
              ? `; ${rows.length - supported.length} excluded for having no cost side.`
              : '.'),
  };
}
