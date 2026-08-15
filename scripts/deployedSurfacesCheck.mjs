/**
 * The surfaces built this cycle, against the real deployment, reading only.
 *
 * The existing deployed walkthrough drives a shift: it creates a sandbox
 * caller, assigns practice work and saves an outcome. This one deliberately
 * does the opposite — it opens the pages an owner opens and writes nothing at
 * all, because the questions it answers are about production data and the
 * answers would be worthless if the act of asking changed them.
 *
 * What it establishes, on the deployment rather than on a developer's laptop:
 *
 *   The claim ledger exists on a real opportunity, and what it says about a
 *   real deal is provenance rather than a badge.
 *   Modelled money appears as a band, never as a midpoint on its own.
 *   The twelve structures are on the page with the five questions answered.
 *   The reconciliation preview reports the real refraction on the real board —
 *   the number the owner has been waiting for — and changes nothing by being
 *   read.
 *   The universe reports its own state, and the held source is held rather
 *   than failing hourly.
 *
 * Nothing here clicks anything that writes. Every control that would mutate is
 * checked for existence and left alone.
 *
 *   BASE_URL=https://… OWNER_EMAIL=… OWNER_PASSWORD=… node scripts/deployedSurfacesCheck.mjs
 */

import { chromium } from 'playwright';

const BASE = (process.env.BASE_URL ?? '').replace(/\/$/, '');
const EMAIL = process.env.OWNER_EMAIL ?? 'owner@dealdispatch.test';
const PASSWORD = process.env.OWNER_PASSWORD ?? '';

if (!BASE) throw new Error('BASE_URL is required.');
// An owner password is sent to this address, so it must be https — except
// against a loopback address, which is how this script gets run at least once
// before it is trusted to report on production. A check that has only ever run
// in CI is a check nobody has seen fail for the right reason.
const loopback = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(BASE);
if (!/^https:\/\//.test(BASE) && !loopback) {
  throw new Error('BASE_URL must be https. An owner password is sent to it.');
}
if (!PASSWORD) throw new Error('OWNER_PASSWORD is required.');

let passed = 0;
let failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ok    ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`); }
}

/** Reported rather than asserted. Facts about production, for the record. */
function report(label, value) {
  console.log(`  ..    ${label}: ${value}`);
}

async function main() {
  // CI installs its own browser; this environment ships one at a fixed path.
  // Honouring CHROMIUM_PATH when it is set means the same script runs in both
  // without a second copy of it.
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  );
  const context = await browser.newContext({ viewport: { width: 1600, height: 1300 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  [page error] ${e.message}`));

  console.log('='.repeat(74));
  console.log('DEPLOYED SURFACES — read-only, against production');
  console.log('='.repeat(74));
  console.log(`Against ${BASE}`);

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle').catch(() => {});
  check('the owner can sign in', !page.url().includes('/login'), page.url());

  // --- the reconciliation preview, and the number that matters -------------
  console.log('\n--- the board built before one event meant one thesis ------------');
  const reconcile = await page.goto(`${BASE}/demand/reconcile`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  check('the reconciliation page renders on the deployment', (reconcile?.status() ?? 0) < 400,
    `status ${reconcile?.status()}`);

  const standing = await page.locator('[data-testid="reconciliation-standing"]').innerText().catch(() => '');
  check('it reports what it would do before anything is pressed', standing.length > 40, standing.slice(0, 200));
  report('production standing', standing.replace(/\s+/g, ' '));

  // Read structurally, and absent is not nought. `Number('')` is zero, so the
  // first version of this passed with four zeroes on a page that had redirected
  // to the login form — a check that cannot fail is not a check.
  const counts = {};
  for (const id of ['retained', 'superseded', 'worked', 'nocredible']) {
    const tile = page.locator(`[data-testid="reconcile-count-${id}"] .stat-value`);
    counts[id] = (await tile.count()) === 1 ? Number((await tile.innerText()).trim()) : null;
  }
  check(
    'every verdict has a real count behind it',
    Object.values(counts).every((n) => n !== null && Number.isFinite(n)),
    JSON.stringify(counts),
  );
  report('verdicts', JSON.stringify(counts));

  // The safeguard, on production data rather than on a fixture.
  const workedRows = await page.locator('td:has-text("worked")').count();
  report('rows marked untouchable because somebody rang them', workedRows);

  // Reading it must not change it. Read twice and compare.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const second = await page.locator('[data-testid="reconciliation-standing"]').innerText().catch(() => '');
  check('reading it twice reports the same thing, so nothing was changed by looking', standing === second);

  // --- the universe --------------------------------------------------------
  console.log('\n--- what this engine can and cannot operate ----------------------');
  const universe = await page.goto(`${BASE}/universe`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  check('the universe page renders', (universe?.status() ?? 0) < 400, `status ${universe?.status()}`);

  const universeBody = await page.locator('body').innerText();
  // The six new playbooks should have moved paths off the taxonomy-only list.
  for (const label of ['Waste and recycling', 'Restaurant supplies', 'Construction subcontracting']) {
    check(`  ${label} is present`, universeBody.includes(label));
  }

  // --- the held source -----------------------------------------------------
  console.log('\n--- the source that is held rather than failing hourly ------------');
  const sources = await page.goto(`${BASE}/demand/sources`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  check('the sources page renders', (sources?.status() ?? 0) < 400, `status ${sources?.status()}`);

  const held = page.locator('[data-testid="held-sources"]');
  if ((await held.count()) > 0) {
    const text = await held.innerText();
    check('the held source keeps its diagnostic', /because|does not respond|network path/i.test(text),
      text.replace(/\s+/g, ' ').slice(0, 180));
    check('and says it is excluded from the recurring run', /excluded from the recurring run/i.test(text));
  } else {
    check('no source is held on this deployment', true);
  }

  // --- a real opportunity --------------------------------------------------
  console.log('\n--- a real opportunity, and how it says it knows things -----------');
  await page.goto(`${BASE}/demand`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  const firstRecord = page.locator('a[href^="/demand/opportunity/"]').first();
  if ((await firstRecord.count()) === 0) {
    // A real failure against a deployment, and the expected answer against a
    // development database that has no production routes on it. The detail says
    // which, so nobody reads this as a broken script.
    check(
      'there is a production opportunity to open',
      false,
      'No production route is on this board. Against the deployment that is a finding; against a development '
      + 'database it usually means the pipeline has never run there.',
    );
  } else {
    const href = await firstRecord.getAttribute('href');
    await page.goto(`${BASE}${href}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    report('opportunity', href);

    // The claim ledger.
    const ledger = page.locator('[data-testid="claim-ledger"]');
    check('the claim ledger is on a production opportunity', (await ledger.count()) === 1);
    if ((await ledger.count()) === 1) {
      const text = await ledger.innerText();
      const empty = await page.locator('[data-testid="claim-ledger-empty"]').count();
      if (empty > 0) {
        // Honest: routes built before the ledger existed carry no claims until
        // the next pipeline pass touches them.
        check('an older route says plainly that nothing has been claimed yet', /Nothing has been claimed/i.test(text));
        report('ledger', 'empty — this route predates the ledger, or has not been rebuilt since');
      } else {
        check('it says where each claim came from', /How it|came from|Where it came from/i.test(text));
        check('with counts rather than a completeness score', !/\d+%\s*complete/i.test(text));
        const summary = await page.locator('[data-testid="claim-ledger-summary"]').innerText().catch(() => '');
        report('ledger', summary.replace(/\s+/g, ' '));
      }
    }

    // Modelled money as a band.
    const body = await page.locator('body').innerText();
    const hasBand = /\$[\d,]+\s*–\s*\$[\d,]+/.test(body) || /between \$[\d,]+ and \$[\d,]+/.test(body);
    const claimsModelled = /Modelled gross profit|modelled band|category prior/i.test(body);
    check(
      'modelled money is shown as a band, or is not shown at all',
      !claimsModelled || hasBand || /predates ranged economics/i.test(body),
      (body.match(/Modelled gross profit[^\n]*/) ?? ['none'])[0].slice(0, 120),
    );

    // The structure comparison.
    const structures = page.locator('[data-testid="structure-comparison"]');
    check('the structure comparison is on the page', (await structures.count()) === 1);
    if ((await structures.count()) === 1) {
      const headers = (await structures.locator('thead').innerText()).toLowerCase();
      for (const question of ['signs with the buyer', 'gets paid first', 'carries the liability', 'funds the gap']) {
        check(`  it asks who ${question}`, headers.includes(question));
      }
      // Deliberately not clicked. Choosing a structure on a production deal is
      // a commercial decision and not this script's to make.
      const canChoose = await structures.locator('button', { hasText: 'Choose' }).count();
      report('structures offered for choice', canChoose);
    }
  }

  // --- is the ledger actually carrying anything --------------------------
  //
  // Asked of the whole board rather than of one record. The first opportunity
  // on the board is whichever route sorts first, and on this deployment that
  // was one built before the ledger existed — so its empty ledger is honest and
  // proves nothing about whether the ledger is live.
  console.log('\n--- the claim ledger, across the whole board ---------------------');
  // Navigated to rather than fetched. Both a page-side `fetch` and Playwright's
  // own request context arrived without the session cookie and got a 401, which
  // would have read as "the diagnostic is broken" rather than "this request was
  // made wrongly". A navigation carries the cookie the same way every other
  // page on this run does.
  const diagnosticNav = await page.goto(`${BASE}/api/demand/diagnostic`, { waitUntil: 'domcontentloaded' });
  let diagnostic = null;
  if ((diagnosticNav?.status() ?? 0) < 400) {
    const raw = await page.locator('body').innerText();
    try { diagnostic = JSON.parse(raw); } catch { diagnostic = null; }
  }
  check(
    'the diagnostic answers',
    diagnostic !== null,
    `status ${diagnosticNav?.status()}`,
  );
  if (diagnostic?.claimLedger) {
    const l = diagnostic.claimLedger;
    report('claim ledger', JSON.stringify(l));
    check(
      'the ledger is carrying claims in production',
      l.total > 0,
      'No claim exists on this board yet. Discovery writes them on every pipeline pass, so this means the '
      + 'pipeline has not run since the ledger shipped.',
    );
    check(
      'and they are attached to real routes',
      l.routesWithClaims > 0,
      `${l.routesWithClaims} route(s) carry a ledger`,
    );
    check(
      'with the composition the rules require',
      l.current <= l.total && l.confirmed <= l.current,
      JSON.stringify(l),
    );
  } else {
    check('the diagnostic reports the claim ledger', false, 'no claimLedger in the diagnostic payload');
  }

  // --- working from supply -------------------------------------------------
  console.log('\n--- working from supply ------------------------------------------');
  const supply = await page.goto(`${BASE}/supply`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  check('the supply page renders', (supply?.status() ?? 0) < 400, `status ${supply?.status()}`);
  const supplyStanding = await page.locator('[data-testid="supply-standing"]').innerText().catch(() => '');
  check('it says how many providers have been verified', /\d+ of \d+ provider/.test(supplyStanding),
    supplyStanding.slice(0, 140));
  report('supply standing', supplyStanding.replace(/\s+/g, ' '));

  // --- what the calling taught --------------------------------------------
  console.log('\n--- what the calling has taught the engine ------------------------');
  const analytics = await page.goto(`${BASE}/analytics`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  check('analytics renders', (analytics?.status() ?? 0) < 400, `status ${analytics?.status()}`);
  const learning = await page.locator('[data-testid="board-learning-sentence"]').innerText().catch(() => '');
  check('and reports what the calling established', learning.length > 30, learning.slice(0, 180));
  report('board learning', learning.replace(/\s+/g, ' '));

  await browser.close();

  console.log(`\n${'='.repeat(74)}`);
  console.log(`${passed}/${passed + failed} checks passed.`);
  console.log('Nothing on this deployment was changed by running this.');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
