import { redactForLogs } from '@/lib/audit';
import { getHandler } from './handlers';
import { claimJob, completeJob, failJob, newWorkerId, reclaimStaleJobs } from './queue';

export type TickResult = { processed: number; succeeded: number; failed: number; reclaimed: number };

/**
 * Processes up to `max` jobs. Used both by the long-running worker and by the
 * /api/jobs/tick endpoint, so a deployment without a separate worker process
 * can still drive the loop from a scheduler.
 */
export async function processJobs(max = 10, workerId = newWorkerId()): Promise<TickResult> {
  const reclaimed = await reclaimStaleJobs();
  const result: TickResult = { processed: 0, succeeded: 0, failed: 0, reclaimed };

  for (let i = 0; i < max; i++) {
    const job = await claimJob(workerId);
    if (!job) break;
    result.processed += 1;

    const handler = getHandler(job.kind);
    if (!handler) {
      await failJob(job.id, new Error(`No handler registered for job kind "${job.kind}"`));
      result.failed += 1;
      continue;
    }

    try {
      const output = await handler(job);
      await completeJob(job.id, output);
      result.succeeded += 1;
    } catch (error) {
      const status = await failJob(job.id, error);
      result.failed += 1;
      console.error(`[jobs] ${job.kind} (${job.id}) -> ${status}:`, redactForLogs(String(error)));
    }
  }

  return result;
}

/** Long-running worker loop. Entry point for `npm run worker`. */
export async function runWorker(options: { pollMs?: number; batchSize?: number; signal?: AbortSignal } = {}): Promise<void> {
  const pollMs = options.pollMs ?? 2000;
  const batchSize = options.batchSize ?? 5;
  const workerId = newWorkerId();
  console.info(`[worker] ${workerId} started (poll ${pollMs}ms, batch ${batchSize})`);

  while (!options.signal?.aborted) {
    try {
      const result = await processJobs(batchSize, workerId);
      if (result.processed === 0) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    } catch (error) {
      console.error('[worker] loop error:', redactForLogs(String(error)));
      await new Promise((resolve) => setTimeout(resolve, pollMs * 2));
    }
  }
  console.info(`[worker] ${workerId} stopped`);
}
