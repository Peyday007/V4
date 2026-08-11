import type { DemandEventType, EventPartyRole, SignalCategory } from '@prisma/client';

/**
 * Job-generation playbooks.
 *
 * A playbook is the knowledge that turns one dated event into one commercial
 * route. It is not a template for a message and not a category filter — it is
 * the answer to "a gym is opening on the first; what, specifically, is there
 * to sell, to whom, when, and what would make it not worth doing".
 *
 * The registry is configurable and keyed, so a second vertical is data rather
 * than a rewrite. Only commercial facility cleaning and janitorial supplies is
 * filled in; the shape is what makes the next one cheap.
 *
 * The rule this structure exists to enforce: a route is created because an
 * event supports it, never because a connector or a query was named after a
 * business path. Provider discovery is not subcontracting demand. A cleaning
 * company found in a directory is potential *supply*; a subcontracting
 * opportunity needs evidence that work exists or that a prime is actively
 * building fulfilment capacity.
 */

export type BuyingWindowRule = {
  /** Days relative to the event's own date. Negative is before it. */
  opensDaysFromEvent: number;
  closesDaysFromEvent: number;
  /** Why this window and not another, in the operator's language. */
  reason: string;
};

export type FrictionFactorRule = {
  key: string;
  /** Question this factor answers about the specific opportunity. */
  question: string;
  /** Positive raises friction, negative lowers it. */
  weight: number;
};

export type Playbook = {
  key: string;
  route: SignalCategory;
  vertical: string;
  subvertical: string;
  label: string;
  /** Only these event types can produce this route. */
  qualifyingEvents: DemandEventType[];
  /**
   * Facts that must be present in the event before the route is created at
   * all. A missing required fact is a reason not to build the route, not a
   * gap to fill in later with a guess.
   */
  requiredEvidence: string[];
  /** Improves confidence and lowers friction when present. */
  optionalEvidence: string[];
  /** Whose problem this is inside the buying organisation. */
  likelyBuyerRoles: EventPartyRole[];
  /** What we would need on the supply side to deliver it. */
  requiredCapability: string;
  window: BuyingWindowRule;
  /** Typical deal size, used for economics before anything is quoted. */
  typicalBuyerPrice: { low: number; high: number };
  typicalMarginPct: number;
  typicalCycleDays: number;
  /** Minutes of human time a deal of this shape usually consumes. */
  typicalHumanMinutes: number;
  /** 0–1, how much of the workflow can run without a person. */
  automationPotential: number;
  frictionFactors: FrictionFactorRule[];
  compliance: string[];
  /** Questions a person must answer before this can be pursued seriously. */
  verificationQuestions: string[];
  /** Conditions that end the route. */
  rejectionConditions: string[];
  /** What to do first, before anything is sold. */
  firstAction: string;
  /** Sources that reliably carry this event type, and ones that do not. */
  authoritativeSources: string[];
  noisySources: string[];
};

const CLEANING_COMPLIANCE = [
  'General liability insurance, commonly $1M per occurrence for commercial premises',
  'Workers compensation for any crew on site',
  'Janitorial bonding where the buyer holds keys or alarm codes',
];

/**
 * Commercial facility cleaning and janitorial supplies.
 *
 * All three routes, driven by the events that actually create each one. Note
 * what is *not* here: nothing produces a route from "this company is a gym"
 * or "this company is a cleaning contractor". Every entry needs a dated event.
 */
export const CLEANING_PLAYBOOKS: Playbook[] = [
  // -------------------------------------------------------------------------
  // Brokerage — we place a cleaning provider with a buyer
  // -------------------------------------------------------------------------
  {
    key: 'cleaning.brokerage.pre_opening',
    route: 'BROKERAGE',
    vertical: 'Commercial facility services',
    subvertical: 'Cleaning',
    label: 'Pre-opening and final clean',
    qualifyingEvents: [
      'FACILITY_OPENING',
      'OCCUPANCY_OR_OPERATING_APPROVAL',
      'NEW_LOCATION',
      'NEW_LEASE',
      'RENOVATION_OR_CONSTRUCTION',
    ],
    requiredEvidence: ['a dated opening or occupancy date', 'a physical address'],
    optionalEvidence: ['square footage', 'named owner or operator', 'general contractor'],
    likelyBuyerRoles: ['BUYER', 'PROPERTY_OWNER', 'PROPERTY_MANAGER'],
    requiredCapability: 'Post-construction cleaning',
    window: {
      // The one-shot job before the doors open. Too early and the trades are
      // still on site; too late and somebody has already done it badly.
      opensDaysFromEvent: -35,
      closesDaysFromEvent: -2,
      reason:
        'A final clean happens in the fortnight before opening. Approaching more than five weeks out reaches ' +
        'someone still dealing with contractors; approaching after the door opens is too late to sell it.',
    },
    typicalBuyerPrice: { low: 800, high: 4500 },
    typicalMarginPct: 30,
    typicalCycleDays: 10,
    typicalHumanMinutes: 45,
    automationPotential: 0.7,
    frictionFactors: [
      { key: 'local_owner', question: 'Is the operator an independent local business?', weight: -2 },
      { key: 'one_time', question: 'Is this a single transaction rather than a contract?', weight: -2 },
      { key: 'no_incumbent', question: 'Is there no existing cleaning vendor to displace?', weight: -2 },
      { key: 'chain_control', question: 'Is purchasing controlled by a chain or franchisor?', weight: 3 },
      { key: 'formal_procurement', question: 'Does a formal procurement process apply?', weight: 3 },
      { key: 'onboarding', question: 'Is vendor onboarding paperwork required?', weight: 2 },
    ],
    compliance: CLEANING_COMPLIANCE,
    verificationQuestions: [
      'Is the opening date still what the source said?',
      'Has a cleaning contractor already been appointed by the builder?',
      'Who signs off on pre-opening spend — the operator or a franchisor?',
    ],
    rejectionConditions: [
      'The opening date has passed by more than a week',
      'The general contractor has the final clean in their scope',
    ],
    firstAction: 'Call the operator to confirm the opening date and ask who is handling the final clean.',
    authoritativeSources: ['socrata_business_licenses', 'socrata_open_data', 'inbound_intake'],
    noisySources: ['google_places'],
  },
  {
    key: 'cleaning.brokerage.recurring',
    route: 'BROKERAGE',
    vertical: 'Commercial facility services',
    subvertical: 'Cleaning',
    label: 'Recurring cleaning contract',
    qualifyingEvents: [
      'FACILITY_OPENING',
      'OCCUPANCY_OR_OPERATING_APPROVAL',
      'NEW_LOCATION',
      'NEW_LEASE',
      'EXPANSION',
      'CONTRACT_EXPIRATION',
      'VENDOR_FAILURE_OR_COMPLAINT',
    ],
    requiredEvidence: ['a dated event establishing the premises are or will be operating', 'a physical address'],
    optionalEvidence: ['square footage', 'operating hours', 'existing vendor', 'staff headcount'],
    likelyBuyerRoles: ['BUYER', 'PROPERTY_MANAGER'],
    requiredCapability: 'Commercial janitorial',
    window: {
      // Recurring work gets decided once the place is actually running and the
      // owner has discovered how much mess it makes.
      opensDaysFromEvent: -14,
      closesDaysFromEvent: 90,
      reason:
        'A recurring contract is usually settled in the first weeks of operating, once the owner has seen the ' +
        'real cleaning load. Before opening they are dealing with fit-out, not schedules.',
    },
    typicalBuyerPrice: { low: 900, high: 6000 },
    typicalMarginPct: 26,
    typicalCycleDays: 30,
    typicalHumanMinutes: 120,
    automationPotential: 0.5,
    frictionFactors: [
      { key: 'local_owner', question: 'Is the operator an independent local business?', weight: -2 },
      { key: 'no_incumbent', question: 'Is there no existing cleaning vendor to displace?', weight: -2 },
      { key: 'incumbent_displacement', question: 'Would this displace an existing vendor?', weight: 3 },
      { key: 'chain_control', question: 'Is purchasing controlled by a chain or franchisor?', weight: 3 },
      { key: 'sensitive_access', question: 'Does the work need keys, alarm codes or after-hours access?', weight: 2 },
      { key: 'custom_scope', question: 'Is the scope unusual rather than standard commercial cleaning?', weight: 2 },
    ],
    compliance: CLEANING_COMPLIANCE,
    verificationQuestions: [
      'Is the site actually operating?',
      'Is there an incumbent cleaner, and when does that arrangement end?',
      'Who decides — the operator, a property manager, or head office?',
    ],
    rejectionConditions: [
      'A multi-year contract was signed within the last month',
      'The site is not open and the opening has been abandoned',
    ],
    firstAction: 'Confirm whether cleaning is handled in-house, by an incumbent, or not yet arranged.',
    authoritativeSources: ['socrata_business_licenses', 'socrata_open_data', 'inbound_intake'],
    noisySources: ['google_places'],
  },
  {
    key: 'cleaning.brokerage.turnover',
    route: 'BROKERAGE',
    vertical: 'Commercial facility services',
    subvertical: 'Cleaning',
    label: 'Property turnover clean',
    qualifyingEvents: ['PROPERTY_TURNOVER', 'NEW_LEASE', 'RENOVATION_OR_CONSTRUCTION'],
    requiredEvidence: ['a dated turnover, lease or completion date', 'a physical address'],
    optionalEvidence: ['unit count', 'property manager name'],
    likelyBuyerRoles: ['PROPERTY_MANAGER', 'PROPERTY_OWNER'],
    requiredCapability: 'Commercial janitorial',
    window: {
      opensDaysFromEvent: -21,
      closesDaysFromEvent: 14,
      reason: 'Turnover cleaning is booked in the short gap between one occupant leaving and the next arriving.',
    },
    typicalBuyerPrice: { low: 300, high: 2500 },
    typicalMarginPct: 32,
    typicalCycleDays: 7,
    typicalHumanMinutes: 30,
    automationPotential: 0.75,
    frictionFactors: [
      { key: 'local_manager', question: 'Is there a local property manager with authority?', weight: -3 },
      { key: 'standard_scope', question: 'Is the scope a standard turnover clean?', weight: -2 },
      { key: 'one_time', question: 'Is this a single transaction rather than a contract?', weight: -1 },
      { key: 'enterprise_owner', question: 'Is the property held by an institutional owner?', weight: 3 },
    ],
    compliance: CLEANING_COMPLIANCE,
    verificationQuestions: [
      'Which unit or building, and when does it need to be ready?',
      'Does the manager already have a turnover crew?',
    ],
    rejectionConditions: ['The turnover date has passed'],
    firstAction: 'Ask the property manager when the unit must be ready and whether a crew is already booked.',
    authoritativeSources: ['socrata_open_data', 'inbound_intake'],
    noisySources: ['google_places'],
  },
  {
    key: 'cleaning.brokerage.solicitation',
    route: 'BROKERAGE',
    vertical: 'Commercial facility services',
    subvertical: 'Cleaning',
    label: 'Answer an open cleaning solicitation',
    qualifyingEvents: ['ACTIVE_RFP', 'ACTIVE_RFQ', 'PROCUREMENT_NOTICE', 'VENDOR_REQUEST', 'INBOUND_REQUEST'],
    requiredEvidence: ['a published request for cleaning services', 'a buying organisation'],
    optionalEvidence: ['deadline', 'scope document', 'incumbent', 'estimated value'],
    likelyBuyerRoles: ['BUYER'],
    requiredCapability: 'Commercial janitorial',
    window: {
      opensDaysFromEvent: 0,
      closesDaysFromEvent: 45,
      reason: 'The window is the solicitation itself. Where a deadline is published it overrides this entirely.',
    },
    typicalBuyerPrice: { low: 2000, high: 40000 },
    typicalMarginPct: 20,
    typicalCycleDays: 45,
    typicalHumanMinutes: 300,
    automationPotential: 0.35,
    frictionFactors: [
      { key: 'formal_procurement', question: 'Does a formal procurement process apply?', weight: 4 },
      { key: 'onboarding', question: 'Is vendor registration or onboarding required?', weight: 2 },
      { key: 'bonding', question: 'Are bonding or heavy insurance requirements stated?', weight: 3 },
      { key: 'inbound', question: 'Did the buyer approach us directly?', weight: -4 },
      { key: 'standard_scope', question: 'Is the scope standard commercial cleaning?', weight: -1 },
    ],
    compliance: [...CLEANING_COMPLIANCE, 'Any registration, bonding or certification the solicitation names'],
    verificationQuestions: [
      'Is the deadline still open?',
      'Has it already been awarded?',
      'Can we meet every mandatory requirement, or is one of them structurally disqualifying?',
    ],
    rejectionConditions: [
      'The deadline has passed',
      'It has been awarded',
      'A mandatory requirement cannot be met by us or by any provider we can reach',
    ],
    firstAction: 'Read the requirements and confirm we can satisfy every mandatory one before spending time.',
    authoritativeSources: ['inbound_intake', 'sam_gov_opportunities'],
    noisySources: [],
  },

  // -------------------------------------------------------------------------
  // Subcontracting — somebody else holds the work and needs local capacity
  // -------------------------------------------------------------------------
  {
    key: 'cleaning.subcontracting.capacity_request',
    route: 'SUBCONTRACTING',
    vertical: 'Commercial facility services',
    subvertical: 'Cleaning',
    label: 'Prime or facilities company needs local crew',
    // Only explicit requests. A contract award alone is not a subcontracting
    // opportunity, and treating it as one is the single easiest way to
    // manufacture a pipeline out of nothing.
    qualifyingEvents: ['SUBCONTRACTOR_REQUEST', 'VENDOR_REQUEST', 'STAFFING_OR_CAPACITY_GAP', 'INBOUND_REQUEST'],
    requiredEvidence: [
      'a named prime contractor or facilities company',
      'evidence they are seeking local fulfilment capacity',
      'a territory or site the capacity is needed in',
    ],
    optionalEvidence: ['rate expectations', 'volume', 'start date', 'insurance requirements'],
    likelyBuyerRoles: ['PRIME_CONTRACTOR'],
    requiredCapability: 'Commercial janitorial',
    window: {
      opensDaysFromEvent: 0,
      closesDaysFromEvent: 60,
      reason: 'A prime looking for crews fills the gap quickly, because they already owe someone the work.',
    },
    typicalBuyerPrice: { low: 1500, high: 25000 },
    typicalMarginPct: 18,
    typicalCycleDays: 21,
    typicalHumanMinutes: 180,
    automationPotential: 0.45,
    frictionFactors: [
      { key: 'onboarding', question: 'Is vendor onboarding paperwork required?', weight: 3 },
      { key: 'insurance_burden', question: 'Are insurance limits above the normal commercial level?', weight: 2 },
      { key: 'inbound', question: 'Did they approach us?', weight: -3 },
      { key: 'standard_scope', question: 'Is the scope standard commercial cleaning?', weight: -1 },
    ],
    compliance: [
      ...CLEANING_COMPLIANCE,
      'Whatever the prime requires of its subcontractors, which is usually stricter than the buyer would be',
    ],
    verificationQuestions: [
      'Which specific sites or territory?',
      'Is this a real awarded scope or a list they are building for later?',
      'What rate are they paying, and does it leave a margin?',
    ],
    rejectionConditions: [
      'The capacity has been filled',
      'The rate offered leaves no margin after provider cost',
    ],
    firstAction: 'Confirm the sites, the volume and the rate before sourcing any crew.',
    authoritativeSources: ['inbound_intake'],
    noisySources: ['google_places', 'usaspending_awards'],
  },

  {
    key: 'cleaning.subcontracting.award_capacity_gap',
    route: 'SUBCONTRACTING',
    vertical: 'Commercial facility services',
    subvertical: 'Cleaning',
    label: 'Local crew for an out-of-area prime',
    // The careful one. An award alone is not an open subcontracting job, and
    // treating it as one manufactures a pipeline out of nothing. What an award
    // *can* support is a narrower hypothesis: a janitorial contract performed
    // in a state where the winner has no presence needs crews on the ground
    // there, and that is usually a local subcontractor. The required evidence
    // below is what makes the difference — the geography must actually differ.
    qualifyingEvents: ['CONTRACT_AWARD'],
    requiredEvidence: [
      'a named prime contractor who won the work',
      'a stated place of performance',
      'evidence the prime is not already established in that market',
    ],
    optionalEvidence: ['award value', 'period of performance', 'number of sites'],
    likelyBuyerRoles: ['PRIME_CONTRACTOR'],
    requiredCapability: 'Commercial janitorial',
    window: {
      // Primes staff up between award and start of performance. Before the
      // award there is nothing; long after it the crews are hired.
      opensDaysFromEvent: 0,
      closesDaysFromEvent: 75,
      reason:
        'A prime staffs a new territory in the weeks after the award. Approaching six months later reaches ' +
        'somebody who solved the problem in month one.',
    },
    typicalBuyerPrice: { low: 2000, high: 30000 },
    typicalMarginPct: 16,
    typicalCycleDays: 30,
    typicalHumanMinutes: 150,
    automationPotential: 0.5,
    frictionFactors: [
      { key: 'onboarding', question: 'Does the prime require vendor onboarding?', weight: 3 },
      { key: 'insurance_burden', question: 'Are insurance limits above the ordinary commercial level?', weight: 2 },
      { key: 'no_incumbent', question: 'Is the territory genuinely uncovered for them?', weight: -2 },
      { key: 'standard_scope', question: 'Is the scope standard commercial cleaning?', weight: -1 },
    ],
    compliance: [
      ...CLEANING_COMPLIANCE,
      'Whatever the prime requires of subcontractors, which is usually stricter than the end buyer would be',
    ],
    verificationQuestions: [
      'Do they already have crews in this market, or are they subcontracting it?',
      'Which specific sites, and when does performance start?',
      'What rate are they paying a subcontractor, and does it leave a margin?',
    ],
    rejectionConditions: [
      'They confirm they already have local crews',
      'The period of performance has already ended',
      'The rate offered leaves no margin after provider cost',
    ],
    firstAction:
      'Call the prime and ask whether they are covering this territory in-house or looking for a local crew. ' +
      'The whole hypothesis rests on that answer.',
    authoritativeSources: ['contract_awards'],
    noisySources: ['google_places'],
  },
  {
    key: 'cleaning.subcontracting.vendor_network',
    route: 'SUBCONTRACTING',
    vertical: 'Commercial facility services',
    subvertical: 'Cleaning',
    label: 'Join a vendor network or approved list',
    // A standing vendor list is an invitation to register, not a job. It is
    // worth doing and it is worth almost nothing until work follows, which is
    // why the economics here are deliberately small.
    qualifyingEvents: ['VENDOR_REQUEST'],
    requiredEvidence: ['an organisation inviting vendors to register', 'the trade it covers'],
    optionalEvidence: ['registration deadline', 'expected volume', 'insurance requirements'],
    likelyBuyerRoles: ['BUYER', 'PRIME_CONTRACTOR'],
    requiredCapability: 'Commercial janitorial',
    window: {
      opensDaysFromEvent: 0,
      closesDaysFromEvent: 120,
      reason: 'Registration windows are long, and being on the list before work appears is the entire value.',
    },
    typicalBuyerPrice: { low: 0, high: 0 },
    typicalMarginPct: 0,
    typicalCycleDays: 14,
    typicalHumanMinutes: 60,
    automationPotential: 0.7,
    frictionFactors: [
      { key: 'onboarding', question: 'Is the registration paperwork heavy?', weight: 3 },
      { key: 'standard_scope', question: 'Is the trade standard commercial cleaning?', weight: -1 },
    ],
    compliance: CLEANING_COMPLIANCE,
    verificationQuestions: [
      'What work actually flows through this list, and how often?',
      'Is registration a prerequisite for the jobs we want?',
    ],
    rejectionConditions: ['The registration window has closed'],
    firstAction: 'Register, then ask what volume actually flows through the list before investing more time.',
    authoritativeSources: ['municipal_solicitations', 'inbound_intake'],
    noisySources: [],
  },

  // -------------------------------------------------------------------------
  // Distribution — we sell the consumables
  // -------------------------------------------------------------------------
  {
    key: 'cleaning.distribution.initial_stock',
    route: 'DISTRIBUTION',
    vertical: 'Janitorial supplies',
    subvertical: 'Consumables',
    label: 'Initial janitorial stock for a new facility',
    qualifyingEvents: [
      'FACILITY_OPENING',
      'OCCUPANCY_OR_OPERATING_APPROVAL',
      'NEW_LOCATION',
      'NEW_LEASE',
      'EXPANSION',
    ],
    requiredEvidence: ['a dated opening or occupancy date', 'a physical address'],
    optionalEvidence: ['square footage', 'expected headcount or footfall', 'named operator'],
    likelyBuyerRoles: ['BUYER', 'PROPERTY_MANAGER'],
    requiredCapability: 'Janitorial consumables',
    window: {
      opensDaysFromEvent: -30,
      closesDaysFromEvent: 14,
      reason:
        'First stock is bought in the weeks before opening, alongside the rest of the fit-out. It is a faster ' +
        'sale than a service contract: no site visit, no incumbent to displace.',
    },
    typicalBuyerPrice: { low: 400, high: 3000 },
    typicalMarginPct: 22,
    typicalCycleDays: 7,
    typicalHumanMinutes: 30,
    automationPotential: 0.8,
    frictionFactors: [
      { key: 'local_owner', question: 'Is the operator an independent local business?', weight: -2 },
      { key: 'one_time', question: 'Is this a single order rather than a contract?', weight: -2 },
      { key: 'standard_scope', question: 'Is this a standard consumables list?', weight: -2 },
      { key: 'chain_control', question: 'Is purchasing controlled by a chain or franchisor?', weight: 4 },
    ],
    compliance: ['Resale registration where the state requires it for wholesale purchase'],
    verificationQuestions: [
      'Is the opening date still current?',
      'Has a supply account already been opened with a wholesaler?',
    ],
    rejectionConditions: ['Opened more than a month ago and already supplied'],
    firstAction: 'Send a priced opening list for the facility type and ask for a delivery date.',
    authoritativeSources: ['socrata_business_licenses', 'socrata_open_data', 'inbound_intake'],
    noisySources: ['google_places'],
  },
  {
    key: 'cleaning.distribution.replenishment',
    route: 'DISTRIBUTION',
    vertical: 'Janitorial supplies',
    subvertical: 'Consumables',
    label: 'Ongoing consumables replenishment',
    // Deliberately requires operating evidence. A facility existing is not a
    // standing order, and claiming one is exactly the inference this engine
    // was built to stop.
    qualifyingEvents: [
      'OCCUPANCY_OR_OPERATING_APPROVAL',
      'FACILITY_OPENING',
      'EXPANSION',
      'VENDOR_FAILURE_OR_COMPLAINT',
      'CONTRACT_EXPIRATION',
    ],
    requiredEvidence: [
      'a dated event establishing the premises are operating',
      'a physical address',
    ],
    optionalEvidence: ['current supplier', 'order frequency', 'monthly spend'],
    likelyBuyerRoles: ['BUYER', 'PROPERTY_MANAGER'],
    requiredCapability: 'Janitorial consumables',
    window: {
      // Replenishment only becomes a conversation once they have run through
      // the first order.
      opensDaysFromEvent: 30,
      closesDaysFromEvent: 365,
      reason:
        'Replenishment follows the first order. Approaching before they have used anything offers to solve a ' +
        'problem they have not had yet.',
    },
    typicalBuyerPrice: { low: 200, high: 1800 },
    typicalMarginPct: 20,
    typicalCycleDays: 14,
    typicalHumanMinutes: 25,
    automationPotential: 0.85,
    frictionFactors: [
      { key: 'local_owner', question: 'Is the operator an independent local business?', weight: -2 },
      { key: 'standard_scope', question: 'Is this a standard consumables list?', weight: -2 },
      { key: 'incumbent_displacement', question: 'Would this displace an existing supplier?', weight: 2 },
      { key: 'chain_control', question: 'Is purchasing controlled by a chain or franchisor?', weight: 4 },
    ],
    compliance: ['Resale registration where the state requires it for wholesale purchase'],
    verificationQuestions: [
      'Who supplies them now, and what do they spend?',
      'Is there an account or contract in place we would be displacing?',
    ],
    rejectionConditions: ['They are inside a national supply agreement they cannot leave'],
    firstAction: 'Ask what they currently order, how often, and from whom.',
    authoritativeSources: ['socrata_business_licenses', 'inbound_intake'],
    noisySources: ['google_places'],
  },
  {
    key: 'cleaning.distribution.supply_procurement',
    route: 'DISTRIBUTION',
    vertical: 'Janitorial supplies',
    subvertical: 'Consumables',
    label: 'Answer an open supply procurement',
    // A published request to buy janitorial products. Distinct from the
    // opening-stock route: here somebody has actually asked, which is why this
    // is the only distribution playbook that can reach tier A.
    qualifyingEvents: ['ACTIVE_RFQ', 'ACTIVE_RFP', 'PROCUREMENT_NOTICE', 'INBOUND_REQUEST', 'VENDOR_REQUEST'],
    requiredEvidence: ['a published request to purchase janitorial products', 'a buying organisation'],
    optionalEvidence: ['quantities', 'deadline', 'incumbent supplier', 'delivery schedule'],
    likelyBuyerRoles: ['BUYER'],
    requiredCapability: 'Janitorial consumables',
    window: {
      opensDaysFromEvent: 0,
      closesDaysFromEvent: 45,
      reason: 'The window is the notice itself. A published deadline overrides this entirely.',
    },
    typicalBuyerPrice: { low: 1000, high: 25000 },
    typicalMarginPct: 18,
    typicalCycleDays: 30,
    typicalHumanMinutes: 180,
    automationPotential: 0.6,
    frictionFactors: [
      { key: 'formal_procurement', question: 'Does a formal procurement process apply?', weight: 4 },
      { key: 'onboarding', question: 'Is vendor registration required?', weight: 2 },
      { key: 'inbound', question: 'Did the buyer approach us?', weight: -4 },
      { key: 'standard_scope', question: 'Is this a standard consumables list?', weight: -2 },
    ],
    compliance: [
      'Resale registration where the state requires it for wholesale purchase',
      'Any product certification the notice names',
    ],
    verificationQuestions: [
      'Is the deadline still open?',
      'Can our wholesaler meet the quantities and the delivery schedule?',
      'Is there an incumbent with a price we cannot beat?',
    ],
    rejectionConditions: [
      'The deadline has passed',
      'It has been awarded',
      'No wholesaler we hold can supply the listed products',
    ],
    firstAction: 'Price the listed items with a wholesaler before committing time to the response.',
    authoritativeSources: ['municipal_solicitations', 'inbound_intake'],
    noisySources: [],
  },
];

export const PLAYBOOKS: Playbook[] = [...CLEANING_PLAYBOOKS];

export function playbooksFor(eventType: DemandEventType): Playbook[] {
  return PLAYBOOKS.filter((p) => p.qualifyingEvents.includes(eventType));
}

export function playbookByKey(key: string): Playbook | undefined {
  return PLAYBOOKS.find((p) => p.key === key);
}

/**
 * The window a playbook opens for one event, measured from the event's own
 * date and from nothing else.
 *
 * Returns null when the event carries no date, which is the correct answer:
 * without one there is no way to know when to make contact, and substituting
 * the discovery date would put every record in the same week.
 */
export function windowFor(playbook: Playbook, eventDate: Date | null): { opensAt: Date; closesAt: Date } | null {
  if (!eventDate) return null;
  const day = 86_400_000;
  return {
    opensAt: new Date(eventDate.getTime() + playbook.window.opensDaysFromEvent * day),
    closesAt: new Date(eventDate.getTime() + playbook.window.closesDaysFromEvent * day),
  };
}
