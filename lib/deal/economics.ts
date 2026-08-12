import type { EconomicsBasis, EconomicsConfidence } from '@prisma/client';

/**
 * The arithmetic of a deal, and — more importantly — what the arithmetic is
 * allowed to claim.
 *
 * Pure. No database, no clock beyond what is handed in, so the same numbers can
 * be shown before a save and enforced after one.
 *
 * The rule that shapes the whole file: a missing cost is not a zero cost. It is
 * tempting to treat `null` as `0` because it makes every screen render and
 * every sort work, and the result is a board ranked by gross profit where the
 * top rows are the deals we know least about. So gross profit is null until
 * both sides are real, `costSideMissing` is carried alongside every number, and
 * ranking is required to exclude those rows rather than order them.
 */

export type EconomicsInput = {
  providerCost: number | null;
  freight?: number | null;
  fees?: number | null;
  contingency?: number | null;
  buyerPrice: number | null;
  /** Whether the provider cost came from a provider, unexpired, rather than from us. */
  costIsQuoted?: boolean;
  /** Whether both sides have committed at these numbers. */
  committed?: boolean;
  /** Whether these are amounts that have actually settled. */
  realised?: boolean;
  /** How complete the buyer requirement behind this is. */
  requirementReady?: boolean;
  /** Days we would be out of pocket before the buyer pays. */
  workingCapitalDays?: number | null;
  /** Explicit override; otherwise derived from the cost side. */
  workingCapitalAmount?: number | null;
};

export type Economics = {
  totalCost: number | null;
  grossProfit: number | null;
  grossMarginPct: number | null;
  basis: EconomicsBasis;
  confidence: EconomicsConfidence;
  costSideMissing: boolean;
  workingCapitalAmount: number | null;
  workingCapitalDays: number | null;
  /** Things a person should read before sending this. Never silently applied. */
  warnings: string[];
};

export function computeEconomics(input: EconomicsInput): Economics {
  const warnings: string[] = [];

  const costSideMissing = input.providerCost === null || input.providerCost === undefined;

  // Add-ons only count when there is a cost to add them to. Freight on top of
  // an unknown cost is still an unknown cost.
  const totalCost = costSideMissing
    ? null
    : round2(
        (input.providerCost ?? 0)
        + (input.freight ?? 0)
        + (input.fees ?? 0)
        + (input.contingency ?? 0),
      );

  const grossProfit =
    totalCost === null || input.buyerPrice === null || input.buyerPrice === undefined
      ? null
      : round2(input.buyerPrice - totalCost);

  const grossMarginPct =
    grossProfit === null || !input.buyerPrice || input.buyerPrice === 0
      ? null
      : round2((grossProfit / input.buyerPrice) * 100);

  const basis = basisFor(input, costSideMissing);
  const confidence = confidenceFor(input, basis, costSideMissing);

  if (costSideMissing) {
    warnings.push('No provider cost. Gross profit cannot be calculated, and this route must not be ranked on profit.');
  }
  if (!costSideMissing && (input.buyerPrice === null || input.buyerPrice === undefined)) {
    warnings.push('No buyer price yet. The cost side is known; the margin is not.');
  }
  if (grossProfit !== null && grossProfit < 0) {
    warnings.push('This price is below cost. Sending it loses money on every unit.');
  }
  if (!input.requirementReady && basis !== 'PRIOR') {
    warnings.push('The buyer requirement behind these numbers is incomplete, so the scope being priced is partly assumed.');
  }
  if (input.contingency === null || input.contingency === undefined) {
    if (!costSideMissing) warnings.push('No contingency. Any overrun comes straight out of the margin.');
  }

  const workingCapitalAmount =
    input.workingCapitalAmount ?? (input.workingCapitalDays && totalCost !== null ? totalCost : null);
  const workingCapitalDays = input.workingCapitalDays ?? null;

  if (workingCapitalAmount !== null && workingCapitalDays === null) {
    warnings.push('Capital is at risk but the duration is unknown, so the exposure cannot be sized.');
  }

  return {
    totalCost,
    grossProfit,
    grossMarginPct,
    basis,
    confidence,
    costSideMissing,
    workingCapitalAmount: workingCapitalAmount === null ? null : round2(workingCapitalAmount),
    workingCapitalDays,
    warnings,
  };
}

/**
 * Where these numbers came from.
 *
 * Ordered most-settled first, because a deal that has realised money is not
 * downgraded to an estimate because somebody left a field blank.
 */
function basisFor(input: EconomicsInput, costSideMissing: boolean): EconomicsBasis {
  if (input.realised) return 'REALISED';
  if (input.committed) return 'COMMITMENT';
  if (input.costIsQuoted && !costSideMissing && input.buyerPrice !== null && input.buyerPrice !== undefined) {
    return 'QUOTE';
  }
  if (!costSideMissing || (input.buyerPrice !== null && input.buyerPrice !== undefined)) return 'ESTIMATE';
  return 'PRIOR';
}

/**
 * How much weight the number carries — a separate question from where it came
 * from. A quote built on a shaky requirement is a real quote we should not lean
 * on, and collapsing the two ideas is how an engine estimate ends up in a
 * revenue report.
 */
function confidenceFor(input: EconomicsInput, basis: EconomicsBasis, costSideMissing: boolean): EconomicsConfidence {
  if (basis === 'REALISED') return 'HIGH';
  if (costSideMissing) return 'UNKNOWN';
  if (basis === 'PRIOR') return 'UNKNOWN';

  if (basis === 'COMMITMENT') return input.requirementReady ? 'HIGH' : 'MEDIUM';
  if (basis === 'QUOTE') return input.requirementReady ? 'HIGH' : 'MEDIUM';
  return input.requirementReady ? 'MEDIUM' : 'LOW';
}

/**
 * "Net 30" and friends, only when they are unambiguous.
 *
 * Returns null for anything else. Payment terms decide how much of our own cash
 * is at risk and for how long, and guessing at "on completion" produces a
 * working-capital figure that looks calculated and is not.
 */
export function paymentTermDays(terms: string | null | undefined): number | null {
  if (!terms) return null;
  const net = /^\s*net\s*(\d{1,3})\s*$/i.exec(terms);
  if (net) return Number(net[1]);
  const days = /^\s*(\d{1,3})\s*days?\s*$/i.exec(terms);
  if (days) return Number(days[1]);
  if (/^\s*(due on receipt|on receipt|cod|prepaid|payment in advance)\s*$/i.test(terms)) return 0;
  return null;
}

/**
 * How long our money is out, given when we pay the provider and when the buyer
 * pays us. Null whenever either side is unknown, rather than assuming zero.
 */
export function exposureDays(input: {
  buyerTerms: string | null | undefined;
  providerTerms: string | null | undefined;
  deliveryDays?: number | null;
}): number | null {
  const buyerDays = paymentTermDays(input.buyerTerms);
  const providerDays = paymentTermDays(input.providerTerms);
  if (buyerDays === null || providerDays === null) return null;
  const delivery = input.deliveryDays ?? 0;
  const gap = delivery + buyerDays - providerDays;
  return gap > 0 ? gap : 0;
}

/**
 * How this should be described in words, so no screen has to invent a phrasing
 * and accidentally upgrade an estimate.
 */
export const BASIS_LABELS: Record<EconomicsBasis, string> = {
  PRIOR: 'Engine estimate — nobody has been asked',
  ESTIMATE: 'Estimate — one side is real, one is assumed',
  QUOTE: 'Quoted — provider cost received, buyer price set',
  COMMITMENT: 'Agreed — both sides committed at these numbers',
  REALISED: 'Realised — money that actually moved',
};

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
