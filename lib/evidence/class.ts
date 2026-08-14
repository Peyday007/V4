/**
 * How well a value is known, and what follows from that.
 *
 * The product had four ways of grading a fact already — `FactStatus`,
 * `AssertionTier`, `EconomicsBasis`, `EconomicsConfidence` — each honest, each
 * used by a different part of the system, and none of them consulted at the
 * moment a number is put on a screen. So a gross-profit figure derived from a
 * playbook's typical range for a category, times an assumed margin, appeared in
 * the same typeface, in the same row, next to money that had actually been
 * invoiced. The grading existed; the display ignored it.
 *
 * This is deliberately not a fifth enum in the schema. Nothing new is stored.
 * It is one function that reads the grading already recorded and answers the
 * only question the screen needs answered: may this be shown as a figure, and
 * if not, what is missing?
 *
 * The composition rule is the whole thing. A calculation is only as good as its
 * weakest input, so a gross profit computed from a real provider cost and an
 * assumed buyer price is an assumption, not a calculation — and it says so, and
 * it is not displayed as money.
 */

/**
 * Re-exported from the schema rather than declared twice.
 *
 * It started as a TypeScript union here and became a database enum when
 * campaign evidence had to persist it. Two definitions of the same five values
 * would drift the first time somebody added a sixth, and the drift would be
 * silent — so there is one, and it lives where the data does.
 */
export type { EvidenceClass } from '@prisma/client';
import type { EvidenceClass } from '@prisma/client';

/**
 * Strongest to weakest.
 *
 * `UNKNOWN` sits below `INFERRED` rather than beside it, so that combining an
 * inference with a gap yields a gap: if one input is missing entirely, the
 * result is not a weaker guess, it is nothing.
 */
const RANK: Record<EvidenceClass, number> = {
  CONFIRMED_BY_PERSON: 4,
  EXTERNALLY_OBSERVED: 3,
  CALCULATED_FROM_CONFIRMED_INPUTS: 2,
  INFERRED: 1,
  UNKNOWN: 0,
};

/** Classes that may be shown as a figure without a qualifier. */
export function isSupported(evidence: EvidenceClass): boolean {
  return RANK[evidence] >= RANK.CALCULATED_FROM_CONFIRMED_INPUTS;
}

export function weakest(...classes: EvidenceClass[]): EvidenceClass {
  if (classes.length === 0) return 'UNKNOWN';
  return classes.reduce((worst, c) => (RANK[c] < RANK[worst] ? c : worst));
}

export const EVIDENCE_LABEL: Record<EvidenceClass, string> = {
  CONFIRMED_BY_PERSON: 'confirmed by a person',
  EXTERNALLY_OBSERVED: 'published by the source',
  CALCULATED_FROM_CONFIRMED_INPUTS: 'calculated from confirmed inputs',
  INFERRED: 'our inference',
  UNKNOWN: 'not known',
};

/** A value that carries how it came to be known. */
export type Evidenced<T> = {
  value: T | null;
  evidence: EvidenceClass;
  /** Where it came from, in one phrase an operator can check. */
  source: string;
  /** What would raise its class. Null when nothing would, or nothing need. */
  toConfirm: string | null;
};

export function confirmed<T>(value: T, source: string): Evidenced<T> {
  return { value, evidence: 'CONFIRMED_BY_PERSON', source, toConfirm: null };
}

export function observed<T>(value: T, source: string): Evidenced<T> {
  return { value, evidence: 'EXTERNALLY_OBSERVED', source, toConfirm: null };
}

export function inferred<T>(value: T, source: string, toConfirm: string): Evidenced<T> {
  return { value, evidence: 'INFERRED', source, toConfirm };
}

export function unknown<T>(source: string, toConfirm: string): Evidenced<T> {
  return { value: null, evidence: 'UNKNOWN', source, toConfirm };
}

/**
 * Arithmetic that inherits the weakest input's class.
 *
 * The rule that stops "calculated" being a laundry. A gross profit is only a
 * calculation from confirmed inputs when the price and the cost are both real;
 * put one assumption in and what comes out is an assumption with a decimal
 * point on it.
 *
 * A missing input yields a missing result rather than a number computed from
 * the ones that happen to be there.
 */
export function calculate<T>(
  inputs: Array<Evidenced<number>>,
  compute: (values: number[]) => T,
  describe: (parts: string[]) => string,
): Evidenced<T> {
  const missing = inputs.filter((i) => i.value === null);
  if (missing.length > 0) {
    return {
      value: null,
      evidence: 'UNKNOWN',
      source: `Cannot be worked out: ${missing.map((m) => m.source).join('; ')}.`,
      toConfirm: missing.map((m) => m.toConfirm).filter((t): t is string => Boolean(t)).join(' ') || null,
    };
  }

  const floor = weakest(...inputs.map((i) => i.evidence));
  const value = compute(inputs.map((i) => i.value as number));
  return {
    value,
    // Confirmed and observed inputs make a calculation; an inferred input makes
    // the whole thing an inference, however sound the arithmetic.
    evidence: RANK[floor] >= RANK.EXTERNALLY_OBSERVED ? 'CALCULATED_FROM_CONFIRMED_INPUTS' : floor,
    source: describe(inputs.map((i) => i.source)),
    toConfirm: inputs.find((i) => RANK[i.evidence] <= RANK.INFERRED)?.toConfirm ?? null,
  };
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export type Presentation =
  | { show: true; evidence: EvidenceClass; label: string; source: string }
  /**
   * Not a blank and not a dash. A suppressed figure has to say what is missing,
   * or the screen has simply become quieter rather than more honest.
   */
  | { show: false; evidence: EvidenceClass; instead: string; toConfirm: string | null };

/**
 * Whether a number may be shown as a number.
 *
 * The rule: money and anything an owner would act on financially is shown only
 * when it is confirmed, observed, or calculated wholly from those. Otherwise
 * the space says what would have to happen for a figure to exist there — which
 * is more useful than the figure would have been, because it is actionable and
 * it is true.
 */
export function present<T>(
  value: Evidenced<T>,
  format: (v: T) => string,
): Presentation {
  if (value.value !== null && isSupported(value.evidence)) {
    return {
      show: true,
      evidence: value.evidence,
      label: format(value.value),
      source: value.source,
    };
  }

  return {
    show: false,
    evidence: value.evidence,
    instead:
      value.evidence === 'UNKNOWN'
        ? value.source
        : `Not shown: this rests on ${EVIDENCE_LABEL[value.evidence]}. ${value.source}`,
    toConfirm: value.toConfirm,
  };
}

/**
 * The same rule applied to a total.
 *
 * Summing a column of estimates produces a number with more digits and no more
 * truth, and a pipeline total is the single figure most likely to be repeated
 * out loud as though it were revenue. A total is shown only for the supported
 * rows, and always says how many rows it left out and why.
 */
export function totalOf(
  rows: Array<Evidenced<number>>,
): {
  total: number;
  counted: number;
  excluded: number;
  evidence: EvidenceClass;
  note: string;
} {
  const supported = rows.filter((r) => r.value !== null && isSupported(r.evidence));
  const total = supported.reduce((sum, r) => sum + (r.value as number), 0);
  const excluded = rows.length - supported.length;

  return {
    total,
    counted: supported.length,
    excluded,
    evidence: supported.length === 0 ? 'UNKNOWN' : weakest(...supported.map((r) => r.evidence)),
    note:
      rows.length === 0
        ? 'Nothing to total.'
        : excluded === 0
          ? `${supported.length} of ${rows.length}, all resting on confirmed or observed inputs.`
          : supported.length === 0
            ? `None of ${rows.length} rest on anything better than an inference, so there is no total to show. `
              + 'A figure here would be the sum of a set of guesses.'
            : `${supported.length} of ${rows.length}. ${excluded} excluded because they rest on inference `
              + 'rather than a confirmed or observed input.',
  };
}
