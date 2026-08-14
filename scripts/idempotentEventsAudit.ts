/**
 * The engine agreeing with itself is not an event.
 *
 * The portfolio audit counted 26 activity rows and 37 AI-decision rows that
 * repeated an identical line, on a portfolio that was mostly fixtures. The
 * cause was not a loop or a bug: scoring and the next-action table are
 * deterministic and run on a schedule, so a deal nobody has touched gets the
 * same answer written to it again every few hours. Three identical rows read
 * as a trail of deliberation and are one decision and two reruns.
 *
 * This drives the real writers against Postgres and checks four things:
 * a rerun writes nothing, a genuine change writes, a change and a return
 * writes twice, and an occurrence — something that actually happened — is
 * never suppressed however often it repeats.
 *
 *   npx tsx scripts/idempotentEventsAudit.ts
 */

import { prisma } from '@/lib/db';
import { recordActivity } from '@/lib/audit';
import { recordDecision } from '@/lib/ai/decisions';
import { collapseRepeats } from '@/lib/activity/collapse';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`);
  }
}

function refuseUnlessLocal() {
  const host = /@([^/:]+)/.exec(process.env.DATABASE_URL ?? '')?.[1] ?? '';
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    console.error(`Writes activity and decisions; local databases only. DATABASE_URL points at "${host}".`);
    process.exit(1);
  }
}

const MARK = 'IDEMPOTENCE-AUDIT';

async function main() {
  refuseUnlessLocal();
  const org = await prisma.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  const opportunity = await prisma.opportunity.findFirst({ where: { orgId: org.id }, select: { id: true } });

  console.log('='.repeat(72));
  console.log('IDEMPOTENT DERIVED EVENTS — a rerun is not a decision');
  console.log('='.repeat(72));
  if (!opportunity) {
    console.log('\nNo opportunity in the local database to write against. Nothing to check.');
    return;
  }

  const verb = `${MARK}.derived`;
  const count = () =>
    prisma.activityEvent.count({ where: { orgId: org.id, opportunityId: opportunity.id, verb } });
  const decisions = () =>
    prisma.aIDecision.count({ where: { orgId: org.id, opportunityId: opportunity.id, process: MARK } });

  const derived = (summary: string) =>
    recordActivity({ orgId: org.id, opportunityId: opportunity.id, verb, summary, derived: true });
  const decide = (decision: string) =>
    recordDecision({
      orgId: org.id,
      opportunityId: opportunity.id,
      process: MARK,
      decision,
      reason: 'audit',
      modelName: 'deterministic',
      promptVersion: 'audit',
      derived: true,
    });

  // -- 1. a rerun writes nothing -------------------------------------------
  console.log('\n--- the same conclusion, three times ----------------------------');
  const before = await count();
  await derived('Next action: confirm timeline');
  await derived('Next action: confirm timeline');
  await derived('Next action: confirm timeline');
  check('three identical derived events write one row', (await count()) - before === 1, `wrote ${(await count()) - before}`);

  const decisionsBefore = await decisions();
  const firstId = await decide('Composite 0.505');
  const secondId = await decide('Composite 0.505');
  check('an unchanged decision writes one row', (await decisions()) - decisionsBefore === 1);
  check(
    'and the caller still gets an id pointing at the decision that stands',
    firstId === secondId,
    `${firstId} vs ${secondId}`,
  );

  // -- 2. a real change writes ----------------------------------------------
  console.log('\n--- something actually changed ----------------------------------');
  await derived('Next action: chase the quote');
  check('a changed conclusion is recorded', (await count()) - before === 2);

  // -- 3. changing back is news ---------------------------------------------
  console.log('\n--- and changed back --------------------------------------------');
  await derived('Next action: confirm timeline');
  check(
    'returning to an earlier conclusion writes again, because moving back is information',
    (await count()) - before === 3,
    `${(await count()) - before} row(s)`,
  );

  // -- 4. occurrences are never suppressed ----------------------------------
  console.log('\n--- things that actually happened -------------------------------');
  const occurrenceVerb = `${MARK}.occurrence`;
  const occurrences = () =>
    prisma.activityEvent.count({ where: { orgId: org.id, opportunityId: opportunity.id, verb: occurrenceVerb } });
  for (let i = 0; i < 3; i += 1) {
    await recordActivity({
      orgId: org.id,
      opportunityId: opportunity.id,
      verb: occurrenceVerb,
      summary: 'Call logged',
    });
  }
  check(
    'three calls with the same summary are three events, not one',
    (await occurrences()) === 3,
    `${await occurrences()}`,
  );

  // -- 5. the feed reads correctly ------------------------------------------
  console.log('\n--- what the feed shows -----------------------------------------');
  const rows = await prisma.activityEvent.findMany({
    where: { orgId: org.id, opportunityId: opportunity.id, verb: occurrenceVerb },
    orderBy: { createdAt: 'desc' },
    select: { id: true, createdAt: true, summary: true, actorType: true, verb: true },
  });
  const collapsed = collapseRepeats(rows);
  check('the three calls collapse to one line in the feed', collapsed.length === 1);
  check('and that line says how many there were', collapsed[0]?.repeats === 3, String(collapsed[0]?.repeats));

  // -- 6. stalled deals stop looking fresh ----------------------------------
  console.log('\n--- a rerun does not refresh lastActivityAt ---------------------');
  await prisma.opportunity.update({
    where: { id: opportunity.id },
    data: { lastActivityAt: new Date('2020-01-01T00:00:00.000Z') },
  });
  await derived('Next action: confirm timeline');
  const after = await prisma.opportunity.findUniqueOrThrow({
    where: { id: opportunity.id },
    select: { lastActivityAt: true },
  });
  check(
    'an opportunity nobody touched still reads as untouched',
    after.lastActivityAt?.getUTCFullYear() === 2020,
    String(after.lastActivityAt),
  );

  // -- cleanup ---------------------------------------------------------------
  const removedActivity = await prisma.activityEvent.deleteMany({
    where: { orgId: org.id, verb: { startsWith: MARK } },
  });
  const removedDecisions = await prisma.aIDecision.deleteMany({
    where: { orgId: org.id, process: MARK },
  });
  console.log(`\nCleaned up ${removedActivity.count} activity row(s) and ${removedDecisions.count} decision(s).`);

  console.log(`\n${'='.repeat(72)}`);
  console.log(`${passed}/${passed + failed} checks passed.`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(process.exitCode ?? 0);
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
