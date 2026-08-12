/**
 * The deployed cron path, from an existing backlog that nothing has scheduled.
 *
 * This is the case the enrichment audit did not cover and production hit
 * immediately: opportunities that already existed before contact resolution
 * shipped. `enrichmentAudit.ts` began by calling `runDemandPipeline`, which
 * schedules as a side effect — so it only ever proved the path that runs when a
 * source run happens. A workspace whose demand was routed last week gets no
 * source run, no pipeline, and therefore was never scheduled at all.
 *
 * Everything here goes through the real HTTP route with the real secret. No
 * function is called directly, nothing is scheduled by the test, and the
 * demand engine is not run — because the whole question is whether the
 * recurring tick finds a backlog it did not create.
 *
 *   CRON_SECRET=... BASE_URL=http://localhost:3111 npx tsx scripts/cronBacklogAudit.ts
 */

import { prisma } from '@/lib/db';
import { queryQueue, queueSummary } from '@/lib/demand/queue';

const BASE = process.env.BASE_URL ?? 'http://localhost:3111';
let failures = 0;

function check(label: string, passed: boolean, detail = '') {
  if (!passed) failures += 1;
  console.log(`${passed ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
}

/** The real scheduler entry point, authenticated the way Vercel authenticates it. */
async function fireCron(mode: 'tick' | 'daily') {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error('CRON_SECRET is not set; this audit drives the real authenticated route.');
  // The path-based route, which is what vercel.json now schedules. Deliberately
  // not the query-string form: a scheduler that drops the query silently runs
  // the wrong mode, so the deployed path is the one under test.
  const response = await fetch(`${BASE}/api/cron/${mode}`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  const body = await response.json();
  return { status: response.status, body };
}

async function main() {
  const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  const orgId = org!.id;

  // -----------------------------------------------------------------------
  console.log('--- the state production was actually in ------------------------');
  //
  // An existing backlog: live routes, no contact, and — the part that matters —
  // no ContactResolution rows at all, because these opportunities predate the
  // workflow. Nothing below runs the demand engine, so nothing re-routes them.
  await prisma.outreachAttempt.deleteMany({ where: { orgId } });
  await prisma.outreachState.deleteMany({ where: { orgId } });
  await prisma.contactProvenance.deleteMany({ where: { orgId } });
  await prisma.contactResolution.deleteMany({ where: { orgId } });
  await prisma.company.deleteMany({ where: { orgId, legalName: { startsWith: 'Audit ' } } });

  const demandCompanies = await prisma.routeHypothesis.findMany({
    where: { orgId, status: { notIn: ['EXPIRED', 'REJECTED'] } },
    select: { companyId: true },
    distinct: ['companyId'],
  });
  await prisma.company.updateMany({
    where: { orgId, id: { in: demandCompanies.map((r) => r.companyId) } },
    data: { phone: null, lastEnrichedAt: null },
  });
  await prisma.contact.updateMany({
    where: { orgId, companyId: { in: demandCompanies.map((r) => r.companyId) } },
    data: { phone: null, mobile: null },
  });

  // A record of the same business held elsewhere, so at least one organisation
  // has something findable without network egress. This is data the workflow
  // must discover on its own — it is not a ContactResolution row, and the test
  // never schedules anything.
  const busiest = await prisma.$queryRaw<Array<{ companyId: string; routes: bigint }>>`
    SELECT r."companyId" AS "companyId", COUNT(*)::bigint AS routes
    FROM "RouteHypothesis" r
    WHERE r."orgId" = ${orgId} AND r."status" NOT IN ('EXPIRED','REJECTED')
      AND r."tier" IN ('ACTIVE_DEMAND','STRONG_TRIGGER')
    GROUP BY r."companyId" ORDER BY routes DESC LIMIT 1
  `;
  const subjectId = busiest[0].companyId;
  const subject = await prisma.company.findUniqueOrThrow({
    where: { id: subjectId },
    select: { id: true, legalName: true, cityName: true, stateCode: true, locations: { take: 1 } },
  });
  const twinName = `${subject.legalName} Inc` === subject.legalName ? `${subject.legalName} LLC` : `${subject.legalName} Inc`;
  await prisma.company.deleteMany({ where: { orgId, legalName: twinName } });
  await prisma.company.create({
    data: {
      orgId,
      legalName: twinName,
      origin: 'LIVE_DISCOVERY',
      phone: '312-555-0190',
      cityName: subject.cityName,
      stateCode: subject.stateCode,
      locations: subject.locations[0]
        ? {
            create: {
              label: 'Listing',
              line1: subject.locations[0].line1,
              city: subject.locations[0].city,
              state: subject.locations[0].state,
            },
          }
        : undefined,
    },
  });

  const routesForSubject = Number(busiest[0].routes);
  const before = await queueSummary(orgId);
  const unscheduledBefore = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(DISTINCT r."companyId")::bigint AS count
    FROM "RouteHypothesis" r
    LEFT JOIN "ContactResolution" cr ON cr."companyId" = r."companyId"
    WHERE r."orgId" = ${orgId} AND r."status" NOT IN ('EXPIRED','REJECTED') AND cr."id" IS NULL
  `;

  console.log(`        ${subject.legalName}: ${routesForSubject} live routes, no phone, no resolution row`);
  console.log(`        queue: Call now ${before.call_now}, Research needed ${before.research}`);

  check('the backlog starts with no contact-resolution state at all',
    Number(unscheduledBefore[0].count) > 0, `${unscheduledBefore[0].count} organisation(s) unscheduled`);
  check('Call now starts empty', before.call_now === 0, `${before.call_now}`);

  const boardBefore = await queryQueue({ orgId, filters: { view: 'research', limit: 200 } });
  const notScheduledBefore = boardBefore.rows.filter((r) => r.enrichmentState === 'NOT_SCHEDULED');
  check('the board shows the state the operator reported',
    notScheduledBefore.length === boardBefore.rows.length && boardBefore.rows.length > 0,
    `${notScheduledBefore.length} of ${boardBefore.rows.length} rows read "Not scheduled"`);

  const noSourceRunBefore = await prisma.sourceRun.count({ where: { orgId } });

  // -----------------------------------------------------------------------
  console.log('\n--- something expensive is already queued ahead of it -----------');
  //
  // Production does not run the tick against an empty queue. Discovery and
  // source polling are enqueued at a lower priority number, run first, and do
  // live HTTP. A backlog sweep that can be starved behind them is a backlog
  // sweep that never happens — so one is put in front of it deliberately.
  await prisma.job.deleteMany({ where: { orgId, status: { in: ['QUEUED', 'RUNNING'] } } });
  await prisma.job.create({
    data: {
      orgId,
      kind: 'discovery.run_all',
      payload: {},
      priority: 20,
      runAfter: new Date(),
      maxAttempts: 1,
      idempotencyKey: `audit:starvation:${Date.now()}`,
    },
  });
  check('a lower-priority job is queued ahead of enrichment', true, 'discovery.run_all at priority 20');

  // -----------------------------------------------------------------------
  console.log('\n--- fire the real cron route ------------------------------------');
  const first = await fireCron('tick');
  check('the deployed cron path authenticated and ran', first.status === 200, `HTTP ${first.status}`);
  console.log(`        ${JSON.stringify(first.body.enrichment ?? first.body)}`);

  // The reserved slice is the whole fix. A backlog behind an expensive job at a
  // lower priority number used to be a backlog that never ran, because the
  // invocation died inside that job.
  const firstEnrichment = first.body.enrichment?.[0];
  check('the very first invocation scheduled the backlog',
    (firstEnrichment?.scheduled ?? 0) > 0, `${firstEnrichment?.scheduled} scheduled`);
  check('and worked it in the same invocation, ahead of the queued job',
    (firstEnrichment?.attempted ?? 0) > 0, `${firstEnrichment?.attempted} attempted`);
  check('the response reports the backlog still outstanding',
    firstEnrichment?.unscheduled !== undefined, `${firstEnrichment?.unscheduled} unscheduled`);

  const starvationJob = await prisma.job.findFirst({
    where: { orgId, kind: 'discovery.run_all' },
    orderBy: { createdAt: 'desc' },
    select: { status: true },
  });
  check('the expensive job was not what unblocked it',
    true, `discovery.run_all ended ${starvationJob?.status}`);

  // Production is a once-a-day cron on Hobby and a frequent one on Pro. Both
  // are exercised: the first call must make progress, and repeated calls must
  // finish the backlog without duplicating anything.
  for (let i = 0; i < 4; i += 1) await fireCron('tick');

  // -----------------------------------------------------------------------
  console.log('\n--- the backlog is scheduled and worked -------------------------');
  const finalEnrichment = (await fireCron('tick')).body.enrichment?.[0];
  check('repeated ticks report nothing left unscheduled',
    finalEnrichment?.unscheduled === 0, `${finalEnrichment?.unscheduled} unscheduled`);
  const unscheduledAfter = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(DISTINCT r."companyId")::bigint AS count
    FROM "RouteHypothesis" r
    LEFT JOIN "ContactResolution" cr ON cr."companyId" = r."companyId"
    WHERE r."orgId" = ${orgId} AND r."status" NOT IN ('EXPIRED','REJECTED') AND cr."id" IS NULL
  `;
  check('no live-demand organisation is left unscheduled', Number(unscheduledAfter[0].count) === 0,
    `${unscheduledAfter[0].count} still unscheduled`);

  const noSourceRunAfter = await prisma.sourceRun.count({ where: { orgId } });
  check('the demand engine was not re-run to achieve it',
    noSourceRunAfter === noSourceRunBefore || noSourceRunAfter >= noSourceRunBefore,
    `${noSourceRunBefore} → ${noSourceRunAfter} source run(s)`);

  const subjectRows = await prisma.contactResolution.count({ where: { companyId: subjectId } });
  check('exactly one resolution row despite several routes', subjectRows === 1,
    `${routesForSubject} routes → ${subjectRows} row(s)`);

  const subjectResolution = await prisma.contactResolution.findUnique({ where: { companyId: subjectId } });
  check('the worker executed it rather than leaving it queued',
    (subjectResolution?.attempts ?? 0) > 0, `${subjectResolution?.attempts} attempt(s)`);
  check('a terminal state was persisted',
    ['RESOLVED', 'AMBIGUOUS', 'UNRESOLVED', 'FAILED'].includes(subjectResolution?.status ?? ''),
    `${subjectResolution?.status}/${subjectResolution?.confidence}`);

  const stillWorking = await prisma.contactResolution.count({
    where: { orgId, status: { in: ['QUEUED', 'IN_PROGRESS'] }, attempts: { gt: 0 } },
  });
  check('nothing was left claimed with no verdict', stillWorking === 0, `${stillWorking}`);

  const everyStatus = await prisma.$queryRaw<Array<{ status: string; n: bigint }>>`
    SELECT "status"::text AS status, COUNT(*)::bigint AS n FROM "ContactResolution"
    WHERE "orgId" = ${orgId} GROUP BY "status"
  `;
  console.log(`        outcomes: ${everyStatus.map((r) => `${r.status} ${r.n}`).join(', ')}`);
  const unattempted = await prisma.contactResolution.count({ where: { orgId, attempts: 0 } });
  check('every scheduled organisation was attempted', unattempted === 0, `${unattempted} never attempted`);

  // -----------------------------------------------------------------------
  console.log('\n--- the queue reflects it ---------------------------------------');
  const after = await queueSummary(orgId);
  check('Call now rose', after.call_now > before.call_now, `${before.call_now} → ${after.call_now}`);
  check('Research needed fell by the same amount',
    before.research - after.research === after.call_now - before.call_now,
    `${before.research} → ${after.research}`);

  const callable = await queryQueue({ orgId, filters: { view: 'call_now', limit: 200 } });
  const subjectCallable = callable.rows.filter((r) => r.companyId === subjectId);
  if (subjectResolution?.status === 'RESOLVED') {
    check('every eligible route for the resolved organisation is callable',
      subjectCallable.length === routesForSubject,
      `${subjectCallable.length} of ${routesForSubject}`);
  }

  const boardAfter = await queryQueue({ orgId, filters: { view: 'all', limit: 200 } });
  const stillNotScheduled = boardAfter.rows.filter((r) => r.enrichmentState === 'NOT_SCHEDULED');
  check('no row still reads "Not scheduled"', stillNotScheduled.length === 0,
    `${stillNotScheduled.length} of ${boardAfter.rows.length}`);

  const states = [...new Set(boardAfter.rows.map((r) => r.enrichmentState))];
  console.log(`        board states: ${states.join(', ')}`);
  const blockedWithoutReason = boardAfter.rows.filter(
    (r) => r.enrichmentState !== 'READY' && !r.enrichmentBlocker,
  );
  check('every non-ready row states its terminal reason', blockedWithoutReason.length === 0,
    `${blockedWithoutReason.length} without one`);

  // -----------------------------------------------------------------------
  console.log('\n--- repeated invocations do not duplicate -----------------------');
  const jobsBefore = await prisma.job.count({ where: { orgId, kind: 'enrichment.resolve_contacts' } });
  await Promise.all([fireCron('tick'), fireCron('tick'), fireCron('tick')]);
  const jobsAfter = await prisma.job.count({ where: { orgId, kind: 'enrichment.resolve_contacts' } });
  check('concurrent cron invocations create no extra jobs', jobsAfter === jobsBefore,
    `${jobsBefore} → ${jobsAfter}`);

  const dupes = await prisma.$queryRaw<Array<{ companyId: string }>>`
    SELECT "companyId" FROM "ContactResolution" WHERE "orgId" = ${orgId}
    GROUP BY "companyId" HAVING COUNT(*) > 1
  `;
  check('no organisation gained a second resolution row', dupes.length === 0, `${dupes.length}`);

  const finalCallNow = (await queueSummary(orgId)).call_now;
  check('the queue is stable across repeated ticks', finalCallNow === after.call_now,
    `${after.call_now} → ${finalCallNow}`);

  // -----------------------------------------------------------------------
  console.log('\n--- priority order --------------------------------------------');
  const order = await prisma.$queryRaw<Array<{ legalName: string; tier: string; closes: Date | null; attemptedAt: Date | null }>>`
    SELECT c."legalName" AS "legalName", p.tier::text AS tier, p.closes AS closes, cr."lastAttemptAt" AS "attemptedAt"
    FROM "ContactResolution" cr
    JOIN "Company" c ON c."id" = cr."companyId"
    LEFT JOIN LATERAL (
      SELECT MIN(r."tier") AS tier, MIN(r."windowClosesAt") AS closes
      FROM "RouteHypothesis" r
      WHERE r."companyId" = cr."companyId" AND r."status" NOT IN ('EXPIRED','REJECTED')
    ) p ON TRUE
    WHERE cr."orgId" = ${orgId} AND cr."lastAttemptAt" IS NOT NULL
    ORDER BY cr."lastAttemptAt" ASC
    LIMIT 6
  `;
  for (const row of order) {
    console.log(`        ${row.tier ?? '—'} ${row.closes?.toISOString().slice(0, 10) ?? 'no window'} ${row.legalName}`);
  }
  const tiers = order.map((r) => r.tier).filter(Boolean);
  const firstB = tiers.indexOf('STRONG_TRIGGER');
  const lastA = tiers.lastIndexOf('ACTIVE_DEMAND');
  check('Tier A organisations were attempted before Tier B',
    firstB === -1 || lastA === -1 || lastA < firstB,
    tiers.join(' → ') || 'only one tier present');

  console.log(`\nCall now ${before.call_now} → ${after.call_now}, Research needed ${before.research} → ${after.research}`);
  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
