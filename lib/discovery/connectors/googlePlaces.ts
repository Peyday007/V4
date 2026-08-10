import type { DiscoveryConnector, ConnectorContext, RawRecord } from '../connector';
import type { CompanyRole, LeadRole, MarketSegment, SignalCategory, SourceType } from '@prisma/client';
import type { MarketContext } from '../connector';
import { httpJson, readCredential } from '../http';

/**
 * Google Places (New) — Text Search.
 *
 * This is the connector that populates both sides of a market: the providers
 * who can do the work, and the commercial premises that need it. A metro's
 * dental practices, gyms, churches, daycares, clinics and property managers are
 * the buyer universe for commercial cleaning, and they are all enumerable here
 * by category and radius.
 *
 * ## What this connector may and may not keep
 *
 * Google's Maps Platform terms prohibit storing Places content. The place ID is
 * the documented exception and may be retained indefinitely; coordinates may be
 * cached for at most 30 days. Names, phone numbers and addresses are not ours
 * to keep.
 *
 * So the rule enforced here, and relied on downstream, is: **the place ID is
 * the durable record, everything else is a lead to be confirmed.** Facts
 * arriving from this source are written as CLAIMED with a short expiry, not as
 * verified company data. Once a caller speaks to the business, what they
 * confirm is first-party information and is ours — that is the intended path,
 * and it is also the only one that produces trustworthy data.
 *
 * @see https://developers.google.com/maps/documentation/places/web-service/text-search
 * @see https://cloud.google.com/maps-platform/terms/maps-service-terms
 */

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';

/**
 * Field mask is required and is what you are billed on. Asking for fewer
 * fields is materially cheaper, so this requests only what a lead needs.
 */
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.addressComponents',
  'places.primaryType',
  'places.types',
  'places.websiteUri',
  'places.nationalPhoneNumber',
  'places.businessStatus',
  'places.location',
  'nextPageToken',
].join(',');

/** How the platform's terms constrain retention. Referenced by the ingest path. */
export const PLACES_RETENTION = {
  /** Place IDs are exempt from the caching restriction. */
  durableFields: ['externalPlaceId'] as const,
  /** Everything else must be re-fetched or confirmed rather than relied on. */
  cacheDays: 30,
} as const;

export type PlaceQuery = {
  /** Text query, e.g. "commercial cleaning company" or "dental clinic". */
  query: string;
  /** What a result of this query is to us. */
  leadRole: LeadRole;
  companyRole: CompanyRole;
  category: SignalCategory;
  segment?: MarketSegment;
  /** Service the lead relates to, used in the signal. */
  service: string;
  /** Why a result of this query is worth someone's time. */
  why: string;
};

/**
 * Default query set, covering all three paths.
 *
 * These are defaults, not limits — a market can replace them entirely through
 * `sourceConfig.placeQueries`, which is how the platform expands beyond
 * cleaning into any other service category without a code change.
 */
export const DEFAULT_PLACE_QUERIES: PlaceQuery[] = [
  // --- Brokerage: providers who can fulfil work ---
  {
    query: 'commercial cleaning company',
    leadRole: 'PROVIDER',
    companyRole: 'SUBCONTRACTOR',
    category: 'BROKERAGE',
    segment: 'COMMERCIAL',
    service: 'Commercial cleaning',
    why: 'Local provider capable of fulfilling commercial cleaning work. Needed on the supply side before buyer demand can be accepted.',
  },
  {
    query: 'janitorial services',
    leadRole: 'PROVIDER',
    companyRole: 'SUBCONTRACTOR',
    category: 'BROKERAGE',
    segment: 'COMMERCIAL',
    service: 'Janitorial',
    why: 'Local janitorial provider. Qualify for crew count, insurance and night-shift capacity before assigning work.',
  },
  // --- Brokerage: commercial premises that buy cleaning ---
  {
    query: 'property management company',
    leadRole: 'BUYER',
    companyRole: 'BUYER',
    category: 'BROKERAGE',
    segment: 'COMMERCIAL',
    service: 'Commercial cleaning',
    why: 'Property managers buy cleaning across a portfolio rather than one site, so a single relationship covers many buildings.',
  },
  {
    query: 'medical clinic',
    leadRole: 'BUYER',
    companyRole: 'BUYER',
    category: 'BROKERAGE',
    segment: 'COMMERCIAL',
    service: 'Medical facility cleaning',
    why: 'Clinics require scheduled cleaning to a compliance standard, which supports higher rates than general office work.',
  },
  {
    query: 'fitness gym',
    leadRole: 'BUYER',
    companyRole: 'BUYER',
    category: 'BROKERAGE',
    segment: 'COMMERCIAL',
    service: 'Commercial cleaning',
    why: 'High-traffic premises with daily cleaning requirements and continual consumables use.',
  },
  // --- Distribution: consumables and supply buyers ---
  {
    query: 'office building',
    leadRole: 'BUYER',
    companyRole: 'BUYER',
    category: 'DISTRIBUTION',
    segment: 'COMMERCIAL',
    service: 'Janitorial supplies and consumables',
    why: 'Occupied office premises consume restroom and cleaning consumables on a recurring cycle, which is a replenishment sale rather than a one-off.',
  },
  {
    query: 'janitorial supply distributor',
    leadRole: 'SUPPLIER',
    companyRole: 'DISTRIBUTOR',
    category: 'DISTRIBUTION',
    segment: 'COMMERCIAL',
    service: 'Janitorial supply wholesale',
    why: 'Wholesale supply partner. Needed to price and fulfil consumables before quoting replenishment.',
  },
  // --- Subcontracting: organisations that hand work down ---
  {
    query: 'facility management company',
    leadRole: 'CONTRACTOR',
    companyRole: 'PRIME_CONTRACTOR',
    category: 'SUBCONTRACTING',
    segment: 'COMMERCIAL',
    service: 'Subcontracted facility services',
    why: 'Facility-management firms hold multi-site contracts and subcontract local delivery, which is overflow capacity we can take on.',
  },
  {
    query: 'general contractor',
    leadRole: 'CONTRACTOR',
    companyRole: 'PRIME_CONTRACTOR',
    category: 'SUBCONTRACTING',
    segment: 'COMMERCIAL',
    service: 'Post-construction cleaning subcontract',
    why: 'General contractors subcontract final construction cleaning on every project and maintain a standing vendor list.',
  },
];

type PlacesResponse = {
  places?: Array<{
    id?: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    addressComponents?: Array<{ longText?: string; shortText?: string; types?: string[] }>;
    primaryType?: string;
    types?: string[];
    websiteUri?: string;
    nationalPhoneNumber?: string;
    businessStatus?: string;
    location?: { latitude?: number; longitude?: number };
  }>;
  nextPageToken?: string;
};

export class GooglePlacesConnector implements DiscoveryConnector {
  readonly key = 'google_places';
  readonly sourceType: SourceType = 'BUSINESS_DIRECTORY';
  readonly defaultCategory: SignalCategory = 'BROKERAGE';
  readonly isLive = true;
  readonly requiresMarket = true;
  // Nationwide by rotating through metro anchors. Without this a deployment
  // whose only market is the national one would never run Places at all — the
  // key would be set, the source enabled, and nothing would ever happen.
  readonly supportsNationwide = true;
  readonly credentialEnvVar = 'GOOGLE_PLACES_API_KEY';
  readonly termsUrl = 'https://cloud.google.com/maps-platform/terms/maps-service-terms';
  readonly accessBasis =
    'Licensed Google Maps Platform Places API accessed with a paid key under its published terms. Place IDs are retained; all other place content is treated as a lead to confirm, not stored data.';

  async fetch(context: ConnectorContext): Promise<RawRecord[]> {
    const market = context.market;
    if (!market) return [];

    const apiKey = readCredential(this.credentialEnvVar, 'Google Places');
    const queries = readQueries(market.sourceConfig, context.config);
    if (queries.length === 0) return [];

    const anchors = searchAnchors(market);
    if (anchors.length === 0) {
      throw new Error(
        `Market "${market.name}" has no centre coordinates and is not nationwide. Places search is a radius query — ` +
          `set centerLat and centerLng, or use a nationwide market.`,
      );
    }

    // Each request is billed, so the budget is split across anchors and
    // queries rather than spent entirely on the first pair.
    const perRequest = Math.max(1, Math.floor(context.maxRecords / (anchors.length * queries.length)));
    const records: RawRecord[] = [];
    let attempted = 0;
    let keyBlocked = false;
    const failures: string[] = [];

    for (const anchor of anchors) {
      for (const query of queries) {
        if (records.length >= context.maxRecords) break;
        attempted += 1;
        try {
          const response = await httpJson<PlacesResponse>({
            url: ENDPOINT,
            method: 'POST',
            headers: {
              'X-Goog-Api-Key': apiKey,
              'X-Goog-FieldMask': FIELD_MASK,
            },
            body: {
              textQuery: query.query,
              // Bias rather than hard restriction: a provider two miles outside
              // the boundary still serves the market.
              locationBias: {
                circle: {
                  center: { latitude: anchor.lat, longitude: anchor.lng },
                  radius: Math.min(anchor.radiusMeters, 50_000),
                },
              },
              maxResultCount: Math.min(Math.max(perRequest, 5), 20),
              languageCode: 'en',
            },
            timeoutMs: 20_000,
            rateLimitKey: 'google_places',
            rateLimitPerMin: context.rateLimitPerMin ?? 60,
          });

          for (const place of response.places ?? []) {
            const record = toPlaceRecord(place, query, anchor.name);
            if (record) records.push(record);
          }
        } catch (error) {
          // Tested against the untruncated error: the signature Google uses
          // sits past the 120 characters kept for display.
          if (/are blocked|API_KEY_SERVICE_BLOCKED/i.test(String(error))) keyBlocked = true;
          failures.push(`${anchor.name}/"${query.query}": ${String(error).slice(0, 120)}`);
        }
      }
    }

    // Every request failing is a broken key, a disabled API or an outage — not
    // a quiet week. Reporting it as a successful run with zero results is the
    // one outcome that leaves the operator with nothing to act on.
    if (attempted > 0 && failures.length === attempted) {
      // Google distinguishes these two cases in its own wording, and they have
      // different fixes, so repeat the distinction rather than guessing.
      const hint = keyBlocked
        ? 'The API is reachable but this key is not allowed to call it — check the key\'s API restrictions in Google Cloud (Credentials → the key → API restrictions), and that the key belongs to the project where Places API (New) is enabled.'
        : 'Check the key is valid, that "Places API (New)" is enabled, and that billing is active on the project.';
      throw new Error(`All ${attempted} Places request(s) failed. ${hint} ${failures.slice(0, 2).join(' | ')}`);
    }

    return records.slice(0, context.maxRecords);
  }
}

export function toPlaceRecord(
  place: NonNullable<PlacesResponse['places']>[number],
  query: PlaceQuery,
  marketName: string,
): RawRecord | null {
  const name = place.displayName?.text?.trim();
  const id = place.id?.trim();
  if (!name || !id) return null;

  // Closed businesses are still returned and are pure waste for a caller.
  if (place.businessStatus && place.businessStatus !== 'OPERATIONAL') return null;

  const state = place.addressComponents?.find((c) => c.types?.includes('administrative_area_level_1'))?.shortText;
  const city = place.addressComponents?.find((c) => c.types?.includes('locality'))?.longText;

  return {
    externalId: `places:${id}`,
    externalPlaceId: id,
    title: `${name} — ${query.service}`,
    excerpt:
      `${name}${place.formattedAddress ? `, ${place.formattedAddress}` : ''}. ` +
      `Listed under ${humanisePlaceType(place.primaryType ?? query.query)} in ${city ?? marketName}. ` +
      `Identified as a ${query.leadRole.toLowerCase()} candidate for ${query.service.toLowerCase()}.`,
    // Links to the canonical Google listing by place ID, which is the one
    // durable identifier and lets a person verify the lead in one click.
    sourceUrl: `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(id)}`,
    location: [city, state].filter(Boolean).join(', ') || marketName,
    state: state ?? undefined,
    companyName: name,
    companyWebsite: place.websiteUri,
    subjectRole: query.companyRole,
    // A directory listing is the company describing itself, which is the one
    // case where inferring role from the listing text is legitimate.
    describesSubject: true,
    leadRole: query.leadRole,
    segment: query.segment ?? 'COMMERCIAL',
    category: query.category,
    requiredService: query.service,
    whyRelevant: query.why,
    contact: {
      phone: place.nationalPhoneNumber,
      website: place.websiteUri,
    },
    payload: {
      placeId: id,
      primaryType: place.primaryType,
      types: place.types,
      businessStatus: place.businessStatus,
      // Coordinates are cacheable for 30 days under the platform terms. The
      // ingest path stamps an expiry rather than keeping them indefinitely.
      location: place.location,
      retrievedFor: query.query,
    },
  };
}

function humanisePlaceType(value: string): string {
  return value.replace(/_/g, ' ').toLowerCase();
}

export type SearchAnchor = { name: string; lat: number; lng: number; radiusMeters: number };

/**
 * Population-weighted metro anchors used to cover the country.
 *
 * A radius search needs a centre, so "nationwide" has to become a set of
 * points. These are the largest US metros by population across as many states
 * as possible — enough that a rotating slice reaches most of the country over
 * a few days without pretending a single query covers it.
 */
export const NATIONAL_ANCHORS: SearchAnchor[] = [
  { name: 'New York, NY', lat: 40.7128, lng: -74.006, radiusMeters: 40_000 },
  { name: 'Los Angeles, CA', lat: 34.0522, lng: -118.2437, radiusMeters: 45_000 },
  { name: 'Chicago, IL', lat: 41.8781, lng: -87.6298, radiusMeters: 45_000 },
  { name: 'Houston, TX', lat: 29.7604, lng: -95.3698, radiusMeters: 50_000 },
  { name: 'Phoenix, AZ', lat: 33.4484, lng: -112.074, radiusMeters: 50_000 },
  { name: 'Philadelphia, PA', lat: 39.9526, lng: -75.1652, radiusMeters: 40_000 },
  { name: 'San Antonio, TX', lat: 29.4241, lng: -98.4936, radiusMeters: 45_000 },
  { name: 'San Diego, CA', lat: 32.7157, lng: -117.1611, radiusMeters: 40_000 },
  { name: 'Dallas, TX', lat: 32.7767, lng: -96.797, radiusMeters: 50_000 },
  { name: 'Jacksonville, FL', lat: 30.3322, lng: -81.6557, radiusMeters: 45_000 },
  { name: 'Austin, TX', lat: 30.2672, lng: -97.7431, radiusMeters: 40_000 },
  { name: 'Columbus, OH', lat: 39.9612, lng: -82.9988, radiusMeters: 40_000 },
  { name: 'Charlotte, NC', lat: 35.2271, lng: -80.8431, radiusMeters: 40_000 },
  { name: 'Indianapolis, IN', lat: 39.7684, lng: -86.1581, radiusMeters: 40_000 },
  { name: 'Seattle, WA', lat: 47.6062, lng: -122.3321, radiusMeters: 40_000 },
  { name: 'Denver, CO', lat: 39.7392, lng: -104.9903, radiusMeters: 45_000 },
  { name: 'Boston, MA', lat: 42.3601, lng: -71.0589, radiusMeters: 35_000 },
  { name: 'Nashville, TN', lat: 36.1627, lng: -86.7816, radiusMeters: 45_000 },
  { name: 'Detroit, MI', lat: 42.3314, lng: -83.0458, radiusMeters: 45_000 },
  { name: 'Portland, OR', lat: 45.5152, lng: -122.6784, radiusMeters: 40_000 },
  { name: 'Las Vegas, NV', lat: 36.1699, lng: -115.1398, radiusMeters: 40_000 },
  { name: 'Memphis, TN', lat: 35.1495, lng: -90.049, radiusMeters: 40_000 },
  { name: 'Louisville, KY', lat: 38.2527, lng: -85.7585, radiusMeters: 40_000 },
  { name: 'Baltimore, MD', lat: 39.2904, lng: -76.6122, radiusMeters: 35_000 },
  { name: 'Milwaukee, WI', lat: 43.0389, lng: -87.9065, radiusMeters: 35_000 },
  { name: 'Albuquerque, NM', lat: 35.0844, lng: -106.6504, radiusMeters: 40_000 },
  { name: 'Atlanta, GA', lat: 33.749, lng: -84.388, radiusMeters: 50_000 },
  { name: 'Kansas City, MO', lat: 39.0997, lng: -94.5786, radiusMeters: 45_000 },
  { name: 'Miami, FL', lat: 25.7617, lng: -80.1918, radiusMeters: 40_000 },
  { name: 'Omaha, NE', lat: 41.2565, lng: -95.9345, radiusMeters: 35_000 },
  { name: 'Minneapolis, MN', lat: 44.9778, lng: -93.265, radiusMeters: 45_000 },
  { name: 'New Orleans, LA', lat: 29.9511, lng: -90.0715, radiusMeters: 35_000 },
  { name: 'Salt Lake City, UT', lat: 40.7608, lng: -111.891, radiusMeters: 40_000 },
  { name: 'St Louis, MO', lat: 38.627, lng: -90.1994, radiusMeters: 45_000 },
  { name: 'Oklahoma City, OK', lat: 35.4676, lng: -97.5164, radiusMeters: 45_000 },
  { name: 'Richmond, VA', lat: 37.5407, lng: -77.436, radiusMeters: 35_000 },
  { name: 'Birmingham, AL', lat: 33.5186, lng: -86.8104, radiusMeters: 40_000 },
  { name: 'Boise, ID', lat: 43.615, lng: -116.2023, radiusMeters: 35_000 },
  { name: 'Des Moines, IA', lat: 41.5868, lng: -93.625, radiusMeters: 35_000 },
  { name: 'Little Rock, AR', lat: 34.7465, lng: -92.2896, radiusMeters: 35_000 },
  { name: 'Charleston, SC', lat: 32.7765, lng: -79.9311, radiusMeters: 35_000 },
  { name: 'Hartford, CT', lat: 41.7658, lng: -72.6734, radiusMeters: 30_000 },
  { name: 'Providence, RI', lat: 41.824, lng: -71.4128, radiusMeters: 30_000 },
  { name: 'Billings, MT', lat: 45.7833, lng: -108.5007, radiusMeters: 60_000 },
  { name: 'Sioux Falls, SD', lat: 43.5446, lng: -96.7311, radiusMeters: 50_000 },
  { name: 'Fargo, ND', lat: 46.8772, lng: -96.7898, radiusMeters: 50_000 },
  { name: 'Wichita, KS', lat: 37.6872, lng: -97.3301, radiusMeters: 45_000 },
  { name: 'Portland, ME', lat: 43.6591, lng: -70.2568, radiusMeters: 40_000 },
  { name: 'Anchorage, AK', lat: 61.2181, lng: -149.9003, radiusMeters: 50_000 },
  { name: 'Honolulu, HI', lat: 21.3099, lng: -157.8581, radiusMeters: 30_000 },
  { name: 'Cheyenne, WY', lat: 41.14, lng: -104.8202, radiusMeters: 50_000 },
  { name: 'Burlington, VT', lat: 44.4759, lng: -73.2121, radiusMeters: 40_000 },
];

/** How many anchors one nationwide run may search. Each is a billed request. */
export const ANCHORS_PER_RUN = 4;

/**
 * The points this run searches around.
 *
 * A market with its own centre uses it. A nationwide market rotates through the
 * anchor list by day, so coverage accumulates across runs instead of spending
 * the whole budget on New York every morning.
 */
export function searchAnchors(market: MarketContext, day = Math.floor(Date.now() / 86_400_000)): SearchAnchor[] {
  if (market.centerLat !== null && market.centerLng !== null) {
    return [{ name: market.name, lat: market.centerLat, lng: market.centerLng, radiusMeters: market.radiusMeters }];
  }
  if (market.scope !== 'NATIONAL') return [];

  const pool = market.states.length > 0
    ? NATIONAL_ANCHORS.filter((a) => market.states.includes(a.name.slice(-2)))
    : NATIONAL_ANCHORS;
  if (pool.length === 0) return [];
  if (pool.length <= ANCHORS_PER_RUN) return pool;

  const offset = (day * ANCHORS_PER_RUN) % pool.length;
  const slice = pool.slice(offset, offset + ANCHORS_PER_RUN);
  return slice.length === ANCHORS_PER_RUN ? slice : [...slice, ...pool.slice(0, ANCHORS_PER_RUN - slice.length)];
}

export function readQueries(
  marketConfig: Record<string, unknown>,
  sourceConfig: Record<string, unknown>,
): PlaceQuery[] {
  const raw = (marketConfig.placeQueries ?? sourceConfig.placeQueries) as unknown;
  if (!Array.isArray(raw)) return DEFAULT_PLACE_QUERIES;
  const parsed = raw.filter(isPlaceQuery);
  return parsed.length > 0 ? parsed : DEFAULT_PLACE_QUERIES;
}

function isPlaceQuery(value: unknown): value is PlaceQuery {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.query === 'string' &&
    typeof candidate.leadRole === 'string' &&
    typeof candidate.companyRole === 'string' &&
    typeof candidate.category === 'string' &&
    typeof candidate.service === 'string' &&
    typeof candidate.why === 'string'
  );
}
