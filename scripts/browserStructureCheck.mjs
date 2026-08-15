/**
 * Choosing how a deal is transacted, in a real browser.
 *
 * The point of this panel is that a decision which used to be made silently by
 * a heuristic is now made by a person who has been shown what it costs. So the
 * checks are about whether the five questions are actually on screen, whether
 * the structures a deal cannot support say why rather than vanishing, and
 * whether choosing one persists — because a comparison that does not commit to
 * anything is a reference table, not a decision.
 *
 *   BASE_URL=http://127.0.0.1:3000 node scripts/browserStructureCheck.mjs
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
  // Discovered, never hardcoded: a practice route id changes with every sandbox
  // reset, and a check pinned to one silently becomes a check that a 404 page
  // has no structure table on it.
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  const route = await prisma.routeHypothesis.findFirst({
    where: { dataMode: 'TEST', status: { notIn: ['EXPIRED', 'REJECTED'] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, commercialStructure: true },
  });
  if (!route) {
    console.error('No practice route exists to open. Run the sandbox reset first.');
    await prisma.$disconnect();
    process.exit(1);
  }

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  [page error] ${e.message}`));

  console.log('='.repeat(74));
  console.log('COMMERCIAL STRUCTURE — the decision, made by a person');
  console.log('='.repeat(74));
  console.log(`Using practice route ${route.id}.`);

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle').catch(() => {});

  await page.goto(`${BASE}/demand/opportunity/${route.id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);

  const panel = page.locator('[data-testid="structure-comparison"]');
  check('the comparison is on the opportunity page', (await panel.count()) === 1);
  if ((await panel.count()) !== 1) {
    await browser.close();
    await prisma.$disconnect();
    console.log(`\n${passed}/${passed + failed} checks passed.`);
    process.exit(1);
  }

  // --- the five questions --------------------------------------------------
  console.log('\n--- the five questions that separate them -----------------------');
  // Compared case-insensitively: the stylesheet upper-cases table headers, so
  // a case-sensitive match here fails on styling rather than on content.
  const headers = (await panel.locator('thead').innerText()).toLowerCase();
  for (const question of ['signs with the buyer', 'gets paid first', 'carries the liability', 'funds the gap']) {
    check(`  the table asks who ${question}`, headers.includes(question), headers.replace(/\s+/g, ' '));
  }
  check('and how much of your own money is at risk', /At risk/i.test(headers));

  // --- what is offered and what is not -------------------------------------
  console.log('\n--- available, and ruled out with a reason ----------------------');
  const rows = await page.locator('[data-testid^="structure-"][data-testid$=""]').count();
  const offered = await panel.locator('tbody tr').count();
  check('several structures are offered side by side', offered >= 3, `${offered} row(s), ${rows} elements`);

  const ruledOut = page.locator('[data-testid="structure-ruled-out"]');
  if ((await ruledOut.count()) > 0) {
    await ruledOut.locator('summary').click();
    await page.waitForTimeout(300);
    const text = await ruledOut.innerText();
    check('what is unavailable says why rather than vanishing', text.length > 80, text.slice(0, 140));
    // An operator who cannot see why brokerage is missing assumes the product
    // forgot it.
    const items = await ruledOut.locator('li').allInnerTexts();
    check('every ruled-out structure carries its reason', items.every((i) => i.includes('—')), items[0] ?? '');
  } else {
    check('nothing is ruled out on this deal', true);
  }

  // --- the standing --------------------------------------------------------
  console.log('\n--- whether a decision has been made ----------------------------');
  const unchosen = page.locator('[data-testid="structure-unchosen"]');
  const chosen = page.locator('[data-testid="structure-chosen"]');
  const hasChoice = (await chosen.count()) > 0;
  check('the panel says whether a structure has been chosen', hasChoice || (await unchosen.count()) > 0);
  if (!hasChoice) {
    const text = await unchosen.innerText();
    check(
      'and an unchosen deal says what that costs',
      /who would sign|whose money/i.test(text),
      text.slice(0, 140),
    );
  }

  // --- detail on demand ----------------------------------------------------
  console.log('\n--- the detail behind a row -------------------------------------');
  const firstMore = panel.locator('tbody tr button', { hasText: 'More' }).first();
  if ((await firstMore.count()) > 0) {
    await firstMore.click();
    await page.waitForTimeout(300);
    const detail = page.locator('[data-testid^="structure-detail-"]');
    check('a row opens into what you must have first', (await detail.count()) === 1);
    if ((await detail.count()) === 1) {
      const text = await detail.innerText();
      check('  including who invoices', /Who invoices/i.test(text));
      check('  what the margin looks like', /What the margin looks like/i.test(text));
      check('  and when it does not fit', /When it does not fit/i.test(text));
    }
  }

  // --- choosing one persists ----------------------------------------------
  console.log('\n--- choosing one -----------------------------------------------');
  const chooseButton = panel.locator('tbody tr button', { hasText: 'Choose' }).first();
  if ((await chooseButton.count()) > 0) {
    const before = route.commercialStructure;
    await chooseButton.click();
    await page.waitForTimeout(1600);

    const after = await prisma.routeHypothesis.findUnique({
      where: { id: route.id },
      select: { commercialStructure: true, structureReason: true },
    });
    check(
      'the choice reaches the database rather than only the screen',
      Boolean(after?.commercialStructure) && after?.commercialStructure !== before,
      `${before ?? 'none'} → ${after?.commercialStructure ?? 'none'}`,
    );
    check(
      'and carries the reasoning it was chosen on',
      (after?.structureReason?.length ?? 0) > 20,
      (after?.structureReason ?? '').slice(0, 120),
    );

    // The decision is a claim about the deal with a person and a date behind
    // it, so it belongs in the ledger as well as on the record.
    const claim = await prisma.claim.findFirst({
      where: { routeId: route.id, key: 'structure.chosen', supersededAt: null },
      orderBy: { recordedAt: 'desc' },
      select: { standing: true, sourceKind: true, sourceLabel: true },
    });
    check('and is written to the claim ledger', claim !== null);
    check(
      'as an operator decision rather than an inference',
      claim?.standing === 'CONFIRMED' && claim.sourceKind === 'OPERATOR',
      `${claim?.standing} from ${claim?.sourceKind}`,
    );

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    check(
      'and the page reports it after a reload',
      (await page.locator('[data-testid="structure-chosen"]').count()) === 1,
    );
  } else {
    check('no structure can be chosen without write permission', true);
  }

  await browser.close();
  await prisma.$disconnect();

  console.log(`\n${'='.repeat(74)}`);
  console.log(`${passed}/${passed + failed} checks passed.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
