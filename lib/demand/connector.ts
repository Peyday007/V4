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
  /**
   * Where the records went. Optional only so an older connector still
   * type-checks; every connector in the registry reports one, and a source
   * that reports nothing is described as such rather than left blank.
   */
  funnel?: SourceScopeReport[];
};

// ---------------------------------------------------------------------------
// Where the records went
// ---------------------------------------------------------------------------

/**
 * A successful request that returns nothing and a successful request whose rows
 * are all discarded look identical from outside: both end as `recordsExamined`
 * and `eventsCreated` that do not add up, with no statement of what happened in
 * between. They have completely different fixes — one is a query window or a
 * republished dataset, the other is a filter that no longer matches the source's
 * vocabulary — and an operator staring at an empty board cannot tell which they
 * have.
 *
 * So every connector counts its own drops by reason and keeps one example of
 * each. It costs a few integers per run and it is the difference between "the
 * demand engine found nothing" and "Chicago returned 200 licences and all 200
 * were discarded because `license_start_date` is now `license_term_start_date`".
 */
export type SourceScopeReport = {
  /** The dataset, portal or page this describes, in the operator's words. */
  scope: string;
  /** The exact request made, so it can be pasted into a browser. */
  url: string | null;
  /** Rows the source returned. */
  fetched: number;
  /** Rows that became events. */
  accepted: number;
  /** Why the rest did not, most common first. */
  drops: Array<{ reason: string; count: number; example: string | null }>;
  /** Set when this scope failed outright; `fetched` is then meaningless. */
  failure: string | null;
  /**
   * What zero rows means here, when the default reading would be wrong.
   *
   * An empty city dataset is suspicious — the window is wide and the portal
   * publishes constantly. An empty inbound queue is just an empty queue, and
   * describing it as a possible outage would train an operator to ignore the
   * line that matters.
   */
  emptyMeans?: string;
};

/**
 * Counts discarded rows by reason.
 *
 * `drop` returns null so a mapper can `return tally.drop('no source date', id)`
 * on the same line it decides — the alternative is a counter incremented
 * separately from the return, which drifts the first time somebody adds a
 * branch.
 */
export class DropTally {
  private readonly counts = new Map<string, number>();
  private readonly examples = new Map<string, string>();

  drop(reason: string, example?: string | null): null {
    this.counts.set(reason, (this.counts.get(reason) ?? 0) + 1);
    if (example && !this.examples.has(reason)) this.examples.set(reason, example.slice(0, 160));
    return null;
  }

  get total(): number {
    let sum = 0;
    for (const n of this.counts.values()) sum += n;
    return sum;
  }

  entries(): SourceScopeReport['drops'] {
    return [...this.counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => ({ reason, count, example: this.examples.get(reason) ?? null }));
  }
}

/**
 * One sentence an owner can act on, built from the funnel.
 *
 * Deliberately written for the zero case first, because that is the case the
 * product was getting wrong: an empty board with no explanation is
 * indistinguishable from a broken one, and the whole point of collecting the
 * tallies is to be able to say which stage swallowed the records.
 */
export function explainSourceOutcome(params: {
  connectorKey: string;
  eventsCreated: number;
  eventsUpdated: number;
  recordsExamined: number;
  funnel: SourceScopeReport[];
}): string {
  const { funnel } = params;
  const produced = params.eventsCreated + params.eventsUpdated;
  const scopes = funnel.length;
  const failed = funnel.filter((s) => s.failure);
  const empty = funnel.filter((s) => !s.failure && s.fetched === 0);
  const filtered = funnel.filter((s) => !s.failure && s.fetched > 0 && s.accepted === 0);

  if (scopes === 0) {
    return produced > 0
      ? `Produced ${produced} event(s). This source does not report a per-stage breakdown.`
      : 'Produced nothing, and reported no per-stage breakdown to explain why.';
  }

  const parts: string[] = [];

  if (produced > 0) {
    parts.push(`Produced ${produced} event(s) from ${params.recordsExamined} record(s) examined.`);
  } else if (params.recordsExamined === 0) {
    parts.push('No records were returned at all, so nothing reached the filters.');
  } else {
    parts.push(
      `${params.recordsExamined} record(s) were returned and none became an event. `
        + 'That is a filter, a mapping or a republished dataset, not a quiet week.',
    );
  }

  for (const scope of failed) {
    parts.push(`${scope.scope} failed: ${scope.failure}`);
  }
  for (const scope of empty) {
    parts.push(
      `${scope.scope} answered with zero rows${scope.url ? `. Query: ${scope.url}` : '.'} `
        + (scope.emptyMeans
          ?? 'Either nothing matched the window and predicate, or the dataset moved.'),
    );
  }
  for (const scope of filtered) {
    const worst = scope.drops[0];
    parts.push(
      `${scope.scope} returned ${scope.fetched} row(s), all discarded`
        + (worst
          ? `; the largest reason was "${worst.reason}" (${worst.count})`
            + (worst.example ? `, e.g. ${worst.example}` : '')
          : '')
        + '.',
    );
  }

  // Sources that did produce something still deserve their loss reported: a
  // connector emitting 3 events from 900 rows is one filter change away from
  // emitting none, and nobody notices until it does.
  for (const scope of funnel.filter((s) => !s.failure && s.accepted > 0)) {
    const lost = scope.drops.reduce((n, d) => n + d.count, 0);
    if (lost > 0) {
      parts.push(
        `${scope.scope}: ${scope.accepted} of ${scope.fetched} row(s) kept; `
          + scope.drops.slice(0, 3).map((d) => `${d.reason} ${d.count}`).join(', ')
          + '.',
      );
    }
  }

  return parts.join(' ');
}

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
  /**
   * The source is reachable in principle and something outside this codebase
   * is preventing it.
   *
   * Set to stop a connector attempting on every tick when the failure is known,
   * external and unchanged by retrying. The distinction from `credentialEnvVar`
   * matters: a missing credential is something an owner can supply, while this
   * is a network path or an upstream policy that no configuration here will
   * move.
   *
   * A blocked connector is skipped by the recurring path and keeps its entry in
   * the health panel, because the diagnostic is the whole value — a source that
   * silently disappeared would be indistinguishable from one nobody had
   * configured, which is the state this product spent weeks getting out of.
   */
  readonly blockedExternally?: {
    /** Why, in the words the health panel shows. */
    because: string;
    /** What would have to change. Not a promise that it will. */
    whatWouldUnblock: string;
  };

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
