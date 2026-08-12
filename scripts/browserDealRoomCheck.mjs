/**
 * The Deal Room in a real browser, from both sides.
 *
 * The acceptance test this exists for is the one that cannot be checked any
 * other way: that the owner preview and the public page render the *same
 * thing*. Two renderers drift within a week, and the one nobody looks at is the
 * one the customer gets — so the substance of both pages is extracted and
 * compared directly rather than asserted separately.
 *
 * The rest is about language. A prospect must be able to tell what we know from
 * what we are guessing, must not be told fulfilment is arranged when it is not,
 * and must find declining as easy as accepting.
 *
 *   npm run build && npx next start -p 3111
 *   DEMO_EMAIL=... DEMO_PASSWORD=... node scripts/browserDealRoomCheck.mjs
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

/**
 * Sign in, and say plainly when it did not work.
 *
 * The login route rate-limits by address, which is right and which makes this
 * script's failure mode opaque: a 429 renders as a page that never navigates,
 * and Playwright reports a twenty-second timeout with no cause. Running the
 * request first turns that into one line naming the status.
 */
async function signIn(page, base, email, password) {
  const response = await page.request.post(`${base}/api/auth/login`, {
    data: { email, password },
    failOnStatusCode: false,
  });
  if (!response.ok()) {
    const hint = response.status() === 429
      ? 'rate-limited — the login route allows 10 attempts a minute per address, and the HTTP audits use most of them. Wait a minute and re-run.'
      : await response.text();
    throw new Error(`Sign-in failed for ${email}: HTTP ${response.status()} — ${hint}`);
  }
  return response;
}

const scratch = mkdtempSync(join('scripts', '.room-check-'));
function server(body) {
  const file = join(scratch, `step-${Date.now()}.ts`);
  writeFileSync(file, `async function main() {\n${body}\n}\nmain().catch((e) => { console.error(e); process.exit(1); });\n`);
  return execFileSync('npx', ['tsx', file], {
    encoding: 'utf8',
    env: { ...process.env, DIRECT_URL: process.env.DIRECT_URL ?? process.env.DATABASE_URL },
  }).trim();
}

/**
 * The substance of the page, with the preview's own annotations stripped.
 *
 * Compared as a list of visible strings rather than as HTML, because the two
 * pages legitimately differ in wrapper markup and must not differ in a word the
 * prospect reads.
 */
async function substance(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="room"]');
    if (!root) return null;
    const clone = root.cloneNode(true);
    for (const el of clone.querySelectorAll('[data-testid="preview-banner"], [data-testid="preview-reasoning"], form')) {
      el.remove();
    }
    return clone.innerText.replace(/\s+/g, ' ').trim();
  });
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
/**
 * A prospect's browser, not a robot's.
 *
 * Playwright's default user-agent contains "HeadlessChrome", which the product
 * correctly classifies as automation and correctly declines to count as a
 * reader. Driving the prospect's side with that agent would be testing the
 * scanner path while claiming to test the human one, so the context carries an
 * ordinary desktop Chrome string instead.
 */
const prospect = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
});
const page = await prospect.newPage();
page.on('pageerror', (e) => console.log(`  [page error] ${e.message}`));

try {
  // -------------------------------------------------------------------------
  console.log('--- stage a route with a candidate and no commitment -----------');
  const stagedJson = server(`
    const { prisma } = await import('@/lib/db');
    const { createRoom } = await import('@/lib/room/rooms');

    const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
    const route = await prisma.routeHypothesis.findFirst({
      where: { orgId: org.id, requirements: { some: { state: 'CURRENT' } } },
      orderBy: { createdAt: 'asc' },
    });
    if (!route) throw new Error('No route with a requirement. Run scripts/dealRoomAudit.ts first.');

    await prisma.dealRoomEvent.deleteMany({ where: { room: { routeId: route.id } } });
    await prisma.dealRoom.deleteMany({ where: { routeId: route.id } });

    const created = await createRoom({ orgId: org.id, routeId: route.id, force: true });
    if (!created.ok) throw new Error('createRoom refused: ' + created.message);

    console.log(JSON.stringify({
      routeId: route.id,
      token: created.room.token,
      roomId: created.room.id,
      organisation: created.content.organisation,
      proofStep: created.content.proofStep.kind,
    }));
  `);
  const staged = JSON.parse(stagedJson.split('\n').pop());
  check('a room was staged', Boolean(staged.token));

  // -------------------------------------------------------------------------
  console.log('\n--- the public page, as a stranger ------------------------------');
  await page.goto(`${BASE}/room/${staged.token}`);
  await page.waitForSelector('[data-testid="room"]', { timeout: 20000 });

  const publicText = await substance(page);
  check('the page renders with no session at all', publicText !== null);
  check('it names the prospect', publicText.includes(staged.organisation));

  check(
    'every claim carries where it came from',
    (await page.locator('.room-source').count()) > 0,
  );
  check(
    'our reading is separated from what they told us',
    (await page.locator('[data-testid="room-ours"]').count()) > 0,
  );
  check(
    'and is labelled as ours in words, not only by styling',
    publicText.includes('Our reading, not something you have told us'),
  );

  check(
    'the supply position is stated honestly',
    /we do not currently have a provider|none of them has committed/i.test(publicText),
    publicText.match(/(we do not currently have a provider|none of them has committed)[^.]*\./i)?.[0] ?? '',
  );
  // Matched as a positive claim rather than as a substring. The page's own
  // honest sentence — "we will not tell you fulfilment is arranged until it
  // is" — contains the words, and a test that fails on it would push the copy
  // toward being vaguer rather than more truthful.
  const claimsFulfilment = /(?<!not tell you )fulfilment (is|has been) (secured|arranged)(?! until)/i.test(publicText)
    || /we have (secured|arranged|lined up) (a |the )?provider/i.test(publicText)
    || /a provider is (secured|arranged|confirmed)/i.test(publicText);
  check('nothing on the page claims fulfilment is arranged', !claimsFulfilment);

  check(
    'no hype, urgency or fabricated savings',
    !/\b(act now|limited time|guaranteed|risk[- ]free|exclusive offer|don't miss|save \$)\b/i.test(publicText),
  );

  // -------------------------------------------------------------------------
  console.log('\n--- saying no is as easy as saying yes --------------------------');
  const actions = page.locator('[data-testid="room-actions"] button');
  check('the actions are a plain form that works without JavaScript',
    (await page.locator('[data-testid="room-actions"]').getAttribute('method')) === 'post');
  const labels = await actions.allInnerTexts();
  check('declining is a button of its own, not a hidden link',
    labels.some((l) => /not interested|stop contacting/i.test(l)), labels.join(' | '));
  check('and it is presented alongside the others, not buried', labels.length >= 3, `${labels.length} buttons`);

  // -------------------------------------------------------------------------
  console.log('\n--- the preview renders the same thing --------------------------');
  const owner = await browser.newPage();
  owner.on('pageerror', (e) => console.log(`  [owner page error] ${e.message}`));
  owner.on('console', (m) => { if (m.type() === 'error') console.log(`  [owner console] ${m.text().slice(0, 300)}`); });
  await signIn(owner, BASE, process.env.DEMO_EMAIL ?? 'owner@dealdispatch.test',
    process.env.DEMO_PASSWORD ?? 'demo-password-123');

  await owner.goto(`${BASE}/demand/opportunity/${staged.routeId}/room`);
  await owner.waitForSelector('[data-testid="room"]', { timeout: 20000 });

  const previewText = await substance(owner);
  check('the preview is marked as one', (await owner.locator('[data-testid="preview-banner"]').count()) === 1);
  check(
    'the preview and the public page say exactly the same thing',
    previewText === publicText,
    previewText === publicText ? '' : firstDifference(previewText, publicText),
  );
  check(
    'the preview shows the owner why this step was chosen',
    (await owner.locator('[data-testid="preview-reasoning"]').count()) === 1,
  );
  check(
    'and the prospect never sees that reasoning',
    !publicText.includes('Why this step'),
  );
  check(
    'the preview has no buyer actions on it',
    (await owner.locator('[data-testid="room-actions"]').count()) === 0,
  );

  // -------------------------------------------------------------------------
  console.log('\n--- the preview recorded nothing --------------------------------');
  const afterPreview = server(`
    const { prisma } = await import('@/lib/db');
    const room = await prisma.dealRoom.findUniqueOrThrow({ where: { id: '${staged.roomId}' } });
    const human = await prisma.dealRoomEvent.count({
      where: { roomId: '${staged.roomId}', kind: 'OPENED', userAgentClass: 'human' },
    });
    console.log(JSON.stringify({ openCount: room.openCount, human, state: room.state }));
  `);
  const counts = JSON.parse(afterPreview.split('\n').pop());
  // The stranger visit above is one human open. The preview must not have
  // added a second.
  check('the browser visit counted as exactly one open', counts.openCount === 1, `openCount ${counts.openCount}`);
  check('and the preview added none', counts.human === 1, `${counts.human} human open events`);

  // -------------------------------------------------------------------------
  console.log('\n--- responding, twice -------------------------------------------');
  await page.fill('[data-testid="room-actions"] textarea', 'Please send a price for all three sites.');
  await page.click('button[value="QUOTE_REQUESTED"]');
  await page.waitForSelector('[data-testid="room-thanks"]', { timeout: 20000 });
  const thanks = await page.locator('[data-testid="room-thanks"]').innerText();
  check('the prospect gets an acknowledgement', /thank you/i.test(thanks), thanks.split('\n')[0]);

  await page.goBack();
  await page.reload();
  await page.waitForSelector('[data-testid="room"]', { timeout: 20000 });

  const afterResponse = server(`
    const { prisma } = await import('@/lib/db');
    const events = await prisma.dealRoomEvent.count({
      where: { roomId: '${staged.roomId}', kind: 'QUOTE_REQUESTED' },
    });
    const room = await prisma.dealRoom.findUniqueOrThrow({ where: { id: '${staged.roomId}' } });
    console.log(JSON.stringify({ events, note: room.responseNote, state: room.state }));
  `);
  const response = JSON.parse(afterResponse.split('\n').pop());
  check('one request was recorded', response.events === 1, `${response.events} events`);
  check('their words were kept exactly', response.note === 'Please send a price for all three sites.', response.note ?? '');
  check('and the room moved to responded', response.state === 'RESPONDED', response.state);

  // -------------------------------------------------------------------------
  console.log('\n--- declining closes it -----------------------------------------');
  await page.click('button[value="DECLINED"]');
  await page.waitForSelector('[data-testid="room-thanks"]', { timeout: 20000 });

  await page.goto(`${BASE}/room/${staged.token}`);
  await page.waitForSelector('[data-testid="room-closed"]', { timeout: 20000 });
  const closed = await page.locator('[data-testid="room-closed"]').innerText();
  check('a declined room stops showing the offer', /closed at your request/i.test(closed), closed.split('\n').pop());
  check('and no buttons remain', (await page.locator('[data-testid="room-actions"]').count()) === 0);

  // -------------------------------------------------------------------------
  console.log('\n--- the owner sees what happened --------------------------------');
  await owner.goto(`${BASE}/demand/opportunity/${staged.routeId}`);
  await owner.waitForSelector('[data-testid="room-panel"]', { timeout: 20000 });
  const panel = await owner.locator('[data-testid="room-panel"]').innerText();
  check('the opportunity record reports the decline', /declined/i.test(panel), panel.split('\n')[1] ?? '');
  check('and tells the owner not to follow up', /do not follow up/i.test(panel));
  check('the token is nowhere on the owner page', !(await owner.content()).includes(staged.token));

  console.log(`\n${checks - failures}/${checks} checks passed.`);
} finally {
  await browser.close();
  rmSync(scratch, { recursive: true, force: true });
}

/** Where two renderings first diverge, so a failure is actionable. */
function firstDifference(a, b) {
  if (a === null || b === null) return 'one page did not render';
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) {
      return `at ${i}: preview "${a.slice(i, i + 60)}" vs public "${b.slice(i, i + 60)}"`;
    }
  }
  return 'lengths differ only';
}

process.exitCode = failures > 0 ? 1 : 0;
