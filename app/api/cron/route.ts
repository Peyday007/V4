import { runCron, type CronMode } from '@/lib/jobs/cron';

export const dynamic = 'force-dynamic';
// Vercel serverless functions are capped; 60s is the Hobby ceiling.
export const maxDuration = 60;

/**
 * Scheduler entry point.
 *
 *   GET /api/cron/tick    drain the queue and work the contact backlog
 *   GET /api/cron/daily   the above, plus discovery, follow-ups, plan, metrics
 *   GET /api/cron?mode=…  the same thing, kept for schedulers already using it
 *
 * Both spellings exist deliberately. A scheduler that strips the query string —
 * and not every one preserves it — would quietly run `tick` forever while
 * reporting success, so the mode is available in the path where nothing can
 * drop it.
 */
export async function GET(request: Request) {
  const mode: CronMode = new URL(request.url).searchParams.get('mode') === 'daily' ? 'daily' : 'tick';
  return runCron(request, mode);
}
