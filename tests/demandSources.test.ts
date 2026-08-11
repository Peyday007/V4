import { describe, expect, it } from 'vitest';
import { toSolicitationEvent, type SolicitationDataset } from '@/lib/demand/connectors/municipalSolicitations';
import { toAwardEvent } from '@/lib/demand/connectors/contractAwards';
import { assessFulfilment, type ProviderCandidate } from '@/lib/demand/fulfilment';
import {
  assessCompliance,
  assessCounterpartyRisk,
  assessPaymentRisk,
  assessWorkingCapital,
  riskBlocksPursuit,
} from '@/lib/demand/risk';
import { buildThesis, thesisGaps } from '@/lib/demand/thesis';
import { playbooksFor } from '@/lib/demand/playbooks';

const NOW = new Date('2026-08-11T12:00:00Z');
const DAY = 86_400_000;
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);
const ahead = (d: number) => new Date(NOW.getTime() + d * DAY);

// ---------------------------------------------------------------------------
// Local solicitations
// ---------------------------------------------------------------------------

const BIDS: SolicitationDataset = {
  domain: 'data.baltimorecity.gov',
  datasetId: 'wxdc-cbe2',
  label: 'Baltimore bid solicitations',
  state: 'MD',
  dateColumn: 'issue_date',
  columns: {
    title: 'title',
    description: 'description',
    agency: 'agency',
    closeDate: 'due_date',
    naturalKey: 'bid_number',
    noticeType: 'type',
  },
};

describe('local solicitations produce tier A demand automatically', () => {
  it('ingests a cleaning bid with its buyer and deadline', () => {
    const event = toSolicitationEvent(
      {
        title: 'Janitorial services for municipal buildings',
        description: 'Nightly custodial cleaning across four sites.',
        agency: 'Department of General Services',
        bid_number: 'B50006543',
        issue_date: '2026-08-05',
        due_date: '2026-09-02',
        type: 'IFB',
      },
      BIDS,
    )!;

    expect(event.type).toBe('ACTIVE_RFQ');
    expect(event.eventDate?.toISOString().slice(0, 10)).toBe('2026-08-05');
    expect(event.deadlineAt?.toISOString().slice(0, 10)).toBe('2026-09-02');
    expect(event.parties[0]).toEqual({ role: 'BUYER', name: 'Department of General Services' });
    expect(event.sourceUrl).toContain('B50006543');
  });

  it('ignores notices outside the trade', () => {
    // A city publishes hundreds a month and almost none are cleaning.
    // Admitting the rest so the board looks busy costs an afternoon each.
    expect(
      toSolicitationEvent(
        { title: 'Asphalt resurfacing, district 4', agency: 'DOT', issue_date: '2026-08-05' },
        BIDS,
      ),
    ).toBeNull();
  });

  it('separates a standing vendor list from an open job', () => {
    // Registering is worth doing. It is not a deal, and must never be shown
    // with a deadline it does not have.
    const event = toSolicitationEvent(
      {
        title: 'Vendor registration — janitorial supplies',
        description: 'Prequalification list for cleaning supply vendors.',
        agency: 'Procurement',
        issue_date: '2026-08-01',
      },
      BIDS,
    )!;
    expect(event.type).toBe('VENDOR_REQUEST');
    expect(event.inferredFacts.join(' ')).toMatch(/not an open job/i);
  });

  it('routes a supply purchase to distribution rather than brokerage', () => {
    const event = toSolicitationEvent(
      {
        title: 'Purchase of janitorial supplies and can liners',
        description: 'Annual supply of paper products and cleaning chemicals.',
        agency: 'Purchasing Division',
        issue_date: '2026-08-04',
      },
      BIDS,
    )!;
    expect(event.relatedCapabilities).toContain('Janitorial consumables');
    expect(event.inferredFacts.join(' ')).toMatch(/supply purchase rather than a service crew/i);
  });

  it('drops a notice with no publication date', () => {
    expect(
      toSolicitationEvent({ title: 'Custodial services', agency: 'DGS' }, BIDS),
    ).toBeNull();
  });

  it('feeds both a brokerage and a distribution playbook', () => {
    const keys = playbooksFor('ACTIVE_RFQ').map((p) => p.key);
    expect(keys).toContain('cleaning.brokerage.solicitation');
    expect(keys).toContain('cleaning.distribution.supply_procurement');
  });

  it('feeds a vendor-network subcontracting playbook', () => {
    expect(playbooksFor('VENDOR_REQUEST').map((p) => p.key)).toContain('cleaning.subcontracting.vendor_network');
  });
});

// ---------------------------------------------------------------------------
// Fulfilment
// ---------------------------------------------------------------------------

function provider(over: Partial<ProviderCandidate> = {}): ProviderCandidate {
  return {
    id: 'p1',
    name: 'Midway Cleaning',
    stateCode: 'IL',
    cityName: 'Chicago',
    capabilities: ['Commercial janitorial'],
    serviceTerritories: [],
    hasInsurance: true,
    hasLicences: true,
    hasPricing: true,
    statedCapacity: 3,
    lastVerifiedAt: ago(10),
    ...over,
  };
}

describe('fulfilment checks six things, not one', () => {
  it('clears a fully-known local provider', () => {
    const result = assessFulfilment({
      requiredCapability: 'Commercial janitorial',
      stateCode: 'IL',
      cityName: 'Chicago',
      neededBy: ahead(20),
      providers: [provider()],
      now: NOW,
    });
    expect(result.status).toBe('AVAILABLE');
    expect(result.blocksPursuit).toBe(false);
    expect(result.matched).toHaveLength(1);
  });

  it('reports an empty network as one setup problem, not a verdict per lead', () => {
    const result = assessFulfilment({
      requiredCapability: 'Commercial janitorial',
      stateCode: 'IL',
      cityName: null,
      neededBy: null,
      providers: [],
      now: NOW,
    });
    expect(result.status).toBe('UNKNOWN');
    expect(result.reason).toMatch(/one setup problem, not a verdict/i);
    expect(result.sourcingTask).toMatch(/recruit at least one provider/i);
  });

  it('blocks pursuit and names a sourcing task when nobody covers the state', () => {
    const result = assessFulfilment({
      requiredCapability: 'Commercial janitorial',
      stateCode: 'TX',
      cityName: 'Austin',
      neededBy: ahead(20),
      providers: [provider({ stateCode: 'IL' })],
      now: NOW,
    });
    expect(result.status).toBe('UNAVAILABLE');
    expect(result.blocksPursuit).toBe(true);
    expect(result.sourcingTask).toMatch(/covering TX/i);
  });

  it('honours a stated service territory over a home address', () => {
    const result = assessFulfilment({
      requiredCapability: 'Commercial janitorial',
      stateCode: 'IN',
      cityName: null,
      neededBy: ahead(20),
      providers: [provider({ stateCode: 'IL', serviceTerritories: ['IL', 'IN', 'WI'] })],
      now: NOW,
    });
    expect(result.status).not.toBe('UNAVAILABLE');
  });

  it('treats stale capacity as unknown rather than free', () => {
    // Crew availability is the fastest-decaying fact in this business.
    const result = assessFulfilment({
      requiredCapability: 'Commercial janitorial',
      stateCode: 'IL',
      cityName: null,
      neededBy: ahead(20),
      providers: [provider({ lastVerifiedAt: ago(200) })],
      now: NOW,
    });
    const capacity = result.checks.find((c) => c.name === 'capacity')!;
    expect(capacity.passed).toBeNull();
    expect(capacity.detail).toMatch(/not the same as free/i);
  });

  it('does not block the conversation over a missing certificate', () => {
    // A credential gap is closed with a phone call. Having nobody at all is
    // a different problem and blocks.
    const result = assessFulfilment({
      requiredCapability: 'Commercial janitorial',
      stateCode: 'IL',
      cityName: null,
      neededBy: ahead(20),
      providers: [provider({ hasInsurance: false, hasLicences: false })],
      now: NOW,
    });
    expect(result.status).toBe('PARTIAL');
    expect(result.blocksPursuit).toBe(false);
    expect(result.sourcingTask).toMatch(/certificate of insurance/i);
  });

  it('fails timing when the work was needed in the past', () => {
    const result = assessFulfilment({
      requiredCapability: 'Commercial janitorial',
      stateCode: 'IL',
      cityName: null,
      neededBy: ago(5),
      providers: [provider()],
      now: NOW,
    });
    expect(result.checks.find((c) => c.name === 'timing')?.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------

describe('unknown risk stays unknown', () => {
  it('does not call an unassessed buyer low risk', () => {
    const result = assessPaymentRisk({
      isPublicSector: null,
      hasPaidBefore: null,
      isNewlyEstablished: null,
      statedTermsDays: null,
      exposure: 3000,
    });
    expect(result.level).toBe('UNKNOWN');
    expect(result.reason).toMatch(/not the same as low risk/i);
    expect(result.toResolve.length).toBeGreaterThan(0);
  });

  it('blocks committing real money against an unassessed counterparty', () => {
    const blocked = riskBlocksPursuit({
      paymentRisk: 'UNKNOWN',
      counterpartyRisk: 'UNKNOWN',
      maxCashExposure: 8000,
    });
    expect(blocked.blocks).toBe(true);
    expect(blocked.reason).toMatch(/unknown is not low/i);

    // Small exposure does not need the same certainty.
    expect(riskBlocksPursuit({ paymentRisk: 'UNKNOWN', counterpartyRisk: 'UNKNOWN', maxCashExposure: 400 }).blocks)
      .toBe(false);
  });

  it('recognises a public buyer as slow but reliable', () => {
    expect(
      assessPaymentRisk({
        isPublicSector: true,
        hasPaidBefore: null,
        isNewlyEstablished: null,
        statedTermsDays: null,
        exposure: 5000,
      }).level,
    ).toBe('LOW');
  });

  it('flags a brand-new business we would advance money to', () => {
    const result = assessPaymentRisk({
      isPublicSector: false,
      hasPaidBefore: null,
      isNewlyEstablished: true,
      statedTermsDays: null,
      exposure: 4000,
    });
    expect(result.level).toBe('HIGH');
    expect(result.reason).toMatch(/deposit/i);
  });

  it('assesses the counterparty separately from whether they pay', () => {
    const solventButVague = assessCounterpartyRisk({
      identityVerified: true,
      scopeIsClear: null,
      knownDisputes: null,
      reachable: true,
    });
    expect(solventButVague.level).not.toBe('LOW');
  });
});

describe('working capital reflects who holds the contract', () => {
  it('commits nothing on a referral or a subcontract', () => {
    expect(
      assessWorkingCapital({ structure: 'REFERRAL', providerCost: 5000, buyerPaymentDays: 30, supplierTermsDays: 0, depositPct: null })
        .maxCashExposure,
    ).toBe(0);
    expect(
      assessWorkingCapital({ structure: 'SUBCONTRACTING', providerCost: 5000, buyerPaymentDays: 30, supplierTermsDays: 0, depositPct: null })
        .maxCashExposure,
    ).toBe(0);
  });

  it('commits the provider cost on brokerage, less any deposit', () => {
    const result = assessWorkingCapital({
      structure: 'BROKERAGE',
      providerCost: 5000,
      buyerPaymentDays: 45,
      supplierTermsDays: 15,
      depositPct: 0.2,
    });
    expect(result.maxCashExposure).toBe(4000);
    expect(result.daysExposed).toBe(30);
  });

  it('reports unknown duration rather than assuming thirty days', () => {
    const result = assessWorkingCapital({
      structure: 'BROKERAGE',
      providerCost: 5000,
      buyerPaymentDays: null,
      supplierTermsDays: null,
      depositPct: null,
    });
    expect(result.daysExposed).toBeNull();
    expect(result.reason).toMatch(/duration of that exposure is unknown/i);
  });

  it('reports unknown exposure when no cost is known', () => {
    const result = assessWorkingCapital({
      structure: 'BROKERAGE',
      providerCost: null,
      buyerPaymentDays: 30,
      supplierTermsDays: 0,
      depositPct: null,
    });
    expect(result.maxCashExposure).toBeNull();
    expect(result.reason).toMatch(/unknown, not zero/i);
  });
});

describe('compliance separates a task from a disqualification', () => {
  const playbook = playbooksFor('FACILITY_OPENING')[0];

  it('treats routine trade cover as nearly ready', () => {
    const result = assessCompliance({ playbook, satisfied: [], knownBlockers: [], providerInsured: false });
    expect(result.status).toBe('NEARLY_READY');
    expect(result.blocksPursuit).toBe(false);
  });

  it('blocks pursuit only on something we cannot do', () => {
    const result = assessCompliance({
      playbook,
      satisfied: [],
      knownBlockers: ['a state contractor licence we do not hold'],
      providerInsured: true,
    });
    expect(result.status).toBe('STRUCTURALLY_UNQUALIFIED');
    expect(result.blocksPursuit).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Thesis
// ---------------------------------------------------------------------------

describe('every tier A/B route carries a complete thesis', () => {
  const playbook = playbooksFor('OCCUPANCY_OR_OPERATING_APPROVAL').find((p) => p.key === 'cleaning.brokerage.pre_opening')!;

  const thesis = buildThesis({
    organisation: 'Ironside Strength',
    location: 'Chicago, IL',
    eventType: 'OCCUPANCY_OR_OPERATING_APPROVAL',
    eventDate: ahead(21),
    confirmedFacts: ['Chicago business licences records a licence start date of 2026-09-01'],
    playbook,
    tier: 'STRONG_TRIGGER',
    tierReason: 'Occupancy approval dated 2026-09-01.',
    needIsConfirmed: false,
    friction: 'LOW',
    frictionReason: 'Low friction. In favour: local purchasing authority.',
    fulfilmentStatus: 'AVAILABLE',
    fulfilmentReason: '2 providers can do this work in IL.',
    buyingWindow: 'WITHIN_30_DAYS',
    windowClosesAt: ahead(19),
    grossProfit: 795,
    humanMinutes: 45,
    economicsBasis: 'Playbook prior. Not a quote.',
    paymentRisk: 'UNKNOWN',
    counterpartyRisk: 'MODERATE',
    complianceGaps: [],
    missingInfo: ['a named decision-maker'],
    nextAction: 'Call the operator to confirm the opening date.',
    now: NOW,
  });

  it('has every required part', () => {
    expect(thesisGaps(thesis)).toEqual([]);
  });

  it('keeps the source’s facts apart from our conclusion', () => {
    // The whole discipline in one assertion: external evidence is theirs, the
    // likely need is ours, and the need says so in words.
    expect(thesis.externalEvidence[0]).toMatch(/licence start date/i);
    expect(thesis.likelyNeed).toMatch(/our inference from the event, not something they have said/i);
    expect(thesis.needIsConfirmed).toBe(false);
  });

  it('says why now, with the window’s closing date', () => {
    expect(thesis.whyNow).toMatch(/window closes 2026-08-30/);
  });

  it('names a stakeholder to ask for rather than "the decision-maker"', () => {
    expect(thesis.likelyStakeholder).toMatch(/owner or general manager/i);
  });

  it('gathers the uncertainties instead of scattering them', () => {
    expect(thesis.uncertainties.join(' ')).toMatch(/whether or how this buyer pays|nothing is known/i);
    expect(thesis.uncertainties.join(' ')).toMatch(/inferred/i);
  });

  it('states profit per hour of attention, not just profit', () => {
    expect(thesis.economics).toMatch(/per hour of attention/i);
    expect(thesis.economics).toMatch(/not a quote/i);
  });

  it('reports a missing thesis as missing', () => {
    expect(thesisGaps(null)).toEqual(['no thesis has been written']);
  });
});

describe('award events are prime evidence, not buyer demand', () => {
  it('records the prime and the place of performance separately', () => {
    const event = toAwardEvent({
      'Award ID': 'W912-26-C-0042',
      'Recipient Name': 'Continental Facility Services',
      'Start Date': '2026-08-01',
      'End Date': '2027-07-31',
      'Award Amount': '480000',
      'Place of Performance State Code': 'IL',
      'Recipient Location State Code': 'GA',
      'Awarding Agency': 'General Services Administration',
      'generated_internal_id': 'CONT_AWD_X',
    })!;

    expect(event.type).toBe('CONTRACT_AWARD');
    expect(event.parties.find((p) => p.role === 'PRIME_CONTRACTOR')?.name).toBe('Continental Facility Services');
    // Never a BUYER. A prime that won cleaning work does not need cleaning.
    expect(event.parties.some((p) => p.role === 'BUYER')).toBe(false);
    expect(event.stateCode).toBe('IL');
    expect(event.confirmedFacts.join(' ')).toMatch(/registered state: GA/);
  });

  it('drops an award with no start date', () => {
    expect(
      toAwardEvent({ 'Award ID': 'X', 'Recipient Name': 'Someone', 'Place of Performance State Code': 'IL' }),
    ).toBeNull();
  });
});
