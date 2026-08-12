import type { CallerScorecard } from '@/lib/measure/analytics';

/**
 * Excellence worth copying.
 *
 * A system that only ever looks for problems finds only problems, and the
 * people it reports on learn that being noticed is bad news. That is not a
 * morale point — it is an accuracy point. The most valuable thing in a fortnight
 * of calls is usually one person's way of getting past a gatekeeper, and
 * nothing in a consistency sweep will ever surface it.
 *
 * Two rules keep this honest:
 *
 *   Never reward speed that sacrifices quality. A caller with twice the dials
 *   and half the notes is not the top of this list; a strength claim checks the
 *   quality side before it checks the rate.
 *
 *   Weak samples produce "insufficient evidence", not a recommendation. The
 *   scorecards already carry their own uncertainty, and this reads it rather
 *   than averaging it away.
 */

export type Strength = {
  callerId: string;
  callerName: string;
  what: string;
  /** The numbers, with their uncertainty, so it can be checked. */
  evidence: string;
  /** What somebody should do with this. Never "well done". */
  suggestion: string;
};

export type StrengthFinding = {
  strengths: Strength[];
  /** Claims that were not made, and why. Absence of a number is not a zero. */
  withheld: string[];
};

/**
 * The comparison group.
 *
 * Rates are only comparable against callers working the same kind of list, so
 * the baseline is the median of the peers who have enough work to be in it at
 * all — not the mean, which one exceptional fortnight drags upward.
 */
function median(values: number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function findStrengths(scorecards: CallerScorecard[]): StrengthFinding {
  const strengths: Strength[] = [];
  const withheld: string[] = [];

  const usable = scorecards.filter((s) => !s.insufficientEvidence);
  const excluded = scorecards.length - usable.length;
  if (excluded > 0) {
    withheld.push(
      `${excluded} caller(s) are absent from this section because their sample is too small to read. That is not a judgement about them in either direction.`,
    );
  }
  if (usable.length < 2) {
    withheld.push(
      'No strength claims at all: with fewer than two comparable callers there is no baseline, and "best of one" is not a finding.',
    );
    return { strengths, withheld };
  }

  const baselineRelevant = median(usable.map((s) => s.relevantPerson.rate ?? 0));
  const baselineDiscovery = median(usable.map((s) => s.discoveryCompleteness.rate ?? 0));
  const baselineKept = median(usable.map((s) => (s.promisesMade > 0 ? s.promisesKept / s.promisesMade : 0)));

  for (const card of usable) {
    // --- decision-maker access, quality-gated ------------------------------
    const relevant = card.relevantPerson;
    if (
      baselineRelevant !== null
      && relevant.rate !== null
      && !relevant.weak
      // The interval, not the point estimate. A rate whose lower bound is below
      // the pack is a rate that might be the pack.
      && (relevant.low ?? 0) > baselineRelevant
      // Quality first: reaching more people while writing less down is not a
      // strength, it is a trade nobody agreed to.
      && (card.discoveryCompleteness.rate ?? 0) >= (baselineDiscovery ?? 0)
      && card.emptyOutcomes === 0
    ) {
      strengths.push({
        callerId: card.callerId,
        callerName: card.name,
        what: 'Gets to the person who can speak to the requirement more often than anybody else, without writing less down.',
        evidence: `${relevant.successes}/${relevant.trials} attempts reached a relevant person (${pct(relevant.rate)}, ${pct(relevant.low)}–${pct(relevant.high)}), against a median of ${pct(baselineRelevant)}. No empty outcomes.`,
        suggestion: 'Listen to three of these calls and write down what they say in the first fifteen seconds. That is a script change, not a compliment.',
      });
    }

    // --- promises kept -----------------------------------------------------
    const keptRate = card.promisesMade > 0 ? card.promisesKept / card.promisesMade : null;
    if (
      keptRate !== null
      && card.promisesMade >= 5
      && baselineKept !== null
      && keptRate >= 0.95
      && keptRate > baselineKept
    ) {
      strengths.push({
        callerId: card.callerId,
        callerName: card.name,
        what: 'Keeps what they promise. Every callback they committed to happened.',
        evidence: `${card.promisesKept} of ${card.promisesMade} promises kept, against a median of ${pct(baselineKept)}.`,
        suggestion: 'Ask how they track them. If the answer is "a notebook", that is a gap in this product, not a knack.',
      });
    }

    // --- information capture ----------------------------------------------
    const discovery = card.discoveryCompleteness;
    if (
      discovery.rate !== null
      && !discovery.weak
      && baselineDiscovery !== null
      && (discovery.low ?? 0) > baselineDiscovery
      && discovery.rate >= 0.9
    ) {
      strengths.push({
        callerId: card.callerId,
        callerName: card.name,
        what: 'Comes off a call with the facts the deal actually needs.',
        evidence: `${pct(discovery.rate)} of required fields captured (${pct(discovery.low)}–${pct(discovery.high)}), against a median of ${pct(baselineDiscovery)}.`,
        suggestion: 'Take their phrasing for the two fields everybody else misses and put it in the script.',
      });
    }

    // --- downstream, the only one that is about money ---------------------
    if (card.collectedGrossProfitInfluenced > 0) {
      strengths.push({
        callerId: card.callerId,
        callerName: card.name,
        what: 'Work that reached money that arrived.',
        evidence: `${card.dealsInfluenced} deal(s) on routes they worked, ${money(card.collectedGrossProfitInfluenced)} collected gross profit.`,
        suggestion: 'Trace these back to the source and the script version. This is the only performance signal here that is downstream of an invoice being paid.',
      });
    }
  }

  if (strengths.length === 0) {
    withheld.push(
      'No strength claims this period. Nobody\'s interval cleared the pack, which is the ordinary result for a small team over a short window — not evidence that nobody did well.',
    );
  }

  // Money last: a strength about collected profit is worth more than one about
  // a rate, and a list that opens with rates buries it.
  return {
    strengths: strengths.sort((a, b) => Number(b.what.includes('money')) - Number(a.what.includes('money'))),
    withheld,
  };
}

function pct(value: number | null): string {
  return value === null ? 'no rate' : `${Math.round(value * 100)}%`;
}

function money(amount: number): string {
  return `$${amount.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}
