import { runCron } from '@/lib/jobs/cron';

export const dynamic = 'force-dynamic';
// Vercel serverless functions are capped; 60s is the Hobby ceiling.
export const maxDuration = 60;

/**
 * The frequent tick: work the contact backlog, then drain the job queue.
 *
 * The mode is the path rather than a query parameter. `/api/cron?mode=daily`
 * still works and is what the deployment used to run, but a scheduler that
 * drops the query string silently downgrades to the cheap mode and reports
 * success — and a scheduler quietly running the wrong thing forever is the
 * exact failure this endpoint exists to recover from.
 *
 * Written as its own segment rather than `[mode]`, because a dynamic segment
 * alongside the parent's own `route.ts` does not resolve in this Next version:
 * the parent handler wins and every child path 404s.
 */
export async function GET(request: Request) {
  return runCron(request, 'tick');
}

/**
 * The same tick, for callers that use the verb this actually is.
 *
 * GET is here because the platform's scheduler issues one and cannot be told
 * otherwise. But this endpoint drains a queue and writes, so POST is the
 * honest verb, and a caller that reasonably used it was getting a 405 — which
 * reads as "the deployment is broken" rather than "wrong method". Both routes
 * go through the same authorisation inside `runCron`; nothing is relaxed by
 * accepting a second verb.
 */
export async function POST(request: Request) {
  return runCron(request, 'tick');
}
