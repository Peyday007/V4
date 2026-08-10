import type { DiscoveryConnector, ConnectorContext, MarketContext, RawRecord } from '../connector';
import type { SignalCategory, SourceType } from '@prisma/client';
import { httpJson } from '../http';

/**
 * NPPES — the federal NPI registry.
 *
 * Every healthcare organisation in the United States that bills insurance is
 * in here: clinics, dental practices, urgent care, dialysis centres, imaging,
 * nursing facilities, hospitals. Around seven million records, with
 * organisation name, practice address and phone number, published by CMS,
 * refreshed daily, free, and requiring no key or registration.
 *
 * It is the nationwide buyer universe this platform needed. Medical facilities
 * buy cleaning to a compliance standard, which supports better rates than
 * general office work, and they buy consumables continuously. Unlike a place
 * API there is no per-request cost and no restriction on retaining what comes
 * back — it is a federal public record.
 *
 * Searchable by state, city or postal code, which maps cleanly onto every
 * market scope. Under NATIONAL scope the connector iterates states rather than
 * pretending one query covers the country.
 *
 * @see https://npiregistry.cms.hhs.gov/api-page
 */

const ENDPOINT = 'https://npiregistry.cms.hhs.gov/api/';
const API_VERSION = '2.1';

/**
 * Taxonomy families worth calling. Deliberately not every provider type — a
 * sole practitioner working from home is not a cleaning buyer, and filtering
 * here costs nothing while filtering later costs a caller's time.
 */
const DEFAULT_TAXONOMIES = [
  'Clinic/Center',
  'General Acute Care Hospital',
  'Skilled Nursing Facility',
  'Dental',
  'Ambulatory Surgical',
];

type NppesResponse = {
  result_count?: number;
  results?: Array<{
    number?: number;
    enumeration_type?: string;
    basic?: {
      organization_name?: string;
      name?: string;
      status?: string;
      organizational_subpart?: string;
    };
    addresses?: Array<{
      address_purpose?: string;
      address_1?: string;
      address_2?: string;
      city?: string;
      state?: string;
      postal_code?: string;
      telephone_number?: string;
    }>;
    taxonomies?: Array<{ desc?: string; primary?: boolean; state?: string }>;
  }>;
};

export class NppesConnector implements DiscoveryConnector {
  readonly key = 'nppes_healthcare';
  readonly sourceType: SourceType = 'LICENSE_DATABASE';
  readonly defaultCategory: SignalCategory = 'BROKERAGE';
  readonly isLive = true;
  readonly requiresMarket = true;
  readonly supportsNationwide = true;
  readonly termsUrl = 'https://npiregistry.cms.hhs.gov/api-page';
  readonly accessBasis =
    'Official CMS National Plan and Provider Enumeration System public API. Federal public record, no key or registration required, no retention restriction.';

  async fetch(context: ConnectorContext): Promise<RawRecord[]> {
    const market = context.market;
    if (!market) return [];

    const taxonomies = readTaxonomies(market.sourceConfig, context.config);
    const emitDistribution = readEmitDistribution(market.sourceConfig, context.config);
    const partitions = rotatePartitions(geographicPartitions(market), maxPartitionsFor(context.maxRecords, taxonomies.length));
    if (partitions.length === 0) return [];

    const records: RawRecord[] = [];
    let attempted = 0;
    const failures: string[] = [];
    // Budget is split across partitions and taxonomies so a nationwide run
    // spreads across states rather than exhausting itself in the first one.
    const perQuery = Math.max(1, Math.floor(context.maxRecords / (partitions.length * taxonomies.length)));

    for (const partition of partitions) {
      for (const taxonomy of taxonomies) {
        if (records.length >= context.maxRecords) break;
        attempted += 1;
        try {
          const response = await httpJson<NppesResponse>({
            url: buildNppesUrl(partition, taxonomy, Math.min(perQuery, 200)),
            timeoutMs: 20_000,
            rateLimitKey: 'nppes',
            rateLimitPerMin: context.rateLimitPerMin ?? 40,
          });

          for (const result of response.results ?? []) {
            for (const record of toNppesRecords(result, market.name, emitDistribution)) {
              records.push(record);
            }
          }
        } catch (error) {
          failures.push(`${JSON.stringify(partition)}/${taxonomy}: ${String(error).slice(0, 120)}`);
        }
      }
    }

    if (attempted > 0 && failures.length === attempted) {
      throw new Error(`All ${attempted} NPPES request(s) failed. ${failures.slice(0, 2).join(' | ')}`);
    }

    return records.slice(0, context.maxRecords);
  }
}

export type GeoPartition = { state?: string; city?: string; postal_code?: string };

/**
 * How many partitions one run may touch.
 *
 * A national sweep is fifty-one states times five taxonomies — 255 requests,
 * which no serverless invocation is going to finish and no source deserves in
 * one burst. The run takes a slice instead.
 */
export function maxPartitionsFor(maxRecords: number, taxonomyCount: number): number {
  const budget = Math.max(1, Math.floor(maxRecords / Math.max(1, taxonomyCount)));
  return Math.min(12, Math.max(1, budget));
}

/**
 * Rotates which slice a run takes, so scheduled runs cover the country over
 * days instead of re-querying Alabama every morning and never reaching Wyoming.
 * Deterministic by date, so a re-run on the same day is idempotent.
 */
export function rotatePartitions<T>(partitions: T[], limit: number, day = dayIndex()): T[] {
  if (partitions.length <= limit) return partitions;
  const offset = (day * limit) % partitions.length;
  const slice = partitions.slice(offset, offset + limit);
  return slice.length === limit ? slice : [...slice, ...partitions.slice(0, limit - slice.length)];
}

function dayIndex(now = new Date()): number {
  return Math.floor(now.getTime() / 86_400_000);
}

/**
 * Turns a market into the set of queries that cover it.
 *
 * This is the piece that makes nationwide real rather than aspirational. NPPES
 * will not return the whole country in one call, so NATIONAL scope becomes one
 * query per state — which is a partition the connector owns, not something the
 * operator has to configure state by state.
 */
export function geographicPartitions(market: MarketContext): GeoPartition[] {
  switch (market.scope) {
    case 'NATIONAL':
      return (market.states.length > 0 ? market.states : US_STATES).map((state) => ({ state }));
    case 'STATE':
      return (market.states.length > 0 ? market.states : market.state ? [market.state] : []).map((state) => ({ state }));
    case 'POSTAL':
      return market.postalCodes.slice(0, 40).map((postal_code) => ({ postal_code }));
    case 'CITY':
    case 'METRO':
    case 'COUNTY':
    case 'RADIUS':
    default: {
      // City lists are how a metro is expressed to a source with no radius
      // support. Falling back to the state keeps a market with no city list
      // productive rather than silent.
      if (market.cities.length > 0) {
        return market.cities.slice(0, 25).map((city) => ({ city, state: market.state ?? undefined }));
      }
      return market.state ? [{ state: market.state }] : [];
    }
  }
}

export function buildNppesUrl(partition: GeoPartition, taxonomy: string, limit: number): string {
  const params = new URLSearchParams({
    version: API_VERSION,
    // Organisations only. Individual practitioners are not facility buyers.
    enumeration_type: 'NPI-2',
    taxonomy_description: taxonomy,
    limit: String(Math.min(limit, 200)),
  });
  if (partition.state) params.set('state', partition.state);
  if (partition.city) params.set('city', partition.city);
  if (partition.postal_code) params.set('postal_code', partition.postal_code);
  return `${ENDPOINT}?${params.toString()}`;
}

export function toNppesRecord(
  result: NonNullable<NppesResponse['results']>[number],
  marketName: string,
): RawRecord | null {
  const name = result.basic?.organization_name?.trim();
  const npi = result.number;
  if (!name || !npi) return null;
  if (result.basic?.status && result.basic.status !== 'A') return null;

  // The location address is the physical site that needs cleaning. A mailing
  // address is frequently a billing company in another state, and calling it
  // reaches somebody with no authority over the building.
  const address =
    result.addresses?.find((a) => a.address_purpose === 'LOCATION') ?? result.addresses?.[0];
  if (!address?.city || !address.state) return null;

  const taxonomy = result.taxonomies?.find((t) => t.primary)?.desc ?? result.taxonomies?.[0]?.desc ?? 'Healthcare facility';
  const phone = address.telephone_number?.trim();

  return {
    externalId: `npi:${npi}`,
    title: `${name} — ${taxonomy}`,
    excerpt:
      `${name} is a ${taxonomy.toLowerCase()} at ${[address.address_1, address.city, address.state, address.postal_code?.slice(0, 5)]
        .filter(Boolean)
        .join(', ')}. ` +
      `Registered with CMS under NPI ${npi}.`,
    sourceUrl: `https://npiregistry.cms.hhs.gov/provider-view/${npi}`,
    location: [address.city, address.state].filter(Boolean).join(', ') || marketName,
    state: address.state,
    companyName: name,
    subjectRole: 'BUYER',
    describesSubject: false,
    leadRole: 'BUYER',
    segment: 'COMMERCIAL',
    // Medical premises need both the service and the consumables, so the
    // record legitimately belongs to two paths. Brokerage is the entry point;
    // the distribution follow-on comes after the first conversation.
    category: 'BROKERAGE',
    requiredService: 'Medical facility cleaning and consumables',
    whyRelevant:
      `Registered healthcare facility in ${address.city}, ${address.state}. Medical premises require cleaning to a ` +
      `documented standard rather than general office cleaning, which supports higher rates, and they consume gloves, ` +
      `liners and paper continuously. Facility address and main line are on the federal register, so no research is ` +
      `needed before a first call.`,
    contact: phone ? { phone } : {},
    payload: {
      npi,
      taxonomy,
      city: address.city,
      state: address.state,
      postalCode: address.postal_code?.slice(0, 5),
    },
  };
}

/**
 * One facility, two leads.
 *
 * A clinic needs the cleaning contract *and* buys gloves, liners and paper on
 * a standing order. Those are different sales, to different budgets, on
 * different cycles, and collapsing them into one record means the distribution
 * path never sees a nationwide source at all. Separate external IDs so the two
 * deduplicate independently and either can be dismissed without losing the
 * other.
 */
export function toNppesRecords(
  result: NonNullable<NppesResponse['results']>[number],
  marketName: string,
  emitDistribution = true,
): RawRecord[] {
  const base = toNppesRecord(result, marketName);
  if (!base) return [];
  if (!emitDistribution) return [base];

  return [
    base,
    {
      ...base,
      externalId: `${base.externalId}:supplies`,
      title: base.title.replace(/ — .*$/, '') + ' — janitorial consumables',
      category: 'DISTRIBUTION',
      leadRole: 'BUYER',
      requiredService: 'Janitorial consumables and replenishment',
      whyRelevant:
        `${base.companyName} is a registered healthcare facility that consumes gloves, liners, paper and cleaning ` +
        `chemicals continuously. Consumables are a faster sale than a service contract — no site visit, no incumbent ` +
        `to displace — and a standing replenishment order is the usual way into the cleaning contract later.`,
    },
  ];
}

export function readEmitDistribution(
  marketConfig: Record<string, unknown>,
  sourceConfig: Record<string, unknown>,
): boolean {
  const raw = marketConfig.nppesEmitDistribution ?? sourceConfig.emitDistribution;
  return raw === undefined ? true : raw !== false;
}

export function readTaxonomies(
  marketConfig: Record<string, unknown>,
  sourceConfig: Record<string, unknown>,
): string[] {
  const raw = (marketConfig.nppesTaxonomies ?? sourceConfig.taxonomies) as unknown;
  if (!Array.isArray(raw)) return DEFAULT_TAXONOMIES;
  const values = raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  return values.length > 0 ? values : DEFAULT_TAXONOMIES;
}

/** The fifty states plus DC. Used to partition a national run. */
export const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM',
  'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA',
  'WV', 'WI', 'WY',
];
