import type { DiscoveryConnector, ConnectorContext, MarketContext, RawRecord } from '../connector';
import type { SignalCategory, SourceType } from '@prisma/client';
import { httpJson } from '../http';
import { US_STATES } from './nppes';

/**
 * USAspending — federal award recipients, nationwide.
 *
 * This is the subcontracting source. SAM.gov lists solicitations that have not
 * been awarded yet; USAspending lists the companies that **already won** and
 * are now obliged to deliver. A firm that took a janitorial contract for a
 * facility six states from its nearest crew has an immediate fulfilment
 * problem, and that is the conversation this platform exists to start.
 *
 * Free, no key, no registration, covers every state, and is a federal public
 * record with no retention restriction. It is queried by place of performance,
 * so a market's geography maps directly onto the filter.
 *
 * The recipient here is a **prime contractor**, not a buyer. Filing them as a
 * buyer would put them in the wrong half of every match.
 *
 * @see https://api.usaspending.gov/
 */

const ENDPOINT = 'https://api.usaspending.gov/api/v2/search/spending_by_award/';

/**
 * Location filters per request. Fifty-one at once is a heavy enough query for
 * the API to fail on, and batching lets one bad state fail alone.
 */
export const LOCATIONS_PER_REQUEST = 8;

/** Documented contract fields. Anything outside this list risks a 500. */
const AWARD_FIELDS = [
  'Award ID',
  'Recipient Name',
  'Award Amount',
  'Start Date',
  'End Date',
  'Awarding Agency',
  'Awarding Sub Agency',
  'Place of Performance State Code',
  'Place of Performance Zip5',
  'Description',
];

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Facility-services NAICS. Same family the SAM.gov connector uses. */
const DEFAULT_NAICS = ['561720', '561790', '561210', '561740'];

type SpendingResponse = {
  results?: Array<{
    'Award ID'?: string;
    'Recipient Name'?: string;
    'Award Amount'?: number;
    'Start Date'?: string;
    'End Date'?: string;
    'Awarding Agency'?: string;
    'Awarding Sub Agency'?: string;
    'Place of Performance State Code'?: string;
    'Place of Performance City Code'?: string;
    'Place of Performance Zip5'?: string;
    'Description'?: string;
    generated_internal_id?: string;
    internal_id?: string | number;
  }>;
  page_metadata?: { hasNext?: boolean };
};

export class UsaSpendingConnector implements DiscoveryConnector {
  readonly key = 'usaspending_awards';
  readonly sourceType: SourceType = 'CONTRACT_AWARD';
  readonly defaultCategory: SignalCategory = 'SUBCONTRACTING';
  readonly isLive = true;
  readonly requiresMarket = true;
  readonly supportsNationwide = true;
  readonly termsUrl = 'https://api.usaspending.gov/';
  readonly accessBasis =
    'Official US Treasury USAspending public API. Federal public record, no key or registration required, no retention restriction.';

  async fetch(context: ConnectorContext): Promise<RawRecord[]> {
    const market = context.market;
    if (!market) return [];

    const naics = readAwardNaics(market.sourceConfig, context.config);
    const locations = placeOfPerformanceFilters(market);
    if (locations.length === 0) return [];

    // Awards stay relevant for the life of the contract, so the window is
    // wider than a permit feed's. A contract awarded eight months ago still
    // needs crews today.
    const since = context.since ?? new Date(Date.now() - 270 * 86_400_000);

    // A nationwide sweep is fifty-one location filters. Sent as one request
    // that is a large enough query to fail server-side, so it goes in batches.
    // Batching also means one bad state cannot lose the whole run.
    const batches = chunk(locations, LOCATIONS_PER_REQUEST);
    const rows: NonNullable<SpendingResponse['results']> = [];
    const failures: string[] = [];

    for (const batch of batches) {
      if (rows.length >= context.maxRecords) break;
      try {
        const response = await httpJson<SpendingResponse>({
          url: ENDPOINT,
          method: 'POST',
          body: {
            filters: {
              award_type_codes: ['A', 'B', 'C', 'D'],
              time_period: [
                { start_date: since.toISOString().slice(0, 10), end_date: new Date().toISOString().slice(0, 10) },
              ],
              naics_codes: naics,
              place_of_performance_locations: batch,
            },
            fields: AWARD_FIELDS,
            sort: 'Award Amount',
            order: 'desc',
            limit: Math.min(Math.max(context.maxRecords, 10), 100),
            page: 1,
            subawards: false,
          },
          timeoutMs: 25_000,
          rateLimitKey: 'usaspending',
          rateLimitPerMin: context.rateLimitPerMin ?? 30,
        });
        rows.push(...(response.results ?? []));
      } catch (error) {
        failures.push(`${batch.map((b) => b.state ?? b.zip ?? b.city).join(',')}: ${String(error).slice(0, 160)}`);
      }
    }

    if (batches.length > 0 && failures.length === batches.length) {
      throw new Error(`All ${batches.length} USAspending request(s) failed. ${failures.slice(0, 2).join(' | ')}`);
    }

    return rows
      .map((row) => toAwardRecord(row, market.name))
      .filter((record): record is RawRecord => record !== null)
      .slice(0, context.maxRecords);
  }
}

/**
 * Place-of-performance filters covering the market.
 *
 * USAspending accepts a list, so a national run is one request with fifty
 * entries rather than fifty requests — the opposite of NPPES, and the reason
 * partitioning belongs to each connector instead of to a shared helper.
 */
export function placeOfPerformanceFilters(market: MarketContext): Array<Record<string, string>> {
  switch (market.scope) {
    case 'NATIONAL':
      return (market.states.length > 0 ? market.states : US_STATES).map((state) => ({ country: 'USA', state }));
    case 'STATE':
      return (market.states.length > 0 ? market.states : market.state ? [market.state] : []).map((state) => ({
        country: 'USA',
        state,
      }));
    case 'POSTAL':
      return market.postalCodes.slice(0, 50).map((zip) => ({ country: 'USA', zip }));
    case 'CITY':
    case 'METRO':
    case 'COUNTY':
    case 'RADIUS':
    default:
      if (market.cities.length > 0 && market.state) {
        return market.cities.slice(0, 25).map((city) => ({ country: 'USA', state: market.state as string, city }));
      }
      return market.state ? [{ country: 'USA', state: market.state }] : [];
  }
}

export function toAwardRecord(
  row: NonNullable<SpendingResponse['results']>[number],
  marketName: string,
): RawRecord | null {
  const recipient = row['Recipient Name']?.trim();
  const awardId = row['Award ID']?.trim() ?? String(row.internal_id ?? '');
  if (!recipient || !awardId) return null;

  const amount = typeof row['Award Amount'] === 'number' ? row['Award Amount'] : null;
  const state = row['Place of Performance State Code'];
  const agency = row['Awarding Sub Agency'] ?? row['Awarding Agency'];
  const start = row['Start Date'] ? new Date(row['Start Date']) : undefined;
  const end = row['End Date'];
  const internal = row.generated_internal_id;

  return {
    externalId: `usaspending:${awardId}`,
    title: `Awarded facility-services contract — ${recipient}`,
    excerpt:
      `${recipient} holds a federal facility-services award` +
      `${agency ? ` from ${agency}` : ''}` +
      `${amount ? ` worth $${Math.round(amount).toLocaleString()}` : ''}` +
      `${state ? `, performed in ${state}` : ''}. ` +
      `${end ? `Period of performance ends ${end.slice(0, 10)}. ` : ''}` +
      `${(row.Description ?? '').slice(0, 400)}`.trim(),
    sourceUrl: internal
      ? `https://www.usaspending.gov/award/${encodeURIComponent(internal)}`
      : `https://www.usaspending.gov/search`,
    observedAt: start && !Number.isNaN(start.getTime()) ? start : undefined,
    // Zip then state, never "KS, KS" — the company's location row is built from
    // this string, and a city of "KS" is worse than no city at all.
    location: formatAwardLocation(row['Place of Performance Zip5'], state) ?? marketName,
    state: state ?? undefined,
    companyName: recipient,
    // The recipient won the work. They are a prime contractor who may need
    // local fulfilment — not the agency that bought it.
    subjectRole: 'PRIME_CONTRACTOR',
    describesSubject: false,
    leadRole: 'CONTRACTOR',
    segment: 'PUBLIC_SECTOR',
    category: 'SUBCONTRACTING',
    requiredService: 'Subcontracted facility services',
    whyRelevant:
      `${recipient} has already won this work and has to deliver it` +
      `${state ? ` in ${state}` : ''}` +
      `${amount ? `, against a $${Math.round(amount).toLocaleString()} award` : ''}. ` +
      `A prime holding a contract away from its own crews needs local fulfilment capacity, which is a faster route to ` +
      `revenue than bidding public work directly — the award decision is already made and the obligation is live.`,
    contact: {},
    payload: {
      awardId,
      amount,
      agency,
      endDate: end,
      placeOfPerformanceState: state,
    },
  };
}

/** Zip and state read as "75201, TX"; state alone reads as "TX", not "TX, TX". */
export function formatAwardLocation(zip: string | undefined, state: string | undefined): string | null {
  const cleanZip = zip?.trim();
  const cleanState = state?.trim();
  if (cleanZip && cleanState) return `${cleanZip}, ${cleanState}`;
  return cleanState || cleanZip || null;
}

export function readAwardNaics(
  marketConfig: Record<string, unknown>,
  sourceConfig: Record<string, unknown>,
): string[] {
  const raw = (marketConfig.awardNaics ?? sourceConfig.naics) as unknown;
  if (!Array.isArray(raw)) return DEFAULT_NAICS;
  const codes = raw.filter((c): c is string => typeof c === 'string' && /^\d{6}$/.test(c));
  return codes.length > 0 ? codes : DEFAULT_NAICS;
}
