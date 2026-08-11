import { describe, expect, it } from 'vitest';
import {
  ACTIVE_DEMAND_EVENTS,
  assertTierEligibility,
  assessEventIdentity,
  assessExpiry,
  eventDedupeKey,
} from '@/lib/demand/events';
import { playbooksFor, windowFor } from '@/lib/demand/playbooks';
import { assessFriction, qualifiesForLowFrictionQueue, UNKNOWN_SIGNALS } from '@/lib/demand/friction';
import { chooseStructure, estimateEconomics, meetsEconomicFloor } from '@/lib/demand/economics';
import { toDemandEvent, type JurisdictionDataset } from '@/lib/demand/connectors/municipalOpenData';
import { parseIntake } from '@/lib/demand/connectors/inboundIntake';
import type { RawDemandEvent } from '@/lib/demand/events';

/**
 * The acceptance cases.
 *
 * Each one is a situation the operator named, and each is a way the previous
 * model got it wrong. These test the rules, not the plumbing — the plumbing is
 * exercised against real Postgres by `scripts/demandAudit.ts`, because a
 * fixture cannot prove that a pipeline writes what it says it writes.
 */

const NOW = new Date('2026-08-11T12:00:00Z');
const DAY = 86_400_000;
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);
const ahead = (d: number) => new Date(NOW.getTime() + d * DAY);

// ---------------------------------------------------------------------------
// 1. A directory company with no event
// ---------------------------------------------------------------------------

describe('1. an existing business found in a directory, with no event', () => {
  it('cannot reach tier A or B, because there is no event to reach it with', () => {
    // Google Places proves Planet Fitness exists. Nothing more. There is no
    // DemandEventType that means "was found in a directory", which is the
    // structural reason a directory hit cannot become demand.
    const asIfItTried = assertTierEligibility({
      type: 'CONTRACT_AWARD',
      eventDate: null,
      sourceUrl: 'https://maps.google.com/…',
      sourceRecordId: 'ChIJplanetfitness',
      now: NOW,
    });
    expect(asIfItTried.tier).not.toBe('ACTIVE_DEMAND');
    expect(asIfItTried.tier).not.toBe('STRONG_TRIGGER');
    expect(asIfItTried.blockedBy).toBe('no external event date');
  });

  it('is not low friction merely because nothing bad is known about it', () => {
    const friction = assessFriction({ signals: { ...UNKNOWN_SIGNALS } });
    expect(friction.level).toBe('UNKNOWN_RESEARCH_REQUIRED');
    expect(qualifiesForLowFrictionQueue(friction.level)).toBe(false);
    expect(friction.reason).toMatch(/not knowing is not the same as easy/i);
  });
});

// ---------------------------------------------------------------------------
// 2. An independent gym opening in three weeks
// ---------------------------------------------------------------------------

describe('2. an independent local gym with a verified opening in three weeks', () => {
  const opening: Parameters<typeof assertTierEligibility>[0] = {
    type: 'OCCUPANCY_OR_OPERATING_APPROVAL',
    eventDate: ahead(21),
    sourceUrl: 'https://data.cityofchicago.org/resource/r5kz-chrr.json?license_number=99',
    sourceRecordId: '99',
    now: NOW,
  };

  it('is tier B — an event that creates the need, not a request', () => {
    const tier = assertTierEligibility(opening);
    expect(tier.tier).toBe('STRONG_TRIGGER');
    expect(tier.reason).toMatch(/nobody has asked for anything/i);
  });

  it('produces brokerage and distribution routes, and no subcontracting route', () => {
    const playbooks = playbooksFor('OCCUPANCY_OR_OPERATING_APPROVAL');
    const keys = playbooks.map((p) => p.key);

    expect(keys).toContain('cleaning.brokerage.pre_opening');
    expect(keys).toContain('cleaning.brokerage.recurring');
    expect(keys).toContain('cleaning.distribution.initial_stock');
    expect(keys).toContain('cleaning.distribution.replenishment');

    // The critical negative. An opening is not somebody needing a crew — that
    // requires a prime who holds work and says so.
    expect(playbooks.some((p) => p.route === 'SUBCONTRACTING')).toBe(false);
  });

  it('gives each route a different window measured from the opening date', () => {
    const preOpening = playbooksFor('OCCUPANCY_OR_OPERATING_APPROVAL').find((p) => p.key === 'cleaning.brokerage.pre_opening')!;
    const replenishment = playbooksFor('OCCUPANCY_OR_OPERATING_APPROVAL').find((p) => p.key === 'cleaning.distribution.replenishment')!;

    const pre = windowFor(preOpening, ahead(21))!;
    const repl = windowFor(replenishment, ahead(21))!;

    // The final clean is now; the replenishment conversation is months away.
    expect(pre.closesAt.getTime()).toBeLessThan(repl.opensAt.getTime());
    expect(pre.opensAt.getTime()).toBeLessThan(NOW.getTime());
  });

  it('bases friction on ownership evidence, not on the deal being small', () => {
    const independent = assessFriction({
      signals: {
        ...UNKNOWN_SIGNALS,
        localPurchasingAuthority: true,
        oneTimeTransaction: true,
        standardScope: true,
        formalProcurement: false,
        chainOrEnterpriseControl: false,
        incumbentPresent: false,
        buyerReachable: true,
      },
    });
    expect(independent.level).toBe('LOW');

    const franchise = assessFriction({
      signals: {
        ...UNKNOWN_SIGNALS,
        localPurchasingAuthority: false,
        oneTimeTransaction: true,
        standardScope: true,
        formalProcurement: false,
        chainOrEnterpriseControl: true,
        incumbentPresent: false,
        buyerReachable: true,
      },
    });
    // Same job, same size, same scope. Different buyer, different work.
    expect(franchise.level).not.toBe('LOW');
  });
});

// ---------------------------------------------------------------------------
// 3. An active cleaning RFQ
// ---------------------------------------------------------------------------

describe('3. an active cleaning RFQ', () => {
  it('is tier A and keeps its deadline and buyer', () => {
    const tier = assertTierEligibility({
      type: 'ACTIVE_RFQ',
      eventDate: ago(3),
      deadlineAt: ahead(12),
      sourceUrl: 'https://example.test/rfq/1',
      sourceRecordId: 'rfq-1',
      now: NOW,
    });
    expect(tier.tier).toBe('ACTIVE_DEMAND');
    expect(tier.reason).toMatch(/a buyer is in market/i);
  });

  it('does not reach serious pursuit while nobody can deliver it', () => {
    const playbook = playbooksFor('ACTIVE_RFQ').find((p) => p.key === 'cleaning.brokerage.solicitation')!;
    const economics = estimateEconomics({
      playbook,
      scaleHint: null,
      availableProviders: 0,
      friction: 'MODERATE',
    });
    // No provider means no cost side, so there is no gross profit to claim.
    expect(economics.grossProfit).toBeNull();
    expect(meetsEconomicFloor({ grossProfit: null, humanMinutes: 300, minimumProfitPerHour: 150 }).passes).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4 & 5. Subcontracting requires a request, not an award
// ---------------------------------------------------------------------------

describe('4. a prime contractor explicitly asking for a local cleaning crew', () => {
  it('produces a subcontracting route', () => {
    const playbooks = playbooksFor('SUBCONTRACTOR_REQUEST');
    expect(playbooks.some((p) => p.key === 'cleaning.subcontracting.capacity_request')).toBe(true);
  });

  it('keeps the prime and the provider as different roles', () => {
    const playbook = playbooksFor('SUBCONTRACTOR_REQUEST').find((p) => p.route === 'SUBCONTRACTING')!;
    // We buy from nobody here — the prime is who we sell capacity to.
    expect(playbook.likelyBuyerRoles).toContain('PRIME_CONTRACTOR');
    expect(playbook.requiredEvidence.join(' ')).toMatch(/named prime contractor/i);
    expect(playbook.requiredEvidence.join(' ')).toMatch(/seeking local fulfilment capacity/i);
  });
});

describe('5. a contract award with no evidence of a subcontracting need', () => {
  it('does not produce a subcontracting route', () => {
    // The easiest way to manufacture a pipeline from nothing is to treat every
    // award as somebody needing crews. An award says work was won, not that
    // capacity is short.
    const playbooks = playbooksFor('CONTRACT_AWARD');
    expect(playbooks.some((p) => p.route === 'SUBCONTRACTING')).toBe(false);
  });

  it('is at most a strong trigger', () => {
    const tier = assertTierEligibility({
      type: 'CONTRACT_AWARD',
      eventDate: ago(10),
      sourceUrl: 'https://example.test/award/1',
      sourceRecordId: 'a-1',
      now: NOW,
    });
    expect(tier.tier).toBe('STRONG_TRIGGER');
    expect(ACTIVE_DEMAND_EVENTS).not.toContain('CONTRACT_AWARD');
  });
});

// ---------------------------------------------------------------------------
// 6. Distribution without claiming a standing order
// ---------------------------------------------------------------------------

describe('6. a new facility needing initial supplies', () => {
  it('produces an initial-stock route', () => {
    expect(playbooksFor('FACILITY_OPENING').some((p) => p.key === 'cleaning.distribution.initial_stock')).toBe(true);
  });

  it('does not claim a replenishment order until the place has been operating', () => {
    const replenishment = playbooksFor('FACILITY_OPENING').find((p) => p.key === 'cleaning.distribution.replenishment')!;
    const window = windowFor(replenishment, NOW)!;
    // Opens a month after the event, not on it: offering to replace a supplier
    // they have not used yet is offering to solve a problem they do not have.
    expect(window.opensAt.getTime()).toBeGreaterThan(NOW.getTime());
    expect(replenishment.requiredEvidence.join(' ')).toMatch(/premises are operating/i);
  });
});

// ---------------------------------------------------------------------------
// 7. No source date
// ---------------------------------------------------------------------------

describe('7. a record with no source event date', () => {
  const dataset: JurisdictionDataset = {
    domain: 'data.example.gov',
    datasetId: 'aaaa-bbbb',
    label: 'Example licences',
    eventType: 'OCCUPANCY_OR_OPERATING_APPROVAL',
    state: 'IL',
    dateColumn: 'license_start_date',
    columns: { name: 'legal_name', address: 'address', city: 'city' },
    primaryRole: 'BUYER',
  };

  it('is dropped by the connector rather than dated with our clock', () => {
    const withDate = toDemandEvent(
      { legal_name: 'Apex Fitness', address: '1200 Main St', city: 'Chicago', license_start_date: '2026-08-20' },
      dataset,
    );
    expect(withDate?.eventDate?.toISOString().slice(0, 10)).toBe('2026-08-20');

    const withoutDate = toDemandEvent({ legal_name: 'Apex Fitness', address: '1200 Main St', city: 'Chicago' }, dataset);
    expect(withoutDate).toBeNull();
  });

  it('cannot reach tier A or B if it somehow arrives without one', () => {
    const tier = assertTierEligibility({
      type: 'ACTIVE_RFQ',
      eventDate: null,
      sourceUrl: 'https://example.test/1',
      sourceRecordId: '1',
      now: NOW,
    });
    expect(tier.tier).toBe('PREDICTED_NEED');
    expect(tier.reason).toMatch(/recency is unknown, and unknown is not recent/i);
  });

  it('rejects an intake submission with no event date rather than stamping it', () => {
    // A form submission time is our clock. This is the one rule that does not bend.
    expect(parseIntake({ organisation: 'Apex Gym', summary: 'opening soon' }, 'ev1', null)).toBeNull();
    expect(parseIntake({ organisation: 'Apex Gym', summary: 'opening', eventDate: '2026-09-01' }, 'ev1', null)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8, 9. Missing contact and missing provider are tasks, not rejections
// ---------------------------------------------------------------------------

describe('8 & 9. missing contact and missing provider', () => {
  it('accepts first-party evidence without demanding a link to itself', () => {
    // An operator-recorded event has no URL because we hold the record. The
    // strongest demand this business gets must not fall to tier C for want of
    // a link to a row in our own database.
    const firstParty = assertTierEligibility({
      type: 'SUBCONTRACTOR_REQUEST',
      eventDate: ago(1),
      sourceUrl: null,
      sourceRecordId: 'intake:abc',
      isFirstParty: true,
      now: NOW,
    });
    expect(firstParty.tier).toBe('ACTIVE_DEMAND');

    // An external source still has to link back, because the record lives on
    // somebody else's server and nobody can check an assertion about it.
    const external = assertTierEligibility({
      type: 'SUBCONTRACTOR_REQUEST',
      eventDate: ago(1),
      sourceUrl: null,
      sourceRecordId: 'row-9',
      now: NOW,
    });
    expect(external.tier).toBe('PREDICTED_NEED');
    expect(external.blockedBy).toBe('no durable source reference');
  });

  it('does not let a missing contact destroy a real event', () => {
    // The event stands. Finding somebody to call is the work.
    const tier = assertTierEligibility({
      type: 'ACTIVE_RFQ',
      eventDate: ago(2),
      sourceUrl: 'https://example.test/1',
      sourceRecordId: '1',
      now: NOW,
    });
    expect(tier.tier).toBe('ACTIVE_DEMAND');
  });

  it('reports no economics rather than a confident zero when no provider exists', () => {
    const playbook = playbooksFor('FACILITY_OPENING')[0];
    const economics = estimateEconomics({ playbook, scaleHint: null, availableProviders: 0, friction: 'LOW' });
    expect(economics.grossProfit).toBeNull();
    expect(economics.basis).toMatch(/no provider can price this yet/i);
    // The human cost is still known, so the sourcing task can be prioritised.
    expect(economics.humanMinutes).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 10. Expiry
// ---------------------------------------------------------------------------

describe('10. an expired solicitation', () => {
  it('expires with a named reason once its deadline passes', () => {
    const verdict = assessExpiry({ type: 'ACTIVE_RFQ', eventDate: ago(20), deadlineAt: ago(2), now: NOW });
    expect(verdict.expired).toBe(true);
    expect(verdict.reason).toMatch(/deadline passed on/i);
  });

  it('expires a request that outlived its window even with no published deadline', () => {
    expect(assessExpiry({ type: 'ACTIVE_RFQ', eventDate: ago(60), now: NOW }).expired).toBe(true);
    // Triggers last longer, because their consequences do.
    expect(assessExpiry({ type: 'FACILITY_OPENING', eventDate: ago(60), now: NOW }).expired).toBe(false);
  });

  it('does not expire a forward-dated event', () => {
    expect(assessExpiry({ type: 'FACILITY_OPENING', eventDate: ahead(21), now: NOW }).expired).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 11. Tier A and high friction together
// ---------------------------------------------------------------------------

describe('11. a formal solicitation with heavy requirements', () => {
  it('is tier A demand and high friction at the same time', () => {
    const tier = assertTierEligibility({
      type: 'ACTIVE_RFP',
      eventDate: ago(5),
      deadlineAt: ahead(20),
      sourceUrl: 'https://sam.gov/opp/x/view',
      sourceRecordId: 'x',
      now: NOW,
    });
    expect(tier.tier).toBe('ACTIVE_DEMAND');

    const friction = assessFriction({
      signals: {
        ...UNKNOWN_SIGNALS,
        formalProcurement: true,
        vendorOnboarding: true,
        heavyCompliance: true,
        localPurchasingAuthority: false,
        standardScope: true,
        oneTimeTransaction: false,
        buyerReachable: false,
      },
      humanMinutes: 300,
    });
    expect(friction.level).toBe('HIGH');
    expect(qualifiesForLowFrictionQueue(friction.level)).toBe(false);
  });

  it('routes low-margin high-friction work to a referral rather than carrying it', () => {
    const choice = chooseStructure({
      route: 'BROKERAGE',
      primeHoldsWork: false,
      canContractWithBuyer: true,
      involvesGoods: false,
      friction: 'HIGH',
      grossProfit: 600,
      blockingCompliance: null,
    });
    expect(choice.structure).toBe('REFERRAL');
    expect(choice.reason).toMatch(/costs more than the margin justifies/i);
  });
});

// ---------------------------------------------------------------------------
// 12. Duplicate events across sources
// ---------------------------------------------------------------------------

describe('12. one event described by several sources', () => {
  it('collapses on a source-issued identifier', () => {
    const a = eventDedupeKey({
      connector: 'municipal_open_data',
      sourceRecordId: 'row-1',
      naturalKey: 'LIC-2026-4412',
      type: 'OCCUPANCY_OR_OPERATING_APPROVAL',
      eventDate: ahead(21),
      parties: [{ role: 'BUYER', name: 'Apex Fitness' }],
    });
    const b = eventDedupeKey({
      connector: 'inbound_intake',
      sourceRecordId: 'intake-9',
      naturalKey: 'lic 2026 4412',
      type: 'OCCUPANCY_OR_OPERATING_APPROVAL',
      eventDate: ahead(21),
      parties: [{ role: 'BUYER', name: 'Apex Fitness Inc' }],
    });
    expect(a.key).toBe(b.key);
    expect(a.basis).toBe('natural');
  });

  it('collapses on organisation, address and date agreeing', () => {
    const common = {
      type: 'FACILITY_OPENING' as const,
      eventDate: ahead(14),
      addressLine1: '1200 Main St',
      cityName: 'Dallas',
      parties: [{ role: 'BUYER' as const, name: 'Apex Fitness' }],
    };
    const a = eventDedupeKey({ connector: 'a', sourceRecordId: '1', ...common });
    const b = eventDedupeKey({ connector: 'b', sourceRecordId: '2', ...common });
    expect(a.key).toBe(b.key);
    expect(a.basis).toBe('org_address_date');
  });

  it('does not collapse two openings at different addresses', () => {
    const a = eventDedupeKey({
      connector: 'a', sourceRecordId: '1', type: 'FACILITY_OPENING', eventDate: ahead(14),
      addressLine1: '1200 Main St', cityName: 'Dallas', parties: [{ role: 'BUYER', name: 'Anytime Fitness' }],
    });
    const b = eventDedupeKey({
      connector: 'a', sourceRecordId: '2', type: 'FACILITY_OPENING', eventDate: ahead(14),
      addressLine1: '4400 Elm St', cityName: 'Dallas', parties: [{ role: 'BUYER', name: 'Anytime Fitness' }],
    });
    // Same brand, same city, same day. Two real gyms.
    expect(a.key).not.toBe(b.key);
  });

  it('quarantines rather than guessing when there is nothing to identify it by', () => {
    const verdict = assessEventIdentity({
      parties: [{ role: 'BUYER', name: 'Apex Fitness' }],
      eventDate: null,
      cityName: 'Dallas',
      dedupeBasis: 'source_record',
    });
    expect(verdict.quarantined).toBe(true);
    expect(verdict.reason).toMatch(/would be a guess/i);
  });
});

// ---------------------------------------------------------------------------
// 14. Search anchor is never the business location
// ---------------------------------------------------------------------------

describe('14. the source location wins over any search scope', () => {
  const dataset: JurisdictionDataset = {
    domain: 'data.cityofchicago.org',
    datasetId: 'r5kz-chrr',
    label: 'Chicago business licences',
    eventType: 'OCCUPANCY_OR_OPERATING_APPROVAL',
    state: 'IL',
    dateColumn: 'license_start_date',
    columns: { name: 'legal_name', address: 'address', city: 'city', zip: 'zip_code' },
    primaryRole: 'BUYER',
  };

  it('uses the row’s own city, and leaves it null when the row has none', () => {
    const withCity = toDemandEvent(
      { legal_name: 'Apex', address: '1 Main St', city: 'Evanston', license_start_date: '2026-08-01' },
      dataset,
    );
    // The dataset is Chicago's. The business is in Evanston. The row wins.
    expect(withCity?.cityName).toBe('Evanston');

    const withoutCity = toDemandEvent(
      { legal_name: 'Apex', address: '1 Main St', license_start_date: '2026-08-01' },
      dataset,
    );
    expect(withoutCity?.cityName).toBeNull();
    // The state is a property of the jurisdiction's dataset, not a search scope.
    expect(withoutCity?.stateCode).toBe('IL');
  });

  it('never emits a jurisdiction name as a city', () => {
    const event = toDemandEvent(
      { legal_name: 'Apex', address: '1 Main St', city: '633', license_start_date: '2026-08-01' },
      dataset,
    );
    // A house number in a city column is discarded, not displayed.
    expect(event?.cityName).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 15. A directory-only dataset
// ---------------------------------------------------------------------------

describe('15. sources that only prove existence', () => {
  it('has no event type meaning "exists in a directory"', () => {
    // The structural guarantee. There is no way to express directory
    // membership as an event, so no playbook can fire on one.
    const allTypes = [...ACTIVE_DEMAND_EVENTS];
    expect(allTypes.some((t) => /DIRECTORY|LISTING|CATEGORY/i.test(t))).toBe(false);
  });

  it('fires no playbook for an event type nothing covers', () => {
    // Contract awards are ingested as evidence of a prime. Nothing sells from
    // one on its own, and the empty result is the correct answer.
    expect(playbooksFor('CONTRACT_AWARD')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: connector output contract
// ---------------------------------------------------------------------------

describe('connector output preserves what the source said', () => {
  const dataset: JurisdictionDataset = {
    domain: 'data.austintexas.gov',
    datasetId: '3syk-w9eu',
    label: 'Austin issued construction permits',
    eventType: 'RENOVATION_OR_CONSTRUCTION',
    state: 'TX',
    dateColumn: 'issued_date',
    columns: {
      name: 'applicant_organization',
      address: 'original_address1',
      city: 'original_city',
      description: 'description',
      naturalKey: 'permit_number',
      scale: 'total_new_add_sqft',
      applicant: 'contractor_company_name',
    },
    primaryRole: 'APPLICANT',
  };

  const row = {
    applicant_organization: 'Riverside Holdings',
    contractor_company_name: 'BuildRight Construction',
    original_address1: '900 E 5th St',
    original_city: 'Austin',
    description: 'Interior finish-out for new fitness studio',
    permit_number: 'BP-2026-77123',
    total_new_add_sqft: '5200',
    issued_date: '2026-07-28T00:00:00.000',
  };

  it('keeps the source date, identifier and a link back to the record', () => {
    const event = toDemandEvent(row, dataset)!;
    expect(event.eventDate?.toISOString().slice(0, 10)).toBe('2026-07-28');
    expect(event.naturalKey).toBe('BP-2026-77123');
    expect(event.sourceUrl).toContain('data.austintexas.gov');
    expect(event.sourceUrl).toContain('BP-2026-77123');
  });

  it('separates the contractor from the organisation the permit is for', () => {
    // Filing a construction permit's contractor as the buyer would put a
    // building firm on the board as somebody who needs cleaning.
    const event = toDemandEvent(row, dataset)!;
    const roles = Object.fromEntries(event.parties.map((p) => [p.name, p.role]));
    expect(roles['Riverside Holdings']).toBe('APPLICANT');
    expect(roles['BuildRight Construction']).toBe('APPLICANT');
  });

  it('states what the source said and infers nothing', () => {
    const event = toDemandEvent(row, dataset)!;
    expect(event.inferredFacts).toEqual([]);
    expect(event.confirmedFacts.join(' ')).toContain('Interior finish-out for new fitness studio');
    expect(event.confirmedFacts.join(' ')).toContain('BP-2026-77123');
  });

  it('carries the scale figure without turning it into a price', () => {
    const event = toDemandEvent(row, dataset)!;
    expect(event.confirmedFacts.join(' ')).toMatch(/5,200/);
    // A large permit does not licence a large deal: the estimate stays inside
    // the playbook's band.
    const playbook = playbooksFor('RENOVATION_OR_CONSTRUCTION')[0];
    const economics = estimateEconomics({ playbook, scaleHint: 5200, availableProviders: 3, friction: 'LOW' });
    expect(economics.buyerPrice!).toBeLessThanOrEqual(playbook.typicalBuyerPrice.high);
    expect(economics.buyerPrice!).toBeGreaterThanOrEqual(playbook.typicalBuyerPrice.low);
  });
});

describe('economics never present a prior as a quote', () => {
  it('says where every number came from', () => {
    const playbook = playbooksFor('FACILITY_OPENING')[0];
    const economics = estimateEconomics({ playbook, scaleHint: null, availableProviders: 4, friction: 'LOW' });
    expect(economics.basis).toMatch(/not a quote/i);
    expect(economics.basis).toMatch(/no provider has priced this/i);
  });

  it('charges friction to the human-time estimate', () => {
    const playbook = playbooksFor('FACILITY_OPENING')[0];
    const easy = estimateEconomics({ playbook, scaleHint: null, availableProviders: 4, friction: 'LOW' });
    const hard = estimateEconomics({ playbook, scaleHint: null, availableProviders: 4, friction: 'HIGH' });
    expect(hard.humanMinutes).toBeGreaterThan(easy.humanMinutes);
    // Same gross profit, worse rate. That is the whole point of the measure.
    expect(hard.profitPerHumanHour!).toBeLessThan(easy.profitPerHumanHour!);
  });

  it('treats unknown friction as expensive rather than cheap', () => {
    const playbook = playbooksFor('FACILITY_OPENING')[0];
    const unknown = estimateEconomics({ playbook, scaleHint: null, availableProviders: 4, friction: 'UNKNOWN_RESEARCH_REQUIRED' });
    const low = estimateEconomics({ playbook, scaleHint: null, availableProviders: 4, friction: 'LOW' });
    expect(unknown.humanMinutes).toBeGreaterThan(low.humanMinutes);
  });
});

describe('commercial structure comes from the evidence', () => {
  it('picks subcontracting only when a prime holds the work', () => {
    expect(
      chooseStructure({
        route: 'BROKERAGE', primeHoldsWork: true, canContractWithBuyer: true, involvesGoods: false,
        friction: 'MODERATE', grossProfit: 3000, blockingCompliance: null,
      }).structure,
    ).toBe('SUBCONTRACTING');

    // A route *named* subcontracting does not make it one.
    expect(
      chooseStructure({
        route: 'SUBCONTRACTING', primeHoldsWork: false, canContractWithBuyer: true, involvesGoods: false,
        friction: 'MODERATE', grossProfit: 3000, blockingCompliance: null,
      }).structure,
    ).toBe('BROKERAGE');
  });

  it('falls back to a referral when compliance blocks us contracting', () => {
    const choice = chooseStructure({
      route: 'BROKERAGE', primeHoldsWork: false, canContractWithBuyer: true, involvesGoods: false,
      friction: 'LOW', grossProfit: 5000, blockingCompliance: 'a state contractor licence we do not hold',
    });
    expect(choice.structure).toBe('REFERRAL');
    expect(choice.rejected.map((r) => r.structure)).toContain('BROKERAGE');
  });
});
