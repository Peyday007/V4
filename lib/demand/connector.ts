import type { RawDemandEvent } from './events';

/**
 * A demand connector fetches records that describe *events*, not organisations.
 *
 * The distinction is the whole point of the interface existing separately from
 * `DiscoveryConnector`. A discovery connector answers "which businesses are
 * there"; a demand connector answers "what happened". A source that can only
 * answer the first cannot be registered here, which is why Google Places and
 * the CMS registry are not demand connectors however useful they are for
 * resolving an account once an event names one.
 *
 * Every implementation must:
 *   - preserve the source's own event date, and emit null rather than
 *     substituting anything of ours when the source published none
 *   - preserve source identifiers and a URL back to the record
 *   - preserve the location the source stated, never a search anchor
 *   - separate what the source said from what we concluded
 *   - be idempotent: the same fetch twice produces the same dedupe keys
 *   - throw when every request failed, rather than returning an empty success
 */

export type DemandFetchContext = {
  /** Where the previous successful run finished, when the source supports it. */
  cursor: string | null;
  /** Only records at or after this date. Derived from the last run. */
  since: Date | null;
  maxRecords: number;
  /** Per-market configuration merged over the source's own. */
  config: Record<string, unknown>;
  /** States to cover this run, empty meaning wherever the source reaches. */
  states: string[];
  rateLimitPerMin?: number;
};

export type DemandFetchResult = {
  events: RawDemandEvent[];
  /** Records looked at, including ones filtered out. */
  recordsExamined: number;
  /** Where a subsequent run should resume. */
  nextCursor: string | null;
  /** Non-fatal problems. A run with some failures still returns its results. */
  warnings: string[];
};

export interface DemandConnector {
  readonly key: string;
  readonly name: string;
  /** Documented basis for accessing this source. */
  readonly accessBasis: string;
  readonly termsUrl: string;
  /** Environment variable holding a credential, when one is needed at all. */
  readonly credentialEnvVar: string | null;
  /** True when the source needs per-jurisdiction configuration to do anything. */
  readonly requiresJurisdictionConfig: boolean;
  /** Which event families this source can actually produce. */
  readonly eventFamilies: string[];
  /** Suggested minutes between runs. */
  readonly pollIntervalMinutes: number;

  fetch(context: DemandFetchContext): Promise<DemandFetchResult>;
}

const REGISTRY = new Map<string, DemandConnector>();

export function registerDemandConnector(connector: DemandConnector): void {
  REGISTRY.set(connector.key, connector);
}

export function getDemandConnector(key: string): DemandConnector | undefined {
  return REGISTRY.get(key);
}

export function listDemandConnectors(): DemandConnector[] {
  return [...REGISTRY.values()];
}

/**
 * A source that failed every request.
 *
 * Distinguished from a source that legitimately found nothing, because the two
 * look identical in a record count and have completely different fixes. This
 * is thrown rather than returned so a caller cannot accidentally treat it as
 * a successful empty run.
 */
export class AllRequestsFailedError extends Error {
  constructor(
    public readonly connectorKey: string,
    public readonly failures: string[],
  ) {
    super(
      `${connectorKey}: every request failed (${failures.length}). ` +
        `This is a broken configuration or an outage, not a quiet week. First failure: ${failures[0]}`,
    );
    this.name = 'AllRequestsFailedError';
  }
}

/** A source that needs configuration it has not been given. */
export class NotConfiguredError extends Error {
  constructor(
    public readonly connectorKey: string,
    public readonly whatIsMissing: string,
    public readonly howToFix: string,
  ) {
    super(`${connectorKey} is not configured: ${whatIsMissing}. ${howToFix}`);
    this.name = 'NotConfiguredError';
  }
}
