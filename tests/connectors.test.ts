import { afterEach, describe, expect, it, vi } from 'vitest';
import { SocrataConnector, buildSocrataUrl, readDatasets, toRawRecord, type SocrataDatasetConfig } from '@/lib/discovery/connectors/socrata';
import { GooglePlacesConnector, DEFAULT_PLACE_QUERIES, readQueries, toPlaceRecord } from '@/lib/discovery/connectors/googlePlaces';
import { SamGovConnector, readNaics, toSamRecord } from '@/lib/discovery/connectors/samGov';
import { setTransport, resetTransport, resetRateLimits, httpJson, HttpError, MissingCredentialError, readCredential } from '@/lib/discovery/http';
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
  state: 'TX',
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

  it('returns nothing when the market has no dataset configuration', async () => {
    let called = false;
    setTransport(async () => {
      called = true;
      return jsonResponse([]);
    });
    const records = await new SocrataConnector().fetch(context());
    expect(records).toEqual([]);
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
    expect(live).toEqual(['google_places', 'sam_gov_opportunities', 'socrata_open_data']);

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
