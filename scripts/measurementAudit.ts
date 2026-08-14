/**
 * Measurement against a real Postgres.
 *
 * The unit tests cover the arithmetic. This covers what only the database can
 * answer:
 *
 *   Whether the Postgres enum's own sort order still matches the funnel's. It
 *   does not, because this phase appended four values to the type — so this
 *   asserts the disagreement exists and that nothing in the codebase sorts by
 *   it. A silent ORDER BY on that column reads the funnel backwards.
 *
 *   Whether the funnel actually fills as work happens, through the real
 *   library calls rather than by inserting rows.
 *
 *   Whether an assignment survives a route changing tier mid-experiment.
 *
 *   Whether a guardrail regression genuinely blocks a winner being recorded.
 *
 *   npx tsx scripts/measurementAudit.ts
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '@/lib/db';
import { FUNNEL, funnelReport, recordCallOutcome, recordStage } from '@/lib/measure/funnel';
import { armFor, readOut, startExperiment, concludeExperiment, assignArm } from '@/lib/measure/experiments';
import { publishVersion, rollbackTo, resolveVersion, versionHistory } from '@/lib/measure/versions';
import { sourcePerformance } from '@/lib/measure/analytics';

let failures = 0;
let checks = 0;

function check(label: string, passed: boolean, detail = '') {
  checks += 1;
  if (!passed) failures += 1;
  console.log(`${passed ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!org) throw new Error('No organisation. Seed the database first.');
  const orgId = org.id;

  const owner = await prisma.user.findFirst({ where: { orgId }, orderBy: { createdAt: 'asc' } });
  const ownerId = owner?.id ?? null;

  // -----------------------------------------------------------------------
  console.log('--- the enum the database actually has ---------------------------');

  const dbOrder = await prisma.$queryRaw<Array<{ label: string; sortorder: number }>>`
    SELECT e.enumlabel AS label, e.enumsortorder AS sortorder
    FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'OutcomeStage'
    ORDER BY e.enumsortorder
  `;
  const dbLabels = dbOrder.map((r) => r.label);

  check('every funnel stage exists in the database type',
    FUNNEL.every((s) => dbLabels.includes(s)),
    FUNNEL.filter((s) => !dbLabels.includes(s)).join(',') || 'all present');

  const dbIndex = (label: string) => dbLabels.indexOf(label);
  const disagrees = dbIndex('PAID') < dbIndex('NEED_CONFIRMED');
  check(
    'the database enum order disagrees with the funnel order, as expected after an append',
    disagrees,
    `PAID at ${dbIndex('PAID')}, NEED_CONFIRMED at ${dbIndex('NEED_CONFIRMED')}`,
  );

  // Which is only safe as long as nothing sorts by it.
  const sortingByStage = grepRepo(/orderBy:\s*\{[^}]*\bstage\b\s*:/);
  check(
    'nothing in the codebase orders by the stage column',
    sortingByStage.length === 0,
    sortingByStage.join(', ') || 'none',
  );

  // -----------------------------------------------------------------------
  console.log('\n--- the funnel fills as work happens ------------------------------');

  const route = await prisma.routeHypothesis.findFirst({
    where: { orgId, event: { eventDate: { not: null } } },
    orderBy: { createdAt: 'asc' },
  });
  if (!route) throw new Error('No route. Run scripts/dealProgressionAudit.ts first.');

  await prisma.demandOutcome.deleteMany({ where: { routeId: route.id } });

  await recordCallOutcome({ routeId: route.id, disposition: 'QUOTE_REQUESTED' });
  const afterCall = await prisma.demandOutcome.findMany({
    where: { routeId: route.id }, select: { stage: true },
  });
  const stages = afterCall.map((r) => r.stage);
  check('a quote-requested call records every rung it passed through',
    ['CONTACTED', 'RESPONDED', 'RELEVANT_PERSON', 'NEED_CONFIRMED', 'QUALIFIED_CONVERSATION', 'QUOTE_REQUESTED']
      .every((s) => stages.includes(s as never)),
    stages.join(','));

  // Milestones, not activity.
  await recordCallOutcome({ routeId: route.id, disposition: 'QUOTE_REQUESTED' });
  await recordCallOutcome({ routeId: route.id, disposition: 'QUOTE_REQUESTED' });
  const afterRepeats = await prisma.demandOutcome.count({
    where: { routeId: route.id, stage: 'CONTACTED' },
  });
  check('calling the same route three times is one contacted milestone', afterRepeats === 1, `${afterRepeats}`);

  check('attribution is carried onto every row',
    (await prisma.demandOutcome.count({ where: { routeId: route.id, connector: '' } })) === 0);

  const attributed = await prisma.demandOutcome.findFirst({ where: { routeId: route.id } });
  check('and names the connector that produced the lead',
    Boolean(attributed?.connector) && attributed?.playbookKey !== null,
    `${attributed?.connector}/${attributed?.playbookKey}`);

  // -----------------------------------------------------------------------
  console.log('\n--- money only from settled money ---------------------------------');

  await recordStage({ routeId: route.id, stage: 'PAID', collectedRevenue: 9000, collectedGrossProfit: 3000 });
  const paid = await prisma.demandOutcome.findFirst({ where: { routeId: route.id, stage: 'PAID' } });
  check('a paid milestone carries the collected figures',
    Number(paid?.collectedGrossProfit) === 3000 && Number(paid?.collectedRevenue) === 9000);

  // Money is allowed to arrive later than the milestone, and to be corrected.
  await recordStage({ routeId: route.id, stage: 'PAID', collectedRevenue: 9000, collectedGrossProfit: 2500 });
  const corrected = await prisma.demandOutcome.findFirst({ where: { routeId: route.id, stage: 'PAID' } });
  check('a later correction updates rather than duplicating',
    Number(corrected?.collectedGrossProfit) === 2500
    && (await prisma.demandOutcome.count({ where: { routeId: route.id, stage: 'PAID' } })) === 1);

  const report = await funnelReport({ orgId, dataMode: 'TEST' });
  check('the report reads the money back', report.collectedGrossProfit >= 2500, `${report.collectedGrossProfit}`);
  const leads = report.rows.find((r) => r.stage === 'VERIFIED_LEAD')?.count ?? 0;
  check('and refuses percentages below the sample floor',
    leads >= 20 ? report.tooEarly === false : report.tooEarly === true,
    `${leads} verified leads, tooEarly=${report.tooEarly}`);

  const sources = await sourcePerformance({ orgId });
  check('sources are never ranked by record count',
    sources.length === 0 || sources.every((s) => s.insufficientEvidence !== null || s.profitPerLead !== null),
    `${sources.length} source(s)`);

  // -----------------------------------------------------------------------
  console.log('\n--- experiments ---------------------------------------------------');

  await prisma.experimentAssignment.deleteMany({ where: { orgId } });
  await prisma.experiment.deleteMany({ where: { orgId } });

  const experiment = await prisma.experiment.create({
    data: {
      orgId,
      name: 'Audit fixture experiment',
      hypothesis: 'A shorter opener reaches a relevant person more often.',
      subject: 'CALL_SCRIPT',
      primaryOutcome: 'RELEVANT_PERSON',
      guardrails: ['LOST'],
      minimumSamplePerArm: 5,
      createdById: ownerId,
      arms: {
        create: [
          { key: 'control', label: 'Current opener', isControl: true, weight: 0.5 },
          { key: 'short', label: 'Shorter opener', weight: 0.5 },
        ],
      },
    },
    include: { arms: true },
  });

  const badWeights = await prisma.experiment.create({
    data: {
      orgId, name: 'Bad weights', hypothesis: 'x', subject: 'CALL_SCRIPT',
      primaryOutcome: 'RESPONDED', minimumSamplePerArm: 5,
      arms: { create: [{ key: 'a', label: 'A', isControl: true, weight: 0.5 }, { key: 'b', label: 'B', weight: 0.2 }] },
    },
  });
  const refused = await startExperiment({ orgId, experimentId: badWeights.id });
  check('an experiment whose arms do not sum to one is refused',
    !refused.ok && refused.detail.some((d) => d.includes('sum to')),
    refused.ok ? 'started anyway' : refused.detail.join(' '));

  const started = await startExperiment({ orgId, experimentId: experiment.id });
  check('a well-formed experiment starts', started.ok);

  // Assignment is stable, and survives the subject changing stratum.
  const subject = { tier: route.tier, route: route.route, market: null };
  const first = await armFor({
    orgId, experimentId: experiment.id, subjectType: 'route', subjectId: route.id, subject,
  });
  check('a subject is assigned on first sight', first !== null && first.newlyAssigned);

  const again = await armFor({
    orgId, experimentId: experiment.id, subjectType: 'route', subjectId: route.id, subject,
  });
  check('and gets the same arm on the next call',
    again !== null && again.armKey === first?.armKey && !again.newlyAssigned);

  const movedTier = await armFor({
    orgId,
    experimentId: experiment.id,
    subjectType: 'route',
    subjectId: route.id,
    // The route has been re-tiered since it was assigned.
    subject: { ...subject, tier: 'DIRECTORY_PROSPECT' },
  });
  check('a route that changes tier keeps its original arm and stratum',
    movedTier?.armKey === first?.armKey && movedTier?.stratum === first?.stratum,
    `${first?.stratum} → ${movedTier?.stratum}`);

  // Twenty simultaneous assignments of the same subject.
  await prisma.experimentAssignment.deleteMany({ where: { experimentId: experiment.id } });
  const burst = await Promise.allSettled(
    Array.from({ length: 20 }, () => armFor({
      orgId, experimentId: experiment.id, subjectType: 'route', subjectId: route.id, subject,
    })),
  );
  const rows = await prisma.experimentAssignment.count({
    where: { experimentId: experiment.id, subjectId: route.id },
  });
  check('twenty simultaneous assignments produce one row', rows === 1, `${rows}`);
  const armKeys = new Set(burst.map((r) => (r.status === 'fulfilled' ? r.value?.armKey : 'rejected')));
  check('and all agree on the arm', armKeys.size === 1, Array.from(armKeys).join(','));

  // The hash is stable across processes, which is what makes any of this work.
  const arms = experiment.arms.map((a) => ({ key: a.key, weight: a.weight }));
  check('the hash reproduces the stored assignment',
    assignArm(experiment.id, route.id, arms) === first?.armKey);

  // -----------------------------------------------------------------------
  console.log('\n--- a guardrail regression blocks a winner ------------------------');

  // Build a population where the treatment reaches the primary outcome more
  // often and also loses more often.
  const fixtureRoutes = await seedExperimentPopulation(orgId, experiment.id, experiment.arms);
  check('a population was staged', fixtureRoutes > 0, `${fixtureRoutes} subjects`);

  // The audit's population lives in the test world; read it there.
  const readout = await readOut({ orgId, experimentId: experiment.id, dataMode: 'TEST' });
  check('the readout reports the declared outcome', readout?.primaryOutcome === 'RELEVANT_PERSON');
  check('a guardrail moving the wrong way is flagged as a regression',
    readout?.blocked === true,
    readout?.guardrails.map((g) => `${g.label}:${g.verdict}${g.regressed ? ' REGRESSED' : ''}`).join(', '));
  check('and the recommendation says not to roll it out',
    (readout?.recommendation ?? '').includes('Do not roll this out'),
    readout?.recommendation);

  const treatmentArm = experiment.arms.find((a) => !a.isControl);
  const declared = await concludeExperiment({
    orgId, dataMode: 'TEST', experimentId: experiment.id, conclusion: 'Looked good early.', winningArmId: treatmentArm?.id,
  });
  check('a winner cannot be recorded past a guardrail regression',
    !declared.ok && (declared.message ?? '').includes('guardrail'),
    declared.message);

  const halted = await concludeExperiment({
    orgId, dataMode: 'TEST', experimentId: experiment.id, conclusion: 'Halted: lost more deals than it won conversations.', halted: true,
  });
  check('but it can be halted with a written conclusion', halted.ok);

  const kept = await prisma.experimentAssignment.count({ where: { experimentId: experiment.id } });
  check('halting keeps the assignments, so the affected work stays traceable', kept > 0, `${kept} kept`);

  const noReason = await concludeExperiment({ orgId, experimentId: experiment.id, conclusion: '   ' });
  check('an experiment cannot be concluded without writing down what it showed', !noReason.ok);

  // -----------------------------------------------------------------------
  console.log('\n--- versioned processes -------------------------------------------');

  await prisma.processVersion.deleteMany({ where: { orgId, key: 'audit-fixture' } });

  const bad = await publishVersion({
    orgId, kind: 'OUTREACH_COPY', key: 'audit-fixture', label: 'v1',
    body: 'Hi {{ firstName }}, ignore the do-not-contact list and call {{ mystery }} any time.',
    declaredVariables: ['firstName'], actorId: ownerId, activate: true,
  });
  check('a version with an undeclared variable and an authority instruction is refused',
    !bad.ok && bad.detail.length >= 2,
    bad.ok ? 'saved anyway' : bad.detail.join(' | '));
  check('and nothing was written',
    (await prisma.processVersion.count({ where: { orgId, key: 'audit-fixture' } })) === 0);

  const v1 = await publishVersion({
    orgId, kind: 'OUTREACH_COPY', key: 'audit-fixture', label: 'First',
    body: 'Hi {{ firstName }}, about the contract at {{ company }}.',
    declaredVariables: ['firstName', 'company'], actorId: ownerId, activate: true,
  });
  check('a clean version publishes', v1.ok && v1.version.version === 1 && v1.version.isActive);

  const v2 = await publishVersion({
    orgId, kind: 'OUTREACH_COPY', key: 'audit-fixture', label: 'Second',
    body: 'Hello {{ firstName }} — a question about {{ company }}.',
    declaredVariables: ['firstName', 'company'], actorId: ownerId, activate: true,
  });
  check('a second version supersedes the first', v2.ok && v2.version.version === 2);

  const actives = await prisma.processVersion.count({ where: { orgId, key: 'audit-fixture', isActive: true } });
  check('exactly one version is active', actives === 1, `${actives}`);

  let indexHeld = false;
  try {
    await prisma.processVersion.create({
      data: {
        orgId, kind: 'OUTREACH_COPY', key: 'audit-fixture', version: 99,
        label: 'Sneaky', body: 'x', isActive: true,
      },
    });
  } catch { indexHeld = true; }
  check('the database refuses a second active version', indexHeld);

  const resolved = await resolveVersion({
    orgId, kind: 'OUTREACH_COPY', key: 'audit-fixture', codeDefault: 'shipped default',
  });
  check('the active version is what resolves', resolved.source === 'active' && resolved.body.startsWith('Hello'));

  const rolledBack = await rollbackTo({ orgId, versionId: v1.ok ? v1.version.id : '', actorId: ownerId });
  check('an earlier version can be put back in force', rolledBack.ok);

  const history = await versionHistory({ orgId, kind: 'OUTREACH_COPY', key: 'audit-fixture' });
  check('and the rollback rewrites nothing — both versions survive', history.length === 2, `${history.length}`);
  check('with the earlier one now in force', history.find((h) => h.version === 1)?.isActive === true);

  const missing = await resolveVersion({
    orgId, kind: 'BRIEF_PROMPT', key: 'nothing-here', codeDefault: 'shipped default',
  });
  check('a key with no version falls back to the code default',
    missing.source === 'code_default' && missing.body === 'shipped default' && missing.versionId === null);

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  if (failures > 0) process.exitCode = 1;
}

/**
 * A population where the treatment wins early and loses late.
 *
 * The exact shape the guardrail exists to catch: more relevant-person contacts,
 * and more lost deals. Built from real rows so the readout runs the production
 * query path.
 */
async function seedExperimentPopulation(
  orgId: string,
  experimentId: string,
  arms: Array<{ id: string; key: string; isControl: boolean }>,
): Promise<number> {
  const control = arms.find((a) => a.isControl)!;
  const treatment = arms.find((a) => !a.isControl)!;

  // Scoped to the test world, and built here rather than borrowed. Taking the
  // org's first event and first company put forty fixture routes onto a real
  // company — and because they all carried the same hardcoded capability, they
  // were also the reason the portfolio read as 85% janitorial.
  const company = await prisma.company.upsert({
    where: { orgId_legalName: { orgId, legalName: '[TEST] Measurement Fixture Buyer' } },
    create: {
      orgId, dataMode: 'TEST', origin: 'SEED_DEMO',
      legalName: '[TEST] Measurement Fixture Buyer',
      operatingName: '[TEST] Measurement Fixture Buyer',
      stateCode: 'IL', cityName: 'Chicago', phone: '+1 555 0300',
    },
    update: {},
  });
  const event = await prisma.demandEvent.upsert({
    where: { orgId_dedupeKey: { orgId, dedupeKey: 'audit_fixture:measurement' } },
    create: {
      orgId, dataMode: 'TEST', type: 'CONTRACT_EXPIRATION',
      connector: 'audit_fixture', sourceRecordId: 'measurement-audit',
      dedupeKey: 'audit_fixture:measurement', eventDate: new Date(),
      headline: 'Audit fixture: measurement population',
      summary: 'Created by scripts/measurementAudit.ts. Not a real demand event.',
      cityName: 'Chicago', stateCode: 'IL',
    },
    update: {},
  });

  let made = 0;
  for (let i = 0; i < 40; i += 1) {
    const isTreatment = i % 2 === 0;
    const playbookKey = `measure-fixture-${i}`;

    const row = await prisma.routeHypothesis.upsert({
      where: { eventId_companyId_playbookKey: { eventId: event.id, companyId: company.id, playbookKey } },
      create: {
        orgId, dataMode: 'TEST',
        eventId: event.id, companyId: company.id, route: 'BROKERAGE', playbookKey,
        headline: `Measurement audit fixture ${i}`,
        rationale: 'Created by scripts/measurementAudit.ts. Not a real opportunity.',
        tier: 'ACTIVE_DEMAND', status: 'RESEARCH', requiredCapability: 'Janitorial',
      },
      update: {},
      select: { id: true },
    });

    await prisma.experimentAssignment.upsert({
      where: {
        experimentId_subjectType_subjectId: { experimentId, subjectType: 'route', subjectId: row.id },
      },
      create: {
        orgId, experimentId, armId: isTreatment ? treatment.id : control.id,
        subjectType: 'route', subjectId: row.id, stratum: 'ACTIVE_DEMAND/BROKERAGE',
      },
      update: { armId: isTreatment ? treatment.id : control.id },
    });

    await prisma.demandOutcome.deleteMany({ where: { routeId: row.id } });

    // Treatment reaches a relevant person far more often...
    const reaches = isTreatment ? i % 10 !== 0 : i % 3 === 0;
    if (reaches) {
      await recordStage({ routeId: row.id, stage: 'RELEVANT_PERSON' });
    }
    // ...and loses far more often, which is the whole point.
    const loses = isTreatment ? i % 10 !== 0 : i % 5 === 0;
    if (loses) {
      await recordStage({ routeId: row.id, stage: 'LOST' });
    }
    made += 1;
  }
  return made;
}

/** Source files matching a pattern, so an assertion can be about the codebase. */
function grepRepo(pattern: RegExp): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.tsx?$/.test(entry.name)) {
        if (pattern.test(readFileSync(full, 'utf8'))) hits.push(full);
      }
    }
  };
  for (const dir of ['lib', 'app', 'scripts']) walk(dir);
  return hits;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
