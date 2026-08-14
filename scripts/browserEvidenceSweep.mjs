/**
 * The evidence rule, on every screen that had a number on it.
 *
 * Correction four asks for evidence classes across *every* material claim, and
 * the way that correction gets faked is by enforcing the rule where it was
 * already enforced and calling it done. So this does not check the opportunity
 * page — that has its own check. It opens the six screens that were still
 * printing raw floats and asserts the two things that matter on each: no
 * percentage appears without something under it, and no suppressed figure has
 * been replaced by a dash.
 *
 *   BASE_URL=http://127.0.0.1:3111 node scripts/browserEvidenceSweep.mjs
 */

import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3111';
const EMAIL = process.env.OWNER_EMAIL ?? 'owner@dealdispatch.test';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'demo-password-123';

let passed = 0;
let failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ok    ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`); }
}

/**
 * The four figures that were column defaults, as they appeared on screen.
 *
 * Matched as a label followed by a percentage, because that is the shape that
 * reads as a measurement. A percentage on its own is fine — a connect rate over
 * two hundred calls is a real one.
 */
const FABRICATIONS = [
  { label: 'P 10%', pattern: /\bP \d+%/ },
  { label: 'Info NN%', pattern: /\bInfo \d+%/ },
  { label: 'Closing probability NN%', pattern: /Closing probability[\s\S]{0,20}?\d+%/i },
];

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  [page error] ${e.message}`));

  console.log('='.repeat(72));
  console.log('EVIDENCE SWEEP — every screen that used to print a raw float');
  console.log('='.repeat(72));

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle').catch(() => {});

  // An opportunity to open, so the detail page is swept with real content
  // rather than a 404. Taken from the list rather than hard-coded.
  await page.goto(`${BASE}/opportunities`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  const firstOpportunity = await page
    .locator('a[href^="/opportunities/"]')
    .first()
    .getAttribute('href')
    .catch(() => null);

  const routes = [
    '/board',
    '/opportunities',
    ...(firstOpportunity ? [firstOpportunity] : []),
    '/dashboard',
    '/approvals',
    '/analytics',
  ];

  for (const route of routes) {
    console.log(`\n--- ${route} ${'-'.repeat(Math.max(0, 58 - route.length))}`);
    const response = await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);

    check('the page renders', (response?.status() ?? 0) < 400, `status ${response?.status()}`);

    const body = await page.locator('body').innerText();

    for (const { label, pattern } of FABRICATIONS) {
      const match = pattern.exec(body);
      check(`no "${label}" presented as fact`, match === null, match?.[0]?.slice(0, 60));
    }

    // Every headline tile is either a sentence or a figure with its provenance
    // attached. This is the check that distinguishes "the fabrication is gone"
    // from "the fabrication moved": a percentage is allowed to appear, but only
    // where the tile says what it rests on.
    const tiles = await page.locator('[data-testid^="stat-"]').all();
    for (const tile of tiles) {
      const shown = await tile.getAttribute('data-shown');
      const text = (await tile.innerText()).replace(/\s+/g, ' ').trim();
      if (shown === 'true') {
        check(
          `a shown tile carries its provenance — ${text.slice(0, 34)}`,
          /confirmed|published|calculated|inferred/.test(text),
          text.slice(0, 110),
        );
      } else {
        check(
          `a withheld tile says what is missing — ${text.slice(0, 34)}`,
          text.length > 40 && !/\d+%/.test(text),
          text.slice(0, 110),
        );
      }
    }

    // A suppressed figure has to say something. The specific regression to
    // guard is a table cell that became an em dash when the rule started
    // withholding it.
    const cells = await page.locator('td, .stat-value').allInnerTexts();
    const dashes = cells.filter((c) => c.trim() === '—');
    check(
      'no figure was replaced by a bare dash',
      dashes.length === 0,
      `${dashes.length} cell(s) contain only an em dash`,
    );

    // And at least one honest suppression sentence, wherever the data is thin
    // enough to produce one. On a fully-populated page there may be none, so
    // this is reported rather than asserted.
    const suppressions = [
      /no closing rate yet/i,
      /column default/i,
      /nothing has scored/i,
      /rather than a measurement/i,
      /no provider has priced/i,
      /no cost behind it/i,
      /playbook range/i,
      /no signals on file/i,
    ].filter((p) => p.test(body)).length;
    console.log(`        ${suppressions} kind(s) of honest suppression visible on this page`);
  }

  // The sweep is worthless against empty pages: "no fabricated percentage
  // found" is trivially true of a page with nothing on it. So the board is
  // required to have rendered real cards, and to be visibly withholding a
  // closing rate rather than simply having nothing to say.
  console.log('\n--- the sweep is not vacuous -----------------------------------');
  await page.goto(`${BASE}/board`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  const cards = await page.locator('.deal-card').count();
  check('the board rendered real deal cards', cards > 0, `${cards} cards`);
  const boardText = await page.locator('body').innerText();
  check(
    'and is visibly withholding a closing rate rather than printing one',
    /No closing rate yet/.test(boardText),
    boardText.slice(0, 120),
  );

  // The board's two graded filters must not silently return everything.
  console.log('\n--- graded filters ---------------------------------------------');
  await page.goto(`${BASE}/board?filter=likely_to_close`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  const likely = await page.locator('body').innerText();
  check(
    'a filter that selects on an ungraded figure explains an empty result',
    !/Nothing matches this view\./.test(likely) || /has not been established/.test(likely),
    'the generic empty state appeared on a view that selects on a graded figure',
  );

  await browser.close();

  console.log(`\n${'='.repeat(72)}`);
  console.log(`${passed}/${passed + failed} checks passed.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
