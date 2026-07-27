/** Long-running background worker. Start with `npm run worker`. */
import { env } from '../lib/env';
import { runWorker } from '../lib/jobs/runner';

const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
process.on('SIGTERM', () => controller.abort());

const config = env();
runWorker({
  pollMs: config.WORKER_POLL_MS,
  batchSize: config.WORKER_CONCURRENCY,
  signal: controller.signal,
}).catch((error) => {
  console.error('[worker] fatal:', error);
  process.exit(1);
});
