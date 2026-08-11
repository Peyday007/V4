import { httpJson, readCredential, hasCredential } from '@/lib/discovery/http';
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
 * SAM.gov solicitations — optional, and deliberately not the foundation.
 *
 * Federal solicitations are genuine Tier A demand with published deadlines,
 * and they are also the highest-friction work this business could take: formal
 * procurement, registration, bonding, and a cycle measured in months. The
 * operator has asked not to depend on government contracting, so this
 * connector is off unless a key is present, and the engine's default sources
 * are municipal open data and inbound intake.
 *
 * It stays in the registry because when it is switched on it produces exactly
 * the record the friction model was built to handle: unambiguous demand that
 * belongs nowhere near the low-friction queue.
 */

const ENDPOINT = 'https://api.sam.gov/opportunities/v2/search';

/** NAICS codes for janitorial and facility support services. */
const CLEANING_NAICS = ['561720', '561790', '561210'];

type SamOpportunity = {
  noticeId?: string;
  title?: string;
  solicitationNumber?: string;
  postedDate?: string;
  responseDeadLine?: string;
  type?: string;
  naicsCode?: string;
  description?: string;
  uiLink?: string;
  active?: string;
  organizationType?: string;
  fullParentPathName?: string;
  placeOfPerformance?: {
    city?: { name?: string };
    state?: { code?: string };
    zip?: string;
  };
  officeAddress?: { city?: string; state?: string; zipcode?: string };
};

export class SamGovDemandConnector implements DemandConnector {
  readonly key = 'sam_gov_demand';
  readonly name = 'SAM.gov solicitations (optional)';
  readonly accessBasis =
    'US federal opportunity data via the documented public SAM.gov API, using a free personal API key issued ' +
    'to the account holder. No scraping and no credential sharing.';
  readonly termsUrl = 'https://open.gsa.gov/api/get-opportunities-public-api/';
  readonly credentialEnvVar = 'SAM_GOV_API_KEY';
  readonly requiresJurisdictionConfig = false;
  readonly eventFamilies = ['Active solicitations, RFQs and procurement notices'];
  readonly pollIntervalMinutes = 12 * 60;

  async fetch(context: DemandFetchContext): Promise<DemandFetchResult> {
    if (!hasCredential(this.credentialEnvVar)) {
      throw new NotConfiguredError(
        this.key,
        'no SAM.gov API key is set',
        'Register at sam.gov, request a public API key from your account profile, and set SAM_GOV_API_KEY in the ' +
          'deployment environment. This source is optional — the demand engine runs without it.',
      );
    }

    const apiKey = readCredential(this.credentialEnvVar, 'SAM.gov');
    const since = context.since ?? new Date(Date.now() - 30 * 86_400_000);
    const events: RawDemandEvent[] = [];
    const failures: string[] = [];
    let recordsExamined = 0;

    for (const naics of CLEANING_NAICS) {
      if (events.length >= context.maxRecords) break;
      try {
        const params = new URLSearchParams({
          api_key: apiKey,
          // SAM.gov wants MM/dd/yyyy and rejects ISO dates outright.
          postedFrom: usDate(since),
          postedTo: usDate(new Date()),
          ncode: naics,
          limit: String(Math.min(context.maxRecords, 100)),
          ptype: 'o,p,r',
        });

        const response = await httpJson<{ opportunitiesData?: SamOpportunity[]; totalRecords?: number }>({
          url: `${ENDPOINT}?${params.toString()}`,
          timeoutMs: 25_000,
          rateLimitKey: 'sam_gov',
          rateLimitPerMin: context.rateLimitPerMin ?? 5,
        });

        const rows = response.opportunitiesData ?? [];
        recordsExamined += rows.length;
        for (const row of rows) {
          const event = toSamEvent(row);
          if (event) events.push(event);
        }
      } catch (error) {
        failures.push(`NAICS ${naics}: ${String(error).slice(0, 160)}`);
      }
    }

    if (failures.length === CLEANING_NAICS.length) {
      throw new AllRequestsFailedError(this.key, failures);
    }

    return {
      events: events.slice(0, context.maxRecords),
      recordsExamined,
      nextCursor: null,
      warnings: failures,
    };
  }
}

function usDate(date: Date): string {
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${mm}/${dd}/${date.getUTCFullYear()}`;
}

export function toSamEvent(row: SamOpportunity): RawDemandEvent | null {
  const noticeId = row.noticeId?.trim();
  const title = row.title?.trim();
  if (!noticeId || !title) return null;

  // The posting date is the event. No posting date, no Tier A claim.
  const posted = row.postedDate ? new Date(row.postedDate) : null;
  if (!posted || Number.isNaN(posted.getTime())) return null;

  const deadline = row.responseDeadLine ? new Date(row.responseDeadLine) : null;
  const buyer = row.fullParentPathName?.split('.').pop()?.trim() || row.fullParentPathName?.trim();

  const place = row.placeOfPerformance;
  return {
    type: row.type?.toLowerCase().includes('sources sought') ? 'PROCUREMENT_NOTICE' : 'ACTIVE_RFQ',
    sourceRecordId: noticeId,
    sourceUrl: row.uiLink ?? `https://sam.gov/opp/${encodeURIComponent(noticeId)}/view`,
    headline: title,
    summary: (row.description ?? title).slice(0, 1500),
    eventDate: posted,
    deadlineAt: deadline && !Number.isNaN(deadline.getTime()) ? deadline : null,
    // Place of performance, which is where the work is. Never the office that
    // published it, and never a search scope.
    cityName: cleanCity(place?.city?.name),
    stateCode: cleanState(place?.state?.code),
    postalCode: place?.zip ?? null,
    addressLine1: null,
    parties: buyer ? [{ role: 'BUYER', name: buyer }] : [],
    confirmedFacts: [
      `SAM.gov notice ${row.solicitationNumber ?? noticeId} posted ${posted.toISOString().slice(0, 10)}`,
      ...(deadline ? [`Responses close ${deadline.toISOString().slice(0, 10)}`] : []),
      ...(row.naicsCode ? [`NAICS ${row.naicsCode}`] : []),
      ...(buyer ? [`Issuing organisation: ${buyer}`] : []),
    ],
    inferredFacts: [],
    confidence: 0.95,
    relatedCapabilities: ['Commercial janitorial'],
    rawPayload: row as unknown as Record<string, unknown>,
    naturalKey: `sam:${noticeId}`,
  };
}
