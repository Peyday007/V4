import type { RiskLevel } from '@prisma/client';
import type { Playbook } from './playbooks';

/**
 * Working capital, payment risk, counterparty risk and compliance.
 *
 * One rule governs this file: an unknown input produces UNKNOWN, never a
 * default. A buyer with no payment history is not a good payer, and defaulting
 * them to LOW would put every unverified counterparty at the top of the queue
 * — which is precisely the failure mode of a system that flatters itself.
 *
 * UNKNOWN is also not neutral. It blocks the automatic promotion of a route to
 * serious pursuit above a spend threshold, because committing capital against
 * an unassessed counterparty is a decision a person should make deliberately.
 */

export type WorkingCapital = {
  /** The most we would be out of pocket at any point. Null when unknowable. */
  maxCashExposure: number | null;
  /** How long that money is committed. */
  daysExposed: number | null;
  reason: string;
};

/**
 * Cash exposure by commercial structure.
 *
 * Brokerage and distribution expose real money — we pay the provider or the
 * wholesaler before the buyer pays us. Subcontracting and referral do not: the
 * prime carries the customer contract, and a referral fee is received rather
 * than advanced.
 */
export function assessWorkingCapital(input: {
  structure: string;
  providerCost: number | null;
  /** Days from delivery to the buyer paying, where we know their terms. */
  buyerPaymentDays: number | null;
  /** Days we get before the provider or wholesaler must be paid. */
  supplierTermsDays: number | null;
  /** A deposit collected up front reduces exposure to nearly nothing. */
  depositPct: number | null;
}): WorkingCapital {
  if (input.structure === 'REFERRAL' || input.structure === 'DIRECT_INTRODUCTION') {
    return {
      maxCashExposure: 0,
      daysExposed: 0,
      reason: 'A fee is received, not advanced. No capital is committed.',
    };
  }

  if (input.structure === 'SUBCONTRACTING') {
    return {
      maxCashExposure: 0,
      daysExposed: null,
      reason:
        'The prime holds the customer contract and pays us. We advance nothing, though we do carry the risk ' +
        'that they pay late.',
    };
  }

  if (input.providerCost === null) {
    return {
      maxCashExposure: null,
      daysExposed: null,
      reason:
        'No provider or wholesaler cost is known, so the money at risk cannot be calculated. Unknown, not zero.',
    };
  }

  const deposit = input.depositPct === null ? 0 : Math.max(0, Math.min(1, input.depositPct));
  const exposure = Math.round(input.providerCost * (1 - deposit));

  // Terms unknown on either side means the duration is unknown. Assuming
  // thirty days would be inventing the number that decides whether this is
  // affordable.
  const days =
    input.buyerPaymentDays === null
      ? null
      : Math.max(0, input.buyerPaymentDays - (input.supplierTermsDays ?? 0));

  return {
    maxCashExposure: exposure,
    daysExposed: days,
    reason:
      `We pay the supply side $${exposure.toLocaleString()}${deposit > 0 ? ` after a ${Math.round(deposit * 100)}% deposit` : ''} ` +
      `before the buyer pays us. ` +
      (days === null
        ? 'Payment terms are unknown on at least one side, so the duration of that exposure is unknown.'
        : `That money is committed for roughly ${days} days.`),
  };
}

export type RiskAssessment = {
  level: RiskLevel;
  reason: string;
  /** What would have to be found out to move it off UNKNOWN. */
  toResolve: string[];
};

/**
 * Will they pay?
 *
 * Public-sector buyers pay slowly and reliably; a brand-new business with no
 * trading history is the opposite on both counts. Anything we have not
 * established stays unknown.
 */
export function assessPaymentRisk(input: {
  /** True when the buyer is a government body or public institution. */
  isPublicSector: boolean | null;
  /** True when the account has paid us before. */
  hasPaidBefore: boolean | null;
  /** Trading for less than a year, per a licence or registration date. */
  isNewlyEstablished: boolean | null;
  /** Payment terms the buyer has stated. */
  statedTermsDays: number | null;
  /** Value at stake, used to decide how much this matters. */
  exposure: number | null;
}): RiskAssessment {
  const toResolve: string[] = [];
  if (input.hasPaidBefore === null) toResolve.push('whether they have paid us before');
  if (input.isPublicSector === null) toResolve.push('whether this is a public body or a private business');
  if (input.statedTermsDays === null) toResolve.push('their payment terms');

  if (input.hasPaidBefore === true) {
    return { level: 'LOW', reason: 'This account has paid us before.', toResolve };
  }

  if (input.isPublicSector === true) {
    return {
      level: 'LOW',
      reason: 'A public body pays slowly and reliably. The risk is timing, not collection.',
      toResolve,
    };
  }

  if (input.isNewlyEstablished === true && (input.exposure ?? 0) > 1000) {
    return {
      level: 'HIGH',
      reason:
        'A business that has been trading for months, with real money advanced before they pay. Ask for a ' +
        'deposit rather than carrying it.',
      toResolve,
    };
  }

  if (input.statedTermsDays !== null && input.statedTermsDays > 60) {
    return {
      level: 'HIGH',
      reason: `Stated terms of ${input.statedTermsDays} days tie up money for two months on a job of this size.`,
      toResolve,
    };
  }

  if (toResolve.length >= 2) {
    return {
      level: 'UNKNOWN',
      reason:
        'Nothing is known about how or whether this buyer pays. That is not the same as low risk, and above a ' +
        'small exposure it should be established before committing capital.',
      toResolve,
    };
  }

  return { level: 'MODERATE', reason: 'An ordinary commercial buyer with no history either way.', toResolve };
}

/**
 * Will they be difficult, or are they not who they say they are?
 *
 * Separate from payment risk: a buyer can be perfectly solvent and still be a
 * counterparty worth avoiding — vague scope, no verifiable identity, a history
 * of disputes.
 */
export function assessCounterpartyRisk(input: {
  /** Identity confirmed against a licence, registration or public record. */
  identityVerified: boolean | null;
  /** The scope of work is clear enough to price. */
  scopeIsClear: boolean | null;
  /** Known disputes, complaints or contract terminations. */
  knownDisputes: boolean | null;
  /** We hold a contact who actually answers. */
  reachable: boolean | null;
}): RiskAssessment {
  const toResolve: string[] = [];
  if (input.identityVerified === null) toResolve.push('confirm the organisation is who the record says');
  if (input.scopeIsClear === null) toResolve.push('establish what the work actually involves');
  if (input.knownDisputes === null) toResolve.push('check for disputes or terminations');

  if (input.knownDisputes === true) {
    return { level: 'HIGH', reason: 'Known disputes or terminations on record.', toResolve };
  }

  if (input.identityVerified === false) {
    return {
      level: 'HIGH',
      reason: 'The organisation could not be confirmed against any public record.',
      toResolve,
    };
  }

  if (input.identityVerified === true && input.scopeIsClear === true) {
    return {
      level: 'LOW',
      reason: 'Identity confirmed against a public record and the scope is clear enough to price.',
      toResolve,
    };
  }

  if (toResolve.length >= 2) {
    return {
      level: 'UNKNOWN',
      reason: 'Too little is established about this counterparty to judge them either way.',
      toResolve,
    };
  }

  return { level: 'MODERATE', reason: 'Partly established. Nothing alarming, nothing confirmed.', toResolve };
}

export type ComplianceAssessment = {
  status: 'READY' | 'NEARLY_READY' | 'GAPS' | 'STRUCTURALLY_UNQUALIFIED' | 'UNKNOWN';
  gaps: string[];
  reason: string;
  blocksPursuit: boolean;
};

/**
 * Can this legally and contractually be performed?
 *
 * A gap that a provider can close — a certificate of insurance, a licence they
 * already hold — is a task. A gap nobody in reach can close is a reason not to
 * spend an afternoon on the response.
 */
export function assessCompliance(input: {
  playbook: Playbook;
  /** Requirements we or a provider demonstrably meet. */
  satisfied: string[];
  /** Requirements the buyer has stated that we cannot currently meet. */
  knownBlockers: string[];
  /** True when a matched provider carries insurance. */
  providerInsured: boolean | null;
}): ComplianceAssessment {
  if (input.knownBlockers.length > 0) {
    return {
      status: 'STRUCTURALLY_UNQUALIFIED',
      gaps: input.knownBlockers,
      reason:
        `Cannot currently be performed: ${input.knownBlockers.join('; ')}. Pursuing this would spend time on ` +
        `something we are not able to win.`,
      blocksPursuit: true,
    };
  }

  const required = input.playbook.compliance;
  const outstanding = required.filter(
    (requirement) => !input.satisfied.some((s) => s.toLowerCase().includes(requirement.slice(0, 12).toLowerCase())),
  );

  if (input.providerInsured === null && outstanding.length === required.length) {
    return {
      status: 'UNKNOWN',
      gaps: outstanding,
      reason: 'Nothing has been checked against this opportunity’s requirements yet.',
      blocksPursuit: false,
    };
  }

  if (outstanding.length === 0) {
    return { status: 'READY', gaps: [], reason: 'Every stated requirement is met.', blocksPursuit: false };
  }

  // Ordinary trade requirements a provider closes with a phone call are a
  // task, not a disqualification.
  const routine = outstanding.every((gap) => /insurance|workers comp|bond/i.test(gap));
  return {
    status: routine ? 'NEARLY_READY' : 'GAPS',
    gaps: outstanding,
    reason: routine
      ? `Outstanding but routine: ${outstanding.join('; ')}. A provider closes these with a certificate.`
      : `Outstanding: ${outstanding.join('; ')}.`,
    blocksPursuit: false,
  };
}

/**
 * Whether risk alone should stop a route being promoted.
 *
 * Deliberately narrow. Risk informs; it blocks only where real money is
 * committed against a counterparty nobody has established anything about.
 */
export function riskBlocksPursuit(input: {
  paymentRisk: RiskLevel;
  counterpartyRisk: RiskLevel;
  maxCashExposure: number | null;
  threshold?: number;
}): { blocks: boolean; reason: string | null } {
  const threshold = input.threshold ?? 2500;
  const exposure = input.maxCashExposure ?? 0;

  if (exposure <= threshold) return { blocks: false, reason: null };

  if (input.paymentRisk === 'HIGH' || input.counterpartyRisk === 'HIGH') {
    return {
      blocks: true,
      reason: `$${exposure.toLocaleString()} of our money against a counterparty assessed as high risk.`,
    };
  }
  if (input.paymentRisk === 'UNKNOWN' || input.counterpartyRisk === 'UNKNOWN') {
    return {
      blocks: true,
      reason:
        `$${exposure.toLocaleString()} of our money against a counterparty nobody has assessed. Unknown is not ` +
        `low — establish who they are and how they pay before committing it.`,
    };
  }
  return { blocks: false, reason: null };
}
