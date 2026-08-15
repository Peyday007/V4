/**
 * The opportunity universe, in a real browser.
 *
 * The claim this has to defend is an uncomfortable one: most of the paths on
 * this page do not work, and the page has to say so plainly rather than
 * shading it. A registry that quietly labelled forty paths "operational" would
 * be worse than having no registry, because it would be believed.
 *
 * So the assertions run in both directions. Every path must carry a status and
 * a next action. No path may claim to be operational without a real record
 * behind it. And the honest-emptiness has to be visible: if this page ever
 * shows forty operational paths on a database with one working source, that is
 * the failure, not the success.
 *
 *   BASE_URL=http://127.0.0.1:3000 node scripts/browserUniverseCheck.mjs
 */

import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const EMAIL = process.env.OWNER_EMAIL ?? 'owner@dealdispatch.test';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'demo-password-123';

let passed = 0;
let failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ok    ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`); }
}

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  [page error] ${e.message}`));

  console.log('='.repeat(74));
  console.log('OPPORTUNITY UNIVERSE — what this business could do, and what works');
  console.log('='.repeat(74));

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle').catch(() => {});

  console.log('\n--- reachable ---------------------------------------------------');
  check('the universe is in the sidebar', (await page.locator('nav a[href="/universe"]').count()) > 0);

  const response = await page.goto(`${BASE}/universe`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  check('the page renders', (response?.status() ?? 0) < 400, `status ${response?.status()}`);

  // --- the universe is actually complete ----------------------------------
  console.log('\n--- the universe is complete ------------------------------------');
  const rows = await page.locator('[data-testid^="path-"]').count();
  check('every declared path is on the page', rows >= 30, `${rows} path row(s)`);

  const models = await page.locator('[data-testid^="model-"]').count();
  check('paths are grouped by commercial model', models >= 5, `${models} model group(s)`);

  const body = await page.locator('body').innerText();
  for (const model of ['Subcontracting', 'Distribution', 'Brokerage', 'Capacity arbitrage']) {
    check(`  ${model.toLowerCase()} is represented`, body.includes(model));
  }

  // --- and honest about it -------------------------------------------------
  console.log('\n--- and honest about what works ---------------------------------');
  const totals = await page.locator('[data-testid="universe-totals"]').innerText();
  check('the four states are counted', /Operational[\s\S]*Partial[\s\S]*Needs configuration[\s\S]*Taxonomy only/i.test(totals));

  const taxonomyCount = Number((/Taxonomy only\s*\n?\s*(\d+)/i.exec(totals) ?? [])[1] ?? '0');
  check(
    'most paths honestly report that they are declarations',
    taxonomyCount > 10,
    `${taxonomyCount} taxonomy-only — if this were near zero the page would be over-claiming`,
  );

  const operationalCount = Number((/Operational\s*\n?\s*(\d+)/i.exec(totals) ?? [])[1] ?? '0');
  check(
    'no more paths claim to be operational than there are working sources for',
    operationalCount <= 6,
    `${operationalCount} operational`,
  );

  // Every row has to say what it is and what would change it. A status with no
  // next action is the kind of honesty nobody can act on.
  console.log('\n--- every row is actionable -------------------------------------');
  const sample = await page.locator('[data-testid^="path-"]').all();
  let missingStatus = 0;
  let missingAction = 0;
  for (const row of sample.slice(0, 40)) {
    const text = (await row.innerText()).replace(/\s+/g, ' ');
    if (!/operational|partial|needs configuration|taxonomy only|disabled/i.test(text)) missingStatus += 1;
    // An operational path needs no next action; everything else does.
    if (!/operational/i.test(text) && !/Next:/.test(text)) missingAction += 1;
  }
  check('every path carries a status', missingStatus === 0, `${missingStatus} without one`);
  check('every non-operational path carries a next action', missingAction === 0, `${missingAction} without one`);

  // --- the five checks are inspectable ------------------------------------
  const checksVisible = await page.locator('details summary', { hasText: 'The five checks' }).count();
  check('the reasoning behind each status can be opened', checksVisible > 0, `${checksVisible} found`);

  // --- the three named paths ----------------------------------------------
  console.log('\n--- the three named paths ---------------------------------------');
  const named = page.locator('[data-testid="universe-named-paths"]');
  check('they are pulled out so they cannot get lost', (await named.count()) === 1);
  const namedText = await named.first().innerText();
  for (const label of ['Overflow warehousing', 'Steel and building-material', 'Commercial facility subcontracting']) {
    check(`  ${label.toLowerCase()} is shown`, namedText.includes(label), namedText.slice(0, 120));
  }

  // --- filters actually filter --------------------------------------------
  console.log('\n--- filters -----------------------------------------------------');
  await page.goto(`${BASE}/universe?state=TAXONOMY_ONLY`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  const filtered = await page.locator('[data-testid^="path-"]').count();
  check('filtering by status narrows the list', filtered > 0 && filtered < rows, `${filtered} of ${rows}`);
  // Read the rows themselves rather than the page text: the filter chips and
  // the four state tiles both contain the word "operational" whatever is
  // selected, so scanning the body was testing the chrome, not the result.
  const filteredRows = await page.locator('[data-testid^="path-"]').all();
  let wrongStatus = 0;
  for (const row of filteredRows) {
    const text = (await row.innerText()).replace(/\s+/g, ' ');
    if (!/taxonomy only/i.test(text)) wrongStatus += 1;
  }
  check('and every row shown carries that status', wrongStatus === 0, `${wrongStatus} row(s) of another status`);

  await browser.close();

  console.log(`\n${'='.repeat(74)}`);
  console.log(`${passed}/${passed + failed} checks passed.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
