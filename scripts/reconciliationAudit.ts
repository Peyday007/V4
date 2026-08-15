/**
 * Reconciling the pre-competition board, against Postgres.
 *
 * The thing being proved is a refusal. A tidy-up that closes a route somebody
 * rang destroys the only record of that conversation, and the operator finds
 * out when they call back and have nothing. So the safety rule is checked twice
 * — once in the preview and again at the moment of closing, because the preview
 * an owner read may be an hour old and a call may have happened since.
 *
 * Also proved: that the preview writes nothing, that only ids the owner named
 * are touched, and that a route which is the sole reading of its event is never
 * proposed for closure however it scores.
 *
 * Everything it creates is TEST-mode and removed afterwards, including on
 * failure.
 *
 *   npx tsx scripts/reconciliationAudit.ts
 */

import { prisma } from '@/lib/db';
import { applyReconciliation, reconciliationPreview } from '@/lib/demand/reconcile';

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
    console.error(`Closes opportunities; local databases only. DATABASE_URL points at "${host}".`);
    process.exit(1);
  }
}

const MARK = 'RECONCILE-AUDIT';
const created = { events: [] as string[], companies: [] as string[] };

async function main() {
  refuseUnlessLocal();

  const org = await prisma.organization.findFirstOrThrow({ select: { id: true } });
  const owner = await prisma.user.findFirstOrThrow({ where: { orgId: org.id, role: { key: 'OWNER' } } });

  console.log('='.repeat(74));
  console.log('RECONCILIATION — what would change, and what must not');
  console.log('='.repeat(74));

  // One event, four readings — the refraction shape this exists for.
  const company = await prisma.company.create({
    data: {
      orgId: org.id, dataMode: 'TEST', legalName: `${MARK} Wicker Park Cafe`,
      companyRole: 'BUYER', phone: '+13125550188', cityName: 'Chicago', stateCode: 'IL',
    },
    select: { id: true },
  });
  created.companies.push(company.id);

  const event = await prisma.demandEvent.create({
    data: {
      orgId: org.id, dataMode: 'TEST', type: 'OCCUPANCY_OR_OPERATING_APPROVAL',
      connector: 'audit', sourceRecordId: `${MARK}-1`, dedupeKey: `${MARK}-1`,
      sourceUrl: 'https://data.cityofchicago.org/resource/audit',
      headline: `${MARK} retail food establishment licence issued`,
      summary: 'Retail food establishment licence issued for a cafe.',
      eventDate: new Date(Date.now() + 14 * 86_400_000),
      confirmedFacts: ['Retail food establishment licence issued', 'Cafe, 1,400 square feet'],
    },
    select: { id: true },
  });
  created.events.push(event.id);

  const makeRoute = async (playbookKey: string) => {
    const route = await prisma.routeHypothesis.create({
      data: {
        orgId: org.id, dataMode: 'TEST', eventId: event.id, companyId: company.id,
        route: 'BROKERAGE', playbookKey,
        headline: `${MARK} ${playbookKey}`,
        rationale: 'Seeded by the reconciliation audit as a pre-competition route.',
        tier: 'STRONG_TRIGGER', status: 'RESEARCH',
      },
      select: { id: true },
    });
    return route.id;
  };

  // Four readings of one licence: the shape the old rule produced.
  const cleanRoute = await makeRoute('cleaning.brokerage.pre_opening');
  const restaurantRoute = await makeRoute('restaurant.distribution.opening_supply');
  const wasteRoute = await makeRoute('facility.brokerage.waste_collection');
  const groundsRoute = await makeRoute('facility.brokerage.grounds');

  // A second event with one reading, which must never be proposed for closure.
  const soloEvent = await prisma.demandEvent.create({
    data: {
      orgId: org.id, dataMode: 'TEST', type: 'OCCUPANCY_OR_OPERATING_APPROVAL',
      connector: 'audit', sourceRecordId: `${MARK}-2`, dedupeKey: `${MARK}-2`,
      headline: `${MARK} single reading`, summary: 'One route only.',
      eventDate: new Date(Date.now() + 14 * 86_400_000),
    },
    select: { id: true },
  });
  created.events.push(soloEvent.id);
  await prisma.routeHypothesis.create({
    data: {
      orgId: org.id, dataMode: 'TEST', eventId: soloEvent.id, companyId: company.id,
      route: 'BROKERAGE', playbookKey: 'cleaning.brokerage.recurring',
      headline: `${MARK} sole reading`, rationale: 'Seeded by the reconciliation audit.',
      tier: 'STRONG_TRIGGER', status: 'RESEARCH',
    },
  });

  // One of the four has been called. It must survive whatever it scores.
  await prisma.outreachAttempt.create({
    data: {
      orgId: org.id, routeId: groundsRoute, userId: owner.id,
      disposition: 'NEED_UNCONFIRMED',
      notes: 'Seeded by the reconciliation audit: somebody rang this one.',
      occurredAt: new Date(),
    },
  });

  // --- the preview ---------------------------------------------------------
  console.log('\n--- what would change --------------------------------------------');
  const before = await prisma.routeHypothesis.count({
    where: { eventId: { in: created.events }, status: { notIn: ['EXPIRED', 'REJECTED'] } },
  });

  const preview = await reconciliationPreview({ orgId: org.id, dataMode: 'TEST' });
  const group = preview.groups.find((g) => g.eventId === event.id);
  check('the refracted event is reported', Boolean(group), `${preview.groups.length} group(s)`);
  check('with all four readings on it', group?.routeCount === 4, `${group?.routeCount}`);

  const after = await prisma.routeHypothesis.count({
    where: { eventId: { in: created.events }, status: { notIn: ['EXPIRED', 'REJECTED'] } },
  });
  check('the preview changed nothing', before === after, `${before} → ${after}`);

  const rows = group?.rows ?? [];
  const verdictOf = (id: string) => rows.find((r) => r.routeId === id)?.verdict;

  check(
    'the route somebody rang is marked untouchable',
    verdictOf(groundsRoute) === 'WORKED',
    verdictOf(groundsRoute),
  );
  check(
    'and says so in terms of the conversation, not the score',
    /call attempt/i.test(rows.find((r) => r.routeId === groundsRoute)?.because ?? ''),
    rows.find((r) => r.routeId === groundsRoute)?.because,
  );

  const retained = rows.filter((r) => r.verdict === 'RETAINED');
  check('exactly one reading is kept', retained.length === 1, `${retained.length}`);
  check(
    'and it is the one the source\'s own words support',
    retained[0]?.routeId === restaurantRoute,
    `${retained[0]?.playbookKey}`,
  );

  const superseded = rows.filter((r) => r.verdict === 'SUPERSEDED');
  check('the weaker readings are proposed for closure', superseded.length >= 1, `${superseded.length}`);
  check(
    'each saying why it lost rather than merely that it did',
    superseded.every((r) => r.because.length > 40),
    superseded[0]?.because,
  );
  check(
    'and that the event and the stronger reading survive',
    superseded.every((r) => /stronger reading of the same event stays open/i.test(r.proposedAction)),
  );

  // The event with one route is never examined.
  check(
    'an event with a single reading is not examined at all',
    !preview.groups.some((g) => g.eventId === soloEvent.id),
  );

  // --- applying it ---------------------------------------------------------
  console.log('\n--- closing only what was named ----------------------------------');
  const target = superseded[0]?.routeId;
  if (!target) {
    check('there is something to close', false);
    return;
  }

  const applied = await applyReconciliation({
    orgId: org.id,
    actorId: owner.id,
    routeIds: [target],
    reason: 'Weaker reading of a licence that reads plainly as restaurant supply.',
  });
  check('the named route is closed', applied.closed === 1, JSON.stringify(applied));

  const closedRoute = await prisma.routeHypothesis.findUniqueOrThrow({
    where: { id: target },
    select: { status: true, statusReason: true },
  });
  check('as rejected rather than deleted', closedRoute.status === 'REJECTED', closedRoute.status);
  check(
    'carrying the owner\'s own reason and the date',
    /Weaker reading/.test(closedRoute.statusReason ?? '') && /\d{4}-\d{2}-\d{2}/.test(closedRoute.statusReason ?? ''),
    closedRoute.statusReason ?? '',
  );

  const untouched = await prisma.routeHypothesis.findUniqueOrThrow({
    where: { id: cleanRoute === target ? restaurantRoute : cleanRoute },
    select: { status: true },
  });
  check('nothing else was touched', untouched.status !== 'REJECTED', untouched.status);

  // --- the refusal ---------------------------------------------------------
  console.log('\n--- and the refusal that makes it safe ---------------------------');
  const refusedWorked = await applyReconciliation({
    orgId: org.id,
    actorId: owner.id,
    routeIds: [groundsRoute],
    reason: 'Attempting to close a route somebody has worked.',
  });
  check('a worked route is refused even when named', refusedWorked.closed === 0);
  check(
    'and the refusal explains itself',
    /record of a conversation/i.test(refusedWorked.refused[0]?.because ?? ''),
    refusedWorked.refused[0]?.because,
  );

  const stillOpen = await prisma.routeHypothesis.findUniqueOrThrow({
    where: { id: groundsRoute },
    select: { status: true },
  });
  check('and it is still open', stillOpen.status !== 'REJECTED', stillOpen.status);

  const refusedTwice = await applyReconciliation({
    orgId: org.id, actorId: owner.id, routeIds: [target], reason: 'Closing something already closed.',
  });
  check('closing something already closed is a no-op with a reason', refusedTwice.closed === 0);
}

async function cleanup() {
  const routes = await prisma.routeHypothesis.findMany({
    where: { eventId: { in: created.events } }, select: { id: true },
  });
  const routeIds = routes.map((r) => r.id);
  await prisma.outreachAttempt.deleteMany({ where: { routeId: { in: routeIds } } });
  await prisma.outreachState.deleteMany({ where: { routeId: { in: routeIds } } });
  await prisma.routeHypothesis.deleteMany({ where: { id: { in: routeIds } } });
  await prisma.demandEvent.deleteMany({ where: { id: { in: created.events } } });
  await prisma.company.deleteMany({ where: { id: { in: created.companies } } });
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
