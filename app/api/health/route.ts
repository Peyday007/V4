import { prisma } from '@/lib/db';
import { json } from '@/lib/api';

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

  return json({ ok: Object.values(checks).every((c) => c.ok), checks }, httpStatus);
}
