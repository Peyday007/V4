/**
 * Move test litter out of the production world.
 *
 * The portfolio audit found that every one of the 54 "production" route
 * hypotheses came from two audit-fixture events — one refracted into 42 routes,
 * one into 12 — left behind by scripts that create their fixtures with the
 * default data mode. The effect was a screen that looked like a commercial
 * portfolio, 85% concentrated in janitorial work, resting on a connector called
 * `audit_fixture` with no source URL. Meanwhile the real connectors were
 * enabled, had run, and had found nothing, and that emptiness was invisible
 * because the litter filled the space where it would have shown.
 *
 * This moves that data to the test world rather than deleting it: the counts,
 * the queries and the reset that already understand `dataMode` then do the rest,
 * and nothing is destroyed by a script written in a hurry.
 *
 * The order is dictated by the isolation triggers. A route may not disagree
 * with its company or its event, and the commercial rows may not disagree with
 * their route — so companies and events move first, then routes, then
 * everything hanging off them.
 *
 *   npx tsx scripts/quarantineFixtures.ts --dry-run
 *   npx tsx scripts/quarantineFixtures.ts --apply
 */

import { prisma } from '@/lib/db';

/** Connectors that never represent a real observation of the world. */
const FIXTURE_CONNECTORS = ['audit_fixture', 'sandbox', 'seed', 'demo', 'fixture'];

const apply = process.argv.includes('--apply');

async function main() {
  const org = await prisma.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });

  const events = await prisma.demandEvent.findMany({
    where: { orgId: org.id, dataMode: 'PRODUCTION', connector: { in: FIXTURE_CONNECTORS } },
    select: { id: true, connector: true, headline: true, _count: { select: { routes: true } } },
  });

  if (events.length === 0) {
    console.log('No fixture-sourced events are in the production world. Nothing to quarantine.');
    return;
  }

  const eventIds = events.map((e) => e.id);
  const routes = await prisma.routeHypothesis.findMany({
    where: { orgId: org.id, eventId: { in: eventIds }, dataMode: 'PRODUCTION' },
    select: { id: true, companyId: true },
  });
  const routeIds = routes.map((r) => r.id);
  const companyIds = [...new Set(routes.map((r) => r.companyId))];

  // A company only moves if *everything* it is attached to is fixture work.
  // A seeded company that a real route also points at has to stay where it is,
  // or quarantining litter would take real records with it.
  const contested = await prisma.routeHypothesis.findMany({
    where: {
      orgId: org.id, companyId: { in: companyIds },
      dataMode: 'PRODUCTION', eventId: { notIn: eventIds },
    },
    select: { companyId: true },
  });
  const contestedIds = new Set(contested.map((c) => c.companyId));
  const movableCompanies = companyIds.filter((id) => !contestedIds.has(id));

  const counts = {
    events: events.length,
    routes: routeIds.length,
    companies: movableCompanies.length,
    companiesKeptBecauseRealWorkPointsAtThem: contestedIds.size,
    requirements: await prisma.buyerRequirement.count({ where: { routeId: { in: routeIds } } }),
    candidates: await prisma.providerCandidate.count({ where: { routeId: { in: routeIds } } }),
    quotes: await prisma.routeQuote.count({ where: { routeId: { in: routeIds } } }),
    deals: await prisma.routeDeal.count({ where: { routeId: { in: routeIds } } }),
    milestones: await prisma.demandOutcome.count({ where: { routeId: { in: routeIds } } }),
    attempts: await prisma.outreachAttempt.count({ where: { routeId: { in: routeIds } } }),
    packetItems: await prisma.packetItem.count({ where: { routeId: { in: routeIds } } }),
  };

  console.log('Fixture-sourced events found in the production world:\n');
  for (const e of events) {
    console.log(`  ${e.connector.padEnd(16)} ${String(e._count.routes).padStart(3)} routes  ${e.headline}`);
  }
  console.log('\nWhat moves with them:');
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(42)} ${v}`);

  if (!apply) {
    console.log('\nDry run. Nothing changed. Re-run with --apply to quarantine.');
    return;
  }

  // Packet items and attempts are the caller's side; they carry their own guard
  // and have to be released before the route moves under them.
  await prisma.packetItem.deleteMany({ where: { routeId: { in: routeIds } } });

  await prisma.$transaction([
    prisma.company.updateMany({ where: { id: { in: movableCompanies } }, data: { dataMode: 'TEST' } }),
    prisma.demandEvent.updateMany({ where: { id: { in: eventIds } }, data: { dataMode: 'TEST' } }),
  ]);

  // Routes next, now that both of their parents agree.
  await prisma.routeHypothesis.updateMany({
    where: { id: { in: routeIds } }, data: { dataMode: 'TEST' },
  });

  // Then everything whose trigger compares it with its route.
  await prisma.$transaction([
    prisma.outreachAttempt.updateMany({ where: { routeId: { in: routeIds } }, data: { dataMode: 'TEST' } }),
    prisma.buyerRequirement.updateMany({ where: { routeId: { in: routeIds } }, data: { dataMode: 'TEST' } }),
    prisma.providerCandidate.updateMany({ where: { routeId: { in: routeIds } }, data: { dataMode: 'TEST' } }),
    prisma.routeQuote.updateMany({ where: { routeId: { in: routeIds } }, data: { dataMode: 'TEST' } }),
    prisma.routeDeal.updateMany({ where: { routeId: { in: routeIds } }, data: { dataMode: 'TEST' } }),
    prisma.demandOutcome.updateMany({ where: { routeId: { in: routeIds } }, data: { dataMode: 'TEST' } }),
  ]);

  // Payments reach their route through the deal.
  const dealIds = (await prisma.routeDeal.findMany({
    where: { routeId: { in: routeIds } }, select: { id: true },
  })).map((d) => d.id);
  if (dealIds.length > 0) {
    await prisma.dealPayment.updateMany({ where: { dealId: { in: dealIds } }, data: { dataMode: 'TEST' } });
  }

  const remaining = await prisma.routeHypothesis.count({
    where: { orgId: org.id, dataMode: 'PRODUCTION' },
  });
  console.log(`\nQuarantined. Production route hypotheses remaining: ${remaining}.`);
  if (remaining === 0) {
    console.log(
      '\nThat is the honest state of the machine: no genuine demand has been\n'
      + 'collected yet. The connectors are enabled and have run; they returned\n'
      + 'nothing. That is now visible instead of being hidden behind fixtures.',
    );
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
