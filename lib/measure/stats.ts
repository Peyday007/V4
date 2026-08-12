/**
 * The small amount of statistics this system is allowed to do.
 *
 * Pure, and deliberately conservative. The failure mode being designed against
 * is not a wrong formula — it is a right formula applied to four observations
 * and rendered as "Caller A converts 50% better than Caller B", which is a
 * sentence somebody acts on.
 *
 * So every rate here carries an interval, every comparison can return "not
 * enough evidence", and nothing exposes a bare percentage without the sample
 * size beside it.
 */

export type Rate = {
  successes: number;
  trials: number;
  /** Null when there were no trials. Zero trials is not a zero rate. */
  rate: number | null;
  /** Wilson score interval, 95%. Null when there were no trials. */
  low: number | null;
  high: number | null;
  /** How wide the interval is. A wide one is the honest answer to a small sample. */
  width: number | null;
  /** True when the sample is too small for the rate to mean anything. */
  weak: boolean;
};

/** Below this many trials, a rate is a story about a handful of events. */
export const MIN_TRIALS = 20;

/** 95% two-sided. */
const Z = 1.959964;

/**
 * A rate with a Wilson score interval.
 *
 * Wilson rather than the textbook normal approximation, for one practical
 * reason: the rates in this business are often near zero — 2% answer rates,
 * 1% conversion — and the normal interval goes negative there, which produces
 * a dashboard claiming a source might convert at minus four percent. Wilson
 * stays inside 0..1 and behaves at small n, which is every sample here for the
 * first several months.
 */
export function rate(successes: number, trials: number, minTrials = MIN_TRIALS): Rate {
  if (trials <= 0) {
    return { successes, trials, rate: null, low: null, high: null, width: null, weak: true };
  }

  const p = successes / trials;
  const z2 = Z * Z;
  const denominator = 1 + z2 / trials;
  const centre = (p + z2 / (2 * trials)) / denominator;
  const spread = (Z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials)) / denominator;

  const low = clamp01(centre - spread);
  const high = clamp01(centre + spread);

  return {
    successes,
    trials,
    rate: round4(p),
    low: round4(low),
    high: round4(high),
    width: round4(high - low),
    weak: trials < minTrials,
  };
}

export type Comparison = {
  /** 'better' | 'worse' | 'no_difference' | 'insufficient_evidence' */
  verdict: 'better' | 'worse' | 'no_difference' | 'insufficient_evidence';
  /** Written for a person deciding what to do, not a p-value. */
  because: string;
  /** Difference in rate, treatment minus control. Null when it cannot be read. */
  difference: number | null;
};

/**
 * Whether one rate is genuinely different from another.
 *
 * Deliberately blunt: non-overlapping 95% intervals, plus a sample floor on
 * both sides. That is a more conservative test than a two-proportion z-test,
 * which is the point — this decides whether somebody rolls a change out to
 * every caller, and being slow to say "better" costs less than being wrong.
 *
 * "No difference" and "not enough evidence" are separate answers, because they
 * lead to different actions: one ends the experiment, the other continues it.
 */
export function compare(
  treatment: Rate,
  control: Rate,
  minTrials = MIN_TRIALS,
): Comparison {
  if (treatment.trials < minTrials || control.trials < minTrials) {
    return {
      verdict: 'insufficient_evidence',
      because: `Not enough yet: ${treatment.trials} and ${control.trials} observations against a floor of ${minTrials} each. This is not a null result — it is an unfinished one.`,
      difference: null,
    };
  }

  if (treatment.rate === null || control.rate === null
    || treatment.low === null || treatment.high === null
    || control.low === null || control.high === null) {
    return { verdict: 'insufficient_evidence', because: 'One side has no observations at all.', difference: null };
  }

  const difference = round4(treatment.rate - control.rate);

  if (treatment.low > control.high) {
    return {
      verdict: 'better',
      because: `${pct(treatment.rate)} against ${pct(control.rate)}, and the ranges do not overlap (${pct(treatment.low)}–${pct(treatment.high)} versus ${pct(control.low)}–${pct(control.high)}).`,
      difference,
    };
  }

  if (treatment.high < control.low) {
    return {
      verdict: 'worse',
      because: `${pct(treatment.rate)} against ${pct(control.rate)}, and the ranges do not overlap (${pct(treatment.low)}–${pct(treatment.high)} versus ${pct(control.low)}–${pct(control.high)}).`,
      difference,
    };
  }

  return {
    verdict: 'no_difference',
    because: `${pct(treatment.rate)} against ${pct(control.rate)}, but the ranges overlap (${pct(treatment.low)}–${pct(treatment.high)} versus ${pct(control.low)}–${pct(control.high)}), so the gap could be noise.`,
    difference,
  };
}

/**
 * A comparison across strata, combined.
 *
 * The reason this exists rather than a single pooled rate: callers and sources
 * do not receive the same work. A caller handed active demand will out-convert
 * one handed directory prospects at every skill level, and comparing their
 * pooled rates measures the allocation rather than the callers. Weighting each
 * stratum by its size and combining is the cheapest correction that is honest
 * about what it is doing.
 *
 * Strata with no control observations are excluded rather than assumed, and
 * how many were dropped is reported — a comparison resting on one stratum out
 * of six is a comparison the reader should distrust.
 */
export type Stratum = {
  key: string;
  treatment: { successes: number; trials: number };
  control: { successes: number; trials: number };
};

export type AdjustedComparison = {
  verdict: 'better' | 'worse' | 'no_difference' | 'insufficient_evidence';
  because: string;
  /** Weighted difference across comparable strata. */
  difference: number | null;
  /** Strata that could be compared. */
  used: string[];
  /** Strata dropped because one side was empty. */
  dropped: string[];
};

export function compareAdjusted(strata: Stratum[], minTrials = MIN_TRIALS): AdjustedComparison {
  const used: string[] = [];
  const dropped: string[] = [];

  let weighted = 0;
  let weight = 0;
  let treatmentTrials = 0;
  let controlTrials = 0;

  for (const stratum of strata) {
    if (stratum.treatment.trials === 0 || stratum.control.trials === 0) {
      dropped.push(stratum.key);
      continue;
    }
    const size = stratum.treatment.trials + stratum.control.trials;
    const difference = stratum.treatment.successes / stratum.treatment.trials
      - stratum.control.successes / stratum.control.trials;
    weighted += difference * size;
    weight += size;
    treatmentTrials += stratum.treatment.trials;
    controlTrials += stratum.control.trials;
    used.push(stratum.key);
  }

  if (used.length === 0 || treatmentTrials < minTrials || controlTrials < minTrials) {
    return {
      verdict: 'insufficient_evidence',
      because: used.length === 0
        ? 'No stratum has observations on both sides, so there is nothing comparable to compare.'
        : `Only ${treatmentTrials} and ${controlTrials} comparable observations against a floor of ${minTrials} each.`,
      difference: null,
      used,
      dropped,
    };
  }

  const difference = round4(weighted / weight);

  // The interval is taken from the pooled totals, which is approximate and
  // stated as such. A stratum-exact interval would need more machinery than
  // this decision justifies, and pretending otherwise would be the same error
  // in the opposite direction.
  const treatmentSuccesses = strata.filter((s) => used.includes(s.key)).reduce((n, s) => n + s.treatment.successes, 0);
  const controlSuccesses = strata.filter((s) => used.includes(s.key)).reduce((n, s) => n + s.control.successes, 0);
  const t = rate(treatmentSuccesses, treatmentTrials, minTrials);
  const c = rate(controlSuccesses, controlTrials, minTrials);
  const pooled = compare(t, c, minTrials);

  const note = dropped.length > 0
    ? ` ${dropped.length} stratum/strata excluded because one side had no work: ${dropped.join(', ')}.`
    : '';

  return {
    verdict: pooled.verdict,
    because: `Adjusted across ${used.length} stratum/strata. ${pooled.because}${note}`,
    difference,
    used,
    dropped,
  };
}

export function pct(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round4(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}
