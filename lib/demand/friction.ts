import type { FrictionLevel } from '@prisma/client';
import type { Playbook } from './playbooks';

/**
 * Relationship friction: how much human relationship work an opportunity costs.
 *
 * Kept strictly apart from tier, because they answer different questions and
 * are frequently opposite. A federal solicitation is unambiguous Tier A demand
 * and a miserable relationship — formal procurement, registration, bonding,
 * months of process. An independent gym opening in three weeks is only Tier B,
 * and is one phone call to the owner.
 *
 * The failure this guards against is treating recurring revenue as low
 * friction. A recurring cleaning contract at a hospital is high friction
 * forever; a one-time turnover clean booked by a local property manager is
 * low friction and pays this month.
 *
 * `UNKNOWN_RESEARCH_REQUIRED` is a real answer and must never be presented as
 * LOW. Not knowing whether a gym is independent or a franchise is not evidence
 * that it is easy — it is the reason to make one research call.
 */

export type FrictionSignals = {
  /** Purchasing decided at the site, not at a head office. */
  localPurchasingAuthority: boolean | null;
  /** One transaction rather than an ongoing contract. */
  oneTimeTransaction: boolean | null;
  /** Standard scope rather than something bespoke. */
  standardScope: boolean | null;
  /** A formal procurement process applies. */
  formalProcurement: boolean | null;
  /** Vendor registration or onboarding paperwork is required. */
  vendorOnboarding: boolean | null;
  /** Insurance, bonding or certification beyond the ordinary. */
  heavyCompliance: boolean | null;
  /** Keys, alarm codes, after-hours or restricted-area access. */
  sensitiveAccess: boolean | null;
  /** An existing provider would have to be displaced. */
  incumbentPresent: boolean | null;
  /** Part of a chain, franchise or enterprise that controls purchasing. */
  chainOrEnterpriseControl: boolean | null;
  /** A person at the buying organisation can actually be reached. */
  buyerReachable: boolean | null;
  /** Payment risk is elevated (long terms, unknown counterparty). */
  paymentRisk: boolean | null;
};

export const UNKNOWN_SIGNALS: FrictionSignals = {
  localPurchasingAuthority: null,
  oneTimeTransaction: null,
  standardScope: null,
  formalProcurement: null,
  vendorOnboarding: null,
  heavyCompliance: null,
  sensitiveAccess: null,
  incumbentPresent: null,
  chainOrEnterpriseControl: null,
  buyerReachable: null,
  paymentRisk: null,
};

type Rule = {
  key: keyof FrictionSignals;
  /** Score when the answer is true. Negative lowers friction. */
  whenTrue: number;
  whenFalse: number;
  label: string;
};

/**
 * Weights are asymmetric on purpose.
 *
 * Chain control and formal procurement each cost more than any single easing
 * factor can save, because either one alone turns a job into a process. A
 * franchise-controlled purchase is not made easy by being a standard scope.
 */
const RULES: Rule[] = [
  { key: 'formalProcurement', whenTrue: 4, whenFalse: -1, label: 'formal procurement process' },
  { key: 'chainOrEnterpriseControl', whenTrue: 4, whenFalse: -2, label: 'chain or enterprise purchasing control' },
  { key: 'incumbentPresent', whenTrue: 3, whenFalse: -2, label: 'incumbent provider to displace' },
  { key: 'vendorOnboarding', whenTrue: 2, whenFalse: -1, label: 'vendor onboarding paperwork' },
  { key: 'heavyCompliance', whenTrue: 2, whenFalse: -1, label: 'insurance or bonding beyond the ordinary' },
  { key: 'sensitiveAccess', whenTrue: 2, whenFalse: 0, label: 'keys, codes or restricted access' },
  { key: 'paymentRisk', whenTrue: 2, whenFalse: 0, label: 'payment risk' },
  { key: 'localPurchasingAuthority', whenTrue: -3, whenFalse: 2, label: 'local purchasing authority' },
  { key: 'oneTimeTransaction', whenTrue: -2, whenFalse: 1, label: 'single transaction rather than a contract' },
  { key: 'standardScope', whenTrue: -2, whenFalse: 2, label: 'standard scope' },
  { key: 'buyerReachable', whenTrue: -2, whenFalse: 2, label: 'the buyer can be reached' },
];

/**
 * How many of the eleven signals must be known before a verdict is possible.
 *
 * Set at a majority: below it, the score is an accident of which few facts
 * happened to be published, and the honest answer is that research is needed.
 */
const MIN_KNOWN_SIGNALS = 6;

export type FrictionAssessment = {
  level: FrictionLevel;
  score: number;
  reason: string;
  /** Each contributing signal, so the verdict is arguable rather than opaque. */
  factors: Array<{ label: string; known: boolean; value: boolean | null; contribution: number }>;
  /** What to go and find out, when the answer is UNKNOWN. */
  researchNeeded: string[];
};

export function assessFriction(input: {
  signals: FrictionSignals;
  playbook?: Playbook;
  /** Expected human minutes from the playbook, as a sanity check on the verdict. */
  humanMinutes?: number;
}): FrictionAssessment {
  const factors = RULES.map((rule) => {
    const value = input.signals[rule.key];
    const contribution = value === null ? 0 : value ? rule.whenTrue : rule.whenFalse;
    return { label: rule.label, known: value !== null, value, contribution };
  });

  const known = factors.filter((f) => f.known);
  const score = factors.reduce((sum, f) => sum + f.contribution, 0);
  const researchNeeded = RULES.filter((r) => input.signals[r.key] === null).map((r) => r.label);

  if (known.length < MIN_KNOWN_SIGNALS) {
    return {
      level: 'UNKNOWN_RESEARCH_REQUIRED',
      score,
      reason:
        `Only ${known.length} of ${RULES.length} friction signals are known, which is not enough to judge. ` +
        `Not knowing is not the same as easy — this needs a research call before it can be queued as low friction.`,
      factors,
      researchNeeded,
    };
  }

  // A deal the playbook expects to consume several hours of human time is not
  // low friction whatever the individual signals say.
  const heavyByExpectation = (input.humanMinutes ?? 0) >= 240;

  if (score <= -5 && !heavyByExpectation) {
    return {
      level: 'LOW',
      score,
      reason: describe(factors, 'Low friction'),
      factors,
      researchNeeded,
    };
  }
  if (score >= 4 || heavyByExpectation) {
    return {
      level: 'HIGH',
      score,
      reason: describe(factors, 'High friction'),
      factors,
      researchNeeded,
    };
  }
  return { level: 'MODERATE', score, reason: describe(factors, 'Moderate friction'), factors, researchNeeded };
}

function describe(factors: FrictionAssessment['factors'], prefix: string): string {
  const against = factors.filter((f) => f.contribution > 0).map((f) => f.label);
  const forIt = factors.filter((f) => f.contribution < 0).map((f) => f.label);
  return (
    `${prefix}. ` +
    `${forIt.length > 0 ? `In favour: ${forIt.join(', ')}. ` : ''}` +
    `${against.length > 0 ? `Against: ${against.join(', ')}.` : ''}`
  ).trim();
}

/**
 * Whether an opportunity belongs in the low-friction queue.
 *
 * Only LOW qualifies. This is the single line that keeps the queue meaningful:
 * an unknown assessment cannot slip in on the grounds that nothing bad has
 * been found yet.
 */
export function qualifiesForLowFrictionQueue(level: FrictionLevel): boolean {
  return level === 'LOW';
}
