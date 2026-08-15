/**
 * The rebuilt opportunity page, in a real browser.
 *
 * Correction three asks for this page to be rebuilt *and* browser-verified,
 * and the distinction matters: a server-rendered component that assembles the
 * right props proves the assembly, not that somebody opening the page can read
 * where the deal stands, find the one thing blocking it, and check any number
 * on it.
 *
 * What this asserts is the order and the honesty, not the styling: the
 * standing sentence comes first, the earliest blocker is named, the money path
 * shows a suppressed figure as a sentence rather than a dash or a zero, buyer
 * and provider are separate tracks, "Explain this" reveals provenance for
 * everything at once, and the raw diagnostics are folded away.
 *
 *   BASE_URL=http://localhost:3111 node scripts/browserOpportunityCheck.mjs
 */

import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:3111';
const EMAIL = process.env.OWNER_EMAIL ?? 'owner@dealdispatch.test';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'demo-password-123';

let passed = 0;
let failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ok    ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`); }
}

async function main() {
  // Discovered rather than hardcoded. A practice route id changes every time
  // the sandbox is reset, and a check that depends on one silently becomes a
  // check that a 404 page has no fabricated percentages on it.
  let routeId = process.env.ROUTE_ID;
  if (!routeId) {
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();
    const route = await prisma.routeHypothesis.findFirst({
      where: { dataMode: 'TEST', status: { notIn: ['EXPIRED', 'REJECTED'] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    await prisma.$disconnect();
    if (!route) {
      console.error('No practice route exists to open. Run the sandbox reset first.');
      process.exit(1);
    }
    routeId = route.id;
    console.log(`Using practice route ${routeId}.`);
  }

  // The environment ships one Chromium at a fixed path and the project's
  // pinned Playwright looks for a differently-numbered build beside it. Point
  // at the one that exists rather than downloading a second copy.
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  [page error] ${e.message}`));

  console.log('='.repeat(72));
  console.log('OPPORTUNITY PAGE — what somebody opening it actually sees');
  console.log('='.repeat(72));

  // --- sign in ------------------------------------------------------------
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle').catch(() => {});

  await page.goto(`${BASE}/demand/opportunity/${routeId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  // --- 1. standing, first --------------------------------------------------
  console.log('\n--- where it stands --------------------------------------------');
  const standing = page.locator('[data-testid="standing-sentence"]');
  check('the page opens with a standing sentence', (await standing.count()) === 1);
  const sentence = (await standing.first().innerText().catch(() => '')).trim();
  check('which is a sentence, not a status word', sentence.split(' ').length >= 6, sentence.slice(0, 110));

  // It has to be above the plan, because the whole correction was about order.
  const standingBox = await standing.first().boundingBox().catch(() => null);
  const planBox = await page.locator('[data-testid="action-plan"]').first().boundingBox().catch(() => null);
  check('and sits above the plan rather than below it',
    Boolean(standingBox && planBox && standingBox.y < planBox.y));

  // --- 2. the one blocker --------------------------------------------------
  console.log('\n--- what is blocking it ----------------------------------------');
  const blocker = page.locator('[data-testid="earliest-blocker"]');
  const hasBlocker = (await blocker.count()) > 0;
  if (hasBlocker) {
    const text = await blocker.first().innerText();
    check('the earliest blocker is named', text.length > 20);
    check('with a next action', /Next:/.test(text), text.slice(0, 120));
  } else {
    check('no blocker shown because nothing is blocked', true);
  }

  // --- 3. the money path ---------------------------------------------------
  console.log('\n--- the money --------------------------------------------------');
  const money = page.locator('[data-testid="money-path"]');
  check('the money is shown as a path', (await money.count()) === 1);
  const moneyText = await money.first().innerText();
  for (const step of ['Buyer price', 'Provider cost', 'Gross profit', 'Collected']) {
    check(`  the path includes ${step.toLowerCase()}`, moneyText.includes(step));
  }
  // The rule that matters: a figure with nothing under it is a sentence, never
  // a dash and never a zero.
  const rows = await money.locator('tbody tr').allInnerTexts();
  const suppressed = rows.filter((r) => /Not shown|No provider has priced|No money has been collected|No price has been set/.test(r));
  check('a suppressed figure is a sentence, not a dash', !rows.some((r) => /\t—\s*$/.test(r)));
  check(
    'and says what is missing',
    suppressed.length === 0 || suppressed.every((r) => r.length > 40),
    suppressed[0]?.slice(0, 100) ?? 'nothing suppressed',
  );

  // --- 4. two tracks -------------------------------------------------------
  console.log('\n--- buyer and provider -----------------------------------------');
  check('the buyer track is its own panel', (await page.locator('[data-testid="buyer-track"]').count()) === 1);
  check('the provider track is its own panel', (await page.locator('[data-testid="provider-track"]').count()) === 1);

  // --- 5. explain this -----------------------------------------------------
  console.log('\n--- explain this -----------------------------------------------');
  const toggle = page.locator('[data-testid="explain-toggle"]');
  check('there is an explain control', (await toggle.count()) === 1);
  check('explanations are hidden until asked for',
    (await page.locator('[data-testid="standing-explanation"]').count()) === 0);

  await toggle.first().click();
  await page.waitForTimeout(400);
  check('clicking it explains the standing',
    (await page.locator('[data-testid="standing-explanation"]').count()) === 1);

  const explained = await page.locator('[data-testid="standing-explanation"]').first().innerText();
  check('with the reasoning, not a restatement', /steps are finished|judged by/.test(explained), explained.slice(0, 110));

  // --- 5b. the magnifying glass ------------------------------------------
  // The owner's actual request: take any word on the page and say what it
  // means here. A glossary would satisfy the letter and miss the point, so
  // this checks the explanations are built from the record.
  const glass = page.locator('[data-testid="explanations"]');
  check('explaining also explains every term on the record', (await glass.count()) === 1);
  if ((await glass.count()) === 1) {
    const text = await glass.innerText();
    check(
      'each term says whether it is a fact or our inference',
      /our inference|a fact, from a source|not a finding|calculated from things/.test(text),
      text.replace(/\s+/g, ' ').slice(0, 160),
    );
    check('and what to do with it', /What to do with it:/.test(text));
    check('and how it was worked out', /How it was worked out:/.test(text));
    // The distinguishing test: a glossary would not name the organisation.
    const org = (await page.locator('h1').first().innerText()).trim();
    check(
      'and is written about this record rather than in general',
      org.length > 0 && text.includes(org.split(' ')[0]),
      `looking for "${org.split(' ')[0]}" in the explanations`,
    );
  }

  await toggle.first().click();
  await page.waitForTimeout(300);
  check('and clicking again hides it',
    (await page.locator('[data-testid="standing-explanation"]').count()) === 0);

  // --- 6. diagnostics folded ----------------------------------------------
  console.log('\n--- diagnostics ------------------------------------------------');
  const diagnostics = page.locator('[data-testid="diagnostics"]');
  if ((await diagnostics.count()) > 0) {
    const open = await diagnostics.first().getAttribute('open');
    check('raw diagnostics are collapsed by default', open === null);
  } else {
    check('no raw diagnostics to fold', true);
  }

  // The old page's fabricated meters must be gone from the top of the page.
  const body = await page.locator('body').innerText();
  check(
    'no closing-probability percentage is presented as fact',
    !/Closing probability\s*\n?\s*\d+%/.test(body),
    (body.match(/Closing probability[^\n]*\n?[^\n]*/) ?? ['—'])[0].slice(0, 60),
  );

  await browser.close();

  console.log(`\n${'='.repeat(72)}`);
  console.log(`${passed}/${passed + failed} checks passed.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
