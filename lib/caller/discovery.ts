import type { CallDisposition, SignalCategory } from '@prisma/client';

/**
 * What a caller must find out, and what they must have written down before the
 * next opportunity is handed to them.
 *
 * Two things live here and they are deliberately separate:
 *
 *   The *fields* a route needs. A distribution call and a subcontracting call
 *   are not the same conversation — one is about quantity and reorder cycles,
 *   the other about mobilisation dates and credentials — and a single "notes"
 *   box cannot answer "how many buyers named a reorder cycle" three months
 *   later. It cannot even answer it for one buyer.
 *
 *   The *minimum* each outcome requires. A no-answer asks for nothing, because
 *   nothing was learned. A confirmed need asks for the things that make it a
 *   confirmed need rather than an impression.
 *
 * All pure, so the caller view can show the requirement before the save and the
 * server can enforce the identical rule after it. One definition, checked in
 * both places, is what stops a refresh or a second tab walking past the gate.
 */

export type FieldKind = 'text' | 'longtext' | 'number' | 'date' | 'boolean' | 'choice';

export type DiscoveryField = {
  key: string;
  label: string;
  kind: FieldKind;
  /** Shown under the label. Written for somebody mid-call. */
  hint?: string;
  choices?: string[];
};

/**
 * Asked on every route, whatever the commercial shape.
 *
 * These are the facts that decide whether there is a deal at all: is the need
 * real, when, who decides, and what was promised.
 */
export const COMMON_FIELDS: DiscoveryField[] = [
  { key: 'confirmedNeed', label: 'What they said they need', kind: 'longtext',
    hint: 'Their words, not our inference. Blank if they did not say.' },
  { key: 'timing', label: 'When they need it', kind: 'text',
    hint: 'A date, a month, or "no timeline" — all three are answers.' },
  { key: 'buyerRole', label: 'Who you spoke to', kind: 'text', hint: 'Role, not just name.' },
  { key: 'decisionAuthority', label: 'Who decides', kind: 'text',
    hint: 'The person who signs. Often not the person who answers.' },
  { key: 'objections', label: 'Objections raised', kind: 'longtext' },
  { key: 'disqualifyReason', label: 'Anything that rules this out', kind: 'longtext',
    hint: 'A disqualifying fact is worth as much as a positive one.' },
  { key: 'nextStep', label: 'What you promised', kind: 'text',
    hint: 'Exactly what you said you would do. This becomes the follow-up.' },
];

/** Distribution: somebody buys goods on a cycle. */
const DISTRIBUTION_FIELDS: DiscoveryField[] = [
  { key: 'productCategory', label: 'Product or category', kind: 'text' },
  { key: 'specification', label: 'Specification, brand, substitution allowed', kind: 'longtext' },
  { key: 'quantity', label: 'Quantity', kind: 'text' },
  { key: 'reorderCycle', label: 'Frequency or reorder cycle', kind: 'text',
    hint: 'The difference between one order and a standing account.' },
  { key: 'deliveryLocation', label: 'Delivery location', kind: 'text' },
  { key: 'deliveryDate', label: 'Delivery date needed', kind: 'text' },
  { key: 'currentSupplier', label: 'Current supplier', kind: 'text' },
  { key: 'purchasingAuthority', label: 'Who raises the purchase order', kind: 'text' },
  { key: 'vendorRequirements', label: 'Vendor requirements to supply them', kind: 'longtext' },
  { key: 'sampleOrQuoteRequested', label: 'Asked for a sample or a quote', kind: 'boolean' },
];

/** Brokerage: somebody buys a service delivered by a provider. */
const BROKERAGE_FIELDS: DiscoveryField[] = [
  { key: 'scope', label: 'Scope of work', kind: 'longtext' },
  { key: 'locations', label: 'Locations', kind: 'text', hint: 'How many sites, and where.' },
  { key: 'frequency', label: 'Frequency', kind: 'text' },
  { key: 'incumbent', label: 'Current provider', kind: 'text' },
  { key: 'contractEnd', label: 'Contract end or decision date', kind: 'text',
    hint: 'The single most useful date on a service deal.' },
  { key: 'siteVisitRequired', label: 'Site visit needed to quote', kind: 'boolean' },
  { key: 'vendorRequirements', label: 'Insurance, bonding, vendor onboarding', kind: 'longtext' },
  { key: 'budgetProcess', label: 'Budget or bid process', kind: 'longtext' },
  { key: 'decisionParticipants', label: 'Who else is involved in deciding', kind: 'text' },
];

/** Subcontracting: somebody else holds the contract and needs local capacity. */
const SUBCONTRACTING_FIELDS: DiscoveryField[] = [
  { key: 'projectOrAward', label: 'Project or award', kind: 'text' },
  { key: 'capacityGap', label: 'What capacity they are short of', kind: 'longtext' },
  { key: 'tradeCapability', label: 'Trade or capability needed', kind: 'text' },
  { key: 'geography', label: 'Where the work is', kind: 'text' },
  { key: 'mobilisationDate', label: 'Mobilisation date', kind: 'text' },
  { key: 'credentials', label: 'Credentials required', kind: 'longtext',
    hint: 'Insurance, licences, bonding, safety record, union status.' },
  { key: 'rateStructure', label: 'Rate or quote structure', kind: 'text' },
  { key: 'onboardingContact', label: 'Onboarding contact and process', kind: 'longtext' },
];

const BY_ROUTE: Record<string, DiscoveryField[]> = {
  DISTRIBUTION: DISTRIBUTION_FIELDS,
  BROKERAGE: BROKERAGE_FIELDS,
  SUBCONTRACTING: SUBCONTRACTING_FIELDS,
  GENERAL: [],
};

/** Every field this route's caller may fill in, route-specific first. */
export function fieldsForRoute(route: SignalCategory | string): DiscoveryField[] {
  return [...(BY_ROUTE[route] ?? []), ...COMMON_FIELDS];
}

// ---------------------------------------------------------------------------
// What each outcome requires
// ---------------------------------------------------------------------------

/**
 * The minimum each disposition must carry.
 *
 * `common` is checked against the common fields, `route` picks the
 * route-specific keys that make that outcome meaningful — a confirmed need on a
 * distribution route means something different from one on a subcontract, and
 * asking for the wrong fields trains callers to type anything to get past the
 * gate.
 *
 * Two rules that are not negotiable:
 *
 *   Outcomes where nothing was learned require nothing. A no-answer is not a
 *   failure to record information; there was none.
 *
 *   Do-not-contact requires nothing, ever. Making it harder to honour than to
 *   ignore is the one requirement that would actively cause harm.
 */
export type DispositionRequirement = {
  /** Keys from the common set. */
  common: string[];
  /** Keys from the route-specific set, by route. */
  route?: Partial<Record<'DISTRIBUTION' | 'BROKERAGE' | 'SUBCONTRACTING', string[]>>;
  /** True when the outcome needs a date to come back on. */
  needsFollowUpDate?: boolean;
  /** Why this is asked, shown to the caller rather than left to be guessed. */
  because: string;
};

export const REQUIREMENTS: Record<CallDisposition, DispositionRequirement> = {
  NO_ANSWER: { common: [], because: 'Nothing was learned, so nothing is asked.' },
  LEFT_VOICEMAIL: { common: [], because: 'Nothing was learned, so nothing is asked.' },

  WRONG_NUMBER: {
    common: [],
    because:
      'The number is taken off the account and contact resolution reopens automatically. ' +
      'Nothing else is asked, so reporting it is never harder than ignoring it.',
  },

  DO_NOT_CONTACT: {
    common: [],
    because: 'Recorded immediately and permanently. Never gated behind anything.',
  },

  GATEKEEPER: {
    common: ['nextStep'],
    because: 'You reached a person. What you asked for is what the next caller needs to know.',
  },

  REACHED_RELEVANT_PERSON: {
    common: ['buyerRole'],
    because: 'Somebody who can speak to the requirement — record who, so the next call opens correctly.',
  },

  DECISION_MAKER_IDENTIFIED: {
    common: ['decisionAuthority'],
    because: 'Knowing who signs is the finding. Without the name it is not one.',
  },

  REACHED_DECISION_MAKER: {
    common: ['buyerRole', 'decisionAuthority'],
    because: 'You reached the person who decides. Their role and authority are the record.',
  },

  NEED_CONFIRMED: {
    common: ['confirmedNeed', 'timing', 'buyerRole'],
    route: {
      DISTRIBUTION: ['productCategory', 'quantity'],
      BROKERAGE: ['scope', 'locations'],
      SUBCONTRACTING: ['tradeCapability', 'geography'],
    },
    because: 'A confirmed need is a fact about their business. Without scope and timing it is an impression.',
  },

  NEED_UNCONFIRMED: {
    common: ['disqualifyReason'],
    because: 'A negative answer is a finding. Recording why stops the same hypothesis being retried.',
  },

  INTERESTED: {
    common: ['confirmedNeed', 'nextStep'],
    needsFollowUpDate: true,
    because: 'Interest with no next step and no date is not interest, it is a pleasant call.',
  },

  NEEDS_INFORMATION: {
    common: ['nextStep'],
    needsFollowUpDate: true,
    because: 'They asked for something. What, and by when, is the whole record.',
  },

  FOLLOW_UP: {
    common: ['nextStep'],
    needsFollowUpDate: true,
    because: 'A promise with no date is a promise nobody keeps.',
  },

  QUOTE_REQUESTED: {
    common: ['confirmedNeed', 'nextStep'],
    route: {
      DISTRIBUTION: ['productCategory', 'quantity', 'deliveryLocation'],
      BROKERAGE: ['scope', 'locations', 'frequency'],
      SUBCONTRACTING: ['tradeCapability', 'geography', 'rateStructure'],
    },
    needsFollowUpDate: true,
    because: 'A quote cannot be produced from an impression. These are the inputs a price needs.',
  },

  QUALIFIED_OPPORTUNITY: {
    common: ['confirmedNeed', 'timing', 'decisionAuthority', 'nextStep'],
    route: {
      DISTRIBUTION: ['productCategory', 'quantity', 'purchasingAuthority'],
      BROKERAGE: ['scope', 'locations', 'budgetProcess'],
      SUBCONTRACTING: ['projectOrAward', 'tradeCapability', 'mobilisationDate'],
    },
    needsFollowUpDate: true,
    because: 'This leaves cold calling and becomes a deal. It has to carry enough to be worked as one.',
  },

  ALREADY_HANDLED: {
    common: ['disqualifyReason'],
    route: { BROKERAGE: ['incumbent'], DISTRIBUTION: ['currentSupplier'] },
    because: 'Who has it, and when that ends, is what makes this worth revisiting rather than closing.',
  },

  NOT_INTERESTED: {
    common: ['disqualifyReason'],
    because: 'The reason separates "not now" from "never", and only one of them is worth a callback.',
  },

  BAD_FIT: {
    common: ['disqualifyReason'],
    because: 'A bad fit tells the engine its hypothesis was wrong. Unexplained, it teaches nothing.',
  },
};

export type ValidationResult = {
  ok: boolean;
  /** Field keys that are required and empty. */
  missing: string[];
  /** Human labels for those keys, for the message. */
  missingLabels: string[];
  /** True when a follow-up date is required and absent. */
  needsFollowUpDate: boolean;
  because: string;
};

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (typeof value === 'boolean') return false;
  if (typeof value === 'number') return Number.isNaN(value);
  return false;
}

/**
 * Whether this save carries its outcome's minimum.
 *
 * Called by the caller view before the save and by the server after it. The
 * same function both times, because a rule enforced only in the browser is a
 * rule a refresh walks past — which is exactly how the previous system's
 * after-call gate was defeated.
 */
export function validateDisposition(input: {
  disposition: CallDisposition;
  route: SignalCategory | string;
  discovery: Record<string, unknown>;
  followUpAt?: Date | string | null;
}): ValidationResult {
  const requirement = REQUIREMENTS[input.disposition];
  const routeKeys =
    requirement.route?.[input.route as 'DISTRIBUTION' | 'BROKERAGE' | 'SUBCONTRACTING'] ?? [];
  const required = [...requirement.common, ...routeKeys];

  const missing = required.filter((key) => isBlank(input.discovery[key]));
  const labels = new Map(fieldsForRoute(input.route).map((f) => [f.key, f.label]));

  const needsFollowUpDate = Boolean(requirement.needsFollowUpDate) && isBlank(input.followUpAt);

  return {
    ok: missing.length === 0 && !needsFollowUpDate,
    missing,
    missingLabels: missing.map((key) => labels.get(key) ?? key),
    needsFollowUpDate,
    because: requirement.because,
  };
}

/** The field definitions an outcome makes mandatory, for the form. */
export function requiredFieldsFor(
  disposition: CallDisposition,
  route: SignalCategory | string,
): DiscoveryField[] {
  const requirement = REQUIREMENTS[disposition];
  const routeKeys =
    requirement.route?.[route as 'DISTRIBUTION' | 'BROKERAGE' | 'SUBCONTRACTING'] ?? [];
  const keys = new Set([...requirement.common, ...routeKeys]);
  return fieldsForRoute(route).filter((f) => keys.has(f.key));
}

/**
 * Discovery values reduced to what the route recognises.
 *
 * A browser can post anything. Keeping only known keys means a caller cannot
 * accidentally — or deliberately — write arbitrary structure into the record
 * that later analysis would have to interpret.
 */
export function sanitiseDiscovery(
  route: SignalCategory | string,
  raw: unknown,
): Record<string, string | number | boolean> {
  if (!raw || typeof raw !== 'object') return {};
  const allowed = new Set(fieldsForRoute(route).map((f) => f.key));
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.has(key)) continue;
    if (typeof value === 'string') {
      const trimmed = value.trim().slice(0, 4000);
      if (trimmed) out[key] = trimmed;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
    } else if (typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}
