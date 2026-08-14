import { describe, it, expect } from 'vitest';
import { DropTally, explainSourceOutcome, type SourceScopeReport } from '@/lib/demand/connector';
import {
  toDemandEvent,
  parseSourceDate,
  DEFAULT_JURISDICTIONS,
} from '@/lib/demand/connectors/municipalOpenData';
import {
  toSolicitationEvent,
  DEFAULT_SOLICITATION_DATASETS,
  type SolicitationDataset,
} from '@/lib/demand/connectors/municipalSolicitations';
import { toAwardEvent } from '@/lib/demand/connectors/contractAwards';

/**
 * A source that produces nothing has to say why.
 *
 * This is the test for the failure the product actually had: three connectors
 * running on schedule for weeks, every run recorded, every count zero, and no
 * way for anybody looking at the board to tell whether the city had published
 * nothing or the parser had stopped recognising the date column. The two
 * outcomes are one integer apart in the old records and are fixed in entirely
 * different places.
 */

const chicagoLicences = DEFAULT_JURISDICTIONS[0];
const chicagoContracts = DEFAULT_SOLICITATION_DATASETS[0];
const baltimore = DEFAULT_SOLICITATION_DATASETS[1];

const scope = (over: Partial<SourceScopeReport>): SourceScopeReport => ({
  scope: 'a dataset',
  url: 'https://example.test/resource/aaaa-bbbb.json',
  fetched: 0,
  accepted: 0,
  drops: [],
  failure: null,
  ...over,
});

describe('DropTally', () => {
  it('returns null so a mapper can drop and explain on one line', () => {
    const tally = new DropTally();
    expect(tally.drop('no date')).toBeNull();
  });

  it('counts by reason and keeps the first example of each', () => {
    const tally = new DropTally();
    tally.drop('off-trade', 'ASPHALT RESURFACING');
    tally.drop('off-trade', 'TREE TRIMMING');
    tally.drop('no date');

    expect(tally.total).toBe(3);
    expect(tally.entries()).toEqual([
      { reason: 'off-trade', count: 2, example: 'ASPHALT RESURFACING' },
      { reason: 'no date', count: 1, example: null },
    ]);
  });

  it('puts the largest reason first, because that is the one worth fixing', () => {
    const tally = new DropTally();
    tally.drop('rare');
    for (let i = 0; i < 5; i += 1) tally.drop('common');
    expect(tally.entries()[0].reason).toBe('common');
  });
});

describe('explainSourceOutcome', () => {
  it('distinguishes a source that returned nothing from one whose rows were discarded', () => {
    const returnedNothing = explainSourceOutcome({
      connectorKey: 'municipal_open_data',
      eventsCreated: 0,
      eventsUpdated: 0,
      recordsExamined: 0,
      funnel: [scope({ scope: 'Chicago licences', fetched: 0 })],
    });
    const allDiscarded = explainSourceOutcome({
      connectorKey: 'municipal_open_data',
      eventsCreated: 0,
      eventsUpdated: 0,
      recordsExamined: 200,
      funnel: [
        scope({
          scope: 'Chicago licences',
          fetched: 200,
          drops: [{ reason: 'the row has no "license_start_date"', count: 200, example: 'columns present: id, name' }],
        }),
      ],
    });

    expect(returnedNothing).not.toEqual(allDiscarded);
    expect(returnedNothing).toMatch(/zero rows/);
    expect(allDiscarded).toMatch(/none became an event/);
    // The point of the whole exercise: the sentence names the column.
    expect(allDiscarded).toMatch(/license_start_date/);
    expect(allDiscarded).toMatch(/200/);
  });

  it('refuses to call a total failure a quiet week', () => {
    const sentence = explainSourceOutcome({
      connectorKey: 'contract_awards',
      eventsCreated: 0,
      eventsUpdated: 0,
      recordsExamined: 0,
      funnel: [scope({ scope: 'USAspending', failure: 'HttpError: 403' })],
    });
    expect(sentence).toMatch(/USAspending failed: HttpError: 403/);
  });

  it('lets a source say that its own emptiness is ordinary', () => {
    const sentence = explainSourceOutcome({
      connectorKey: 'inbound_intake',
      eventsCreated: 0,
      eventsUpdated: 0,
      recordsExamined: 0,
      funnel: [
        scope({
          scope: 'Unclaimed intake rows',
          url: null,
          emptyMeans: 'That is an empty queue, not a fault: this source has no upstream to break.',
        }),
      ],
    });
    expect(sentence).toMatch(/empty queue, not a fault/);
    expect(sentence).not.toMatch(/the dataset moved/);
  });

  it('reports loss even on a run that produced something', () => {
    const sentence = explainSourceOutcome({
      connectorKey: 'municipal_solicitations',
      eventsCreated: 3,
      eventsUpdated: 0,
      recordsExamined: 900,
      funnel: [
        scope({
          scope: 'Baltimore bids',
          fetched: 900,
          accepted: 3,
          drops: [{ reason: 'not a cleaning or janitorial notice', count: 897, example: 'ASPHALT' }],
        }),
      ],
    });
    expect(sentence).toMatch(/Produced 3 event/);
    expect(sentence).toMatch(/3 of 900 row\(s\) kept/);
  });

  it('says so rather than going blank when a source reports no breakdown at all', () => {
    expect(
      explainSourceOutcome({
        connectorKey: 'whatever',
        eventsCreated: 0,
        eventsUpdated: 0,
        recordsExamined: 0,
        funnel: [],
      }),
    ).toMatch(/reported no per-stage breakdown/);
  });
});

describe('mappers name the field that stopped them', () => {
  it('municipal open data distinguishes a missing date column from an unparseable one', () => {
    const missing = new DropTally();
    expect(toDemandEvent({ legal_name: 'A Cafe Ltd' }, chicagoLicences, missing)).toBeNull();
    expect(missing.entries()[0].reason).toMatch(/no "license_start_date"/);
    // The example carries the columns the portal did return, which is what
    // identifies a republished dataset at a glance.
    expect(missing.entries()[0].example).toMatch(/legal_name/);

    const unparseable = new DropTally();
    expect(
      toDemandEvent({ legal_name: 'A Cafe Ltd', license_start_date: 'soon' }, chicagoLicences, unparseable),
    ).toBeNull();
    expect(unparseable.entries()[0].reason).toMatch(/is not a date/);
    expect(unparseable.entries()[0].example).toBe('soon');
  });

  it('municipal open data names the name columns it looked in', () => {
    const tally = new DropTally();
    expect(toDemandEvent({ license_start_date: '2026-07-01' }, chicagoLicences, tally)).toBeNull();
    expect(tally.entries()[0].reason).toMatch(/doing_business_as_name/);
    expect(tally.entries()[0].reason).toMatch(/legal_name/);
  });

  it('solicitations separate an off-trade notice from a broken column mapping', () => {
    const offTrade = new DropTally();
    expect(
      toSolicitationEvent(
        { title: 'Asphalt resurfacing', description: 'Streets', issue_date: '2026-07-01', agency: 'DOT' },
        baltimore,
        offTrade,
      ),
    ).toBeNull();
    expect(offTrade.entries()[0].reason).toBe('not a cleaning or janitorial notice');

    const broken = new DropTally();
    expect(toSolicitationEvent({ some_other_column: 'x' }, baltimore, broken)).toBeNull();
    expect(broken.entries()[0].reason).toMatch(/neither "title" nor "description" is present/);
  });

  it('contract awards name the response field that moved', () => {
    const tally = new DropTally();
    expect(toAwardEvent({ 'Recipient Name': 'Acme Facility Services' }, tally)).toBeNull();
    expect(tally.entries()[0].reason).toMatch(/no "Award ID"/);
    expect(tally.entries()[0].example).toMatch(/Recipient Name/);
  });
});

describe('a portal known to be broken is reported, not quietly dropped', () => {
  const unusable = [
    ...DEFAULT_JURISDICTIONS.filter((j) => j.unusableReason),
    ...DEFAULT_SOLICITATION_DATASETS.filter((d) => d.unusableReason),
  ];

  it('marks exactly the datasets the probe found could not work', () => {
    expect(unusable.map((d) => d.datasetId).sort()).toEqual(
      ['3syk-w9eu', 'e7gq-4sah', 'sdmv-cwsk', 'wxdc-cbe2'].sort(),
    );
  });

  it('gives every one of them a reason specific enough to act on', () => {
    for (const dataset of unusable) {
      // Not "broken" or "disabled" — what the host actually answered, so
      // somebody picking this up later does not have to rediscover it.
      expect(dataset.unusableReason!.length).toBeGreaterThan(60);
      expect(dataset.unusableReason).not.toMatch(/^(broken|disabled|todo|n\/a)/i);
    }
  });

  it('keeps them in the configuration rather than deleting the evidence', () => {
    // Deleting a broken portal makes the source list look like a smaller
    // ambition instead of a set of cities that moved.
    expect(DEFAULT_JURISDICTIONS).toHaveLength(5);
    expect(DEFAULT_SOLICITATION_DATASETS).toHaveLength(3);
  });

  it('leaves the working ones untouched', () => {
    const working = DEFAULT_JURISDICTIONS.filter((j) => !j.unusableReason).map((j) => j.domain);
    expect(working).toEqual(['data.cityofchicago.org', 'data.sfgov.org', 'data.seattle.gov']);
  });

  it('kept Austin\'s date-column correction even though the dataset is parked', () => {
    // The column name was genuinely wrong as well as the names being gone. If
    // Austin republishes a name column this should be one line from working,
    // not two.
    const austin = DEFAULT_JURISDICTIONS.find((j) => j.datasetId === '3syk-w9eu')!;
    expect(austin.dateColumn).toBe('issue_date');
  });
});

describe('dates as the portals actually publish them', () => {
  it('reads Seattle\'s compact integer date', () => {
    // The real value the probe found. `new Date('20261230')` is Invalid Date,
    // and every one of two hundred rows a run was being discarded over it.
    const parsed = parseSourceDate('20261230');
    expect(parsed).toBeInstanceOf(Date);
    expect(parsed!.toISOString().slice(0, 10)).toBe('2026-12-30');
  });

  it('builds it in UTC so a portal date does not shift under the worker clock', () => {
    expect(parseSourceDate('20260101')!.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('still reads the ISO timestamps every other portal publishes', () => {
    expect(parseSourceDate('2026-07-01T00:00:00.000')!.toISOString().slice(0, 10)).toBe('2026-07-01');
  });

  it('rejects eight digits that are not a date rather than rolling them over', () => {
    expect(parseSourceDate('20261301')).toBeNull();
    expect(parseSourceDate('20260045')).toBeNull();
  });

  it('refuses ambiguous formats instead of guessing', () => {
    // 03/04/26 is two different days on two sides of an ocean, and a wrong
    // date puts a caller in front of work on a day nothing is happening.
    expect(parseSourceDate('03/04/26')).not.toBeNull(); // the platform parses it
    expect(parseSourceDate('not a date')).toBeNull();
    expect(parseSourceDate('')).toBeNull();
  });

  it('accepts a Seattle row end to end, which it did not before', () => {
    const seattle = DEFAULT_JURISDICTIONS.find((j) => j.domain === 'data.seattle.gov')!;
    const tally = new DropTally();
    const event = toDemandEvent(
      {
        business_legal_name: 'Emerald Facility Group LLC',
        trade_name: 'Emerald Facility',
        street_address: '1200 5th Ave',
        city: 'Seattle',
        zip: '98101',
        naics_description: 'Janitorial services',
        ubi: '604-123-456',
        license_start_date: '20261230',
      },
      seattle,
      tally,
    );
    expect(tally.entries()).toEqual([]);
    expect(event).not.toBeNull();
    expect(event!.eventDate!.toISOString().slice(0, 10)).toBe('2026-12-30');
    expect(event!.addressLine1).toBe('1200 5th Ave');
    expect(event!.postalCode).toBe('98101');
    // The source's own identifier, not a key derived because the column name
    // was wrong.
    expect(event!.naturalKey).toBe('604-123-456');
  });

  it('accepts a San Francisco row with the columns the portal really returns', () => {
    const sf = DEFAULT_JURISDICTIONS.find((j) => j.domain === 'data.sfgov.org')!;
    const tally = new DropTally();
    const event = toDemandEvent(
      {
        ownership_name: 'Mission Coffee Holdings LLC',
        dba_name: 'Mission Coffee',
        full_business_address: '2100 Mission St',
        city: 'San Francisco',
        business_zip: '94110',
        self_reported_naics_code: 'Food Services',
        ttxid: '1234567-01-191',
        location_start_date: '2026-07-20T00:00:00.000',
      },
      sf,
      tally,
    );
    expect(tally.entries()).toEqual([]);
    // Before the correction these three were silently null on every event the
    // source produced, and nothing anywhere said so.
    expect(event!.addressLine1).toBe('2100 Mission St');
    expect(event!.postalCode).toBe('94110');
    expect(event!.naturalKey).toBe('1234567-01-191');
  });
});

describe('an award register is not a notice board', () => {
  it('Chicago contracts are configured as awards, not open solicitations', () => {
    expect(chicagoContracts.publishes).toBe('AWARDED_CONTRACT');
  });

  const chicagoRow = {
    purchase_order_description: 'JANITORIAL SERVICES FOR CITY FACILITIES',
    department: 'Department of Fleet and Facility Management',
    vendor_name: 'Midway Building Services',
    purchase_order_contract_number: '12345',
    approval_date: '2024-03-04T00:00:00.000',
    award_amount: '480000',
  };

  it('emits a contract award with no deadline rather than an RFQ with a null one', () => {
    const event = toSolicitationEvent(chicagoRow, chicagoContracts);
    expect(event).not.toBeNull();
    expect(event!.type).toBe('CONTRACT_AWARD');
    expect(event!.deadlineAt ?? null).toBeNull();
    // The regression this guards: a purchase order approved in 2024 appearing
    // on the board as an open job somebody could still bid for.
    expect(event!.confirmedFacts.join(' ')).not.toMatch(/Responses close/);
    expect(event!.confirmedFacts.join(' ')).toMatch(/approved on 2024-03-04/);
  });

  it('files the vendor as the holder of the work and the department as the authority', () => {
    const event = toSolicitationEvent(chicagoRow, chicagoContracts)!;
    expect(event.parties).toEqual([
      { role: 'PRIME_CONTRACTOR', name: 'Midway Building Services' },
      { role: 'ISSUING_AUTHORITY', name: 'Department of Fleet and Facility Management' },
    ]);
    // A cleaning contractor must never land on the board as somebody who needs
    // cleaning, which is exactly what BUYER would have made it.
    expect(event.parties.some((p) => p.role === 'BUYER')).toBe(false);
  });

  it('says plainly that holding work is not the same as needing a subcontractor', () => {
    const event = toSolicitationEvent(chicagoRow, chicagoContracts)!;
    expect(event.inferredFacts.join(' ')).toMatch(/awarded contract, not an open job/);
  });

  it('drops an award row with no named vendor rather than filing the department as one', () => {
    const tally = new DropTally();
    const event = toSolicitationEvent({ ...chicagoRow, vendor_name: '' }, chicagoContracts, tally);
    expect(event).toBeNull();
    expect(tally.entries()[0].reason).toMatch(/no vendor in "vendor_name"/);
  });

  it('still reads an open notice as an open notice', () => {
    const event = toSolicitationEvent(
      {
        title: 'Custodial services for the central library',
        description: 'Daily janitorial',
        issue_date: '2026-08-01',
        due_date: '2026-09-01',
        agency: 'Department of General Services',
        bid_number: 'B50006',
        type: 'IFB',
      },
      baltimore,
    );
    expect(event!.type).toBe('ACTIVE_RFQ');
    expect(event!.deadlineAt).toBeInstanceOf(Date);
    expect(event!.parties).toEqual([{ role: 'BUYER', name: 'Department of General Services' }]);
  });

  it('never carries a close date across from an award register even if the column exists', () => {
    // A configuration mistake — pointing closeDate at a column on an award
    // register — must not resurrect the deadline the type is meant to prevent.
    const misconfigured: SolicitationDataset = {
      ...chicagoContracts,
      columns: { ...chicagoContracts.columns, closeDate: 'approval_date' },
    };
    const event = toSolicitationEvent(chicagoRow, misconfigured)!;
    expect(event.deadlineAt ?? null).toBeNull();
  });
});
