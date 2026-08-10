import { afterEach, describe, expect, it, vi } from 'vitest';
import { SocrataConnector, buildSocrataUrl, readDatasets, toRawRecord, type SocrataDatasetConfig } from '@/lib/discovery/connectors/socrata';
import { GooglePlacesConnector, DEFAULT_PLACE_QUERIES, readQueries, toPlaceRecord, searchAnchors, NATIONAL_ANCHORS, ANCHORS_PER_RUN } from '@/lib/discovery/connectors/googlePlaces';
import { SamGovConnector, readNaics, toSamRecord } from '@/lib/discovery/connectors/samGov';
import { setTransport, resetTransport, resetRateLimits, httpJson, HttpError, MissingCredentialError, readCredential, summariseError } from '@/lib/discovery/http';
import { NppesConnector, geographicPartitions, toNppesRecord, toNppesRecords, readEmitDistribution, maxPartitionsFor, rotatePartitions, US_STATES } from '@/lib/discovery/connectors/nppes';
import { UsaSpendingConnector, placeOfPerformanceFilters, toAwardRecord, formatAwardLocation, chunk, LOCATIONS_PER_REQUEST } from '@/lib/discovery/connectors/usaSpending';
import { assignMarket, METRO_PRESETS } from '@/lib/discovery/markets';
import { planTargets } from '@/lib/discovery/run';
import type { ConnectorContext, MarketContext } from '@/lib/discovery/connector';

/**
 * Connector contract tests.
 *
 * These drive recorded response payloads through the transport seam rather than
 * calling the live APIs. That is a real limitation and worth naming: they prove
 * the connector parses the documented response shape, maps fields to the right
 * columns, files leads on the correct side of a deal and fails safely. They do
 * **not** prove the remote endpoint still returns that shape. Only
 * `npm run discovery:probe`, run somewhere with network access and credentials,
 * proves that.
 */

const MARKET: MarketContext = {
  id: 'mkt_1',
  name: 'Dallas–Fort Worth',
  slug: 'dfw',
  scope: 'METRO',
  state: 'TX',
  states: ['TX'],
  centerLat: 32.7767,
  centerLng: -96.797,
  radiusMeters: 40000,
  postalCodes: [],
  cities: ['Dallas'],
  counties: ['Dallas County'],
  sourceConfig: {},
};

function context(overrides: Partial<ConnectorContext> = {}): ConnectorContext {
  return {
    orgId: 'org_1',
    dataSourceId: 'ds_1',
    config: {},
    maxRecords: 20,
    market: MARKET,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  resetTransport();
  resetRateLimits();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

describe('httpJson', () => {
  it('retries a 500 and succeeds on a later attempt', async () => {
    let calls = 0;
    setTransport(async () => {
      calls += 1;
      return calls < 3 ? jsonResponse({ error: 'boom' }, 500) : jsonResponse({ ok: true });
    });
    const result = await httpJson<{ ok: boolean }>({ url: 'https://example.test/x', attempts: 3 });
    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
  });

  it('does not retry a 400, because the same bad request will fail again', async () => {
    let calls = 0;
    setTransport(async () => {
      calls += 1;
      return jsonResponse({ error: 'bad query' }, 400);
    });
    await expect(httpJson({ url: 'https://example.test/x', attempts: 3 })).rejects.toBeInstanceOf(HttpError);
    expect(calls).toBe(1);
  });

  it('retries a 429, because the source is asking for less traffic rather than refusing', async () => {
    let calls = 0;
    setTransport(async () => {
      calls += 1;
      return calls === 1 ? jsonResponse({}, 429) : jsonResponse({ ok: true });
    });
    await httpJson({ url: 'https://example.test/x', attempts: 2 });
    expect(calls).toBe(2);
  });

  it('never puts the credential value in the error when one is missing', () => {
    vi.stubEnv('SOME_KEY', '');
    try {
      readCredential('SOME_KEY', 'Test source');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(MissingCredentialError);
      expect((error as Error).message).toContain('SOME_KEY');
      expect((error as Error).message).not.toContain('secret');
    }
  });
});

// ---------------------------------------------------------------------------
// Socrata
// ---------------------------------------------------------------------------

const PERMIT_DATASET: SocrataDatasetConfig = {
  domain: 'www.dallasopendata.com',
  datasetId: 'e7gq-4sah',
  label: 'Building permit',
  dateColumn: 'issued_date',
  columns: {
    description: 'work_description',
    address: 'address',
    city: 'city',
    value: 'estimated_cost',
    workType: 'permit_type',
    permitNumber: 'permit_number',
    owner: 'owner_name',
  },
};

describe('Socrata connector', () => {
  it('builds a SoQL query filtered and ordered by the configured date column', () => {
    const url = buildSocrataUrl(PERMIT_DATASET, new Date('2026-06-01T00:00:00Z'), 50);
    // URLSearchParams encodes spaces as '+', which decodeURIComponent leaves alone.
    const readable = decodeURIComponent(url).replace(/\+/g, ' ');
    expect(url).toContain('https://www.dallasopendata.com/resource/e7gq-4sah.json');
    expect(readable).toContain("issued_date >= '2026-06-01T00:00:00'");
    expect(readable).toContain('$order=issued_date DESC');
    expect(readable).toContain('$limit=50');
  });

  it('rejects a column name that could alter the query', () => {
    // Dataset configuration is operator-supplied, so it is untrusted input.
    expect(() =>
      buildSocrataUrl({ ...PERMIT_DATASET, dateColumn: "issued' OR '1'='1" }, new Date(), 10),
    ).toThrow(/Invalid Socrata column name/);
  });

  it('files a permit as a BUYER lead, not a provider', async () => {
    // The party on a permit is the one who will need the building cleaned.
    // Filing them as a provider makes them invisible to matching for ever.
    setTransport(async () =>
      jsonResponse([
        {
          permit_number: 'BP-2026-1188',
          issued_date: '2026-07-20T00:00:00.000',
          permit_type: 'Commercial tenant finish-out',
          work_description: 'Interior finish-out for new dental clinic, 6,400 sq ft',
          address: '1200 Main St',
          city: 'Dallas',
          estimated_cost: '480000',
          owner_name: 'Brightpath Dental Group',
        },
      ]),
    );

    const records = await new SocrataConnector().fetch(
      context({ market: { ...MARKET, sourceConfig: { socrata: [PERMIT_DATASET] } } }),
    );

    expect(records).toHaveLength(1);
    expect(records[0].leadRole).toBe('BUYER');
    expect(records[0].subjectRole).toBe('BUYER');
    expect(records[0].segment).toBe('COMMERCIAL');
    expect(records[0].companyName).toBe('Brightpath Dental Group');
    expect(records[0].requiredService).toBe('Medical facility cleaning');
    expect(records[0].externalId).toBe('BP-2026-1188');
    expect(records[0].whyRelevant).toMatch(/post-construction clean/i);
  });

  it('reports "not configured" rather than an empty run when the market has no dataset', async () => {
    // Distinct from a failure: the source works fine wherever it has a portal.
    // Reporting eight empty runs buried the sources that actually did something.
    let called = false;
    setTransport(async () => {
      called = true;
      return jsonResponse([]);
    });
    await expect(new SocrataConnector().fetch(context())).rejects.toMatchObject({
      name: 'NoConfigurationError',
    });
    expect(called).toBe(false);
  });

  it('returns nothing rather than searching everywhere when there is no market', async () => {
    const records = await new SocrataConnector().fetch(context({ market: null }));
    expect(records).toEqual([]);
  });

  it('fails the run when every dataset fails, rather than reporting a quiet week', async () => {
    // A source that returns nothing and calls itself healthy is indistinguishable
    // from a market with no activity. That is the failure mode worth preventing.
    setTransport(async () => jsonResponse({ error: 'forbidden' }, 403));
    await expect(
      new SocrataConnector().fetch(context({ market: { ...MARKET, sourceConfig: { socrata: [PERMIT_DATASET] } } })),
    ).rejects.toThrow(/All 1 Socrata dataset\(s\) failed/);
  });

  it('survives one dataset failing and still returns the others', async () => {
    const second = { ...PERMIT_DATASET, datasetId: 'aaaa-bbbb', domain: 'data.other.test' };
    setTransport(async (url) =>
      url.includes('aaaa-bbbb')
        ? jsonResponse([{ permit_number: 'X-1', issued_date: '2026-07-01', permit_type: 'Office remodel', work_description: 'Office remodel', owner_name: 'Acme' }])
        : jsonResponse({ error: 'down' }, 500),
    );

    const records = await new SocrataConnector().fetch(
      context({ market: { ...MARKET, sourceConfig: { socrata: [PERMIT_DATASET, second] } } }),
    );
    expect(records).toHaveLength(1);
    expect(records[0].externalId).toBe('X-1');
  });

  it('drops single-family residential work unless the dataset asks for it', () => {
    const row = { permit_number: 'R-1', issued_date: '2026-07-01', permit_type: 'Single family dwelling', work_description: 'New single family dwelling' };
    expect(toRawRecord(row, PERMIT_DATASET, 'Dallas')).toBeNull();
    expect(toRawRecord(row, { ...PERMIT_DATASET, segment: 'RESIDENTIAL' }, 'Dallas')).not.toBeNull();
  });

  it('drops work that creates no cleaning demand', () => {
    const row = { permit_number: 'S-1', issued_date: '2026-07-01', permit_type: 'Sign', work_description: 'Replace pole sign face' };
    expect(toRawRecord(row, PERMIT_DATASET, 'Dallas')).toBeNull();
  });

  it('ignores malformed dataset configuration instead of throwing', () => {
    expect(readDatasets({ socrata: [{ domain: 'x' }] }, {})).toEqual([]);
    expect(readDatasets({}, {})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Google Places
// ---------------------------------------------------------------------------

describe('Google Places connector', () => {
  const place = {
    id: 'ChIJtest123',
    displayName: { text: 'Apex Commercial Cleaning' },
    formattedAddress: '500 Elm St, Dallas, TX 75202',
    addressComponents: [
      { longText: 'Dallas', types: ['locality'] },
      { shortText: 'TX', types: ['administrative_area_level_1'] },
    ],
    primaryType: 'cleaning_service',
    websiteUri: 'https://apexclean.example',
    nationalPhoneNumber: '(214) 555-0142',
    businessStatus: 'OPERATIONAL',
    location: { latitude: 32.78, longitude: -96.8 },
  };

  it('keeps the place ID, which is the only field the terms let us store', () => {
    const record = toPlaceRecord(place, DEFAULT_PLACE_QUERIES[0], 'Dallas');
    expect(record?.externalPlaceId).toBe('ChIJtest123');
    expect(record?.sourceUrl).toContain('place_id:ChIJtest123');
  });

  it('marks a provider query result as a PROVIDER, and a buyer query as a BUYER', () => {
    const provider = toPlaceRecord(place, DEFAULT_PLACE_QUERIES.find((q) => q.leadRole === 'PROVIDER')!, 'Dallas');
    const buyer = toPlaceRecord(place, DEFAULT_PLACE_QUERIES.find((q) => q.leadRole === 'BUYER')!, 'Dallas');
    expect(provider?.leadRole).toBe('PROVIDER');
    expect(buyer?.leadRole).toBe('BUYER');
  });

  it('skips businesses that are not operational', () => {
    expect(toPlaceRecord({ ...place, businessStatus: 'CLOSED_PERMANENTLY' }, DEFAULT_PLACE_QUERIES[0], 'Dallas')).toBeNull();
  });

  it('skips a result with no name or no id', () => {
    expect(toPlaceRecord({ ...place, id: undefined }, DEFAULT_PLACE_QUERIES[0], 'Dallas')).toBeNull();
    expect(toPlaceRecord({ ...place, displayName: undefined }, DEFAULT_PLACE_QUERIES[0], 'Dallas')).toBeNull();
  });

  it('covers all three business paths in its default queries', () => {
    const categories = new Set(DEFAULT_PLACE_QUERIES.map((q) => q.category));
    expect(categories).toEqual(new Set(['BROKERAGE', 'DISTRIBUTION', 'SUBCONTRACTING']));
  });

  it('refuses to run without a credential rather than failing silently', async () => {
    vi.stubEnv('GOOGLE_PLACES_API_KEY', '');
    await expect(new GooglePlacesConnector().fetch(context())).rejects.toBeInstanceOf(MissingCredentialError);
  });

  it('refuses a market with no coordinates, because a radius search needs a centre', async () => {
    vi.stubEnv('GOOGLE_PLACES_API_KEY', 'test-key');
    await expect(
      new GooglePlacesConnector().fetch(context({ market: { ...MARKET, centerLat: null, centerLng: null } })),
    ).rejects.toThrow(/centre coordinates/);
  });

  it('sends the field mask and location bias the API requires', async () => {
    vi.stubEnv('GOOGLE_PLACES_API_KEY', 'test-key');
    const seen: RequestInit[] = [];
    setTransport(async (_url, init) => {
      seen.push(init);
      return jsonResponse({ places: [place] });
    });

    await new GooglePlacesConnector().fetch(
      context({ market: { ...MARKET, sourceConfig: { placeQueries: [DEFAULT_PLACE_QUERIES[0]] } } }),
    );

    const headers = seen[0].headers as Record<string, string>;
    expect(headers['X-Goog-Api-Key']).toBe('test-key');
    expect(headers['X-Goog-FieldMask']).toContain('places.id');
    const body = JSON.parse(String(seen[0].body));
    expect(body.locationBias.circle.center).toEqual({ latitude: 32.7767, longitude: -96.797 });
  });

  it('lets a market replace the query set entirely, which is how it leaves cleaning', () => {
    const custom = [
      { query: 'commercial landscaping', leadRole: 'PROVIDER', companyRole: 'SUBCONTRACTOR', category: 'BROKERAGE', service: 'Landscaping', why: 'Local provider.' },
    ];
    expect(readQueries({ placeQueries: custom }, {})).toHaveLength(1);
    expect(readQueries({ placeQueries: custom }, {})[0].service).toBe('Landscaping');
    // Malformed configuration falls back rather than searching nothing.
    expect(readQueries({ placeQueries: [{ query: 'x' }] }, {})).toEqual(DEFAULT_PLACE_QUERIES);
  });
});

// ---------------------------------------------------------------------------
// SAM.gov
// ---------------------------------------------------------------------------

describe('SAM.gov connector', () => {
  const notice = {
    noticeId: 'abc123',
    title: 'Custodial Services, Building 400',
    solicitationNumber: 'W912-26-R-0042',
    fullParentPathName: 'DEPT OF DEFENSE.DEPT OF THE ARMY',
    postedDate: '2026-07-15',
    type: 'Solicitation',
    naicsCode: '561720',
    responseDeadLine: '2026-08-30T17:00:00-05:00',
    description: 'Recurring custodial services for a 90,000 sq ft facility.',
    uiLink: 'https://sam.gov/opp/abc123/view',
    typeOfSetAsideDescription: 'Total Small Business Set-Aside',
    placeOfPerformance: { city: { name: 'Fort Worth' }, state: { code: 'TX' } },
    pointOfContact: [{ fullName: 'J. Rivera', email: 'j.rivera@example.gov', phone: '555-0100' }],
  };

  it('files the issuing agency as the buyer and the segment as public sector', () => {
    const record = toSamRecord(notice);
    expect(record?.leadRole).toBe('BUYER');
    expect(record?.subjectRole).toBe('BUYER');
    expect(record?.segment).toBe('PUBLIC_SECTOR');
    expect(record?.category).toBe('SUBCONTRACTING');
  });

  it('links to the human notice page rather than the JSON endpoint', () => {
    expect(toSamRecord(notice)?.sourceUrl).toBe('https://sam.gov/opp/abc123/view');
  });

  it('explains that reaching primes is usually faster than bidding directly', () => {
    expect(toSamRecord(notice)?.whyRelevant).toMatch(/subcontractor rather than to bid directly/i);
  });

  it('carries through the published point of contact', () => {
    expect(toSamRecord(notice)?.contact).toEqual({ name: 'J. Rivera', email: 'j.rivera@example.gov', phone: '555-0100' });
  });

  it('skips a notice with no id or title', () => {
    expect(toSamRecord({ ...notice, noticeId: undefined })).toBeNull();
    expect(toSamRecord({ ...notice, title: undefined })).toBeNull();
  });

  it('restricts the search to the market state so results are fulfillable', async () => {
    vi.stubEnv('SAM_GOV_API_KEY', 'test-key');
    let requested = '';
    setTransport(async (url) => {
      requested = url;
      return jsonResponse({ opportunitiesData: [notice] });
    });
    await new SamGovConnector().fetch(context());
    expect(requested).toContain('state=TX');
    expect(requested).toContain('ncode=561720');
  });

  it('falls back to facility-services NAICS codes when configuration is invalid', () => {
    expect(readNaics({ samNaics: ['nope'] }, {})).toContain('561720');
    expect(readNaics({ samNaics: ['238220'] }, {})).toEqual(['238220']);
  });
});

// ---------------------------------------------------------------------------
// Live-vs-fixture honesty
// ---------------------------------------------------------------------------

describe('connector provenance', () => {
  it('marks the real connectors live and nothing else', async () => {
    const { BUILT_IN_CONNECTORS } = await import('@/lib/discovery/connectors');
    const live = BUILT_IN_CONNECTORS.filter((c) => c.isLive).map((c) => c.key).sort();
    expect(live).toEqual([
      'google_places',
      'nppes_healthcare',
      'sam_gov_opportunities',
      'socrata_open_data',
      'usaspending_awards',
    ]);

    // At least two live sources must work nationwide without a credential,
    // or "nationwide" depends on the operator signing up for something.
    const freeNationwide = BUILT_IN_CONNECTORS.filter(
      (c) => c.isLive && c.supportsNationwide && !c.credentialEnvVar,
    ).map((c) => c.key);
    expect(freeNationwide).toContain('nppes_healthcare');
    expect(freeNationwide).toContain('usaspending_awards');

    // Every fixture connector must report itself as not live, or the interface
    // cannot tell fabricated volume from real discovery.
    const fixtures = BUILT_IN_CONNECTORS.filter((c) => !c.isLive);
    expect(fixtures.length).toBeGreaterThan(0);
    expect(fixtures.every((c) => c.isLive === false)).toBe(true);
  });

  it('gives every live connector a terms URL backing its access claim', async () => {
    const { BUILT_IN_CONNECTORS } = await import('@/lib/discovery/connectors');
    for (const connector of BUILT_IN_CONNECTORS.filter((c) => c.isLive)) {
      expect(connector.termsUrl, `${connector.key} has no termsUrl`).toBeTruthy();
      expect(connector.accessBasis.length).toBeGreaterThan(40);
    }
  });
});

// ---------------------------------------------------------------------------
// Nationwide coverage
// ---------------------------------------------------------------------------

describe('nationwide geography', () => {
  const national: MarketContext = { ...MARKET, id: 'mkt_us', name: 'United States', slug: 'us', scope: 'NATIONAL', state: null, states: [], cities: [], counties: [] };

  it('partitions a national NPPES run into one query per state', () => {
    const partitions = geographicPartitions(national);
    expect(partitions).toHaveLength(US_STATES.length);
    expect(partitions[0]).toEqual({ state: 'AL' });
    expect(partitions.some((p) => p.state === 'MT')).toBe(true);
  });

  it('honours an explicit state list instead of sweeping all fifty', () => {
    expect(geographicPartitions({ ...national, states: ['TX', 'IL', 'AZ'] })).toEqual([
      { state: 'TX' },
      { state: 'IL' },
      { state: 'AZ' },
    ]);
  });

  it('queries a metro by its city list, not by its state alone', () => {
    const parts = geographicPartitions({ ...MARKET, scope: 'METRO', cities: ['Dallas', 'Plano'] });
    expect(parts).toEqual([{ city: 'Dallas', state: 'TX' }, { city: 'Plano', state: 'TX' }]);
  });

  it('queries a postal market by postcode', () => {
    expect(geographicPartitions({ ...MARKET, scope: 'POSTAL', postalCodes: ['75201', '75202'] })).toEqual([
      { postal_code: '75201' },
      { postal_code: '75202' },
    ]);
  });

  it('sends USAspending a single request covering every state rather than fifty requests', () => {
    const filters = placeOfPerformanceFilters(national);
    expect(filters).toHaveLength(US_STATES.length);
    expect(filters[0]).toEqual({ country: 'USA', state: 'AL' });
  });

  it('files a USAspending award recipient as a contractor, not the buying agency', () => {
    const record = toAwardRecord(
      {
        'Award ID': 'W912-26-C-0001',
        'Recipient Name': 'National Facility Partners LLC',
        'Award Amount': 4_200_000,
        'Start Date': '2026-04-01',
        'End Date': '2027-03-31',
        'Awarding Sub Agency': 'Dept of the Army',
        'Place of Performance State Code': 'MT',
        generated_internal_id: 'CONT_AWD_1',
      },
      'United States',
    );
    expect(record?.leadRole).toBe('CONTRACTOR');
    expect(record?.subjectRole).toBe('PRIME_CONTRACTOR');
    expect(record?.companyName).toBe('National Facility Partners LLC');
    expect(record?.state).toBe('MT');
    expect(record?.sourceUrl).toContain('usaspending.gov/award/CONT_AWD_1');
    expect(record?.whyRelevant).toMatch(/already won this work/i);
  });

  it('files an NPPES facility as a commercial buyer with its location address', () => {
    const record = toNppesRecord(
      {
        number: 1234567890,
        basic: { organization_name: 'Big Sky Dental PC', status: 'A' },
        addresses: [
          { address_purpose: 'MAILING', city: 'Denver', state: 'CO', telephone_number: '303-555-0100' },
          { address_purpose: 'LOCATION', address_1: '12 Main St', city: 'Bozeman', state: 'MT', postal_code: '597151234', telephone_number: '406-555-0142' },
        ],
        taxonomies: [{ desc: 'Dental', primary: true }],
      },
      'Montana',
    );
    // The mailing address is often a billing company in another state; calling
    // it reaches nobody with authority over the building.
    expect(record?.state).toBe('MT');
    expect(record?.location).toBe('Bozeman, MT');
    expect(record?.contact?.phone).toBe('406-555-0142');
    expect(record?.leadRole).toBe('BUYER');
    expect(record?.sourceUrl).toContain('1234567890');
  });

  it('skips a deactivated NPPES record', () => {
    expect(
      toNppesRecord({ number: 1, basic: { organization_name: 'Closed Clinic', status: 'D' }, addresses: [] }, 'X'),
    ).toBeNull();
  });

  it('routes a nationwide source to the national market once, not once per metro', () => {
    const markets = [
      { id: 'us', scope: 'NATIONAL' as const },
      { id: 'dfw', scope: 'METRO' as const },
      { id: 'chi', scope: 'METRO' as const },
    ];
    const targets = planTargets({ requiresMarket: true, supportsNationwide: true }, null, markets);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.id).toBe('us');
  });

  it('never points a jurisdiction-specific source at the national market', () => {
    const markets = [
      { id: 'us', scope: 'NATIONAL' as const },
      { id: 'dfw', scope: 'METRO' as const },
      { id: 'chi', scope: 'METRO' as const },
    ];
    const targets = planTargets({ requiresMarket: true, supportsNationwide: false }, null, markets);
    expect(targets.map((t) => t?.id)).toEqual(['dfw', 'chi']);
  });

  it('falls back to local markets when no national market is configured', () => {
    const markets = [{ id: 'dfw', scope: 'METRO' as const }];
    expect(planTargets({ requiresMarket: true, supportsNationwide: true }, null, markets).map((t) => t?.id)).toEqual(['dfw']);
  });

  it('re-homes a nationally discovered record onto the narrowest market containing it', () => {
    const markets = [
      { id: 'us', scope: 'NATIONAL' as const, state: null, states: [], cities: [], postalCodes: [] },
      { id: 'tx', scope: 'STATE' as const, state: 'TX', states: ['TX'], cities: [], postalCodes: [] },
      { id: 'dfw', scope: 'METRO' as const, state: 'TX', states: ['TX'], cities: ['Dallas', 'Plano'], postalCodes: [] },
    ];
    // A Dallas record belongs to the Dallas metro, not the sweep that found it.
    expect(assignMarket(markets, { state: 'TX', location: 'Dallas, TX' })?.id).toBe('dfw');
    // A Texas record outside the metro's city list still lands in Texas.
    expect(assignMarket(markets, { state: 'TX', location: 'Lubbock, TX' })?.id).toBe('tx');
    // Anything else falls back to the national market rather than being dropped.
    expect(assignMarket(markets, { state: 'ME', location: 'Bangor, ME' })?.id).toBe('us');
  });

  it('covers multiple states across the metro presets, including non-urban ones', () => {
    const states = new Set(METRO_PRESETS.flatMap((m) => m.states ?? []));
    expect(states.size).toBeGreaterThanOrEqual(6);
    expect(METRO_PRESETS.some((m) => m.kind === 'rural')).toBe(true);
    expect(METRO_PRESETS.some((m) => m.scope === 'STATE')).toBe(true);
    // No market may be privileged in code — Dallas is one row among several.
    expect(METRO_PRESETS.filter((m) => m.isDefault).length).toBe(0);
  });
});

describe('national run budgeting', () => {
  it('caps how many partitions one run touches', () => {
    // 51 states x 5 taxonomies is 255 requests. No serverless run finishes that.
    expect(maxPartitionsFor(60, 5)).toBe(12);
    expect(maxPartitionsFor(10, 5)).toBe(2);
    expect(maxPartitionsFor(1, 5)).toBe(1);
  });

  it('rotates the slice by day so every state is reached over time', () => {
    const states = US_STATES.map((s) => ({ state: s }));
    const day0 = rotatePartitions(states, 12, 0);
    const day1 = rotatePartitions(states, 12, 1);
    expect(day0).toHaveLength(12);
    expect(day0[0]).toEqual({ state: 'AL' });
    expect(day1[0]).not.toEqual(day0[0]);

    // Every state must be reachable within a full cycle, or the far end of the
    // alphabet is never discovered at all.
    const seen = new Set<string>();
    for (let day = 0; day < 60; day++) {
      for (const p of rotatePartitions(states, 12, day)) seen.add(p.state);
    }
    expect(seen.size).toBe(US_STATES.length);
  });

  it('is idempotent within a day', () => {
    const states = US_STATES.map((s) => ({ state: s }));
    expect(rotatePartitions(states, 12, 7)).toEqual(rotatePartitions(states, 12, 7));
  });

  it('wraps around the end of the list without dropping entries', () => {
    const items = [1, 2, 3, 4, 5];
    const slice = rotatePartitions(items, 3, 1);
    expect(slice).toHaveLength(3);
    expect(new Set(slice).size).toBe(3);
  });

  it('emits both a service lead and a consumables lead per facility', () => {
    // The same clinic buys the cleaning contract and the gloves. Different
    // budgets, different cycles — collapsing them loses the distribution path.
    const records = toNppesRecords(
      {
        number: 1234567890,
        basic: { organization_name: 'Big Sky Dental PC', status: 'A' },
        addresses: [{ address_purpose: 'LOCATION', city: 'Bozeman', state: 'MT', telephone_number: '406-555-0142' }],
        taxonomies: [{ desc: 'Dental', primary: true }],
      },
      'Montana',
    );
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.category)).toEqual(['BROKERAGE', 'DISTRIBUTION']);
    // Distinct IDs so the two deduplicate independently.
    expect(new Set(records.map((r) => r.externalId)).size).toBe(2);
    expect(readEmitDistribution({ nppesEmitDistribution: false }, {})).toBe(false);
  });

  it('never renders a location as "KS, KS"', () => {
    expect(formatAwardLocation('75201', 'TX')).toBe('75201, TX');
    expect(formatAwardLocation(undefined, 'KS')).toBe('KS');
    expect(formatAwardLocation('', 'KS')).toBe('KS');
    expect(formatAwardLocation(undefined, undefined)).toBeNull();
  });
});

describe('Google Places nationwide coverage', () => {
  const national: MarketContext = { ...MARKET, name: 'United States', scope: 'NATIONAL', state: null, states: [], cities: [], centerLat: null, centerLng: null };

  it('uses the market centre when it has one', () => {
    const anchors = searchAnchors(MARKET);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({ lat: 32.7767, lng: -96.797 });
  });

  it('rotates through metro anchors for a nationwide market', () => {
    const day0 = searchAnchors(national, 0);
    const day1 = searchAnchors(national, 1);
    expect(day0).toHaveLength(ANCHORS_PER_RUN);
    expect(day0[0].name).not.toBe(day1[0].name);
  });

  it('reaches every anchor within a full rotation', () => {
    // Otherwise the tail of the list is billed for and never searched.
    const seen = new Set<string>();
    for (let day = 0; day < NATIONAL_ANCHORS.length; day++) {
      for (const a of searchAnchors(national, day)) seen.add(a.name);
    }
    expect(seen.size).toBe(NATIONAL_ANCHORS.length);
  });

  it('restricts anchors to the configured states when a national market names them', () => {
    const anchors = searchAnchors({ ...national, states: ['MT', 'TX'] }, 0);
    expect(anchors.every((a) => a.name.endsWith('MT') || a.name.endsWith('TX'))).toBe(true);
  });

  it('spans many states and includes low-density ones', () => {
    const states = new Set(NATIONAL_ANCHORS.map((a) => a.name.slice(-2)));
    expect(states.size).toBeGreaterThanOrEqual(35);
    for (const sparse of ['MT', 'ND', 'SD', 'WY', 'AK', 'VT']) {
      expect(states.has(sparse), `no anchor in ${sparse}`).toBe(true);
    }
  });

  it('refuses a non-national market with no coordinates instead of searching nowhere', async () => {
    vi.stubEnv('GOOGLE_PLACES_API_KEY', 'test-key');
    await expect(
      new GooglePlacesConnector().fetch(context({ market: { ...MARKET, scope: 'METRO', centerLat: null, centerLng: null } })),
    ).rejects.toThrow(/centre coordinates/);
  });

  it('searches multiple anchors in one nationwide run', async () => {
    vi.stubEnv('GOOGLE_PLACES_API_KEY', 'test-key');
    const centres: string[] = [];
    setTransport(async (_url, init) => {
      const body = JSON.parse(String(init.body));
      centres.push(`${body.locationBias.circle.center.latitude}`);
      return jsonResponse({ places: [] });
    });
    await new GooglePlacesConnector().fetch(
      context({ maxRecords: 40, market: { ...national, sourceConfig: { placeQueries: [DEFAULT_PLACE_QUERIES[0]] } } }),
    );
    expect(new Set(centres).size).toBe(ANCHORS_PER_RUN);
  });
});

describe('partitioned connectors report total failure honestly', () => {
  const national: MarketContext = { ...MARKET, scope: 'NATIONAL', state: null, states: ['TX'], cities: [], centerLat: null, centerLng: null };

  it('Places fails the run when every request fails', async () => {
    vi.stubEnv('GOOGLE_PLACES_API_KEY', 'bad-key');
    setTransport(async () => jsonResponse({ error: { message: 'API key not valid' } }, 400));
    await expect(new GooglePlacesConnector().fetch(context({ market: national }))).rejects.toThrow(
      /All \d+ Places request\(s\) failed.*Places API \(New\)/s,
    );
  });

  it('distinguishes a blocked key from a disabled API, because the fixes differ', async () => {
    vi.stubEnv('GOOGLE_PLACES_API_KEY', 'restricted-key');
    setTransport(async () =>
      jsonResponse(
        { error: { message: 'Requests to this API places.googleapis.com method google.maps.places.v1.Places.SearchText are blocked.' } },
        403,
      ),
    );
    // "Enable the API" is the wrong instruction here — it already is enabled,
    // and the key's own restrictions are what refused the call.
    await expect(new GooglePlacesConnector().fetch(context({ market: national }))).rejects.toThrow(
      /not allowed to call it.*API restrictions/s,
    );
  });

  it(
    'NPPES fails the run when every request fails',
    async () => {
      // A 500 is retryable, so this walks the full backoff for every taxonomy —
      // slow by design, and the timeout has to allow for it.
      setTransport(async () => jsonResponse({}, 500));
      await expect(new NppesConnector().fetch(context({ market: national }))).rejects.toThrow(/All \d+ NPPES request/);
    },
    30_000,
  );

  it('Places still returns results when only some anchors fail', async () => {
    vi.stubEnv('GOOGLE_PLACES_API_KEY', 'test-key');
    let call = 0;
    setTransport(async () => {
      call += 1;
      return call === 1
        ? jsonResponse({}, 500)
        : jsonResponse({ places: [{ id: 'p1', displayName: { text: 'Acme Clean' }, businessStatus: 'OPERATIONAL' }] });
    });
    const records = await new GooglePlacesConnector().fetch(
      context({ market: { ...national, sourceConfig: { placeQueries: [DEFAULT_PLACE_QUERIES[0]] } } }),
    );
    expect(records.length).toBeGreaterThan(0);
  });
});

describe('upstream error messages are surfaced', () => {
  it('extracts Google-style nested error messages', () => {
    expect(
      summariseError(JSON.stringify({ error: { code: 403, message: 'Places API (New) has not been used in project 123 before or it is disabled.' } })),
    ).toMatch(/Places API \(New\) has not been used/);
  });

  it('extracts USAspending-style detail messages', () => {
    expect(summariseError(JSON.stringify({ detail: 'Field \'Foo\' is not a valid field' }))).toBe(
      "Field 'Foo' is not a valid field",
    );
  });

  it('falls back to plain text and discards HTML soup', () => {
    expect(summariseError('Service Unavailable')).toBe('Service Unavailable');
    expect(summariseError('<html><body>nope</body></html>')).toBe('');
    expect(summariseError('')).toBe('');
  });

  it('puts the message in the thrown error, not just the body', async () => {
    setTransport(async () =>
      new Response(JSON.stringify({ error: { message: 'API key not valid. Please pass a valid API key.' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(httpJson({ url: 'https://example.test/x', attempts: 1 })).rejects.toThrow(/API key not valid/);
  });
});

describe('USAspending request batching', () => {
  it('splits a nationwide sweep into batches rather than one huge query', () => {
    expect(chunk(US_STATES, LOCATIONS_PER_REQUEST).length).toBe(Math.ceil(US_STATES.length / LOCATIONS_PER_REQUEST));
    expect(chunk([1, 2, 3], 8)).toEqual([[1, 2, 3]]);
    expect(chunk([], 8)).toEqual([]);
  });

  it('keeps results when only some batches fail', async () => {
    let call = 0;
    setTransport(async () => {
      call += 1;
      return call === 1
        ? new Response('{"detail":"boom"}', { status: 500, headers: { 'content-type': 'application/json' } })
        : new Response(
            JSON.stringify({
              results: [{ 'Award ID': 'A1', 'Recipient Name': 'Acme Facilities', 'Award Amount': 100, 'Place of Performance State Code': 'TX' }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
    });
    const records = await new UsaSpendingConnector().fetch(
      context({ maxRecords: 50, market: { ...MARKET, scope: 'NATIONAL', state: null, states: ['TX', 'IL', 'AZ', 'GA', 'NY', 'MT', 'KS', 'ME', 'CA'], cities: [] } }),
    );
    expect(records.length).toBeGreaterThan(0);
  }, 30_000);

  it('fails the run when every batch fails', async () => {
    setTransport(async () => new Response('{"detail":"nope"}', { status: 500, headers: { 'content-type': 'application/json' } }));
    await expect(
      new UsaSpendingConnector().fetch(context({ market: { ...MARKET, scope: 'STATE', states: ['TX'], cities: [] } })),
    ).rejects.toThrow(/All 1 USAspending request\(s\) failed.*nope/s);
  }, 30_000);
});
