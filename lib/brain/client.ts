import { brainConfig, RECORD_TYPE, SOURCE_SYSTEM, type BrainConfig } from './config';

/**
 * The only place this site talks to Brain.
 *
 * Three rules, and each one is here because the obvious alternative goes wrong
 * in production:
 *
 *   * **Every call is bounded.** A serverless function that waits indefinitely
 *     on a remote host is a page that never renders. The timeout is a hard
 *     abort, and a timeout is reported as a timeout rather than as an empty
 *     result — "Brain did not answer" and "Brain says there is nothing" are
 *     different facts and the caller has to be able to tell them apart.
 *
 *   * **The credential never appears in an error.** A failure carries a status
 *     and Brain's own message, and this module never interpolates the token,
 *     the header or the request into anything it throws. That is the one leak
 *     that would survive every review, because it only shows up in logs.
 *
 *   * **Refusals are not exceptions.** Brain answers a record the caller may
 *     not have with the same 404 as one that does not exist, deliberately. So
 *     `NOT_FOUND` is a value here, and callers decide what it means for them.
 */

export type BrainFailure =
  | { kind: 'NOT_CONNECTED' }
  | { kind: 'NOT_FOUND' }
  | { kind: 'REFUSED'; status: number; message: string }
  | { kind: 'TIMEOUT' }
  | { kind: 'UNREACHABLE'; message: string };

export type BrainResult<T> = { ok: true; value: T } | { ok: false; failure: BrainFailure };

/** What Brain says about one record. The site renders exactly this. */
export interface BrainProjection {
  brainId: string;
  sourceSystem: string;
  sourceRecordId: string;
  sourceVersion: string;
  title: string;
  sourceState: string | null;
  state: 'NOT_EVALUATED' | 'QUEUED' | 'IN_PROGRESS' | 'NEEDS_PERSON' | 'COMPLETED' | 'FAILED';
  stateReason: string;
  priority: string | null;
  priorityRank: number | null;
  reason: string | null;
  confidence: number | null;
  research: {
    missionId: string;
    objective: string;
    documentId: string | null;
    conclusion: string | null;
    filedUnder: string | null;
  } | null;
  nextAction: { command: string; label: string } | null;
  lastUpdatedAt: string;
  observedAt: string;
}

export interface SyncReport {
  imported: number;
  updated: number;
  unchanged: number;
  stale: number;
  rejected: { sourceRecordId: string | null; reason: string; detail: string }[];
  cursor: string | null;
  total: number;
}

export interface ProjectionPage {
  records: BrainProjection[];
  cursor: string | null;
  more: boolean;
}

async function request<T>(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
): Promise<BrainResult<T>> {
  const config = brainConfig();
  if (!config) return { ok: false, failure: { kind: 'NOT_CONNECTED' } };
  return await requestWith(config, path, init);
}

async function requestWith<T>(
  config: BrainConfig,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
): Promise<BrainResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${config.token}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
      cache: 'no-store',
    });

    if (response.status === 404) return { ok: false, failure: { kind: 'NOT_FOUND' } };

    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const message =
        parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string'
          ? (parsed as { error: string }).error
          : 'Brain refused the request.';
      return { ok: false, failure: { kind: 'REFUSED', status: response.status, message } };
    }
    return { ok: true, value: parsed as T };
  } catch (error) {
    // Never the request, never the headers, never the token. Only what kind of
    // failure it was, and the runtime's own words for it.
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, failure: { kind: 'TIMEOUT' } };
    }
    return {
      ok: false,
      failure: {
        kind: 'UNREACHABLE',
        message: error instanceof Error ? error.message.slice(0, 200) : 'unknown transport failure',
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

function base(config: BrainConfig): string {
  return `/api/projects/${config.projectId}/connect/${SOURCE_SYSTEM}`;
}

/** One delivery, in Brain's own wire shape. */
export interface Delivery {
  sourceRecordType: typeof RECORD_TYPE;
  sourceRecordId: string;
  sourceVersion: string;
  sourceCreatedAt: string | null;
  sourceRef: string;
  title: string;
  summary: string;
  attributes: Record<string, unknown>;
}

export async function pushRecords(records: Delivery[]): Promise<BrainResult<SyncReport>> {
  const config = brainConfig();
  if (!config) return { ok: false, failure: { kind: 'NOT_CONNECTED' } };
  return await requestWith<SyncReport>(config, `${base(config)}/records`, {
    method: 'POST',
    body: { records },
  });
}

export async function readProjection(
  sourceRecordId: string,
): Promise<BrainResult<BrainProjection>> {
  const config = brainConfig();
  if (!config) return { ok: false, failure: { kind: 'NOT_CONNECTED' } };
  const result = await requestWith<{ record: BrainProjection }>(
    config,
    `${base(config)}/records/${encodeURIComponent(sourceRecordId)}`,
    { method: 'GET' },
  );
  if (!result.ok) return result;
  return { ok: true, value: result.value.record };
}

export async function readProjectionsSince(
  since: string | null,
  limit = 100,
): Promise<BrainResult<ProjectionPage>> {
  const config = brainConfig();
  if (!config) return { ok: false, failure: { kind: 'NOT_CONNECTED' } };
  const query = new URLSearchParams({ limit: String(limit) });
  if (since) query.set('since', since);
  return await requestWith<ProjectionPage>(config, `${base(config)}/records?${query.toString()}`, {
    method: 'GET',
  });
}

export interface CommandReply {
  record: BrainProjection;
  replayed: boolean;
  operationId: string;
}

/**
 * Ask Brain to do the one thing it offers.
 *
 * No idempotency header: Brain derives the key from the record and the command
 * and refuses a supplied one, because a key the caller chose would be a key the
 * caller could vary — and a varying key on a retry is not idempotency. The
 * actor is attribution and Brain treats it as such; authorization here is the
 * session on this site and the credential on that one.
 */
export async function sendCommand(input: {
  sourceRecordId: string;
  command: 'RESEARCH_FURTHER';
  actorLabel: string;
}): Promise<BrainResult<CommandReply>> {
  const config = brainConfig();
  if (!config) return { ok: false, failure: { kind: 'NOT_CONNECTED' } };
  return await requestWith<CommandReply>(
    config,
    `${base(config)}/records/${encodeURIComponent(input.sourceRecordId)}/commands`,
    {
      method: 'POST',
      body: { command: input.command, actor: { label: input.actorLabel } },
    },
  );
}

/** Words for a failure that are safe to show a person. */
export function describeFailure(failure: BrainFailure): string {
  switch (failure.kind) {
    case 'NOT_CONNECTED':
      return 'This site is not connected to a Brain.';
    case 'NOT_FOUND':
      return 'Brain does not hold this record.';
    case 'TIMEOUT':
      return 'Brain did not answer in time.';
    case 'UNREACHABLE':
      return 'Brain could not be reached.';
    case 'REFUSED':
      return failure.message;
  }
}

export { request };
