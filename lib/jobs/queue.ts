import { randomUUID } from 'node:crypto';
import type { Job, JobStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { redactForLogs } from '@/lib/audit';

/**
 * Durable, Postgres-backed job queue.
 *
 * Chosen over an in-process queue because the operating loop must survive a
 * restart: a transcript half-processed at deploy time cannot be silently lost.
 * Locking uses a conditional update so two workers never claim the same row.
 */

export type JobKind =
  | 'discovery.run_source'
  | 'discovery.run_all'
  | 'discovery.promote_signals'
  | 'demand.poll_sources'
  | 'demand.run_pipeline'
  /** The recurring contact-resolution worker. Schedules, then works the batch. */
  | 'enrichment.resolve_contacts'
  /** Re-runs provider matching when the supply catalogue has changed. */
  | 'supply.match_routes'
  | 'transcription.process'
  | 'transcript.analyze'
  /// The live call path. Named apart from the two above, which belong to the
  /// older Call/Opportunity layer and operate on different rows.
  | 'call.transcribe'
  | 'call.analyse'
  | 'call.expire_recordings'
  | 'matching.run'
  | 'scoring.run'
  | 'scoring.run_all'
  | 'deal.configure'
  | 'next_action.determine'
  | 'next_action.refresh_all'
  | 'planning.daily'
  | 'vulnerability.assess_all'
  | 'lanes.evaluate_all'
  | 'analytics.snapshot'
  | 'followup.generate'
  | 'document.generate'
  | 'notification.send';

export type EnqueueOptions = {
  orgId: string;
  kind: JobKind;
  payload?: Record<string, unknown>;
  runAfter?: Date;
  priority?: number;
  maxAttempts?: number;
  /** Guarantees at-most-one queued job for a logical unit of work. */
  idempotencyKey?: string;
  /**
   * Treat a finished job under the same key as "already done" and skip.
   *
   * The default is to re-enqueue once a previous run completed, which is what
   * you want for per-record work. A date-stamped scheduler key wants the
   * opposite: the daily sweep must not run twice because the cron retried.
   */
  skipIfCompleted?: boolean;
};

export async function enqueue(options: EnqueueOptions): Promise<Job | null> {
  const data = {
    orgId: options.orgId,
    kind: options.kind,
    payload: (options.payload ?? {}) as object,
    runAfter: options.runAfter ?? new Date(),
    priority: options.priority ?? 100,
    maxAttempts: options.maxAttempts ?? 3,
    idempotencyKey: options.idempotencyKey ?? null,
  };

  if (!options.idempotencyKey) return prisma.job.create({ data });

  const existing = await prisma.job.findUnique({
    where: { orgId_idempotencyKey: { orgId: options.orgId, idempotencyKey: options.idempotencyKey } },
  });
  // Re-enqueue only if the previous run finished; otherwise the key is held.
  if (existing) {
    if (existing.status === 'QUEUED' || existing.status === 'RUNNING') return null;
    if (options.skipIfCompleted && (existing.status === 'SUCCEEDED' || existing.status === 'DEAD')) return null;
    return prisma.job.update({
      where: { id: existing.id },
      data: { ...data, status: 'QUEUED', attempts: 0, lockedAt: null, lockedBy: null, lastError: null, result: undefined },
    });
  }
  return prisma.job.create({ data });
}

/**
 * Claims one job atomically. `updateMany` with the status guard means a losing
 * worker updates zero rows and simply tries the next candidate.
 */
export async function claimJob(workerId: string): Promise<Job | null> {
  const candidates = await prisma.job.findMany({
    where: { status: 'QUEUED', runAfter: { lte: new Date() } },
    orderBy: [{ priority: 'asc' }, { runAfter: 'asc' }],
    take: 10,
  });

  for (const candidate of candidates) {
    const claimed = await prisma.job.updateMany({
      where: { id: candidate.id, status: 'QUEUED' },
      data: { status: 'RUNNING', lockedAt: new Date(), lockedBy: workerId, startedAt: new Date(), attempts: { increment: 1 } },
    });
    if (claimed.count === 1) return prisma.job.findUnique({ where: { id: candidate.id } });
  }
  return null;
}

export async function completeJob(jobId: string, result: unknown): Promise<void> {
  await prisma.job.update({
    where: { id: jobId },
    data: { status: 'SUCCEEDED', result: (result ?? {}) as object, finishedAt: new Date(), lockedAt: null, lockedBy: null },
  });
}

/** Exponential backoff on retry; DEAD once attempts are exhausted. */
export async function failJob(jobId: string, error: unknown): Promise<JobStatus> {
  const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
  const message = redactForLogs(error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)).slice(0, 4000);
  const exhausted = job.attempts >= job.maxAttempts;
  const status: JobStatus = exhausted ? 'DEAD' : 'QUEUED';

  await prisma.job.update({
    where: { id: jobId },
    data: {
      status,
      lastError: message,
      lockedAt: null,
      lockedBy: null,
      finishedAt: exhausted ? new Date() : null,
      runAfter: exhausted ? job.runAfter : new Date(Date.now() + Math.min(300_000, 2 ** job.attempts * 5_000)),
    },
  });
  return status;
}

/** Releases jobs whose worker died mid-run. */
export async function reclaimStaleJobs(staleAfterMs = 300_000): Promise<number> {
  const cutoff = new Date(Date.now() - staleAfterMs);
  const result = await prisma.job.updateMany({
    where: { status: 'RUNNING', lockedAt: { lt: cutoff } },
    data: { status: 'QUEUED', lockedAt: null, lockedBy: null, lastError: 'Reclaimed after worker timeout' },
  });
  return result.count;
}

export function newWorkerId(): string {
  return `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
}
