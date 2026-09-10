import { prisma } from '@/lib/db';
import { json } from '@/lib/api';
import { describeBrain, isConnected } from '@/lib/brain/config';
import { readProjectionsSince, describeFailure } from '@/lib/brain/client';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Unauthenticated health check.
 *
 * Deliberately reachable without a session: the failures worth diagnosing —
 * an unreachable database, a schema that migrations never applied, an empty
 * user table — are all failures that make signing in impossible. It reports
 * only whether things work, never data.
 */
export async function GET() {
  const checks: Record<string, { ok: boolean; detail: string }> = {};
  let httpStatus = 200;

  // 1. Can we reach the database at all?
  try {
    const started = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    checks.database = { ok: true, detail: `Reachable in ${Date.now() - started}ms` };
  } catch (error) {
    httpStatus = 503;
    checks.database = {
      ok: false,
      detail:
        'Cannot reach the database. Check DATABASE_URL, and note that a serverless deployment needs the POOLED connection string. ' +
        `(${String(error).slice(0, 160)})`,
    };
    return json({ ok: false, checks }, httpStatus);
  }

  // 2. Has every migration actually been applied? This is the failure mode
  //    that looks like a random application error on an unrelated page.
  try {
    const applied = await prisma.$queryRaw<Array<{ migration_name: string; finished_at: Date | null }>>`
      SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY started_at ASC
    `;
    const pending = applied.filter((m) => m.finished_at === null);
    checks.migrations = {
      ok: pending.length === 0,
      detail:
        pending.length === 0
          ? `${applied.length} migration(s) applied: ${applied.map((m) => m.migration_name).join(', ')}`
          : `${pending.length} migration(s) started but never finished: ${pending.map((m) => m.migration_name).join(', ')}`,
    };
    if (pending.length > 0) httpStatus = 503;
  } catch {
    httpStatus = 503;
    checks.migrations = { ok: false, detail: 'No _prisma_migrations table — the schema was never created. Redeploy so the build runs migrations.' };
  }

  // 3. Does the running code's schema match the database's? A column the
  //    client selects but the database lacks breaks pages far from the change.
  try {
    await prisma.message.findFirst({ select: { id: true, purpose: true, outcome: true, costCents: true } });
    await prisma.contact.findFirst({ select: { id: true, consentToSms: true, hasMobile: true } });
    checks.schema = { ok: true, detail: 'Database columns match the deployed code.' };
  } catch (error) {
    httpStatus = 503;
    checks.schema = {
      ok: false,
      detail:
        'The database is missing columns this version of the code expects. Redeploy — the build applies migrations. ' +
        `(${String(error).slice(0, 200)})`,
    };
  }

  // 4. Is there anything to sign in with?
  try {
    const [users, opportunities] = await Promise.all([prisma.user.count(), prisma.opportunity.count()]);
    checks.data = {
      ok: users > 0,
      detail:
        users > 0
          ? `${users} user(s), ${opportunities} opportunity(ies).`
          : 'No users exist. Run the seed at /api/admin/seed?secret=YOUR_CRON_SECRET',
    };
  } catch (error) {
    checks.data = { ok: false, detail: String(error).slice(0, 160) };
  }

  /*
   * 5. Is this site connected to a Brain, and does that Brain answer?
   *
   * Two different facts, reported separately, for the reason Brain itself
   * reports configuration and operation separately: having the variables set is
   * not the same fact as the other end answering. A connector that was
   * configured against the wrong project, or with a credential that has been
   * revoked, is *configured* and does not work, and an operator needs to be
   * able to tell those apart without reading a log.
   *
   * It names the host and the project and never the credential — the same rule
   * every diagnostic in both codebases follows. And it never makes the whole
   * health check fail: an unreachable Brain is not a reason to report this site
   * as down, because every page except one still works without it.
   */
  if (!isConnected()) {
    checks.brain = {
      ok: true,
      detail:
        'Not connected. Set BRAIN_URL, BRAIN_TOKEN and BRAIN_PROJECT_ID to connect this site ' +
        'to a Brain; with any of them missing the panel does not render and nothing else changes.',
    };
  } else {
    const probe = await readProjectionsSince(null, 1);
    checks.brain = probe.ok
      ? {
          ok: true,
          detail:
            `Connected to ${describeBrain()} — it answered, and holds ` +
            `${probe.value.records.length === 0 && !probe.value.more ? 'no records from this site yet' : 'records from this site'}.`,
        }
      : {
          ok: true,
          detail: `Configured for ${describeBrain()}, and it did not answer: ${describeFailure(probe.failure)}`,
        };
  }

  return json({ ok: Object.values(checks).every((c) => c.ok), checks }, httpStatus);
}
