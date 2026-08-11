import type { AssertionTier, IntentKind, LeadRole, LeadStage, MarketSegment } from '@prisma/client';

/**
 * Lead qualification, rebuilt.
 *
 * The model this replaces treated "we found a company" and "a company wants to
 * buy" as the same fact. A gym that has never heard of us scored 88 because it
 * was recent, had a phone number, came from a live source and matched a
 * category search — four things that are all true of every business on earth
 * and say nothing about buying.
 *
 * The correction is a hard separation:
 *
 *   Account fit   — does this look like the kind of organisation we serve?
 *                   A directory listing can establish this, legitimately.
 *   Intent        — is there dated evidence they may be buying *now*?
 *                   Only an external event or a conversation can establish it.
 *   Contactability— can we reach a person who decides?
 *   Fulfilment    — could we deliver if they said yes today?
 *
 * Priority combines them for ordering. It is never a claim about the lead on
 * its own, and a high-fit zero-intent record must never outrank a real signal.
 */

// ---------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------

/**
 * What each kind of intent event is worth at full freshness.
 *
 * A conversation outranks everything because it is the only category where
 * someone has actually said something. Permits and openings are strong because
 * the work is committed. A job posting is weaker — hiring a facilities manager
 * suggests activity, not a purchase.
 */
export const INTENT_WEIGHTS: Record<IntentKind, number> = {
  CONVERSATION_CONFIRMED: 1.0,
  RFQ_ISSUED: 0.95,
  PURCHASING_NOTICE: 0.9,
  CONTRACT_EXPIRY: 0.85,
  INCUMBENT_CHANGE: 0.8,
  FACILITY_OPENING: 0.8,
  PERMIT_FILED: 0.75,
  CONTRACT_AWARD: 0.7,
  EXPANSION: 0.65,
  VENDOR_REGISTRATION: 0.6,
  JOB_POSTING: 0.4,
};

/**
 * Things that must never contribute intent, kept as a list because they were
 * all previously scored and each one is individually tempting.
 */
export const NON_INTENT_FACTORS = [
  'recently discovered',
  'has a main phone number',
  'came from a live source',
  'matched a business-category search',
  'exists in a directory',
] as const;

export type IntentSignal = {
  kind: IntentKind;
  /** When the event happened per the source. Not when it was ingested. */
  occurredAt: Date;
  tier: AssertionTier;
};

/**
 * Intent decays. A permit filed fourteen months ago is history, not a lead.
 * Half-life of roughly 90 days, floored at zero after two years.
 */
export function intentDecay(occurredAt: Date, now = new Date()): number {
  const days = (now.getTime() - occurredAt.getTime()) / 86_400_000;
  if (days < 0) return 1; // future-dated events (a contract starting soon) stay hot
  if (days > 730) return 0;
  return Math.pow(0.5, days / 90);
}

export type IntentResult = {
  score: number;
  reason: string;
  strongest: IntentSignal | null;
  lastSignalAt: Date | null;
};

/**
 * Intent from events only.
 *
 * With no events the answer is zero and says so. That is the single most
 * important behaviour in this file: the overwhelming majority of discovered
 * accounts have no intent, and the system must be willing to say so rather
 * than manufacturing a number from the circumstances of its own discovery.
 */
export function scoreIntent(signals: IntentSignal[], now = new Date()): IntentResult {
  if (signals.length === 0) {
    return {
      score: 0,
      reason:
        'No intent evidence. This organisation was found in a directory or registry, which shows it exists and may fit — not that it is buying anything.',
      strongest: null,
      lastSignalAt: null,
    };
  }

  const scored = signals
    .map((signal) => ({
      signal,
      // An unconfirmed inference cannot carry full weight even when the event
      // type is strong; only the source or a person can vouch for it.
      value:
        INTENT_WEIGHTS[signal.kind] *
        intentDecay(signal.occurredAt, now) *
        (signal.tier === 'SYSTEM_INFERENCE' ? 0.5 : 1),
    }))
    .sort((a, b) => b.value - a.value);

  const top = scored[0];
  // Corroboration matters but must not let five weak events out-score one
  // strong one, so the remainder contributes with sharply diminishing returns.
  const rest = scored.slice(1).reduce((sum, s, index) => sum + s.value / (index + 3), 0);
  const score = clamp01(top.value + rest);

  const days = Math.max(0, Math.round((now.getTime() - top.signal.occurredAt.getTime()) / 86_400_000));
  return {
    score,
    reason:
      `${humaniseIntent(top.signal.kind)} ${days === 0 ? 'today' : `${days} day(s) ago`}` +
      `${signals.length > 1 ? `, plus ${signals.length - 1} other intent signal(s)` : ''}.` +
      `${top.signal.tier === 'SYSTEM_INFERENCE' ? ' Inferred rather than stated, so counted at half weight.' : ''}`,
    strongest: top.signal,
    lastSignalAt: scored.reduce(
      (latest, s) => (latest === null || s.signal.occurredAt > latest ? s.signal.occurredAt : latest),
      null as Date | null,
    ),
  };
}

export function humaniseIntent(kind: IntentKind): string {
  const labels: Record<IntentKind, string> = {
    PERMIT_FILED: 'Building permit filed',
    FACILITY_OPENING: 'Facility opening',
    EXPANSION: 'Expansion announced',
    JOB_POSTING: 'Relevant job posting',
    VENDOR_REGISTRATION: 'Vendor registration opened',
    PURCHASING_NOTICE: 'Purchasing notice issued',
    CONTRACT_AWARD: 'Contract awarded',
    CONTRACT_EXPIRY: 'Contract approaching expiry',
    INCUMBENT_CHANGE: 'Incumbent provider changed',
    RFQ_ISSUED: 'Request for quote issued',
    CONVERSATION_CONFIRMED: 'Confirmed in conversation',
  };
  return labels[kind];
}

// ---------------------------------------------------------------------------
// Account fit
// ---------------------------------------------------------------------------

export type FitInput = {
  /** Path segments; empty means the path takes anything. */
  pathSegments: MarketSegment[];
  segment: MarketSegment;
  /** Roles this path actually deals in. Empty means any. */
  pathRoles: LeadRole[];
  leadRole: LeadRole;
  /**
   * True when the service maps to a capability already in the catalogue —
   * something we can price and match — rather than a connector's generic
   * fallback label.
   */
  serviceIsCatalogued: boolean;
  /** City and state both known and plausible, not just a state. */
  locationPrecision: 'CITY' | 'STATE' | 'UNKNOWN';
  /** Matched to a named local market rather than only the national sweep. */
  matchedLocalMarket: boolean;
};

/**
 * Account fit.
 *
 * The first version of this scored four things that were true of every record
 * by construction — the segment always matched because every connector emits
 * COMMERCIAL, the service was always present because every connector hardcodes
 * one, the market always matched because the market was assigned from the
 * enabled list, and the source was always live because only live records were
 * examined. Four boxes that could not be unticked, so every account scored 100
 * and the dimension carried no information at all.
 *
 * These five vary. A CMS record carries a city; a USAspending award often
 * carries only a state. A Places result matched to the Dallas metro is more
 * useful than one that only landed in the national sweep. A service naming a
 * capability we hold providers for is worth more than a generic label. That is
 * what a fit score is supposed to distinguish.
 */
export function scoreAccountFit(input: FitInput): { score: number; reason: string } {
  const parts = [
    {
      label: 'segment',
      weight: 0.2,
      value: input.pathSegments.length === 0 || input.pathSegments.includes(input.segment) ? 1 : 0,
      yes: `${titleCase(input.segment)} is a segment this path works`,
      no: `${titleCase(input.segment)} is outside this path's segments`,
    },
    {
      label: 'role',
      weight: 0.2,
      value: input.pathRoles.length === 0 || input.pathRoles.includes(input.leadRole) ? 1 : 0,
      yes: `${titleCase(input.leadRole)} is a role this path deals in`,
      no: `${titleCase(input.leadRole)} is not a role this path deals in`,
    },
    {
      label: 'service',
      weight: 0.2,
      value: input.serviceIsCatalogued ? 1 : 0.25,
      yes: 'the service maps to a capability we can price and match',
      no: 'the service is a generic label, not a catalogued capability',
    },
    {
      label: 'location',
      weight: 0.2,
      value: input.locationPrecision === 'CITY' ? 1 : input.locationPrecision === 'STATE' ? 0.4 : 0,
      yes: 'city and state are both known',
      no: input.locationPrecision === 'STATE' ? 'only a state is known, no city' : 'no usable location',
    },
    {
      label: 'market',
      weight: 0.2,
      value: input.matchedLocalMarket ? 1 : 0.3,
      yes: 'falls inside a named market we work',
      no: 'only inside the nationwide sweep, not a market we actively work',
    },
  ];

  const score = clamp01(parts.reduce((sum, p) => sum + p.value * p.weight, 0));
  const strong = parts.filter((p) => p.value >= 0.9).map((p) => p.yes);
  const weak = parts.filter((p) => p.value < 0.9).map((p) => p.no);

  return {
    score,
    reason:
      `Profile fit only — this says nothing about whether they are buying. ` +
      `${strong.length > 0 ? `In favour: ${strong.join(', ')}. ` : ''}` +
      `${weak.length > 0 ? `Against: ${weak.join(', ')}.` : ''}`.trim(),
  };
}

// ---------------------------------------------------------------------------
// Contactability
// ---------------------------------------------------------------------------

export type ContactInput = {
  hasRoutingPhone: boolean;
  hasDirectPhone: boolean;
  hasEmail: boolean;
  /** A website is a route to finding a named person, not a contact itself. */
  hasWebsite: boolean;
  /** A person's name from the source, rather than an unnamed main line. */
  hasNamedPerson: boolean;
  /** A named person established to decide or sign. */
  hasIdentifiedDecisionMaker: boolean;
  decisionMakerVerified: boolean;
};

/**
 * Contactability.
 *
 * A switchboard number is not a decision-maker, and the first version was
 * right about that but got the shape wrong: it returned the first matching
 * branch, so every discovered record — all of which have a main line, no
 * mobile and no named person — returned exactly 0.3. Correct in principle,
 * useless in practice, because it could not tell a bare phone number from a
 * phone number plus an email plus a named office manager.
 *
 * A routing-only record now accumulates from its corroborating channels but
 * stays capped well below a named decision-maker, which is the property that
 * matters.
 */
export const ROUTING_ONLY_CEILING = 0.45;

export function scoreContactability(input: ContactInput): { score: number; reason: string } {
  if (input.hasIdentifiedDecisionMaker && input.decisionMakerVerified) {
    return { score: 1, reason: 'A verified decision-maker with direct contact details is on file.' };
  }
  if (input.hasIdentifiedDecisionMaker) {
    return { score: 0.75, reason: 'A decision-maker is named but not yet verified.' };
  }

  const routes: Array<{ has: boolean; value: number; label: string }> = [
    { has: input.hasDirectPhone, value: 0.3, label: 'a direct or mobile number' },
    { has: input.hasRoutingPhone, value: 0.2, label: 'a main switchboard line' },
    { has: input.hasEmail, value: 0.12, label: 'an email address' },
    { has: input.hasNamedPerson, value: 0.1, label: 'a named person (role unconfirmed)' },
    { has: input.hasWebsite, value: 0.05, label: 'a website to research a contact from' },
  ];

  const present = routes.filter((r) => r.has);
  if (present.length === 0) {
    return { score: 0, reason: 'No contact route at all. Research is needed before this can be worked.' };
  }

  const raw = present.reduce((sum, r) => sum + r.value, 0);
  const score = Math.min(raw, ROUTING_ONLY_CEILING);

  return {
    score,
    reason:
      `Nobody has been established as the decision-maker, so this is capped at ${Math.round(ROUTING_ONLY_CEILING * 100)}. ` +
      `Available: ${present.map((r) => r.label).join(', ')}. ` +
      `${input.hasRoutingPhone && !input.hasDirectPhone ? 'Expect a gatekeeper on the main line first.' : ''}`.trim(),
  };
}

// ---------------------------------------------------------------------------
// Fulfilment readiness
// ---------------------------------------------------------------------------

export type FulfilmentInput = {
  /** Providers in this market able to do this work. */
  availableProviders: number;
  minimumProviders: number;
  /** Whether the path needs supply at all — provider-side leads do not. */
  requiresSupply: boolean;
};

export function scoreFulfilmentReadiness(input: FulfilmentInput): { score: number; reason: string } {
  if (!input.requiresSupply) {
    return { score: 1, reason: 'This lead is supply-side; no fulfilment capacity is needed to act on it.' };
  }
  if (input.availableProviders === 0) {
    return {
      score: 0,
      reason: 'No provider in this market can do this work. Selling it would create an obligation we cannot meet.',
    };
  }
  const ratio = clamp01(input.availableProviders / Math.max(1, input.minimumProviders));
  return {
    score: ratio,
    reason: `${input.availableProviders} provider(s) available against a minimum of ${input.minimumProviders}.`,
  };
}

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

export type PriorityInput = {
  accountFit: number;
  intent: number;
  contactability: number;
  fulfilmentReadiness: number;
};

/**
 * Ordering only.
 *
 * Intent is weighted hardest and, crucially, **gates** the rest: with zero
 * intent the ceiling is low no matter how perfect the fit, because a perfect
 * fit with no intent is a cold call. That property is what stops the board
 * filling with directory listings again.
 */
export function scorePriority(input: PriorityInput): { score: number; reason: string } {
  const base =
    input.accountFit * 0.25 +
    input.intent * 0.45 +
    input.contactability * 0.2 +
    input.fulfilmentReadiness * 0.1;

  // Without intent this is prospecting, and prospecting must never outrank a
  // company with a live signal.
  const ceiling = input.intent === 0 ? 0.35 : 1;
  const score = Math.round(Math.min(base, ceiling) * 100);

  return {
    score,
    reason:
      input.intent === 0
        ? `Capped at 35 because there is no intent evidence. Fit ${pct(input.accountFit)}, contactability ${pct(input.contactability)} — a cold approach, however good the profile.`
        : `Intent ${pct(input.intent)}, fit ${pct(input.accountFit)}, contactability ${pct(input.contactability)}, fulfilment ${pct(input.fulfilmentReadiness)}.`,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export type QualificationEvidence = {
  need: { present: boolean; tier?: AssertionTier };
  decisionMaker: { present: boolean; verified?: boolean };
  timing: { present: boolean };
  fit: { present: boolean };
  nextStep: { present: boolean };
};

export type StageDecision = {
  stage: LeadStage;
  missing: string[];
  reason: string;
};

/**
 * Where a hypothesis sits, and what is missing to move it on.
 *
 * QUALIFIED_LEAD requires all five of need, decision-maker, timing, fit and
 * next step, and the need may not be a system inference — we do not get to
 * qualify a lead on our own guess about what they want.
 */
export function decideStage(params: {
  intentScore: number;
  accountFit: number;
  evidence: QualificationEvidence;
  currentStage?: LeadStage;
}): StageDecision {
  const { evidence } = params;

  // Terminal states are held; only a person moves a record out of them.
  if (params.currentStage === 'DISQUALIFIED' || params.currentStage === 'ACTIVE_OPPORTUNITY') {
    return { stage: params.currentStage, missing: [], reason: 'Set by a person; not recomputed.' };
  }

  const missing: string[] = [];
  if (!evidence.need.present) missing.push('a stated or evidenced need');
  else if (evidence.need.tier === 'SYSTEM_INFERENCE') missing.push('a need confirmed by the source or a conversation, not inferred');
  if (!evidence.decisionMaker.present) missing.push('an identified decision-maker');
  if (!evidence.timing.present) missing.push('timing — when they would buy');
  if (!evidence.fit.present) missing.push('confirmed fit');
  if (!evidence.nextStep.present) missing.push('an agreed next step');

  if (missing.length === 0) {
    return { stage: 'QUALIFIED_LEAD', missing: [], reason: 'Need, decision-maker, timing, fit and next step are all established.' };
  }

  if (params.intentScore > 0) {
    return {
      stage: 'INTENT_DETECTED',
      missing,
      reason: 'A dated external event suggests they may be buying, but this is not yet a qualified lead.',
    };
  }

  if (params.accountFit >= 0.5) {
    return {
      stage: 'OPPORTUNITY_HYPOTHESIS',
      missing,
      reason:
        'The organisation fits the profile, so a path is worth testing. This is our hypothesis about them, not anything they have said.',
    };
  }

  return {
    stage: 'DISCOVERED_ACCOUNT',
    missing,
    reason: 'A source confirms this organisation exists. Nothing further is established.',
  };
}

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------

/**
 * Role-appropriate wording for what a record represents.
 *
 * A provider's capability is not a buyer's need, and calling both an
 * "identified need" put words in people's mouths. Nothing here claims more
 * than the evidence supports.
 */
export function describeRelevance(role: LeadRole, service: string | null, hasIntent: boolean): string {
  const subject = service ?? 'facility services';
  if (!hasIntent) {
    switch (role) {
      case 'BUYER':
        return `Possible need for ${subject}. Inferred from the organisation type — they have not said anything.`;
      case 'PROVIDER':
      case 'SUBCONTRACTOR':
        return `Offers ${subject} capability, per its own listing. Capacity and credentials unverified.`;
      case 'SUPPLIER':
        return `Offers ${subject} products, per its own listing. Pricing and terms unknown.`;
      case 'CONTRACTOR':
        return `May subcontract ${subject}. No evidence yet that they are looking.`;
      case 'PARTNER':
        return `Possible partner for ${subject}. Nothing established.`;
      default:
        return `Possible relevance to ${subject}. Role not yet established.`;
    }
  }

  switch (role) {
    case 'BUYER':
      return `Evidenced need for ${subject}.`;
    case 'PROVIDER':
    case 'SUBCONTRACTOR':
      return `Available capacity for ${subject}.`;
    case 'SUPPLIER':
      return `Supplies ${subject}, with a live signal.`;
    case 'CONTRACTOR':
      return `Actively seeking subcontractors for ${subject}.`;
    default:
      return `Live signal relating to ${subject}.`;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function titleCase(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ');
}
