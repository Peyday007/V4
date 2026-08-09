import type { DiscoveryConnector, ConnectorContext, RawRecord } from '../connector';
import type { CompanyRole, LeadRole, MarketSegment, SignalCategory, SourceType } from '@prisma/client';
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
  readonly credentialEnvVar = 'GOOGLE_PLACES_API_KEY';
  readonly termsUrl = 'https://cloud.google.com/maps-platform/terms/maps-service-terms';
  readonly accessBasis =
    'Licensed Google Maps Platform Places API accessed with a paid key under its published terms. Place IDs are retained; all other place content is treated as a lead to confirm, not stored data.';

  async fetch(context: ConnectorContext): Promise<RawRecord[]> {
    const market = context.market;
    if (!market) return [];
    if (market.centerLat === null || market.centerLng === null) {
      throw new Error(
        `Market "${market.name}" has no centre coordinates. Places search is a radius query — set centerLat and centerLng.`,
      );
    }

    const apiKey = readCredential(this.credentialEnvVar, 'Google Places');
    const queries = readQueries(market.sourceConfig, context.config);
    if (queries.length === 0) return [];

    const perQuery = Math.max(1, Math.floor(context.maxRecords / queries.length));
    const records: RawRecord[] = [];

    for (const query of queries) {
      if (records.length >= context.maxRecords) break;
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
                center: { latitude: market.centerLat, longitude: market.centerLng },
                radius: Math.min(market.radiusMeters, 50_000),
              },
            },
            maxResultCount: Math.min(perQuery, 20),
            languageCode: 'en',
          },
          timeoutMs: 20_000,
          rateLimitKey: 'google_places',
          rateLimitPerMin: context.rateLimitPerMin ?? 60,
        });

        for (const place of response.places ?? []) {
          const record = toPlaceRecord(place, query, market.name);
          if (record) records.push(record);
        }
      } catch (error) {
        console.error(`[google_places] "${query.query}": ${String(error).slice(0, 200)}`);
      }
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
