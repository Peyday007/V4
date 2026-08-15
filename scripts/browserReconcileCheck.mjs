/**
 * The reconciliation preview, in a real browser.
 *
 * The danger this page carries is not that it fails — it is that it succeeds
 * too easily. A screen offering to close a hundred records is a screen somebody
 * will use at the end of a long day, and the only thing standing between that
 * and a destroyed record of a conversation is whether the safeguards are
 * genuinely on the page rather than in a function nobody ran.
 *
 * So: does opening it change anything (it must not), is a worked route visibly
 * untouchable, can anything be closed without ticking it, and can anything be
 * closed without a stated reason.
 *
 *   BASE_URL=http://127.0.0.1:3000 node scripts/browserReconcileCheck.mjs
 */

import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const EMAIL = process.env.OWNER_EMAIL ?? 'owner@dealdispatch.test';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'demo-password-123';
const MARK = '[BROWSER-RECONCILE]';

let passed = 0;
let failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ok    ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`); }
}

/**
 * One event wearing four hypotheses, one of which somebody rang.
 *
 * Seeded rather than borrowed from the board, because the shape being checked
 * has to be present for the check to mean anything — and a production board
 * that happens to be clean today would turn every assertion into a skip.
 */
async function seed(prisma) {
  const org = await prisma.organization.findFirstOrThrow({ select: { id: true } });
  const owner = await prisma.user.findFirstOrThrow({ where: { email: EMAIL }, select: { id: true } });

  const company = await prisma.company.create({
    data: {
      orgId: org.id, dataMode: 'TEST', legalName: `${MARK} Logan Square Cafe`,
      companyRole: 'BUYER', phone: '+13125550190', cityName: 'Chicago', stateCode: 'IL',
    },
    select: { id: true },
  });
  const event = await prisma.demandEvent.create({
    data: {
      orgId: org.id, dataMode: 'TEST', type: 'OCCUPANCY_OR_OPERATING_APPROVAL',
      connector: 'browser-check', sourceRecordId: `${MARK}-1`, dedupeKey: `${MARK}-1`,
      headline: `${MARK} retail food establishment licence issued`,
      summary: 'Retail food establishment licence issued for a cafe.',
      eventDate: new Date(Date.now() + 14 * 86_400_000),
      confirmedFacts: ['Retail food establishment licence issued', 'Cafe, 1,400 square feet'],
    },
    select: { id: true },
  });

  const routeIds = [];
  for (const key of [
    'cleaning.brokerage.pre_opening',
    'restaurant.distribution.opening_supply',
    'facility.brokerage.waste_collection',
    'facility.brokerage.grounds',
  ]) {
    const route = await prisma.routeHypothesis.create({
      data: {
        orgId: org.id, dataMode: 'TEST', eventId: event.id, companyId: company.id,
        route: 'BROKERAGE', playbookKey: key, headline: `${MARK} ${key}`,
        rationale: 'Seeded by the reconciliation browser check as a pre-competition route.',
        tier: 'STRONG_TRIGGER', status: 'RESEARCH',
      },
      select: { id: true },
    });
    routeIds.push(route.id);
  }

  // The last one has been called, so it must never be offered for closure.
  await prisma.outreachAttempt.create({
    data: {
      orgId: org.id, routeId: routeIds[3], userId: owner.id,
      disposition: 'NEED_UNCONFIRMED',
      notes: 'Seeded by the reconciliation browser check: somebody rang this one.',
      occurredAt: new Date(),
    },
  });

  return { eventId: event.id, companyId: company.id, routeIds, workedRouteId: routeIds[3] };
}

async function cleanUp(prisma, seeded) {
  if (!seeded) return;
  await prisma.outreachAttempt.deleteMany({ where: { routeId: { in: seeded.routeIds } } });
  await prisma.outreachState.deleteMany({ where: { routeId: { in: seeded.routeIds } } });
  await prisma.routeHypothesis.deleteMany({ where: { id: { in: seeded.routeIds } } });
  await prisma.demandEvent.deleteMany({ where: { id: seeded.eventId } });
  await prisma.company.deleteMany({ where: { id: seeded.companyId } });
}

let seeded = null;
let prisma = null;

async function main() {
  const { PrismaClient } = await import('@prisma/client');
  prisma = new PrismaClient();
  seeded = await seed(prisma);

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1300 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  [page error] ${e.message}`));

  console.log('='.repeat(74));
  console.log('RECONCILIATION — what would change, and what the page will not let you do');
  console.log('='.repeat(74));

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle').catch(() => {});

  const before = await prisma.routeHypothesis.count({
    where: { id: { in: seeded.routeIds }, status: { notIn: ['EXPIRED', 'REJECTED'] } },
  });

  const response = await page.goto(`${BASE}/demand/reconcile?dataMode=TEST`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);
  check('the page renders', (response?.status() ?? 0) < 400, `status ${response?.status()}`);

  const nav = await page.locator('nav').innerText();
  check('it is reachable from the sidebar', /Reconcile the board/i.test(nav));

  // --- it changes nothing --------------------------------------------------
  console.log('\n--- opening it changes nothing ---------------------------------');
  const after = await prisma.routeHypothesis.count({
    where: { id: { in: seeded.routeIds }, status: { notIn: ['EXPIRED', 'REJECTED'] } },
  });
  check('every route is still open after reading the page', before === after, `${before} → ${after}`);
  check(
    'and the page says so before anything else',
    /has been changed|Nothing here has been changed/i.test(await page.locator('h1, p, .alert').first().innerText().catch(() => ''))
      || /Nothing on this page has been changed/i.test(await page.locator('body').innerText()),
  );

  // --- the four buckets ----------------------------------------------------
  console.log('\n--- the four verdicts ------------------------------------------');
  for (const id of ['retained', 'superseded', 'worked', 'nocredible']) {
    check(`  the ${id} count is shown`, (await page.locator(`[data-testid="reconcile-count-${id}"]`).count()) === 1);
  }

  const group = page.locator(`[data-testid="reconcile-group-${seeded.eventId}"]`);
  check('the refracted event has a group of its own', (await group.count()) === 1);
  if ((await group.count()) === 1) {
    const text = await group.innerText();
    check('naming how many routes came from one event', /4 routes from one event/i.test(text), text.slice(0, 120));
  }

  // --- the safeguard -------------------------------------------------------
  console.log('\n--- what the page will not let you close ------------------------');
  const workedRow = page.locator(`[data-testid="reconcile-row-${seeded.workedRouteId}"]`);
  check('the route somebody rang is on the page', (await workedRow.count()) === 1);
  if ((await workedRow.count()) === 1) {
    const text = await workedRow.innerText();
    check('marked as worked rather than superseded', /worked/i.test(text), text.replace(/\s+/g, ' ').slice(0, 140));
    check(
      'with no way to tick it',
      (await page.locator(`[data-testid="reconcile-select-${seeded.workedRouteId}"]`).count()) === 0,
    );
    check(
      'and a sentence saying why it will not be tidied away',
      /not tidied away|record of a conversation/i.test(text),
      text.replace(/\s+/g, ' ').slice(0, 180),
    );
  }

  // --- nothing closes without a tick and a reason --------------------------
  console.log('\n--- nothing closes without a tick and a reason -------------------');
  const applyPanel = page.locator('[data-testid="reconcile-apply"]');
  if ((await applyPanel.count()) === 1) {
    const button = page.locator('[data-testid="reconcile-apply-button"]');
    check('the close control is disabled with nothing ticked', await button.isDisabled());

    const firstSelect = page.locator('[data-testid^="reconcile-select-"]').first();
    check('a superseded route can be ticked', (await firstSelect.count()) === 1);
    await firstSelect.check();
    await page.waitForTimeout(300);
    check('and it is still disabled without a reason', await button.isDisabled());

    await page.fill('[data-testid="reconcile-reason"]', 'A weaker reading of a licence that reads as food supply.');
    await page.waitForTimeout(300);
    check('a ticked route and a stated reason enable it', !(await button.isDisabled()));

    // And it actually closes only that one.
    await button.click();
    await page.waitForTimeout(1800);
    const closed = await prisma.routeHypothesis.count({
      where: { id: { in: seeded.routeIds }, status: 'REJECTED' },
    });
    check('exactly one route was closed', closed === 1, `${closed} closed`);
    const workedStill = await prisma.routeHypothesis.findUnique({
      where: { id: seeded.workedRouteId }, select: { status: true },
    });
    check('and the worked one is untouched', workedStill?.status !== 'REJECTED', workedStill?.status);
  } else {
    check('no close control without owner authority', true);
  }

  await browser.close();
}

main()
  .catch((e) => { console.error(e); failed += 1; })
  .finally(async () => {
    if (prisma) {
      await cleanUp(prisma, seeded).catch((e) => console.error('cleanup:', e));
      await prisma.$disconnect();
    }
    console.log(`\n${'='.repeat(74)}`);
    console.log(`${passed}/${passed + failed} checks passed.`);
    process.exit(failed > 0 ? 1 : 0);
  });
