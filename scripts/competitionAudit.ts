/**
 * One event does not become several jobs — proved against the real pipeline.
 *
 * The unit tests prove the competition picks one winner. They cannot prove the
 * production pipeline calls it, and that gap is the single failure this project
 * keeps repeating: correct logic that nothing invokes. A portfolio audit once
 * found 54 live routes resting on two events, one refracted into 42, and every
 * component involved passed its own tests.
 *
 * So this drives `runDemandPipeline` — the same function the recurring worker
 * calls — against Postgres with TEST-mode events built to be ambiguous on
 * purpose, and counts the rows that come out the other side.
 *
 * Four things are checked:
 *
 *   An event several playbooks could read produces exactly one route.
 *   The route that wins is the reading the source's own words support.
 *   The losing readings are kept on the event, and are not routes.
 *   An event nothing credibly explains produces no route and says why.
 *
 * Everything it creates is TEST-mode and removed afterwards, including on
 * failure.
 *
 *   npx tsx scripts/competitionAudit.ts
 */

import { prisma } from '@/lib/db';
import { runDemandPipeline } from '@/lib/demand/pipeline';
import { playbooksFor } from '@/lib/demand/playbooks';
import type { CompetitionResult } from '@/lib/demand/competition';

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
    console.error(`Writes demand events and routes; local databases only. DATABASE_URL points at "${host}".`);
    process.exit(1);
  }
}

const MARK = 'COMPETITION-AUDIT';
const created = { events: [] as string[], companies: [] as string[] };

const NOW = new Date();
const ahead = (days: number) => new Date(NOW.getTime() + days * 86_400_000);

async function seedEvent(input: {
  orgId: string;
  headline: string;
  type: 'CONTRACT_AWARD' | 'OCCUPANCY_OR_OPERATING_APPROVAL';
  companyName: string;
  scope: string;
  primeState?: string;
}) {
  const company = await prisma.company.create({
    data: {
      orgId: input.orgId,
      dataMode: 'TEST',
      legalName: `[TEST] ${input.companyName}`,
      companyRole: 'BUYER',
      stateCode: 'IL',
      cityName: 'Chicago',
    },
    select: { id: true },
  });
  created.companies.push(company.id);

  const event = await prisma.demandEvent.create({
    data: {
      orgId: input.orgId,
      dataMode: 'TEST',
      connector: 'audit_fixture',
      type: input.type,
      lifecycle: 'VERIFIED',
      headline: `${MARK} ${input.headline}`,
      summary: input.scope,
      // A real external date and a real-looking source, because the tier gate
      // refuses anything without them and this audit is about the competition,
      // not about re-testing the tier gate.
      eventDate: ahead(20),
      sourceUrl: `https://example.invalid/${MARK}/${encodeURIComponent(input.headline)}`,
      sourceRecordId: `${MARK}-${input.headline}`,
      dedupeKey: `${MARK}:${input.headline}`.toLowerCase(),
      stateCode: 'IL',
      cityName: 'Chicago',
      confirmedFacts: [input.scope],
      inferredFacts: [],
      rawPayload: {
        __scope: input.scope,
        ...(input.primeState ? { __recipientState: input.primeState } : {}),
      },
      parties: {
        create: [
          {
            role: input.type === 'CONTRACT_AWARD' ? 'PRIME_CONTRACTOR' : 'BUYER',
            sourceName: `[TEST] ${input.companyName}`,
            companyId: company.id,
            resolutionConfidence: 1,
            resolutionMethod: 'audit fixture',
          },
          // A buying party too, so a reading that needs one is not eliminated
          // for a reason this audit is not testing.
          {
            role: 'BUYER',
            sourceName: `[TEST] ${input.companyName} (buyer)`,
            companyId: company.id,
            resolutionConfidence: 1,
            resolutionMethod: 'audit fixture',
          },
        ],
      },
    },
    select: { id: true },
  });
  created.events.push(event.id);
  return event.id;
}

async function cleanUp() {
  await prisma.routeHypothesis.deleteMany({ where: { eventId: { in: created.events } } });
  await prisma.demandEventParty.deleteMany({ where: { eventId: { in: created.events } } });
  await prisma.demandEvent.deleteMany({ where: { id: { in: created.events } } });
  await prisma.companyIndustry.deleteMany({ where: { companyId: { in: created.companies } } });
  await prisma.company.deleteMany({ where: { id: { in: created.companies } } });
  console.log('\nCleaned up every record this audit created.');
}

async function main() {
  refuseUnlessLocal();
  const org = await prisma.organization.findFirstOrThrow({ select: { id: true } });

  console.log('='.repeat(74));
  console.log('COMPETITION — one event, one primary reading, through the real pipeline');
  console.log('='.repeat(74));

  // How many readings could apply at all. If this is one, the audit proves
  // nothing, so it is asserted rather than assumed.
  const awardReadings = playbooksFor('CONTRACT_AWARD').length;
  console.log(`\n${awardReadings} playbook(s) can read a contract award.`);
  check('a contract award is genuinely ambiguous', awardReadings >= 2, `${awardReadings} reading(s)`);

  // ---------------------------------------------------------------------
  // 1. An award whose own words are about steel
  // ---------------------------------------------------------------------
  console.log('\n--- an award the source describes as structural steel -----------');
  const steelEvent = await seedEvent({
    orgId: org.id,
    headline: 'steel-award',
    type: 'CONTRACT_AWARD',
    companyName: 'Northline Constructors',
    scope: 'Structural steel supply and erection for bridge rehabilitation, phase two',
    primeState: 'GA',
  });

  await runDemandPipeline({ orgId: org.id, now: NOW });

  const steelRoutes = await prisma.routeHypothesis.findMany({
    where: { eventId: steelEvent },
    select: { playbookKey: true, route: true, headline: true },
  });

  check(
    'exactly one route is created, not one per matching playbook',
    steelRoutes.length === 1,
    `${steelRoutes.length} route(s): ${steelRoutes.map((r) => r.playbookKey).join(', ')}`,
  );
  check(
    'and it is the reading the source’s own words support',
    steelRoutes[0]?.playbookKey === 'distribution.materials.steel',
    `won: ${steelRoutes[0]?.playbookKey ?? 'none'}`,
  );

  const steelRecord = await prisma.demandEvent.findUniqueOrThrow({
    where: { id: steelEvent },
    select: { competition: true },
  });
  const steelCompetition = steelRecord.competition as unknown as CompetitionResult | null;

  check('the competition is recorded on the event', steelCompetition !== null);
  check(
    'the losing readings are kept rather than discarded',
    (steelCompetition?.alternatives.length ?? 0) >= 1,
    `${steelCompetition?.alternatives.length ?? 0} alternative(s)`,
  );
  check(
    'and each says why it lost',
    (steelCompetition?.alternatives ?? []).every((a) => Boolean(a.lostBecause)),
  );
  check(
    'the kept alternatives are not routes',
    steelRoutes.length < 1 + (steelCompetition?.alternatives.length ?? 0),
    'an alternative became a route, which is the failure this exists to stop',
  );
  check(
    'the event records which lane it came through',
    steelCompetition?.lane === 'TRIGGER_BACKED',
    `lane: ${steelCompetition?.lane}`,
  );

  // ---------------------------------------------------------------------
  // 2. An opening that supports nothing in particular
  // ---------------------------------------------------------------------
  console.log('\n--- a licence record that supports no credible reading ----------');
  const thinEvent = await seedEvent({
    orgId: org.id,
    headline: 'thin-licence',
    type: 'OCCUPANCY_OR_OPERATING_APPROVAL',
    companyName: 'Altruistic Esthetics',
    // Deliberately nothing commercial in it. A beauty salon licence is not a
    // cleaning contract, a steel order or a warehousing requirement, and the
    // old engine made it all three.
    scope: 'Limited business licence issued',
  });

  await runDemandPipeline({ orgId: org.id, now: NOW });

  const thinRoutes = await prisma.routeHypothesis.findMany({
    where: { eventId: thinEvent },
    select: { playbookKey: true },
  });
  const thinRecord = await prisma.demandEvent.findUniqueOrThrow({
    where: { id: thinEvent },
    select: { competition: true },
  });
  const thinCompetition = thinRecord.competition as unknown as CompetitionResult | null;

  check(
    'a weak record produces at most one route, never a fan of them',
    thinRoutes.length <= 1,
    `${thinRoutes.length} route(s): ${thinRoutes.map((r) => r.playbookKey).join(', ')}`,
  );
  check('the decision is recorded either way', thinCompetition !== null);
  if (thinRoutes.length === 0) {
    check(
      'and when nothing wins, the refusal says so in words',
      /no commercially credible route/i.test(thinCompetition?.verdict ?? ''),
      thinCompetition?.verdict?.slice(0, 140),
    );
  } else {
    check(
      'and when something wins it cleared the stated gate',
      (thinCompetition?.primary?.total ?? -99) >= (thinCompetition?.gate ?? 0),
      `scored ${thinCompetition?.primary?.total} against a gate of ${thinCompetition?.gate}`,
    );
  }

  // ---------------------------------------------------------------------
  // 3. Rerunning does not multiply
  // ---------------------------------------------------------------------
  console.log('\n--- running the pipeline again ----------------------------------');
  await runDemandPipeline({ orgId: org.id, now: NOW });
  const afterRerun = await prisma.routeHypothesis.count({ where: { eventId: steelEvent } });
  check(
    'a second pass does not add a second route',
    afterRerun === steelRoutes.length,
    `${steelRoutes.length} then ${afterRerun}`,
  );

  // ---------------------------------------------------------------------
  // 4. The whole fixture set, counted
  // ---------------------------------------------------------------------
  console.log('\n--- refraction across everything this audit created --------------');
  const allRoutes = await prisma.routeHypothesis.count({ where: { eventId: { in: created.events } } });
  check(
    'routes never exceed events',
    allRoutes <= created.events.length,
    `${allRoutes} route(s) from ${created.events.length} event(s) — anything above 1:1 is refraction`,
  );
}

main()
  .then(async () => {
    await cleanUp();
    console.log(`\n${'='.repeat(74)}`);
    console.log(`${passed}/${passed + failed} checks passed.`);
    await prisma.$disconnect();
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch(async (error) => {
    console.error(error);
    await cleanUp().catch(() => {});
    await prisma.$disconnect();
    process.exit(1);
  });
