import type { EvidenceClass } from '@prisma/client';
import { calculate, confirmed, inferred, observed, present, unknown, type Evidenced } from './class';

/**
 * Grading the claims a screen makes, not just the money.
 *
 * The first pass at this stopped one dashboard total summing playbook priors.
 * That was one number. The same fabrication was everywhere else and louder: a
 * closing probability of 0.1 that nobody set, rendered as "10%" beside a
 * progress meter; an information-completeness score of 0.35 shown to two
 * significant figures; a fulfilment confidence that is a column default
 * presented as a judgement about a supplier.
 *
 * Unsupported precision is the specific fault. "10%" is a claim about one deal
 * in ten closing. Nothing in the system has ever observed that, and the figure
 * exists because a column needed a default. The honest rendering is not a
 * rounder number — it is no number, and a sentence saying what would produce
 * one.
 *
 * Every grader here answers the same question the money graders answer: what
 * is under this, and may it be shown?
 */

// ---------------------------------------------------------------------------
// Scores and probabilities
// ---------------------------------------------------------------------------

/**
 * A score is only as good as the inputs it was computed from.
 *
 * The scoring model is deterministic and defensible *given* its inputs. The
 * trouble is that it runs whether or not those inputs exist: an opportunity
 * nobody has spoken to, with no confirmed requirement and no provider, still
 * gets a composite to three decimal places. The score is not wrong; the
 * precision is a lie about how much is known.
 */
export function gradeScore(input: {
  value: number | null;
  /** Fields the score depends on that have actually been established. */
  inputsPresent: number;
  inputsTotal: number;
  what: string;
}): Evidenced<number> {
  if (input.value === null) {
    return unknown(`No ${input.what} has been computed.`, 'It is computed once the deal has inputs.');
  }
  if (input.inputsTotal === 0) {
    return inferred(input.value, `${input.what}, computed from nothing in particular.`, 'Establish the inputs.');
  }

  const share = input.inputsPresent / input.inputsTotal;
  if (share >= 0.8) {
    return {
      value: input.value,
      evidence: 'CALCULATED_FROM_CONFIRMED_INPUTS',
      source: `${input.what}, computed from ${input.inputsPresent} of ${input.inputsTotal} inputs.`,
      toConfirm: null,
    };
  }
  return inferred(
    input.value,
    `${input.what}, but only ${input.inputsPresent} of ${input.inputsTotal} inputs are established — `
    + 'the rest are defaults.',
    `Establish the remaining ${input.inputsTotal - input.inputsPresent} input(s).`,
  );
}

/**
 * A probability nobody has evidence for.
 *
 * Kept separate from scores because the failure is worse. A score is at least
 * described as a score; a probability is read as a forecast, and a forecast
 * with no history behind it is the most confident-sounding fabrication a
 * product can make. Until enough deals have closed to know a rate, this is
 * unknown — not 10%.
 */
export function gradeProbability(input: {
  value: number | null;
  /** Closed deals of this kind. Below the floor there is no rate to know. */
  observations: number;
  minimumObservations?: number;
}): Evidenced<number> {
  const floor = input.minimumObservations ?? 20;
  if (input.value === null) return unknown('No closing probability has been set.', 'It needs a history to rest on.');

  if (input.observations < floor) {
    return {
      value: null,
      evidence: 'UNKNOWN',
      source:
        `Only ${input.observations} comparable deal(s) have closed or been lost. A closing rate needs about `
        + `${floor} before it means anything, and a percentage shown now would be a guess wearing a decimal point.`,
      toConfirm: `Close or lose about ${floor - input.observations} more deal(s) of this kind.`,
    };
  }
  return {
    value: input.value,
    evidence: 'CALCULATED_FROM_CONFIRMED_INPUTS',
    source: `From ${input.observations} closed deal(s) of this kind.`,
    toConfirm: null,
  };
}

/**
 * Expected value: the product of a price, a probability and a confidence.
 *
 * The composition rule makes this one nearly always unknown early on, and that
 * is correct. Multiplying a real price by an invented probability produces a
 * number with the authority of arithmetic and the content of a wish, and it is
 * the figure most likely to be put in front of somebody as a reason to spend a
 * morning on one deal rather than another.
 */
export function gradeExpectedValue(input: {
  grossProfit: Evidenced<number>;
  closingProbability: Evidenced<number>;
}): Evidenced<number> {
  return calculate(
    [input.grossProfit, input.closingProbability],
    ([gp, p]) => gp * p,
    ([gpSource, pSource]) => `${gpSource} ${pSource}`,
  );
}

// ---------------------------------------------------------------------------
// Buyer and provider claims
// ---------------------------------------------------------------------------

/**
 * A field on a buyer requirement.
 *
 * `confirmedFields` records which parts of a requirement the buyer themselves
 * stated. Everything else on the record is our reading of an event, and the
 * two were rendered identically — so a square footage nobody had asked about
 * sat beside one the facilities manager had read off a lease.
 */
export function gradeRequirementField(input: {
  field: string;
  value: string | number | null;
  confirmedFields: string[];
  /** Where the unconfirmed version came from. */
  derivedFrom: string | null;
}): Evidenced<string | number> {
  if (input.value === null || input.value === '') {
    return unknown(`${input.field} is not known.`, `Ask on the next call.`);
  }
  if (input.confirmedFields.includes(input.field)) {
    return confirmed(input.value, `${input.field}, as stated by the buyer.`);
  }
  return inferred(
    input.value,
    input.derivedFrom
      ? `${input.field}, read from ${input.derivedFrom} rather than stated by them.`
      : `${input.field}, our reading rather than theirs.`,
    `Confirm ${input.field} with the buyer.`,
  );
}

/**
 * A provider's claim about themselves.
 *
 * A directory entry saying a company does janitorial work is the company
 * saying so, filtered through somebody who did not check. `capabilityVerifiedAt`
 * is the difference between that and a person having established it, and until
 * it is set the claim is theirs, not a fact.
 */
export function gradeProviderClaim(input: {
  claim: string;
  capabilityVerifiedAt: Date | null;
  verifiedBy: string | null;
  sourceUrl: string | null;
}): Evidenced<string> {
  if (input.capabilityVerifiedAt) {
    return confirmed(
      input.claim,
      `Verified${input.verifiedBy ? ` by ${input.verifiedBy}` : ''} on `
      + `${input.capabilityVerifiedAt.toISOString().slice(0, 10)}.`,
    );
  }
  if (input.sourceUrl) {
    return observed(input.claim, 'Listed in a directory. Their claim, published, not checked by us.');
  }
  return inferred(
    input.claim,
    'Assumed from the catalogue with no source and no verification.',
    'Ring them and establish it, or read a licence.',
  );
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/** A percentage, or the reason there isn't one. */
export function presentPercent(value: Evidenced<number>) {
  return present(value, (v) => `${Math.round(v * 100)}%`);
}

/** A count or a measure, shown at the precision its evidence supports. */
export function presentNumber(value: Evidenced<number>, unit = '') {
  return present(value, (v) => `${Math.round(v).toLocaleString()}${unit ? ` ${unit}` : ''}`);
}

export function presentText(value: Evidenced<string | number>) {
  return present(value, (v) => String(v));
}

/**
 * A short badge for a class, for putting beside a value that is shown.
 *
 * Only ever attached to a figure that survived the rule. A suppressed value
 * gets a sentence, not a badge — the whole point is that it does not appear as
 * a number with a caveat, because a number with a caveat is still a number and
 * gets read as one.
 */
export const CLASS_BADGE: Record<EvidenceClass, string> = {
  CONFIRMED_BY_PERSON: 'confirmed',
  EXTERNALLY_OBSERVED: 'published',
  CALCULATED_FROM_CONFIRMED_INPUTS: 'calculated',
  INFERRED: 'inferred',
  UNKNOWN: 'unknown',
};
