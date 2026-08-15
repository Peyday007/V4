import type { Playbook } from './playbooks';

/**
 * Paths a working source can actually feed, given real playbooks.
 *
 * The universe page reported thirty-two paths as declarations — named, argued
 * for, and with no qualification rules, no evidence threshold, no disqualifiers
 * and no call script behind them. That was the honest answer and it was also a
 * list of work.
 *
 * These are the ones worth doing first, chosen on a single test: does a source
 * that is currently answering produce the event this path needs? Municipal
 * permit and licence records produce construction permits, occupancy approvals
 * and operating licences, and those are genuine triggers for six paths that had
 * nothing behind them. Everything else on the list stays a declaration, because
 * writing rules for an event nobody can collect would move a label from
 * "declaration" to "operational" without changing what the product can do — the
 * exact swap the universe page exists to prevent.
 *
 * Each one here is reasoned from what actually creates the demand, not from the
 * category name. The required evidence is the guard: a path that fires on "this
 * is a building" produces a board of buildings, and the whole discipline is
 * that a missing required fact is a reason not to build the route rather than a
 * gap to fill in later.
 */

const TRADE_COMPLIANCE = [
  'General liability insurance at the limit the general contractor\'s own contract requires, usually $1M–$2M',
  'Workers compensation for every person on site, checked by the GC before mobilisation',
  'State or municipal trade licence where the work is regulated — electrical and plumbing almost always are',
  'Site safety training records where the GC operates a card scheme',
];

const HAULING_COMPLIANCE = [
  'A waste hauling permit or franchise agreement, which in many cities is exclusive to one hauler by district',
  'Commercial vehicle insurance and DOT registration where the vehicles cross that threshold',
  'Disposal site access, because a hauler with no tipping arrangement is a truck with nowhere to go',
];

const FOOD_COMPLIANCE = [
  'A food-grade supply chain where anything touches consumables, with traceable lot numbers',
  'Resale certificate for the state, or the sale carries tax that eats the margin',
  'Delivery insurance where goods are dropped inside a working kitchen',
];

export const FACILITY_PLAYBOOKS: Playbook[] = [
  // -------------------------------------------------------------------------
  // Construction trades — a permit is a schedule somebody has to staff
  // -------------------------------------------------------------------------
  {
    key: 'construction.subcontracting.trade_packages',
    route: 'SUBCONTRACTING',
    vertical: 'Construction',
    subvertical: 'Trade packages',
    label: 'Construction trade subcontracting',
    qualifyingEvents: ['RENOVATION_OR_CONSTRUCTION', 'EXPANSION'],
    // A permit names a contractor and a job. Both are required, and the second
    // is what stops this firing on a homeowner replacing a water heater: a
    // stated value is the only thing on a permit record that separates a
    // project needing subcontractors from a job one person does in an
    // afternoon.
    requiredEvidence: [
      'a named general contractor or permit holder',
      'a stated construction value or scope',
      'a physical address',
    ],
    optionalEvidence: ['permit issue date', 'trade classification', 'square footage', 'stated completion date'],
    // The buyer is the contract holder, never the building owner. A trade
    // subcontract is sold to whoever is short of crews, and that is the GC.
    likelyBuyerRoles: ['PRIME_CONTRACTOR', 'BUYER'],
    requiredCapability: 'Construction trade crews',
    window: {
      // Trade packages are let after the permit and before mobilisation. Too
      // early and the GC has not scheduled; too late and the crews are booked.
      opensDaysFromEvent: 3,
      closesDaysFromEvent: 75,
      reason:
        'A general contractor lets trade packages in the weeks after the permit issues and before mobilisation. '
        + 'Calling on the day of issue reaches somebody still pricing; calling three months later reaches '
        + 'somebody whose crews are already on site.',
    },
    typicalBuyerPrice: { low: 6_000, high: 120_000 },
    typicalMarginPct: 12,
    typicalCycleDays: 45,
    typicalHumanMinutes: 240,
    automationPotential: 0.35,
    frictionFactors: [
      { key: 'named_gc', question: 'Does the permit name the general contractor?', weight: -2 },
      { key: 'local_gc', question: 'Is the contractor a local firm rather than a national?', weight: -2 },
      { key: 'prequalification', question: 'Does the GC run a formal prequalification process?', weight: 3 },
      { key: 'union_site', question: 'Is this a union site with agreed labour?', weight: 4 },
      { key: 'bonding', question: 'Is a payment or performance bond required of subcontractors?', weight: 3 },
      { key: 'public_works', question: 'Is this public works with prevailing wage obligations?', weight: 4 },
    ],
    compliance: TRADE_COMPLIANCE,
    verificationQuestions: [
      'Which trade packages are still unlet, and when do they need to mobilise?',
      'What insurance limits and bonding does the GC require of a subcontractor?',
      'Is this a union site, and if so under which agreement?',
      'Are the GC\'s payment terms pay-when-paid, and how long is the pay cycle?',
    ],
    rejectionConditions: [
      'Every trade package is already awarded',
      'The site is union and the provider is not signatory',
      'Prevailing wage applies and the provider does not run certified payroll',
      'The permit is for owner-occupied residential work with no contractor named',
    ],
    firstAction:
      'Ring the named contractor and ask which trade packages are still unlet and what they require of a sub.',
    authoritativeSources: ['socrata_building_permits', 'socrata_open_data'],
    noisySources: ['google_places'],
  },

  // -------------------------------------------------------------------------
  // Waste — a building that opens starts producing rubbish immediately
  //
  // Brokerage, not subcontracting, and the distinction was worth a failing
  // test. Subcontracting means somebody else holds the customer contract and we
  // work underneath them. Here the customer is the operator of the building
  // that just opened, we would hold their contract and place a hauler beneath
  // us, and that is the opposite arrangement — different liability, different
  // invoice, different margin.
  // -------------------------------------------------------------------------
  {
    key: 'facility.brokerage.waste_collection',
    route: 'BROKERAGE',
    vertical: 'Commercial facility services',
    subvertical: 'Waste and recycling',
    label: 'Waste and recycling collection',
    qualifyingEvents: ['OCCUPANCY_OR_OPERATING_APPROVAL', 'FACILITY_OPENING', 'NEW_LOCATION'],
    requiredEvidence: ['a dated occupancy or opening date', 'a physical address'],
    optionalEvidence: ['square footage', 'business type', 'named operator'],
    likelyBuyerRoles: ['BUYER', 'PROPERTY_MANAGER', 'PROPERTY_OWNER'],
    requiredCapability: 'Commercial waste collection',
    window: {
      // Uniquely early. A building cannot open without somewhere for the
      // rubbish to go, so the decision is made before the doors do, and the
      // first hauler in is usually the one who stays.
      opensDaysFromEvent: -30,
      closesDaysFromEvent: 21,
      reason:
        'Waste collection has to be arranged before a building can trade, so the decision is made in the month '
        + 'around opening. After the first few weeks somebody has already signed something, usually for a year.',
    },
    typicalBuyerPrice: { low: 2_400, high: 30_000 },
    typicalMarginPct: 18,
    typicalCycleDays: 21,
    typicalHumanMinutes: 90,
    automationPotential: 0.55,
    frictionFactors: [
      { key: 'new_site', question: 'Is this a genuinely new site rather than a change of tenant?', weight: -2 },
      { key: 'single_operator', question: 'Is the operator independent rather than part of a chain?', weight: -2 },
      { key: 'exclusive_franchise', question: 'Does the city grant an exclusive hauling franchise here?', weight: 5 },
      { key: 'landlord_controlled', question: 'Does the landlord control waste for the whole building?', weight: 4 },
      { key: 'long_contract', question: 'Is an incumbent under a multi-year agreement?', weight: 3 },
    ],
    compliance: HAULING_COMPLIANCE,
    verificationQuestions: [
      'Does this city or district grant an exclusive hauling franchise? If so there is no deal at any price.',
      'Is waste included in the lease and controlled by the landlord?',
      'What volume and what streams — is there a recycling or organics obligation?',
      'When does any existing agreement end, and does it auto-renew?',
    ],
    rejectionConditions: [
      'The municipality operates an exclusive franchise covering this address',
      'Waste is included in the lease and the tenant has no say',
      'An incumbent contract has more than nine months to run with auto-renewal',
    ],
    firstAction:
      'Check whether this city grants exclusive hauling franchises before anything else. If it does, close the '
      + 'route — no amount of selling beats an ordinance.',
    authoritativeSources: ['socrata_business_licenses', 'socrata_open_data', 'inbound_intake'],
    noisySources: ['google_places'],
  },

  // -------------------------------------------------------------------------
  // Grounds — only where there are grounds, and brokerage for the same reason
  // as waste: the buyer is the site, not a facilities-management prime.
  // -------------------------------------------------------------------------
  {
    key: 'facility.brokerage.grounds',
    route: 'BROKERAGE',
    vertical: 'Commercial facility services',
    subvertical: 'Landscaping and grounds',
    label: 'Landscaping and grounds maintenance',
    qualifyingEvents: ['OCCUPANCY_OR_OPERATING_APPROVAL', 'FACILITY_OPENING', 'NEW_LEASE'],
    // The guard that matters. A ground-floor unit on a city block has no
    // grounds, and a playbook that fires on every occupancy approval produces a
    // board of shopfronts nobody can sell landscaping to.
    requiredEvidence: [
      'a dated occupancy or opening date',
      'a physical address',
      'evidence the site has grounds — a lot size, a parking area, or a standalone building',
    ],
    optionalEvidence: ['lot square footage', 'number of parking spaces', 'named property manager'],
    likelyBuyerRoles: ['PROPERTY_MANAGER', 'PROPERTY_OWNER', 'BUYER'],
    requiredCapability: 'Landscaping and grounds maintenance',
    window: {
      opensDaysFromEvent: -14,
      closesDaysFromEvent: 60,
      reason:
        'Grounds maintenance is arranged around opening and then reviewed seasonally. The two months after '
        + 'opening are when somebody notices the grass, and before that nobody is thinking about it.',
    },
    typicalBuyerPrice: { low: 1_800, high: 24_000 },
    typicalMarginPct: 22,
    typicalCycleDays: 28,
    typicalHumanMinutes: 100,
    automationPotential: 0.5,
    frictionFactors: [
      { key: 'standalone', question: 'Is this a standalone building with its own grounds?', weight: -3 },
      { key: 'seasonal_bundle', question: 'Would snow or irrigation bundle into the same contract?', weight: -2 },
      { key: 'landlord_controlled', question: 'Does the landlord maintain common grounds?', weight: 4 },
      { key: 'in_house', question: 'Does the operator have its own maintenance staff?', weight: 3 },
    ],
    compliance: [
      'General liability insurance, commonly $1M per occurrence',
      'Workers compensation for crews',
      'Pesticide applicator licensing where any treatment is applied — this is regulated and personal to the applicator',
    ],
    verificationQuestions: [
      'Does this site actually have grounds, or is the address a unit inside a larger building?',
      'Does the lease put grounds with the landlord?',
      'Is snow or irrigation part of the same requirement, and does the provider do both?',
    ],
    rejectionConditions: [
      'The address is a unit within a building whose grounds the landlord maintains',
      'The operator maintains its own grounds with employed staff',
      'No evidence the site has any grounds at all',
    ],
    firstAction:
      'Establish whether the site has its own grounds and who the lease makes responsible for them, before '
      + 'anything is quoted.',
    authoritativeSources: ['socrata_business_licenses', 'socrata_open_data'],
    noisySources: ['google_places'],
  },

  // -------------------------------------------------------------------------
  // Restaurant supply — an operating licence is an opening order
  // -------------------------------------------------------------------------
  {
    key: 'restaurant.distribution.opening_supply',
    route: 'DISTRIBUTION',
    vertical: 'Food service',
    subvertical: 'Restaurant supplies',
    label: 'Restaurant opening and replenishment supply',
    qualifyingEvents: ['OCCUPANCY_OR_OPERATING_APPROVAL', 'FACILITY_OPENING', 'NEW_LOCATION'],
    // A retail food licence is the specific thing that makes this a restaurant
    // rather than an office. Without it the route is being built from a guess
    // about what kind of business opened.
    requiredEvidence: [
      'a licence or approval that identifies food service specifically',
      'a dated opening or approval date',
      'a physical address',
    ],
    optionalEvidence: ['seating capacity', 'cuisine or format', 'named operator', 'square footage'],
    likelyBuyerRoles: ['BUYER', 'PROPERTY_OWNER'],
    requiredCapability: 'Restaurant and food service supplies',
    window: {
      // The opening order is placed before the doors open and the standing
      // account is decided in the first month of trading.
      opensDaysFromEvent: -45,
      closesDaysFromEvent: 30,
      reason:
        'The opening order goes in during the six weeks before service and the standing supplier is settled in '
        + 'the first month of trading. After that changing supplier means changing a routine that works.',
    },
    typicalBuyerPrice: { low: 1_500, high: 22_000 },
    typicalMarginPct: 16,
    typicalCycleDays: 14,
    typicalHumanMinutes: 75,
    automationPotential: 0.6,
    frictionFactors: [
      { key: 'independent', question: 'Is this an independent operator rather than a chain unit?', weight: -3 },
      { key: 'first_site', question: 'Is this their first location?', weight: -2 },
      { key: 'franchise_supply', question: 'Does a franchisor mandate approved suppliers?', weight: 5 },
      { key: 'group_buying', question: 'Is the operator in a group purchasing arrangement?', weight: 4 },
      { key: 'credit_terms', question: 'Would the buyer expect trade credit on the first order?', weight: 2 },
    ],
    compliance: FOOD_COMPLIANCE,
    verificationQuestions: [
      'Is this operator free to choose suppliers, or does a franchisor or buying group decide?',
      'What are they buying now, and what is the reorder cycle?',
      'Would they expect terms on an opening order, and can that be funded?',
    ],
    rejectionConditions: [
      'A franchisor mandates approved suppliers for this category',
      'The operator is already inside a group purchasing organisation',
      'The licence is for a format that buys nothing we can supply',
    ],
    firstAction:
      'Ring and ask who they are buying from for opening and whether anybody upstream constrains that choice.',
    authoritativeSources: ['socrata_business_licenses', 'socrata_food_licenses', 'inbound_intake'],
    noisySources: ['google_places'],
  },

  // -------------------------------------------------------------------------
  // Hospitality — rooms consume consumables from the first night
  // -------------------------------------------------------------------------
  {
    key: 'hospitality.distribution.opening_supply',
    route: 'DISTRIBUTION',
    vertical: 'Hospitality',
    subvertical: 'Hospitality supplies',
    label: 'Hotel and lodging supply',
    qualifyingEvents: ['OCCUPANCY_OR_OPERATING_APPROVAL', 'FACILITY_OPENING', 'NEW_LOCATION'],
    requiredEvidence: [
      'a licence or approval that identifies lodging specifically',
      'a dated opening or approval date',
      'a physical address',
    ],
    optionalEvidence: ['room count', 'brand or flag', 'named operator'],
    likelyBuyerRoles: ['BUYER', 'PROPERTY_MANAGER'],
    requiredCapability: 'Hospitality consumables and linen',
    window: {
      opensDaysFromEvent: -60,
      closesDaysFromEvent: 21,
      reason:
        'A hotel stocks before it opens and its consumption is predictable from the first night, so the '
        + 'supplier decision is made early and reviewed rarely.',
    },
    typicalBuyerPrice: { low: 4_000, high: 60_000 },
    typicalMarginPct: 14,
    typicalCycleDays: 30,
    typicalHumanMinutes: 120,
    automationPotential: 0.55,
    frictionFactors: [
      { key: 'independent', question: 'Is this independent rather than flagged to a brand?', weight: -3 },
      { key: 'room_count', question: 'Is the room count large enough to justify a standing account?', weight: -2 },
      { key: 'brand_standards', question: 'Do brand standards mandate specific products?', weight: 5 },
      { key: 'management_company', question: 'Does a management company buy centrally?', weight: 4 },
    ],
    compliance: [
      'Resale certificate for the state',
      'Fire-retardancy certification where soft furnishings are supplied',
      'Delivery insurance for goods left at a loading dock',
    ],
    verificationQuestions: [
      'Is the property flagged to a brand, and do brand standards decide the products?',
      'Does a management company buy for several properties centrally?',
      'How many rooms, and what is the expected occupancy in the first quarter?',
    ],
    rejectionConditions: [
      'Brand standards mandate suppliers for every category we could serve',
      'A management company buys centrally for a portfolio',
    ],
    firstAction:
      'Establish whether this property buys for itself or a brand or management company decides, before '
      + 'anything else.',
    authoritativeSources: ['socrata_business_licenses', 'socrata_open_data'],
    noisySources: ['google_places'],
  },

  // -------------------------------------------------------------------------
  // Packaging — a distribution site ships from the day it opens
  // -------------------------------------------------------------------------
  {
    key: 'distribution.packaging.opening_supply',
    route: 'DISTRIBUTION',
    vertical: 'Logistics and warehousing',
    subvertical: 'Packaging',
    label: 'Packaging and shipping supplies',
    qualifyingEvents: ['OCCUPANCY_OR_OPERATING_APPROVAL', 'FACILITY_OPENING', 'NEW_LOCATION'],
    // The size guard. A four-hundred-square-foot unit does not consume pallets,
    // and without a scale figure this fires on every occupancy approval in the
    // city.
    requiredEvidence: [
      'evidence the site is a warehouse, distribution or fulfilment facility',
      'a stated square footage or scale figure',
      'a dated occupancy or opening date',
    ],
    optionalEvidence: ['named operator', 'dock count', 'stated use'],
    likelyBuyerRoles: ['BUYER'],
    requiredCapability: 'Packaging and shipping consumables',
    window: {
      opensDaysFromEvent: -21,
      closesDaysFromEvent: 45,
      reason:
        'A distribution site consumes packaging from its first shipment, and the first supplier who can hold '
        + 'stock nearby usually keeps the account. The window is the weeks either side of going live.',
    },
    typicalBuyerPrice: { low: 3_000, high: 45_000 },
    typicalMarginPct: 15,
    typicalCycleDays: 21,
    typicalHumanMinutes: 90,
    automationPotential: 0.6,
    frictionFactors: [
      { key: 'independent', question: 'Is the operator independent rather than a national 3PL?', weight: -3 },
      { key: 'new_site', question: 'Is this a new site rather than an expansion of an existing account?', weight: -2 },
      { key: 'national_contract', question: 'Is packaging bought under a national contract?', weight: 5 },
      { key: 'custom_print', question: 'Does the buyer need custom-printed packaging with lead times?', weight: 3 },
    ],
    compliance: [
      'Resale certificate for the state',
      'Certification where packaging touches food or pharmaceuticals',
    ],
    verificationQuestions: [
      'Is packaging bought at this site or under a national agreement?',
      'What volumes, and would they hold stock or expect deliveries against a schedule?',
      'Is any of it custom-printed, and what lead time does that carry?',
    ],
    rejectionConditions: [
      'Packaging is bought under a national contract this site cannot vary',
      'The site is too small to consume packaging in commercial quantities',
    ],
    firstAction:
      'Ring the site and ask whether they buy packaging locally or under a national agreement, and what they '
      + 'get through in a week.',
    authoritativeSources: ['socrata_business_licenses', 'socrata_open_data'],
    noisySources: ['google_places'],
  },
];
