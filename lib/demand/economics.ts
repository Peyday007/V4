import type { FrictionLevel, SignalCategory } from '@prisma/client';
import type { Playbook } from './playbooks';

/**
 * Economics, and choosing the commercial structure.
 *
 * Two rules shape this module.
 *
 * Estimates are labelled by where they came from. A playbook's typical range
 * is a prior, not a quote, and presenting a prior as a number the buyer might
 * pay is how a pipeline acquires a value nobody can collect. `basis` travels
 * with every figure, and a route with no usable basis carries nulls rather
 * than a confident zero.
 *
 * The commercial structure is chosen from the evidence, never from the name of
 * the connector or the query that found the record. A search called
 * "subcontracting" returning a cleaning company does not make a subcontracting
 * deal — it makes a supply-side company that happened to match a query.
 */

export type EconomicsInput = {
  playbook: Playbook;
  /** Square footage or unit count where the source published one. */
  scaleHint: number | null;
  /** Providers who could actually do the work. Zero means no cost basis. */
  availableProviders: number;
  friction: FrictionLevel;
};

export type Economics = {
  buyerPrice: number | null;
  providerCost: number | null;
  grossProfit: number | null;
  marginPct: number | null;
  humanMinutes: number;
  /** Where these numbers came from. Always present when a number is. */
  basis: string;
  /** Profit per hour of human attention. The number that ranks work. */
  profitPerHumanHour: number | null;
};

/**
 * Friction costs time, and time is the scarce resource.
 *
 * Multipliers on the playbook's expected human minutes. An unknown assessment
 * is treated as expensive rather than cheap: the research call is real work,
 * and assuming otherwise is what makes an unqualified board look attractive.
 */
const FRICTION_TIME_MULTIPLIER: Record<FrictionLevel, number> = {
  LOW: 1,
  MODERATE: 1.8,
  HIGH: 3.5,
  UNKNOWN_RESEARCH_REQUIRED: 1.6,
};

export function estimateEconomics(input: EconomicsInput): Economics {
  const { playbook } = input;
  const humanMinutes = Math.round(
    playbook.typicalHumanMinutes * FRICTION_TIME_MULTIPLIER[input.friction],
  );

  // Without a provider there is no cost side, and a gross profit computed from
  // a margin assumption alone is a number pretending to be a calculation.
  if (input.availableProviders <= 0) {
    return {
      buyerPrice: null,
      providerCost: null,
      grossProfit: null,
      marginPct: null,
      humanMinutes,
      basis:
        'No provider can price this yet, so there is no cost side and no honest gross profit. ' +
        'The buyer-price range for this playbook is a prior, not a quote.',
      profitPerHumanHour: null,
    };
  }

  // Midpoint of the playbook range, nudged by scale where the source gave one.
  const { low, high } = playbook.typicalBuyerPrice;
  const midpoint = (low + high) / 2;
  const scaled = input.scaleHint ? scaleAdjust(midpoint, low, high, input.scaleHint) : midpoint;

  const buyerPrice = Math.round(scaled);
  const grossProfit = Math.round(buyerPrice * (playbook.typicalMarginPct / 100));
  const providerCost = buyerPrice - grossProfit;

  return {
    buyerPrice,
    providerCost,
    grossProfit,
    marginPct: playbook.typicalMarginPct,
    humanMinutes,
    basis:
      `Playbook prior for ${playbook.label.toLowerCase()}: $${low.toLocaleString()}–$${high.toLocaleString()} ` +
      `at ${playbook.typicalMarginPct}% margin` +
      `${input.scaleHint ? `, adjusted for a stated scale of ${input.scaleHint.toLocaleString()}` : ''}. ` +
      `Not a quote — no provider has priced this and no buyer has been asked.`,
    profitPerHumanHour: humanMinutes > 0 ? Math.round((grossProfit / humanMinutes) * 60) : null,
  };
}

/**
 * Nudges the midpoint by scale without ever leaving the playbook's range.
 *
 * A stated square footage is real information and should move the estimate,
 * but not out of the band the playbook says this kind of work sells in — a
 * large number in a permit record is not licence to invent a large deal.
 */
function scaleAdjust(midpoint: number, low: number, high: number, scale: number): number {
  const TYPICAL_SCALE = 4000;
  const ratio = Math.max(0.4, Math.min(2.5, scale / TYPICAL_SCALE));
  return Math.max(low, Math.min(high, midpoint * ratio));
}

// ---------------------------------------------------------------------------
// Commercial structure
// ---------------------------------------------------------------------------

export type CommercialStructure =
  | 'REFERRAL'
  | 'BROKERAGE'
  | 'SUBCONTRACTING'
  | 'DISTRIBUTION_RESALE'
  | 'PROCUREMENT_AGENT'
  | 'MANAGED_SERVICE'
  | 'DIRECT_INTRODUCTION';

export type StructureChoice = {
  structure: CommercialStructure;
  reason: string;
  /** Structures ruled out, and why. Keeps the choice arguable. */
  rejected: Array<{ structure: CommercialStructure; because: string }>;
};

/**
 * Picks how we would actually transact.
 *
 * Driven by who owns the work, who holds the money, what capital we would be
 * exposed to and what compliance the route carries — not by the business path
 * whose connector happened to surface the record.
 */
export function chooseStructure(input: {
  route: SignalCategory;
  /** A prime already holds the contract and we would work under them. */
  primeHoldsWork: boolean;
  /** We would take the buyer's money and pay the provider. */
  canContractWithBuyer: boolean;
  /** Physical goods change hands. */
  involvesGoods: boolean;
  friction: FrictionLevel;
  grossProfit: number | null;
  /** Regulatory registration we do not currently hold. */
  blockingCompliance: string | null;
}): StructureChoice {
  const rejected: StructureChoice['rejected'] = [];

  if (input.blockingCompliance) {
    rejected.push(
      { structure: 'BROKERAGE', because: `blocked by ${input.blockingCompliance}` },
      { structure: 'DISTRIBUTION_RESALE', because: `blocked by ${input.blockingCompliance}` },
    );
    return {
      structure: 'REFERRAL',
      reason:
        `We cannot contract for this work while ${input.blockingCompliance} is outstanding. A referral fee ` +
        `keeps the relationship and the revenue without taking on a liability we are not licensed to carry.`,
      rejected,
    };
  }

  if (input.primeHoldsWork) {
    rejected.push({ structure: 'BROKERAGE', because: 'the prime already holds the buyer relationship' });
    return {
      structure: 'SUBCONTRACTING',
      reason:
        'A prime contractor owns the customer contract and needs local fulfilment. We sit underneath them, ' +
        'which caps the margin but removes the sales cycle entirely.',
      rejected,
    };
  }

  if (input.involvesGoods) {
    if (!input.canContractWithBuyer) {
      rejected.push({ structure: 'DISTRIBUTION_RESALE', because: 'we cannot hold the buyer contract' });
      return {
        structure: 'DIRECT_INTRODUCTION',
        reason: 'Goods, but no route to contract with the buyer. Introduce the wholesaler and take a fee.',
        rejected,
      };
    }
    return {
      structure: 'DISTRIBUTION_RESALE',
      reason:
        'Consumables bought at wholesale and resold. Working capital is small and short, and there is no crew ' +
        'to schedule, which is why this is the fastest route to a first transaction.',
      rejected,
    };
  }

  // Services. High friction plus thin profit is not worth carrying delivery
  // risk for; hand it over and keep the relationship.
  if (input.friction === 'HIGH' && (input.grossProfit ?? 0) < 1500) {
    rejected.push({
      structure: 'BROKERAGE',
      because: 'high relationship cost against a small margin does not justify carrying delivery risk',
    });
    return {
      structure: 'REFERRAL',
      reason:
        'The relationship work costs more than the margin justifies. Referring it keeps the account without ' +
        'committing crew time to a deal that loses money on attention.',
      rejected,
    };
  }

  if (!input.canContractWithBuyer) {
    return {
      structure: 'DIRECT_INTRODUCTION',
      reason: 'No route to hold the buyer contract, so the value we add is the introduction itself.',
      rejected,
    };
  }

  rejected.push({ structure: 'SUBCONTRACTING', because: 'no prime holds this work; the buyer is direct' });
  return {
    structure: 'BROKERAGE',
    reason:
      'We contract with the buyer and place a provider underneath. The spread is ours and so is the delivery ' +
      'risk, which is the right trade when the buyer is reachable directly.',
    rejected,
  };
}

/**
 * The minimum gross profit worth a serious pursuit, given what it will cost in
 * human time. Below this the opportunity is a distraction however real it is.
 */
export function meetsEconomicFloor(input: {
  grossProfit: number | null;
  humanMinutes: number;
  minimumProfitPerHour: number;
}): { passes: boolean; reason: string } {
  if (input.grossProfit === null) {
    return { passes: false, reason: 'Gross profit cannot be estimated yet, so the economics are unknown.' };
  }
  const perHour = (input.grossProfit / Math.max(1, input.humanMinutes)) * 60;
  if (perHour < input.minimumProfitPerHour) {
    return {
      passes: false,
      reason:
        `$${Math.round(perHour)} of gross profit per hour of human time, against a floor of ` +
        `$${input.minimumProfitPerHour}. The work is real; it is not worth the attention it would take.`,
    };
  }
  return {
    passes: true,
    reason: `$${Math.round(perHour)} of gross profit per hour of human time.`,
  };
}
