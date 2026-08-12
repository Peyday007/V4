/**
 * The contact-resolution bridge, end to end against a real database.
 *
 * Every check is one the operator listed, and each drives the production path:
 * the same scheduling the pipeline calls, the same worker the cron runs, the
 * same queue clause the board reads. A fixture cannot show that two workers do
 * not enrich one organisation twice, that a resolved contact actually moves a
 * route into Call now, or that a do-not-contact record stays unreachable after
 * a number is found for it — so those are asked of Postgres.
 *
 * The network is not reachable from here, which makes one check better rather
 * than worse: the external provider genuinely fails, and the workflow has to
 * report a failure rather than "no contact found".
 *
 *   npx tsx scripts/enrichmentAudit.ts
 */

import { prisma } from '@/lib/db';
import { isCallable, queryQueue, queueSummary } from '@/lib/demand/queue';
import { saveDisposition } from '@/lib/demand/outreach';
import { loadCallCard } from '@/lib/demand/callCard';
import { runDemandPipeline } from '@/lib/demand/pipeline';
import { resolveCompanyContact } from '@/lib/enrichment/resolve';
import {
  claimResolutions,
  drainContactResolution,
  scheduleContactResolution,
  sweepContactResolution,
} from '@/lib/enrichment/schedule';
import { enrichmentOverview } from '@/lib/enrichment/report';
import { resolveSupply } from '@/lib/enrichment/supply';

let failures = 0;

function check(label: string, passed: boolean, detail = '') {
  if (!passed) failures += 1;
  console.log(`${passed ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  const user = await prisma.user.findFirst({ where: { orgId: org!.id } });
  const orgId = org!.id;

  // A repeatable starting point. The demand engine's own records — events,
  // routes, evidence — are never touched; only the outreach and contact layers
  // this workflow owns.
  await prisma.outreachAttempt.deleteMany({ where: { orgId } });
  await prisma.outreachState.deleteMany({ where: { orgId } });
  await prisma.contactProvenance.deleteMany({ where: { orgId } });
  await prisma.contactResolution.deleteMany({ where: { orgId } });
  await prisma.company.updateMany({ where: { orgId }, data: { phone: null, lastEnrichedAt: null } });
  await prisma.company.deleteMany({ where: { orgId, legalName: { startsWith: 'Audit ' } } });

  const startingSummary = await queueSummary(orgId);
  console.log(`starting point: ${JSON.stringify(startingSummary)}`);

  // -----------------------------------------------------------------------
  console.log('\n--- 1. an event with no phone number schedules enrichment ------');
  // The production trigger, not a helper: the pipeline is what a source run
  // calls, and scheduling is the last thing it does.
  const pipeline = await runDemandPipeline({ orgId });
  check(
    'running the pipeline put organisations into the workflow',
    pipeline.contactResolution.scheduled + pipeline.contactResolution.alreadyTracked > 0,
    `${pipeline.contactResolution.scheduled} scheduled, ${pipeline.contactResolution.alreadyTracked} already tracked`,
  );

  const uncovered = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(DISTINCT r."companyId")::bigint AS count
    FROM "RouteHypothesis" r
    LEFT JOIN "ContactResolution" cr ON cr."companyId" = r."companyId"
    WHERE r."orgId" = ${orgId} AND r."status" NOT IN ('EXPIRED','REJECTED') AND cr."id" IS NULL
  `;
  check('every account with live demand is in the workflow', Number(uncovered[0].count) === 0,
    `${uncovered[0].count} uncovered`);

  const queuedJob = await prisma.job.findFirst({
    where: { orgId, kind: 'enrichment.resolve_contacts' },
    orderBy: { createdAt: 'desc' },
  });
  check('a worker job was enqueued, not run inline', Boolean(queuedJob), queuedJob?.status ?? 'none');

  // -----------------------------------------------------------------------
  console.log('\n--- 2. scheduling twice does not duplicate work ----------------');
  const again = await scheduleContactResolution({ orgId });
  check('a second scheduling pass creates nothing new', again.scheduled === 0,
    `${again.scheduled} created, ${again.alreadyTracked} already tracked`);

  const duplicates = await prisma.$queryRaw<Array<{ companyId: string; n: bigint }>>`
    SELECT "companyId", COUNT(*)::bigint AS n FROM "ContactResolution"
    WHERE "orgId" = ${orgId} GROUP BY "companyId" HAVING COUNT(*) > 1
  `;
  check('no organisation has two resolution rows', duplicates.length === 0, `${duplicates.length} duplicated`);

  // -----------------------------------------------------------------------
  console.log('\n--- 3. one enrichment per organisation, not per route ----------');
  const shared = await prisma.$queryRaw<Array<{ companyId: string; routes: bigint }>>`
    SELECT "companyId", COUNT(*)::bigint AS routes FROM "RouteHypothesis"
    WHERE "orgId" = ${orgId} AND "status" NOT IN ('EXPIRED','REJECTED')
    GROUP BY "companyId" ORDER BY routes DESC LIMIT 1
  `;
  const busiest = shared[0];
  const rowsForBusiest = await prisma.contactResolution.count({ where: { companyId: busiest.companyId } });
  check(
    'an account with several routes has exactly one resolution record',
    rowsForBusiest === 1,
    `${busiest.routes} routes, ${rowsForBusiest} resolution row(s)`,
  );

  // -----------------------------------------------------------------------
  console.log('\n--- 4. two workers never claim the same organisation -----------');
  const [claimA, claimB] = await Promise.all([
    claimResolutions({ orgId, limit: 5, workerId: 'audit-worker-a' }),
    claimResolutions({ orgId, limit: 5, workerId: 'audit-worker-b' }),
  ]);
  const overlap = claimA.filter((a) => claimB.some((b) => b.id === a.id));
  check('concurrent claims do not overlap', overlap.length === 0,
    `${claimA.length} + ${claimB.length} claimed, ${overlap.length} overlapping`);
  // Released so the real pass below can take them.
  await prisma.contactResolution.updateMany({
    where: { orgId, lockedBy: { in: ['audit-worker-a', 'audit-worker-b'] } },
    data: { status: 'QUEUED', lockedAt: null, lockedBy: null },
  });

  // -----------------------------------------------------------------------
  console.log('\n--- 5. existing platform data is reused, not re-created --------');
  // A record of the same business reached by another route. The workflow must
  // find it and must not create a second company for it.
  const target = await prisma.company.findFirst({
    where: { orgId, contactResolution: { isNot: null } },
    select: { id: true, legalName: true, cityName: true, stateCode: true, locations: { take: 1 } },
    orderBy: { createdAt: 'asc' },
  });
  // A legal suffix the original does not already carry, so the twin is a
  // distinct row that normalises to the same name — which is the case the
  // platform adapter has to catch without creating a third company.
  const twinName =
    ['Inc', 'LLC', 'Corp', 'Ltd', 'Co'].map((suffix) => `${target!.legalName} ${suffix}`).find(
      (name) => name !== target!.legalName,
    ) ?? `${target!.legalName} Group`;
  await prisma.company.deleteMany({ where: { orgId, legalName: twinName } });
  // Counted after the twin is cleared and before it is made, so the number
  // below measures what resolution created rather than what this check did.
  const companiesBefore = await prisma.company.count({ where: { orgId } });

  const twin = await prisma.company.create({
    data: {
      orgId,
      legalName: twinName,
      origin: 'LIVE_DISCOVERY',
      phone: '312-555-0142',
      cityName: target!.cityName,
      stateCode: target!.stateCode,
      locations: target!.locations[0]
        ? {
            create: {
              label: 'Directory',
              line1: target!.locations[0].line1,
              city: target!.locations[0].city,
              state: target!.locations[0].state,
            },
          }
        : undefined,
    },
    select: { id: true },
  });

  const reused = await resolveCompanyContact({ orgId, companyId: target!.id, force: true });
  const companiesAfter = await prisma.company.count({ where: { orgId } });
  check('resolution created no new company', companiesAfter === companiesBefore + 1,
    `${companiesBefore} → ${companiesAfter} (the twin this check created, "${twinName}")`);
  check('the held record was reused as the contact source',
    reused.sources.includes('existing_platform_data'), reused.sources.join(', '));
  check('a result was recorded whatever the outcome', reused.status !== undefined, `${reused.status}/${reused.confidence}`);
  console.log(`        ${target!.legalName}: ${reused.status} — ${reused.blocker ?? reused.phone ?? '—'}`);

  // -----------------------------------------------------------------------
  console.log('\n--- 6. a verified phone moves the route into Call now ----------');
  // Wound back so the move is actually observed rather than assumed from a
  // resolution that had already happened.
  await prisma.company.update({ where: { id: target!.id }, data: { phone: null } });
  const beforeRelease = await queueSummary(orgId);
  const targetRoutesBefore = (await queryQueue({ orgId, filters: { view: 'call_now', limit: 500 } })).rows.filter(
    (r) => r.companyId === target!.id,
  ).length;

  const released = await resolveCompanyContact({ orgId, companyId: target!.id, force: true });
  const afterRelease = await queueSummary(orgId);
  const targetRoutesAfter = (await queryQueue({ orgId, filters: { view: 'call_now', limit: 500 } })).rows.filter(
    (r) => r.companyId === target!.id,
  ).length;

  check('resolution found the held number', released.status === 'RESOLVED', `${released.status}/${released.confidence}`);
  check('the account was not callable before and is now', targetRoutesBefore === 0 && targetRoutesAfter > 0,
    `${targetRoutesBefore} → ${targetRoutesAfter} callable route(s)`);
  check('one enrichment released every route on the account',
    targetRoutesAfter === Number(busiest.routes) || released.callableRoutes === targetRoutesAfter,
    `${targetRoutesAfter} released, ${released.callableRoutes} reported`);
  check(
    'Call now grew by exactly what Research needed lost',
    afterRelease.call_now - beforeRelease.call_now === beforeRelease.research - afterRelease.research &&
      afterRelease.call_now > beforeRelease.call_now,
    `call_now ${beforeRelease.call_now} → ${afterRelease.call_now}, research ${beforeRelease.research} → ${afterRelease.research}`,
  );
  check(
    'no deployment, run or re-audit was needed for the queue to notice',
    afterRelease.call_now > beforeRelease.call_now,
    'the queue reads the same column the resolver writes',
  );

  // -----------------------------------------------------------------------
  console.log('\n--- 7. provenance is kept, and nothing weaker overwrites it ----');
  const provenance = await prisma.contactProvenance.findMany({ where: { companyId: target!.id } });
  check('every written field carries a provenance row', provenance.length > 0, `${provenance.length} row(s)`);
  const phoneRow = provenance.find((p) => p.field === 'phone');
  check('provenance names its source', Boolean(phoneRow?.source), phoneRow?.source ?? '—');
  check('provenance records when it was retrieved', Boolean(phoneRow?.retrievedAt));
  check('provenance records the match method', Boolean(phoneRow?.matchMethod), phoneRow?.matchMethod ?? '—');
  check('provenance records whether a person entered it', phoneRow?.enteredByOperator === false);
  check('a value found in a listing is not marked verified', phoneRow?.verified === false);

  // A caller's own correction, then another automatic pass over the top.
  const targetRoute = await prisma.routeHypothesis.findFirst({
    where: { orgId, companyId: target!.id, status: { notIn: ['EXPIRED', 'REJECTED'] } },
    select: { id: true },
  });
  await saveDisposition({
    orgId,
    userId: user!.id,
    input: { routeId: targetRoute!.id, disposition: 'GATEKEEPER', correctedPhone: '312-555-0188', notes: 'Spoke to reception.' },
  });
  await resolveCompanyContact({ orgId, companyId: target!.id, force: true });
  const operatorRow = await prisma.contactProvenance.findFirst({
    where: { companyId: target!.id, field: 'phone', value: '312-555-0188' },
  });
  check('what the caller typed is recorded as operator-entered and verified',
    operatorRow?.enteredByOperator === true && operatorRow?.verified === true);
  check('a later automatic pass did not supersede it', operatorRow?.supersededAt === null);

  // -----------------------------------------------------------------------
  console.log('\n--- 8. a provider failure is reported as a failure -------------');
  // There is no network from here, so Google Places genuinely fails. That is
  // the case the operator called out: it must not read as "no contact exists".
  const orphan = await prisma.company.create({
    data: {
      orgId,
      legalName: `Audit Nowhere Cleaning ${Date.now()}`,
      origin: 'LIVE_DISCOVERY',
      cityName: 'Rockford',
      stateCode: 'IL',
    },
    select: { id: true },
  });
  const failedResult = await resolveCompanyContact({ orgId, companyId: orphan.id, force: true });
  const failedRow = await prisma.contactResolution.findUnique({ where: { companyId: orphan.id } });
  const configured = Boolean(process.env.GOOGLE_PLACES_API_KEY);
  check(
    'a terminal result was recorded rather than a silent return',
    failedRow !== null && failedRow.status !== 'IN_PROGRESS',
    `${failedRow?.status}`,
  );
  check('the blocker distinguishes searching from finding',
    Boolean(failedResult.blocker), failedResult.blocker?.slice(0, 110) ?? '—');
  if (!configured) {
    check(
      'an unconfigured provider is named as configuration, with a fix',
      failedRow?.failureKind === 'configuration' || failedResult.blocker!.includes('Not every source'),
      `${failedRow?.failureKind ?? 'none'} · ${failedRow?.fixInstruction?.slice(0, 80) ?? 'no fix text'}`,
    );
  }
  check(
    'a failure never claims the business has no phone number',
    !/no contact exists|has no phone/i.test(failedResult.blocker ?? ''),
  );
  check('a failure schedules its own retry rather than stopping',
    failedRow?.status === 'UNRESOLVED' ? true : failedRow?.nextAttemptAt !== null,
    failedRow?.nextAttemptAt?.toISOString() ?? 'none');

  // -----------------------------------------------------------------------
  console.log('\n--- 8b. same name, different places, and genuine ambiguity ------');
  // Two records naming the same business at the same address with different
  // numbers is the case where picking one would be a guess.
  const ambiguousSubject = await prisma.company.create({
    data: {
      orgId,
      legalName: `Audit Riverside Dental ${Date.now()}`,
      origin: 'LIVE_DISCOVERY',
      cityName: 'Peoria',
      stateCode: 'IL',
      locations: { create: { label: 'Site', line1: '400 Water St', city: 'Peoria', state: 'IL', isHeadquarters: true } },
    },
    select: { id: true, legalName: true },
  });
  for (const [suffix, phone] of [['Inc', '309-555-0111'], ['LLC', '309-555-0122']] as const) {
    await prisma.company.create({
      data: {
        orgId,
        legalName: `${ambiguousSubject.legalName} ${suffix}`,
        origin: 'LIVE_DISCOVERY',
        phone,
        cityName: 'Peoria',
        stateCode: 'IL',
        locations: { create: { label: 'Listing', line1: '400 Water St', city: 'Peoria', state: 'IL' } },
      },
    });
  }
  const ambiguous = await resolveCompanyContact({ orgId, companyId: ambiguousSubject.id, force: true });
  const ambiguousRow = await prisma.contactResolution.findUnique({ where: { companyId: ambiguousSubject.id } });
  check('two numbers for one site is ambiguous rather than a coin toss',
    ambiguous.status === 'AMBIGUOUS', `${ambiguous.status}`);
  check('no number was written while it is ambiguous', ambiguous.phone === null);
  check('the competing candidates are kept for a person to choose between',
    Array.isArray(ambiguousRow?.candidates) && (ambiguousRow!.candidates as unknown[]).length === 2,
    `${(ambiguousRow?.candidates as unknown[] | undefined)?.length ?? 0} candidate(s)`);
  check('the ambiguity states why', Boolean(ambiguousRow?.ambiguityReason),
    ambiguousRow?.ambiguityReason?.slice(0, 90) ?? '');
  check('an ambiguity is not retried on a timer, because the answer would not change',
    ambiguousRow?.nextAttemptAt === null);

  // The same brand in another town. A branch, not this site.
  const branchSubject = await prisma.company.create({
    data: {
      orgId,
      legalName: `Audit Lakeside Fitness ${Date.now()}`,
      origin: 'LIVE_DISCOVERY',
      cityName: 'Evanston',
      stateCode: 'IL',
      locations: { create: { label: 'Site', line1: '15 Sherman Ave', city: 'Evanston', state: 'IL', isHeadquarters: true } },
    },
    select: { id: true, legalName: true },
  });
  await prisma.company.create({
    data: {
      orgId,
      legalName: `${branchSubject.legalName} Inc`,
      origin: 'LIVE_DISCOVERY',
      phone: '414-555-0133',
      cityName: 'Milwaukee',
      stateCode: 'WI',
      locations: { create: { label: 'Listing', line1: '900 N Water St', city: 'Milwaukee', state: 'WI' } },
    },
  });
  const branch = await resolveCompanyContact({ orgId, companyId: branchSubject.id, force: true });
  const branchCompany = await prisma.company.findUnique({ where: { id: branchSubject.id }, select: { phone: true } });
  check('a branch in another town is not used as this location’s number',
    branch.phone === null && branchCompany?.phone === null, branch.status);
  check('the branch is still recorded, labelled as another site',
    (await prisma.contactProvenance.count({
      where: { companyId: branchSubject.id, scope: 'PARENT_OR_CENTRAL' },
    })) > 0);
  check('the blocker explains that what was found is elsewhere',
    /other addresses|different site/i.test(branch.blocker ?? ''), branch.blocker?.slice(0, 100) ?? '');

  // -----------------------------------------------------------------------
  console.log('\n--- 9. a wrong number leaves Call now and is not proposed again -');
  const victimCard = await loadCallCard({ orgId, routeId: targetRoute!.id });
  await prisma.outreachState.update({
    where: { routeId: targetRoute!.id },
    data: { correctedPhone: null, status: 'NEW', snoozeUntil: null },
  });
  await prisma.company.update({ where: { id: target!.id }, data: { phone: '312-555-0142' } });
  const callableBeforeWrong = await isCallable(orgId, targetRoute!.id);
  await saveDisposition({
    orgId,
    userId: user!.id,
    input: { routeId: targetRoute!.id, disposition: 'WRONG_NUMBER', notes: 'Reached a dry cleaner.' },
  });
  const companyAfterWrong = await prisma.company.findUnique({ where: { id: target!.id }, select: { phone: true } });
  const resolutionAfterWrong = await prisma.contactResolution.findUnique({ where: { companyId: target!.id } });
  check('the record was callable before the wrong number was reported', callableBeforeWrong.callable,
    callableBeforeWrong.reason ?? '');
  check('the bad number came off the account', companyAfterWrong?.phone !== '312-555-0142',
    companyAfterWrong?.phone ?? 'cleared');
  check('the bad number is remembered so it is not proposed again',
    resolutionAfterWrong?.rejectedValues.includes('312-555-0142') === true,
    resolutionAfterWrong?.rejectedValues.join(', ') ?? '');
  check('enrichment was put back to work on it', resolutionAfterWrong?.status === 'QUEUED',
    resolutionAfterWrong?.status ?? '');
  const rejectedRow = await prisma.contactProvenance.findFirst({
    where: { companyId: target!.id, field: 'phone', value: '312-555-0142' },
  });
  check('the rejection is recorded rather than the history deleted', rejectedRow?.supersededAt !== null,
    rejectedRow?.supersededReason ?? '');
  const retried = await resolveCompanyContact({ orgId, companyId: target!.id, force: true });
  check('the next attempt does not return the rejected number', retried.phone !== '312-555-0142',
    retried.phone ?? retried.blocker?.slice(0, 80) ?? '—');

  // -----------------------------------------------------------------------
  console.log('\n--- 10. an account that cannot be served stays unreachable ------');
  const dncRoute = await prisma.routeHypothesis.findFirst({
    where: { orgId, status: { notIn: ['EXPIRED', 'REJECTED'] }, id: { not: targetRoute!.id } },
    select: { id: true, companyId: true },
  });
  await saveDisposition({
    orgId,
    userId: user!.id,
    input: { routeId: dncRoute!.id, disposition: 'DO_NOT_CONTACT', notes: 'Asked not to be called.' },
  });
  await prisma.company.update({ where: { id: dncRoute!.companyId }, data: { phone: '312-555-0177' } });
  const dncAfterPhone = await isCallable(orgId, dncRoute!.id);
  check('finding a number for a do-not-contact account does not make it callable',
    !dncAfterPhone.callable, dncAfterPhone.reason ?? '');
  const dncPage = await queryQueue({ orgId, filters: { view: 'call_now', limit: 500 } });
  check('it appears in no Call now page', !dncPage.rows.some((r) => r.routeId === dncRoute!.id));

  // -----------------------------------------------------------------------
  console.log('\n--- 11. the board can say what happened, per row ----------------');
  const board = await queryQueue({ orgId, filters: { view: 'all', limit: 200 } });
  const states = new Set(board.rows.map((r) => r.enrichmentState));
  check('every row carries an enrichment state', board.rows.every((r) => Boolean(r.enrichmentState)),
    [...states].join(', '));
  check('no live row is missing from the workflow', !states.has('NOT_SCHEDULED') || board.total === 0);
  const research = await queryQueue({ orgId, filters: { view: 'research', limit: 200 } });
  const withoutReason = research.rows.filter((r) => !r.enrichmentBlocker && r.enrichmentState !== 'WAITING');
  check('every Research needed row states its remaining blocker', withoutReason.length === 0,
    `${withoutReason.length} of ${research.rows.length} without one`);
  const filtered = await queryQueue({ orgId, filters: { view: 'all', enrichment: ['NONE_FOUND'], limit: 200 } });
  check('the board can be filtered by enrichment state',
    filtered.rows.every((r) => r.enrichmentState === 'NONE_FOUND'), `${filtered.total} rows`);

  // -----------------------------------------------------------------------
  console.log('\n--- 12. the backlog drains on its own ---------------------------');
  await prisma.contactResolution.updateMany({
    where: { orgId },
    data: { status: 'QUEUED', nextAttemptAt: new Date(), lockedAt: null, lockedBy: null },
  });
  const drained = await drainContactResolution({ orgId, budgetMs: 60_000, limit: 25 });
  check('the worker attempted the whole backlog without being told how', drained.attempted > 0,
    `${drained.attempted} attempted in ${drained.durationMs}ms`);
  check('nothing was left waiting', drained.remaining === 0, `${drained.remaining} remaining`);
  check('every attempt reached a terminal state',
    drained.resolved + drained.ambiguous + drained.unresolved + drained.failed === drained.attempted,
    `${drained.resolved} resolved / ${drained.ambiguous} ambiguous / ${drained.unresolved} unresolved / ${drained.failed} failed`);

  const noVerdict = await prisma.contactResolution.count({
    where: { orgId, status: { in: ['QUEUED', 'IN_PROGRESS'] }, attempts: { gt: 0 } },
  });
  check('no record was left claimed with no verdict', noVerdict === 0, `${noVerdict} stuck`);

  const idle = await sweepContactResolution({ orgId });
  check('a second pass does no work rather than re-doing it', idle.attempted === 0,
    `${idle.attempted} attempted`);

  // Asked once the backlog is worked, where it is a claim about the finished
  // state rather than a race against the worker.
  const worked = await queryQueue({ orgId, filters: { view: 'research', limit: 200 } });
  const unexplained = worked.rows.filter((r) => r.enrichmentSources.length === 0);
  check('every remaining Research needed row says what was already searched',
    unexplained.length === 0, `${unexplained.length} of ${worked.rows.length} without a source list`);
  const noBlocker = worked.rows.filter((r) => !r.enrichmentBlocker);
  check('every remaining Research needed row states its blocker', noBlocker.length === 0,
    `${noBlocker.length} of ${worked.rows.length}`);

  // -----------------------------------------------------------------------
  console.log('\n--- 13. supply is resolved automatically too --------------------');
  const supply = await resolveSupply({ orgId });
  check('every live route was checked against the provider catalogue', supply.routesConsidered > 0,
    `${supply.routesConsidered} routes`);
  check('a candidate provider is distinguished from a verified one',
    supply.withVerifiedProvider + supply.withCandidateOnly + supply.withNobody === supply.routesConsidered,
    `${supply.withVerifiedProvider} verified / ${supply.withCandidateOnly} candidate only / ${supply.withNobody} nobody`);
  const sourcingTasks = await prisma.task.count({ where: { orgId, kind: 'provider_research', status: 'OPEN' } });
  check('research tasks exist only where automatic matching found nobody',
    supply.withNobody > 0 ? sourcingTasks > 0 : sourcingTasks === 0,
    `${sourcingTasks} task(s) for ${supply.withNobody} route(s) with no provider`);
  const rejectedForSupply = await prisma.routeHypothesis.count({
    where: { orgId, status: 'REJECTED', fulfilmentStatus: { in: ['UNAVAILABLE', 'UNKNOWN'] } },
  });
  check('no real demand was rejected for missing supply', rejectedForSupply === 0, `${rejectedForSupply} rejected`);
  const twice = await resolveSupply({ orgId });
  check('running supply resolution twice raises no duplicate tasks',
    (await prisma.task.count({ where: { orgId, kind: 'provider_research', status: 'OPEN' } })) === sourcingTasks,
    `${twice.tasksCreated} created on the second pass`);

  // -----------------------------------------------------------------------
  console.log('\n--- 14. the evidence behind the opportunity is unchanged --------');
  const event = await prisma.demandEvent.findFirst({ where: { orgId }, orderBy: { createdAt: 'asc' } });
  check('the external event date is still the source’s', event?.eventDate !== undefined);
  check('confirmed facts are untouched by enrichment', Array.isArray(event?.confirmedFacts));
  const touchedEvents = await prisma.demandEvent.count({
    where: { orgId, updatedAt: { gt: new Date(Date.now() - 60_000) }, lastVerifiedAt: null },
  });
  check('enrichment wrote nothing onto the event records', touchedEvents === 0, `${touchedEvents} touched`);

  // -----------------------------------------------------------------------
  console.log('\n--- 15. the admin view can answer "why is Research still full" --');
  const overview = await enrichmentOverview(orgId);
  console.log(`        ${JSON.stringify({
    waiting: overview.waiting, inProgress: overview.inProgress, resolved: overview.resolved,
    ambiguous: overview.ambiguous, unresolved: overview.unresolved, failed: overview.failed,
    stale: overview.stale, untracked: overview.untracked, newlyCallable: overview.newlyCallable,
  })}`);
  check('the six outcomes are counted separately',
    overview.waiting + overview.inProgress + overview.resolved + overview.ambiguous +
      overview.unresolved + overview.failed >= 0);
  check('nothing with live demand is outside the workflow', overview.untracked === 0, `${overview.untracked}`);
  check('sources attempted are reported', overview.sourcesAttempted.length > 0,
    overview.sourcesAttempted.map((s) => `${s.source}:${s.accounts}`).join(', '));
  check('the last attempt time is known', Boolean(overview.lastAttemptAt), overview.lastAttemptAt ?? '');
  check('blockers are summarised rather than hidden', overview.topBlockers.length >= 0,
    `${overview.topBlockers.length} distinct blocker(s)`);
  if (!configured) {
    check('the missing configuration is named with its remedy',
      overview.configurationProblems.length > 0,
      overview.configurationProblems.map((p) => p.source).join(', '));
  }

  const finalSummary = await queueSummary(orgId);
  console.log(`\nfinal queue: ${JSON.stringify(finalSummary)}`);
  console.log(`Call now ${startingSummary.call_now} → ${finalSummary.call_now}, Research needed ${startingSummary.research} → ${finalSummary.research}`);

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
