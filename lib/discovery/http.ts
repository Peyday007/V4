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

/**
 * A successful response that is not the API's data.
 *
 * Baltimore's open-data host answers 200 with an ArcGIS Hub page: the city
 * moved off Socrata and left the domain answering, so the request looks
 * healthy at every level except the one that matters. Left as a JSON parse
 * failure it reached the operator as `Unexpected token <`, which describes the
 * fifth character of the problem and none of the rest.
 */
export class NotJsonError extends Error {
  constructor(
    readonly host: string,
    readonly body: string,
  ) {
    super(
      `${host} answered 200 with ${describeNonJson(body)} rather than JSON. `
        + 'The host is up but is not serving this API — the dataset has usually moved to a different '
        + 'platform, or something in front of it answered instead.',
    );
    this.name = 'NotJsonError';
  }
}

/** Names what came back instead, from the shapes that actually turn up. */
function describeNonJson(body: string): string {
  const title = /<title[^>]*>([^<]{1,80})/i.exec(body)?.[1]?.trim();
  if (/Web Page Blocked|attack_ID|Access Denied|Request Rejected/i.test(body)) {
    return 'a filtering appliance\'s block page';
  }
  if (title) return `an HTML page titled "${title}"`;
  if (/^\s*</.test(body)) return 'an HTML page';
  return `${body.slice(0, 60).replace(/\s+/g, ' ')}…`;
}

export class MissingCredentialError extends Error {
  constructor(readonly envVar: string, sourceName: string) {
    super(
      `${sourceName} needs ${envVar}, which is not set. The source stays disabled rather than failing silently — see docs/DISCOVERY.md.`,
    );
    this.name = 'MissingCredentialError';
  }
}

/**
 * User agent.
 *
 * Configurable, because this is the one request property that a security
 * appliance in front of a public API is most likely to judge, and there is no
 * way to know from here which string a given deployment needs. USAspending
 * returns a "Web Page Blocked!" page for this client from Vercel's egress; a
 * different deployment may not see it at all.
 *
 * The default identifies the software and its purpose plainly. Deliberately no
 * "(compatible; ...)" wrapper — that is the classic crawler signature and some
 * filters match on it specifically, so imitating it can hurt rather than help.
 */
const DEFAULT_USER_AGENT = 'DealDispatch/1.0 (automated lead discovery for a facility-services operator)';

function userAgent(): string {
  return process.env.DISCOVERY_USER_AGENT?.trim() || DEFAULT_USER_AGENT;
}

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
          'user-agent': userAgent(),
          ...(options.body ? { 'content-type': 'application/json' } : {}),
          ...(options.headers ?? {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
        redirect: 'follow',
      });

      if (!response.ok) {
        const text = (await response.text().catch(() => '')).slice(0, 2000);
        // The status alone is close to useless for diagnosis: Google returns a
        // 403 that says exactly which API is disabled in which project, and
        // USAspending returns a 500 naming the field it choked on. Surfacing
        // that turns "it failed" into an instruction.
        throw new HttpError(
          `${response.status} from ${hostOf(options.url)}${summariseError(text) ? ` — ${summariseError(text)}` : ''}`,
          response.status,
          text,
        );
      }

      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) {
        throw new Error(`Response from ${hostOf(options.url)} exceeded ${MAX_RESPONSE_BYTES} bytes; narrow the query.`);
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        // A 200 carrying HTML is not a parse problem, it is an answer: the
        // host is no longer serving this API and something else — a portal
        // migration, a login wall, a filtering appliance — replied instead.
        // `SyntaxError: Unexpected token <` names none of that, and it was
        // what a whole city's move off Socrata looked like from inside.
        throw new NotJsonError(hostOf(options.url), text);
      }
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

/**
 * Pulls the human-readable message out of an error body.
 *
 * Every API nests it somewhere different — Google under `error.message`,
 * USAspending under `detail`, others under `message` — and falling back to the
 * raw text is still better than discarding it.
 */
export function summariseError(body: string): string {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const nested = parsed.error as Record<string, unknown> | undefined;
    const message =
      (typeof nested?.message === 'string' && nested.message) ||
      (typeof parsed.detail === 'string' && parsed.detail) ||
      (typeof parsed.message === 'string' && parsed.message) ||
      (typeof parsed.error === 'string' && parsed.error) ||
      '';
    if (message) return message.slice(0, 300);
  } catch {
    // Not JSON — HTML error pages are common and the tag soup is not useful.
  }
  // An HTML error page is a proxy or gateway talking, not the API. Its text is
  // boilerplate, so it is worth less than the status code already reported.
  // Tested against the raw body — stripping tags first would hide the evidence.
  if (/^\s*<(?:!doctype|html|\?xml)/i.test(body)) return '';
  return body.replace(/\s+/g, ' ').trim().slice(0, 300);
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
