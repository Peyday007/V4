import { createHash } from 'node:crypto';
import type { CompanyRole, LeadRole, MarketScope, MarketSegment, SignalCategory, SourceType } from '@prisma/client';

/**
 * A connector fetches records from one class of source and normalises them
 * into evidence + candidate signals. Connectors never decide whether an
 * opportunity exists — that is the classifier's and scorer's job.
 *
 * Access policy: every connector must declare an `accessBasis` explaining why
 * the access is permitted (public record, licensed API, first-party data).
 * Connectors must respect robots directives, rate limits, authentication
 * boundaries and contractual restrictions. Nothing here bypasses access
 * controls or logs into a portal on a user's behalf.
 */

export type RawRecord = {
  /** Stable identifier within the source, used for de-duplication. */
  externalId: string;
  title: string;
  excerpt: string;
  sourceUrl?: string;
  observedAt?: Date;
  /**
   * The subject's own "City, ST", or absent.
   *
   * Never the market, metro anchor or jurisdiction a run was pointed at. A
   * search scope is not a fact about the business, and substituting one for
   * the other produced a board of businesses in twelve states all showing the
   * same city.
   */
  location?: string;
  state?: string;
  /** Street line, where the source published one. A deduplication key. */
  addressLine1?: string;
  postalCode?: string;
  companyName?: string;
  companyWebsite?: string;
  /**
   * The named company's role *in the situation this record describes*.
   *
   * This matters: an award notice or an RFQ describes a transaction, and the
   * words in it ("subcontract", "supplier", "quarry") describe other parties,
   * not the subject. Inferring the subject's role from that text produces
   * confidently wrong classifications, so connectors state it explicitly and
   * keyword inference is reserved for records that genuinely describe the
   * company itself, such as a directory listing.
   */
  subjectRole?: CompanyRole;
  /** True when the excerpt is the company describing itself. */
  describesSubject?: boolean;
  payload?: Record<string, unknown>;

  /**
   * Lead attributes the source itself establishes.
   *
   * A connector knows things the downstream rules can only guess at. A permit
   * record knows it is commercial construction in a named city; a place search
   * knows it returned cleaning contractors, not buyers. Passing that through
   * beats re-deriving it from prose, which is where confident mistakes come
   * from. Everything here is optional — a connector that does not know should
   * say nothing rather than guess.
   */
  leadRole?: LeadRole;
  segment?: MarketSegment;
  /** The service or product at issue, in the source's own words. */
  requiredService?: string;
  /** Overrides the connector's default path when one record differs. */
  category?: SignalCategory;
  /** Plain-language reason this record is worth someone's attention. */
  whyRelevant?: string;
  /** Only what the source actually published. Never inferred, never guessed. */
  contact?: {
    name?: string;
    phone?: string;
    email?: string;
    website?: string;
  };
  /** Provider-stable place identifier, where the source has one. */
  externalPlaceId?: string;
};

/** The geography a run is pointed at. Null only for sources with no geography. */
export type MarketContext = {
  id: string;
  name: string;
  slug: string;
  scope: MarketScope;
  state: string | null;
  /** Every state the market covers. Empty under NATIONAL means all of them. */
  states: string[];
  centerLat: number | null;
  centerLng: number | null;
  radiusMeters: number;
  postalCodes: string[];
  cities: string[];
  counties: string[];
  /** Per-source settings for this market, merged over the source's own config. */
  sourceConfig: Record<string, unknown>;
};

export type ConnectorContext = {
  orgId: string;
  dataSourceId: string;
  config: Record<string, unknown>;
  /** Bounded so a run can never fan out without limit. */
  maxRecords: number;
  since?: Date;
  /** Where to look. Connectors that need it and do not get it must return []. */
  market: MarketContext | null;
  /** Name of the environment variable holding this source's credential. */
  credentialEnvVar?: string | null;
  rateLimitPerMin?: number;
};

export interface DiscoveryConnector {
  readonly key: string;
  readonly sourceType: SourceType;
  readonly defaultCategory: SignalCategory;
  /** Human-readable justification for accessing this source. */
  readonly accessBasis: string;
  /**
   * True when this connector reaches a real external source. False for the
   * fixture connectors backing the demonstration. Surfaced in the interface so
   * fabricated volume can never be mistaken for real discovery.
   */
  readonly isLive: boolean;
  /** Link to the terms the accessBasis claim rests on. */
  readonly termsUrl?: string;
  /** Environment variable this connector needs, if any. */
  readonly credentialEnvVar?: string;
  /** True when this connector cannot run without a market. */
  readonly requiresMarket?: boolean;
  /**
   * True when the connector can cover the whole country by partitioning the
   * query itself — one request per state, or a fifty-entry filter list. A
   * connector without this is inherently local, and a NATIONAL market must not
   * silently reduce it to whichever single place it happens to default to.
   */
  readonly supportsNationwide?: boolean;
  fetch(context: ConnectorContext): Promise<RawRecord[]>;
}

const registry = new Map<string, DiscoveryConnector>();

export function registerConnector(connector: DiscoveryConnector): void {
  registry.set(connector.key, connector);
}

export function getConnector(key: string): DiscoveryConnector | undefined {
  return registry.get(key);
}

export function listConnectors(): DiscoveryConnector[] {
  return [...registry.values()];
}

export function contentHash(parts: Array<string | undefined | null>): string {
  return createHash('sha256').update(parts.filter(Boolean).join('|').toLowerCase()).digest('hex');
}
