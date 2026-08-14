/**
 * The campaign detail page, in a real browser.
 *
 * A campaign model that exists in the schema and a campaign an owner can
 * actually read and act on are different things, and the second is what was
 * asked for. So this seeds a practice campaign through the real service layer,
 * opens the page somebody would open, and asserts that the operating document
 * is there: the thesis, the evidence *against* it beside the evidence for it,
 * what testing costs and who authorised it, every channel with its authority
 * and its downstream metric, the outcome chain through collected gross profit
 * with the first empty rung named, the kill and expansion conditions with their
 * current values, and the work the campaign generated.
 *
 * Everything it creates is TEST-mode and removed afterwards, including on
 * failure — a browser check that leaves debris behind is how the replenishment
 * audit started failing for reasons that had nothing to do with replenishment.
 *
 *   BASE_URL=http://127.0.0.1:3000 node scripts/browserCampaignCheck.mjs
 */

import { chromium } from 'playwright';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const EMAIL = process.env.OWNER_EMAIL ?? 'owner@dealdispatch.test';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'demo-password-123';
const MARK = '[BROWSER-CAMPAIGN]';

let passed = 0;
let failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ok    ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`); }
}

async function seed() {
  const org = await prisma.organization.findFirstOrThrow({ select: { id: true } });
  const owner = await prisma.user.findFirstOrThrow({ where: { email: EMAIL }, select: { id: true } });

  const campaign = await prisma.campaign.create({
    data: {
      orgId: org.id,
      dataMode: 'TEST',
      name: `${MARK} post-opening cleans`,
      state: 'RUNNING',
      startedAt: new Date(Date.now() - 3 * 86_400_000),
      authorityGrantedById: owner.id,
      authorityGrantedAt: new Date(),
      thesis:
        'Businesses granted an operating licence need a first deep clean before opening, and almost none of '
        + 'them have a cleaning contractor arranged at that point.',
      whyNow: 'The licence record is dated, so the window is known rather than guessed.',
      route: 'BROKERAGE',
      targetStates: ['IL'],
      buyerProfile: 'An independent operator granted a licence at a named address.',
      providerProfile: 'A local cleaning contractor with capacity for a one-off pre-opening job.',
      requiredCapability: 'Post-construction cleaning',
      testingHours: 12,
      testingCostCents: 0,
      testingCostBasis: 'Twelve hours of calling at no cash cost.',
      budgetCents: null,
      createdById: owner.id,
      evidence: {
        create: [
          {
            orgId: org.id, kind: 'SUPPORTING',
            claim: 'Licence records carry a dated start, so a cleaning window can be derived rather than guessed.',
            evidenceClass: 'EXTERNALLY_OBSERVED',
            sourceUrl: 'https://data.cityofchicago.org/resource/r5kz-chrr.json',
            observedAt: new Date('2026-01-14T00:00:00Z'),
          },
          {
            orgId: org.id, kind: 'CONTRARY',
            claim: 'The general contractor often has the final clean inside their own scope.',
            evidenceClass: 'INFERRED',
          },
        ],
      },
      channels: {
        create: [{ orgId: org.id, kind: 'CALLING', enabled: true, outcomeMetric: 'CONVERSATIONS_HELD' }],
      },
      conditions: {
        create: [
          {
            orgId: org.id, kind: 'KILL', metric: 'CONVERSATIONS_HELD', comparator: 'AT_OR_BELOW',
            threshold: 0, afterDays: 14,
            statement: 'Stop if nobody has been spoken to after a fortnight.',
          },
          {
            orgId: org.id, kind: 'EXPAND', metric: 'COLLECTED_GROSS_PROFIT', comparator: 'AT_OR_ABOVE',
            threshold: 500,
            statement: 'Widen once five hundred of gross profit has actually been collected.',
          },
        ],
      },
    },
    select: { id: true },
  });

  // One completed task and one that found nothing, because "what it found" and
  // "why it found nothing" are both things the page has to be able to show.
  await prisma.campaignTask.createMany({
    data: [
      {
        orgId: org.id, campaignId: campaign.id, dataMode: 'TEST',
        kind: 'find_published_number', intent: 'Find a published telephone number.',
        status: 'DONE', result: '+1 312 555 0143', evidenceClass: 'EXTERNALLY_OBSERVED',
        sourceUrl: 'https://example.invalid/listing', completedAt: new Date(),
      },
      {
        orgId: org.id, campaignId: campaign.id, dataMode: 'TEST',
        kind: 'source_providers', intent: 'Find providers who could do this work.',
        status: 'FAILED',
        because: 'No company in the catalogue holds post-construction cleaning in Illinois.',
      },
    ],
  });

  return { campaignId: campaign.id, orgId: org.id };
}

async function cleanUp(campaignId) {
  if (!campaignId) return;
  await prisma.campaignTask.deleteMany({ where: { campaignId } });
  await prisma.campaignCondition.deleteMany({ where: { campaignId } });
  await prisma.campaignChannel.deleteMany({ where: { campaignId } });
  await prisma.campaignEvidence.deleteMany({ where: { campaignId } });
  await prisma.campaign.deleteMany({ where: { id: campaignId } });
}

/** Set as soon as anything exists, so the cleanup in `finally` can find it. */
let seeded = null;

async function main() {
  const { campaignId } = await seed();
  seeded = campaignId;

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1200 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  [page error] ${e.message}`));

  console.log('='.repeat(72));
  console.log('CAMPAIGN — what an owner deciding whether to keep going actually sees');
  console.log('='.repeat(72));

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle').catch(() => {});

  // --- reachable from the sidebar, not only by deep link -------------------
  console.log('\n--- navigation --------------------------------------------------');
  const navLink = page.locator('nav a[href="/campaigns"]');
  check('campaigns is in the sidebar', (await navLink.count()) > 0);

  const response = await page.goto(`${BASE}/campaigns/${campaignId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  check('the campaign page renders', (response?.status() ?? 0) < 400, `status ${response?.status()}`);

  // --- the thesis ----------------------------------------------------------
  console.log('\n--- what it believes --------------------------------------------');
  const thesis = page.locator('[data-testid="campaign-thesis"]');
  check('the thesis is on the page', (await thesis.count()) === 1);
  const thesisText = await thesis.first().innerText();
  check('with why now', /Why now/i.test(thesisText));
  check('who buys', /Who buys/i.test(thesisText));
  check('and who delivers', /Who delivers/i.test(thesisText));

  // --- evidence both ways --------------------------------------------------
  console.log('\n--- evidence ----------------------------------------------------');
  const supporting = page.locator('[data-testid="campaign-supporting"]');
  const contrary = page.locator('[data-testid="campaign-contrary"]');
  check('evidence for is its own panel', (await supporting.count()) === 1);
  check('evidence against is its own panel', (await contrary.count()) === 1);

  const supportingText = await supporting.first().innerText();
  check('a supporting claim carries its class', /published|confirmed|calculated|inferred/.test(supportingText));
  check('and links its source', (await supporting.locator('a[href^="http"]').count()) > 0);
  check(
    'dated by what the source stated',
    /stated 2026-01-14/.test(supportingText),
    supportingText.slice(0, 140),
  );

  const contraryText = await contrary.first().innerText();
  check('the contrary evidence is shown, not buried', /general contractor/i.test(contraryText));

  // --- cost and authority --------------------------------------------------
  console.log('\n--- what finding out costs --------------------------------------');
  const cost = page.locator('[data-testid="campaign-cost"]');
  const costText = await cost.first().innerText();
  check('testing time is stated', /12h/.test(costText));
  check('spend authority is stated', /Spend authority/i.test(costText));
  check(
    'and no authority reads as none rather than as zero pounds',
    /none/i.test(costText),
    costText.replace(/\s+/g, ' ').slice(0, 160),
  );

  // --- channels ------------------------------------------------------------
  console.log('\n--- channels ----------------------------------------------------');
  const channels = page.locator('[data-testid="campaign-channels"]');
  const channelText = await channels.first().innerText();
  check('each channel names how it is measured', /Measured by/i.test(channelText));
  check('and the calling channel is there', /Calling/i.test(channelText));

  // --- the outcome chain ---------------------------------------------------
  console.log('\n--- what came back ----------------------------------------------');
  const outcome = page.locator('[data-testid="campaign-outcome"]');
  const outcomeText = await outcome.first().innerText();
  for (const rung of [
    'Routes generated', 'Conversations held', 'Requirements confirmed',
    'Providers verified', 'Quotes sent', 'Commitments won', 'Collected gross profit',
  ]) {
    check(`  the chain includes ${rung.toLowerCase()}`, outcomeText.includes(rung));
  }
  check(
    'the first empty rung is named rather than left to be worked out',
    /first empty rung/i.test(outcomeText),
    outcomeText.replace(/\s+/g, ' ').slice(0, 160),
  );
  check('and an empty rung says none rather than 0', !/\bRoutes generated\s*\n?\s*0\b/.test(outcomeText));

  // --- conditions ----------------------------------------------------------
  console.log('\n--- what would end it -------------------------------------------');
  const conditions = page.locator('[data-testid="campaign-conditions"]');
  const conditionText = await conditions.first().innerText();
  check('the kill condition is on the page', /Stop if nobody has been spoken to/i.test(conditionText));
  check('so is the expansion condition', /Widen once five hundred/i.test(conditionText));
  check(
    'each carries why it has not fired',
    /day\(s\) in|is not at or/i.test(conditionText),
    conditionText.replace(/\s+/g, ' ').slice(0, 200),
  );

  // --- generated work ------------------------------------------------------
  console.log('\n--- the work it generated ---------------------------------------');
  const work = page.locator('[data-testid="campaign-work"]');
  const workText = await work.first().innerText();
  check('a completed task shows what it found', /\+1 312 555 0143/.test(workText));
  check('with the class of that finding', /published/.test(workText));
  check(
    'and a task that found nothing says why rather than going blank',
    /No company in the catalogue holds/i.test(workText),
    workText.replace(/\s+/g, ' ').slice(0, 180),
  );

  // --- actions -------------------------------------------------------------
  console.log('\n--- what may be done to it --------------------------------------');
  const actions = page.locator('[data-testid="campaign-actions"]');
  check('the actions panel is present', (await actions.count()) === 1);
  const actionText = await actions.first().innerText();
  for (const action of ['Generate work', 'Run outstanding tasks', 'Pause', 'Kill', 'Conclude']) {
    check(`  ${action.toLowerCase()} is offered on a running campaign`, actionText.includes(action));
  }

  await browser.close();

  console.log(`\n${'='.repeat(72)}`);
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
  await cleanUp(seeded);
  await prisma.$disconnect();
}
process.exit(code);
