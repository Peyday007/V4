/**
 * A source that produces nothing has to say why — against a real database.
 *
 * The unit tests prove the sentence is built correctly from a funnel. This
 * proves the funnel survives the round trip: that a run persists it, that a
 * later reader gets it back, and — the part that actually caught a bug — that
 * the health view reads the reason from the last *attempt* rather than the last
 * success. A source failing every four hours still has a recent success from a
 * fortnight ago, and showing that success's reason next to a board that has
 * been empty ever since is worse than showing nothing.
 *
 * The transport is stubbed. That substitution is what is being tested here: the
 * four shapes an upstream can take — blocked, empty, republished, working — put
 * through the real run, the real persistence and the real health query. Whether
 * data.cityofchicago.org returns those shapes today is what
 * scripts/connectorProbe.ts answers, from a machine that can reach it.
 *
 *   npx tsx scripts/sourceExplainAudit.ts
 */

import { prisma } from '@/lib/db';
import { setTransport } from '@/lib/discovery/http';
import { runDemandSource, demandSourceHealth } from '@/lib/demand/run';

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

/** Answers every request with one canned outcome. */
function stub(outcome: { status: number; body: unknown } | 'throw') {
  setTransport(async () => {
    if (outcome === 'throw') throw new Error('getaddrinfo ENOTFOUND data.cityofchicago.org');
    return new Response(JSON.stringify(outcome.body), {
      status: outcome.status,
      headers: { 'content-type': 'application/json' },
    });
  });
}

const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 19);

/** A well-formed Chicago licence row, as the connector expects one. */
const GOOD_ROW = {
  legal_name: 'Ironside Strength LLC',
  doing_business_as_name: 'Ironside Strength',
  address: '2244 W Belmont Ave',
  city: 'Chicago',
  zip_code: '60618',
  license_description: 'Limited Business License',
  license_number: 'LIC-EXPLAIN-1',
  license_status: 'AAI',
  license_start_date: iso(-3),
};

/**
 * The same dataset after a republish that renamed the date column.
 *
 * This is the failure the whole feature exists for. Every field the connector
 * needs is still there except one, every row is silently discarded, and the run
 * records a flawless `status: OK` with zero events.
 */
const REPUBLISHED_ROW = (() => {
  const { license_start_date, ...rest } = GOOD_ROW;
  return { ...rest, license_term_start_date: license_start_date, license_number: 'LIC-EXPLAIN-2' };
})();

async function lastRun(orgId: string, connector: string) {
  return prisma.sourceRun.findFirstOrThrow({
    where: { orgId, connector },
    orderBy: { startedAt: 'desc' },
  });
}

/**
 * This audit drives the real ingest, so it creates real demand events under a
 * real connector name. That is the point — a stubbed persistence layer would
 * prove nothing — and it is also exactly how 54 fixture routes ended up in the
 * production portfolio wearing a connector called `audit_fixture`. A script
 * that writes through the production path has no business being pointed at the
 * production database, and the cheapest way to guarantee that is to refuse.
 */
function refuseUnlessLocal() {
  const url = process.env.DATABASE_URL ?? '';
  const host = /@([^/:]+)/.exec(url)?.[1] ?? '';
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    console.error(
      `This audit writes demand events through the production path and will only run against a local\n`
      + `database. DATABASE_URL points at "${host || 'an unparseable host'}".`,
    );
    process.exit(1);
  }
}

async function main() {
  refuseUnlessLocal();
  const org = await prisma.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  const connector = 'municipal_open_data';

  console.log('='.repeat(72));
  console.log('SOURCE EXPLANATION AUDIT — a zero-result run states its own reason');
  console.log('='.repeat(72));

  // -- 1. blocked -----------------------------------------------------------
  console.log('\n--- the client is blocked before it reaches the dataset ---------');
  stub({ status: 403, body: { message: 'Forbidden' } });
  const blocked = await runDemandSource({ orgId: org.id, connectorKey: connector, maxRecords: 20 });
  const blockedRow = await lastRun(org.id, connector);

  check('the run is recorded as FAILED, not as a quiet week', blockedRow.status === 'FAILED', blockedRow.status);
  check('a reason is persisted', Boolean(blockedRow.outcomeReason), String(blockedRow.outcomeReason));
  check(
    'the reason says the emptiness proves nothing about the source',
    /says nothing about the source/.test(blockedRow.outcomeReason ?? ''),
    blockedRow.outcomeReason ?? '(none)',
  );
  check(
    'the reason carries the status the host returned',
    /403/.test(blockedRow.outcomeReason ?? ''),
    blockedRow.outcomeReason ?? '(none)',
  );
  check('the returned summary carries the same reason', blocked.outcomeReason === blockedRow.outcomeReason);

  // -- 2. reachable and empty ----------------------------------------------
  console.log('\n--- the portal answers, and matches nothing ---------------------');
  stub({ status: 200, body: [] });
  await runDemandSource({ orgId: org.id, connectorKey: connector, maxRecords: 20 });
  const emptyRow = await lastRun(org.id, connector);

  check('the run succeeds', emptyRow.status === 'OK', emptyRow.status);
  check('nothing was examined', emptyRow.recordsExamined === 0);
  check(
    'the reason says no records were returned at all',
    /No records were returned at all/.test(emptyRow.outcomeReason ?? ''),
    emptyRow.outcomeReason ?? '(none)',
  );
  check(
    'and names the query, so it can be pasted into a browser',
    /https:\/\/data\.cityofchicago\.org\/resource\//.test(emptyRow.outcomeReason ?? ''),
    (emptyRow.outcomeReason ?? '').slice(0, 200),
  );

  // -- 3. republished -------------------------------------------------------
  console.log('\n--- the dataset was republished under a new column name ---------');
  stub({ status: 200, body: [REPUBLISHED_ROW, REPUBLISHED_ROW, REPUBLISHED_ROW] });
  await runDemandSource({ orgId: org.id, connectorKey: connector, maxRecords: 20 });
  const republished = await lastRun(org.id, connector);

  check('the run still succeeds — which is exactly the trap', republished.status === 'OK');
  check('rows were examined', republished.recordsExamined > 0, String(republished.recordsExamined));
  check('and no event was created', republished.eventsCreated === 0);
  check(
    'the reason refuses to call it a quiet week',
    /not a quiet week/.test(republished.outcomeReason ?? ''),
    republished.outcomeReason ?? '(none)',
  );
  check(
    'the reason names the column that stopped it',
    /license_start_date/.test(republished.outcomeReason ?? ''),
    republished.outcomeReason ?? '(none)',
  );
  check(
    'and shows the columns the portal did return, which identifies the republish',
    /license_term_start_date/.test(republished.outcomeReason ?? ''),
    (republished.outcomeReason ?? '').slice(0, 300),
  );

  const funnel = (republished.details as { funnel?: unknown[] } | null)?.funnel;
  check('the per-scope funnel is persisted alongside it', Array.isArray(funnel) && funnel.length > 0);
  const first = Array.isArray(funnel) ? (funnel[0] as Record<string, unknown>) : {};
  check('each scope records what it fetched and what it kept', first.fetched === 3 && first.accepted === 0,
    JSON.stringify(first).slice(0, 200));
  check('each scope carries the exact URL it requested', typeof first.url === 'string' && String(first.url).includes('r5kz-chrr'));

  // -- 4. the health view reads the last attempt ----------------------------
  console.log('\n--- health reports the last attempt, not the last good day ------');
  // The stub answers every configured jurisdiction with the same Chicago row,
  // so two of the five (the ones whose columns happen to match) produce events
  // and three discard it. That is a fair picture of a partly-working source,
  // and it is the case where the per-dataset breakdown earns its keep.
  stub({ status: 200, body: [GOOD_ROW] });
  const working = await runDemandSource({ orgId: org.id, connectorKey: connector, maxRecords: 20 });
  check(
    'a working run says how many events it produced',
    /Produced \d+ event\(s\)/.test(working.outcomeReason),
    working.outcomeReason.slice(0, 160),
  );
  check(
    'and still names the datasets that produced nothing, rather than resting on the ones that did',
    /San Francisco.*all discarded/.test(working.outcomeReason),
    working.outcomeReason.slice(0, 240),
  );
  check(
    'naming, per dataset, the column it went looking for',
    /location_start_date/.test(working.outcomeReason) && /issued_date/.test(working.outcomeReason),
    working.outcomeReason.slice(0, 240),
  );

  // Now break it again, and make sure health shows the breakage.
  stub({ status: 403, body: { message: 'Forbidden' } });
  await runDemandSource({ orgId: org.id, connectorKey: connector, maxRecords: 20 });

  const health = await demandSourceHealth(org.id);
  const entry = health.find((h) => h.connector === connector);
  check('the source appears in the health view', Boolean(entry));
  check(
    'and its reason is the failing attempt, not the earlier success',
    /says nothing about the source/.test(entry?.outcomeReason ?? ''),
    entry?.outcomeReason ?? '(none)',
  );
  check('a last success is still reported separately', Boolean(entry?.lastSuccessAt));

  // -- 5. every registered connector can explain itself ---------------------
  console.log('\n--- every source has something to say --------------------------');
  for (const source of health) {
    check(
      `${source.connector} reports where its records went`,
      Boolean(source.outcomeReason && source.outcomeReason.length > 20),
      source.outcomeReason ?? '(none)',
    );
  }

  // -- clean up after itself ------------------------------------------------
  // The events this created are indistinguishable from real ones by design, so
  // leaving them behind would put three fictional Chicago gyms in the local
  // portfolio and quietly teach the source scorecards that this connector
  // works.
  // Matched on the fictional business rather than the source identifier: a
  // dataset with no natural-key column falls through to a derived key, so the
  // rows this audit created do not all share a prefix. The name does.
  const litter = await prisma.demandEvent.findMany({
    where: {
      orgId: org.id,
      OR: [
        { sourceRecordId: { startsWith: 'LIC-EXPLAIN-' } },
        { headline: { contains: 'Ironside Strength' } },
      ],
    },
    select: { id: true },
  });
  if (litter.length > 0) {
    const ids = litter.map((e) => e.id);
    await prisma.routeHypothesis.deleteMany({ where: { eventId: { in: ids } } });
    await prisma.demandEvent.deleteMany({ where: { id: { in: ids } } });
  }
  console.log(`\nCleaned up ${litter.length} event(s) this audit created.`);

  console.log(`\n${'='.repeat(72)}`);
  console.log(`${passed}/${passed + failed} checks passed.`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .then(async () => {
    setTransport(null);
    await prisma.$disconnect();
    process.exit(process.exitCode ?? 0);
  })
  .catch(async (e) => {
    console.error(e);
    setTransport(null);
    await prisma.$disconnect();
    process.exit(1);
  });
