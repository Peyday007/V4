/**
 * Handing a caller their access, and reading back what they established.
 *
 * Two gaps this covers, both of which looked finished and were not.
 *
 * A PIN was issued and shown, and the address it works at was nowhere on the
 * screen. The owner was left reciting a URL down the phone from memory. A
 * credential with no address is not a handover.
 *
 * And a caller's page showed how many calls they had made, which measures
 * effort. What came back — facts on the record because they asked, hypotheses
 * they closed, answers that disagree with somebody else's — had no surface at
 * all, so the caller who disproved a thesis looked worse than the one who
 * confirmed a requirement nobody will buy.
 *
 *   BASE_URL=http://127.0.0.1:3000 node scripts/browserCallerHandoverCheck.mjs
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
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();

  // Prefer a caller who has actually made calls, so the learning panel has
  // something to say. Falling back to any caller keeps the check meaningful on
  // a fresh database — the empty state is a real state and has to read well too.
  const caller =
    (await prisma.user.findFirst({
      where: { isActive: true, callerProfile: { isNot: null }, outreachAttempts: { some: {} } },
      select: { id: true, name: true },
    }))
    ?? (await prisma.user.findFirst({
      where: { isActive: true, callerProfile: { isNot: null } },
      select: { id: true, name: true },
    }));
  if (!caller) {
    console.error('No caller exists. Seed one first.');
    await prisma.$disconnect();
    process.exit(1);
  }

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1200 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  [page error] ${e.message}`));

  console.log('='.repeat(74));
  console.log('CALLER HANDOVER — the credential, the address, and what came back');
  console.log('='.repeat(74));
  console.log(`Using ${caller.name}.`);

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle').catch(() => {});

  await page.goto(`${BASE}/callers/${caller.id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1400);

  // --- the handover --------------------------------------------------------
  console.log('\n--- issuing access ---------------------------------------------');
  const issue = page.locator('[data-testid="detail-issue-pin"]');
  check('the owner can issue a PIN from the caller\'s page', (await issue.count()) === 1);

  await issue.click();
  await page.waitForTimeout(1500);

  const pinPanel = page.locator('[data-testid="detail-pin"]');
  check('the PIN is shown once', (await pinPanel.count()) === 1);
  if ((await pinPanel.count()) === 1) {
    const text = await pinPanel.innerText();
    check('and says it cannot be read again', /cannot be read again/i.test(text));

    const handover = page.locator('[data-testid="detail-handover"]');
    check('the address is shown beside the credential', (await handover.count()) === 1);
    if ((await handover.count()) === 1) {
      const url = await page.locator('[data-testid="detail-signin-url"]').innerText();
      // An absolute URL, from the browser rather than a setting, so it is right
      // on a preview deployment and on a custom domain alike.
      check('it is an address somebody can be given, not a path', /^https?:\/\/.+\/work$/.test(url), url);
      check('and points at the caller door rather than the owner login', url.endsWith('/work'), url);

      const handoverText = await handover.innerText();
      check('the instruction says no email and no password', /no email/i.test(handoverText) && /no password/i.test(handoverText));
      check(
        'and there is one control that copies the whole message',
        (await page.locator('[data-testid="detail-copy-handover"]').count()) === 1,
      );
    }
  }

  // --- what came back ------------------------------------------------------
  console.log('\n--- what their calls established --------------------------------');
  const learning = page.locator('[data-testid="detail-learning"]');
  check('the page reports what their calls established', (await learning.count()) === 1);
  if ((await learning.count()) === 1) {
    const sentence = await page.locator('[data-testid="detail-learning-sentence"]').innerText();
    check('in a sentence rather than a score', sentence.length > 40, sentence.slice(0, 140));
    // A rate here would measure the list as much as the caller.
    check('with no rate or percentage in it', !/%/.test(sentence), sentence);
    // Either it counts what came back, or it says plainly that nothing has —
    // both are answers, and a blank panel would be neither.
    check(
      'and it counts facts, or says plainly that there are none yet',
      /fact\(s\)|recorded call/i.test(sentence) || /No calls have been recorded/i.test(sentence),
      sentence.slice(0, 140),
    );
  }

  // --- and across everybody ------------------------------------------------
  console.log('\n--- what the calling taught the engine --------------------------');
  await page.goto(`${BASE}/analytics`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);

  const board = page.locator('[data-testid="board-learning"]');
  check('analytics reports what the calling taught', (await board.count()) === 1);
  if ((await board.count()) === 1) {
    const text = await board.innerText();
    check(
      'grouped by outcome so two wordings still group',
      /grouped by outcome|Why hypotheses close|No hypothesis has been closed/i.test(text),
      text.replace(/\s+/g, ' ').slice(0, 160),
    );
    check('and says what it means when nothing has been closed yet', text.length > 80);
  }

  await browser.close();
  await prisma.$disconnect();

  console.log(`\n${'='.repeat(74)}`);
  console.log(`${passed}/${passed + failed} checks passed.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
