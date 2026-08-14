#!/usr/bin/env node
/**
 * Did the deployment actually collect demand from the real world?
 *
 * The connector probe answers a different and smaller question: whether the
 * portals return what the connectors expect, asked from a machine that can
 * reach them. It writes nothing and touches no database. Passing it is not
 * evidence that production has ingested anything, and reporting it as though
 * it were is exactly the substitution this script exists to stop.
 *
 * This drives the deployed application through its own recurring path — the
 * same `runAllDemandSources` the worker calls — against the production
 * database, and then reads back what is actually there. It reports, per source:
 * rows examined, events accepted, rejected, persisted, organisations created or
 * matched, routes created, the evidence URL and external date of each event
 * that landed, and for every source still at zero, the exact reason.
 *
 * It creates no fixtures. If production ends at zero, that is the answer.
 *
 *   BASE_URL=https://… OWNER_EMAIL=… OWNER_PASSWORD=… node scripts/productionDemandCheck.mjs
 */

const BASE = (process.env.BASE_URL ?? '').replace(/\/$/, '');
const OWNER_EMAIL = process.env.OWNER_EMAIL ?? 'owner@dealdispatch.test';
const OWNER_PASSWORD = process.env.OWNER_PASSWORD ?? '';
const CRON_SECRET = process.env.CRON_SECRET ?? '';
const EXPECT_COMMIT = (process.env.EXPECT_COMMIT ?? '').trim();

if (!BASE.startsWith('https://')) {
  console.error('BASE_URL must be an https:// deployment URL.');
  process.exit(1);
}

let cookie = '';
let failures = 0;

function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
}

async function call(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    redirect: 'manual',
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: response.status, body, text };
}

const line = (n = 76) => '='.repeat(n);

async function main() {
  console.log(line());
  console.log('PRODUCTION DEMAND — did the deployment collect anything real?');
  console.log(line());
  console.log(`\nDeployment: ${BASE}`);
  console.log(`Run at:     ${new Date().toISOString()}\n`);

  // --- 1. which build is answering ----------------------------------------
  console.log('--- build identity ---------------------------------------------');
  if (CRON_SECRET) {
    const tick = await call('/api/cron/tick', {
      method: 'POST',
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
    const build = tick.body?.build ?? null;
    check('the deployment answers the tick', tick.status === 200, `HTTP ${tick.status}`);
    if (build) {
      console.log(`        commit ${build.commit ?? '(unknown)'}  branch ${build.branch ?? '(unknown)'}  env ${build.environment ?? '(unknown)'}`);
      if (EXPECT_COMMIT) {
        check(
          `the deployed build is ${EXPECT_COMMIT}`,
          String(build.commit ?? '').startsWith(EXPECT_COMMIT),
          `deployed ${build.commit}`,
        );
      }
    } else {
      check('the tick reports a build identity', false, 'no build block in the response');
    }
  } else {
    console.log('        CRON_SECRET not set; build identity not read.');
  }

  // --- 2. sign in ----------------------------------------------------------
  console.log('\n--- signing in as the owner ------------------------------------');
  const login = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
  });
  check('the owner signs in', login.status === 200, `HTTP ${login.status} ${login.text.slice(0, 120)}`);
  if (login.status !== 200) {
    console.log('\nCannot continue without a session.');
    process.exit(1);
  }

  // --- 3. the baseline before anything runs --------------------------------
  console.log('\n--- production baseline, before the run ------------------------');
  const before = await call('/api/demand/diagnostic');
  check('the diagnostic reads', before.status === 200, `HTTP ${before.status}`);
  // Read from `pipelineTruth`, which is what the endpoint actually returns.
  // The first version of this script guessed at `events.total` and got zero
  // for everything — and then reported production as empty when it was not.
  // Reading the wrong key and calling the result a finding is the same class
  // of mistake as everything else this work has been correcting.
  const truth = (body) => ({
    events: body?.pipelineTruth?.demandEvents ?? 0,
    routes: body?.pipelineTruth?.routeHypotheses ?? 0,
    companies: body?.pipelineTruth?.accounts ?? 0,
    verifiedLeads: body?.pipelineTruth?.verifiedLeads ?? 0,
    withExternalDate: body?.events?.dateCoverage?.withExternalEventDate ?? 0,
    withSourceUrl: body?.events?.dateCoverage?.withDurableSourceUrl ?? 0,
  });
  const baseline = truth(before.body);
  console.log(
    `        events ${baseline.events}   routes ${baseline.routes}   organisations ${baseline.companies}`
    + `   verified leads ${baseline.verifiedLeads}`,
  );

  // --- 4. the real recurring path ------------------------------------------
  console.log('\n--- running the demand sources through the deployed path -------');
  const run = await call('/api/demand/run', { method: 'POST' });
  check('the run completes', run.status === 200, `HTTP ${run.status} ${run.text.slice(0, 200)}`);

  const sources = run.body?.sources ?? [];
  console.log('');
  for (const source of sources) {
    console.log(`  ${source.connector}`);
    console.log(
      `      status ${source.status}   examined ${source.recordsExamined ?? 0}`
      + `   created ${source.eventsCreated ?? 0}   updated ${source.eventsUpdated ?? 0}`
      + `   rejected ${source.eventsRejected ?? 0}   quarantined ${source.quarantined ?? 0}`,
    );
    if (source.outcomeReason) console.log(`      why: ${String(source.outcomeReason).slice(0, 400)}`);
    if (source.error) console.log(`      error: ${String(source.error).slice(0, 300)}`);
    for (const warning of source.warnings ?? []) console.log(`      warning: ${String(warning).slice(0, 200)}`);
  }

  const totals = sources.reduce(
    (acc, s) => ({
      examined: acc.examined + (s.recordsExamined ?? 0),
      created: acc.created + (s.eventsCreated ?? 0),
      updated: acc.updated + (s.eventsUpdated ?? 0),
      rejected: acc.rejected + (s.eventsRejected ?? 0),
      quarantined: acc.quarantined + (s.quarantined ?? 0),
    }),
    { examined: 0, created: 0, updated: 0, rejected: 0, quarantined: 0 },
  );

  console.log('\n--- the pipeline that followed ---------------------------------');
  const pipelineEvents = run.body?.events ?? {};
  const accounts = run.body?.accounts ?? {};
  const routes = run.body?.routes ?? {};
  console.log(`  events verified ${pipelineEvents.verified ?? 0}   expired ${pipelineEvents.expired ?? 0}   quarantined ${pipelineEvents.quarantined ?? 0}`);
  console.log(`  organisations resolved ${accounts.resolved ?? 0}   created ${accounts.created ?? 0}   matched ${accounts.matched ?? accounts.linked ?? 0}`);
  console.log(`  routes created ${routes.created ?? 0}   updated ${routes.updated ?? 0}   expired ${routes.expired ?? 0}`);
  if (Array.isArray(routes.skipped) && routes.skipped.length > 0) {
    console.log('  playbooks that did not fire:');
    for (const s of routes.skipped.slice(0, 10)) {
      console.log(`      ${String(s.playbook ?? '—')}: ${String(s.because ?? '').slice(0, 140)}`);
    }
  }

  // --- 5. what is actually in the database now -----------------------------
  console.log('\n--- production after the run -----------------------------------');
  const after = await call('/api/demand/diagnostic');
  const a = after.body ?? {};
  const now = truth(a);
  console.log(
    `        events ${now.events}   routes ${now.routes}   organisations ${now.companies}`
    + `   verified leads ${now.verifiedLeads}`,
  );
  console.log(
    `        delta: events +${now.events - baseline.events}`
    + `   routes +${now.routes - baseline.routes}`
    + `   organisations +${now.companies - baseline.companies}`,
  );
  console.log(
    `        of ${now.events} event(s): ${now.withExternalDate} carry an external date, `
    + `${now.withSourceUrl} carry a durable source URL`,
  );

  // --- 6. evidence for what landed -----------------------------------------
  console.log('\n--- evidence for every event that landed ------------------------');
  const sample = Array.isArray(a.liveRoutes) ? a.liveRoutes : [];
  if (sample.length === 0) {
    console.log('  No live route carries evidence, because there are no live routes.');
  } else {
    for (const r of sample.slice(0, 25)) {
      console.log(
        `  ${String(r.connector ?? '—').padEnd(24)}`
        + ` ${String(r.externalDate ?? 'no date').slice(0, 10)}`
        + `  ${String(r.sourceUrl ?? '(no url)').slice(0, 100)}`,
      );
    }
    const withUrl = sample.filter((r) => r.sourceUrl).length;
    const withDate = sample.filter((r) => r.externalDate).length;
    console.log(
      `\n  ${withUrl}/${sample.length} shown carry a source URL; ${withDate}/${sample.length} carry an external date.`,
    );
  }

  // --- 7. the honest verdict ------------------------------------------------
  console.log(`\n${line()}`);
  console.log('VERDICT');
  console.log(line());
  console.log(`  rows examined            ${totals.examined}`);
  console.log(`  events accepted          ${totals.created + totals.updated}`);
  console.log(`  events rejected          ${totals.rejected}`);
  console.log(`  events quarantined       ${totals.quarantined}`);
  console.log(`  events persisted (total) ${now.events}   (delta ${now.events - baseline.events})`);
  console.log(`  … carrying an external date  ${now.withExternalDate}`);
  console.log(`  … carrying a source URL      ${now.withSourceUrl}`);
  console.log(`  organisations resolved   ${accounts.resolved ?? 0}   created ${accounts.created ?? 0}   matched ${accounts.matched ?? accounts.linked ?? 0}`);
  console.log(`  organisations (total)    ${now.companies}`);
  console.log(`  routes created           ${routes.created ?? 0}   updated ${routes.updated ?? 0}   (total ${now.routes})`);
  console.log(`  verified leads           ${now.verifiedLeads}`);

  if (now.events === 0) {
    console.log('\n  Production holds no demand events. Per-source reasons, verbatim:');
    for (const source of sources) {
      console.log(`    ${source.connector}: ${String(source.outcomeReason ?? source.error ?? 'no reason recorded').slice(0, 500)}`);
    }
  }

  console.log(
    '\n  No fixture was created by this script. Every number above is either an\n'
    + '  external record the deployment fetched, or a zero with a reason.',
  );

  if (failures > 0) {
    console.log(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
