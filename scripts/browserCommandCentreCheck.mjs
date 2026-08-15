/**
 * The owner's landing page, in a real browser.
 *
 * The acceptance criterion is blunt: somebody opens the application and
 * immediately sees where money may be made and what to do next. The page that
 * failed it opened with a row of record counts and a plan ranked by an expected
 * value built on a closing probability nobody had set — which told an owner how
 * busy the system had been, and nothing about what to do.
 *
 * So this checks the order and the content, not the styling. The first thing on
 * the page is a sentence about money or a decision. Work is banded by distance
 * from collected profit. Every band says what it is and what to do with it. The
 * raw counts are still available and are folded away. And the band that makes
 * an empty board legible — what the engine read and could not build a case from
 * — is present whether or not it has anything in it.
 *
 *   BASE_URL=http://127.0.0.1:3000 node scripts/browserCommandCentreCheck.mjs
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
  const context = await browser.newContext({ viewport: { width: 1500, height: 1300 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  [page error] ${e.message}`));

  console.log('='.repeat(74));
  console.log('COMMAND CENTRE — what an owner sees when they open the application');
  console.log('='.repeat(74));

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle').catch(() => {});

  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  // --- the first thing on the page ----------------------------------------
  console.log('\n--- what comes first --------------------------------------------');
  const headline = page.locator('[data-testid="command-headline"]');
  check('the page opens with a sentence, not a count', (await headline.count()) === 1);
  const headlineText = (await headline.first().innerText()).trim();
  check('which is a sentence', headlineText.split(' ').length >= 8, headlineText.slice(0, 120));
  check(
    'and is about money, a decision, or an honest absence of both',
    /money|unpaid|decision|deliver|quoted|waiting on you|nothing is waiting|need/i.test(headlineText),
    headlineText.slice(0, 140),
  );

  // The banded work must sit above the raw counts, because the whole point was
  // that counts stopped being the first thing an owner reads.
  const centreBox = await page.locator('[data-testid="command-centre"]').first().boundingBox().catch(() => null);
  const countsBox = await page.locator('[data-testid="dashboard-counts"]').first().boundingBox().catch(() => null);
  check('work sits above the raw counts', Boolean(centreBox && countsBox && centreBox.y < countsBox.y));

  const countsOpen = await page.locator('[data-testid="dashboard-counts"]').first().getAttribute('open');
  check('and the counts are folded away by default', countsOpen === null);

  // --- the bands ------------------------------------------------------------
  console.log('\n--- work banded by distance from money --------------------------');
  const bands = await page.locator('[data-testid^="band-"]').all();
  check('work is banded', bands.length > 0, `${bands.length} band(s) shown`);

  let missingMeaning = 0;
  let missingAction = 0;
  for (const band of bands) {
    const text = (await band.innerText()).replace(/\s+/g, ' ');
    // Every band explains why it exists...
    if (text.length < 60) missingMeaning += 1;
    // ...and every band with work in it says what to do with that work.
    const count = Number((/\n?\s*(\d+)\s/.exec(await band.innerText()) ?? [])[1] ?? '0');
    if (count > 0 && !/What to do:/.test(text)) missingAction += 1;
  }
  check('every band explains itself', missingMeaning === 0, `${missingMeaning} without an explanation`);
  check('every band with work says what to do with it', missingAction === 0, `${missingAction} without one`);

  // --- the band that makes an empty board legible --------------------------
  console.log('\n--- the band nobody usually builds ------------------------------');
  const refused = page.locator('[data-testid="band-no_credible_thesis"]');
  check('“read, and no case made” is always present', (await refused.count()) === 1);
  const refusedText = await refused.first().innerText();
  check(
    'and explains why it matters',
    /empty board is not the same as a broken engine/i.test(refusedText),
    refusedText.replace(/\s+/g, ' ').slice(0, 160),
  );

  // --- nothing invented -----------------------------------------------------
  console.log('\n--- nothing invented --------------------------------------------');
  const body = await page.locator('body').innerText();
  check(
    'no closing probability is presented as fact anywhere on the page',
    !/Closing probability[\s\S]{0,20}?\d+%/i.test(body),
  );
  // A band total is gross profit with both sides contracted, or it is absent.
  const bandMoney = /gross profit, both sides contracted/.test(body);
  console.log(`        band-level money shown: ${bandMoney ? 'yes' : 'no (nothing qualifies, which is the honest state)'}`);

  // --- every item is reachable ---------------------------------------------
  console.log('\n--- every item goes somewhere -----------------------------------');
  const links = await page.locator('[data-testid^="band-"] a').all();
  let deadLinks = 0;
  for (const link of links.slice(0, 20)) {
    const href = await link.getAttribute('href');
    if (!href || href === '#') deadLinks += 1;
  }
  check('no item is a dead end', deadLinks === 0, `${deadLinks} without a destination`);

  await browser.close();

  console.log(`\n${'='.repeat(74)}`);
  console.log(`${passed}/${passed + failed} checks passed.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
