import type { DiscoveryConnector, ConnectorContext, RawRecord } from '../connector';
import type { MarketSegment, SignalCategory, SourceType } from '@prisma/client';
import { httpJson } from '../http';

/**
 * Municipal open-data connector (Socrata / SODA).
 *
 * Two hundred-odd US city, county and state governments publish building
 * permits, certificates of occupancy and business licences through Socrata's
 * SODA API. The data is public record, the API is documented and intended for
 * programmatic access, no key is required, and there is no restriction on
 * storing what comes back. For a business that sells cleaning and facility
 * services, it is the highest-signal free source that exists: a commercial
 * tenant-improvement permit is a building that will need construction cleaning
 * on completion and recurring janitorial after that, named and dated, months
 * before anyone advertises for it.
 *
 * It is deliberately generic. Every portal exposes the same query language over
 * different datasets with different column names, so the dataset identifier and
 * a column mapping live in market configuration rather than in code. Adding
 * Fort Worth, Chicago or Seattle is configuration, not a deployment.
 *
 * @see https://dev.socrata.com/docs/endpoints.html
 * @see https://dev.socrata.com/docs/queries/
 */

/** What a market must supply for one Socrata dataset. */
export type SocrataDatasetConfig = {
  /** Portal host, e.g. "www.dallasopendata.com". */
  domain: string;
  /** Four-by-four dataset identifier, e.g. "e7gq-4sah". */
  datasetId: string;
  /** Human label used in signal headlines. */
  label: string;
  /** Column holding the record date, used for freshness filtering and ordering. */
  dateColumn: string;
  /** Column mapping. Portals agree on nothing, so every field is nameable. */
  columns: {
    description?: string;
    address?: string;
    city?: string;
    postalCode?: string;
    value?: string;
    workType?: string;
    permitNumber?: string;
    applicant?: string;
    contractor?: string;
    owner?: string;
    businessName?: string;
    status?: string;
  };
  /** Extra SoQL predicate ANDed onto the query, e.g. commercial-only filters. */
  where?: string;
  /** Overrides for this dataset. */
  segment?: MarketSegment;
  category?: SignalCategory;
  sourceType?: SourceType;
};

type SocrataRow = Record<string, unknown>;

const DEFAULT_LOOKBACK_DAYS = 45;

/**
 * Terms describing work that produces cleaning demand. A permit for a sign
 * replacement does not; a tenant finish-out for 20,000 square feet does.
 */
const RELEVANT_WORK = /tenant|finish.?out|remodel|renovat|interior|new construction|shell|build.?out|alteration|addition|occupancy|restaurant|medical|office|retail|warehouse|school|clinic/i;

const RESIDENTIAL_HINT = /single.?family|duplex|residential|dwelling|\bsfr\b|townhome|apartment unit\b/i;

export class SocrataConnector implements DiscoveryConnector {
  readonly key = 'socrata_open_data';
  readonly sourceType: SourceType = 'BUILDING_PERMIT';
  readonly defaultCategory: SignalCategory = 'BROKERAGE';
  readonly isLive = true;
  readonly requiresMarket = true;
  readonly termsUrl = 'https://dev.socrata.com/docs/endpoints.html';
  readonly accessBasis =
    'Government open-data portals published as public records through the documented SODA API, which exists for programmatic access. No key required, no rate-limit bypass, no scraping.';

  async fetch(context: ConnectorContext): Promise<RawRecord[]> {
    const market = context.market;
    if (!market) return [];

    const datasets = readDatasets(market.sourceConfig, context.config);
    if (datasets.length === 0) return [];

    const since = context.since ?? new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 86_400_000);
    const perDataset = Math.max(1, Math.floor(context.maxRecords / datasets.length));
    const records: RawRecord[] = [];
    const failures: string[] = [];

    for (const dataset of datasets) {
      if (records.length >= context.maxRecords) break;
      try {
        const rows = await queryDataset(dataset, since, perDataset, context);
        for (const row of rows) {
          const record = toRawRecord(row, dataset, market.name);
          if (record) records.push(record);
        }
      } catch (error) {
        // One misconfigured dataset must not take down the others.
        failures.push(`${dataset.domain}/${dataset.datasetId}: ${String(error).slice(0, 120)}`);
      }
    }

    // But if every dataset failed, the run did not succeed and must not be
    // recorded as healthy. A source reporting "ok" while returning nothing is
    // worse than one reporting an error: it looks like a quiet week.
    if (failures.length === datasets.length) {
      throw new Error(`All ${datasets.length} Socrata dataset(s) failed. ${failures.join(' | ')}`);
    }
    if (failures.length > 0) {
      console.error(`[socrata] ${failures.length} of ${datasets.length} dataset(s) failed: ${failures.join(' | ')}`);
    }

    return records.slice(0, context.maxRecords);
  }
}

/**
 * Builds the SoQL query.
 *
 * `$where` is the documented filter parameter. Values are quoted and escaped
 * rather than interpolated raw — the dataset configuration is operator-supplied
 * and an unescaped quote would either break the query or change its meaning.
 */
export function buildSocrataUrl(dataset: SocrataDatasetConfig, since: Date, limit: number): string {
  const clauses = [`${quoteIdent(dataset.dateColumn)} >= '${since.toISOString().slice(0, 19)}'`];
  if (dataset.where) clauses.push(`(${dataset.where})`);

  const params = new URLSearchParams({
    $where: clauses.join(' AND '),
    $order: `${dataset.dateColumn} DESC`,
    $limit: String(Math.min(limit, 1000)),
  });

  return `https://${dataset.domain}/resource/${dataset.datasetId}.json?${params.toString()}`;
}

/** SODA identifiers are lowercase alphanumeric with underscores; anything else is a config error. */
function quoteIdent(column: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(column)) {
    throw new Error(`Invalid Socrata column name "${column}". Expected letters, digits and underscores.`);
  }
  return column;
}

async function queryDataset(
  dataset: SocrataDatasetConfig,
  since: Date,
  limit: number,
  context: ConnectorContext,
): Promise<SocrataRow[]> {
  const appToken = process.env.SOCRATA_APP_TOKEN;
  const rows = await httpJson<SocrataRow[]>({
    url: buildSocrataUrl(dataset, since, limit),
    // An app token is optional and only raises the shared rate limit. The
    // connector works without one, which is why it is not a credentialEnvVar.
    headers: appToken ? { 'X-App-Token': appToken } : {},
    timeoutMs: 20_000,
    rateLimitKey: `socrata:${dataset.domain}`,
    rateLimitPerMin: context.rateLimitPerMin ?? 20,
  });
  return Array.isArray(rows) ? rows : [];
}

export function toRawRecord(
  row: SocrataRow,
  dataset: SocrataDatasetConfig,
  marketName: string,
): RawRecord | null {
  const get = (key?: string): string => {
    if (!key) return '';
    const value = row[key];
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return '';
    return String(value).trim();
  };

  const description = get(dataset.columns.description) || get(dataset.columns.workType);
  const businessName = get(dataset.columns.businessName) || get(dataset.columns.owner) || get(dataset.columns.applicant);
  const address = get(dataset.columns.address);
  const permitNumber = get(dataset.columns.permitNumber);
  const workType = get(dataset.columns.workType);
  const haystack = `${description} ${workType}`.trim();

  // A record with neither a description nor an identifiable party cannot be
  // qualified by a person later, so it is noise rather than a lead.
  if (!haystack && !businessName) return null;

  // Residential single-family work is filtered out unless the market has asked
  // for it, because it is high volume and low value for commercial cleaning.
  const isResidential = RESIDENTIAL_HINT.test(haystack);
  if (isResidential && dataset.segment !== 'RESIDENTIAL') return null;
  if (!isResidential && haystack && !RELEVANT_WORK.test(haystack)) return null;

  const dateValue = get(dataset.dateColumn);
  const observedAt = dateValue ? new Date(dateValue) : undefined;

  const valueRaw = get(dataset.columns.value).replace(/[^0-9.]/g, '');
  const value = valueRaw ? Number(valueRaw) : null;

  const city = get(dataset.columns.city) || marketName;
  const location = [address, city].filter(Boolean).join(', ') || marketName;

  return {
    externalId: permitNumber || `${dataset.datasetId}:${stableRowKey(row, dataset)}`,
    title: `${dataset.label}: ${truncate(description || workType || 'Permitted work', 110)}${businessName ? ` — ${businessName}` : ''}`,
    excerpt: buildExcerpt({ description, workType, address, city, value, businessName, status: get(dataset.columns.status), label: dataset.label }),
    sourceUrl: `https://${dataset.domain}/resource/${dataset.datasetId}.json?${new URLSearchParams(permitNumber && dataset.columns.permitNumber ? { [dataset.columns.permitNumber]: permitNumber } : {}).toString()}`,
    observedAt: observedAt && !Number.isNaN(observedAt.getTime()) ? observedAt : undefined,
    location,
    state: undefined,
    companyName: businessName || undefined,
    // A permit names the property owner or the applicant. That party is the one
    // who will need the building cleaned — they are a buyer, not a provider.
    // Getting this backwards files every lead on the wrong side of the deal.
    subjectRole: 'BUYER',
    describesSubject: false,
    leadRole: 'BUYER',
    segment: dataset.segment ?? (isResidential ? 'RESIDENTIAL' : 'COMMERCIAL'),
    category: dataset.category ?? 'BROKERAGE',
    requiredService: inferService(haystack),
    whyRelevant: explainRelevance({ workType: haystack, value, city, label: dataset.label }),
    contact: {},
    payload: { ...row, socrataDataset: dataset.datasetId, socrataDomain: dataset.domain },
  };
}

/**
 * Post-construction cleaning is the near-term sale; recurring janitorial is the
 * one worth having. Both follow from the same record, so the service named here
 * is the entry point rather than the whole opportunity.
 */
function inferService(workType: string): string {
  if (/restaurant|kitchen|food/i.test(workType)) return 'Post-construction and kitchen cleaning';
  if (/medical|clinic|dental|surgery/i.test(workType)) return 'Medical facility cleaning';
  if (/warehouse|industrial|distribution/i.test(workType)) return 'Industrial and warehouse cleaning';
  if (/school|educational|campus/i.test(workType)) return 'Educational facility cleaning';
  if (/new construction|shell|build.?out|finish.?out|tenant/i.test(workType)) return 'Post-construction cleaning';
  return 'Commercial cleaning';
}

function explainRelevance(input: { workType: string; value: number | null; city: string; label: string }): string {
  const size = input.value && input.value > 0 ? ` valued at $${Math.round(input.value).toLocaleString()}` : '';
  return (
    `${input.label} filed in ${input.city}${size}. Permitted work of this kind creates a post-construction clean on ` +
    `completion and, once occupied, recurring janitorial and consumables demand. The filing party is reachable now, ` +
    `before the work finishes and the contract is awarded.`
  );
}

function buildExcerpt(input: {
  description: string;
  workType: string;
  address: string;
  city: string;
  value: number | null;
  businessName: string;
  status: string;
  label: string;
}): string {
  const parts = [
    input.description || input.workType || input.label,
    input.address ? `Location: ${input.address}${input.city ? `, ${input.city}` : ''}.` : '',
    input.value && input.value > 0 ? `Declared valuation $${Math.round(input.value).toLocaleString()}.` : '',
    input.businessName ? `Filed by ${input.businessName}.` : '',
    input.status ? `Status: ${input.status}.` : '',
  ];
  return parts.filter(Boolean).join(' ').slice(0, 1200);
}

function stableRowKey(row: SocrataRow, dataset: SocrataDatasetConfig): string {
  const candidate =
    row[':id'] ?? row.objectid ?? row.record_id ?? `${row[dataset.dateColumn] ?? ''}-${row[dataset.columns.address ?? ''] ?? ''}`;
  return String(candidate).slice(0, 120);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Dataset configuration comes from the market first, then the source. Markets
 * differ (Dallas and Chicago publish different datasets with different column
 * names) so the market is the natural home; the source-level list is a fallback
 * for single-market deployments.
 */
export function readDatasets(
  marketConfig: Record<string, unknown>,
  sourceConfig: Record<string, unknown>,
): SocrataDatasetConfig[] {
  const raw = (marketConfig.socrata ?? sourceConfig.socrata ?? sourceConfig.datasets) as unknown;
  if (!Array.isArray(raw)) return [];

  return raw.filter(isDatasetConfig);
}

function isDatasetConfig(value: unknown): value is SocrataDatasetConfig {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.domain === 'string' &&
    typeof candidate.datasetId === 'string' &&
    typeof candidate.dateColumn === 'string' &&
    typeof candidate.label === 'string' &&
    typeof candidate.columns === 'object' &&
    candidate.columns !== null
  );
}
