import type { DemandEventType } from '@prisma/client';
import { httpJson } from '@/lib/discovery/http';
import { cleanCity, cleanState } from '@/lib/discovery/identity';
import type { RawDemandEvent } from '../events';
import {
  AllRequestsFailedError,
  DropTally,
  NotConfiguredError,
  type DemandConnector,
  type DemandFetchContext,
  type DemandFetchResult,
  type SourceScopeReport,
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
  /**
   * What a row in this dataset actually is.
   *
   * This distinction was missing and it mattered more than anything else in the
   * file. Procurement portals publish two quite different tables under similar
   * names: notices of what a body intends to buy, and the register of contracts
   * it has already awarded. Chicago's `rsxa-ify5` is the second — approved
   * purchase orders, with an approval date and an award amount and no closing
   * date anywhere in it.
   *
   * Read as a solicitation, every row in it became an `ACTIVE_RFQ` with a null
   * deadline: a contract signed two years ago, presented on the board as an
   * open job somebody could still bid for. That is manufactured demand, arrived
   * at by mislabelling rather than by invention, and it is no better for it.
   *
   * An awarded row is emitted as `CONTRACT_AWARD` instead, which already means
   * "somebody holds this work" everywhere downstream and carries no deadline to
   * be wrong about.
   */
  publishes?: 'OPEN_SOLICITATION' | 'AWARDED_CONTRACT';
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
    /** Who won it. Award registers only; absent from an open notice by nature. */
    awardee?: string;
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
    label: 'Chicago awarded contracts',
    state: 'IL',
    dateColumn: 'approval_date',
    // An award register, not a notice board. See `publishes` above.
    publishes: 'AWARDED_CONTRACT',
    columns: {
      title: 'purchase_order_description',
      description: 'purchase_order_description',
      agency: 'department',
      awardee: 'vendor_name',
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
    const funnel: SourceScopeReport[] = [];
    let recordsExamined = 0;
    let newest: Date | null = null;

    for (const dataset of covering) {
      if (events.length >= context.maxRecords) break;
      const scope = `${dataset.label} (${dataset.domain}/${dataset.datasetId})`;
      const url = buildSolicitationUrl(dataset, since, perDataset);
      const tally = new DropTally();
      try {
        const rows = await queryDataset(dataset, since, perDataset, context);
        recordsExamined += rows.length;
        let accepted = 0;
        for (const row of rows) {
          const event = toSolicitationEvent(row, dataset, tally);
          if (!event) continue;
          accepted += 1;
          if (event.eventDate && (!newest || event.eventDate > newest)) newest = event.eventDate;
          events.push(event);
        }
        funnel.push({ scope, url, fetched: rows.length, accepted, drops: tally.entries(), failure: null });
      } catch (error) {
        failures.push(`${scope}: ${String(error).slice(0, 160)}`);
        funnel.push({ scope, url, fetched: 0, accepted: 0, drops: [], failure: String(error).slice(0, 300) });
      }
    }

    if (failures.length === covering.length) throw new AllRequestsFailedError(this.key, failures);

    return {
      events: events.slice(0, context.maxRecords),
      recordsExamined,
      nextCursor: newest ? newest.toISOString() : context.cursor,
      warnings: failures,
      funnel,
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
export function toSolicitationEvent(
  row: Row,
  dataset: SolicitationDataset,
  tally: DropTally = new DropTally(),
): RawDemandEvent | null {
  const get = (column?: string): string => {
    if (!column) return '';
    const value = row[column];
    return typeof value === 'string' ? value.trim() : value == null ? '' : String(value);
  };

  const awarded = dataset.publishes === 'AWARDED_CONTRACT';

  const title = get(dataset.columns.title);
  const description = get(dataset.columns.description);
  const haystack = `${title} ${description}`;
  if (!title && !description) {
    return tally.drop(
      `neither "${dataset.columns.title ?? '-'}" nor "${dataset.columns.description ?? '-'}" is present`,
      `columns present: ${Object.keys(row).slice(0, 12).join(', ')}`,
    );
  }
  if (!TRADE_TERMS.test(haystack)) {
    return tally.drop('not a cleaning or janitorial notice', title.slice(0, 90) || description.slice(0, 90));
  }

  const rawDate = get(dataset.dateColumn);
  const eventDate = rawDate ? new Date(rawDate) : null;
  // No publication date means no way to say whether the notice is live.
  if (!rawDate) {
    return tally.drop(
      `the row has no "${dataset.dateColumn}"`,
      `columns present: ${Object.keys(row).slice(0, 12).join(', ')}`,
    );
  }
  if (!eventDate || Number.isNaN(eventDate.getTime())) {
    return tally.drop(`"${dataset.dateColumn}" is not a date`, rawDate);
  }

  const closeRaw = get(dataset.columns.closeDate);
  const parsedClose = closeRaw ? new Date(closeRaw) : null;
  // An award register has no closing date and must not be given one.
  const deadlineAt = awarded ? null : parsedClose && !Number.isNaN(parsedClose.getTime()) ? parsedClose : null;

  const agency = get(dataset.columns.agency);
  if (!agency) {
    return tally.drop(
      `no buying organisation in "${dataset.columns.agency ?? '-'}"`,
      `columns present: ${Object.keys(row).slice(0, 12).join(', ')}`,
    );
  }

  const awardee = get(dataset.columns.awardee);
  if (awarded && !awardee) {
    // Without the winner there is no capacity hypothesis to make and no party
    // to ring. Better to drop it and say so than to file the buying department
    // as though it were the contractor.
    return tally.drop(
      `award register row with no vendor in "${dataset.columns.awardee ?? '-'}"`,
      `columns present: ${Object.keys(row).slice(0, 12).join(', ')}`,
    );
  }

  const naturalKey = get(dataset.columns.naturalKey) || null;
  const noticeType = get(dataset.columns.noticeType);
  const valueRaw = get(dataset.columns.estimatedValue).replace(/[^0-9.]/g, '');
  const estimatedValue = valueRaw ? Number(valueRaw) : null;

  // A standing vendor list is an invitation to register, not an open job. It
  // gets its own event type so it can never be presented as active demand
  // with a deadline it does not have.
  const isVendorList = !awarded && VENDOR_LIST_TERMS.test(`${haystack} ${noticeType}`);
  const type: DemandEventType = awarded
    ? 'CONTRACT_AWARD'
    : isVendorList
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
    headline: awarded
      ? `${awardee} — ${agency} facility-services contract`
      : `${agency} — ${title.slice(0, 160)}`,
    summary: description || title,
    eventDate,
    deadlineAt,
    // The buying organisation's own city where the portal gives one; otherwise
    // absent. The portal's jurisdiction is not the notice's location.
    cityName: cleanCity(get(dataset.columns.city)),
    stateCode: cleanState(dataset.state),
    postalCode: null,
    addressLine1: null,
    // Who plays what part differs entirely between the two tables. On an open
    // notice the department is the buyer. On an award register the department
    // is the authority that issued it and the vendor is the one holding the
    // work — filing that vendor as a buyer would put a cleaning contractor on
    // the board as somebody who needs cleaning.
    parties: awarded
      ? [
          { role: 'PRIME_CONTRACTOR' as const, name: awardee },
          { role: 'ISSUING_AUTHORITY' as const, name: agency },
        ]
      : [{ role: 'BUYER' as const, name: agency }],
    confirmedFacts: awarded
      ? [
          `${dataset.label} records this contract as approved on ${eventDate.toISOString().slice(0, 10)}`,
          `Awarded to ${awardee} by ${agency}`,
          ...(naturalKey ? [`Contract number: ${naturalKey}`] : []),
          ...(estimatedValue ? [`Award amount stated by the source: $${estimatedValue.toLocaleString()}`] : []),
          `Text matched the trade: ${title.slice(0, 140)}`,
        ]
      : [
          `${dataset.label} published this on ${eventDate.toISOString().slice(0, 10)}`,
          ...(naturalKey ? [`Notice number: ${naturalKey}`] : []),
          ...(deadlineAt ? [`Responses close ${deadlineAt.toISOString().slice(0, 10)}`] : []),
          ...(noticeType ? [`Notice type as published: ${noticeType}`] : []),
          ...(estimatedValue ? [`Value stated by the source: $${estimatedValue.toLocaleString()}`] : []),
          `Text matched the trade: ${title.slice(0, 140)}`,
        ],
    // What the notice implies about which of our routes fits is ours, and is
    // recorded as ours.
    inferredFacts: awarded
      ? [
          'This is an awarded contract, not an open job. It says who holds the work; '
            + 'whether they need local capacity is a separate question for a playbook to put.',
        ]
      : [
          isSupply
            ? 'Reads as a supply purchase rather than a service crew, so the distribution route fits better than brokerage.'
            : 'Reads as a service requirement rather than a product purchase.',
          ...(isVendorList
            ? ['This is a standing vendor list, not an open job. Registering is worth doing; it is not a deal.']
            : []),
        ],
    confidence: naturalKey ? 0.9 : 0.7,
    relatedCapabilities: isSupply ? ['Janitorial consumables'] : ['Commercial janitorial'],
    rawPayload: {
      ...row,
      __dataset: dataset.datasetId,
      __domain: dataset.domain,
      __isSupply: isSupply,
      __publishes: dataset.publishes ?? 'OPEN_SOLICITATION',
    },
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
