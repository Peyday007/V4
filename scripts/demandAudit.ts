/**
 * End-to-end demand-engine run against a real database.
 *
 * Drives the production path: the real connector, the real ingest, the real
 * verification, the real account resolution, the real playbooks, the real
 * friction and economics. The only substitution is the HTTP transport, because
 * this sandbox has no egress to the city portals.
 *
 * That substitution is the honest limit of what this can prove. It shows the
 * pipeline writes what it says it writes, against Postgres, with realistic
 * payload shapes. It does not show that data.cityofchicago.org returns those
 * shapes today — only the deployed diagnostic can show that.
 *
 *   npx tsx scripts/demandAudit.ts --stub
 */

import { prisma } from '@/lib/db';
import { ensureDefaultPaths } from '@/lib/paths';
import { setTransport } from '@/lib/discovery/http';
import { runDemandSource } from '@/lib/demand/run';
import { runDemandPipeline } from '@/lib/demand/pipeline';

const STUB = process.argv.includes('--stub');
const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 19);

/**
 * Rows shaped like a Chicago business-licence response.
 *
 * Deliberately heterogeneous, and deliberately containing the cases the
 * operator named: an independent gym opening soon, a franchise, a record with
 * no date, one business appearing twice under different spellings, and a
 * licence issued so long ago its window has closed.
 */
const CHICAGO_ROWS = [
  {
    legal_name: 'Ironside Strength LLC',
    doing_business_as_name: 'Ironside Strength',
    address: '2244 W Belmont Ave',
    city: 'Chicago',
    zip_code: '60618',
    license_description: 'Limited Business License',
    license_number: 'LIC-2026-88101',
    license_status: 'AAI',
    license_start_date: iso(21),
  },
  {
    legal_name: 'Northshore Dental Partners PC',
    doing_business_as_name: 'Northshore Dental',
    address: '1710 N Clark St',
    city: 'Chicago',
    zip_code: '60614',
    license_description: 'Regulated Business License',
    license_number: 'LIC-2026-88102',
    license_status: 'AAI',
    license_start_date: iso(9),
  },
  {
    legal_name: 'Anytime Fitness Franchising LLC',
    doing_business_as_name: 'Anytime Fitness',
    address: '55 E Monroe St',
    city: 'Chicago',
    zip_code: '60603',
    license_description: 'Limited Business License',
    license_number: 'LIC-2026-88103',
    license_status: 'AAI',
    license_start_date: iso(30),
  },
  {
    legal_name: 'Lakeview Cafe Group Inc',
    doing_business_as_name: 'Lakeview Cafe',
    address: '3200 N Halsted St',
    city: 'Chicago',
    zip_code: '60657',
    license_description: 'Retail Food Establishment',
    license_number: 'LIC-2026-88104',
    license_status: 'AAI',
    license_start_date: iso(-15),
  },
  {
    // No date. Must be dropped rather than stamped with today.
    legal_name: 'Undated Holdings LLC',
    doing_business_as_name: 'Undated Holdings',
    address: '10 S Wacker Dr',
    city: 'Chicago',
    license_number: 'LIC-2026-88105',
    license_status: 'AAI',
  },
  {
    // Long past its window. Should ingest and immediately expire.
    legal_name: 'Old News Retail LLC',
    doing_business_as_name: 'Old News Retail',
    address: '888 W Randolph St',
    city: 'Chicago',
    license_description: 'Limited Business License',
    license_number: 'LIC-2026-88106',
    license_status: 'AAI',
    license_start_date: iso(-320),
  },
  {
    // Same licence number as the first row, different spelling of the name.
    // Must collapse onto one event, not create a second.
    legal_name: 'IRONSIDE STRENGTH L.L.C.',
    doing_business_as_name: 'Ironside Strength',
    address: '2244 W Belmont Avenue',
    city: 'Chicago',
    zip_code: '60618',
    license_description: 'Limited Business License',
    license_number: 'LIC-2026-88101',
    license_status: 'AAI',
    license_start_date: iso(21),
  },
];

const AUSTIN_ROWS = [
  {
    applicant_organization: 'Riverside Holdings LP',
    contractor_company_name: 'BuildRight Construction',
    original_address1: '900 E 5th St',
    original_city: 'Austin',
    original_zip: '78702',
    description: 'Interior finish-out for new fitness studio',
    permit_number: 'BP-2026-77123',
    total_new_add_sqft: '5200',
    status_current: 'Active',
    permit_class_mapped: 'Commercial',
    issued_date: iso(-6),
  },
  {
    applicant_organization: 'Congress Retail Trust',
    contractor_company_name: 'Hill Country Builders',
    original_address1: '1400 S Congress Ave',
    original_city: 'Austin',
    original_zip: '78704',
    description: 'Tenant improvement, medical office suite',
    permit_number: 'BP-2026-77124',
    total_new_add_sqft: '3100',
    status_current: 'Active',
    permit_class_mapped: 'Commercial',
    issued_date: iso(-20),
  },
];

async function main() {
  const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!org) throw new Error('No organisation. Run the seed first.');
  const user = await prisma.user.findFirst({ where: { orgId: org.id } });
  if (!user) throw new Error('No user.');

  await ensureDefaultPaths(org.id);

  if (STUB) {
    setTransport(async (url) => {
      const target = String(url);
      const rows = target.includes('cityofchicago')
        ? CHICAGO_ROWS
        : target.includes('austintexas')
          ? AUSTIN_ROWS
          : [];
      // Every other configured portal answers empty, which is a legitimate
      // outcome and must not be reported as a failure.
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
  }

  console.log('--- running the demand source ---------------------------------');
  const run = await runDemandSource({ orgId: org.id, connectorKey: 'municipal_open_data', maxRecords: 100 });
  console.log(
    `${run.connector}: ${run.status} · examined ${run.recordsExamined} · created ${run.eventsCreated} · ` +
      `updated ${run.eventsUpdated} · rejected ${run.eventsRejected} · quarantined ${run.quarantined}`,
  );
  if (run.error) console.log(`  error: ${run.error}`);
  for (const warning of run.warnings) console.log(`  warning: ${warning.slice(0, 140)}`);

  console.log('\n--- idempotency: running it again ------------------------------');
  const rerun = await runDemandSource({ orgId: org.id, connectorKey: 'municipal_open_data', maxRecords: 100 });
  console.log(`created ${rerun.eventsCreated} (should be 0) · updated ${rerun.eventsUpdated}`);

  console.log('\n--- pipeline ---------------------------------------------------');
  const pipeline = await runDemandPipeline({ orgId: org.id, userId: user.id });
  console.log(
    `verified ${pipeline.verification.verified} · expired ${pipeline.verification.expired} · ` +
      `quarantined ${pipeline.verification.quarantined}`,
  );
  console.log(`accounts resolved ${pipeline.resolution.resolved}`);
  console.log(
    `routes created ${pipeline.routes.routesCreated} · updated ${pipeline.routes.routesUpdated} · ` +
      `expired ${pipeline.routes.routesExpired}`,
  );
  console.log(`by route:    ${JSON.stringify(pipeline.routes.byRoute)}`);
  console.log(`by tier:     ${JSON.stringify(pipeline.routes.byTier)}`);
  console.log(`by friction: ${JSON.stringify(pipeline.routes.byFriction)}`);
  console.log(`low-friction queue: ${pipeline.routes.lowFrictionQueue}`);

  console.log('\n--- playbooks that did NOT fire, and why -----------------------');
  const reasons = new Map<string, number>();
  for (const skip of pipeline.routes.skipped) {
    reasons.set(skip.because, (reasons.get(skip.because) ?? 0) + 1);
  }
  for (const [reason, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${String(count).padStart(3)}  ${reason}`);
  }

  console.log('\n--- events -----------------------------------------------------');
  const events = await prisma.demandEvent.findMany({
    where: { orgId: org.id },
    include: { parties: true },
    orderBy: { eventDate: 'desc' },
  });
  console.log('lifecycle    date        type                              account');
  for (const event of events) {
    console.log(
      `${event.lifecycle.padEnd(12)} ${(event.eventDate?.toISOString().slice(0, 10) ?? '—').padEnd(11)} ` +
        `${event.type.padEnd(33)} ${event.parties[0]?.sourceName ?? '—'}` +
        `${event.expiredReason ? `  [expired: ${event.expiredReason.slice(0, 60)}]` : ''}` +
        `${event.quarantineReason ? `  [held: ${event.quarantineReason.slice(0, 60)}]` : ''}`,
    );
  }

  console.log('\n--- routes -----------------------------------------------------');
  const routes = await prisma.routeHypothesis.findMany({
    where: { orgId: org.id },
    include: { company: true, event: true },
    orderBy: [{ companyId: 'asc' }, { route: 'asc' }],
  });
  console.log('tier  friction   route           status              window            account / playbook');
  for (const route of routes) {
    console.log(
      `${route.tier.slice(0, 4).padEnd(5)} ` +
        `${route.friction.slice(0, 9).padEnd(10)} ` +
        `${route.route.padEnd(15)} ` +
        `${route.status.padEnd(19)} ` +
        `${(route.buyingWindow ?? '—').padEnd(17)} ` +
        `${route.company.legalName} / ${route.playbookKey.replace('cleaning.', '')}`,
    );
  }

  console.log('\n--- one account, several routes --------------------------------');
  const grouped = new Map<string, typeof routes>();
  for (const route of routes) grouped.set(route.companyId, [...(grouped.get(route.companyId) ?? []), route]);
  for (const [, group] of grouped) {
    if (group.length < 2) continue;
    console.log(`${group[0].company.legalName}: ${group.length} routes from ${new Set(group.map((r) => r.eventId)).size} event(s)`);
    for (const route of group) console.log(`    ${route.route.padEnd(15)} ${route.headline}`);
  }

  console.log('\n--- honesty checks ---------------------------------------------');
  const undated = events.filter((e) => !e.eventDate);
  const tierAB = routes.filter((r) => r.tier === 'ACTIVE_DEMAND' || r.tier === 'STRONG_TRIGGER');
  const withoutSourceUrl = tierAB.filter((r) => !r.event.sourceUrl);
  const lowFrictionUnknown = routes.filter((r) => r.friction === 'UNKNOWN_RESEARCH_REQUIRED');

  console.log(`events with no source date:                       ${undated.length} (connector should drop these)`);
  console.log(`tier A/B routes lacking a durable source link:     ${withoutSourceUrl.length} (must be 0)`);
  console.log(`routes with unknown friction:                      ${lowFrictionUnknown.length} (none may sit in the low-friction queue)`);
  console.log(`routes in the low-friction queue:                  ${routes.filter((r) => r.friction === 'LOW' && r.status !== 'EXPIRED').length}`);
  console.log(`subcontracting routes:                             ${routes.filter((r) => r.route === 'SUBCONTRACTING').length} (0 expected — no prime asked for capacity)`);

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
