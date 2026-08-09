import type { DiscoveryConnector, ConnectorContext, RawRecord } from '../connector';
import type { SignalCategory, SourceType } from '@prisma/client';
import { httpJson, readCredential } from '../http';

/**
 * SAM.gov contract opportunities.
 *
 * Public-sector work, and deliberately **disabled by default**. Federal
 * solicitations carry registration requirements, long award cycles and net-30
 * to net-60 payment against work already performed — which is a working-capital
 * problem, not a lead-flow problem. A business that needs revenue this quarter
 * should not be pointed here first.
 *
 * It earns its place for one reason: subcontracting. Prime contractors winning
 * facility-services awards need local fulfilment partners immediately, and
 * small-business subcontracting goals mean they are obliged to look. That is a
 * fast path that does not require us to be a registered prime.
 *
 * Rate limits are the binding constraint. A non-federal personal API key
 * permits on the order of ten requests per day, so this connector makes one
 * request per run and is scheduled daily rather than hourly.
 *
 * @see https://open.gsa.gov/api/get-opportunities-public-api/
 */

const ENDPOINT = 'https://api.sam.gov/opportunities/v2/search';

/** NAICS codes for cleaning, facility support and janitorial supply. */
const DEFAULT_NAICS = [
  '561720', // Janitorial services
  '561790', // Other services to buildings and dwellings
  '561210', // Facilities support services
  '561740', // Carpet and upholstery cleaning
  '423850', // Service establishment equipment and supplies merchant wholesalers
];

type SamResponse = {
  totalRecords?: number;
  opportunitiesData?: Array<{
    noticeId?: string;
    title?: string;
    solicitationNumber?: string;
    fullParentPathName?: string;
    postedDate?: string;
    type?: string;
    naicsCode?: string;
    classificationCode?: string;
    active?: string;
    responseDeadLine?: string;
    description?: string;
    uiLink?: string;
    typeOfSetAsideDescription?: string;
    placeOfPerformance?: {
      city?: { name?: string };
      state?: { code?: string; name?: string };
    };
    pointOfContact?: Array<{ fullName?: string; email?: string; phone?: string; type?: string }>;
    organizationType?: string;
  }>;
};

export class SamGovConnector implements DiscoveryConnector {
  readonly key = 'sam_gov_opportunities';
  readonly sourceType: SourceType = 'PROCUREMENT_PORTAL';
  readonly defaultCategory: SignalCategory = 'SUBCONTRACTING';
  readonly isLive = true;
  readonly requiresMarket = false;
  readonly credentialEnvVar = 'SAM_GOV_API_KEY';
  readonly termsUrl = 'https://open.gsa.gov/api/get-opportunities-public-api/';
  readonly accessBasis =
    'Official US federal government public API for contract opportunities, accessed with a registered api.data.gov key within its published daily request limit.';

  async fetch(context: ConnectorContext): Promise<RawRecord[]> {
    const apiKey = readCredential(this.credentialEnvVar, 'SAM.gov');
    const market = context.market;

    const naics = readNaics(market?.sourceConfig ?? {}, context.config);
    const since = context.since ?? new Date(Date.now() - 30 * 86_400_000);

    // The API caps the window at one year and wants MM/dd/yyyy.
    const params = new URLSearchParams({
      api_key: apiKey,
      postedFrom: formatSamDate(since),
      postedTo: formatSamDate(new Date()),
      limit: String(Math.min(context.maxRecords, 100)),
      ptype: 'o,k,r', // solicitation, combined synopsis, sources sought
    });
    if (naics.length > 0) params.set('ncode', naics.join(','));

    // Place of performance keeps federal results inside the market we actually
    // serve. Without it the feed is national and almost entirely unfulfillable.
    const stateCode = (market?.sourceConfig?.samState as string | undefined) ?? market?.state ?? undefined;
    if (stateCode) params.set('state', stateCode);

    const response = await httpJson<SamResponse>({
      url: `${ENDPOINT}?${params.toString()}`,
      timeoutMs: 25_000,
      // One request per run. The daily key limit is roughly ten.
      attempts: 2,
      rateLimitKey: 'sam_gov',
      rateLimitPerMin: context.rateLimitPerMin ?? 5,
    });

    return (response.opportunitiesData ?? [])
      .map((item) => toSamRecord(item))
      .filter((record): record is RawRecord => record !== null)
      .slice(0, context.maxRecords);
  }
}

export function toSamRecord(item: NonNullable<SamResponse['opportunitiesData']>[number]): RawRecord | null {
  const title = item.title?.trim();
  const noticeId = item.noticeId?.trim();
  if (!title || !noticeId) return null;

  const agency = item.fullParentPathName?.split('.').pop()?.trim() || item.fullParentPathName?.trim();
  const city = item.placeOfPerformance?.city?.name;
  const state = item.placeOfPerformance?.state?.code;
  const contact = item.pointOfContact?.find((c) => c.email || c.phone);
  const deadline = item.responseDeadLine ? new Date(item.responseDeadLine) : null;
  const posted = item.postedDate ? new Date(item.postedDate) : undefined;

  return {
    externalId: `sam:${noticeId}`,
    title: `${item.type ?? 'Solicitation'}: ${title}`,
    excerpt:
      `${title}. ` +
      `${agency ? `Issued by ${agency}. ` : ''}` +
      `${item.solicitationNumber ? `Solicitation ${item.solicitationNumber}. ` : ''}` +
      `${item.naicsCode ? `NAICS ${item.naicsCode}. ` : ''}` +
      `${item.typeOfSetAsideDescription ? `Set-aside: ${item.typeOfSetAsideDescription}. ` : ''}` +
      `${deadline && !Number.isNaN(deadline.getTime()) ? `Responses due ${deadline.toISOString().slice(0, 10)}. ` : ''}` +
      `${(item.description ?? '').slice(0, 500)}`.trim(),
    // uiLink is the human-facing notice page, which is what someone verifying
    // the lead actually wants — not the JSON endpoint.
    sourceUrl: item.uiLink ?? `https://sam.gov/opp/${encodeURIComponent(noticeId)}/view`,
    observedAt: posted && !Number.isNaN(posted.getTime()) ? posted : undefined,
    location: [city, state].filter(Boolean).join(', ') || undefined,
    state: state ?? undefined,
    companyName: agency ?? undefined,
    // The issuing agency is the buyer. Awards to primes are a different record
    // type; nothing here describes a supplier, and inferring one from the
    // solicitation text is how buyers end up filed as providers.
    subjectRole: 'BUYER',
    describesSubject: false,
    leadRole: 'BUYER',
    segment: 'PUBLIC_SECTOR',
    category: 'SUBCONTRACTING',
    requiredService: item.naicsCode ? naicsLabel(item.naicsCode) : 'Facility services',
    whyRelevant:
      `Open public-sector solicitation in a facility-services classification` +
      `${state ? ` with performance in ${state}` : ''}. ` +
      `Public work carries long award and payment cycles, so the faster path is usually to reach the prime bidders as a ` +
      `local fulfilment subcontractor rather than to bid directly` +
      `${item.typeOfSetAsideDescription ? `, particularly against a ${item.typeOfSetAsideDescription.toLowerCase()} requirement` : ''}.`,
    contact: {
      name: contact?.fullName,
      email: contact?.email,
      phone: contact?.phone,
    },
    payload: {
      noticeId,
      solicitationNumber: item.solicitationNumber,
      naicsCode: item.naicsCode,
      setAside: item.typeOfSetAsideDescription,
      responseDeadline: item.responseDeadLine,
      active: item.active,
    },
  };
}

function naicsLabel(code: string): string {
  const labels: Record<string, string> = {
    '561720': 'Janitorial services',
    '561790': 'Building services',
    '561210': 'Facilities support services',
    '561740': 'Carpet and upholstery cleaning',
    '423850': 'Janitorial supply wholesale',
  };
  return labels[code] ?? `NAICS ${code}`;
}

function formatSamDate(date: Date): string {
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${month}/${day}/${date.getUTCFullYear()}`;
}

export function readNaics(marketConfig: Record<string, unknown>, sourceConfig: Record<string, unknown>): string[] {
  const raw = (marketConfig.samNaics ?? sourceConfig.naics) as unknown;
  if (!Array.isArray(raw)) return DEFAULT_NAICS;
  const codes = raw.filter((code): code is string => typeof code === 'string' && /^\d{6}$/.test(code));
  return codes.length > 0 ? codes : DEFAULT_NAICS;
}
