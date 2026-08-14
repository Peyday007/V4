import type { DemandEventType, EventPartyRole } from '@prisma/client';
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
 * Municipal open data as a demand source.
 *
 * This is the workhorse, and it is the reason the engine does not depend on
 * federal contracting. Cities publish, as public record and through a
 * documented API with no key:
 *
 *   - business licences, whose issue date is when a business is allowed to
 *     start operating — the closest public proxy for "opening"
 *   - certificates of occupancy, which say a building may now be used
 *   - building permits, whose completion or final-inspection date says a fit-out
 *     is finishing
 *
 * Each of those is a *dated event about a specific address*, which is exactly
 * what the category-matching model could never produce. A new business licence
 * issued last week at a named address is not a guess that somebody might need
 * cleaning; it is a statement that a business is about to start operating
 * there, with a date attached.
 *
 * What this connector deliberately does not do is infer. It maps a dataset to
 * an event type declared in configuration, keeps the source's own date and
 * address, and records the licence description verbatim. Whether a new fitness
 * studio needs a final clean is a playbook's judgement, made downstream and
 * labelled as inference.
 */

export type JurisdictionDataset = {
  /** Portal host, e.g. "data.cityofchicago.org". */
  domain: string;
  /** Four-by-four dataset identifier. */
  datasetId: string;
  label: string;
  /** What kind of event a row in this dataset represents. */
  eventType: DemandEventType;
  /** The state this jurisdiction sits in. A dataset property, not a search scope. */
  state: string;
  /** Column carrying the date the event happened, per the source. */
  dateColumn: string;
  columns: {
    /** Business or applicant legal name. */
    name?: string;
    /** Trading name, where the portal separates them. */
    doingBusinessAs?: string;
    address?: string;
    city?: string;
    zip?: string;
    description?: string;
    /** Source-issued identifier: licence number, permit number. */
    naturalKey?: string;
    status?: string;
    /** Square footage or valuation, used only as a scale hint. */
    scale?: string;
    /** Contractor or applicant distinct from the business itself. */
    applicant?: string;
  };
  /** Extra SoQL predicate, e.g. commercial-only or issued-status filters. */
  where?: string;
  /**
   * The part the named organisation plays. A business licence names the
   * business; a construction permit frequently names the contractor, and
   * filing them both as "buyer" is how a cleaning contractor ends up on the
   * board as somebody who needs cleaning.
   */
  primaryRole: EventPartyRole;
  /**
   * The part the separate contractor column plays, where the portal has one.
   * Without this the contractor and the owner collapse into a single role and
   * the record loses the distinction that decides who to sell to.
   */
  contractorRole?: EventPartyRole;
};

/**
 * Jurisdictions shipped as defaults.
 *
 * Every one is a real, public, no-key Socrata dataset. Dataset identifiers do
 * change when a city republishes, so the connector fails loudly with the URL it
 * tried rather than returning nothing, and the deployed probe reports exactly
 * which jurisdiction is broken. Nothing here is claimed to have been verified
 * against the live portal from this environment — the sandbox has no egress.
 */
export const DEFAULT_JURISDICTIONS: JurisdictionDataset[] = [
  {
    domain: 'data.cityofchicago.org',
    datasetId: 'r5kz-chrr',
    label: 'Chicago business licences',
    eventType: 'OCCUPANCY_OR_OPERATING_APPROVAL',
    state: 'IL',
    dateColumn: 'license_start_date',
    columns: {
      name: 'legal_name',
      doingBusinessAs: 'doing_business_as_name',
      address: 'address',
      city: 'city',
      zip: 'zip_code',
      description: 'license_description',
      naturalKey: 'license_number',
      status: 'license_status',
    },
    // Issued licences only. An application is not permission to operate.
    where: "license_status = 'AAI'",
    primaryRole: 'BUYER',
  },
  {
    domain: 'data.sfgov.org',
    datasetId: 'g8m3-pdis',
    label: 'San Francisco registered business locations',
    eventType: 'NEW_LOCATION',
    state: 'CA',
    dateColumn: 'location_start_date',
    columns: {
      name: 'ownership_name',
      doingBusinessAs: 'dba_name',
      address: 'street_address',
      city: 'city',
      zip: 'source_zipcode',
      description: 'naic_code_description',
      naturalKey: 'location_id',
    },
    primaryRole: 'BUYER',
  },
  {
    domain: 'data.seattle.gov',
    datasetId: 'wnbq-64tb',
    label: 'Seattle business licence tax certificates',
    eventType: 'OCCUPANCY_OR_OPERATING_APPROVAL',
    state: 'WA',
    dateColumn: 'license_start_date',
    columns: {
      name: 'legal_name',
      doingBusinessAs: 'trade_name',
      address: 'business_address',
      city: 'city',
      zip: 'zip',
      description: 'naics_description',
      naturalKey: 'business_license_number',
    },
    primaryRole: 'BUYER',
  },
  {
    domain: 'data.austintexas.gov',
    datasetId: '3syk-w9eu',
    label: 'Austin issued construction permits',
    eventType: 'RENOVATION_OR_CONSTRUCTION',
    state: 'TX',
    dateColumn: 'issued_date',
    columns: {
      name: 'applicant_organization',
      address: 'original_address1',
      city: 'original_city',
      zip: 'original_zip',
      description: 'description',
      naturalKey: 'permit_number',
      scale: 'total_new_add_sqft',
      applicant: 'contractor_company_name',
      status: 'status_current',
    },
    // Commercial work only. A residential remodel is not this business.
    where: "upper(permit_class_mapped) = 'COMMERCIAL'",
    // Austin publishes the applicant organisation and the contractor in
    // separate columns, so the organisation is the party the work is *for*.
    // Where a portal gives only one name, it is the contractor, and filing
    // them as a buyer would put a building firm on the board as somebody who
    // needs cleaning.
    primaryRole: 'PROPERTY_OWNER',
    contractorRole: 'PRIME_CONTRACTOR',
  },
  {
    domain: 'www.dallasopendata.com',
    datasetId: 'e7gq-4sah',
    label: 'Dallas building permits',
    eventType: 'RENOVATION_OR_CONSTRUCTION',
    state: 'TX',
    dateColumn: 'issued_date',
    columns: {
      name: 'contractor_name',
      address: 'address',
      description: 'work_description',
      naturalKey: 'permit_number',
      scale: 'estimated_cost',
    },
    primaryRole: 'APPLICANT',
  },
];

type Row = Record<string, unknown>;

const DEFAULT_LOOKBACK_DAYS = 45;

export class MunicipalOpenDataConnector implements DemandConnector {
  readonly key = 'municipal_open_data';
  readonly name = 'Municipal open data (licences, occupancy, permits)';
  readonly accessBasis =
    'City open-data portals published as public record through the documented SODA API. No key required, ' +
    'no authentication bypassed, no scraping, no terms circumvented.';
  readonly termsUrl = 'https://dev.socrata.com/docs/endpoints.html';
  readonly credentialEnvVar = null;
  readonly requiresJurisdictionConfig = true;
  readonly eventFamilies = [
    'Facility openings, occupancy and operating approval',
    'Renovation and construction',
    'New locations',
  ];
  readonly pollIntervalMinutes = 6 * 60;

  async fetch(context: DemandFetchContext): Promise<DemandFetchResult> {
    const jurisdictions = readJurisdictions(context.config);
    if (jurisdictions.length === 0) {
      throw new NotConfiguredError(
        this.key,
        'no jurisdictions are configured',
        'Add at least one entry under the source configuration, or restore the shipped defaults from Administration → Data sources.',
      );
    }

    const covering = context.states.length
      ? jurisdictions.filter((j) => context.states.includes(j.state.toUpperCase()))
      : jurisdictions;

    if (covering.length === 0) {
      throw new NotConfiguredError(
        this.key,
        `no configured jurisdiction covers ${context.states.join(', ')}`,
        'Configured portals are: ' + jurisdictions.map((j) => `${j.label} (${j.state})`).join(', ') + '.',
      );
    }

    const since = context.since ?? new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 86_400_000);
    const perDataset = Math.max(5, Math.floor(context.maxRecords / covering.length));

    const events: RawDemandEvent[] = [];
    const failures: string[] = [];
    const warnings: string[] = [];
    const funnel: SourceScopeReport[] = [];
    let recordsExamined = 0;
    let newestSeen: Date | null = null;

    for (const jurisdiction of covering) {
      if (events.length >= context.maxRecords) break;
      const scope = `${jurisdiction.label} (${jurisdiction.domain}/${jurisdiction.datasetId})`;
      const url = buildQueryUrl(jurisdiction, since, perDataset);
      const tally = new DropTally();
      try {
        const rows = await queryDataset(jurisdiction, since, perDataset, context);
        recordsExamined += rows.length;
        let accepted = 0;
        for (const row of rows) {
          const event = toDemandEvent(row, jurisdiction, tally);
          if (!event) continue;
          accepted += 1;
          if (event.eventDate && (!newestSeen || event.eventDate > newestSeen)) newestSeen = event.eventDate;
          events.push(event);
        }
        funnel.push({ scope, url, fetched: rows.length, accepted, drops: tally.entries(), failure: null });
      } catch (error) {
        // One republished dataset must not take down the others, but the
        // failure is named so it can be fixed rather than absorbed.
        failures.push(`${scope}: ${String(error).slice(0, 160)}`);
        funnel.push({
          scope, url, fetched: 0, accepted: 0, drops: [], failure: String(error).slice(0, 300),
        });
      }
    }

    if (failures.length === covering.length) {
      throw new AllRequestsFailedError(this.key, failures);
    }
    warnings.push(...failures);

    return {
      events: events.slice(0, context.maxRecords),
      recordsExamined,
      // The cursor is the newest *source* date seen, never the time this ran.
      nextCursor: newestSeen ? newestSeen.toISOString() : context.cursor,
      warnings,
      funnel,
    };
  }
}

export function readJurisdictions(config: Record<string, unknown>): JurisdictionDataset[] {
  const raw = config.jurisdictions;
  if (!Array.isArray(raw)) return DEFAULT_JURISDICTIONS;
  const parsed = raw.filter(
    (j): j is JurisdictionDataset =>
      Boolean(j) &&
      typeof (j as JurisdictionDataset).domain === 'string' &&
      typeof (j as JurisdictionDataset).datasetId === 'string' &&
      typeof (j as JurisdictionDataset).dateColumn === 'string',
  );
  return parsed.length > 0 ? parsed : DEFAULT_JURISDICTIONS;
}

/**
 * Builds the SoQL query.
 *
 * Ordered by the source's own date descending and filtered from `since`, so a
 * repeated run re-reads only what is new. Column names are validated rather
 * than interpolated raw: the configuration is operator-supplied.
 */
export function buildQueryUrl(dataset: JurisdictionDataset, since: Date, limit: number): string {
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
  if (!/^[a-z_][a-z0-9_]*$/i.test(column)) {
    throw new Error(`Invalid column name "${column}". SODA identifiers are letters, digits and underscores.`);
  }
  return column;
}

async function queryDataset(
  dataset: JurisdictionDataset,
  since: Date,
  limit: number,
  context: DemandFetchContext,
): Promise<Row[]> {
  const appToken = process.env.SOCRATA_APP_TOKEN;
  const rows = await httpJson<Row[]>({
    url: buildQueryUrl(dataset, since, limit),
    // Optional, and only raises a shared rate limit. Not a credential the
    // connector needs to function, which is why it is not declared as one.
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
 * One row becomes one event, or nothing.
 *
 * Returns null rather than filling gaps. A row with no date cannot support a
 * tier-A or tier-B claim and there is nothing to be gained by admitting it
 * with today's date standing in.
 *
 * Every rejection is counted against a named reason. A dataset that republishes
 * `license_start_date` under a new name goes from producing hundreds of events
 * to producing none, and without the tally that shows up as an empty board with
 * no explanation — which is exactly the failure this connector was returning
 * before anybody thought to count.
 */
export function toDemandEvent(
  row: Row,
  dataset: JurisdictionDataset,
  tally: DropTally = new DropTally(),
): RawDemandEvent | null {
  const get = (column?: string): string => {
    if (!column) return '';
    const value = row[column];
    return typeof value === 'string' ? value.trim() : value == null ? '' : String(value);
  };

  const rawDate = get(dataset.dateColumn);
  const eventDate = rawDate ? new Date(rawDate) : null;
  // No usable source date means no event. This is the rule the old pipeline
  // broke by falling back to ingestion time.
  if (!rawDate) {
    return tally.drop(
      `the row has no "${dataset.dateColumn}"`,
      `columns present: ${Object.keys(row).slice(0, 12).join(', ')}`,
    );
  }
  if (!eventDate || Number.isNaN(eventDate.getTime())) {
    return tally.drop(`"${dataset.dateColumn}" is not a date`, rawDate);
  }

  const legalName = get(dataset.columns.name);
  const dba = get(dataset.columns.doingBusinessAs);
  const name = dba || legalName;
  if (!name || name.length < 3) {
    return tally.drop(
      `no usable name in "${dataset.columns.doingBusinessAs ?? '-'}" or "${dataset.columns.name ?? '-'}"`,
      `columns present: ${Object.keys(row).slice(0, 12).join(', ')}`,
    );
  }

  const address = get(dataset.columns.address);
  const description = get(dataset.columns.description);
  const naturalKey = get(dataset.columns.naturalKey) || null;
  const scaleRaw = get(dataset.columns.scale).replace(/[^0-9.]/g, '');
  const scale = scaleRaw ? Number(scaleRaw) : null;

  const parties: RawDemandEvent['parties'] = [{ role: dataset.primaryRole, name }];
  // A permit's contractor and the business at the address are different
  // organisations with different parts to play.
  const applicant = get(dataset.columns.applicant);
  if (applicant && applicant !== name) {
    parties.push({ role: dataset.contractorRole ?? 'APPLICANT', name: applicant });
  }
  if (legalName && dba && legalName !== dba) parties.push({ role: 'PROPERTY_OWNER', name: legalName });

  const confirmedFacts = [
    `${dataset.label} records ${name} with a ${dataset.dateColumn.replace(/_/g, ' ')} of ${eventDate.toISOString().slice(0, 10)}`,
    ...(address ? [`Address on the record: ${address}`] : []),
    ...(description ? [`Described by the source as: ${description}`] : []),
    ...(naturalKey ? [`Source identifier: ${naturalKey}`] : []),
    ...(scale ? [`Scale figure published by the source: ${scale.toLocaleString()}`] : []),
  ];

  return {
    type: dataset.eventType,
    sourceRecordId: naturalKey ?? `${dataset.datasetId}:${stableRowKey(row, dataset)}`,
    sourceUrl: naturalKey
      ? `https://${dataset.domain}/resource/${dataset.datasetId}.json?${dataset.columns.naturalKey}=${encodeURIComponent(naturalKey)}`
      : `https://${dataset.domain}/resource/${dataset.datasetId}.json`,
    headline: `${name} — ${dataset.label}`,
    summary: description
      ? `${description}. Recorded by ${dataset.label} on ${eventDate.toISOString().slice(0, 10)}.`
      : `Recorded by ${dataset.label} on ${eventDate.toISOString().slice(0, 10)}.`,
    eventDate,
    // The city's own address fields. There is no market or anchor fallback
    // here, and a missing city stays missing.
    cityName: cleanCity(get(dataset.columns.city)),
    stateCode: cleanState(dataset.state),
    postalCode: get(dataset.columns.zip).slice(0, 5) || null,
    addressLine1: address || null,
    parties,
    confirmedFacts,
    // Nothing is inferred here. What this event implies commercially is a
    // playbook's judgement, made downstream and labelled as ours.
    inferredFacts: [],
    confidence: naturalKey ? 0.85 : 0.65,
    relatedCapabilities: [],
    rawPayload: { ...row, __dataset: dataset.datasetId, __domain: dataset.domain },
    naturalKey,
  };
}

/** Stable across runs for a row with no source-issued identifier. */
function stableRowKey(row: Row, dataset: JurisdictionDataset): string {
  const parts = [
    dataset.columns.name && row[dataset.columns.name],
    dataset.columns.address && row[dataset.columns.address],
    row[dataset.dateColumn],
  ]
    .filter(Boolean)
    .map((v) => String(v).toLowerCase().replace(/\s+/g, ''));
  return parts.join('|').slice(0, 120);
}
