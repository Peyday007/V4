import type { CallDisposition } from '@prisma/client';
import type { ClaimAbout, ClaimInput } from './ledger';

/**
 * What a call establishes, turned into claims.
 *
 * The discovery form was already the strongest evidence this system collects: a
 * named person, on a recorded date, answering a specific question about their
 * own business. It was stored as a JSON blob on an attempt row, and nothing
 * read it. The route's columns went on saying what a playbook had inferred
 * three weeks earlier while a facilities manager's actual answer sat two tables
 * away.
 *
 * This is the mapping from those answers to the ledger. Three things it gets
 * deliberately right:
 *
 *   A person's answer outranks the engine's inference and simply supersedes it.
 *   That is not a dispute — the model was working from a permit and the person
 *   works there.
 *
 *   A person's answer that disagrees with *another person's* answer is a
 *   dispute, and both stay on the record until somebody settles it. This is the
 *   case the product could not represent at all before.
 *
 *   A negative is a finding. "They do not need this" is recorded as a confirmed
 *   claim with a value of false, not as an absence — otherwise the same
 *   hypothesis is regenerated on the next pipeline pass and somebody rings them
 *   again.
 */

/** Which discovery field establishes which claim, and where it belongs. */
type Mapping = {
  key: string;
  about: ClaimAbout;
  /** Written for the record, from the caller's answer. */
  statement: (value: string, organisation: string) => string;
};

const MAPPINGS: Record<string, Mapping> = {
  confirmedNeed: {
    key: 'buyer.need',
    about: 'BUYER',
    statement: (v, org) => `${org} stated their requirement: ${v}`,
  },
  timing: {
    key: 'timing.window',
    about: 'TIMING',
    statement: (v) => `They said they need it: ${v}`,
  },
  buyerRole: {
    key: 'buyer.contactRole',
    about: 'BUYER',
    statement: (v) => `Spoke to ${v}.`,
  },
  decisionAuthority: {
    key: 'buyer.decisionMaker',
    about: 'BUYER',
    statement: (v) => `The person who signs: ${v}`,
  },
  nextStep: {
    key: 'buyer.commitment',
    about: 'BUYER',
    statement: (v) => `We promised: ${v}`,
  },
  objections: {
    key: 'buyer.objections',
    about: 'BUYER',
    statement: (v) => `Objections raised: ${v}`,
  },
  disqualifyReason: {
    key: 'buyer.disqualified',
    about: 'BUYER',
    statement: (v) => `Ruled out: ${v}`,
  },

  // Distribution
  productCategory: { key: 'buyer.requirement.product', about: 'BUYER', statement: (v) => `They buy: ${v}` },
  quantity: { key: 'buyer.requirement.quantity', about: 'BUYER', statement: (v) => `Quantity: ${v}` },
  reorderCycle: {
    key: 'buyer.requirement.cycle',
    about: 'TIMING',
    statement: (v) => `Reorder cycle: ${v}. This is what makes it an account rather than an order.`,
  },
  deliveryLocation: { key: 'buyer.requirement.location', about: 'BUYER', statement: (v) => `Delivered to: ${v}` },
  currentSupplier: {
    key: 'buyer.incumbent',
    about: 'BUYER',
    statement: (v) => `Currently supplied by ${v}.`,
  },
  purchasingAuthority: {
    key: 'buyer.purchasingAuthority',
    about: 'BUYER',
    statement: (v) => `Raises the purchase order: ${v}`,
  },
  vendorRequirements: {
    key: 'compliance.vendorRequirements',
    about: 'COMPLIANCE',
    statement: (v) => `To supply them we would need: ${v}`,
  },

  // Brokerage
  scope: { key: 'buyer.requirement.scope', about: 'BUYER', statement: (v) => `Scope of work: ${v}` },
  locations: { key: 'buyer.requirement.locations', about: 'BUYER', statement: (v) => `Locations: ${v}` },
  frequency: { key: 'buyer.requirement.frequency', about: 'TIMING', statement: (v) => `Frequency: ${v}` },
  incumbent: { key: 'buyer.incumbent', about: 'BUYER', statement: (v) => `Currently served by ${v}.` },
  contractEnd: {
    key: 'timing.contractEnd',
    about: 'TIMING',
    statement: (v) => `Contract ends or is decided: ${v}`,
  },
  budgetProcess: {
    key: 'buyer.budgetProcess',
    about: 'ECONOMICS',
    statement: (v) => `Budget or bid process: ${v}`,
  },
  decisionParticipants: {
    key: 'buyer.decisionParticipants',
    about: 'BUYER',
    statement: (v) => `Others involved in deciding: ${v}`,
  },

  // Subcontracting
  projectOrAward: { key: 'buyer.project', about: 'BUYER', statement: (v) => `The work: ${v}` },
  capacityGap: {
    key: 'buyer.capacityGap',
    about: 'BUYER',
    statement: (v) => `What they are short of: ${v}`,
  },
  tradeCapability: {
    key: 'buyer.requirement.capability',
    about: 'BUYER',
    statement: (v) => `Capability needed: ${v}`,
  },
  geography: { key: 'buyer.requirement.geography', about: 'BUYER', statement: (v) => `Where the work is: ${v}` },
  mobilisationDate: {
    key: 'timing.mobilisation',
    about: 'TIMING',
    statement: (v) => `Mobilisation: ${v}`,
  },
  credentials: {
    key: 'compliance.credentials',
    about: 'COMPLIANCE',
    statement: (v) => `Credentials required: ${v}`,
  },
  rateStructure: {
    key: 'economics.pricingBasis',
    about: 'ECONOMICS',
    statement: (v) => `How they pay: ${v}. Not a price — the shape a price has to take.`,
  },
  onboardingContact: {
    key: 'compliance.onboarding',
    about: 'COMPLIANCE',
    statement: (v) => `Onboarding: ${v}`,
  },
};

/**
 * Outcomes that establish there is no need, whatever else the form carries.
 *
 * Recorded as a confirmed negative rather than left as an absence, so the next
 * pipeline pass does not rebuild the same hypothesis and put the same company
 * back in a queue.
 */
const NEGATIVE: Partial<Record<CallDisposition, string>> = {
  NEED_UNCONFIRMED: 'They do not have this requirement.',
  NOT_INTERESTED: 'They are not interested in pursuing this.',
  BAD_FIT: 'This is not a fit.',
  ALREADY_HANDLED: 'Somebody else already has this work.',
};

export type CallClaimInput = {
  routeId: string;
  companyId: string | null;
  contactId?: string | null;
  organisation: string;
  disposition: CallDisposition;
  discovery: Record<string, string | number | boolean>;
  /** Who made the call, for the record. Never invented. */
  callerName: string;
  /** The attempt this came from, so the claim can be reopened. */
  attemptId: string;
  calledAt: Date;
};

export function callClaims(input: CallClaimInput): ClaimInput[] {
  const claims: ClaimInput[] = [];
  const sourceLabel = `${input.callerName} was told this on a call on `
    + `${input.calledAt.toISOString().slice(0, 10)}.`;
  const common = {
    routeId: input.routeId,
    companyId: input.companyId ?? null,
    contactId: input.contactId ?? null,
    observedAt: input.calledAt,
    sourceRef: `attempt:${input.attemptId}`,
    sourceKind: 'PERSON' as const,
    standing: 'CONFIRMED' as const,
  };

  // --- the negative, first --------------------------------------------------
  //
  // Recorded before anything else so it is the claim on `buyer.need`, whatever
  // else the form carried. A "not interested" call that also filled in a scope
  // box must not leave a confirmed requirement standing on the record.
  const negative = NEGATIVE[input.disposition];
  if (negative) {
    const because = String(input.discovery.disqualifyReason ?? '').trim();
    claims.push({
      ...common,
      about: 'BUYER',
      key: 'buyer.need',
      statement: `${negative}${because ? ` ${because}` : ''}`,
      value: { confirmed: false, disposition: input.disposition },
      sourceLabel,
    });
  }

  for (const [field, raw] of Object.entries(input.discovery)) {
    const mapping = MAPPINGS[field];
    if (!mapping) continue;
    const value = typeof raw === 'string' ? raw.trim() : String(raw);
    if (!value) continue;
    // A negative outcome has already settled the need. Whatever the caller
    // typed in the requirement boxes is context, not a live requirement.
    if (negative && mapping.key === 'buyer.need') continue;

    claims.push({
      ...common,
      about: mapping.about,
      key: mapping.key,
      statement: mapping.statement(value, input.organisation),
      value: { answer: value, field },
      sourceLabel,
    });
  }

  return claims;
}

/**
 * Whether two claims on the same key genuinely disagree.
 *
 * Only asked when both sides are a person's answer — an engine inference losing
 * to a person is not a dispute, and treating it as one would fill the board
 * with contradictions on every first call.
 *
 * Deliberately crude, and crude in the safe direction: it compares the answers
 * as text and calls them the same when one contains the other. "Twelve thousand
 * square feet" and "12,000 sq ft" will be flagged as a disagreement and a person
 * will spend a moment dismissing it. The opposite error — quietly overwriting
 * one person's answer with another's — is the one that loses information, and it
 * is the error this whole table exists to prevent.
 */
export function answersAgree(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): string => {
    const value =
      v && typeof v === 'object' && 'answer' in (v as Record<string, unknown>)
        ? (v as Record<string, unknown>).answer
        : v;
    return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  };
  const left = norm(a);
  const right = norm(b);
  if (!left || !right) return true;
  return left === right || left.includes(right) || right.includes(left);
}
