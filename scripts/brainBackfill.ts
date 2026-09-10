/**
 * Send this site's existing opportunities to Brain, once, safely, repeatedly.
 *
 *   npx tsx scripts/brainBackfill.ts            # every organisation
 *   npx tsx scripts/brainBackfill.ts --org <id> # one
 *   npx tsx scripts/brainBackfill.ts --dry-run  # count what would be sent
 *
 * It is the same code path the `brain.push` job runs, called in a loop until
 * the cursor stops moving, so there is no second implementation of the import
 * to get out of step with the first. Running it twice is free: the second run
 * finds every record already at the version Brain holds, sends nothing, and
 * reports `unchanged`.
 *
 * Nothing here deletes, overwrites or reconstructs anything on either side. A
 * record Brain refuses keeps its rejection on Brain's ledger with a reason and
 * is reconsidered on the next run rather than being marked done.
 */
import { prisma } from '../lib/db';
import { brainConfig, describeBrain } from '../lib/brain/config';
import { pushChanges } from '../lib/brain/sync';
import { toDelivery } from '../lib/brain/map';

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return process.argv[index + 1] ?? '';
}

async function main(): Promise<void> {
  if (!brainConfig()) {
    console.error(
      'This site is not connected to a Brain. Set BRAIN_URL, BRAIN_TOKEN and ' +
        'BRAIN_PROJECT_ID, then run this again. Nothing was sent.',
    );
    process.exitCode = 1;
    return;
  }
  console.log(`Brain: ${describeBrain()}`);

  const orgFilter = flag('org');
  const dryRun = process.argv.includes('--dry-run');
  const orgs = await prisma.organization.findMany({
    where: orgFilter ? { id: orgFilter } : {},
    select: { id: true, name: true },
  });
  if (orgs.length === 0) {
    console.error('No organisation matched.');
    process.exitCode = 1;
    return;
  }

  for (const org of orgs) {
    const total = await prisma.opportunity.count({ where: { orgId: org.id } });
    console.log(`\n${org.name} — ${total} opportunity(ies)`);

    if (dryRun) {
      const sample = await prisma.opportunity.findMany({
        where: { orgId: org.id },
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        take: 3,
        include: { lane: { select: { name: true } } },
      });
      for (const opportunity of sample) {
        const delivery = toDelivery(opportunity);
        console.log(
          `  would send ${delivery.sourceRecordId} @ ${delivery.sourceVersion} — ${delivery.title}`,
        );
      }
      console.log('  (dry run: nothing was sent)');
      continue;
    }

    const totals = { imported: 0, updated: 0, unchanged: 0, stale: 0, rejected: 0 };
    let pages = 0;
    for (;;) {
      const result = await pushChanges({ orgId: org.id });
      if (result.error) {
        console.error(`  stopped: ${result.error}`);
        process.exitCode = 1;
        break;
      }
      totals.imported += result.imported;
      totals.updated += result.updated;
      totals.unchanged += result.unchanged;
      totals.stale += result.stale;
      totals.rejected += result.rejected.length;
      for (const rejection of result.rejected) {
        console.warn(`  refused ${rejection.sourceRecordId ?? '(no id)'}: ${rejection.reason}`);
      }
      pages += 1;
      if (!result.more) break;
      // A guard rather than a limit: the cursor advances every page, so this
      // can only be reached if something is wrong with the cursor itself.
      if (pages > 10_000) {
        console.error('  stopped: the cursor is not advancing.');
        process.exitCode = 1;
        break;
      }
    }

    console.log(
      `  imported ${totals.imported}, updated ${totals.updated}, ` +
        `unchanged ${totals.unchanged}, older-than-held ${totals.stale}, ` +
        `refused ${totals.rejected} (${pages} page(s))`,
    );
  }

  await prisma.$disconnect();
}

void main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
  await prisma.$disconnect();
});
