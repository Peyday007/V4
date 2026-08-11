import type { DemandEventType } from '@prisma/client';
import { httpJson } from '@/lib/discovery/http';
import { cleanCity, cleanState } from '@/lib/discovery/identity';
import type { RawDemandEvent } from '../events';
import {
  AllRequestsFailedError,
  NotConfiguredError,
  type DemandConnector,
  type DemandFetchContext,
  type DemandFetchResult,
} from '../connector';

/**
 * Local solicitations, bids and vendor requests.
 *
 * Cities, counties, school districts, transit authorities and housing
 * authorities publish what they are currently buying, with a closing date, on
 * the same open-data portals that publish licences. That is Tier A demand —
 * somebody has asked — and it is local, which is the whole point: this is the
 * automatic route to active demand that does not go anywhere near federal
 * contracting.
 *
 * The connector filters to the trade rather than ingesting every notice a city
 * publishes. A solicitation for asphalt is not this business, and admitting it
 * so the board looks busy is how a pipeline fills with work nobody can do.
 *
 * Two event types come out of one dataset, and the distinction matters:
 *
 *   a bid with a closing date        → ACTIVE_RFQ / ACTIVE_RFP
 *   a standing vendor-list request   → VENDOR_REQUEST
 *
 * The first has a deadline and expires. The second is an invitation to
 * register, which is worth far less and must not be presented as an open job.
 */

export type SolicitationDataset = {
  domain: string;
  datasetId: string;
  label: string;
  state: string;
  /** The date the notice was published. */
  dateColumn: string;
  columns: {
    title?: string;
    description?: string;
    /** The buying organisation, where the portal names one. */
    agency?: string;
    /** Closing or response date. Its absence is not fatal; its passing is. */
    closeDate?: string;
    naturalKey?: string;
    /** Bid, RFP, RFQ, sources-sought — used to pick the event type. */
    noticeType?: string;
    status?: string;
    city?: string;
    estimatedValue?: string;
    url?: string;
  };
  where?: string;
};

/**
 * Words that mean this notice is about cleaning or janitorial supply.
 *
 * Kept explicit rather than fuzzy: a solicitation is expensive to chase, and
 * a false positive costs a person an afternoon reading a document about
 * something else entirely.
 */
const TRADE_TERMS =
  /\b(janitorial|custodial|cleaning|housekeeping|porter|day\s*porter|sanitation|disinfect|floor\s*care|carpet\s*care|window\s*cleaning|restroom|paper\s*products|can\s*liners|trash\s*liners|cleaning\s*suppl|janitorial\s*suppl)\b/i;

/** Notices that are about supply rather than a service crew. */
const SUPPLY_TERMS = /\b(suppl|product|consumable|paper|liner|chemical|dispenser|equipment|purchase)\b/i;

/** Standing vendor lists rather than an open job with a deadline. */
const VENDOR_LIST_TERMS = /\b(vendor\s*list|vendor\s*registration|prequalif|pre-?qualif|sources\s*sought|rfi|request\s*for\s*information|supplier\s*registration)\b/i;

/**
 * Jurisdictions shipped as defaults.
 *
 * Real, public, no-key Socrata datasets. Dataset identifiers change when a
 * city republishes, so a failure names the URL it tried and the deployed probe
 * reports exactly which one broke. None has been verified from this
 * environment, which has no egress.
 */
export const DEFAULT_SOLICITATION_DATASETS: SolicitationDataset[] = [
  {
    domain: 'data.cityofchicago.org',
    datasetId: 'rsxa-ify5',
    label: 'Chicago contracts and solicitations',
    state: 'IL',
    dateColumn: 'approval_date',
    columns: {
      title: 'purchase_order_description',
      description: 'purchase_order_description',
      agency: 'department',
      naturalKey: 'purchase_order_contract_number',
      estimatedValue: 'award_amount',
    },
  },
  {
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
      status: 'status',
    },
  },
  {
    domain: 'data.austintexas.gov',
    datasetId: 'sdmv-cwsk',
    label: 'Austin solicitations',
    state: 'TX',
    dateColumn: 'issue_date',
    columns: {
      title: 'title',
      description: 'description',
      agency: 'department',
      closeDate: 'due_date',
      naturalKey: 'solicitation_number',
      noticeType: 'solicitation_type',
      status: 'status',
    },
  },
];

type Row = Record<string, unknown>;
const DEFAULT_LOOKBACK_DAYS = 60;

export class MunicipalSolicitationsConnector implements DemandConnector {
  readonly key = 'municipal_solicitations';
  readonly name = 'Local bids, solicitations and vendor requests';
  readonly accessBasis =
    'City and county procurement notices published as public record through the documented SODA API. No key ' +
    'required, no authentication bypassed, no scraping.';
  readonly termsUrl = 'https://dev.socrata.com/docs/endpoints.html';
  readonly credentialEnvVar = null;
  readonly requiresJurisdictionConfig = true;
  readonly eventFamilies = [
    'Active solicitations, RFQs and bids',
    'Vendor and supplier registration requests',
    'Supply procurement',
  ];
  readonly pollIntervalMinutes = 4 * 60;

  async fetch(context: DemandFetchContext): Promise<DemandFetchResult> {
    const datasets = readSolicitationDatasets(context.config);
    if (datasets.length === 0) {
      throw new NotConfiguredError(
        this.key,
        'no procurement portals are configured',
        'Add a dataset under the source configuration, or restore the shipped defaults from Administration → Data sources.',
      );
    }

    const covering = context.states.length
      ? datasets.filter((d) => context.states.includes(d.state.toUpperCase()))
      : datasets;
    if (covering.length === 0) {
      throw new NotConfiguredError(
        this.key,
        `no configured portal covers ${context.states.join(', ')}`,
        'Configured portals: ' + datasets.map((d) => `${d.label} (${d.state})`).join(', ') + '.',
      );
    }

    const since = context.since ?? new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 86_400_000);
    const perDataset = Math.max(20, Math.floor(context.maxRecords / covering.length));

    const events: RawDemandEvent[] = [];
    const failures: string[] = [];
    let recordsExamined = 0;
    let newest: Date | null = null;

    for (const dataset of covering) {
      if (events.length >= context.maxRecords) break;
      try {
        const rows = await queryDataset(dataset, since, perDataset, context);
        recordsExamined += rows.length;
        for (const row of rows) {
          const event = toSolicitationEvent(row, dataset);
          if (!event) continue;
          if (event.eventDate && (!newest || event.eventDate > newest)) newest = event.eventDate;
          events.push(event);
        }
      } catch (error) {
        failures.push(`${dataset.label} (${dataset.domain}/${dataset.datasetId}): ${String(error).slice(0, 160)}`);
      }
    }

    if (failures.length === covering.length) throw new AllRequestsFailedError(this.key, failures);

    return {
      events: events.slice(0, context.maxRecords),
      recordsExamined,
      nextCursor: newest ? newest.toISOString() : context.cursor,
      warnings: failures,
    };
  }
}

export function readSolicitationDatasets(config: Record<string, unknown>): SolicitationDataset[] {
  const raw = config.solicitationDatasets;
  if (!Array.isArray(raw)) return DEFAULT_SOLICITATION_DATASETS;
  const parsed = raw.filter(
    (d): d is SolicitationDataset =>
      Boolean(d) && typeof (d as SolicitationDataset).domain === 'string' && typeof (d as SolicitationDataset).datasetId === 'string',
  );
  return parsed.length > 0 ? parsed : DEFAULT_SOLICITATION_DATASETS;
}

export function buildSolicitationUrl(dataset: SolicitationDataset, since: Date, limit: number): string {
  const clauses = [`${ident(dataset.dateColumn)} >= '${since.toISOString().slice(0, 19)}'`];
  if (dataset.where) clauses.push(`(${dataset.where})`);
  const params = new URLSearchParams({
    $where: clauses.join(' AND '),
    $order: `${dataset.dateColumn} DESC`,
    $limit: String(Math.min(limit, 1000)),
  });
  return `https://${dataset.domain}/resource/${dataset.datasetId}.json?${params.toString()}`;
}

function ident(column: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(column)) throw new Error(`Invalid column name "${column}".`);
  return column;
}

async function queryDataset(
  dataset: SolicitationDataset,
  since: Date,
  limit: number,
  context: DemandFetchContext,
): Promise<Row[]> {
  const appToken = process.env.SOCRATA_APP_TOKEN;
  const rows = await httpJson<Row[]>({
    url: buildSolicitationUrl(dataset, since, limit),
    headers: appToken ? { 'X-App-Token': appToken } : {},
    timeoutMs: 20_000,
    rateLimitKey: `socrata:${dataset.domain}`,
    rateLimitPerMin: context.rateLimitPerMin ?? 20,
  });
  if (!Array.isArray(rows)) {
    throw new Error('Portal returned something that is not a row array; the dataset may have been republished.');
  }
  return rows;
}

/**
 * One notice becomes one event, or nothing.
 *
 * Filters on the trade first. A city publishes hundreds of notices a month and
 * almost none are cleaning; admitting the rest so the board looks busy costs a
 * person an afternoon per false positive.
 */
export function toSolicitationEvent(row: Row, dataset: SolicitationDataset): RawDemandEvent | null {
  const get = (column?: string): string => {
    if (!column) return '';
    const value = row[column];
    return typeof value === 'string' ? value.trim() : value == null ? '' : String(value);
  };

  const title = get(dataset.columns.title);
  const description = get(dataset.columns.description);
  const haystack = `${title} ${description}`;
  if (!TRADE_TERMS.test(haystack)) return null;

  const rawDate = get(dataset.dateColumn);
  const eventDate = rawDate ? new Date(rawDate) : null;
  // No publication date means no way to say whether the notice is live.
  if (!eventDate || Number.isNaN(eventDate.getTime())) return null;

  const closeRaw = get(dataset.columns.closeDate);
  const deadlineAt = closeRaw ? new Date(closeRaw) : null;

  const agency = get(dataset.columns.agency);
  if (!agency) return null;

  const naturalKey = get(dataset.columns.naturalKey) || null;
  const noticeType = get(dataset.columns.noticeType);
  const valueRaw = get(dataset.columns.estimatedValue).replace(/[^0-9.]/g, '');
  const estimatedValue = valueRaw ? Number(valueRaw) : null;

  // A standing vendor list is an invitation to register, not an open job. It
  // gets its own event type so it can never be presented as active demand
  // with a deadline it does not have.
  const isVendorList = VENDOR_LIST_TERMS.test(`${haystack} ${noticeType}`);
  const type: DemandEventType = isVendorList
    ? 'VENDOR_REQUEST'
    : /\brfp\b|proposal/i.test(`${noticeType} ${title}`)
      ? 'ACTIVE_RFP'
      : 'ACTIVE_RFQ';

  const isSupply = SUPPLY_TERMS.test(haystack) && !/\bservice[s]?\b|\bcrew\b|\bcontract\s*clean/i.test(haystack);

  return {
    type,
    sourceRecordId: naturalKey ?? `${dataset.datasetId}:${stableKey(row, dataset)}`,
    sourceUrl:
      get(dataset.columns.url) ||
      (naturalKey && dataset.columns.naturalKey
        ? `https://${dataset.domain}/resource/${dataset.datasetId}.json?${dataset.columns.naturalKey}=${encodeURIComponent(naturalKey)}`
        : `https://${dataset.domain}/resource/${dataset.datasetId}.json`),
    headline: `${agency} — ${title.slice(0, 160)}`,
    summary: description || title,
    eventDate,
    deadlineAt: deadlineAt && !Number.isNaN(deadlineAt.getTime()) ? deadlineAt : null,
    // The buying organisation's own city where the portal gives one; otherwise
    // absent. The portal's jurisdiction is not the notice's location.
    cityName: cleanCity(get(dataset.columns.city)),
    stateCode: cleanState(dataset.state),
    postalCode: null,
    addressLine1: null,
    parties: [{ role: 'BUYER', name: agency }],
    confirmedFacts: [
      `${dataset.label} published this on ${eventDate.toISOString().slice(0, 10)}`,
      ...(naturalKey ? [`Notice number: ${naturalKey}`] : []),
      ...(deadlineAt && !Number.isNaN(deadlineAt.getTime())
        ? [`Responses close ${deadlineAt.toISOString().slice(0, 10)}`]
        : []),
      ...(noticeType ? [`Notice type as published: ${noticeType}`] : []),
      ...(estimatedValue ? [`Value stated by the source: $${estimatedValue.toLocaleString()}`] : []),
      `Text matched the trade: ${title.slice(0, 140)}`,
    ],
    // What the notice implies about which of our routes fits is ours, and is
    // recorded as ours.
    inferredFacts: [
      isSupply
        ? 'Reads as a supply purchase rather than a service crew, so the distribution route fits better than brokerage.'
        : 'Reads as a service requirement rather than a product purchase.',
      ...(isVendorList
        ? ['This is a standing vendor list, not an open job. Registering is worth doing; it is not a deal.']
        : []),
    ],
    confidence: naturalKey ? 0.9 : 0.7,
    relatedCapabilities: isSupply ? ['Janitorial consumables'] : ['Commercial janitorial'],
    rawPayload: { ...row, __dataset: dataset.datasetId, __domain: dataset.domain, __isSupply: isSupply },
    naturalKey,
  };
}

function stableKey(row: Row, dataset: SolicitationDataset): string {
  return [dataset.columns.title && row[dataset.columns.title], row[dataset.dateColumn]]
    .filter(Boolean)
    .map((v) => String(v).toLowerCase().replace(/\s+/g, ''))
    .join('|')
    .slice(0, 120);
}
