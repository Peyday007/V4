/**
 * The manager screen in a real browser.
 *
 * What is being checked is whether a person reading this page can tell four
 * things apart that all look alike in a database and must never look alike on
 * a screen:
 *
 *   A decision that is in force, and one that is recorded and doing nothing.
 *   A question about somebody, and a finding against them.
 *   A capability stopped by an outage, and one stopped because of a person.
 *   A number, and the absence of one.
 *
 * The third is the one with the most riding on it. A caller who sees "calling
 * paused" with no indication of whose fault it is spends the morning assuming
 * it is theirs.
 *
 *   npm run build && npx next start -p 3111
 *   DEMO_EMAIL=... DEMO_PASSWORD=... node scripts/browserSystemManagerCheck.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:3111';
let failures = 0;
let checks = 0;
const check = (label, ok, detail = '') => {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
};

async function signIn(page, base, email, password) {
  const response = await page.request.post(`${base}/api/auth/login`, {
    data: { email, password },
    failOnStatusCode: false,
  });
  if (!response.ok()) {
    const hint = response.status() === 429
      ? 'rate-limited — the login route allows ten attempts a minute per address. Wait a minute and re-run.'
      : await response.text();
    throw new Error(`Sign-in failed for ${email}: HTTP ${response.status()} — ${hint}`);
  }
  return response;
}

const scratch = mkdtempSync(join('scripts', '.manager-check-'));
function server(body) {
  const file = join(scratch, `step-${Date.now()}.ts`);
  writeFileSync(file, `async function main() {\n${body}\n}\nmain().catch((e) => { console.error(e); process.exit(1); });\n`);
  return execFileSync('npx', ['tsx', file], {
    encoding: 'utf8',
    env: { ...process.env, DIRECT_URL: process.env.DIRECT_URL ?? process.env.DATABASE_URL },
  }).trim();
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log(`  [page error] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') console.log(`  [console] ${m.text().slice(0, 200)}`); });

try {
  // -------------------------------------------------------------------------
  console.log('--- stage one of everything the screen has to distinguish -------');
  const stagedJson = server(`
    const { prisma } = await import('@/lib/db');
    const { RESTORATION } = await import('@/lib/manager/ladder');
    const { recordReadiness } = await import('@/lib/manager/readiness');

    const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
    const caller = await prisma.user.findFirst({
      where: { orgId: org.id, email: 'dana@dealdispatch.test' },
    });
    const route = await prisma.routeHypothesis.findFirst({ where: { orgId: org.id }, orderBy: { createdAt: 'asc' } });

    await prisma.intervention.deleteMany({ where: { orgId: org.id, producedBy: 'browser-check' } });
    await prisma.consistencyCase.deleteMany({ where: { orgId: org.id, producedBy: 'browser-check' } });
    await prisma.circuitBreaker.deleteMany({ where: { orgId: org.id, producedBy: 'browser-check' } });

    // An open question, with its innocent explanations.
    const question = await prisma.consistencyCase.create({
      data: {
        orgId: org.id, callerId: caller.id, routeId: route.id,
        kind: 'ATTEMPT_WITHOUT_EVIDENCE', dedupeKey: 'browser-check-' + Date.now(),
        observed: 'The call is recorded as reached decision maker and carries no notes and no facts.',
        expected: 'A call that reached somebody usually leaves at least one thing behind.',
        evidence: [{ label: 'the attempt', ref: 'OutreachAttempt:browser-check' }],
        benignAlternatives: [
          'The save dropped the notes after the disposition was recorded.',
          'The conversation was thirty seconds and genuinely had nothing in it.',
        ],
        producedBy: 'browser-check', ruleVersion: 'browser@1', confidence: 0.9,
        question: 'Do you remember what was said, or did the form lose it?',
      },
    });

    // One restriction in force, one decision recorded in shadow.
    await prisma.intervention.create({
      data: {
        orgId: org.id, callerId: caller.id, rung: 'RESTRICTED_MODE', capability: 'QUOTE_DRAFTING',
        attribution: 'OPERATOR', reason: 'Browser check: three confirmed pricing corrections.',
        evidence: [{ label: 'the cases', ref: 'ConsistencyCase:browser-check' }],
        restorationRule: RESTORATION.QUOTE_DRAFTING,
        producedBy: 'browser-check', ruleVersion: 'browser@1',
        state: 'ACTIVE', shadow: false, enforcedAt: new Date(),
      },
    });
    await prisma.intervention.create({
      data: {
        orgId: org.id, callerId: caller.id, rung: 'WARNING',
        attribution: 'OPERATOR', reason: 'Browser check: what the rules would have done.',
        evidence: [{ label: 'the cases', ref: 'ConsistencyCase:browser-check' }],
        producedBy: 'browser-check', ruleVersion: 'browser@1',
        state: 'SHADOW', shadow: true,
      },
    });

    // An outage, which is nobody's fault.
    await prisma.circuitBreaker.create({
      data: {
        orgId: org.id, capability: 'CALL_RECORDING', state: 'OPEN',
        openedAt: new Date(), openedBecause: 'Browser check: 9 of 10 captures produced nothing.',
        evidence: [{ label: 'fixture', ref: 'Audit:1' }],
        failureCount: 9, observedCount: 10, windowMinutes: 60,
        retryAt: new Date(Date.now() + 30 * 60000),
        producedBy: 'browser-check', ruleVersion: 'browser@1',
      },
    });

    await recordReadiness({ orgId: org.id, callerId: caller.id });

    console.log(JSON.stringify({ caseId: question.id, callerId: caller.id }));
  `);
  const staged = JSON.parse(stagedJson.split('\n').pop());
  check('the fixtures are in place', Boolean(staged.caseId));

  // -------------------------------------------------------------------------
  console.log('\n--- open the manager screen --------------------------------------');
  await signIn(page, BASE, process.env.DEMO_EMAIL ?? 'owner@dealdispatch.test',
    process.env.DEMO_PASSWORD ?? 'demo-password-123');
  await page.goto(`${BASE}/manager`);
  await page.waitForSelector('[data-testid="cases"]', { timeout: 20000 });
  check('the manager screen renders', true);

  // -------------------------------------------------------------------------
  console.log('\n--- a question looks like a question ------------------------------');
  const cases = await page.locator('[data-testid="case"]').count();
  check('the open questions are listed', cases > 0, `${cases}`);

  const benign = await page.locator('[data-testid="benign"]').allInnerTexts();
  check('every question shows the ordinary reasons it happens',
    benign.length === cases && benign.every((b) => /Ordinary reasons this happens/.test(b)),
    benign[0]?.split('\n')[1]?.slice(0, 70) ?? 'none');

  const actors = await page.locator('[data-testid="case-actor"]').allInnerTexts();
  check('and names what concluded it and which rules',
    actors.length === cases && actors.every((a) => /concluded by \S+@\S+/.test(a)),
    actors[0] ?? 'none');

  check('and says its confidence is about the records, not about a person',
    actors.every((a) => /sure the\s+records disagree/.test(a.replace(/\s+/g, ' ')) || /records disagree/.test(a)),
    actors[0] ?? '');

  const caseText = (await page.locator('[data-testid="case"]').first().innerText()).toLowerCase();
  check('and nothing on it calls anybody a liar',
    !/\b(lied|lying|liar|fraud|dishonest|falsif)\b/.test(caseText));

  // -------------------------------------------------------------------------
  console.log('\n--- in force and doing nothing are visibly different --------------');
  const active = await page.locator('[data-testid="active-intervention"]').count();
  check('a restriction in force is listed', active > 0, `${active}`);

  const restoration = await page.locator('[data-testid="restoration"]').allInnerTexts();
  check('and every one of them says how it ends',
    restoration.length === active
    && restoration.every((r) => r.trim().length > 20 && !/should not be possible/.test(r)),
    restoration[0]?.slice(0, 80) ?? 'none');

  const shadowRows = await page.locator('[data-testid="shadow-intervention"]').count();
  check('a decision recorded in shadow is listed separately', shadowRows > 0, `${shadowRows}`);

  const shadowText = await page.locator('[data-testid="shadow"]').innerText();
  check('and the section says plainly that they do nothing',
    /doing nothing/i.test(shadowText) && /not in force/i.test(shadowText),
    shadowText.split('\n')[1]?.slice(0, 90) ?? '');

  check('and each shadow row is individually labelled, not just the heading',
    (await page.locator('[data-testid="shadow-intervention"]').first().innerText())
      .match(/shadow, no effect|proposed, not applied/) !== null);

  // -------------------------------------------------------------------------
  console.log('\n--- an outage is not somebody\'s fault -----------------------------');
  const breakers = await page.locator('[data-testid="breaker"]').count();
  check('the stopped capability is listed', breakers > 0, `${breakers}`);

  const breakerSection = await page.locator('[data-testid="breakers"]').innerText();
  check('and the section says it is ours before it says anything else',
    /These are ours/.test(breakerSection),
    breakerSection.split('\n')[1]?.slice(0, 90) ?? '');
  check('and that nothing attempted during it counts against anybody',
    /counts against the person who attempted it/.test(breakerSection));

  const blockers = await page.locator('[data-testid="blocker"]').allInnerTexts();
  check('a blocked shift says whose problem it is on the row itself',
    blockers.length === 0 || blockers.every((b) => /^(ours|theirs):/.test(b.trim())),
    blockers[0]?.slice(0, 80) ?? 'no blockers today');

  // -------------------------------------------------------------------------
  console.log('\n--- the absence of a number is stated ------------------------------');
  const withheld = await page.locator('[data-testid="withheld-item"]').count();
  const withheldText = await page.locator('[data-testid="withheld"]').innerText();
  check('what could not be concluded is written down rather than left blank',
    withheld > 0 || /Nothing was withheld/.test(withheldText),
    withheldText.split('\n')[1]?.slice(0, 110) ?? '');

  const strengths = await page.locator('[data-testid="strengths"]').innerText();
  check('and the strengths section exists even when it has nothing to say',
    /Worth copying/.test(strengths));

  // -------------------------------------------------------------------------
  console.log('\n--- a caller sees none of it ---------------------------------------');
  const callerPage = await browser.newPage();
  await signIn(callerPage, BASE, 'dana@dealdispatch.test', process.env.DEMO_PASSWORD ?? 'demo-password-123');
  await callerPage.goto(`${BASE}/manager`);
  const callerBody = await callerPage.locator('body').innerText();
  check('a caller opening the manager screen is refused',
    !callerBody.includes('Records that do not line up') && !callerBody.includes('Recorded, doing nothing'),
    callerPage.url());
  await callerPage.close();

  // -------------------------------------------------------------------------
  server(`
    const { prisma } = await import('@/lib/db');
    const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
    await prisma.intervention.deleteMany({ where: { orgId: org.id, producedBy: 'browser-check' } });
    await prisma.consistencyCase.deleteMany({ where: { orgId: org.id, producedBy: 'browser-check' } });
    await prisma.circuitBreaker.deleteMany({ where: { orgId: org.id, producedBy: 'browser-check' } });
    console.log('cleaned');
  `);

  console.log(`\n${checks - failures}/${checks} checks passed.`);
} finally {
  await browser.close();
  rmSync(scratch, { recursive: true, force: true });
}

process.exitCode = failures > 0 ? 1 : 0;
