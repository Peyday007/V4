/**
 * HTTP access for discovery connectors.
 *
 * Every live connector goes through here rather than calling fetch directly,
 * because the things that make external access sustainable — timeouts, retry
 * with backoff, rate limiting, an honest user agent, a hard cap on response
 * size — are exactly the things that get skipped when each connector rolls its
 * own. A connector that hangs takes the whole discovery run with it, and a
 * connector that hammers a municipal open-data portal gets the IP blocked for
 * everyone.
 *
 * There is no HTML parsing here and no browser automation, deliberately. Every
 * source is a documented API returning structured data, accessed within its
 * published terms. Nothing in this file can be pointed at a page that did not
 * intend to be read by a program.
 */

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }

  /** Retrying a 4xx sends the same bad request again; only 429 is worth repeating. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export class MissingCredentialError extends Error {
  constructor(readonly envVar: string, sourceName: string) {
    super(
      `${sourceName} needs ${envVar}, which is not set. The source stays disabled rather than failing silently — see docs/DISCOVERY.md.`,
    );
    this.name = 'MissingCredentialError';
  }
}

const USER_AGENT = 'DealDispatch/1.0 (+deal-dispatch; automated lead discovery; contact via deployment operator)';

/** Responses larger than this are a sign the query was wrong, not a windfall. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export type HttpJsonOptions = {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** Total attempts including the first. */
  attempts?: number;
  /** Identifier for rate-limit bookkeeping — usually the source key. */
  rateLimitKey?: string;
  rateLimitPerMin?: number;
};

/**
 * Fixed-window rate limiting per source, in process.
 *
 * A serverless deployment runs many instances, so this bounds a single run
 * rather than global traffic. That is the useful guarantee here: a run that
 * loops over 40 postcodes should not issue 40 requests in one second, and the
 * daily schedule keeps total volume low regardless of instance count.
 */
const windows = new Map<string, { count: number; resetAt: number }>();

export function rateLimitSlot(key: string, perMinute: number): number {
  const now = Date.now();
  const window = windows.get(key);
  if (!window || window.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + 60_000 });
    return 0;
  }
  if (window.count < perMinute) {
    window.count += 1;
    return 0;
  }
  return window.resetAt - now;
}

export function resetRateLimits(): void {
  windows.clear();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Swappable transport. Connector tests drive recorded responses through this
 * seam instead of reaching the network, which is what makes them meaningful in
 * CI and in sandboxes with no egress.
 */
export type Transport = (url: string, init: RequestInit) => Promise<Response>;

let transport: Transport = (url, init) => fetch(url, init);

export function setTransport(next: Transport): void {
  transport = next;
}

export function resetTransport(): void {
  transport = (url, init) => fetch(url, init);
}

export async function httpJson<T = unknown>(options: HttpJsonOptions): Promise<T> {
  const attempts = options.attempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 15_000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (options.rateLimitKey && options.rateLimitPerMin) {
      const wait = rateLimitSlot(options.rateLimitKey, options.rateLimitPerMin);
      if (wait > 0) await sleep(Math.min(wait, 5_000));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await transport(options.url, {
        method: options.method ?? 'GET',
        headers: {
          accept: 'application/json',
          'user-agent': USER_AGENT,
          ...(options.body ? { 'content-type': 'application/json' } : {}),
          ...(options.headers ?? {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
        redirect: 'follow',
      });

      if (!response.ok) {
        const text = (await response.text().catch(() => '')).slice(0, 500);
        throw new HttpError(`${response.status} from ${hostOf(options.url)}`, response.status, text);
      }

      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) {
        throw new Error(`Response from ${hostOf(options.url)} exceeded ${MAX_RESPONSE_BYTES} bytes; narrow the query.`);
      }
      return JSON.parse(text) as T;
    } catch (error) {
      lastError = error;
      const retryable = error instanceof HttpError ? error.retryable : true;
      if (!retryable || attempt === attempts) break;
      // Exponential backoff. A portal returning 429 wants less traffic, not
      // the same traffic sooner.
      await sleep(Math.min(2 ** attempt * 500, 8_000));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'source';
  }
}

/** Reads a credential without ever putting its value in an error message or log. */
export function readCredential(envVar: string | null | undefined, sourceName: string): string {
  if (!envVar) throw new Error(`${sourceName} has no credentialEnvVar configured.`);
  const value = process.env[envVar];
  if (!value || value.trim().length === 0) throw new MissingCredentialError(envVar, sourceName);
  return value.trim();
}

export function hasCredential(envVar: string | null | undefined): boolean {
  if (!envVar) return true;
  const value = process.env[envVar];
  return Boolean(value && value.trim().length > 0);
}
