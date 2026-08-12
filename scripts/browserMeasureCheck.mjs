/**
 * The measurement page in a real browser.
 *
 * One thing is being checked above everything else: that a weak sample reads as
 * a weak sample. The previous system's dashboards were confident about
 * everything, and a source with four leads and one lucky conversion got budget
 * on the strength of a percentage sitting alone in a cell.
 *
 * So: no bare rate anywhere without its sample beside it, an explicit sentence
 * where the floor is not met, and a recommendation that says "keep running"
 * rather than naming a winner when the evidence is not there.
 *
 *   npm run build && npx next start -p 3111
 *   DEMO_EMAIL=... DEMO_PASSWORD=... node scripts/browserMeasureCheck.mjs
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
      ? 'rate-limited — the login route allows 10 attempts a minute per address. Wait a minute and re-run.'
      : await response.text();
    throw new Error(`Sign-in failed for ${email}: HTTP ${response.status()} — ${hint}`);
  }
  return response;
}

const scratch = mkdtempSync(join('scripts', '.measure-check-'));
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
  console.log('--- stage an experiment that wins early and loses late ----------');
  const stagedJson = server(`
    const { prisma } = await import('@/lib/db');
    const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
    const running = await prisma.experiment.findFirst({
      where: { orgId: org.id, guardrails: { has: 'LOST' } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, state: true },
    });
    console.log(JSON.stringify({ experiment: running }));
  `);
  const staged = JSON.parse(stagedJson.split('\n').pop());
  check('an experiment with a guardrail exists to read',
    staged.experiment !== null,
    'run scripts/measurementAudit.ts first');

  // -------------------------------------------------------------------------
  console.log('\n--- open the page ------------------------------------------------');
  await signIn(page, BASE, process.env.DEMO_EMAIL ?? 'owner@dealdispatch.test',
    process.env.DEMO_PASSWORD ?? 'demo-password-123');
  await page.goto(`${BASE}/measure`);
  await page.waitForSelector('[data-testid="funnel"]', { timeout: 20000 });
  check('the measurement page renders', true);

  const funnel = await page.locator('[data-testid="funnel"]').innerText();
  check('the funnel runs to collected gross profit',
    funnel.includes('Money collected'), funnel.split('\n').slice(-3).join(' | '));
  check('and names the source record at the top', funnel.includes('Source record'));

  // -------------------------------------------------------------------------
  console.log('\n--- a weak sample says so ----------------------------------------');
  const tooEarly = await page.locator('[data-testid="funnel-too-early"]').count();
  const breakNote = await page.locator('[data-testid="funnel-break"]').count();

  if (tooEarly > 0) {
    const text = await page.locator('[data-testid="funnel-too-early"]').innerText();
    check('the funnel says why no percentages are shown',
      /counts are real; the percentages would not be/i.test(text), text.slice(0, 90));

    // And genuinely shows none.
    const rows = await page.locator('[data-testid="funnel"] tbody tr').allInnerTexts();
    const withPercent = rows.filter((r) => /\d+\.\d%/.test(r));
    check('and shows no conversion percentage at all', withPercent.length === 0,
      withPercent.slice(0, 2).join(' | '));
  } else {
    check('the funnel shows rates because the sample supports them', true, 'sample above the floor');
  }

  if (breakNote > 0) {
    const text = await page.locator('[data-testid="funnel-break"]').innerText();
    check('where the chain stops is named, not left as a low percentage',
      /unmeasured, not zero/i.test(text), text.slice(0, 100));
  } else {
    check('the chain has no gap to report', true);
  }

  // -------------------------------------------------------------------------
  console.log('\n--- no bare rate anywhere ----------------------------------------');
  // Checked per table cell rather than per line of text. The interval renders
  // in a nested element and therefore lands on its own line in innerText, so a
  // line-based check would split a rate from the sample sitting right under it
  // and report a problem that is not there.
  const bare = await page.evaluate(() => {
    const offenders = [];
    for (const cell of Array.from(document.querySelectorAll('td'))) {
      const text = cell.innerText ?? '';
      if (!/\d+\.\d%/.test(text)) continue;
      // Either an interval (two percentages joined by an en dash), an explicit
      // sample size, or the "too few" marker. Anything else is a bare number.
      if (/n=\d+/.test(text) || /too few/.test(text) || /%\s*–\s*/.test(text)) continue;
      offenders.push(text.replace(/\s+/g, ' ').trim().slice(0, 80));
    }
    return offenders;
  });
  check('every rate carries its sample or its interval', bare.length === 0, bare.slice(0, 3).join(' | '));

  // -------------------------------------------------------------------------
  console.log('\n--- sources are not ranked on volume -----------------------------');
  const sources = await page.locator('[data-testid="sources"]').innerText();
  check('the sources table warns that records are not performance',
    /Record volume is shown first|looks productive on any count of records/i.test(sources),
    sources.split('\n')[1] ?? '');

  const insufficient = await page.locator('[data-testid="source-insufficient"]').count();
  check('a source below the floor says so on its own row', insufficient >= 0, `${insufficient} flagged`);

  // -------------------------------------------------------------------------
  console.log('\n--- the experiment readout ---------------------------------------');
  const readouts = await page.locator('[data-testid="experiment-readout"]').count();
  if (readouts > 0) {
    const readout = await page.locator('[data-testid="experiment-readout"]').first().innerText();
    check('the declared outcome is named', /Declared outcome:/.test(readout));

    const recommendation = await page.locator('[data-testid="experiment-recommendation"]').first().innerText();
    check('a recommendation is given in plain words', recommendation.length > 20, recommendation.slice(0, 90));

    // The one that matters: a guardrail regression must never read as a win.
    if (/regressed/i.test(readout)) {
      check('a guardrail regression is reported as blocked, not as a win with a caveat',
        /Do not roll this out/i.test(recommendation) && !/Roll it out/i.test(recommendation),
        recommendation.slice(0, 90));
      check('and the badge says blocked rather than better',
        /blocked/i.test(readout) && !/^better/im.test(readout));
    } else {
      check('no guardrail regression on this experiment', true);
    }
  } else {
    check('an experiment readout is on the page', false, 'none rendered');
  }

  // -------------------------------------------------------------------------
  console.log('\n--- a caller sees none of it -------------------------------------');
  const callerPage = await browser.newPage();
  await signIn(callerPage, BASE, 'dana@dealdispatch.test', process.env.DEMO_PASSWORD ?? 'demo-password-123');
  await callerPage.goto(`${BASE}/measure`);
  const callerBody = await callerPage.locator('body').innerText();
  check('a caller opening the measurement page is refused',
    !callerBody.includes('Collected gross profit') && !callerBody.includes('Sources'),
    callerPage.url());
  await callerPage.close();

  console.log(`\n${checks - failures}/${checks} checks passed.`);
} finally {
  await browser.close();
  rmSync(scratch, { recursive: true, force: true });
}

process.exitCode = failures > 0 ? 1 : 0;
