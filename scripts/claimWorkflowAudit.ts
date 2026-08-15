/**
 * The claim ledger through the real workflow, not through its own store.
 *
 * The store audit proves the table behaves. This proves the product uses it,
 * which is the failure this project keeps repeating: correct logic that nothing
 * invokes. So every step here goes through the function the running system
 * calls — `runDemandPipeline` for discovery, `saveCallerCall` for a call,
 * `loadDemandContext` and `buildDealPlan` for what the operator is told to do.
 *
 * The chain being proved:
 *
 *   Discovery builds a route and writes down what it is claiming, with only the
 *   published event marked confirmed and every inference carrying a next step.
 *
 *   A caller's answers supersede those inferences, because a person who works
 *   there outranks a playbook reading a permit.
 *
 *   A second caller's different answer does not overwrite the first. Both stay,
 *   both are flagged, and the deal plan reports the disagreement as the thing
 *   blocking the deal — which is the whole reason the ledger exists.
 *
 *   Running discovery again does not forget any of it.
 *
 * Everything it creates is TEST-mode and removed afterwards, including on
 * failure.
 *
 *   npx tsx scripts/claimWorkflowAudit.ts
 */

import { prisma } from '@/lib/db';
import { hashSecret } from '@/lib/auth/password';
import { runDemandPipeline } from '@/lib/demand/pipeline';
import { buildPacket } from '@/lib/caller/packets';
import { saveCallerCall } from '@/lib/caller/save';
import { buildDealPlan, loadDemandContext } from '@/lib/deal/plan';
import { loadDealRecord } from '@/lib/deal/record';
import { currentClaims, openContradictions } from '@/lib/evidence/ledger';

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
    console.error(`Runs the pipeline and saves calls; local databases only. DATABASE_URL points at "${host}".`);
    process.exit(1);
  }
}

const MARK = 'CLAIM-WORKFLOW-AUDIT';
const created = { events: [] as string[], companies: [] as string[], users: [] as string[] };

async function main() {
  refuseUnlessLocal();

  const org = await prisma.organization.findFirstOrThrow({ select: { id: true } });
  const owner = await prisma.user.findFirstOrThrow({ where: { orgId: org.id, role: { key: 'OWNER' } } });

  console.log('='.repeat(74));
  console.log('CLAIM LEDGER — through the workflow that runs in production');
  console.log('='.repeat(74));

  // --- a real event, through the real pipeline ----------------------------
  //
  // Ambiguous on purpose is not the point here — this needs one route to exist,
  // so the event is one the overflow playbook reads cleanly.
  const buyer = await prisma.company.create({
    data: {
      orgId: org.id,
      dataMode: 'TEST',
      legalName: `${MARK} Northside Distribution`,
      companyRole: 'BUYER',
      phone: '+13125550100',
      cityName: 'Chicago',
      stateCode: 'IL',
    },
    select: { id: true, legalName: true },
  });
  created.companies.push(buyer.id);

  const event = await prisma.demandEvent.create({
    data: {
      orgId: org.id,
      dataMode: 'TEST',
      type: 'OCCUPANCY_OR_OPERATING_APPROVAL',
      lifecycle: 'DISCOVERED',
      verification: 'AUTO_VERIFIED',
      connector: 'municipal_open_data',
      sourceRecordId: `${MARK}-1`,
      dedupeKey: `${MARK}-1`,
      sourceUrl: 'https://data.cityofchicago.org/resource/audit-fixture',
      headline: `${MARK} — warehouse occupancy approved, 40,000 sq ft`,
      summary: 'Certificate of occupancy issued for a distribution warehouse.',
      // Ahead of today: an approval already a week old closes the pre-opening
      // window, the route expires, and an expired route cannot be assigned —
      // which is correct behaviour and useless for this audit.
      eventDate: new Date(Date.now() + 14 * 86_400_000),
      cityName: 'Chicago',
      stateCode: 'IL',
      confirmedFacts: ['Warehouse occupancy approved', 'Distribution centre, 40,000 square feet'],
      parties: {
        create: [{ companyId: buyer.id, role: 'BUYER', sourceName: buyer.legalName, resolutionConfidence: 1 }],
      },
    },
    select: { id: true },
  });
  created.events.push(event.id);

  console.log('\n--- discovery writes down what it is claiming -------------------');
  const firstRun = await runDemandPipeline({ orgId: org.id, userId: owner.id });
  check('the pipeline recorded claims', firstRun.routes.claimsRecorded > 0, `${firstRun.routes.claimsRecorded}`);

  const route = await prisma.routeHypothesis.findFirst({
    where: { orgId: org.id, eventId: event.id },
    orderBy: { createdAt: 'desc' },
    select: { id: true, playbookKey: true },
  });
  if (!route) {
    check('a route was built from the seeded event', false, 'no route — nothing further can be checked');
    return;
  }
  check('a route was built from the seeded event', true, route.playbookKey);

  const discovered = await currentClaims(route.id);
  check('the route carries a ledger', discovered.length > 0, `${discovered.length} claim(s)`);

  const confirmed = discovered.filter((c) => c.standing === 'CONFIRMED');
  check(
    'only the published event is claimed as confirmed',
    confirmed.length > 0 && confirmed.every((c) => c.key === 'demand.event' || c.key === 'buyer.need'),
    confirmed.map((c) => c.key).join(', '),
  );

  const money = discovered.filter((c) => c.key.startsWith('economics.'));
  check(
    'no money figure is claimed as a fact',
    money.length > 0 && money.every((c) => c.standing !== 'CONFIRMED'),
    money.map((c) => `${c.key}=${c.standing}`).join(', '),
  );
  check(
    'every unsettled claim says what would settle it',
    discovered.filter((c) => c.standing !== 'CONFIRMED').every((c) => (c.correctiveAction?.length ?? 0) > 10),
  );
  check(
    'and every claim says where it came from',
    discovered.every((c) => c.sourceLabel.length > 10),
  );

  // --- a caller's answers outrank the engine's inference -------------------
  console.log('\n--- a person who works there outranks the playbook --------------');
  const callerRole = await prisma.role.findFirstOrThrow({ where: { orgId: org.id, key: 'CALLER' } });
  const makeCaller = async (email: string, name: string) => {
    const user = await prisma.user.upsert({
      where: { orgId_email: { orgId: org.id, email } },
      create: {
        orgId: org.id,
        email,
        name,
        passwordHash: await hashSecret('not-used-for-pin-login', 10),
        roleId: callerRole.id,
      },
      update: { isActive: true, name, roleId: callerRole.id },
      select: { id: true, name: true },
    });
    created.users.push(user.id);
    await prisma.callerProfile.upsert({
      where: { userId: user.id },
      create: { userId: user.id, dataMode: 'TEST' },
      update: { dataMode: 'TEST' },
    });
    return user;
  };

  const first = await makeCaller(`${MARK.toLowerCase()}.first@dealdispatch.test`, 'Dana Whitlock');
  const second = await makeCaller(`${MARK.toLowerCase()}.second@dealdispatch.test`, 'Rowan Estes');

  const planOne = await buildPacket({
    orgId: org.id,
    callerId: first.id,
    name: `${MARK} packet one`,
    routeIds: [route.id],
    assignedByUserId: owner.id,
    discoveryObjective: 'Confirm the need and the scope.',
    scriptVersion: 'v1',
    processVersion: 'p1',
    offerVersion: 'o1',
    experimentCohort: 'audit',
  });

  check('the route was assigned to the first caller', planOne.items === 1, JSON.stringify(planOne));

  const firstCall = await saveCallerCall({
    orgId: org.id,
    callerId: first.id,
    input: {
      routeId: route.id,
      disposition: 'NEED_CONFIRMED',
      discovery: {
        confirmedNeed: 'Two thousand pallet positions of overflow from October',
        timing: 'October',
        buyerRole: 'Operations manager',
        scope: 'Overflow pallet storage, forty thousand square feet',
        locations: 'One site, Chicago',
      },
    },
  });
  check('the first call saved', firstCall.ok, firstCall.ok ? '' : firstCall.message);
  check('and raised no disagreement', firstCall.ok && !firstCall.contradictions);

  const afterCall = await currentClaims(route.id);
  const need = afterCall.find((c) => c.key === 'buyer.need');
  check(
    'the caller\'s answer replaced the playbook\'s inference',
    need?.standing === 'CONFIRMED' && need.sourceKind === 'PERSON',
    `${need?.standing} from ${need?.sourceKind}`,
  );
  check('and names who said it, on what date', Boolean(need?.sourceLabel.includes('Dana Whitlock')), need?.sourceLabel);
  check('and can be reopened', Boolean(need?.sourceRef?.startsWith('attempt:')), need?.sourceRef ?? 'no reference');

  const superseded = await prisma.claim.findMany({
    where: { routeId: route.id, key: 'buyer.need', supersededAt: { not: null } },
  });
  check('the inference is kept rather than deleted', superseded.length === 1, `${superseded.length}`);

  // --- a second person disagreeing ----------------------------------------
  console.log('\n--- a second person disagreeing is not an overwrite -------------');
  await buildPacket({
    orgId: org.id,
    callerId: second.id,
    name: `${MARK} packet two`,
    routeIds: [route.id],
    assignedByUserId: owner.id,
    discoveryObjective: 'Confirm the scope.',
    scriptVersion: 'v1',
    processVersion: 'p1',
    offerVersion: 'o1',
    experimentCohort: 'audit',
  });

  const secondCall = await saveCallerCall({
    orgId: org.id,
    callerId: second.id,
    input: {
      routeId: route.id,
      disposition: 'NEED_CONFIRMED',
      discovery: {
        confirmedNeed: 'Two thousand pallet positions of overflow from October',
        timing: 'October',
        buyerRole: 'Operations manager',
        // The disagreement. A different person, a materially different figure.
        scope: 'Twelve thousand square feet, nothing like forty',
        locations: 'One site, Chicago',
      },
    },
  });
  check('the second call saved', secondCall.ok, secondCall.ok ? '' : secondCall.message);
  check(
    'the disagreement is reported back to the caller who caused it',
    Boolean(secondCall.ok && secondCall.contradictions?.length),
    secondCall.ok ? JSON.stringify(secondCall.contradictions ?? []).slice(0, 140) : '',
  );

  const disputes = await openContradictions(route.id);
  check('both readings stay on the record', disputes.length === 2, `${disputes.length}`);
  check(
    'and the earlier answer was not quietly replaced',
    disputes.some((c) => c.statement.includes('forty')) && disputes.some((c) => c.statement.includes('Twelve')),
    disputes.map((c) => c.statement).join(' | '),
  );

  // --- and it blocks the deal ---------------------------------------------
  console.log('\n--- and the operator is told to settle it ----------------------');
  const context = await loadDemandContext({ orgId: org.id, routeId: route.id });
  check('the deal chain sees the disagreement', (context?.disputedClaims.length ?? 0) > 0);

  const record = await loadDealRecord({ orgId: org.id, routeId: route.id });
  const plan = buildDealPlan({ record, demand: context! });
  const undisputed = plan.stages.find((s) => s.key === 'UNDISPUTED');
  check('there is a rung for having nothing in dispute', Boolean(undisputed));
  check('it is blocked', undisputed?.state === 'BLOCKED', undisputed?.state);
  check(
    'and it is what the operator is told to do next',
    plan.firstBroken?.key === 'UNDISPUTED',
    `${plan.firstBroken?.key}: ${plan.firstBroken?.nextAction ?? ''}`,
  );
  check(
    'with an action, not a warning',
    (undisputed?.nextAction?.length ?? 0) > 20,
    undisputed?.nextAction ?? 'none',
  );

  // --- the nightly rebuild -------------------------------------------------
  console.log('\n--- running discovery again forgets nothing ---------------------');
  await runDemandPipeline({ orgId: org.id, userId: owner.id });

  const afterRebuild = await openContradictions(route.id);
  check('the disagreement survives a rebuild', afterRebuild.length === 2, `${afterRebuild.length}`);

  const timing = (await currentClaims(route.id)).find((c) => c.key === 'timing.window');
  check(
    'and the caller\'s answers are still theirs',
    timing?.sourceKind === 'PERSON',
    `${timing?.standing} from ${timing?.sourceKind}`,
  );
}

async function cleanup() {
  const routes = await prisma.routeHypothesis.findMany({
    where: { eventId: { in: created.events } },
    select: { id: true },
  });
  const routeIds = routes.map((r) => r.id);
  await prisma.packetItem.deleteMany({ where: { routeId: { in: routeIds } } });
  await prisma.workPacket.deleteMany({ where: { callerId: { in: created.users } } });
  await prisma.outreachAttempt.deleteMany({ where: { routeId: { in: routeIds } } });
  await prisma.outreachState.deleteMany({ where: { routeId: { in: routeIds } } });
  await prisma.routeHypothesis.deleteMany({ where: { id: { in: routeIds } } });
  await prisma.demandEvent.deleteMany({ where: { id: { in: created.events } } });
  await prisma.company.deleteMany({ where: { id: { in: created.companies } } });
  await prisma.callerProfile.deleteMany({ where: { userId: { in: created.users } } });
  await prisma.user.deleteMany({ where: { id: { in: created.users } } });
}

main()
  .catch((error) => {
    console.error(error);
    failed += 1;
  })
  .finally(async () => {
    await cleanup().catch((e) => console.error('cleanup:', e));
    await prisma.$disconnect();
    console.log(`\n${'='.repeat(74)}`);
    console.log(`${passed}/${passed + failed} checks passed.`);
    process.exit(failed > 0 ? 1 : 0);
  });
