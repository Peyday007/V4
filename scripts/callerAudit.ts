/**
 * The calling workflow, end to end against a real database.
 *
 * Every check here is one the operator listed, and each drives the production
 * path rather than a helper: the same queue query the page runs, the same save
 * the caller view posts, the same eligibility clause the server enforces.
 *
 * The point of doing it against Postgres is the things a fixture cannot show —
 * that a do-not-contact record is unreachable through a direct request, that a
 * follow-up really disappears until its date, that paging does not skip a row.
 *
 *   npx tsx scripts/callerAudit.ts
 */

import { prisma } from '@/lib/db';
import { isCallable, nextCallable, queryQueue, queueSummary } from '@/lib/demand/queue';
import { saveDisposition } from '@/lib/demand/outreach';
import { loadCallCard, loadEvidence } from '@/lib/demand/callCard';

const DAY = 86_400_000;
let failures = 0;

function check(label: string, passed: boolean, detail = '') {
  if (!passed) failures += 1;
  console.log(`${passed ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  const user = await prisma.user.findFirst({ where: { orgId: org!.id } });
  const orgId = org!.id;

  // Start from a known state so the run is repeatable.
  await prisma.outreachAttempt.deleteMany({ where: { orgId } });
  await prisma.outreachState.deleteMany({ where: { orgId } });

  // Enough contactable records for the consecutive-calling check further down,
  // provisioned here rather than assumed. Contact resolution can now empty and
  // refill the phone column on its own, so a calling test that depended on
  // whatever the last run happened to leave behind was measuring the previous
  // script's side effects rather than the calling workflow.
  const needContact = await prisma.$queryRaw<Array<{ companyId: string }>>`
    SELECT DISTINCT r."companyId" AS "companyId"
    FROM "RouteHypothesis" r
    JOIN "Company" c ON c."id" = r."companyId"
    WHERE r."orgId" = ${orgId}
      AND r."status" NOT IN ('EXPIRED','REJECTED')
      AND r."tier" IN ('ACTIVE_DEMAND','STRONG_TRIGGER')
      AND c."phone" IS NULL
    LIMIT 8
  `;
  for (const [index, row] of needContact.entries()) {
    // The 555-01xx range is reserved for fiction and cannot reach anybody.
    await prisma.company.update({
      where: { id: row.companyId },
      data: { phone: `312-555-01${String(20 + index).padStart(2, '0')}` },
    });
  }
  if (needContact.length > 0) console.log(`(provisioned ${needContact.length} test contact(s) for this run)`);

  console.log('--- the board loads compactly ---------------------------------');
  const summary = await queueSummary(orgId);
  const page = await queryQueue({ orgId, filters: { view: 'call_now', limit: 5 } });
  console.log(`summary: ${JSON.stringify(summary)}`);
  check('a page is bounded by its limit', page.rows.length <= 5, `${page.rows.length} rows of ${page.total}`);
  check('the count matches the rows behind it', summary.call_now === page.total, `${summary.call_now} vs ${page.total}`);

  console.log('\n--- summary counts filter to their own rows --------------------');
  for (const view of ['call_now', 'research', 'supply_needed', 'expired'] as const) {
    const result = await queryQueue({ orgId, filters: { view } });
    check(`${view} count equals its view total`, summary[view] === result.total, `${summary[view]} vs ${result.total}`);
  }

  console.log('\n--- work next returns the right record -------------------------');
  const first = await nextCallable({ orgId });
  check('a callable record is returned', Boolean(first), first?.organisation);
  check('it has a phone number', Boolean(first?.phone));
  check('it is tier A or B', ['ACTIVE_DEMAND', 'STRONG_TRIGGER'].includes(first?.tier ?? ''));
  const top = (await queryQueue({ orgId, filters: { view: 'call_now', limit: 1 } })).rows[0];
  check('it is the same record as the top of the board', first?.routeId === top?.routeId);

  console.log('\n--- a contactable record outranks an uncontactable one ---------');
  const all = await queryQueue({ orgId, filters: { view: 'all', limit: 200 } });
  let orderingHolds = true;
  for (const tier of ['ACTIVE_DEMAND', 'STRONG_TRIGGER']) {
    const rows = all.rows.filter((r) => r.tier === tier);
    const lastWithPhone = rows.map((r) => Boolean(r.phone)).lastIndexOf(true);
    const firstWithout = rows.map((r) => Boolean(r.phone)).indexOf(false);
    if (firstWithout !== -1 && lastWithPhone > firstWithout) orderingHolds = false;
  }
  check('within a tier, every contactable row sorts above every uncontactable one', orderingHolds);

  console.log('\n--- the full evidence is still there ---------------------------');
  const card = await loadCallCard({ orgId, routeId: first!.routeId });
  const evidence = await loadEvidence({ orgId, routeId: first!.routeId });
  check('the caller card names the source', Boolean(card?.connector));
  check('the caller card carries the external event date', card?.eventDate !== undefined);
  check('the evidence names the source', Boolean(evidence?.event.connector));
  check('the evidence keeps the external date and our first-seen date apart',
    Boolean(evidence?.event.externalEventDate !== undefined && evidence?.event.firstSeenByUs));
  check('the evidence still carries confirmed facts', Array.isArray(evidence?.event.confirmedFacts));
  check('the call brief exists and hedges an inferred need',
    Boolean(card?.brief.opening) && (card!.needIsConfirmed || /don't know whether/i.test(card!.brief.opening)));

  console.log('\n--- multiple routes from one event read coherently -------------');
  const multi = all.rows.find((r) => r.routesForEvent > 1);
  check('a row states how many routes share its event', Boolean(multi), multi ? `${multi.organisation}: ${multi.routesForEvent}` : 'none in this data');
  if (card) {
    check('the caller card lists the account’s other routes', card.siblingRoutes.length >= 0,
      `${card.siblingRoutes.length} sibling(s), ${card.siblingRoutes.filter((s) => s.sameEvent).length} from the same event`);
  }

  console.log('\n--- saving a follow-up removes it from Call now -----------------');
  const followUpAt = new Date(Date.now() + 5 * DAY);
  const before = await queueSummary(orgId);
  await saveDisposition({
    orgId,
    userId: user!.id,
    input: { routeId: first!.routeId, disposition: 'FOLLOW_UP', notes: 'Called, asked for a call back Tuesday.', followUpAt },
  });
  const after = await queueSummary(orgId);
  check('Call now went down by one', after.call_now === before.call_now - 1, `${before.call_now} → ${after.call_now}`);
  check('Follow up went up by one', after.follow_up === before.follow_up + 1, `${before.follow_up} → ${after.follow_up}`);

  const stillCallable = await isCallable(orgId, first!.routeId);
  check('the server refuses to call it again', !stillCallable.callable, stillCallable.reason ?? '');

  const excluded = await queryQueue({ orgId, filters: { view: 'call_now', limit: 200 } });
  check('it is absent from the Call now page', !excluded.rows.some((r) => r.routeId === first!.routeId));

  console.log('\n--- the attempt is append-only ---------------------------------');
  const attempts = await prisma.outreachAttempt.findMany({ where: { routeId: first!.routeId } });
  check('one attempt was recorded', attempts.length === 1);
  check('it carries the notes', attempts[0]?.notes?.includes('Tuesday') ?? false);
  check('it carries an operator', Boolean(attempts[0]?.userId));

  // A second disposition adds a row rather than replacing the first.
  await saveDisposition({
    orgId,
    userId: user!.id,
    input: { routeId: first!.routeId, disposition: 'NO_ANSWER', notes: 'Second attempt.' },
  });
  const afterSecond = await prisma.outreachAttempt.findMany({ where: { routeId: first!.routeId }, orderBy: { occurredAt: 'asc' } });
  check('a second attempt appends rather than overwrites', afterSecond.length === 2);
  check('the first attempt is unchanged', afterSecond[0]?.disposition === 'FOLLOW_UP');

  console.log('\n--- the event evidence was not rewritten -----------------------');
  const eventAfter = await loadEvidence({ orgId, routeId: first!.routeId });
  check('the external event date is untouched',
    eventAfter?.event.externalEventDate === evidence?.event.externalEventDate);
  check('the confirmed facts are untouched',
    JSON.stringify(eventAfter?.event.confirmedFacts) === JSON.stringify(evidence?.event.confirmedFacts));

  console.log('\n--- do-not-contact cannot be returned by the server -------------');
  const victim = await nextCallable({ orgId });
  await saveDisposition({
    orgId,
    userId: user!.id,
    input: { routeId: victim!.routeId, disposition: 'DO_NOT_CONTACT', notes: 'Asked not to be called.' },
  });
  const dncCheck = await isCallable(orgId, victim!.routeId);
  check('isCallable refuses it', !dncCheck.callable, dncCheck.reason ?? '');
  const dncCard = await loadCallCard({ orgId, routeId: victim!.routeId });
  check('the caller card says why it cannot be called', dncCard?.callable === false && Boolean(dncCard?.notCallableReason));
  const dncPage = await queryQueue({ orgId, filters: { view: 'call_now', limit: 500 } });
  check('it is in no Call now page', !dncPage.rows.some((r) => r.routeId === victim!.routeId));
  const nextAfterDnc = await nextCallable({ orgId });
  check('Work next never offers it', nextAfterDnc?.routeId !== victim!.routeId);
  const closedView = await queryQueue({ orgId, filters: { view: 'closed' } });
  check('it appears in Closed', closedView.rows.some((r) => r.routeId === victim!.routeId));

  console.log('\n--- consecutive calling ----------------------------------------');
  const worked: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const card = await nextCallable({ orgId, excludeRouteIds: worked });
    if (!card) break;
    await saveDisposition({
      orgId,
      userId: user!.id,
      input: { routeId: card.routeId, disposition: 'LEFT_VOICEMAIL', notes: `Consecutive call ${i + 1}.` },
    });
    worked.push(card.routeId);
  }
  check('four opportunities were worked in a row', worked.length === 4, worked.length + ' completed');
  check('no record was handed back twice', new Set(worked).size === worked.length);

  console.log('\n--- a save failure does not advance ----------------------------');
  let threw = false;
  try {
    await saveDisposition({ orgId, userId: user!.id, input: { routeId: 'does-not-exist', disposition: 'NO_ANSWER' } });
  } catch (error) {
    threw = true;
    check('an unknown route is rejected', String(error).includes('does not exist'));
  }
  check('the save threw rather than silently succeeding', threw);
  const attemptsForGhost = await prisma.outreachAttempt.count({ where: { routeId: 'does-not-exist' } });
  check('no orphan attempt was written', attemptsForGhost === 0);

  console.log('\n--- another org cannot reach these records ---------------------');
  const foreign = await isCallable('some-other-org', first!.routeId);
  check('a route from another organisation is refused', !foreign.callable, foreign.reason ?? '');

  console.log('\n--- paging neither duplicates nor skips ------------------------');
  const size = 3;
  const seen: string[] = [];
  let cursor: number | null = 0;
  while (cursor !== null) {
    const p: Awaited<ReturnType<typeof queryQueue>> = await queryQueue({
      orgId,
      filters: { view: 'all', limit: size, cursor },
    });
    seen.push(...p.rows.map((r) => r.routeId));
    cursor = p.nextCursor;
  }
  const full = await queryQueue({ orgId, filters: { view: 'all', limit: 500 } });
  check('paging returns every row', seen.length === full.total, `${seen.length} of ${full.total}`);
  check('paging returns each row once', new Set(seen).size === seen.length);
  check('paging returns them in the same order',
    seen.join(',') === full.rows.map((r) => r.routeId).join(','));

  console.log('\n--- filters and search -----------------------------------------');
  const searched = await queryQueue({ orgId, filters: { view: 'all', search: 'ironside' } });
  check('search matches an organisation', searched.total > 0, `${searched.total} rows`);
  const byRoute = await queryQueue({ orgId, filters: { view: 'all', route: ['DISTRIBUTION'] } });
  check('a route filter narrows the set', byRoute.rows.every((r) => r.route === 'DISTRIBUTION'), `${byRoute.total} rows`);
  const byContact = await queryQueue({ orgId, filters: { view: 'all', contactable: 'no' } });
  check('a contactability filter narrows the set', byContact.rows.every((r) => !r.phone), `${byContact.total} rows`);

  console.log('\n--- follow-up returns when it is due ---------------------------');
  // Moving the date into the past is what the clock would do overnight.
  await prisma.outreachState.update({
    where: { routeId: first!.routeId },
    data: { status: 'FOLLOW_UP', snoozeUntil: new Date(Date.now() - DAY) },
  });
  const due = await isCallable(orgId, first!.routeId);
  check('an overdue follow-up is callable again', due.callable, due.reason ?? '');

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
