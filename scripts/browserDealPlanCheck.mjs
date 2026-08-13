/**
 * The opportunity page, as something an owner acts on.
 *
 * The directive this implements asks for one thing above all: the owner
 * interface has to identify the first broken stage and the exact next action.
 * That is checked here against the real page, on a real route, rather than
 * against the function that computes it — because a plan that is correct and
 * not rendered is a plan nobody follows.
 *
 * Also checks the thing that is easy to get wrong in the other direction: the
 * evidence has not been deleted to make room, it has been folded away. An owner
 * who wants to know why we believe any of it must still be one click from it.
 *
 *   npm run build && npx next start -p 3111
 *   node scripts/browserDealPlanCheck.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:3111';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'demo-password-123';

let failures = 0;
let checks = 0;
const check = (label, ok, detail = '') => {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
};

const scratch = mkdtempSync(join('scripts', '.deal-plan-check-'));
function server(body) {
  const file = join(scratch, `step-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(file, `async function main() {\n${body}\n}\nmain().catch((e) => { console.error(e); process.exit(1); });\n`);
  return execFileSync('npx', ['tsx', file], {
    encoding: 'utf8',
    env: { ...process.env, DIRECT_URL: process.env.DIRECT_URL ?? process.env.DATABASE_URL },
  }).trim().split('\n').pop();
}

async function signIn(page, email) {
  const response = await page.request.post(`${BASE}/api/auth/login`, {
    data: { email, password: PASSWORD }, failOnStatusCode: false,
  });
  if (!response.ok()) throw new Error(`Sign-in failed for ${email}: HTTP ${response.status()}`);
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});

try {
  // A real production route, chosen by the database rather than hard-coded, so
  // this keeps working after a reseed.
  const routeId = server(`
    const { prisma } = await import('@/lib/db');
    const org = await prisma.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
    const route = await prisma.routeHypothesis.findFirstOrThrow({
      where: { orgId: org.id, dataMode: 'PRODUCTION', status: { notIn: ['EXPIRED', 'REJECTED'] } },
      orderBy: { createdAt: 'asc' }, select: { id: true },
    });
    console.log(route.id);
  `);

  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  [page error] ${e.message}`));
  await signIn(page, process.env.DEMO_EMAIL ?? 'owner@dealdispatch.test');

  console.log('--- the plan is the first thing on the page ----------------------');
  await page.goto(`${BASE}/demand/opportunity/${routeId}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="deal-plan"]', { timeout: 20000 });
  check('the opportunity page renders a plan', true, routeId);

  const headline = (await page.locator('[data-testid="plan-headline"]').innerText()).trim();
  check('and says in one line what the state of it is', headline.length > 10, headline.slice(0, 90));

  // The plan must come before the evidence in the document, not just exist.
  const order = await page.evaluate(() => {
    const plan = document.querySelector('[data-testid="deal-plan"]');
    const evidence = document.querySelector('[data-testid="evidence-detail"]');
    if (!plan || !evidence) return null;
    return plan.compareDocumentPosition(evidence) & Node.DOCUMENT_POSITION_FOLLOWING ? 'plan first' : 'evidence first';
  });
  check('the plan comes before the evidence', order === 'plan first', order ?? 'one of them is missing');

  console.log('\n--- the first broken stage, and what to do about it --------------');
  const broken = await page.locator('[data-testid="first-broken"]').count();
  const waiting = await page.locator('[data-testid="waiting-on"]').count();
  check('either a broken stage or a waiting note is shown', broken > 0 || waiting > 0,
    broken > 0 ? 'blocked' : 'waiting');

  if (broken > 0) {
    const label = (await page.locator('[data-testid="first-broken-label"]').innerText()).trim();
    const action = (await page.locator('[data-testid="first-broken-action"]').innerText()).trim();
    const block = (await page.locator('[data-testid="first-broken"]').innerText());
    check('the broken stage is named', label.length > 0, label);
    check('and carries an actual next action', action.length > 10, action.slice(0, 80));
    check('and says who does it', /Who:/.test(block));
    check('and what makes it finished', /Done when:/.test(block));
    check('and what evidence that needs', /Evidence:/.test(block));
  }

  console.log('\n--- the whole chain is available, collapsed ----------------------');
  const stagesHidden = await page.locator('[data-testid="stage-DATED_DEMAND"]').isVisible();
  check('the full chain is folded away by default', stagesHidden === false);
  await page.locator('[data-testid="plan-stages"] summary').click();
  await page.waitForTimeout(300);
  const rows = await page.locator('[data-testid^="stage-"]').count();
  check('and opens to the full chain', rows === 12, `${rows} stages`);

  const chain = await page.locator('[data-testid="plan-stages"]').innerText();
  for (const rung of ['A dated demand event', 'A requirement they confirmed', 'Gross profit collected']) {
    check(`the chain names "${rung}"`, chain.includes(rung));
  }

  console.log('\n--- the evidence is folded, not deleted --------------------------');
  const evidenceHidden = await page.locator('[data-testid="evidence-detail"] .grid').first().isVisible();
  check('the diagnostics are collapsed behind a control', evidenceHidden === false);
  await page.locator('[data-testid="evidence-detail"] > summary').click();
  await page.waitForTimeout(300);
  const evidence = await page.locator('[data-testid="evidence-detail"]').innerText();
  for (const section of ['Confirmed by the source', 'Confirmed by a person', 'Our hypothesis', 'Unknown, and blocking']) {
    check(`the evidence still has "${section}"`, evidence.includes(section));
  }

  await context.close();
  console.log(`\n${checks - failures}/${checks} checks passed.`);
} finally {
  await browser.close();
  rmSync(scratch, { recursive: true, force: true });
}

process.exitCode = failures > 0 ? 1 : 0;
