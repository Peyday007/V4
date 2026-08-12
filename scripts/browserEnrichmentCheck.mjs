/**
 * The contact-resolution bridge, driven through a real browser.
 *
 * `enrichmentAudit.ts` proves the server behaves. This proves the operator can
 * see it happening: that Research needed says why each record is there and what
 * has already been searched, that a record moves out of it and into Call now
 * without anybody deploying anything, that the released record can actually be
 * worked, and that the caller is told where the number came from before they
 * dial it.
 *
 * The interesting half is the transition. The page is left open, the worker is
 * run against the same database from outside the browser, and the board is
 * reloaded — which is exactly what happens in production when the cron fires
 * while somebody is looking at the queue.
 *
 * Needs the app running and a login. Neither is committed:
 *
 *   npm run build && npx next start -p 3111
 *   DEMO_EMAIL=... DEMO_PASSWORD=... node scripts/browserEnrichmentCheck.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const BASE = 'http://localhost:3111';
let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
};

/**
 * Runs a snippet against the same database the server is using.
 *
 * Written to a file under `scripts/` rather than passed with `-e`, because the
 * project's path alias and its top-level-await settings both come from
 * tsconfig, and an inline script gets neither.
 */
const scratch = mkdtempSync(join('scripts', '.browser-check-'));
function server(body) {
  const file = join(scratch, `step-${Date.now()}.ts`);
  writeFileSync(file, `async function main() {\n${body}\n}\nmain().catch((e) => { console.error(e); process.exit(1); });\n`);
  return execFileSync('npx', ['tsx', file], {
    encoding: 'utf8',
    env: { ...process.env, DIRECT_URL: process.env.DIRECT_URL ?? process.env.DATABASE_URL },
  }).trim();
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log(`  [page error] ${e.message}`));

const VIEW_KEYS = { 'Call now': 'call_now', 'Research needed': 'research' };

/**
 * Switches the board to a view and waits for that view's rows to be on screen.
 *
 * The board fetches on a debounce, and the previous view's rows stay rendered
 * while it does. Waiting for `tbody tr` therefore returns instantly against
 * stale content, and every assertion after it reads the view the operator was
 * looking at a moment ago. Waiting for the response that belongs to the view
 * just asked for is the only version of this that is not a race.
 */
async function openView(label) {
  const key = VIEW_KEYS[label];
  const response = page.waitForResponse(
    (r) => r.url().includes('/api/demand/queue') && new URL(r.url()).searchParams.get('view') === key && r.ok(),
    { timeout: 20000 },
  );
  await page.locator('button.filter-chip', { hasText: label }).first().click();
  const body = await (await response).json();
  // One more frame so React has committed the rows the response carried.
  await page.waitForFunction(
    (expected) => document.querySelectorAll('table.table tbody tr').length >= expected,
    Math.min(body.rows.length, 50),
    { timeout: 20000 },
  );
  return body;
}

/** The counts as the board itself renders them, read from the chips. */
async function chipCount(label) {
  const text = await page.locator('button.filter-chip', { hasText: label }).first().textContent();
  return Number(text?.match(/\((\d+)\)/)?.[1] ?? '-1');
}

// ---------------------------------------------------------------------------
console.log('--- set the stage: an unresolved opportunity -------------------');
// One account with live demand, its contact removed and its resolution wound
// back, so the browser sees the state the operator complained about.
const staged = server(`
  const { prisma } = await import('@/lib/db');
  const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  await prisma.outreachAttempt.deleteMany({ where: { orgId: org.id } });
  await prisma.outreachState.deleteMany({ where: { orgId: org.id } });
  const row = await prisma.$queryRaw\`
    SELECT r."companyId", c."legalName"
    FROM "RouteHypothesis" r JOIN "Company" c ON c."id" = r."companyId"
    WHERE r."orgId" = \${org.id} AND r."status" NOT IN ('EXPIRED','REJECTED')
      AND r."tier" IN ('ACTIVE_DEMAND','STRONG_TRIGGER') AND c."phone" IS NOT NULL
    LIMIT 1\`;
  const target = row[0];
  await prisma.contactProvenance.deleteMany({ where: { companyId: target.companyId } });
  await prisma.company.update({ where: { id: target.companyId }, data: { phone: null } });
  await prisma.contactResolution.upsert({
    where: { companyId: target.companyId },
    create: { orgId: org.id, companyId: target.companyId, status: 'QUEUED', nextAttemptAt: new Date() },
    update: { status: 'QUEUED', confidence: null, blocker: null, resolvedAt: null,
              nextAttemptAt: new Date(), rejectedValues: [], lockedAt: null, lockedBy: null },
  });
  // A record of the same business found by another route, which is what the
  // worker will reuse rather than paying a provider for.
  const name = target.legalName + ' Inc';
  await prisma.company.deleteMany({ where: { orgId: org.id, legalName: name } });
  const loc = await prisma.companyLocation.findFirst({ where: { companyId: target.companyId } });
  const src = await prisma.company.findUnique({ where: { id: target.companyId } });
  await prisma.company.create({ data: {
    orgId: org.id, legalName: name, origin: 'LIVE_DISCOVERY', phone: '312-555-0161',
    cityName: src.cityName, stateCode: src.stateCode,
    locations: loc ? { create: { label: 'Listing', line1: loc.line1, city: loc.city, state: loc.state } } : undefined,
  }});
  console.log(JSON.stringify({ companyId: target.companyId, organisation: target.legalName }));
  await prisma.$disconnect();
`);
const subject = JSON.parse(staged.split('\n').pop());
console.log(`        staged: ${subject.organisation}`);

// ---------------------------------------------------------------------------
console.log('\n--- log in and open Research needed ----------------------------');
await page.goto(`${BASE}/login`);
await page.fill('input[type=email]', process.env.DEMO_EMAIL);
await page.fill('input[type=password]', process.env.DEMO_PASSWORD);
await page.click('button[type=submit]');
await page.waitForURL(/dashboard|demand|board/, { timeout: 15000 });

await page.goto(`${BASE}/demand`);
await page.waitForSelector('table.table tbody tr', { timeout: 15000 });
const researchView = await openView('Research needed');

const researchRows = await page.locator('table.table tbody tr').count();
check('Research needed lists unresolved opportunities', researchRows > 0,
  `${researchRows} rows of ${researchView.total}`);

const subjectRow = page.locator('table.table tbody tr', { hasText: subject.organisation }).first();
check('the staged opportunity is in Research needed', (await subjectRow.count()) > 0, subject.organisation);

const rowText = await subjectRow.textContent();
const hasState = /Queued|Retry scheduled|No contact found|Ambiguous match|Provider failure|Enriching/.test(rowText ?? '');
check('the row states where contact resolution has got to', hasState,
  (rowText ?? '').replace(/\s+/g, ' ').slice(0, 120));
check('the row offers a retry without exposing job records', (await subjectRow.locator('button:has-text("Try again now")').count()) > 0);
check('no raw job or table identifiers are shown', !/ContactResolution|cuid|job id/i.test(rowText ?? ''));

const bulk = page.locator('button:has-text("Retry everything blocked")');
check('a bulk retry is offered as a recovery tool', (await bulk.count()) > 0);

const callNowBefore = await chipCount('Call now');
const researchBefore = await chipCount('Research needed');
console.log(`        before: Call now ${callNowBefore}, Research needed ${researchBefore}`);

// ---------------------------------------------------------------------------
console.log('\n--- the worker runs, with nobody pressing anything --------------');
// The recurring worker, not the retry button: this is the automatic path.
const swept = server(`
  const { prisma } = await import('@/lib/db');
  const { sweepContactResolution } = await import('@/lib/enrichment/schedule');
  const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  const out = await sweepContactResolution({ orgId: org.id, limit: 50 });
  console.log(JSON.stringify(out));
  await prisma.$disconnect();
`);
const sweep = JSON.parse(swept.split('\n').pop());
check('the worker attempted the backlog on its own', sweep.attempted > 0,
  `${sweep.attempted} attempted, ${sweep.resolved} resolved, ${sweep.released} route(s) released`);

// ---------------------------------------------------------------------------
console.log('\n--- the board reflects it on reload -----------------------------');
await page.reload();
await page.waitForSelector('table.table tbody tr', { timeout: 15000 });
const researchAfterView = await openView('Research needed');

const stillInResearch = await page.locator('table.table tbody tr', { hasText: subject.organisation }).count();
check('the resolved opportunity has left Research needed', stillInResearch === 0,
  `${researchAfterView.total} still in research`);

const callNowAfter = await chipCount('Call now');
const researchAfter = await chipCount('Research needed');
check('Call now increased', callNowAfter > callNowBefore, `${callNowBefore} → ${callNowAfter}`);
check('Research needed fell by the same amount', researchBefore - researchAfter === callNowAfter - callNowBefore,
  `research ${researchBefore} → ${researchAfter}`);

await openView('Call now');
const nowCallable = page.locator('table.table tbody tr', { hasText: subject.organisation }).first();
check('the opportunity is now in Call now', (await nowCallable.count()) > 0);
const callableText = await nowCallable.textContent();
check('the row says the contact is ready', /Contact ready/.test(callableText ?? ''),
  (callableText ?? '').replace(/\s+/g, ' ').slice(0, 100));
check('the row shows a dialable number', /\d{3}[-.\s]?\d{4}/.test(callableText ?? ''));

// ---------------------------------------------------------------------------
console.log('\n--- Start calling serves it, with its provenance ----------------');
await page.goto(`${BASE}/demand/call`);
await page.waitForSelector('a[href^="tel:"]', { timeout: 15000 });
const cardText = await page.locator('body').textContent();
check('the caller view opens on a callable record', /☎/.test(cardText ?? ''));
check('the caller is told how confident the match is',
  /verified|probable|confirmed by a caller/i.test(cardText ?? ''));
check('the caller is told which source the number came from',
  /existing platform data|google places|records we already hold|operator/i.test(cardText ?? ''));
check('the caller is told how the match was made',
  /matched on|confirmed by/i.test(cardText ?? ''));
check('the retrieval date is shown, not implied',
  /retrieved \d{4}-\d{2}-\d{2}/.test(cardText ?? ''));

// ---------------------------------------------------------------------------
console.log('\n--- the admin view explains the rest ----------------------------');
await page.goto(`${BASE}/demand/sources`);
await page.waitForSelector('text=Contact resolution', { timeout: 15000 });
const adminText = await page.locator('body').textContent();
for (const label of ['Waiting', 'In progress', 'Resolved', 'Ambiguous', 'Nothing published', 'Failed', 'Stale']) {
  check(`the admin view counts "${label}" separately`, adminText.includes(label));
}
check('it says when the last attempt was', /Last attempt/.test(adminText));
check('it says when the next retry is', /Next scheduled retry/.test(adminText));
check('it lists the sources attempted', /Sources attempted/.test(adminText));
check('it reports what became callable', /Routes released into Call now/.test(adminText));
check('it names any configuration that is blocking enrichment, or says nothing is',
  /Configuration stopping automatic enrichment/.test(adminText) || /Nothing blocked/.test(adminText));

// ---------------------------------------------------------------------------
console.log('\n--- the whole chain names where it is stopped -------------------');
check('the admin view opens with where the machine is stopped',
  /Where the machine is stopped/.test(adminText));
for (const stage of ['Demand sources', 'Dated demand events', 'Organisation and location',
                     'Commercial routes', 'Contact resolution', 'Work ready to call',
                     'Calls being made', 'Supply able to deliver']) {
  check(`the chain lists "${stage}"`, adminText.includes(stage));
}
check('exactly one break is emphasised, not a wall of amber',
  (await page.locator('.alert.danger').count()) <= 1,
  `${await page.locator('.alert.danger').count()} danger alert(s)`);
check('supply keeps its own verdict rather than being hidden behind a demand break',
  /Supply, separately/.test(adminText) || /Supply able to deliver/.test(adminText));
check('the stages that would record money are named as not built',
  /Not built yet/.test(adminText) && /payment and collected profit/i.test(adminText));
check('it does not claim the chain is flowing while nothing is paid',
  !/flowing all the way/.test(adminText) || !/Not built yet/.test(adminText));

// ---------------------------------------------------------------------------
console.log('\n--- state survives a reload -------------------------------------');
await page.goto(`${BASE}/demand`);
await page.waitForSelector('table.table tbody tr', { timeout: 15000 });
await openView('Research needed');
const persistedRow = await page.locator('table.table tbody tr').first().textContent();
check('Research needed still states each remaining blocker after a reload',
  /searched:|Queued|next automatic attempt|No contact found|Ambiguous match|Provider failure/.test(persistedRow ?? ''),
  (persistedRow ?? '').replace(/\s+/g, ' ').slice(0, 120));

await browser.close();
rmSync(scratch, { recursive: true, force: true });
console.log(`\n${failures === 0 ? 'All browser checks passed.' : `${failures} browser check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
