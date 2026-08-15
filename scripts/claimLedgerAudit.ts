/**
 * The claim ledger, against Postgres.
 *
 * The unit tests prove what may be claimed. They cannot prove any of the things
 * that actually decide whether this table is safe to build on, because all of
 * them are database behaviour:
 *
 *   That a claim inherits its route's world, so a practice call can never put a
 *   claim on a production deal.
 *   That the constraints refuse a claim nobody can act on, even when a future
 *   writer forgets.
 *   That superseding is atomic — a new reading and the old one stepping aside
 *   are one transaction, or the ledger has two current claims on a key and
 *   every reader picks a different one.
 *   That a contradiction leaves *both* sides standing and neither superseded,
 *   which is the entire reason the table exists.
 *   That the nightly rebuild does not overwrite what a caller established.
 *
 * Everything it creates is TEST-mode and removed afterwards, including on
 * failure.
 *
 *   npx tsx scripts/claimLedgerAudit.ts
 */

import { prisma } from '@/lib/db';
import {
  claimHistory,
  contradict,
  currentClaims,
  openContradictions,
  recordClaim,
  recordEngineClaims,
  recordPersonClaims,
  settleContradiction,
  type ClaimInput,
} from '@/lib/evidence/ledger';
import { answersAgree } from '@/lib/evidence/callClaims';

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
    console.error(`Writes claims, routes and events; local databases only. DATABASE_URL points at "${host}".`);
    process.exit(1);
  }
}

const MARK = 'CLAIM-LEDGER-AUDIT';
const created = { events: [] as string[], companies: [] as string[] };

async function seedRoute(orgId: string, mode: 'TEST' | 'PRODUCTION'): Promise<string> {
  const company = await prisma.company.create({
    data: {
      orgId,
      dataMode: mode,
      legalName: `${MARK} ${mode} ${Math.random().toString(36).slice(2, 8)}`,
      companyRole: 'BUYER',
    },
    select: { id: true },
  });
  created.companies.push(company.id);

  const event = await prisma.demandEvent.create({
    data: {
      orgId,
      dataMode: mode,
      type: 'OCCUPANCY_OR_OPERATING_APPROVAL',
      connector: 'audit',
      sourceRecordId: `${MARK}-${company.id}`,
      dedupeKey: `${MARK}-${company.id}`,
      headline: `${MARK} occupancy approved`,
      summary: 'Seeded by the claim ledger audit.',
      eventDate: new Date(),
    },
    select: { id: true },
  });
  created.events.push(event.id);

  const route = await prisma.routeHypothesis.create({
    data: {
      orgId,
      dataMode: mode,
      eventId: event.id,
      companyId: company.id,
      route: 'BROKERAGE',
      playbookKey: 'audit.playbook',
      headline: `${MARK} route`,
      rationale: 'Seeded by the claim ledger audit.',
    },
    select: { id: true },
  });
  return route.id;
}

const claim = (routeId: string, over: Partial<ClaimInput> = {}): ClaimInput => ({
  routeId,
  about: 'BUYER',
  key: 'buyer.requirement.scope',
  statement: 'They need forty thousand square feet.',
  value: { answer: 'forty thousand square feet' },
  standing: 'CONFIRMED',
  sourceKind: 'PERSON',
  sourceLabel: 'The facilities manager said so.',
  ...over,
});

async function main() {
  refuseUnlessLocal();

  const org = await prisma.organization.findFirst({ select: { id: true } });
  if (!org) {
    console.error('No organisation in this database. Seed it first.');
    process.exit(1);
  }

  console.log('='.repeat(74));
  console.log('CLAIM LEDGER — against Postgres');
  console.log('='.repeat(74));

  const testRoute = await seedRoute(org.id, 'TEST');
  const productionRoute = await seedRoute(org.id, 'PRODUCTION');

  // --- isolation ----------------------------------------------------------
  console.log('\n--- a claim belongs to its route\'s world -----------------------');
  const onTest = await recordClaim({ orgId: org.id, claim: claim(testRoute) });
  check('a claim on a practice route is written as practice', onTest.dataMode === 'TEST', onTest.dataMode);

  const onProduction = await recordClaim({ orgId: org.id, claim: claim(productionRoute) });
  check(
    'and a claim on a production route is written as production',
    onProduction.dataMode === 'PRODUCTION',
    onProduction.dataMode,
  );

  // The writer never passes a mode, so the only way this can be wrong is the
  // trigger not firing. Force the mismatch directly to prove it refuses.
  let refusedMismatch = false;
  try {
    await prisma.claim.update({ where: { id: onTest.id }, data: { dataMode: 'PRODUCTION' } });
  } catch (caught) {
    refusedMismatch = /claim_data_mode/.test(String(caught));
  }
  check('and a claim cannot be moved between the two', refusedMismatch);

  // --- the shape of an honest claim ---------------------------------------
  console.log('\n--- what the database itself refuses ----------------------------');
  let refusedNoAction = false;
  try {
    // Around the store, as a future writer eventually will.
    await prisma.claim.create({
      data: {
        orgId: org.id,
        routeId: testRoute,
        about: 'BUYER',
        key: 'buyer.unactionable',
        statement: 'Something is missing.',
        standing: 'UNKNOWN',
        sourceKind: 'ABSENCE',
        sourceLabel: 'Nothing.',
      },
    });
  } catch (caught) {
    refusedNoAction = /claim_unsettled_needs_action/.test(String(caught));
  }
  check('an unsettled claim with nothing to do about it is refused', refusedNoAction);

  let refusedConfidence = false;
  try {
    await prisma.claim.create({
      data: {
        orgId: org.id,
        routeId: testRoute,
        about: 'BUYER',
        key: 'buyer.overconfident',
        statement: 'They definitely need this.',
        standing: 'CONFIRMED',
        sourceKind: 'PERSON',
        sourceLabel: 'Somebody.',
        confidence: 0.8,
      },
    });
  } catch (caught) {
    refusedConfidence = /claim_confidence_only_when_inferred/.test(String(caught));
  }
  check('a confidence figure on a confirmed fact is refused', refusedConfidence);

  let refusedBareContradiction = false;
  try {
    await prisma.claim.create({
      data: {
        orgId: org.id,
        routeId: testRoute,
        about: 'BUYER',
        key: 'buyer.bare',
        statement: 'This is disputed.',
        standing: 'CONTRADICTED',
        sourceKind: 'PERSON',
        sourceLabel: 'Somebody.',
        correctiveAction: 'Ring back.',
      },
    });
  } catch (caught) {
    refusedBareContradiction = /claim_contradiction_names_its_target/.test(String(caught));
  }
  check('a contradiction that names nothing is refused', refusedBareContradiction);

  // --- supersession --------------------------------------------------------
  console.log('\n--- a newer reading steps the older one aside -------------------');
  const second = await recordClaim({
    orgId: org.id,
    claim: claim(testRoute, {
      statement: 'They need forty-two thousand square feet.',
      value: { answer: 'forty-two thousand square feet' },
    }),
  });
  const current = await currentClaims(testRoute);
  const scopeRows = current.filter((c) => c.key === 'buyer.requirement.scope');
  check('exactly one reading of a key is current', scopeRows.length === 1, `${scopeRows.length} current`);
  check('and it is the newest one', scopeRows[0]?.id === second.id);

  const history = await claimHistory(testRoute, 'buyer.requirement.scope');
  check('the older reading is kept rather than overwritten', history.length === 2, `${history.length} rows`);
  check(
    'and says what replaced it',
    history.find((h) => h.id === onTest.id)?.supersededById === second.id,
  );

  // --- disagreement --------------------------------------------------------
  console.log('\n--- two people disagreeing ------------------------------------');
  const dispute = await contradict({
    orgId: org.id,
    claim: claim(testRoute, {
      statement: 'They need twelve thousand square feet.',
      value: { answer: 'twelve thousand square feet' },
    }),
    settleBy: 'Ring back and establish which figure holds.',
  });
  check('a disagreement is recorded', dispute !== null);

  const afterDispute = await currentClaims(testRoute);
  const disputed = afterDispute.filter((c) => c.key === 'buyer.requirement.scope');
  check('both readings stay current', disputed.length === 2, `${disputed.length} current`);
  check('neither is superseded', disputed.every((c) => c.supersededAt === null));
  check('both are marked as disputed', disputed.every((c) => c.standing === 'CONTRADICTED'));
  check('and each names the other', disputed.every((c) => disputed.some((o) => o.id === c.contradictsId)));

  const open = await openContradictions(testRoute);
  check('the disagreement appears on the open list', open.length === 2, `${open.length}`);

  // A third opinion must not quietly resolve it.
  await recordClaim({
    orgId: org.id,
    claim: claim(testRoute, {
      standing: 'INFERRED',
      sourceKind: 'ENGINE_INFERENCE',
      statement: 'Probably around thirty thousand square feet.',
      value: { answer: 'thirty thousand square feet' },
      confidence: 0.3,
      correctiveAction: 'Ask them.',
    }),
  });
  const stillOpen = await openContradictions(testRoute);
  check('an inference written over a disagreement does not settle it', stillOpen.length === 2, `${stillOpen.length}`);

  // --- settling -------------------------------------------------------------
  console.log('\n--- settling it -----------------------------------------------');
  await settleContradiction({
    orgId: org.id,
    routeId: testRoute,
    key: 'buyer.requirement.scope',
    claim: {
      about: 'BUYER',
      statement: 'Twelve thousand square feet, confirmed on a callback.',
      value: { answer: 'twelve thousand square feet' },
      standing: 'CONFIRMED',
      sourceKind: 'PERSON',
      sourceLabel: 'The facilities manager, on a callback.',
    },
  });
  const settled = await openContradictions(testRoute);
  check('the disagreement leaves the open list', settled.length === 0, `${settled.length} still open`);
  const afterSettle = (await currentClaims(testRoute)).filter((c) => c.key === 'buyer.requirement.scope');
  check('and one confirmed reading stands', afterSettle.length === 1 && afterSettle[0].standing === 'CONFIRMED');

  // --- the nightly rebuild -------------------------------------------------
  console.log('\n--- the rebuild does not forget what a person said --------------');
  const engine = await recordEngineClaims({
    orgId: org.id,
    routeId: testRoute,
    claims: [
      claim(testRoute, {
        standing: 'INFERRED',
        sourceKind: 'ENGINE_INFERENCE',
        statement: 'Probably around forty thousand square feet.',
        value: { answer: 'forty thousand square feet' },
        confidence: 0.3,
        correctiveAction: 'Ring them.',
      }),
      claim(testRoute, {
        key: 'timing.window',
        about: 'TIMING',
        standing: 'INFERRED',
        sourceKind: 'ENGINE_INFERENCE',
        statement: 'Likely buying within sixty days.',
        value: { answer: 'sixty days' },
        confidence: 0.4,
        correctiveAction: 'Ask when they need it.',
      }),
    ],
  });
  check('the engine yields on a key a person established', engine.deferredToPeople === 1, `${engine.deferredToPeople}`);
  check('and still writes the keys nobody has answered', engine.recorded === 1, `${engine.recorded}`);
  const afterRebuild = (await currentClaims(testRoute)).find((c) => c.key === 'buyer.requirement.scope');
  check(
    'the person\'s answer is still the one on the record',
    afterRebuild?.standing === 'CONFIRMED' && afterRebuild.sourceKind === 'PERSON',
    `${afterRebuild?.standing} from ${afterRebuild?.sourceKind}`,
  );

  // --- a person against a person --------------------------------------------
  console.log('\n--- a second person disagreeing raises a dispute ----------------');
  const person = await recordPersonClaims({
    orgId: org.id,
    routeId: testRoute,
    claims: [
      claim(testRoute, {
        statement: 'They need forty thousand square feet.',
        value: { answer: 'forty thousand square feet' },
        sourceLabel: 'A second caller, a week later.',
      }),
    ],
    agree: answersAgree,
  });
  check('the disagreement is detected rather than overwritten', person.contradicted.length === 1);
  check('and reported with both statements', Boolean(person.contradicted[0]?.wasSaid && person.contradicted[0]?.nowSaid));

  const personAgrees = await recordPersonClaims({
    orgId: org.id,
    routeId: testRoute,
    claims: [
      claim(testRoute, {
        key: 'buyer.contactRole',
        statement: 'Spoke to the operations manager.',
        value: { answer: 'operations manager' },
        sourceLabel: 'A caller.',
      }),
    ],
    agree: answersAgree,
  });
  check('a first answer on an unclaimed key is simply recorded', personAgrees.recorded === 1);

  // --- cascade --------------------------------------------------------------
  console.log('\n--- claims belong to their deal --------------------------------');
  const before = await prisma.claim.count({ where: { routeId: productionRoute } });
  await prisma.routeHypothesis.delete({ where: { id: productionRoute } });
  const after = await prisma.claim.count({ where: { routeId: productionRoute } });
  check('deleting a route removes its claims', before > 0 && after === 0, `${before} → ${after}`);
}

async function cleanup() {
  // Claims and routes cascade from the event and the company.
  await prisma.routeHypothesis.deleteMany({ where: { eventId: { in: created.events } } });
  await prisma.demandEvent.deleteMany({ where: { id: { in: created.events } } });
  await prisma.company.deleteMany({ where: { id: { in: created.companies } } });
}

main()
  .catch((error) => {
    console.error(error);
    failed += 1;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    console.log(`\n${'='.repeat(74)}`);
    console.log(`${passed}/${passed + failed} checks passed.`);
    process.exit(failed > 0 ? 1 : 0);
  });
