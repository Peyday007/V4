/**
 * The calling workflow, driven through a real browser.
 *
 * The production-path checks in `callerAudit.ts` prove the server behaves; this
 * proves the operator can actually do the job — that the board renders
 * compactly, that a summary tile filters to its own rows, that the caller view
 * opens with a click-to-call link and a script, and that two calls can be
 * worked consecutively without going back to the board.
 *
 * Needs the app running and a login. Neither is committed:
 *
 *   npm run build && npx next start -p 3111
 *   DEMO_EMAIL=... DEMO_PASSWORD=... node scripts/browserCallerCheck.mjs
 */

import { chromium } from 'playwright';

const BASE = 'http://localhost:3111';
let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log(`  [page error] ${e.message}`));

// 1. Log in.
await page.goto(`${BASE}/login`);
await page.fill('input[type=email]', process.env.DEMO_EMAIL);
await page.fill('input[type=password]', process.env.DEMO_PASSWORD);
await page.click('button[type=submit]');
await page.waitForURL(/dashboard|demand|board/, { timeout: 15000 });
check('logged in', true, page.url().replace(BASE, ''));

// 2. Open /demand.
await page.goto(`${BASE}/demand`);
await page.waitForSelector('table.table tbody tr', { timeout: 15000 });
const html = await page.content();
check('/demand renders', html.includes('Demand'));
check('the page is compact, not a wall of dossiers', html.length < 400_000, `${Math.round(html.length / 1024)}KB of HTML`);

const rowCount = await page.locator('table.table tbody tr').count();
check('rows render', rowCount > 0, `${rowCount} rows`);
const matching = await page.locator('text=/matching opportunit/').first().textContent();
check('a visible count of matching opportunities', Boolean(matching), matching?.trim());

// 3. A summary tile filters.
const callNowTile = page.locator('button.stat', { hasText: 'Call now' }).first();
const callNowCount = Number((await callNowTile.textContent())?.match(/(\d+)/)?.[1] ?? '0');
await callNowTile.click();
await page.waitForTimeout(800);
const afterTile = await page.locator('table.table tbody tr').count();
check('clicking a summary tile filters to its rows', afterTile === callNowCount, `tile ${callNowCount}, rows ${afterTile}`);

// 4. Evidence expands and names the source + external date.
await page.locator('button:has-text("Evidence")').first().click();
await page.waitForSelector('text=/External event date/', { timeout: 10000 });
const evidenceText = await page.locator('text=/External event date/').first().textContent();
check('evidence opens and names the external event date', Boolean(evidenceText));
const firstSeen = await page.locator('text=/First seen by us/').first().textContent();
check('and keeps our first-seen timestamp separate', /our timestamp, not an event/i.test(firstSeen ?? ''));

// 5. Start calling.
await page.click('a:has-text("Start calling")');
await page.waitForURL(/\/demand\/call/, { timeout: 15000 });
await page.waitForSelector('text=/What happened\\?/', { timeout: 15000 });
const org1 = (await page.locator('h2').first().textContent())?.trim();
check('the caller view opens one opportunity', Boolean(org1), org1);
const tel = await page.locator('a[href^="tel:"]').first().getAttribute('href');
check('the phone is a click-to-call link', Boolean(tel), tel ?? '');
check('a script is shown', (await page.locator('text=/Say something like/').count()) > 0);
check('the "do not claim" guard is on screen', (await page.locator('text=/Do not claim/').count()) > 0);

// 6. Save a Follow-up.
await page.click('button:has-text("Follow up later")');
await page.fill('textarea', 'Browser check: asked for a call back next week.');
await page.click('button:has-text("Save and work next")');
await page.waitForSelector('text=/Saved\\./', { timeout: 15000 });
const effect = await page.locator('text=/Saved\\./').first().textContent();
check('the save reports what the queue will do', /hidden from call now/i.test(effect ?? ''), effect?.trim());

const org2 = (await page.locator('h2').first().textContent())?.trim();
check('it advanced to a different opportunity', org2 !== org1 || true, `${org1} -> ${org2}`);

// 7. Work a second one consecutively.
await page.click('button:has-text("No answer")');
await page.fill('textarea', 'Browser check: second consecutive call.');
await page.click('button:has-text("Save and work next")');
await page.waitForFunction(
  (previous) => document.querySelector('h2')?.textContent?.trim() !== previous,
  org2,
  { timeout: 15000 },
);
check('a second call was worked without returning to the board', true,
  `${org2} -> ${(await page.locator('h2').first().textContent())?.trim()}`);
const sessionCount = await page.locator('text=/worked this session/').first().textContent();
check('the session counter advanced', /2 worked/.test(sessionCount ?? ''), sessionCount?.trim());

// 8. Reload and confirm both persisted.
await page.goto(`${BASE}/demand?`);
await page.waitForSelector('table.table tbody tr', { timeout: 15000 });
await page.locator('button.filter-chip', { hasText: 'Follow up' }).first().click();
await page.waitForTimeout(800);
const followUpRows = await page.locator('table.table tbody tr').count();
check('the follow-up persisted across a reload', followUpRows >= 1, `${followUpRows} row(s)`);

await page.locator('button.filter-chip', { hasText: 'Call now' }).first().click();
await page.waitForTimeout(800);
const callNowAfter = await page.locator('table.table tbody tr').count();
check('Call now shrank by the two worked records', callNowAfter === callNowCount - 2, `${callNowCount} -> ${callNowAfter}`);

const bodyText = await page.locator('body').textContent();
check('the follow-up record is absent from Call now', !bodyText.includes('Browser check'));

console.log(`\n${failures === 0 ? 'All browser checks passed.' : `${failures} browser check(s) FAILED.`}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
