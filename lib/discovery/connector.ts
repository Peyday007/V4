import { createHash } from 'node:crypto';
import type { CompanyRole, SignalCategory, SourceType } from '@prisma/client';

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
  location?: string;
  state?: string;
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
};

export type ConnectorContext = {
  orgId: string;
  dataSourceId: string;
  config: Record<string, unknown>;
  /** Bounded so a run can never fan out without limit. */
  maxRecords: number;
  since?: Date;
};

export interface DiscoveryConnector {
  readonly key: string;
  readonly sourceType: SourceType;
  readonly defaultCategory: SignalCategory;
  /** Human-readable justification for accessing this source. */
  readonly accessBasis: string;
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
