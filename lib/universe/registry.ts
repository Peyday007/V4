/**
 * The opportunity universe: every commercial model, vertical and mini-path
 * this business could operate, declared as data.
 *
 * Two failures this exists to prevent, and they pull in opposite directions.
 *
 * The first is a product that can only see the shapes its code already knows.
 * Ten of the thirteen playbooks in the engine are cleaning playbooks, so a
 * licence record became a cleaning route whatever the business actually was,
 * and an owner reading the board would conclude this is a janitorial brokerage
 * because that is the only thing on it. The universe has to be declared in full
 * — including the parts that do not work yet — or nobody can see what is
 * missing.
 *
 * The second is the opposite: a taxonomy that lists forty commercial paths and
 * lets an owner believe the platform operates forty commercial paths. That is
 * the more dangerous failure, because it is invisible. So nothing here claims
 * to work. A declaration is a declaration; whether a path is *operational* is
 * computed in `status.ts` from evidence of real wiring, and most of these will
 * honestly report that they are names on a list.
 *
 * The rule: declaring a path is free and costs nothing but honesty. Claiming
 * one is operational requires a working acquisition source, a playbook, both
 * commercial sides, an operator action, and a production entry point that
 * actually invokes it.
 */

// ---------------------------------------------------------------------------
// Commercial models
// ---------------------------------------------------------------------------

/**
 * How the intermediary participates in the transaction.
 *
 * This is deliberately not the `SignalCategory` enum. That enum names the seven
 * shapes the demand pipeline can currently *produce*, and it lives in the
 * database because routes are stored against it. This list names the fourteen
 * ways a middleman can legally and commercially stand between two parties,
 * which is a larger set, changes on a different timescale, and must be able to
 * grow without a migration.
 *
 * The distinction matters commercially, not just structurally: who contracts
 * with whom, who invoices whom, who carries performance liability and who is
 * exposed to the cash gap are different in every one of these, and a product
 * that blurs them will eventually tell an operator to do something that makes
 * them liable for work they cannot control.
 */
export type CommercialModelKey =
  | 'subcontracting'
  | 'distribution'
  | 'brokerage'
  | 'procurement'
  | 'managed_services'
  | 'aggregation'
  | 'capacity_arbitrage'
  | 'inventory_arbitrage'
  | 'manufacturer_representation'
  | 'sales_agency'
  | 'demand_generation'
  | 'marketplace'
  | 'licensing'
  | 'transaction_intermediation';

export type CommercialModel = {
  key: CommercialModelKey;
  label: string;
  /** What it is, for somebody who has never worked in this trade. */
  plainDescription: string;
  /** Who signs what. The question that decides liability. */
  contracting: string;
  /** Where the money comes from. */
  revenueBasis: string;
  /** What the intermediary is exposed to. The reason not to pick it lightly. */
  exposure: string;
};

export const COMMERCIAL_MODELS: CommercialModel[] = [
  {
    key: 'subcontracting',
    label: 'Subcontracting',
    plainDescription:
      'Somebody else holds the contract with the end customer and we perform, or arrange the performance of, '
      + 'part of it. We are accountable to them, not to their customer.',
    contracting: 'The prime contracts with the buyer. We contract with the prime.',
    revenueBasis: 'A rate per site, per job or per hour, less what fulfilment costs us.',
    exposure:
      'We carry performance risk to the prime and usually wait for their customer to pay them first. Insurance '
      + 'and onboarding requirements are typically the heaviest of any model here.',
  },
  {
    key: 'distribution',
    label: 'Distribution',
    plainDescription:
      'We buy goods and resell them. Title passes through us, so we own the stock, however briefly.',
    contracting: 'We buy from the supplier and sell to the buyer. Two separate contracts, both ours.',
    revenueBasis: 'The spread between what we pay and what we charge, less freight.',
    exposure:
      'Cash is committed before it is collected, and stock that does not move is a loss rather than a missed '
      + 'opportunity. Freight and damage sit with whoever holds title at the time.',
  },
  {
    key: 'brokerage',
    label: 'Brokerage',
    plainDescription:
      'We arrange a transaction between a buyer and a provider and are paid for arranging it. Both sides usually '
      + 'know we are doing so.',
    contracting: 'Either we contract with both sides back to back, or we introduce and take a fee.',
    revenueBasis: 'A spread or a disclosed commission.',
    exposure:
      'Back-to-back contracting puts performance risk on us; a disclosed introduction does not, but is easier '
      + 'for either side to go around next time.',
  },
  {
    key: 'procurement',
    label: 'Procurement agency',
    plainDescription:
      'We buy on the customer\'s behalf, using their money and their authority, because they lack the time or '
      + 'the supplier relationships.',
    contracting: 'We act as the buyer\'s agent. The supplier contract is often theirs, not ours.',
    revenueBasis: 'A fee, a percentage of spend, or a share of savings achieved.',
    exposure:
      'Low cash exposure and low performance liability, but our duty is to the buyer — taking a rebate from a '
      + 'supplier without disclosing it is a conflict, not a margin.',
  },
  {
    key: 'managed_services',
    label: 'Managed service',
    plainDescription:
      'We take ongoing responsibility for an outcome — a clean building, a stocked store, a covered route — and '
      + 'organise whoever is needed to deliver it.',
    contracting: 'We contract with the buyer for the outcome and separately with everyone who delivers it.',
    revenueBasis: 'A recurring fee, less the cost of the providers under it.',
    exposure:
      'The highest operational burden and the stickiest revenue. A failure by any provider is our failure to '
      + 'the customer.',
  },
  {
    key: 'aggregation',
    label: 'Aggregation',
    plainDescription:
      'We combine many small buyers or many small suppliers into one counterparty large enough to be worth '
      + 'dealing with, and take a share of the value that creates.',
    contracting: 'We contract with each participant, and present as one to the other side.',
    revenueBasis: 'Improved pricing from scale, shared with participants or retained.',
    exposure:
      'Nothing works until enough participants join, so the early cost is real and the early revenue is zero.',
  },
  {
    key: 'capacity_arbitrage',
    label: 'Capacity arbitrage',
    plainDescription:
      'Somebody has capacity they are not using — a warehouse bay, a truck lane, an idle crew — and somebody '
      + 'else needs exactly that. We connect them and keep the difference.',
    contracting: 'Usually back to back: we take the capacity and sell it on.',
    revenueBasis: 'The gap between idle-capacity pricing and market pricing.',
    exposure:
      'The window is the whole opportunity. Idle capacity stops being cheap the moment its owner finds another '
      + 'use for it, so a slow process earns nothing.',
  },
  {
    key: 'inventory_arbitrage',
    label: 'Inventory arbitrage',
    plainDescription:
      'Somebody holds stock they need to clear — overproduction, a cancelled order, a discontinued line — and '
      + 'somebody else will buy it at a price that still leaves us a margin.',
    contracting: 'We buy the stock, or take it on consignment, and sell it.',
    revenueBasis: 'The spread, less freight and storage.',
    exposure:
      'If it does not sell, we own it. Consignment removes that risk and reduces the margin, which is usually '
      + 'the right trade early on.',
  },
  {
    key: 'manufacturer_representation',
    label: 'Manufacturer representation',
    plainDescription:
      'A manufacturer without a sales presence in a territory appoints us to sell for them there.',
    contracting: 'The manufacturer contracts with the buyer. We hold a representation agreement.',
    revenueBasis: 'Commission on shipped orders, sometimes with a territory retainer.',
    exposure:
      'No cash exposure and no performance liability, but the relationship is the asset and it can be '
      + 'terminated. Territory exclusivity is the thing worth negotiating hardest.',
  },
  {
    key: 'sales_agency',
    label: 'Sales agency',
    plainDescription:
      'We sell somebody else\'s service under an agency agreement, usually where they have capacity but no '
      + 'commercial function.',
    contracting: 'The principal contracts with the customer. We are their agent.',
    revenueBasis: 'Commission on won work.',
    exposure:
      'Very low, and correspondingly easy to displace. Works best where we own the customer relationship and '
      + 'they own the delivery.',
  },
  {
    key: 'demand_generation',
    label: 'Demand generation',
    plainDescription:
      'We find and qualify buyers for somebody who can already deliver, and are paid for the qualified demand '
      + 'rather than for the transaction.',
    contracting: 'The provider contracts with the buyer. We have an agreement with the provider.',
    revenueBasis: 'Per qualified lead, per appointment, or a share of first-year revenue.',
    exposure:
      'We are paid before the outcome is known, which is the attraction — and it means our incentive and the '
      + 'provider\'s diverge unless the fee is tied to what actually closes.',
  },
  {
    key: 'marketplace',
    label: 'Marketplace transaction',
    plainDescription:
      'We operate the place the transaction happens and take a cut of transactions we did not individually '
      + 'broker.',
    contracting: 'Buyer and seller contract with each other under our terms.',
    revenueBasis: 'Transaction fee or listing fee.',
    exposure:
      'Almost none per transaction, and it requires enough liquidity on both sides to work at all. Not a '
      + 'starting position.',
  },
  {
    key: 'licensing',
    label: 'Licensing and rights',
    plainDescription:
      'We hold or place rights to something — a product line, a territory, a process — and are paid when others '
      + 'use them.',
    contracting: 'A licence agreement, usually with a term and a territory.',
    revenueBasis: 'Royalty or licence fee.',
    exposure: 'Legal complexity well above the others, and slow to start. Rarely the right first structure.',
  },
  {
    key: 'transaction_intermediation',
    label: 'Acquisition and transaction intermediation',
    plainDescription:
      'We introduce and help structure a larger one-off transaction — a business sale, an asset purchase, a '
      + 'contract novation — and are paid on completion.',
    contracting: 'A fee agreement with whichever side engaged us.',
    revenueBasis: 'Success fee, occasionally with a retainer.',
    exposure:
      'Long cycles, binary outcomes, and often a licensing question depending on what is being transacted and '
      + 'where. Check before pursuing, not after.',
  },
];

export const COMMERCIAL_MODEL_BY_KEY = new Map(COMMERCIAL_MODELS.map((m) => [m.key, m]));

// ---------------------------------------------------------------------------
// Acquisition lanes
// ---------------------------------------------------------------------------

/**
 * How an opportunity came to exist, which decides how it may be treated.
 *
 * This is the distinction the engine was missing entirely. A published RFQ and
 * a newly granted licence are not the same kind of thing: one is a buyer
 * asking, the other is a guess about what a buyer might need. They were being
 * scored on the same scale and shown on the same board, which is how a system
 * ends up presenting an inference as a request.
 */
export type AcquisitionLane = 'DIRECT_DEMAND' | 'TRIGGER_BACKED' | 'MARKET_DEVELOPMENT';

export const LANES: Record<AcquisitionLane, { label: string; meaning: string; mayQualifyFast: boolean }> = {
  DIRECT_DEMAND: {
    label: 'Direct demand',
    meaning:
      'Somebody has actually asked for something — a published solicitation, a vendor request, an inbound '
      + 'enquiry. The need is stated by the buyer, not concluded by us.',
    // The only lane where the evidence can carry a qualification on its own.
    mayQualifyFast: true,
  },
  TRIGGER_BACKED: {
    label: 'Trigger-backed',
    meaning:
      'Something happened that usually creates a need — an opening, an award, an expansion, a supplier '
      + 'failure. That is a reason to go and ask. It is not a need, and it must not be shown as one.',
    mayQualifyFast: false,
  },
  MARKET_DEVELOPMENT: {
    label: 'Market development',
    meaning:
      'Nobody has asked and nothing has happened. We believe a market exists and are spending time or money to '
      + 'find out. Legitimate, deliberate, and never to be presented as buyer demand.',
    mayQualifyFast: false,
  },
};

// ---------------------------------------------------------------------------
// Mini-paths
// ---------------------------------------------------------------------------

export type MiniPathKey = string;

export type MiniPath = {
  key: MiniPathKey;
  model: CommercialModelKey;
  vertical: string;
  subvertical: string;
  label: string;
  /** What this is, in one sentence, for somebody outside the trade. */
  plainDescription: string;
  /** The economic change that makes somebody need this. */
  whatCreatesDemand: string;
  /** Who is on the buying side. */
  buyerTypes: string[];
  /** Who is on the delivering side. */
  providerTypes: string[];
  /** Why either side would accept an intermediary at all. */
  intermediaryAdvantage: string;
  /** Lanes this path can legitimately be acquired through. */
  lanes: AcquisitionLane[];
  /**
   * The playbook key in `lib/demand/playbooks.ts`, when one exists.
   *
   * Null is the honest answer for most of these and is what keeps the status
   * derivation from over-claiming: no playbook means no qualification rules,
   * no call script and no evidence threshold, which means taxonomy only.
   */
  playbookKey: string | null;
};

/**
 * Every path, including the ones that do not work.
 *
 * Ordered by commercial model so the universe page can group them without
 * sorting logic, and keyed by a stable string so a route recorded today still
 * resolves after this list is reordered.
 */
export const MINI_PATHS: MiniPath[] = [
  // -------------------------------------------------------------------------
  // Brokerage
  // -------------------------------------------------------------------------
  {
    key: 'brokerage.warehousing.overflow',
    model: 'brokerage',
    vertical: 'Logistics and warehousing',
    subvertical: 'Overflow warehousing',
    label: 'Overflow warehousing',
    plainDescription:
      'A business has more goods than its own space can hold and needs somewhere to put them for weeks or '
      + 'months, without signing a lease.',
    whatCreatesDemand:
      'An import surge, a seasonal build-up, a cancelled or delayed order, a facility move, or a new contract '
      + 'that arrives before the space to service it does.',
    buyerTypes: ['Importers', 'Distributors', 'Manufacturers', 'Retail chains', 'Third-party logistics firms'],
    providerTypes: ['Warehouses with unlet bays', '3PLs with spare racking', 'Cold stores', 'Yard operators'],
    intermediaryAdvantage:
      'Spare warehouse space is invisible: it is not listed anywhere, it appears and disappears within weeks, '
      + 'and the operators holding it are not looking for tenants. Somebody who knows who has space this month '
      + 'is worth paying.',
    lanes: ['DIRECT_DEMAND', 'TRIGGER_BACKED', 'MARKET_DEVELOPMENT'],
    playbookKey: 'brokerage.warehousing.overflow',
  },
  {
    key: 'brokerage.logistics.freight_capacity',
    model: 'capacity_arbitrage',
    vertical: 'Logistics and warehousing',
    subvertical: 'Freight',
    label: 'Freight and logistics capacity',
    plainDescription: 'Matching loads that need moving with carriers that have empty trucks on that lane.',
    whatCreatesDemand: 'A shipper with volume and no contracted carrier, or a carrier running empty back-hauls.',
    buyerTypes: ['Shippers', 'Manufacturers', 'Distributors'],
    providerTypes: ['Carriers', 'Owner-operators', 'Freight brokers with capacity'],
    intermediaryAdvantage: 'Lane knowledge and the ability to fill a back-haul that would otherwise run empty.',
    lanes: ['DIRECT_DEMAND', 'MARKET_DEVELOPMENT'],
    playbookKey: null,
  },
  {
    key: 'brokerage.warehousing.cross_dock',
    model: 'brokerage',
    vertical: 'Logistics and warehousing',
    subvertical: 'Cross-docking',
    label: 'Cross-docking',
    plainDescription: 'Moving goods straight from inbound to outbound without storing them.',
    whatCreatesDemand: 'A distribution pattern that changes faster than a lease can be signed.',
    buyerTypes: ['Retail distributors', 'Importers'],
    providerTypes: ['Cross-dock operators', '3PLs'],
    intermediaryAdvantage: 'Knowing which docks have inbound slots in the window the goods actually arrive.',
    lanes: ['DIRECT_DEMAND', 'MARKET_DEVELOPMENT'],
    playbookKey: null,
  },
  {
    key: 'brokerage.warehousing.fulfillment',
    model: 'brokerage',
    vertical: 'Logistics and warehousing',
    subvertical: 'Fulfilment',
    label: 'Fulfilment capacity',
    plainDescription: 'Placing pick-and-pack volume with an operator who has the capacity to run it.',
    whatCreatesDemand: 'A brand outgrowing its own fulfilment, or a seasonal peak beyond its capacity.',
    buyerTypes: ['E-commerce brands', 'Distributors'],
    providerTypes: ['Fulfilment operators', '3PLs'],
    intermediaryAdvantage: 'Fit is hard to judge from outside; the wrong operator costs a peak season.',
    lanes: ['DIRECT_DEMAND', 'MARKET_DEVELOPMENT'],
    playbookKey: null,
  },
  {
    key: 'brokerage.warehousing.cold_storage',
    model: 'brokerage',
    vertical: 'Logistics and warehousing',
    subvertical: 'Cold storage',
    label: 'Cold storage capacity',
    plainDescription: 'Temperature-controlled space, which is scarcer and more specialised than dry storage.',
    whatCreatesDemand: 'A harvest, an import arrival, a plant shutdown, or a cold-chain failure.',
    buyerTypes: ['Food importers', 'Processors', 'Pharmaceutical distributors'],
    providerTypes: ['Cold stores', 'Refrigerated 3PLs'],
    intermediaryAdvantage: 'Very few operators, rarely advertised, and capacity is genuinely constrained.',
    lanes: ['DIRECT_DEMAND', 'MARKET_DEVELOPMENT'],
    playbookKey: null,
  },
  {
    key: 'brokerage.warehousing.yard',
    model: 'brokerage',
    vertical: 'Logistics and warehousing',
    subvertical: 'Yard and outdoor storage',
    label: 'Yard storage',
    plainDescription: 'Outdoor space for containers, equipment, vehicles or materials.',
    whatCreatesDemand: 'Container dwell, equipment between projects, or a site with nowhere to stage materials.',
    buyerTypes: ['Contractors', 'Equipment owners', 'Drayage operators'],
    providerTypes: ['Yard owners', 'Industrial landowners', 'Truck terminals'],
    intermediaryAdvantage: 'Almost never listed; found by knowing the area rather than by searching.',
    lanes: ['DIRECT_DEMAND', 'MARKET_DEVELOPMENT'],
    playbookKey: null,
  },
  {
    key: 'brokerage.equipment.rental_placement',
    model: 'brokerage',
    vertical: 'Equipment',
    subvertical: 'Rental and placement',
    label: 'Equipment rental or placement',
    plainDescription: 'Putting idle equipment to work on a site that needs it.',
    whatCreatesDemand: 'A project starting without owned equipment, or a fleet sitting between jobs.',
    buyerTypes: ['Contractors', 'Facility operators', 'Event operators'],
    providerTypes: ['Rental yards', 'Contractors with idle fleet'],
    intermediaryAdvantage: 'Utilisation is the owner\'s whole economics, and idle weeks are pure loss to them.',
    lanes: ['DIRECT_DEMAND', 'MARKET_DEVELOPMENT'],
    playbookKey: null,
  },
  {
    key: 'brokerage.space.commercial',
    model: 'brokerage',
    vertical: 'Commercial space',
    subvertical: 'Short-term commercial space',
    label: 'Commercial space',
    plainDescription: 'Short-term or sub-let commercial premises for a use that does not justify a lease.',
    whatCreatesDemand: 'A pop-up, a project office, a temporary production need, a relocation gap.',
    buyerTypes: ['Operators needing temporary premises'],
    providerTypes: ['Landlords with vacancy', 'Tenants with surplus space'],
    intermediaryAdvantage: 'Vacancy is expensive and short-term demand is hard for landlords to find.',
    lanes: ['DIRECT_DEMAND', 'MARKET_DEVELOPMENT'],
    playbookKey: null,
  },
  {
    key: 'brokerage.staffing.commercial',
    model: 'brokerage',
    vertical: 'Staffing',
    subvertical: 'Commercial and industrial labour',
    label: 'Staffing capacity',
    plainDescription: 'Placing crews or individuals with an operation that is short of people.',
    whatCreatesDemand: 'A contract won without the headcount to service it, or a seasonal peak.',
    buyerTypes: ['Facility operators', 'Contractors', 'Warehouses'],
    providerTypes: ['Staffing agencies', 'Labour contractors'],
    intermediaryAdvantage: 'Speed, and knowing which agencies actually have people rather than a website.',
    lanes: ['DIRECT_DEMAND', 'TRIGGER_BACKED', 'MARKET_DEVELOPMENT'],
    playbookKey: null,
  },
  {
    key: 'brokerage.capacity.specialised',
    model: 'capacity_arbitrage',
    vertical: 'Specialised capacity',
    subvertical: 'Manufacturing and processing',
    label: 'Specialised capacity',
    plainDescription: 'Machine time, processing capacity or specialist plant that somebody is not using.',
    whatCreatesDemand: 'A production overflow, a plant outage, or a buyer whose own line is committed.',
    buyerTypes: ['Manufacturers', 'Processors', 'Brands'],
    providerTypes: ['Contract manufacturers', 'Processors with spare shifts'],
    intermediaryAdvantage: 'Spare shift capacity is never advertised and is worth little to its owner idle.',
    lanes: ['DIRECT_DEMAND', 'MARKET_DEVELOPMENT'],
    playbookKey: null,
  },

  // -------------------------------------------------------------------------
  // Subcontracting
  // -------------------------------------------------------------------------
  {
    key: 'subcontracting.facility.commercial',
    model: 'subcontracting',
    vertical: 'Facility services',
    subvertical: 'Commercial facility maintenance',
    label: 'Commercial facility subcontracting',
    plainDescription:
      'A facility-management firm or national service vendor holds a contract somewhere they have no crews, '
      + 'and needs somebody local to actually do the work.',
    whatCreatesDemand:
      'A national contract awarded across territories the holder cannot self-perform, a site added to an '
      + 'existing contract, or a subcontractor who has failed and must be replaced.',
    buyerTypes: ['Facility-management firms', 'National service vendors', 'Prime contractors', 'Property managers'],
    providerTypes: ['Local service contractors', 'Regional crews', 'Specialty trades'],
    intermediaryAdvantage:
      'The prime needs coverage in a place they do not know, quickly, from somebody already vetted. Finding and '
      + 'qualifying that locally is the work they are trying to avoid.',
    lanes: ['DIRECT_DEMAND', 'TRIGGER_BACKED', 'MARKET_DEVELOPMENT'],
    playbookKey: 'subcontracting.facility.commercial',
  },
  {
    key: 'subcontracting.construction.trades',
    model: 'subcontracting',
    vertical: 'Construction',
    subvertical: 'Trade packages',
    label: 'Construction subcontracting',
    plainDescription: 'Taking a trade package on a construction project from the general contractor.',
    whatCreatesDemand: 'An award to a prime who lacks a trade in that market, or a subcontractor default.',
    buyerTypes: ['General contractors', 'Construction managers', 'Developers'],
    providerTypes: ['Trade subcontractors', 'Specialty crews'],
    intermediaryAdvantage: 'Primes need vetted trades on a schedule, and a gap costs them liquidated damages.',
    lanes: ['DIRECT_DEMAND', 'TRIGGER_BACKED'],
    playbookKey: null,
  },
  {
    key: 'subcontracting.awards.capacity_gap',
    model: 'subcontracting',
    vertical: 'Public contracting',
    subvertical: 'Post-award capacity gaps',
    label: 'Post-award prime capacity gaps',
    plainDescription:
      'A prime has just won public work in a place they do not operate, and now has to deliver it there.',
    whatCreatesDemand: 'The award itself, combined with the prime being headquartered somewhere else.',
    buyerTypes: ['Award-winning prime contractors'],
    providerTypes: ['Local subcontractors in the place of performance'],
    intermediaryAdvantage:
      'The award is public and dated, so the need is knowable before the prime has solved it. That window is '
      + 'the entire opportunity.',
    lanes: ['TRIGGER_BACKED'],
    playbookKey: 'cleaning.subcontracting.award_capacity_gap',
  },
  {
    key: 'subcontracting.facility.cleaning',
    model: 'subcontracting',
    vertical: 'Facility services',
    subvertical: 'Cleaning',
    label: 'Cleaning subcontracting',
    plainDescription: 'Performing or arranging janitorial work under somebody else\'s contract.',
    whatCreatesDemand: 'A facility contract covering sites the holder cannot service.',
    buyerTypes: ['Facility-management firms', 'Building owners'],
    providerTypes: ['Janitorial contractors'],
    intermediaryAdvantage: 'Coverage in markets the contract holder does not operate in.',
    lanes: ['DIRECT_DEMAND', 'TRIGGER_BACKED'],
    playbookKey: 'cleaning.subcontracting.capacity_request',
  },
  {
    key: 'subcontracting.facility.landscaping',
    model: 'subcontracting',
    vertical: 'Facility services',
    subvertical: 'Landscaping and grounds',
    label: 'Landscaping and grounds',
    plainDescription: 'Grounds maintenance, snow clearance and seasonal work under a facility contract.',
    whatCreatesDemand: 'Seasonal onset, a portfolio contract, or an incumbent failing during a weather event.',
    buyerTypes: ['Property managers', 'Facility-management firms', 'Retail portfolios'],
    providerTypes: ['Landscaping contractors', 'Snow contractors'],
    intermediaryAdvantage: 'Seasonal capacity is booked early and fails publicly when it is short.',
    lanes: ['TRIGGER_BACKED', 'MARKET_DEVELOPMENT'],
    playbookKey: null,
  },
  {
    key: 'subcontracting.trades.electrical',
    model: 'subcontracting',
    vertical: 'Building trades',
    subvertical: 'Electrical',
    label: 'Electrical',
    plainDescription: 'Licensed electrical work under a prime or facility contract.',
    whatCreatesDemand: 'Fit-out, expansion, compliance work, or an equipment installation.',
    buyerTypes: ['General contractors', 'Facility managers'],
    providerTypes: ['Licensed electrical contractors'],
    intermediaryAdvantage: 'Licensing is jurisdictional and verifying it is exactly what a buyer wants avoided.',
    lanes: ['DIRECT_DEMAND', 'TRIGGER_BACKED'],
    playbookKey: null,
  },
  {
    key: 'subcontracting.trades.plumbing',
    model: 'subcontracting',
    vertical: 'Building trades',
    subvertical: 'Plumbing',
    label: 'Plumbing',
    plainDescription: 'Licensed plumbing work under a prime or facility contract.',
    whatCreatesDemand: 'Fit-out, renovation, compliance, or a failure.',
    buyerTypes: ['General contractors', 'Facility managers', 'Property owners'],
    providerTypes: ['Licensed plumbing contractors'],
    intermediaryAdvantage: 'Same licensing and availability problem as electrical.',
    lanes: ['DIRECT_DEMAND', 'TRIGGER_BACKED'],
    playbookKey: null,
  },
  {
    key: 'subcontracting.trades.hvac',
    model: 'subcontracting',
    vertical: 'Building trades',
    subvertical: 'HVAC',
    label: 'HVAC',
    plainDescription: 'Heating, ventilation and cooling work, installed or maintained.',
    whatCreatesDemand: 'Seasonal failure, a fit-out, an efficiency programme, or a compliance deadline.',
    buyerTypes: ['Facility managers', 'General contractors', 'Building owners'],
    providerTypes: ['HVAC contractors'],
    intermediaryAdvantage: 'Failures are urgent and capacity in a heatwave is genuinely scarce.',
    lanes: ['DIRECT_DEMAND', 'TRIGGER_BACKED'],
    playbookKey: null,
  },
  {
    key: 'subcontracting.facility.waste',
    model: 'subcontracting',
    vertical: 'Facility services',
    subvertical: 'Waste and recycling',
    label: 'Waste and recycling',
    plainDescription: 'Collection, disposal and recycling under a facility or construction contract.',
    whatCreatesDemand: 'A new site, a demolition, a contract renewal, or a compliance requirement.',
    buyerTypes: ['Facility managers', 'Contractors', 'Municipal buyers'],
    providerTypes: ['Waste haulers', 'Recycling operators'],
    intermediaryAdvantage: 'Route density decides price, and buyers cannot see who has it.',
    lanes: ['DIRECT_DEMAND', 'TRIGGER_BACKED'],
    playbookKey: null,
  },
  {
    key: 'subcontracting.facility.security',
    model: 'subcontracting',
    vertical: 'Facility services',
    subvertical: 'Security',
    label: 'Security services',
    plainDescription: 'Guarding, patrol and monitoring under a facility contract.',
    whatCreatesDemand: 'A new site, an incident, an event, or a contract expiry.',
    buyerTypes: ['Property managers', 'Facility-management firms', 'Event operators'],
    providerTypes: ['Licensed security firms'],
    intermediaryAdvantage: 'Licensing and insurance verification, and cover at short notice.',
    lanes: ['DIRECT_DEMAND', 'TRIGGER_BACKED'],
    playbookKey: null,
  },
  {
    key: 'subcontracting.trades.specialty',
    model: 'subcontracting',
    vertical: 'Building trades',
    subvertical: 'Specialty trades',
    label: 'Specialty trades',
    plainDescription: 'Narrow trades — restoration, abatement, high access, industrial cleaning.',
    whatCreatesDemand: 'An incident, an inspection finding, or a project phase needing a specialist.',
    buyerTypes: ['General contractors', 'Facility managers', 'Insurers'],
    providerTypes: ['Specialist contractors'],
    intermediaryAdvantage: 'Few qualified providers and buyers who do not know how to find them.',
    lanes: ['DIRECT_DEMAND', 'TRIGGER_BACKED'],
    playbookKey: null,
  },
  {
    key: 'subcontracting.professional.services',
    model: 'subcontracting',
    vertical: 'Professional services',
    subvertical: 'Technical and compliance',
    label: 'Professional services',
    plainDescription: 'Engineering, inspection, survey or compliance work taken under a prime contract.',
    whatCreatesDemand: 'A project requirement, a regulatory deadline, or a prime without that discipline.',
    buyerTypes: ['Primes', 'Owners', 'Public buyers'],
    providerTypes: ['Licensed professional firms'],
    intermediaryAdvantage: 'Credential matching, which is slow and consequential to get wrong.',
    lanes: ['DIRECT_DEMAND'],
    playbookKey: null,
  },
  {
    key: 'subcontracting.white_label',
    model: 'managed_services',
    vertical: 'Facility services',
    subvertical: 'White-label fulfilment',
    label: 'White-label service fulfilment',
    plainDescription: 'Delivering under another firm\'s brand, so their customer never sees us.',
    whatCreatesDemand: 'A firm that has sold more than it can deliver, or has entered a market it cannot cover.',
    buyerTypes: ['Service firms with sold-out capacity', 'National vendors'],
    providerTypes: ['Delivery capacity willing to work unbranded'],
    intermediaryAdvantage: 'They keep the relationship, we keep the margin, and nobody has to admit anything.',
    lanes: ['DIRECT_DEMAND', 'MARKET_DEVELOPMENT'],
    playbookKey: null,
  },

  // -------------------------------------------------------------------------
  // Distribution
  // -------------------------------------------------------------------------
  {
    key: 'distribution.materials.steel',
    model: 'distribution',
    vertical: 'Building materials',
    subvertical: 'Steel and metals',
    label: 'Steel and building-material distribution',
    plainDescription:
      'Supplying structural steel, rebar, metal products and related building materials into projects that '
      + 'need them on a date.',
    whatCreatesDemand:
      'A construction award or permit that puts a dated material requirement in front of a contractor who has '
      + 'not yet placed the order, or a mill lead time that has moved and left somebody short.',
    buyerTypes: ['General contractors', 'Steel erectors', 'Fabricators', 'Public works buyers'],
    providerTypes: ['Service centres', 'Mills', 'Fabricators', 'Stocking distributors'],
    intermediaryAdvantage:
      'Price and availability move weekly and are not published. Somebody who knows which service centre has '
      + 'the section in stock this week, at what price, saves the contractor a delay that costs far more than '
      + 'the margin.',
    lanes: ['DIRECT_DEMAND', 'TRIGGER_BACKED', 'MARKET_DEVELOPMENT'],
    playbookKey: 'distribution.materials.steel',
  },
  {
    key: 'distribution.supplies.industrial',
    model: 'distribution',
    vertical: 'Industrial supplies',
    subvertical: 'General industrial',
    label: 'Industrial supplies',
    plainDescription: 'Consumables, fasteners, abrasives and general industrial goods on a recurring cycle.',
    whatCreatesDemand: 'A new facility, a supplier failure, or a consolidation programme.',
    buyerTypes: ['Manufacturers', 'Facilities', 'Contractors'],
    providerTypes: ['Industrial distributors', 'Manufacturers'],
    intermediaryAdvantage: 'Consolidating a fragmented spend across many small suppliers.',
    lanes: ['DIRECT_DEMAND', 'MARKET_DEVELOPMENT'],
    playbookKey: null,
  },
  {
    key: 'distribution.supplies.mro',
    model: 'distribution',
    vertical: 'Industrial supplies',
    subvertical: 'MRO',
    label: 'MRO supply',
    plainDescription: 'Maintenance, repair and operations items kept on a recurring replenishment.',
    whatCreatesDemand: 'A facility opening, an expansion, or a contract renewal.',
    buyerTypes: ['Facility operators', 'Manufacturers'],
    providerTypes: ['MRO distributors'],
    intermediaryAdvantage: 'Recurring, predictable, and sticky once the replenishment is established.',
    lanes: ['DIRECT_DEMAND', 'TRIGGER_BACKED'],
    playbookKey: null,
  },
  {
    key: 'distribution.supplies.janitorial',
    model: 'distribution',
    vertical: 'Facility supplies',
    subvertical: 'Janitorial consumables',
    label: 'Janitorial consumables',
    plainDescription: 'Paper, liners, chemicals and equipment supplied on a replenishment cycle.',
    whatCreatesDemand: 'A facility opening or a change of cleaning provider.',
    buyerTypes: ['Facility operators', 'Cleaning contractors'],
    providerTypes: ['Janitorial distributors'],
    intermediaryAdvantage: 'Recurring volume and simple logistics.',
    lanes: ['TRIGGER_BACKED', 'DIRECT_DEMAND'],
    playbookKey: 'cleaning.distribution.replenishment',
  },
  {
    key: 'distribution.supplies.hospitality',
    model: 'distribution',
    vertical: 'Hospitality supplies',
    subvertical: 'Hotel and venue',
    label: 'Hospitality supplies',
    plainDescription: 'Linen, amenities, tableware and operating supplies for hotels and venues.',
    whatCreatesDemand: 'An opening, a refurbishment, or a brand standard change.',
    buyerTypes: ['Hotels', 'Venues', 'Management companies'],
    providerTypes: ['Hospitality distributors', 'Manufacturers'],
    intermediaryAdvantage: 'Openings are dated and the buying window is short.',
    lanes: ['TRIGGER_BACKED'],
    playbookKey: null,
  },
  {
    key: 'distribution.supplies.restaurant',
    model: 'distribution',
    vertical: 'Hospitality supplies',
    subvertical: 'Restaurant',
    label: 'Restaurant supplies',
    plainDescription: 'Smallwares, disposables and equipment for food-service operators.',
    whatCreatesDemand: 'An opening, a menu change, or an equipment failure.',
    buyerTypes: ['Restaurants', 'Groups', 'Caterers'],
    providerTypes: ['Food-service distributors'],
    intermediaryAdvantage: 'Openings are public and dated; incumbents are not yet in place.',
    lanes: ['TRIGGER_BACKED'],
    playbookKey: null,
  },
  {
    key: 'distribution.supplies.packaging',
    model: 'distribution',
    vertical: 'Packaging',
    subvertical: 'Industrial and retail packaging',
    label: 'Packaging',
    plainDescription: 'Cartons, film, labels and protective packaging on recurring supply.',
    whatCreatesDemand: 'A production increase, a new line, or a packaging change.',
    buyerTypes: ['Manufacturers', 'Fulfilment operators', 'Food producers'],
    providerTypes: ['Packaging converters', 'Distributors'],
    intermediaryAdvantage: 'Specification matching and volume pricing across converters.',
    lanes: ['DIRECT_DEMAND', 'MARKET_DEVELOPMENT'],
    playbookKey: null,
  },
  {
    key: 'distribution.supplies.medical',
    model: 'distribution',
    vertical: 'Medical supplies',
    subvertical: 'Clinical consumables',
    label: 'Medical supplies',
    plainDescription: 'Clinical consumables and equipment into care settings.',
    whatCreatesDemand: 'A facility opening, a licence, or a supply disruption.',
    buyerTypes: ['Clinics', 'Care operators', 'Public health buyers'],
    providerTypes: ['Medical distributors'],
    intermediaryAdvantage: 'Regulated supply where compliance and traceability matter more than price.',
    lanes: ['DIRECT_DEMAND', 'TRIGGER_BACKED'],
    playbookKey: null,
  },
  {
    key: 'distribution.supplies.automotive',
    model: 'distribution',
    vertical: 'Automotive supplies',
    subvertical: 'Parts and consumables',
    label: 'Automotive supplies',
    plainDescription: 'Parts, fluids and shop consumables into fleets and workshops.',
    whatCreatesDemand: 'A fleet expansion, a workshop opening, or a supply gap.',
    buyerTypes: ['Fleets', 'Workshops', 'Dealers'],
    providerTypes: ['Parts distributors'],
    intermediaryAdvantage: 'Availability on a date, which is what stops a vehicle earning.',
    lanes: ['DIRECT_DEMAND', 'TRIGGER_BACKED'],
    playbookKey: null,
  },
  {
    key: 'distribution.sourcing.specialty',
    model: 'distribution',
    vertical: 'Specialty sourcing',
    subvertical: 'Hard-to-find goods',
    label: 'Specialty sourcing',
    plainDescription: 'Finding and supplying something a buyer cannot source themselves.',
    whatCreatesDemand: 'A discontinued item, an allocation shortage, or an unusual specification.',
    buyerTypes: ['Any buyer with an unmet specification'],
    providerTypes: ['Specialist suppliers', 'Secondary market'],
    intermediaryAdvantage: 'The search itself is the value, and price sensitivity is low when nothing else fits.',
    lanes: ['DIRECT_DEMAND'],
    playbookKey: null,
  },
  {
    key: 'distribution.inventory.liquidation',
    model: 'inventory_arbitrage',
    vertical: 'Inventory',
    subvertical: 'Excess and obsolete',
    label: 'Excess inventory liquidation',
    plainDescription: 'Finding buyers for stock somebody needs to clear.',
    whatCreatesDemand: 'A cancelled order, a discontinued line, a facility closure, or year-end pressure.',
    buyerTypes: ['Discount buyers', 'Secondary distributors', 'Exporters'],
    providerTypes: ['Holders of excess stock'],
    intermediaryAdvantage:
      'The seller wants it gone and off the balance sheet; the buyer wants a price. Neither can find the other.',
    lanes: ['DIRECT_DEMAND', 'MARKET_DEVELOPMENT'],
    playbookKey: null,
  },

  // -------------------------------------------------------------------------
  // Procurement, representation and development
  // -------------------------------------------------------------------------
  {
    key: 'procurement.institutional',
    model: 'procurement',
    vertical: 'Public and institutional',
    subvertical: 'Institutional procurement',
    label: 'Institutional procurement',
    plainDescription:
      'Responding to formal solicitations from public bodies and institutions on behalf of, or alongside, '
      + 'suppliers who can deliver.',
    whatCreatesDemand: 'A published solicitation with a deadline.',
    buyerTypes: ['Municipalities', 'School districts', 'Hospitals', 'Agencies'],
    providerTypes: ['Registered suppliers', 'Qualified contractors'],
    intermediaryAdvantage:
      'The process is the barrier: registration, bonding, formatting and deadlines defeat capable suppliers '
      + 'who would otherwise win.',
    lanes: ['DIRECT_DEMAND'],
    playbookKey: 'cleaning.brokerage.solicitation',
  },
  {
    key: 'procurement.consolidation',
    model: 'aggregation',
    vertical: 'Procurement',
    subvertical: 'Spend consolidation',
    label: 'Procurement consolidation',
    plainDescription: 'Combining fragmented spend across sites or entities into one supply arrangement.',
    whatCreatesDemand: 'A multi-site operator paying different prices in every location.',
    buyerTypes: ['Multi-site operators', 'Franchise groups', 'Portfolio owners'],
    providerTypes: ['Suppliers willing to price for volume'],
    intermediaryAdvantage: 'Nobody inside the buyer owns the aggregate view, so nobody captures the saving.',
    lanes: ['MARKET_DEVELOPMENT', 'DIRECT_DEMAND'],
    playbookKey: null,
  },
  {
    key: 'procurement.multi_location_supply',
    model: 'managed_services',
    vertical: 'Procurement',
    subvertical: 'Recurring multi-site supply',
    label: 'Multi-location recurring supply',
    plainDescription: 'A standing supply arrangement across many locations of one operator.',
    whatCreatesDemand: 'Expansion, a supplier failure, or a standardisation programme.',
    buyerTypes: ['Multi-site operators'],
    providerTypes: ['Distributors with the footprint or the willingness to build it'],
    intermediaryAdvantage: 'Coverage across locations no single local supplier can serve.',
    lanes: ['MARKET_DEVELOPMENT', 'DIRECT_DEMAND'],
    playbookKey: null,
  },
  {
    key: 'representation.manufacturer',
    model: 'manufacturer_representation',
    vertical: 'Representation',
    subvertical: 'Territory representation',
    label: 'Manufacturer representation',
    plainDescription: 'Selling a manufacturer\'s product in a territory where they have no presence.',
    whatCreatesDemand: 'A manufacturer with capacity and no route to a market.',
    buyerTypes: ['Regional buyers in the territory'],
    providerTypes: ['Manufacturers seeking representation'],
    intermediaryAdvantage: 'Local relationships are the whole barrier, and building them is slow for an outsider.',
    lanes: ['MARKET_DEVELOPMENT'],
    playbookKey: null,
  },
  {
    key: 'development.supplier',
    model: 'aggregation',
    vertical: 'Supply development',
    subvertical: 'Capability building',
    label: 'Supplier development',
    plainDescription:
      'Helping a provider acquire what they lack — coverage, credentials, crew or equipment — so they can take '
      + 'work we already have buyers for.',
    whatCreatesDemand: 'Confirmed demand we cannot currently place.',
    buyerTypes: ['Existing buyers whose work cannot be fulfilled'],
    providerTypes: ['Providers one capability short of being usable'],
    intermediaryAdvantage: 'We can see the demand they cannot, which makes the investment rational for both.',
    lanes: ['MARKET_DEVELOPMENT'],
    playbookKey: 'supply.supplier_development.capacity_gap',
  },
  {
    key: 'development.provider_recruitment',
    model: 'demand_generation',
    vertical: 'Supply development',
    subvertical: 'Provider recruitment',
    label: 'Provider recruitment',
    plainDescription: 'Finding and qualifying providers where supply is what limits the business.',
    whatCreatesDemand: 'Repeatedly losing work for want of somebody to deliver it.',
    buyerTypes: ['Internal — this path serves the other paths'],
    providerTypes: ['Any capable provider in a constrained trade or territory'],
    intermediaryAdvantage: 'Not applicable; this path removes the constraint rather than earning directly.',
    lanes: ['MARKET_DEVELOPMENT'],
    playbookKey: 'supply.provider_recruitment.award_geography',
  },
  {
    key: 'development.seasonal_capacity',
    model: 'capacity_arbitrage',
    vertical: 'Supply development',
    subvertical: 'Seasonal capacity',
    label: 'Seasonal capacity development',
    plainDescription: 'Contracting capacity ahead of a season that reliably creates more demand than supply.',
    whatCreatesDemand: 'A predictable seasonal peak — snow, storm season, harvest, retail peak.',
    buyerTypes: ['Operators exposed to the season'],
    providerTypes: ['Providers with capacity willing to commit early'],
    intermediaryAdvantage: 'Booking capacity before the peak prices it, which only works if done early.',
    lanes: ['MARKET_DEVELOPMENT'],
    playbookKey: null,
  },
  {
    key: 'direct.service.self_perform',
    model: 'managed_services',
    vertical: 'Facility services',
    subvertical: 'Self-performed',
    label: 'Direct service',
    plainDescription: 'Doing the work ourselves, where placing it costs more than performing it.',
    whatCreatesDemand: 'A job small, close and urgent enough that finding a provider is not worth the time.',
    buyerTypes: ['Local buyers'],
    providerTypes: ['Our own crew'],
    intermediaryAdvantage:
      'None — this is the case where being an intermediary adds cost rather than value, which is worth being '
      + 'able to say.',
    lanes: ['DIRECT_DEMAND', 'TRIGGER_BACKED'],
    playbookKey: 'direct.service.self_perform',
  },
];

export const MINI_PATH_BY_KEY = new Map(MINI_PATHS.map((p) => [p.key, p]));

/**
 * The three paths the owner named as having to work end to end.
 *
 * Kept as data rather than prose so the universe page and the walkthrough
 * cannot disagree about which ones were promised.
 */
export const PROVEN_PATH_TARGETS: MiniPathKey[] = [
  'brokerage.warehousing.overflow',
  'distribution.materials.steel',
  'subcontracting.facility.commercial',
];
