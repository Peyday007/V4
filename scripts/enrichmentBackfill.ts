/**
 * Work the contact-resolution backlog now, rather than waiting for the cron.
 *
 * Not a separate implementation — it calls the same sweep the recurring worker
 * calls, which is the point: a backfill that behaved differently from the
 * steady state would eventually enrich the same organisation twice under two
 * sets of rules.
 *
 * Safe to stop and restart. State lives in `ContactResolution`, so a run that
 * is killed halfway leaves the rest exactly where the next run finds it, and
 * safe to run while the cron is also running, because claims are conditional
 * updates.
 *
 *   npx tsx scripts/enrichmentBackfill.ts [--org <id>] [--batch 25] [--budget 300]
 */

import { prisma } from '@/lib/db';
import { drainContactResolution } from '@/lib/enrichment/schedule';
import { enrichmentOverview } from '@/lib/enrichment/report';
import { queueSummary } from '@/lib/demand/queue';
import { resolveSupply } from '@/lib/enrichment/supply';

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

async function main() {
  const orgFlag = flag('org');
  const batch = Number(flag('batch') ?? 25);
  const budgetSeconds = Number(flag('budget') ?? 300);

  const orgs = orgFlag
    ? await prisma.organization.findMany({ where: { id: orgFlag }, select: { id: true, name: true } })
    : await prisma.organization.findMany({ select: { id: true, name: true } });

  if (orgs.length === 0) {
    console.log('No organisation matched.');
    process.exit(1);
  }

  for (const org of orgs) {
    console.log(`\n=== ${org.name} ===`);
    const before = await queueSummary(org.id);
    console.log(`before: Call now ${before.call_now}, Research needed ${before.research}`);

    const result = await drainContactResolution({
      orgId: org.id,
      budgetMs: budgetSeconds * 1000,
      limit: batch,
      // Progress as it happens, because a silent backfill over a large backlog
      // is indistinguishable from a hung one.
      onBatch: (pass) => {
        if (pass.attempted === 0) return;
        console.log(
          `  ${pass.attempted} attempted — ${pass.resolved} resolved, ${pass.ambiguous} ambiguous, ` +
            `${pass.unresolved} nothing published, ${pass.failed} failed · ${pass.remaining} remaining` +
            (pass.releasedAccounts.length > 0 ? ` · released: ${pass.releasedAccounts.join(', ')}` : ''),
        );
      },
    });

    // Supply is the other half of what makes a route workable, and it is cheap:
    // a catalogue lookup, no external calls.
    const supply = await resolveSupply({ orgId: org.id });

    const after = await queueSummary(org.id);
    const overview = await enrichmentOverview(org.id);

    console.log(
      `\nattempted ${result.attempted} in ${Math.round(result.durationMs / 1000)}s: ` +
        `${result.resolved} resolved, ${result.ambiguous} ambiguous, ${result.unresolved} with nothing published, ` +
        `${result.failed} failed.`,
    );
    console.log(`after: Call now ${before.call_now} → ${after.call_now}, Research needed ${before.research} → ${after.research}`);
    console.log(
      `supply: ${supply.withVerifiedProvider} verified, ${supply.withCandidateOnly} candidate only, ` +
        `${supply.withNobody} with nobody · ${supply.tasksCreated} research task(s) raised`,
    );

    if (result.remaining > 0) {
      console.log(`${result.remaining} organisation(s) still queued — run again, or let the cron finish them.`);
    }
    for (const problem of overview.configurationProblems) {
      console.log(`\nconfiguration: ${problem.source} — ${problem.reason}\n  ${problem.fix}`);
    }
  }

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
