/**
 * One organisation is one phone call, and the portfolio is as big as it says.
 *
 * Two failures the portfolio audit found, checked against a real database in
 * the TEST world so nothing here can touch a production count.
 *
 * The first is the counting rule. One demand event fans out into a route per
 * applicable playbook, so a buyer whose licence matched three playbooks
 * produces three rows. A board that shows them as three is showing one phone
 * call three times, and a fill that hands a caller all three spends their
 * morning ringing one receptionist about three things they will hear about in
 * the first minute of the first call.
 *
 * The second is that nothing was measuring concentration, which is how 85% of
 * a portfolio came to be one trade sourced from one fixture without anybody
 * noticing.
 *
 *   npx tsx scripts/portfolioGuardAudit.ts
 */

import { prisma } from '@/lib/db';
import { callableRouteIds } from '@/lib/demand/eligibility';
import { portfolioShape } from '@/lib/portfolio/concentration';

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
    console.error(`Creates demand records; local databases only. DATABASE_URL points at "${host}".`);
    process.exit(1);
  }
}

const STAMP = Date.now();
const MARK = `guard-${STAMP}`;

async function main() {
  refuseUnlessLocal();
  const org = await prisma.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });

  console.log('='.repeat(72));
  console.log('PORTFOLIO GUARD — one organisation is one call');
  console.log('='.repeat(72));

  // Everything below is TEST-world. The isolation triggers set a child's mode
  // from its parent route, so companies and events have to be created first.
  const company = async (name: string, state: string) =>
    prisma.company.create({
      data: {
        orgId: org.id, legalName: name, stateCode: state, cityName: 'Chicago',
        phone: '+13125550100', dataMode: 'TEST', origin: 'MANUAL',
      },
      select: { id: true },
    });

  const event = async (headline: string) =>
    prisma.demandEvent.create({
      data: {
        orgId: org.id,
        connector: MARK,
        type: 'OCCUPANCY_OR_OPERATING_APPROVAL',
        sourceRecordId: `${MARK}:${headline}`,
        // Normally computed by the ingest from organisation, address and date;
        // set directly here because this bypasses ingest on purpose.
        dedupeKey: `${MARK}:${headline}`,
        headline,
        summary: headline,
        eventDate: new Date(Date.now() - 2 * 86_400_000),
        stateCode: 'IL',
        dataMode: 'TEST',
      },
      select: { id: true },
    });

  const route = async (eventId: string, companyId: string, playbookKey: string, capability: string) =>
    prisma.routeHypothesis.create({
      data: {
        orgId: org.id, eventId, companyId, playbookKey,
        headline: `${capability} for ${playbookKey}`,
        rationale: 'Fixture for the portfolio guard audit. Not a claim about anybody.',
        route: 'BROKERAGE', tier: 'ACTIVE_DEMAND', status: 'RESEARCH',
        requiredCapability: capability,
        friction: 'LOW', fulfilmentStatus: 'AVAILABLE',
        windowClosesAt: new Date(Date.now() + 20 * 86_400_000),
        dataMode: 'TEST',
      },
      select: { id: true },
    });

  // -- one buyer, three playbooks -------------------------------------------
  console.log('\n--- one licence, three playbooks, one receptionist --------------');
  const acme = await company(`${MARK} Acme Offices`, 'IL');
  const acmeEvent = await event(`${MARK} Acme opened a new floor`);
  const acmeRoutes = [
    await route(acmeEvent.id, acme.id, `${MARK}-a`, 'Commercial janitorial'),
    await route(acmeEvent.id, acme.id, `${MARK}-b`, 'Janitorial consumables'),
    await route(acmeEvent.id, acme.id, `${MARK}-c`, 'Commercial janitorial'),
  ];

  const other = await company(`${MARK} Borough Dental`, 'IL');
  const otherEvent = await event(`${MARK} Borough Dental opened`);
  await route(otherEvent.id, other.id, `${MARK}-a`, 'Commercial janitorial');

  // A fixed instant inside the calling window, so the audit's answer does not
  // depend on the hour it happens to run at. 15:00 UTC is 10am in Chicago.
  const at = new Date('2026-08-13T15:00:00Z');
  const picked = await callableRouteIds({ orgId: org.id, mode: 'TEST', limit: 25, now: at });
  const mine = picked.filter((id) => acmeRoutes.some((r) => r.id === id));
  check(
    'a fill offers one route for the buyer with three, not three',
    mine.length === 1,
    `${mine.length} of that buyer's routes were offered`,
  );
  check(
    'and still offers the other buyer, rather than shrinking the fill',
    picked.length >= 2,
    `${picked.length} route(s) offered in total`,
  );

  const withAll = await callableRouteIds({
    orgId: org.id, mode: 'TEST', limit: 25, allowMultiplePerCompany: true, now: at,
  });
  check(
    'asking for all of them explicitly still returns all of them',
    withAll.filter((id) => acmeRoutes.some((r) => r.id === id)).length === 3,
  );
  check(
    'and the siblings are not deleted — they come back on a later fill',
    (await prisma.routeHypothesis.count({ where: { eventId: acmeEvent.id } })) === 3,
  );

  // -- the shape of the thing -----------------------------------------------
  console.log('\n--- what the portfolio actually is ------------------------------');
  const shape = await portfolioShape({ orgId: org.id, dataMode: 'TEST' });
  check('routes are counted', shape.routes >= 4, String(shape.routes));
  check(
    'and so are the distinct events behind them',
    shape.opportunities < shape.routes,
    `${shape.routes} route(s) on ${shape.opportunities} event(s)`,
  );
  check(
    'refraction is named rather than left to be inferred from two numbers',
    shape.refraction === shape.routes - shape.opportunities && shape.refraction > 0,
  );
  check(
    'and the verdict says the portfolio is smaller than it looks',
    /smaller than it looks/.test(shape.verdict),
    shape.verdict.slice(0, 160),
  );

  // -- concentration says what breaks ---------------------------------------
  console.log('\n--- concentration, with a consequence attached ------------------');
  const source = shape.exposures.find((e) => e.dimension === 'source');
  check('the source concentration is measured', Boolean(source));
  check(
    'and it says what happens if that source goes, not just a percentage',
    /republishes a dataset/.test(source?.ifItGoes ?? ''),
    source?.ifItGoes.slice(0, 120),
  );

  const smallPortfolio = shape.routes < 8;
  check(
    'a portfolio this small is not nagged about being concentrated',
    smallPortfolio ? shape.exposures.every((e) => !e.material) : true,
    `${shape.routes} route(s); ${shape.exposures.filter((e) => e.material).length} flagged`,
  );

  // -- production is untouched ----------------------------------------------
  console.log('\n--- and production never saw any of this -----------------------');
  const productionShape = await portfolioShape({ orgId: org.id, dataMode: 'PRODUCTION' });
  check(
    'the production portfolio is unchanged by this audit',
    productionShape.routes === 0,
    `${productionShape.routes} production route(s)`,
  );
  check(
    'and says so honestly rather than reporting a balanced empty portfolio',
    /collection problem rather than a balance one/.test(productionShape.verdict),
    productionShape.verdict.slice(0, 140),
  );

  // -- cleanup ---------------------------------------------------------------
  await prisma.routeHypothesis.deleteMany({ where: { event: { connector: MARK } } });
  await prisma.demandEvent.deleteMany({ where: { connector: MARK } });
  await prisma.company.deleteMany({ where: { legalName: { startsWith: MARK } } });
  console.log('\nCleaned up every record this audit created.');

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
