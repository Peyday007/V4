/**
 * Grading the four numbers that appear on every opportunity surface.
 *
 * `closingProbability`, `fulfillmentConfidence`, `informationCompleteness` and
 * the composite score are columns with defaults — 0.1, 0.3, 0 — and the scorer
 * writes over them whenever it runs, so a row carrying 0.1 might be a scored
 * judgement or might be a column default that nothing has ever touched. Both
 * rendered as "10%", in the same typeface, on the board, the list, the detail
 * page, the comparison and the dashboard.
 *
 * The distinction the screens were missing is not "is the model good". It is
 * "has anything been observed at all". So this reads the two things that
 * actually settle it:
 *
 *   Has the scorer ever run on this opportunity? An `OpportunityScore` row is
 *   the evidence. No row means every figure on the opportunity is a default,
 *   and a default is not a judgement about a deal.
 *
 *   Does a probability have a history to rest on? A closing rate is a claim
 *   about how often deals like this close. Until enough have closed or been
 *   lost, there is no rate — and a percentage shown before then is a guess
 *   wearing a decimal point.
 *
 * One module, because the fault was that each surface decided for itself.
 */

import { prisma } from '@/lib/db';
import { gradeProbability, gradeScore, gradeExpectedValue, presentPercent } from './claims';
import { confirmed, inferred, present, unknown, type Evidenced, type Presentation } from './class';

/** The row shape each surface already has, or can select cheaply. */
export type ScorableOpportunity = {
  id: string;
  type: string;
  stage: string;
  closingProbability: number;
  fulfillmentConfidence: number;
  informationCompleteness: number;
  relationshipVulnerability: number;
  expectedValue: unknown;
  estimatedGrossProfit?: unknown;
  missingInformation: string[];
  /** Whether the scorer has ever written a score row for this opportunity. */
  hasScore: boolean;
  /**
   * Documented problems with whoever currently does the work, and the
   * vulnerability signals that fired on the buyer. Both are quoted evidence
   * when present, and both are what a relationship-vulnerability figure is
   * supposed to rest on — so their absence is the thing that makes it hollow.
   */
  incumbentIssues?: number;
  movabilitySignals?: number;
};

export type OpportunityClaims = {
  closingProbability: Evidenced<number>;
  fulfillmentConfidence: Evidenced<number>;
  informationCompleteness: Evidenced<number>;
  relationshipVulnerability: Evidenced<number>;
  expectedValue: Evidenced<number>;
  /** Presentations, so a render site cannot reach past the grader to the value. */
  shown: {
    closingProbability: Presentation;
    fulfillmentConfidence: Presentation;
    informationCompleteness: Presentation;
    relationshipVulnerability: Presentation;
  };
};

/**
 * How many closed deals a probability needs before it means anything.
 *
 * Kept here rather than at each call site so raising it raises it everywhere.
 */
export const PROBABILITY_FLOOR = 20;

/**
 * Closed comparables per opportunity type, counted once for a whole page.
 *
 * Per-type rather than global, because "how often does brokerage work close"
 * and "how often does subcontracting close" are different questions and
 * answering the first with the second's history is the same fabrication in a
 * quieter form.
 */
export async function closedComparablesByType(orgId: string): Promise<Map<string, number>> {
  const rows = await prisma.opportunity.groupBy({
    by: ['type'],
    where: { orgId, status: { in: ['WON', 'LOST'] } },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [String(r.type), r._count._all]));
}

/**
 * Grades one opportunity's headline numbers.
 *
 * `closedComparables` is passed in rather than queried, so a board rendering
 * four hundred cards issues one query rather than four hundred.
 */
export function gradeOpportunity(input: {
  opportunity: ScorableOpportunity;
  closedComparables: number;
}): OpportunityClaims {
  const o = input.opportunity;

  // Nothing on an unscored opportunity is a judgement. Say so once, and let
  // every figure inherit it, rather than grading four defaults separately.
  const unscored = !o.hasScore;

  const closingProbability = unscored
    ? unknown<number>(
        'Nothing has scored this opportunity, so the closing probability on it is the column default rather '
        + 'than a judgement about this deal.',
        'It gets a figure when the scorer runs against real inputs.',
      )
    : gradeProbability({
        value: o.closingProbability,
        observations: input.closedComparables,
        minimumObservations: PROBABILITY_FLOOR,
      });

  const fulfillmentConfidence = unscored
    ? unknown<number>(
        'Nothing has scored this opportunity, so the fulfilment confidence is the column default rather than '
        + 'an assessment of any provider.',
        'Attach a provider and verify the capability.',
      )
    : gradeScore({
        value: o.fulfillmentConfidence,
        // Fulfilment confidence rests on a provider existing, holding the
        // capability, and having priced it. Those are the three.
        inputsPresent: fulfilmentInputsPresent(o),
        inputsTotal: 3,
        what: 'Fulfilment confidence',
      });

  // Information completeness is the one figure that is honestly self-measuring:
  // it is a count of what is known against what is needed, and the system does
  // know what it has. It is still worthless before anything has run.
  const informationCompleteness = unscored
    ? unknown<number>(
        'Nothing has assessed what is known about this opportunity yet.',
        'It fills in as facts are established.',
      )
    : confirmed(o.informationCompleteness, `Counted from what has been established against what this deal needs.`);

  // A claim about how loosely a buyer is attached to whoever currently does
  // the work. It rests on two things that carry quoted evidence when they
  // exist — documented incumbent problems, and vulnerability signals that fired
  // on the account — and on neither when they do not, in which case the
  // scorer's defaults produce roughly 0.28 and the screen printed "28%".
  const evidenceForVulnerability = (o.incumbentIssues ?? 0) + (o.movabilitySignals ?? 0);
  const relationshipVulnerability = unscored || evidenceForVulnerability === 0
    ? unknown<number>(
        'Nothing has established who the incumbent is or how the buyer feels about them, so a vulnerability '
        + 'figure would be the scorer\'s defaults rather than anything about this account.',
        'Ask on a call who currently does this work and how it is going.',
      )
    : observedValue(
        o.relationshipVulnerability,
        `From ${evidenceForVulnerability} recorded signal(s) about their current arrangement.`,
      );

  const expectedValue = gradeExpectedValue({
    grossProfit:
      o.estimatedGrossProfit === null || o.estimatedGrossProfit === undefined
        ? unknown<number>('No gross profit has been established.', 'Price it against a provider cost.')
        : inferred(
            Number(o.estimatedGrossProfit),
            'An estimate from the playbook range, not a quoted price against a quoted cost.',
            'Quote it against a provider cost.',
          ),
    closingProbability,
  });

  return {
    closingProbability,
    fulfillmentConfidence,
    informationCompleteness,
    relationshipVulnerability,
    expectedValue,
    shown: {
      closingProbability: presentPercent(closingProbability),
      fulfillmentConfidence: presentPercent(fulfillmentConfidence),
      informationCompleteness: presentPercent(informationCompleteness),
      relationshipVulnerability: presentPercent(relationshipVulnerability),
    },
  };
}

function fulfilmentInputsPresent(o: ScorableOpportunity): number {
  // Read from the stage ladder rather than from joined rows, so this stays
  // cheap enough for a board. The stages are ordered, so reaching one means
  // the earlier ones were passed.
  const order = [
    'SUPPLIER_REQUIRED',
    'FULFILLMENT_CAPABILITY_CONFIRMED',
    'MATCH_BEING_CONFIGURED',
    'PRICING_REQUIRED',
  ];
  const reached = order.indexOf(o.stage);
  if (reached < 0) {
    // Either before supply is considered at all, or past pricing entirely.
    return LATE_STAGES.has(o.stage) ? 3 : 0;
  }
  return Math.min(3, reached);
}

/**
 * The pipeline in operating order.
 *
 * Position in this list is a fact about a deal — it got here, so it passed
 * everything before it. That makes it the honest thing to rank by when the
 * alternative is a predicted probability nothing has observed.
 */
export const STAGE_ORDER: string[] = [
  'SIGNAL_DISCOVERED',
  'RESEARCHING',
  'QUALIFICATION_REQUIRED',
  'BUYER_NEED_CONFIRMED',
  'SUPPLIER_REQUIRED',
  'FULFILLMENT_CAPABILITY_CONFIRMED',
  'MATCH_BEING_CONFIGURED',
  'PRICING_REQUIRED',
  'QUOTE_BEING_PREPARED',
  'QUOTE_DELIVERED',
  'FOLLOW_UP_REQUIRED',
  'NEGOTIATION',
  'AWAITING_APPROVAL',
  'CONTRACTING',
  'FULFILLMENT_SCHEDULED',
  'ACTIVE_FULFILLMENT',
  'COMPLETED',
  'REPEAT_OR_EXPANSION',
];

const LATE_STAGES = new Set(STAGE_ORDER.slice(STAGE_ORDER.indexOf('QUOTE_BEING_PREPARED')));

/**
 * The one-line summary a card shows in place of "P 10% · Info 35%".
 *
 * A card has room for a fragment, not a paragraph, and the honest fragment is
 * the state of knowledge rather than a suppressed figure's full explanation.
 * Clicking through to the record gets the sentence.
 */
export function claimsChip(claims: OpportunityClaims): string {
  const parts: string[] = [];
  const p = claims.shown.closingProbability;
  parts.push(p.show ? `Closes ${p.label}` : 'No closing rate yet');
  const i = claims.shown.informationCompleteness;
  if (i.show) parts.push(`Known ${i.label}`);
  return parts.join(' · ');
}

/**
 * The money on a legacy opportunity, graded.
 *
 * `estimatedValue` and `estimatedGrossProfit` are the playbook's typical range
 * for a category, sometimes multiplied by an assumed margin. They were rendered
 * in columns headed "Value" and "GP" in the same typeface as a quoted price,
 * which is the exact fault the money grading was built to stop — it just had
 * never been applied to this model.
 *
 * A quote with a cost total behind it is a different thing: somebody entered
 * line items and a supplier cost. That is observable, so it shows. The estimate
 * is not, so it does not.
 */
export function gradeOpportunityMoney(input: {
  estimatedValue: unknown;
  estimatedGrossProfit: unknown;
  /** The live outbound quote, if one has been raised. */
  quote: { total: unknown; costTotal: unknown; grossProfit: unknown } | null;
}): { value: Evidenced<number>; grossProfit: Evidenced<number> } {
  const costed = input.quote !== null && Number(input.quote.costTotal) > 0;

  if (costed && input.quote) {
    return {
      value: observedValue(Number(input.quote.total), 'A quote was raised at this total.'),
      grossProfit: observedValue(
        Number(input.quote.grossProfit),
        'The quoted total less a supplier cost that was entered against it.',
      ),
    };
  }

  const hasQuote = input.quote !== null;
  const because = hasQuote
    ? 'A quote exists but nothing has been costed against it, so the margin on it is not known.'
    : 'No quote has been raised, so this is the playbook range for this kind of work rather than a price.';
  const fix = hasQuote ? 'Enter the supplier cost on the quote.' : 'Get a provider to price the work and quote it.';

  return {
    value:
      input.estimatedValue === null || input.estimatedValue === undefined
        ? unknown<number>('No value has been estimated.', fix)
        : inferred(Number(input.estimatedValue), because, fix),
    grossProfit:
      input.estimatedGrossProfit === null || input.estimatedGrossProfit === undefined
        ? unknown<number>('No gross profit has been estimated.', fix)
        : inferred(Number(input.estimatedGrossProfit), because, fix),
  };
}

function observedValue(value: number, source: string): Evidenced<number> {
  return { value, evidence: 'EXTERNALLY_OBSERVED', source, toConfirm: null };
}

/**
 * A match score, graded.
 *
 * `Match.score` is a similarity between a requirement and a catalogue entry.
 * It is a real computation over real rows, so it is not a fabrication — but it
 * is a statement about how well two records line up, not about whether the
 * provider can do the work, and it was being read as the latter. It stays
 * inferred until somebody has verified the capability.
 */
export function gradeMatchScore(input: {
  score: number;
  missingInformation: string[];
  capabilityVerified: boolean;
}): Evidenced<number> {
  if (input.capabilityVerified) {
    return {
      value: input.score,
      evidence: 'CALCULATED_FROM_CONFIRMED_INPUTS',
      source: 'Computed against a capability somebody verified.',
      toConfirm: null,
    };
  }
  return inferred(
    input.score,
    input.missingInformation.length > 0
      ? `How well the records line up, with ${input.missingInformation.length} thing(s) still unknown about this `
        + 'candidate. Not a judgement that they can do the work.'
      : 'How well the records line up. Not a judgement that they can do the work.',
    'Verify the capability with the provider.',
  );
}

/** A match score as a percentage, or the reason there isn't one. */
export function presentMatchScore(score: Evidenced<number>): Presentation {
  return present(score, (v) => `${Math.round(v * 100)}%`);
}
