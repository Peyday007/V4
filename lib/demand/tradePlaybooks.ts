import type { Playbook } from './playbooks';

/**
 * The three paths the owner named, written as themselves.
 *
 * Ten of the thirteen playbooks in this engine were cleaning playbooks. That is
 * why a portfolio audit found 85% of live work in one trade, and why a licence
 * record for a steakhouse and a licence record for a fabrication shop both
 * produced a proposal to clean something. The fix is not a wider keyword list —
 * it is that overflow warehousing, steel supply and facility subcontracting are
 * genuinely different businesses, with different buyers, different urgency,
 * different compliance, different money and, above all, different questions on
 * the phone.
 *
 * A warehousing call asks how many pallets and for how long. A steel call asks
 * for a section size, a tonnage and a delivery date. A subcontracting call asks
 * who holds the contract and what their onboarding requires. Nothing about
 * those three conversations is interchangeable, and a caller handed the wrong
 * one sounds like somebody who has not read the file.
 *
 * Kept in their own file rather than appended to the cleaning list, because the
 * moment they sit inside `CLEANING_PLAYBOOKS` somebody will copy the compliance
 * array and this will all happen again.
 */

const WAREHOUSE_COMPLIANCE = [
  'Warehouse legal liability cover, because stored goods belong to somebody else',
  'Confirmation of whose insurance covers the goods while stored, ours or theirs',
  'Fire and racking compliance appropriate to the commodity being stored',
  'Bonded or food-grade status where the commodity requires it',
];

const STEEL_COMPLIANCE = [
  'Mill test reports or certificates of conformance for structural material',
  'Buy-America or domestic-content status where public money is involved',
  'Fabricator certification where the work is fabricated rather than supplied plain',
  'Confirmation of who carries the freight and damage risk in transit',
];

const SUBCONTRACT_COMPLIANCE = [
  'General liability at the limit the prime’s own contract requires, commonly $1M-$2M',
  'Workers compensation for every person on site',
  'Additional-insured endorsement naming the prime',
  'Background checks or badging where the site requires them',
  'Prevailing-wage and certified-payroll capability on public work',
];

export const TRADE_PLAYBOOKS: Playbook[] = [
  // -------------------------------------------------------------------------
  // Overflow warehousing
  // -------------------------------------------------------------------------
  {
    key: 'brokerage.warehousing.overflow',
    route: 'BROKERAGE',
    vertical: 'Logistics and warehousing',
    subvertical: 'Overflow warehousing',
    label: 'Overflow warehousing placement',
    // A business opening or moving is the moment its storage need changes, and
    // an inbound request is somebody saying it outright.
    qualifyingEvents: [
      'NEW_LOCATION',
      'EXPANSION',
      'NEW_LEASE',
      'FACILITY_OPENING',
      'INBOUND_REQUEST',
      'VENDOR_REQUEST',
    ],
    requiredEvidence: [
      'a dated event showing the operation is growing, moving or arriving',
      'a physical address that places the storage need in a specific market',
    ],
    optionalEvidence: [
      'the commodity being stored',
      'pallet or square-foot scale',
      'how long the overflow is expected to last',
      'whether the goods need temperature control',
    ],
    likelyBuyerRoles: ['BUYER', 'PROPERTY_MANAGER'],
    requiredCapability: 'Short-term warehouse space',
    window: {
      // Storage is arranged before the goods arrive and becomes urgent the week
      // they do. Approaching a quarter out reaches somebody still negotiating a
      // lease; approaching after arrival means they have already stacked the
      // pallets somewhere.
      opensDaysFromEvent: -60,
      closesDaysFromEvent: 30,
      reason:
        'Overflow is arranged in the two months before goods arrive and stops being a problem once they have '
        + 'been put somewhere, however badly. After that the next conversation is the next peak.',
    },
    // A pallet-month, times a few hundred pallets, times a few months. Wide,
    // because commodity and duration move it more than anything we can see.
    typicalBuyerPrice: { low: 3_000, high: 60_000 },
    typicalMarginPct: 18,
    typicalCycleDays: 14,
    typicalHumanMinutes: 60,
    automationPotential: 0.4,
    frictionFactors: [
      { key: 'known_duration', question: 'Is the storage period defined rather than open-ended?', weight: -3 },
      { key: 'standard_pallets', question: 'Is it palletised dry goods rather than an awkward commodity?', weight: -2 },
      { key: 'single_market', question: 'Is it one market rather than several at once?', weight: -1 },
      { key: 'temperature', question: 'Does it need temperature control?', weight: 3 },
      { key: 'hazmat', question: 'Is any of it hazardous or regulated?', weight: 4 },
      { key: 'goods_in_transit', question: 'Are the goods already in transit with nowhere to go?', weight: 2 },
    ],
    compliance: WAREHOUSE_COMPLIANCE,
    verificationQuestions: [
      'How many pallets, and what are the dimensions if they are not standard?',
      'From what date, and for how many weeks or months?',
      'What is the commodity, and does any of it need temperature control or special handling?',
      'Does it need to move in and out, or go in once and come out once?',
      'Who currently holds it, and what happens if nothing is arranged?',
    ],
    rejectionConditions: [
      'The goods have already been placed somewhere else',
      'The commodity is hazardous and no candidate warehouse is licensed for it',
      'The requirement is a lease rather than short-term storage',
      'The duration is open-ended with no committed minimum',
    ],
    firstAction:
      'Call and establish pallet count, start date and duration. Without those three numbers no warehouse can '
      + 'quote, and every later step is blocked on them.',
    authoritativeSources: ['municipal_open_data', 'inbound_intake'],
    noisySources: ['google_places'],
  },

  // -------------------------------------------------------------------------
  // Steel and building-material distribution
  // -------------------------------------------------------------------------
  {
    key: 'distribution.materials.steel',
    route: 'DISTRIBUTION',
    vertical: 'Building materials',
    subvertical: 'Steel and metals',
    label: 'Steel and building-material supply',
    qualifyingEvents: [
      'CONTRACT_AWARD',
      'RENOVATION_OR_CONSTRUCTION',
      'ACTIVE_RFQ',
      'PROCUREMENT_NOTICE',
      'INBOUND_REQUEST',
    ],
    requiredEvidence: [
      'a dated construction award, permit or solicitation that implies a material requirement',
      'an identifiable contractor or buyer responsible for procuring it',
    ],
    optionalEvidence: [
      'the scope of work, which implies the sections and tonnage',
      'the project value',
      'the required delivery or mobilisation date',
      'whether public money makes domestic content mandatory',
    ],
    likelyBuyerRoles: ['BUYER', 'ISSUING_AUTHORITY'],
    requiredCapability: 'Steel and building-material supply',
    window: {
      // Material is bought after award and before mobilisation. Turn up before
      // the award and there is nothing to price; turn up after mobilisation and
      // the order was placed weeks ago.
      opensDaysFromEvent: 0,
      closesDaysFromEvent: 75,
      reason:
        'Structural material is ordered in the weeks between an award and mobilisation, because lead times force '
        + 'it. Before the award there is no order to win; two and a half months after it, the steel is rolling.',
    },
    typicalBuyerPrice: { low: 15_000, high: 400_000 },
    // Material margins are thin and freight can take all of it, which is
    // precisely why a modelled number here would be misleading.
    typicalMarginPct: 9,
    typicalCycleDays: 30,
    typicalHumanMinutes: 90,
    automationPotential: 0.35,
    frictionFactors: [
      { key: 'standard_sections', question: 'Are the sections standard stock rather than special order?', weight: -3 },
      { key: 'single_delivery', question: 'Is it one delivery rather than a release schedule?', weight: -2 },
      { key: 'buyer_flexible', question: 'Is the buyer open on mill of origin?', weight: -2 },
      { key: 'domestic_content', question: 'Does public funding require domestic content?', weight: 3 },
      { key: 'fabrication', question: 'Does it need fabrication rather than plain supply?', weight: 4 },
      { key: 'incumbent_supplier', question: 'Do they already have a service centre they always use?', weight: 3 },
      { key: 'price_volatility', question: 'Has the mill price moved since the project was estimated?', weight: 2 },
    ],
    compliance: STEEL_COMPLIANCE,
    verificationQuestions: [
      'What sections and grades, and what total tonnage?',
      'Plain supply, or cut, drilled and fabricated?',
      'What is the required delivery date, and is it one drop or a release schedule?',
      'Does this project carry a domestic-content or Buy-America requirement?',
      'Who currently supplies their steel, and what would make them price it elsewhere?',
      'Who pays the freight, and is there site access for an articulated delivery?',
    ],
    rejectionConditions: [
      'The material package was awarded with the main contract and is already ordered',
      'The requirement is fabrication capacity rather than material supply',
      'Domestic content is required and no candidate supplier can certify it',
      'The delivery date is inside the mill or service-centre lead time',
    ],
    firstAction:
      'Call the contractor’s buyer and get the section list, tonnage and required delivery date. A steel '
      + 'enquiry without those is not a quotable enquiry and no service centre will price it.',
    authoritativeSources: ['municipal_solicitations', 'contract_awards', 'inbound_intake'],
    noisySources: ['google_places', 'municipal_open_data'],
  },

  // -------------------------------------------------------------------------
  // Commercial facility subcontracting
  // -------------------------------------------------------------------------
  {
    key: 'subcontracting.facility.commercial',
    route: 'SUBCONTRACTING',
    // A national contract awarded across territories the holder cannot
    // self-perform is the single most reliable trigger this path has, and
    // without opting in it could never fire from an award at all.
    readsAwardsAsCapacityGap: true,
    vertical: 'Facility services',
    subvertical: 'Commercial facility maintenance',
    label: 'Commercial facility subcontracting',
    qualifyingEvents: [
      'CONTRACT_AWARD',
      'SUBCONTRACTOR_REQUEST',
      'VENDOR_REQUEST',
      'ACTIVE_RFP',
      'STAFFING_OR_CAPACITY_GAP',
      'VENDOR_FAILURE_OR_COMPLAINT',
      'INBOUND_REQUEST',
    ],
    requiredEvidence: [
      'a named prime contractor or contract holder seeking local fulfilment capacity',
      'a place of performance they do not obviously already cover',
    ],
    optionalEvidence: [
      'the number of sites and their locations',
      'the service scope and frequency',
      'the contract term',
      'the insurance limits the prime’s own contract imposes',
    ],
    // Subcontracting sells capacity to whoever holds the head contract. Listing
    // a property manager or an end buyer here would point every downstream
    // action at the wrong organisation — we are not selling to the building,
    // we are selling to the firm that already promised to service it.
    likelyBuyerRoles: ['PRIME_CONTRACTOR', 'BUYER'],
    requiredCapability: 'Commercial facility services delivery',
    window: {
      // The gap between winning and having to show up. Longer than a material
      // order because vendor onboarding is slow, and it is the onboarding that
      // decides whether anybody can actually start.
      opensDaysFromEvent: -14,
      closesDaysFromEvent: 90,
      reason:
        'A prime looks for local capacity between winning the work and having to perform it. Vendor onboarding '
        + 'takes weeks, so the useful window is wide at the start and closes hard once they have chosen.',
    },
    typicalBuyerPrice: { low: 12_000, high: 250_000 },
    typicalMarginPct: 22,
    typicalCycleDays: 45,
    typicalHumanMinutes: 120,
    automationPotential: 0.3,
    frictionFactors: [
      { key: 'distant_prime', question: 'Is the contract holder based outside the place of performance?', weight: -3 },
      { key: 'multi_site', question: 'Does it span more sites than one local crew could cover?', weight: -2 },
      { key: 'existing_vendor_list', question: 'Are we already on their approved vendor list?', weight: -3 },
      { key: 'heavy_onboarding', question: 'Is vendor onboarding heavy — portals, audits, badging?', weight: 3 },
      { key: 'high_insurance', question: 'Are insurance limits above the ordinary commercial level?', weight: 3 },
      { key: 'prevailing_wage', question: 'Is this public work with certified-payroll obligations?', weight: 3 },
      { key: 'self_perform_policy', question: 'Do they self-perform as a matter of policy?', weight: 5 },
    ],
    compliance: SUBCONTRACT_COMPLIANCE,
    verificationQuestions: [
      'Who holds the head contract, and how many sites does it cover in this area?',
      'What is the service scope and frequency at each site?',
      'Do they subcontract in this market today, or self-perform?',
      'What does their vendor onboarding require, and how long does it take?',
      'What insurance limits and endorsements does their own contract impose on subcontractors?',
      'Is this public work with prevailing-wage and certified-payroll obligations?',
      'What is their payment term to subcontractors, and is it pay-when-paid?',
    ],
    rejectionConditions: [
      'They self-perform in this market as a matter of policy',
      'Vendor onboarding cannot be completed before the work has to start',
      'Insurance limits exceed what any candidate provider carries or could obtain',
      'Payment terms are pay-when-paid at a length that no provider will accept',
    ],
    firstAction:
      'Call the prime and establish whether they subcontract in this market at all, and what their onboarding '
      + 'requires. A policy of self-performing ends this in one question, and it is cheaper to ask it first.',
    authoritativeSources: ['contract_awards', 'municipal_solicitations', 'inbound_intake'],
    noisySources: ['google_places'],
  },
];
