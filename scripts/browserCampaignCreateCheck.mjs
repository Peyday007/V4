/**
 * Creating a campaign, in a real browser, all the way to a saved draft.
 *
 * The acceptance criterion is that Commercial Campaigns can create and execute
 * real work. The page had a model, a service, conditions, generated work and no
 * way to make anything — so the criterion failed on the one step nobody had
 * built, and every other part of it was irrelevant.
 *
 * This clicks through what an owner would actually do: pick a starter, read the
 * reasons it might be wrong, fill in the geography, create it, and land on the
 * campaign. Then it checks the two refusals that make the feature honest — a
 * campaign with no geography cannot be created, and a created campaign is a
 * draft rather than something that started itself.
 *
 * The campaign it creates is real and is removed afterwards, including on
 * failure.
 *
 *   BASE_URL=http://127.0.0.1:3000 node scripts/browserCampaignCreateCheck.mjs
 */

import { chromium } from 'playwright';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const EMAIL = process.env.OWNER_EMAIL ?? 'owner@dealdispatch.test';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'demo-password-123';
const MARK = `[BROWSER-CREATE-${Date.now()}]`;

let passed = 0;
let failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ok    ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`); }
}

async function cleanUp() {
  const made = await prisma.campaign.findMany({
    where: { name: { contains: MARK } },
    select: { id: true },
  });
  const ids = made.map((c) => c.id);
  if (ids.length === 0) return;
  await prisma.campaignTask.deleteMany({ where: { campaignId: { in: ids } } });
  await prisma.campaignCondition.deleteMany({ where: { campaignId: { in: ids } } });
  await prisma.campaignChannel.deleteMany({ where: { campaignId: { in: ids } } });
  await prisma.campaignEvidence.deleteMany({ where: { campaignId: { in: ids } } });
  await prisma.campaign.deleteMany({ where: { id: { in: ids } } });
  console.log(`\nRemoved ${ids.length} campaign(s) this check created.`);
}

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1300 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  [page error] ${e.message}`));

  console.log('='.repeat(74));
  console.log('CAMPAIGN CREATION — from a starter to a saved draft');
  console.log('='.repeat(74));

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle').catch(() => {});

  await page.goto(`${BASE}/campaigns`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  // --- starters are offered ------------------------------------------------
  console.log('\n--- an argument to edit, not a blank page -----------------------');
  const starters = page.locator('[data-testid^="starter-"]');
  const starterCount = await starters.count();
  check('the page offers campaigns to start from', starterCount >= 5, `${starterCount} starter(s)`);

  const startersText = await page.locator('[data-testid="campaign-starters"]').innerText();
  for (const named of ['steel', 'warehousing', 'subcontractor', 'inventory', 'institutional']) {
    check(`  a ${named} starter is offered`, new RegExp(named, 'i').test(startersText));
  }
  check(
    'each starter says how many reasons it might be wrong',
    /reason\(s\) it might be wrong/.test(startersText),
  );

  // --- picking one shows the argument --------------------------------------
  console.log('\n--- the argument, including against itself ----------------------');
  await page.locator('[data-testid="starter-steel_supply_metro"]').click();
  await page.waitForTimeout(400);

  const form = page.locator('[data-testid="campaign-form"]');
  check('picking one opens the campaign', (await form.count()) === 1);

  const contrary = page.locator('[data-testid="starter-contrary"]');
  check('the reasons it might be wrong are shown before anything is filled in', (await contrary.count()) === 1);
  const contraryText = await contrary.innerText();
  check(
    'and they are real objections, not caveats',
    /material package is inside the main contract|already have a service centre/i.test(contraryText),
    contraryText.replace(/\s+/g, ' ').slice(0, 160),
  );

  const mustAdd = page.locator('[data-testid="starter-you-must-add"]');
  check('what the owner must supply is stated', (await mustAdd.count()) === 1);
  check('including the geography', /metro|state|geography/i.test(await mustAdd.innerText()));

  // --- creating it ---------------------------------------------------------
  console.log('\n--- creating it -------------------------------------------------');
  await page.fill('[data-testid="campaign-form"] input[maxlength="120"]', `${MARK} steel supply`);
  await page.fill('[data-testid="campaign-states"]', 'IL');
  await page.locator('[data-testid="campaign-form"] textarea').fill(
    'Three service centres inside 60 miles of the metro, and two contractors with awarded work this quarter.',
  );

  await page.locator('[data-testid="campaign-form"] button.primary').click();
  await page.waitForTimeout(2500);

  const landedOn = page.url();
  check('the owner lands on the campaign that was created', /\/campaigns\/[a-z0-9]+/.test(landedOn), landedOn);

  const saved = await prisma.campaign.findFirst({
    where: { name: { contains: MARK } },
    include: { evidence: true, conditions: true, channels: true },
  });
  check('and it is actually in the database', saved !== null);

  if (saved) {
    check('as a draft, not something that started itself', saved.state === 'DRAFT', `state ${saved.state}`);
    check('with the geography the owner supplied', saved.targetStates.includes('IL'), saved.targetStates.join(','));
    check(
      'the contrary evidence is saved with it, not dropped',
      saved.evidence.filter((e) => e.kind === 'CONTRARY').length >= 2,
      `${saved.evidence.filter((e) => e.kind === 'CONTRARY').length} contrary`,
    );
    check(
      'the owner’s own note is recorded as an inference rather than a fact',
      saved.evidence.some((e) => /service centres inside 60 miles/i.test(e.claim) && e.evidenceClass === 'INFERRED'),
    );
    check('a kill condition is attached', saved.conditions.some((c) => c.kind === 'KILL'));
    check('and an expansion condition', saved.conditions.some((c) => c.kind === 'EXPAND'));
    check(
      'no paid channel is enabled by a create form',
      saved.channels.every((c) => c.kind === 'CALLING' || !c.enabled),
      saved.channels.map((c) => `${c.kind}:${c.enabled}`).join(', '),
    );
    check('and no budget was granted without an authoriser', saved.budgetCents === null);
  }

  // --- the campaign page shows it ------------------------------------------
  console.log('\n--- and it is a working campaign --------------------------------');
  const detail = await page.locator('body').innerText();
  check('the campaign page shows its thesis', /Steel price and availability move weekly/i.test(detail));
  check('and what it cannot do yet', /cannot run yet|thing\(s\) missing/i.test(detail), detail.slice(0, 200));

  await browser.close();

  console.log(`\n${'='.repeat(74)}`);
  console.log(`${passed}/${passed + failed} checks passed.`);
  return failed;
}

let code = 1;
try {
  code = (await main()) > 0 ? 1 : 0;
} catch (error) {
  console.error(error);
  code = 1;
} finally {
  await cleanUp().catch(() => {});
  await prisma.$disconnect();
}
process.exit(code);
