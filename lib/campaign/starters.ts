import type { SignalCategory } from '@prisma/client';

/**
 * Campaigns an owner can start from, filled in far enough to be arguable.
 *
 * A blank campaign form asks somebody to state a market thesis, name the
 * evidence against it, price the test in hours, and write a kill condition —
 * from nothing, in one sitting. That is a reasonable thing to require of a
 * finished campaign and an unreasonable thing to require of a first draft, and
 * the result is the form never gets filled in. The campaigns page was a
 * paperweight for exactly this reason.
 *
 * So each starter arrives complete enough to be criticised: a real thesis, a
 * real reason it might be wrong, an honest cost in hours, and a kill condition
 * with a number in it. None of them can be started as they stand — every one
 * needs a geography and, in most cases, better evidence than "this is generally
 * true", and the readiness rules refuse until it has them. That is the point.
 * Editing somebody else's argument is a different and much easier job than
 * writing one from a blank page.
 *
 * The contrary evidence is the part that matters. A starter that only argued
 * for itself would be a sales pitch, and a campaign whose thesis nobody has
 * argued against has not been thought about.
 */

export type CampaignStarter = {
  key: string;
  label: string;
  /** What this campaign is, for somebody who does not know the trade. */
  premise: string;
  route: SignalCategory;
  requiredCapability: string;
  buyerProfile: string;
  providerProfile: string;
  thesis: string;
  whyNow: string;
  testingHours: number;
  testingCostBasis: string;
  evidence: Array<{
    kind: 'SUPPORTING' | 'CONTRARY';
    claim: string;
    evidenceClass: 'CONFIRMED_BY_PERSON' | 'EXTERNALLY_OBSERVED' | 'CALCULATED_FROM_CONFIRMED_INPUTS' | 'INFERRED' | 'UNKNOWN';
  }>;
  conditions: Array<{
    kind: 'KILL' | 'EXPAND';
    metric: 'ROUTES_GENERATED' | 'CONVERSATIONS_HELD' | 'REQUIREMENTS_CONFIRMED' | 'PROVIDERS_VERIFIED'
      | 'QUOTES_SENT' | 'COMMITMENTS_WON' | 'COLLECTED_GROSS_PROFIT' | 'SPEND' | 'DAYS_RUNNING' | 'RETURN_ON_SPEND';
    comparator: 'BELOW' | 'AT_OR_BELOW' | 'ABOVE' | 'AT_OR_ABOVE';
    threshold: number;
    afterDays: number;
    statement: string;
  }>;
  /** What the owner must supply before this can run. Shown on the form. */
  youMustAdd: string[];
};

const CALLING_ONLY = 'Calling time only. No paid channel is enabled, so the cash cost is zero and the real cost '
  + 'is the hours.';

export const CAMPAIGN_STARTERS: CampaignStarter[] = [
  {
    key: 'steel_supply_metro',
    label: 'Develop steel and building-material supply in one metro',
    premise:
      'Pick a city with construction activity, find the contractors buying structural material, and find the '
      + 'service centres that could supply them.',
    route: 'DISTRIBUTION',
    requiredCapability: 'Steel and building-material supply',
    buyerProfile:
      'General contractors, steel erectors and fabricators with awarded work in the metro who buy material '
      + 'rather than having it supplied inside the main contract.',
    providerProfile:
      'Service centres and stocking distributors within delivery range, and fabricators with spare capacity.',
    thesis:
      'Steel price and availability move weekly and are not published, so a contractor who has just been '
      + 'awarded work does not know which service centre has their sections in stock this week or at what '
      + 'price. Somebody who does know can place the order and keep a margin the contractor never sees, '
      + 'because the alternative is a delay that costs them more than the spread.',
    whyNow:
      'Awards are public and dated, and material is ordered in the weeks between award and mobilisation. That '
      + 'window is knowable in advance and closes on its own.',
    testingHours: 30,
    testingCostBasis: CALLING_ONLY,
    evidence: [
      {
        kind: 'SUPPORTING',
        claim: 'Public construction awards carry a dated start, so the material-buying window can be derived.',
        evidenceClass: 'EXTERNALLY_OBSERVED',
      },
      {
        kind: 'CONTRARY',
        claim:
          'On most projects the material package is inside the main contract and was ordered the week of '
          + 'award, in which case there is nothing left to sell by the time the award is public.',
        evidenceClass: 'INFERRED',
      },
      {
        kind: 'CONTRARY',
        claim:
          'Contractors of any size already have a service centre they always use, and the relationship is '
          + 'usually older than the buyer.',
        evidenceClass: 'INFERRED',
      },
    ],
    conditions: [
      {
        kind: 'KILL', metric: 'REQUIREMENTS_CONFIRMED', comparator: 'AT_OR_BELOW', threshold: 0, afterDays: 21,
        statement: 'Stop if no contractor has given us a section list and tonnage after three weeks.',
      },
      {
        kind: 'EXPAND', metric: 'COLLECTED_GROSS_PROFIT', comparator: 'AT_OR_ABOVE', threshold: 5000, afterDays: 0,
        statement: 'Widen to a second metro once five thousand of gross profit has actually been collected.',
      },
    ],
    youMustAdd: [
      'The metro, as a state and city',
      'At least one piece of evidence about this specific market rather than the trade in general',
    ],
  },
  {
    key: 'subcontractor_capacity_public',
    label: 'Recruit subcontractor capacity around active public projects',
    premise:
      'Find primes who have won public work in places they do not operate, and find local crews who could '
      + 'deliver it for them.',
    route: 'PROVIDER_RECRUITMENT',
    requiredCapability: 'Commercial facility services delivery',
    buyerProfile: 'Prime contractors and national service vendors with awarded work outside their own footprint.',
    providerProfile: 'Local crews and trade contractors in the place of performance who can meet prime insurance limits.',
    thesis:
      'A prime that wins work in a state where it has no crews must find local capacity fast, from somebody '
      + 'already insured and willing to be onboarded. Finding and vetting that locally is the work they are '
      + 'trying to avoid, and the award tells us it is happening before they have solved it.',
    whyNow:
      'Awards are dated and public. The gap between winning and mobilising is when the prime is looking, and it '
      + 'is a few weeks wide.',
    testingHours: 25,
    testingCostBasis: CALLING_ONLY,
    evidence: [
      {
        kind: 'SUPPORTING',
        claim: 'Award records publish both the place of performance and where the winner is based, so the gap is visible.',
        evidenceClass: 'EXTERNALLY_OBSERVED',
      },
      {
        kind: 'CONTRARY',
        claim:
          'Many primes self-perform as a matter of policy, and the ones that do not usually have a standing '
          + 'subcontractor list they go to first.',
        evidenceClass: 'INFERRED',
      },
      {
        kind: 'CONTRARY',
        claim:
          'Prime vendor onboarding often takes longer than the mobilisation window, so being right about the '
          + 'need is not enough to be usable.',
        evidenceClass: 'INFERRED',
      },
    ],
    conditions: [
      {
        kind: 'KILL', metric: 'PROVIDERS_VERIFIED', comparator: 'AT_OR_BELOW', threshold: 1, afterDays: 30,
        statement: 'Stop if fewer than two local providers have been verified as able and willing after a month.',
      },
      {
        kind: 'EXPAND', metric: 'COMMITMENTS_WON', comparator: 'AT_OR_ABOVE', threshold: 1, afterDays: 0,
        statement: 'Widen once one prime has actually committed to a local crew we placed.',
      },
    ],
    youMustAdd: ['The states to work', 'A view on which trades are actually short of capacity there'],
  },
  {
    key: 'overflow_warehousing_corridor',
    label: 'Build overflow warehousing capacity near a logistics corridor',
    premise:
      'Find warehouses with unlet bays along an industrial corridor, and find the importers and distributors '
      + 'who periodically have more goods than space.',
    route: 'BROKERAGE',
    requiredCapability: 'Short-term warehouse space',
    buyerProfile: 'Importers, distributors and manufacturers with seasonal or contract-driven overflow.',
    providerProfile: 'Warehouses, 3PLs and cold stores with bays they are not letting.',
    thesis:
      'Spare warehouse space is invisible — it is not listed, it appears and disappears within weeks, and the '
      + 'operators holding it are not looking for tenants. Somebody who knows who has space this month can '
      + 'place overflow that would otherwise be stacked badly somewhere expensive.',
    whyNow:
      'Overflow is arranged in the two months before goods arrive, so the need is knowable from expansions, '
      + 'new locations and import activity before anybody advertises it.',
    testingHours: 25,
    testingCostBasis: CALLING_ONLY,
    evidence: [
      {
        kind: 'SUPPORTING',
        claim: 'Spare warehouse capacity is not published anywhere, so it cannot be found by searching.',
        evidenceClass: 'INFERRED',
      },
      {
        kind: 'CONTRARY',
        claim:
          'Operators with real overflow usually already have a 3PL relationship and call them first; we would '
          + 'be the second call, not the first.',
        evidenceClass: 'INFERRED',
      },
      {
        kind: 'CONTRARY',
        claim:
          'Warehouse operators would rather hold out for a longer let than take a two-month overflow, so the '
          + 'space that is genuinely available may be the space nobody wants.',
        evidenceClass: 'INFERRED',
      },
    ],
    conditions: [
      {
        kind: 'KILL', metric: 'PROVIDERS_VERIFIED', comparator: 'AT_OR_BELOW', threshold: 2, afterDays: 28,
        statement: 'Stop if fewer than three warehouses have confirmed available space after four weeks.',
      },
      {
        kind: 'EXPAND', metric: 'COLLECTED_GROSS_PROFIT', comparator: 'AT_OR_ABOVE', threshold: 3000, afterDays: 0,
        statement: 'Widen along the corridor once three thousand of gross profit has been collected.',
      },
    ],
    youMustAdd: ['The corridor, as states and cities', 'Whether temperature-controlled space is in scope'],
  },
  {
    key: 'excess_inventory_buyers',
    label: 'Find buyers for excess inventory',
    premise:
      'Find businesses holding stock they need to clear, and find the discount and secondary buyers who would '
      + 'take it at a price.',
    route: 'DISTRIBUTION',
    requiredCapability: 'Excess inventory placement',
    buyerProfile: 'Discount retailers, secondary distributors, exporters and liquidators.',
    providerProfile: 'Manufacturers, importers and distributors with obsolete, cancelled or overstocked goods.',
    thesis:
      'A holder of excess stock wants it gone and off the balance sheet; a discount buyer wants a price. '
      + 'Neither can find the other efficiently, and the holder is usually more motivated by the write-down '
      + 'than by the recovery.',
    whyNow:
      'Cancelled orders, discontinued lines and year-end pressure create this continuously rather than '
      + 'seasonally, so there is no window to miss — which also means no urgency to exploit.',
    testingHours: 20,
    testingCostBasis: CALLING_ONLY,
    evidence: [
      {
        kind: 'SUPPORTING',
        claim: 'Excess stock is a recognised balance-sheet problem that businesses actively want solved.',
        evidenceClass: 'INFERRED',
      },
      {
        kind: 'CONTRARY',
        claim:
          'Established liquidators already cover this and have the buyer relationships; there is no dated '
          + 'trigger that would let us reach a holder before they do.',
        evidenceClass: 'INFERRED',
      },
      {
        kind: 'CONTRARY',
        claim: 'Taking stock on our own book to make the margin work is inventory risk, which is the risk we least want.',
        evidenceClass: 'INFERRED',
      },
    ],
    conditions: [
      {
        kind: 'KILL', metric: 'REQUIREMENTS_CONFIRMED', comparator: 'AT_OR_BELOW', threshold: 0, afterDays: 21,
        statement: 'Stop if nobody has told us what stock they are holding after three weeks.',
      },
      {
        kind: 'EXPAND', metric: 'COMMITMENTS_WON', comparator: 'AT_OR_ABOVE', threshold: 2, afterDays: 0,
        statement: 'Widen once two lots have actually been placed with a buyer.',
      },
    ],
    youMustAdd: [
      'The geography and the commodity types in scope',
      'A decision on whether we will ever take title, because the thesis changes if we will not',
    ],
  },
  {
    key: 'multi_location_facility',
    label: 'Develop multi-location facility-service coverage',
    premise:
      'Find operators running many sites with a different supplier at each, and build one arrangement across '
      + 'all of them.',
    route: 'SUBCONTRACTING',
    requiredCapability: 'Commercial facility services delivery',
    buyerProfile: 'Multi-site operators, franchise groups and portfolio property owners.',
    providerProfile: 'Local service contractors in each market, coordinated centrally.',
    thesis:
      'A multi-site operator pays a different price in every location and nobody inside the business owns the '
      + 'aggregate view, so nobody captures the saving. One arrangement across the portfolio is worth more to '
      + 'them than the discount costs us.',
    whyNow:
      'Not time-sensitive, which is a weakness of this campaign rather than a strength: there is no dated '
      + 'trigger, so it competes for attention against work that has a deadline.',
    testingHours: 35,
    testingCostBasis: CALLING_ONLY,
    evidence: [
      {
        kind: 'SUPPORTING',
        claim: 'Fragmented site-level purchasing is a well-known source of unmanaged spend in multi-site operators.',
        evidenceClass: 'INFERRED',
      },
      {
        kind: 'CONTRARY',
        claim:
          'Consolidating spend is a procurement project with a long cycle and several stakeholders, and we '
          + 'would be a new supplier proposing it.',
        evidenceClass: 'INFERRED',
      },
      {
        kind: 'CONTRARY',
        claim: 'Without a dated trigger there is no reason for anybody to act this quarter rather than next.',
        evidenceClass: 'INFERRED',
      },
    ],
    conditions: [
      {
        kind: 'KILL', metric: 'CONVERSATIONS_HELD', comparator: 'AT_OR_BELOW', threshold: 3, afterDays: 30,
        statement: 'Stop if fewer than four operators have engaged at all after a month.',
      },
      {
        kind: 'EXPAND', metric: 'QUOTES_SENT', comparator: 'AT_OR_ABOVE', threshold: 3, afterDays: 0,
        statement: 'Widen once three portfolio quotes have been sent.',
      },
    ],
    youMustAdd: ['The geography', 'The service scope, because "facility services" is too broad to qualify against'],
  },
  {
    key: 'seasonal_trade_capacity',
    label: 'Build specialty-trade coverage before seasonal demand',
    premise:
      'Contract trade capacity ahead of a season that reliably creates more demand than supply, while it is '
      + 'still cheap.',
    route: 'SUPPLIER_DEVELOPMENT',
    requiredCapability: 'Seasonal trade capacity',
    buyerProfile: 'Property managers and facility operators exposed to the season.',
    providerProfile: 'Trade contractors with capacity willing to commit before the peak.',
    thesis:
      'Seasonal capacity is booked before the season and priced during it. Committing early costs less than '
      + 'buying in the peak, and the operators exposed to the season know it — which is why the ones who '
      + 'planned ahead are not available to buy from later.',
    whyNow: 'The season is dated, and the commitment has to be made before it starts to be worth anything.',
    testingHours: 20,
    testingCostBasis: CALLING_ONLY,
    evidence: [
      {
        kind: 'SUPPORTING',
        claim: 'Seasonal trades are demonstrably capacity-constrained during their peak.',
        evidenceClass: 'INFERRED',
      },
      {
        kind: 'CONTRARY',
        claim:
          'Committing to capacity before we have committed buyers is taking the risk ourselves, which is the '
          + 'opposite of how every other path here works.',
        evidenceClass: 'INFERRED',
      },
      {
        kind: 'CONTRARY',
        claim: 'A mild season leaves the committed capacity unused and paid for.',
        evidenceClass: 'INFERRED',
      },
    ],
    conditions: [
      {
        kind: 'KILL', metric: 'REQUIREMENTS_CONFIRMED', comparator: 'AT_OR_BELOW', threshold: 1, afterDays: 30,
        statement: 'Stop if fewer than two buyers have confirmed a seasonal requirement before we commit to capacity.',
      },
      {
        kind: 'EXPAND', metric: 'COMMITMENTS_WON', comparator: 'AT_OR_ABOVE', threshold: 3, afterDays: 0,
        statement: 'Widen once three seasonal commitments are in place.',
      },
    ],
    youMustAdd: ['The trade and the season', 'The geography', 'Whether we will commit to capacity before buyers do'],
  },
  {
    key: 'institutional_supply_lane',
    label: 'Create a recurring institutional-supply lane',
    premise:
      'Find institutions that buy the same things on a schedule through formal procurement, and get registered '
      + 'to supply them.',
    route: 'DISTRIBUTION',
    requiredCapability: 'Institutional supply',
    buyerProfile: 'School districts, municipalities, hospitals and public agencies.',
    providerProfile: 'Suppliers able to meet public procurement, bonding and registration requirements.',
    thesis:
      'Institutional buyers publish what they need and buy it repeatedly, but the process — registration, '
      + 'bonding, formatting, deadlines — defeats capable suppliers who would otherwise win. Handling the '
      + 'process is the service, and the revenue recurs once the lane is open.',
    whyNow:
      'Solicitations are published with deadlines, so the work arrives dated and the only question is whether '
      + 'we can respond in time.',
    testingHours: 40,
    testingCostBasis: CALLING_ONLY,
    evidence: [
      {
        kind: 'SUPPORTING',
        claim: 'Public solicitations are published with scope and deadline, so the demand is stated rather than inferred.',
        evidenceClass: 'EXTERNALLY_OBSERVED',
      },
      {
        kind: 'CONTRARY',
        claim:
          'Registration and bonding take weeks and must be done before the first bid, so the first several '
          + 'solicitations will pass while we are still becoming eligible.',
        evidenceClass: 'INFERRED',
      },
      {
        kind: 'CONTRARY',
        claim:
          'Public buying is price-led with published results, so margins are visible to competitors and '
          + 'compress every cycle.',
        evidenceClass: 'INFERRED',
      },
    ],
    conditions: [
      {
        kind: 'KILL', metric: 'QUOTES_SENT', comparator: 'AT_OR_BELOW', threshold: 0, afterDays: 45,
        statement: 'Stop if no bid has actually been submitted after six weeks.',
      },
      {
        kind: 'EXPAND', metric: 'COMMITMENTS_WON', comparator: 'AT_OR_ABOVE', threshold: 1, afterDays: 0,
        statement: 'Widen to neighbouring authorities once one award has been won.',
      },
    ],
    youMustAdd: [
      'The jurisdictions',
      'The commodity or service category',
      'Who will actually complete the registration, and by when',
    ],
  },
];

export function starterByKey(key: string): CampaignStarter | undefined {
  return CAMPAIGN_STARTERS.find((s) => s.key === key);
}
