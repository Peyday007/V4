/**
 * Working from supply, in a real browser.
 *
 * The risk this page carries is not a bug, it is a reading. A list of
 * commercial paths beside a provider's name looks like a pipeline, and anybody
 * who reads it as one will make their first call assuming somebody wants this.
 * Nobody does — that is the entire question the page exists to pose.
 *
 * So the assertions are about what the page must say and must not imply: that
 * these are questions, that no money or score appears anywhere, that the
 * falsifier is on screen rather than folded away, and that a provider nobody
 * has verified produces a refusal with a next action rather than a thin list.
 *
 *   BASE_URL=http://127.0.0.1:3000 node scripts/browserSupplyCheck.mjs
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

/**
 * A provider with one verified capability, so the briefs half of the page is
 * actually rendered.
 *
 * Without this the check only ever exercised the refusal, because no provider
 * on a fresh database has a capability anybody has confirmed — and the more
 * complicated half of the page had never been seen in a browser at all. The
 * fixture is created in production mode because the page reads production
 * providers, and it is removed again whatever happens.
 */
async function withVerifiedProvider(run) {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  const MARK = 'SUPPLY-BROWSER-CHECK';
  let companyId = null;
  let capabilityId = null;
  try {
    const org = await prisma.organization.findFirstOrThrow({ select: { id: true } });
    const capability = await prisma.capability.upsert({
      where: { orgId_key: { orgId: org.id, key: `${MARK}-warehousing` } },
      create: { orgId: org.id, key: `${MARK}-warehousing`, name: 'Warehousing', category: 'Logistics' },
      update: {},
      select: { id: true },
    });
    capabilityId = capability.id;
    const company = await prisma.company.create({
      data: {
        orgId: org.id,
        dataMode: 'PRODUCTION',
        legalName: `${MARK} Halsted Storage`,
        companyRole: 'SUPPLIER',
        cityName: 'Chicago',
        stateCode: 'IL',
        capabilities: {
          create: [{
            capabilityId: capability.id,
            status: 'CONFIRMED',
            confidence: 0.9,
            verifiedAt: new Date(),
            notes: 'Confirmed on a call with the operator',
          }],
        },
      },
      select: { id: true },
    });
    companyId = company.id;
    await run(companyId);
  } finally {
    if (companyId) {
      await prisma.companyCapability.deleteMany({ where: { companyId } });
      await prisma.company.delete({ where: { id: companyId } }).catch(() => {});
    }
    if (capabilityId) await prisma.capability.delete({ where: { id: capabilityId } }).catch(() => {});
    await prisma.$disconnect();
  }
}

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1200 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  [page error] ${e.message}`));

  console.log('='.repeat(74));
  console.log('WORKING FROM SUPPLY — questions, not a pipeline');
  console.log('='.repeat(74));

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle').catch(() => {});

  const response = await page.goto(`${BASE}/supply`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  check('the page renders', (response?.status() ?? 0) < 400, `status ${response?.status()}`);

  // --- it is reachable without a deep link --------------------------------
  console.log('\n--- reachable ---------------------------------------------------');
  const nav = await page.locator('nav').innerText();
  check('it is in the sidebar rather than only at a URL', /Working from supply/i.test(nav));

  // --- the roster ---------------------------------------------------------
  console.log('\n--- the roster --------------------------------------------------');
  check('the provider roster is on the page', (await page.locator('[data-testid="supply-roster"]').count()) === 1);

  const standing = await page.locator('[data-testid="supply-standing"]').innerText();
  check(
    'it says how many providers have actually been verified',
    /\d+ of \d+ provider/.test(standing),
    standing.slice(0, 120),
  );
  check(
    'and that a claimed capability is not the same thing',
    /claim about themselves|claim themselves|not the same thing/i.test(standing),
    standing.slice(0, 160),
  );

  // --- the right-hand panel ------------------------------------------------
  console.log('\n--- what the panel says -----------------------------------------');
  const briefs = page.locator('[data-testid="reverse-briefs"]');
  const refusal = page.locator('[data-testid="reverse-refusal"]');
  const hasBriefs = (await briefs.count()) > 0;
  const hasRefusal = (await refusal.count()) > 0;
  const rosterEmpty = (await page.locator('[data-testid^="supply-provider-"]').count()) === 0;
  check(
    'the panel produces briefs, refuses, or says there are no providers',
    hasBriefs || hasRefusal || rosterEmpty,
    `briefs=${hasBriefs} refusal=${hasRefusal} rosterEmpty=${rosterEmpty}`,
  );

  if (hasRefusal) {
    // The refusal path is the more important one to get right, because it is
    // the one an account with no verified supply will actually see.
    const text = await refusal.innerText();
    check('the refusal explains itself in terms of evidence', text.length > 80, text.slice(0, 140));
    check('and names what would change it', /What would change it/i.test(text));
    check('and does not offer anything to click through to', (await refusal.locator('button').count()) === 0);
  }

  // --- and now the half a fresh database never shows ----------------------
  console.log('\n--- with a provider somebody has actually verified ---------------');
  await withVerifiedProvider(async (companyId) => {
    await page.goto(`${BASE}/supply?provider=${companyId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);

    const panel = page.locator('[data-testid="reverse-briefs"]');
    check('verified capacity produces briefs', (await panel.count()) === 1);
    if ((await panel.count()) !== 1) return;

    const text = await panel.innerText();
    const standingText = await page.locator('[data-testid="reverse-standing"]').innerText();
    check(
      'the panel opens by saying these are questions',
      /questions, not opportunities/i.test(standingText),
      standingText.slice(0, 120),
    );
    check(
      'and that nobody has asked for anything',
      /nobody has asked|no event has happened/i.test(standingText),
      standingText.slice(0, 160),
    );

    // The distinguishing test. A brief that carries money reads as a deal, and
    // whoever works it will assume somebody wants this.
    check('no money appears anywhere on a brief', !/\$\s?\d/.test(text), (text.match(/\$\s?\d[\d,]*/) ?? [''])[0]);
    check(
      'no score, probability or priority appears',
      !/\b\d{1,3}%|probability|priority score/i.test(text),
      (text.match(/\d{1,3}%|probability|priority score/i) ?? [''])[0],
    );

    check('the verification is quoted rather than asserted', /Confirmed on a call with the operator/.test(text));
    check('what would falsify it is on screen, not folded away', /What would show this is not worth/i.test(text));
    check('the questions are things to ask a person', /Ring/i.test(text));

    const firstBrief = page.locator('[data-testid^="reverse-brief-"]').first();
    check('at least one brief is offered', (await firstBrief.count()) > 0);
    if ((await firstBrief.count()) > 0) {
      const label = await firstBrief.locator('button').innerText();
      check('a brief can be committed to a campaign', /Draft a campaign/i.test(label), label);
      check(
        'and the control says what it cannot do on its own',
        /cannot be started until somebody adds/i.test(await firstBrief.innerText()),
      );
    }
  });

  await browser.close();

  console.log(`\n${'='.repeat(74)}`);
  console.log(`${passed}/${passed + failed} checks passed.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
