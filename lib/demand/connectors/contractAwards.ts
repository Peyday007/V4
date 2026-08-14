import { httpJson, looksLikeBlockPage } from '@/lib/discovery/http';
import { cleanCity, cleanState } from '@/lib/discovery/identity';
import type { RawDemandEvent } from '../events';
import {
  AllRequestsFailedError,
  DropTally,
  type DemandConnector,
  type DemandFetchContext,
  type DemandFetchResult,
  type SourceScopeReport,
} from '../connector';

/**
 * Contract awards, as evidence of primes who may need local crews.
 *
 * This is the automatic subcontracting source, and it needs stating carefully
 * because the obvious version of it is wrong.
 *
 * An award says work was won. It does not say the winner is short of capacity,
 * and treating every award as an open subcontracting job is the easiest way in
 * this entire system to manufacture a pipeline out of nothing — thousands of
 * "opportunities" nobody asked for.
 *
 * What an award *can* support is a narrower hypothesis: when a janitorial
 * contract is awarded for performance in one state to a company whose own
 * address is in another, somebody has to put crews on the ground there, and
 * that somebody is usually a local subcontractor. That inference is real, it is
 * checkable in one phone call, and it is labelled an inference all the way to
 * the screen. The playbook that consumes these events requires the mismatch to
 * exist; an award performed where the winner already sits produces no route.
 *
 * The connector emits the award and the geography. It draws no conclusion —
 * the capacity hypothesis is the playbook's, made downstream where it can be
 * seen and argued with.
 */

const USASPENDING_ENDPOINT = 'https://api.usaspending.gov/api/v2/search/spending_by_award/';

/** Janitorial and facility support services. */
const CLEANING_NAICS = ['561720', '561790', '561210'];

type AwardRow = Record<string, unknown>;

export class ContractAwardsConnector implements DemandConnector {
  readonly key = 'contract_awards';
  readonly name = 'Contract awards (prime-contractor and capacity evidence)';
  readonly accessBasis =
    'Award records published by USAspending under the DATA Act through its documented public API. No key, no ' +
    'authentication, no scraping. Used as evidence about who holds work and where, never as open buyer demand.';
  readonly termsUrl = 'https://api.usaspending.gov/';
  readonly credentialEnvVar = null;
  readonly requiresJurisdictionConfig = false;
  readonly eventFamilies = [
    'Contract awards and prime-contractor evidence',
    'Local capacity gaps inferred from award geography',
  ];
  readonly pollIntervalMinutes = 12 * 60;

  async fetch(context: DemandFetchContext): Promise<DemandFetchResult> {
    const since = context.since ?? new Date(Date.now() - 120 * 86_400_000);
    const events: RawDemandEvent[] = [];
    const failures: string[] = [];
    const tally = new DropTally();
    let recordsExamined = 0;
    let accepted = 0;
    let newest: Date | null = null;

    // One request per page rather than per state: the filter takes a NAICS
    // list, and a state-by-state sweep would be fifty requests for the same
    // rows.
    const pages = Math.max(1, Math.ceil(context.maxRecords / 100));

    for (let page = 1; page <= pages; page += 1) {
      try {
        const response = await httpJson<{ results?: AwardRow[] }>({
          url: USASPENDING_ENDPOINT,
          method: 'POST',
          body: {
            filters: {
              award_type_codes: ['A', 'B', 'C', 'D'],
              naics_codes: CLEANING_NAICS,
              time_period: [
                { start_date: since.toISOString().slice(0, 10), end_date: new Date().toISOString().slice(0, 10) },
              ],
            },
            fields: [
              'Award ID',
              'Recipient Name',
              'Start Date',
              'End Date',
              'Award Amount',
              'Awarding Agency',
              'Place of Performance State Code',
              'Place of Performance City Code',
              'Place of Performance Zip5',
              // Where the prime itself sits. The entire capacity hypothesis
              // rests on this differing from the place of performance, so a
              // row without it produces no subcontracting route at all.
              'Recipient Location State Code',
              'Description',
              'recipient_id',
              'generated_internal_id',
            ],
            page,
            limit: 100,
            sort: 'Start Date',
            order: 'desc',
          },
          timeoutMs: 30_000,
          rateLimitKey: 'usaspending',
          rateLimitPerMin: context.rateLimitPerMin ?? 60,
        });

        const rows = response.results ?? [];
        recordsExamined += rows.length;
        if (rows.length === 0) break;

        for (const row of rows) {
          const event = toAwardEvent(row, tally);
          if (!event) continue;
          accepted += 1;
          if (event.eventDate && (!newest || event.eventDate > newest)) newest = event.eventDate;
          events.push(event);
        }
      } catch (error) {
        failures.push(`page ${page}: ${String(error).slice(0, 200)}`);
      }
    }

    // Every page failing is an outage or a changed contract, not a quiet
    // quarter. Reporting it as a successful empty run leaves nothing to act on.
    if (failures.length > 0 && events.length === 0) {
      // A block page is a filter in front of the API, not the API refusing the
      // query: the request carries no credential and the endpoint is public,
      // so nothing here can be fixed by changing what is asked. The probe sees
      // this from a GitHub runner and the deployment sees it from Vercel, and
      // sending somebody to check their filters would send them nowhere.
      if (failures.some(looksLikeBlockPage)) {
        throw new AllRequestsFailedError(this.key, [
          'A network filter in front of USAspending is answering instead of the API — the response is a '
          + 'block page, not an API error, so the request never arrived. Nothing in the query will change '
          + 'that: try a different DISCOVERY_USER_AGENT, request from somewhere else, or turn this source '
          + 'off. The municipal sources are unaffected.',
          ...failures.slice(0, 2),
        ]);
      }
      throw new AllRequestsFailedError(this.key, failures);
    }

    const funnel: SourceScopeReport[] = [
      {
        scope: `USAspending awards, NAICS ${CLEANING_NAICS.join('/')}, since ${since.toISOString().slice(0, 10)}`,
        url: USASPENDING_ENDPOINT,
        fetched: recordsExamined,
        accepted,
        drops: tally.entries(),
        failure: failures.length > 0 ? failures.join('; ').slice(0, 300) : null,
      },
    ];

    return {
      events: events.slice(0, context.maxRecords),
      recordsExamined,
      nextCursor: newest ? newest.toISOString() : context.cursor,
      warnings: failures,
      funnel,
    };
  }
}

/**
 * One award row becomes one event.
 *
 * The recipient is recorded as `PRIME_CONTRACTOR` — they hold the work — and
 * the place of performance is recorded as the event's location, because that
 * is where crews would be needed. Whether the two differ is left for the
 * playbook to judge.
 */
export function toAwardEvent(row: AwardRow, tally: DropTally = new DropTally()): RawDemandEvent | null {
  const str = (key: string): string => {
    const value = row[key];
    return typeof value === 'string' ? value.trim() : value == null ? '' : String(value);
  };
  const present = () => `fields returned: ${Object.keys(row).slice(0, 14).join(', ')}`;

  const recipient = str('Recipient Name');
  const awardId = str('Award ID') || str('generated_internal_id');
  // The field names in the request are the API's display names, and they are
  // the part most likely to have moved. Saying which one is missing turns a
  // silent empty run into a one-line fix.
  if (!recipient) return tally.drop('no "Recipient Name" in the response row', present());
  if (!awardId) return tally.drop('no "Award ID" or "generated_internal_id"', present());

  // The award's start date is when the obligation begins, which is when crews
  // are actually needed. No date, no event.
  const startRaw = str('Start Date');
  if (!startRaw) return tally.drop('no "Start Date"', present());
  const eventDate = new Date(startRaw);
  if (Number.isNaN(eventDate.getTime())) return tally.drop('"Start Date" is not a date', startRaw);

  const endRaw = str('End Date');
  const completesAt = endRaw ? new Date(endRaw) : null;

  const performanceState = cleanState(str('Place of Performance State Code'));
  const recipientState = cleanState(str('Recipient Location State Code'));
  const amountRaw = str('Award Amount').replace(/[^0-9.]/g, '');
  const amount = amountRaw ? Number(amountRaw) : null;
  const agency = str('Awarding Agency');
  const internal = str('generated_internal_id');

  return {
    type: 'CONTRACT_AWARD',
    sourceRecordId: awardId,
    sourceUrl: internal
      ? `https://www.usaspending.gov/award/${encodeURIComponent(internal)}`
      : 'https://www.usaspending.gov/search',
    headline: `${recipient} awarded facility-services work${performanceState ? ` in ${performanceState}` : ''}`,
    summary: str('Description').slice(0, 1500) || `Facility services award to ${recipient}.`,
    eventDate,
    completesAt: completesAt && !Number.isNaN(completesAt.getTime()) ? completesAt : null,
    // Where the work is, which is where crews would be needed. Not where the
    // agency sits and not a search scope.
    cityName: cleanCity(str('Place of Performance City Code')),
    stateCode: performanceState,
    postalCode: str('Place of Performance Zip5').slice(0, 5) || null,
    addressLine1: null,
    // The recipient holds the work. That is the only role an award establishes.
    parties: [
      { role: 'PRIME_CONTRACTOR', name: recipient },
      ...(agency ? [{ role: 'ISSUING_AUTHORITY' as const, name: agency }] : []),
    ],
    confirmedFacts: [
      `${recipient} was awarded this on ${eventDate.toISOString().slice(0, 10)}`,
      ...(performanceState ? [`Place of performance: ${performanceState}`] : []),
      ...(amount ? [`Award amount: $${Math.round(amount).toLocaleString()}`] : []),
      ...(completesAt && !Number.isNaN(completesAt.getTime())
        ? [`Period of performance ends ${completesAt.toISOString().slice(0, 10)}`]
        : []),
      ...(agency ? [`Awarding agency: ${agency}`] : []),
      ...(recipientState ? [`The prime's own registered state: ${recipientState}`] : []),
    ],
    // Deliberately empty. Whether this prime needs local capacity is a
    // hypothesis the playbook makes, where the reasoning is visible.
    inferredFacts: [],
    confidence: 0.9,
    relatedCapabilities: ['Commercial janitorial'],
    // The recipient's state is lifted into a stable key because the
    // subcontracting playbook reads it, and USAspending's own field names
    // change between API versions.
    rawPayload: { ...row, __recipientState: recipientState },
    naturalKey: `award:${awardId}`,
  };
}
