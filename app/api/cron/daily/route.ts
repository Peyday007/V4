import { runCron } from '@/lib/jobs/cron';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * The daily sweep: everything the tick does, plus discovery, follow-up
 * generation, the daily plan and metrics.
 *
 * See `../tick/route.ts` for why the mode is a path segment.
 */
export async function GET(request: Request) {
  return runCron(request, 'daily');
}
