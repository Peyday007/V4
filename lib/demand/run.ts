import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { hasCredential } from '@/lib/discovery/http';
import {
  AllRequestsFailedError,
  NotConfiguredError,
  explainSourceOutcome,
  getDemandConnector,
  listDemandConnectors,
  type DemandConnector,
  type SourceScopeReport,
} from './connector';
import { ensureDemandConnectorsRegistered } from './connectors';
import { ingestEvents, runDemandPipeline, type PipelineResult } from './pipeline';
import { recordOutcome } from './performance';

/**
 * Running the demand sources.
 *
 * Every run is recorded whether it succeeded or not, because a source that
 * silently returns nothing looks exactly like a quiet week and the difference
 * is the entire question when the board shows no demand. `SourceRun` is
 * written before the fetch starts and closed after it ends, so a run that
 * crashes mid-way leaves a visible RUNNING row rather than no trace at all.
 *
 * Cursors come from the last successful run's newest *source* date. The worker
 * clock never enters the window calculation — a source whose cursor advanced
 * to "now" would silently skip every record published while it was running.
 */

export type SourceRunSummary = {
  connector: string;
  name: string;
  status: 'ok' | 'failed' | 'not_configured' | 'disabled';
  recordsExamined: number;
  eventsCreated: number;
  eventsUpdated: number;
  eventsRejected: number;
  quarantined: number;
  error: string | null;
  /** Precise remedy when the status is `not_configured`. */
  howToFix: string | null;
  /** Where the records went, in one sentence. Always set. */
  outcomeReason: string;
  warnings: string[];
  durationMs: number;
};

const DEFAULT_MAX_RECORDS = 200;

export async function runDemandSource(params: {
  orgId: string;
  connectorKey: string;
  maxRecords?: number;
  states?: string[];
  config?: Record<string, unknown>;
}): Promise<SourceRunSummary> {
  ensureDemandConnectorsRegistered();
  const connector = getDemandConnector(params.connectorKey);
  if (!connector) {
    return {
      connector: params.connectorKey,
      name: params.connectorKey,
      status: 'failed',
      recordsExamined: 0,
      eventsCreated: 0,
      eventsUpdated: 0,
      eventsRejected: 0,
      quarantined: 0,
      error: `No demand connector registered under "${params.connectorKey}".`,
      howToFix: null,
      outcomeReason: `Nothing ran: no connector is registered under "${params.connectorKey}".`,
      warnings: [],
      durationMs: 0,
    };
  }

  const startedAt = Date.now();
  const dataSource = await prisma.dataSource.findFirst({
    where: { orgId: params.orgId, connector: connector.key },
  });

  const run = await prisma.sourceRun.create({
    data: {
      orgId: params.orgId,
      dataSourceId: dataSource?.id ?? null,
      connector: connector.key,
      status: 'RUNNING',
    },
  });

  const cursor = await lastSuccessfulCursor(params.orgId, connector.key);
  const since = cursor ? new Date(cursor) : null;

  try {
    const result = await connector.fetch({
      cursor,
      since,
      maxRecords: params.maxRecords ?? DEFAULT_MAX_RECORDS,
      config: { ...((dataSource?.config as Record<string, unknown>) ?? {}), ...(params.config ?? {}) },
      states: params.states ?? [],
      rateLimitPerMin: dataSource?.rateLimitPerMin,
    });

    // Every record the source looked at, counted at the top of the chain. A
    // source that examines ten thousand rows to produce two events has a
    // signal-to-noise problem that only this comparison exposes.
    if (result.recordsExamined > 0) {
      await recordOutcome({
        orgId: params.orgId,
        connector: connector.key,
        stage: 'SOURCE_RECORD',
        note: `${result.recordsExamined} record(s) examined`,
      });
    }

    const ingest = await ingestEvents({
      orgId: params.orgId,
      connector: connector.key,
      events: result.events,
      sourceReliability: await reliabilityOf(params.orgId, connector.key),
    });

    // Two funnels feed the sentence, and both matter. The connector's own says
    // which rows never became candidate events; the ingest's says which
    // candidates the pipeline then refused. A source can be blameless at the
    // first stage and still produce nothing.
    const funnel = result.funnel ?? [];
    const outcomeReason = [
      explainSourceOutcome({
        connectorKey: connector.key,
        eventsCreated: ingest.created,
        eventsUpdated: ingest.updated,
        recordsExamined: result.recordsExamined,
        funnel,
      }),
      ...(ingest.rejected > 0
        ? [
            `${ingest.rejected} candidate event(s) were then refused by ingest`
              + (ingest.rejectionReasons.length > 0
                ? `: ${[...new Set(ingest.rejectionReasons)].slice(0, 3).join('; ')}.`
                : '.'),
          ]
        : []),
      ...(ingest.quarantined > 0 ? [`${ingest.quarantined} were quarantined pending corroboration.`] : []),
    ].join(' ');

    await prisma.sourceRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        status: 'OK',
        recordsExamined: result.recordsExamined,
        eventsCreated: ingest.created,
        eventsUpdated: ingest.updated,
        eventsRejected: ingest.rejected,
        cursor: result.nextCursor,
        windowStart: since,
        // The newest source date reached, not the moment the run ended.
        windowEnd: result.nextCursor ? new Date(result.nextCursor) : null,
        outcomeReason: outcomeReason.slice(0, 4000),
        details: {
          warnings: result.warnings,
          quarantined: ingest.quarantined,
          rejectionReasons: ingest.rejectionReasons.slice(0, 10),
          funnel: funnel as unknown as Prisma.InputJsonValue,
        } as Prisma.InputJsonValue,
      },
    });

    if (dataSource) {
      await prisma.dataSource.update({
        where: { id: dataSource.id },
        data: {
          lastRunAt: new Date(),
          lastRunStatus: 'ok',
          lastRecordCount: result.recordsExamined,
          consecutiveFailures: 0,
        },
      });
    }

    return {
      connector: connector.key,
      name: connector.name,
      status: 'ok',
      recordsExamined: result.recordsExamined,
      eventsCreated: ingest.created,
      eventsUpdated: ingest.updated,
      eventsRejected: ingest.rejected,
      quarantined: ingest.quarantined,
      error: null,
      howToFix: null,
      outcomeReason,
      warnings: result.warnings,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const notConfigured = error instanceof NotConfiguredError;
    const message =
      error instanceof AllRequestsFailedError || notConfigured
        ? error.message
        : String(error).slice(0, 500);

    const outcomeReason = notConfigured
      ? `Did not run. ${message}`
      : error instanceof AllRequestsFailedError
        ? `Reached nothing. Every request failed, so no record was examined and the emptiness `
          + `says nothing about the source. ${message}`
        : `The run ended in an error before it could report a breakdown. ${message}`;

    await prisma.sourceRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        // A configuration gap is not a fault. Reporting them the same way
        // buries a broken source under a wall of unconfigured ones.
        status: notConfigured ? 'NOT_CONFIGURED' : 'FAILED',
        error: message,
        outcomeReason: outcomeReason.slice(0, 4000),
      },
    });

    if (dataSource && !notConfigured) {
      await prisma.dataSource.update({
        where: { id: dataSource.id },
        data: {
          lastRunAt: new Date(),
          lastRunStatus: 'failed',
          lastErrorAt: new Date(),
          consecutiveFailures: { increment: 1 },
        },
      });
    }

    return {
      connector: connector.key,
      name: connector.name,
      status: notConfigured ? 'not_configured' : 'failed',
      recordsExamined: 0,
      eventsCreated: 0,
      eventsUpdated: 0,
      eventsRejected: 0,
      quarantined: 0,
      error: message,
      howToFix: notConfigured ? (error as NotConfiguredError).howToFix : null,
      outcomeReason,
      warnings: [],
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * Runs every enabled demand source, then the pipeline once.
 *
 * The pipeline runs after all sources rather than after each, so an event
 * corroborated by two sources is verified once with both pieces of evidence
 * in place.
 */
export async function runAllDemandSources(params: {
  orgId: string;
  userId?: string;
  maxRecordsPerSource?: number;
}): Promise<{ sources: SourceRunSummary[]; pipeline: PipelineResult }> {
  ensureDemandConnectorsRegistered();

  const enabled = await enabledConnectors(params.orgId);
  const sources: SourceRunSummary[] = [];

  for (const connector of enabled) {
    sources.push(
      await runDemandSource({
        orgId: params.orgId,
        connectorKey: connector.key,
        maxRecords: params.maxRecordsPerSource,
      }),
    );
  }

  const pipeline = await runDemandPipeline({ orgId: params.orgId, userId: params.userId });
  return { sources, pipeline };
}

/**
 * Which demand connectors should run.
 *
 * A connector needing a credential that is absent is skipped rather than run
 * and failed — the health panel already reports it as unconfigured, and
 * failing it every hour buries real faults.
 */
export async function enabledConnectors(orgId: string): Promise<DemandConnector[]> {
  ensureDemandConnectorsRegistered();
  const rows = await prisma.dataSource.findMany({ where: { orgId }, select: { connector: true, isEnabled: true } });
  const byKey = new Map(rows.map((r) => [r.connector, r.isEnabled]));

  return listDemandConnectors().filter((connector) => {
    const explicit = byKey.get(connector.key);
    if (explicit === false) return false;
    if (connector.credentialEnvVar && !hasCredential(connector.credentialEnvVar)) return false;
    return true;
  });
}

async function lastSuccessfulCursor(orgId: string, connector: string): Promise<string | null> {
  const run = await prisma.sourceRun.findFirst({
    where: { orgId, connector, status: 'OK', cursor: { not: null } },
    orderBy: { startedAt: 'desc' },
    select: { cursor: true },
  });
  return run?.cursor ?? null;
}

/**
 * How much a source has earned trust, from its own history.
 *
 * Starts neutral and moves on outcomes rather than on volume: a source
 * producing a hundred records that all quarantine is not reliable.
 */
async function reliabilityOf(orgId: string, connector: string): Promise<number> {
  const runs = await prisma.sourceRun.findMany({
    where: { orgId, connector, finishedAt: { not: null } },
    orderBy: { startedAt: 'desc' },
    take: 20,
    select: { status: true, eventsCreated: true, eventsRejected: true },
  });
  if (runs.length === 0) return 0.5;

  const ok = runs.filter((r) => r.status === 'OK').length;
  const created = runs.reduce((sum, r) => sum + r.eventsCreated, 0);
  const rejected = runs.reduce((sum, r) => sum + r.eventsRejected, 0);
  const successRate = ok / runs.length;
  const usefulRate = created + rejected === 0 ? 0.5 : created / (created + rejected);
  return Math.max(0.1, Math.min(0.95, successRate * 0.6 + usefulRate * 0.4));
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export type SourceHealth = {
  connector: string;
  name: string;
  enabled: boolean;
  /** Whether it has everything it needs to run at all. */
  configured: boolean;
  configurationNote: string;
  credentialEnvVar: string | null;
  credentialPresent: boolean;
  eventFamilies: string[];
  pollIntervalMinutes: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastStatus: string | null;
  recordsExamined: number;
  eventsCreated: number;
  eventsUpdated: number;
  eventsRejected: number;
  error: string | null;
  nextScheduledAt: string | null;
  /**
   * Where the last attempt's records went.
   *
   * Read from the last *attempt*, not the last success, because the case this
   * exists for is a source that has been attempting and producing nothing.
   * Pointing at the last success would show a healthy sentence from three
   * weeks ago next to a board that has been empty ever since.
   */
  outcomeReason: string | null;
  /** Per-scope breakdown behind the sentence, for whoever wants the detail. */
  funnel: SourceScopeReport[];
};

export async function demandSourceHealth(orgId: string): Promise<SourceHealth[]> {
  ensureDemandConnectorsRegistered();

  const [rows, runs] = await Promise.all([
    prisma.dataSource.findMany({ where: { orgId }, select: { connector: true, isEnabled: true } }),
    prisma.sourceRun.findMany({
      where: { orgId },
      orderBy: { startedAt: 'desc' },
      take: 200,
    }),
  ]);
  const enabledByKey = new Map(rows.map((r) => [r.connector, r.isEnabled]));

  return listDemandConnectors().map((connector) => {
    const mine = runs.filter((r) => r.connector === connector.key);
    const lastAttempt = mine[0] ?? null;
    const lastSuccess = mine.find((r) => r.status === 'OK') ?? null;
    const credentialPresent = connector.credentialEnvVar ? hasCredential(connector.credentialEnvVar) : true;
    const enabled = enabledByKey.get(connector.key) !== false && credentialPresent;

    return {
      connector: connector.key,
      name: connector.name,
      enabled,
      configured: credentialPresent,
      configurationNote: connector.credentialEnvVar
        ? credentialPresent
          ? `${connector.credentialEnvVar} is set.`
          : `${connector.credentialEnvVar} is not set, so this source is skipped. It is optional.`
        : 'No credential required.',
      credentialEnvVar: connector.credentialEnvVar,
      credentialPresent,
      eventFamilies: connector.eventFamilies,
      pollIntervalMinutes: connector.pollIntervalMinutes,
      lastAttemptAt: lastAttempt?.startedAt.toISOString() ?? null,
      lastSuccessAt: lastSuccess?.startedAt.toISOString() ?? null,
      lastStatus: lastAttempt?.status ?? null,
      recordsExamined: lastSuccess?.recordsExamined ?? 0,
      eventsCreated: lastSuccess?.eventsCreated ?? 0,
      eventsUpdated: lastSuccess?.eventsUpdated ?? 0,
      eventsRejected: lastSuccess?.eventsRejected ?? 0,
      error: lastAttempt?.error ?? null,
      nextScheduledAt: lastAttempt
        ? new Date(lastAttempt.startedAt.getTime() + connector.pollIntervalMinutes * 60_000).toISOString()
        : null,
      outcomeReason:
        lastAttempt?.outcomeReason
        ?? (lastAttempt
          ? 'This run predates per-stage reporting, so where its records went was not recorded.'
          : 'This source has never been attempted.'),
      funnel: readFunnel(lastAttempt?.details),
    };
  });
}

/** The stored funnel, defensively — `details` is free-form JSON on old rows. */
function readFunnel(details: unknown): SourceScopeReport[] {
  if (!details || typeof details !== 'object') return [];
  const raw = (details as Record<string, unknown>).funnel;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (s): s is SourceScopeReport =>
      Boolean(s) && typeof (s as SourceScopeReport).scope === 'string',
  );
}

/** Sources whose poll interval has elapsed since their last attempt. */
export async function dueConnectors(orgId: string, now = new Date()): Promise<DemandConnector[]> {
  const enabled = await enabledConnectors(orgId);
  const due: DemandConnector[] = [];

  for (const connector of enabled) {
    const last = await prisma.sourceRun.findFirst({
      where: { orgId, connector: connector.key },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    });
    if (!last || now.getTime() - last.startedAt.getTime() >= connector.pollIntervalMinutes * 60_000) {
      due.push(connector);
    }
  }
  return due;
}
