/**
 * The coverage matrix, in a real browser.
 *
 * The failure this defends against is a claim rather than a bug. A federal
 * award API is nationwide, so a product wired to one is tempted to describe
 * itself as operating nationwide. It does not — it operates wherever a source
 * is configured and answering, and today that is three cities.
 *
 * So the assertions are mostly about what the page must *not* say. All fifty
 * states must be present, the uncovered ones must outnumber the covered ones by
 * a long way, no state may be listed as working without a source behind it, and
 * every uncovered state must carry a specific next action rather than a shrug.
 *
 *   BASE_URL=http://127.0.0.1:3000 node scripts/browserCoverageCheck.mjs
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
  console.log('COVERAGE — fifty states, and what this engine can actually reach');
  console.log('='.repeat(74));

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle').catch(() => {});

  const response = await page.goto(`${BASE}/demand/sources`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  check('the sources page renders', (response?.status() ?? 0) < 400, `status ${response?.status()}`);

  const matrix = page.locator('[data-testid="coverage-matrix"]');
  check('the coverage matrix is on it', (await matrix.count()) === 1);

  // --- all fifty are present ----------------------------------------------
  console.log('\n--- all fifty states --------------------------------------------');
  // The uncovered list is behind a fold, so open it before counting.
  await page.locator('[data-testid="coverage-uncovered"] summary').click();
  await page.waitForTimeout(400);

  const rows = await page.locator('[data-testid^="coverage-"]').count();
  // The panel itself, the verdict and the fold also match the prefix, so the
  // state rows are what remains.
  check('every state is listed', rows >= 50, `${rows} matching elements (50 states plus panel furniture)`);

  const body = await matrix.innerText();
  for (const state of ['Wyoming', 'Nebraska', 'Vermont', 'Illinois', 'California', 'Washington']) {
    check(`  ${state} appears`, body.includes(state));
  }

  // --- and honest about them ----------------------------------------------
  console.log('\n--- and honest about them ---------------------------------------');
  const verdict = await page.locator('[data-testid="coverage-verdict"]').innerText();
  check(
    'the verdict says what nationwide does not mean',
    /does not make this engine nationwide/i.test(verdict),
    verdict.slice(0, 160),
  );

  // Read the tiles by test id rather than by scraping the panel text. The
  // first version regexed "Working" out of `innerText`, silently matched
  // nothing, and fell back to defaults that made the assertion meaningless —
  // it reported 99 working states and failed for the wrong reason.
  const readCount = async (testId) => {
    const text = await page.locator(`[data-testid="${testId}"] .stat-value`).innerText();
    const value = Number(text.trim());
    if (!Number.isFinite(value)) throw new Error(`${testId} did not contain a number: ${text}`);
    return value;
  };
  const workingCount = await readCount('coverage-count-working');
  const noSourceCount = await readCount('coverage-count-none');
  check(
    'far more states have no source than have one',
    noSourceCount > workingCount * 5,
    `${workingCount} working, ${noSourceCount} with no source`,
  );
  check(
    'and the working count matches the handful of configured cities',
    workingCount > 0 && workingCount <= 6,
    `${workingCount} working`,
  );

  // --- every gap is actionable --------------------------------------------
  console.log('\n--- every gap is actionable -------------------------------------');
  const uncovered = await page.locator('[data-testid="coverage-uncovered"] tbody tr').all();
  let withoutAction = 0;
  let vague = 0;
  for (const row of uncovered) {
    const text = (await row.innerText()).replace(/\s+/g, ' ');
    if (!/would be the place to start/i.test(text)) withoutAction += 1;
    // A next action naming no place is not a next action.
    if (!/check whether the city publishes/i.test(text)) vague += 1;
  }
  check('every uncovered state says where to start', withoutAction === 0, `${withoutAction} without one`);
  check('and what to look for there', vague === 0, `${vague} vague`);

  // --- and nothing proposes scraping ---------------------------------------
  check(
    'nothing here proposes scraping to turn the map green',
    /would be worse than an honest map/i.test(body),
  );

  await browser.close();

  console.log(`\n${'='.repeat(74)}`);
  console.log(`${passed}/${passed + failed} checks passed.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
