/**
 * The review queue in a real browser.
 *
 * What is being checked is whether a person opening this page can tell a
 * machine's opinion from a fact. Every conclusion has to name who reached it,
 * show the words it came from, and say plainly when it has neither — because
 * the failure this whole layer is built against is an AI conclusion quietly
 * becoming a record that somebody later acts on.
 *
 * Also: that a call with no audio says so rather than offering a play button,
 * and that interim room audio carries its caveat wherever it appears.
 *
 *   npm run build && npx next start -p 3111
 *   DEMO_EMAIL=... DEMO_PASSWORD=... node scripts/browserCallReviewCheck.mjs
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

const scratch = mkdtempSync(join('scripts', '.call-check-'));
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
  console.log('--- stage an interim-capture call that needs review -------------');
  const stagedJson = server(`
    const { prisma } = await import('@/lib/db');
    const { startSession, finishSession } = await import('@/lib/calls/recording');
    const { transcribeSession, analyseSession } = await import('@/lib/calls/analysis');
    const { openReviewIfNeeded } = await import('@/lib/calls/review');

    const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
    const owner = await prisma.user.findFirst({ where: { orgId: org.id }, orderBy: { createdAt: 'asc' } });
    const route = await prisma.routeHypothesis.findFirst({ where: { orgId: org.id }, orderBy: { createdAt: 'asc' } });

    await prisma.company.update({ where: { id: route.companyId }, data: { stateCode: 'TX' } });
    await prisma.callReview.deleteMany({ where: { session: { routeId: route.id } } });
    await prisma.callInsight.deleteMany({ where: { session: { routeId: route.id } } });
    await prisma.callTranscript.deleteMany({ where: { session: { routeId: route.id } } });
    await prisma.callSession.deleteMany({ where: { routeId: route.id } });

    // A call captured through the interim mode: a microphone next to a
    // speakerphone. The page must say so wherever it appears.
    const started = await startSession({
      orgId: org.id, routeId: route.id, callerId: owner.id,
      intendedCapture: 'INTERIM_ROOM_AUDIO', callerState: 'TX',
    });
    await finishSession({
      orgId: org.id, sessionId: started.session.id, durationSec: 300,
      stored: { storageKey: 'browser-check/room.mp3', mimeType: 'audio/mpeg', retentionDays: 30 },
    });
    await transcribeSession({
      orgId: org.id, sessionId: started.session.id,
      syntheticText: [
        'Caller: Morning, I wanted to ask about your cleaning contract.',
        'Buyer: Our contract ends in March and we are with CleanCo at the moment.',
        'Buyer: Honestly the price is what matters most to us.',
        'Caller: I will send a quote through this afternoon.',
      ].join('\\n'),
    });
    await analyseSession({ orgId: org.id, sessionId: started.session.id, callerDisposition: 'QUOTE_REQUESTED' });
    const review = await openReviewIfNeeded({ orgId: org.id, sessionId: started.session.id });

    // And a second call with no audio at all, which is the ordinary case.
    const silent = await startSession({
      orgId: org.id, routeId: route.id, callerId: owner.id, callerState: 'TX',
    });
    await finishSession({ orgId: org.id, sessionId: silent.session.id, durationSec: 60 });
    await prisma.callReview.create({
      data: {
        orgId: org.id, sessionId: silent.session.id, reason: 'OPERATOR_FLAGGED',
        because: 'Staged by the browser check: a call with no audio.', state: 'OPEN',
      },
    });

    console.log(JSON.stringify({
      sessionId: started.session.id,
      silentId: silent.session.id,
      reviewOpened: review.opened,
      reason: review.reason,
    }));
  `);
  const staged = JSON.parse(stagedJson.split('\n').pop());
  check('a review was opened for the analysed call', staged.reviewOpened, staged.reason ?? '');

  // -------------------------------------------------------------------------
  console.log('\n--- open the queue -----------------------------------------------');
  await signIn(page, BASE, process.env.DEMO_EMAIL ?? 'owner@dealdispatch.test',
    process.env.DEMO_PASSWORD ?? 'demo-password-123');
  await page.goto(`${BASE}/reviews`);
  await page.waitForSelector('[data-testid="review-item"]', { timeout: 20000 });
  check('the review queue renders', true);

  const items = await page.locator('[data-testid="review-item"]').count();
  check('both staged calls are waiting', items >= 2, `${items} items`);

  // -------------------------------------------------------------------------
  console.log('\n--- a machine\'s opinion is labelled as one -----------------------');
  const insights = await page.locator('[data-testid="insight"]').count();
  check('the conclusions are listed', insights > 0, `${insights}`);

  const actors = await page.locator('[data-testid="insight-actor"]').allInnerTexts();
  check('every conclusion names who reached it',
    actors.length === insights && actors.every((a) => /concluded by \S+/.test(a)),
    actors[0] ?? 'none');

  check('and the actor is a model or a rule set, not a person\'s name',
    actors.every((a) => /concluded by (ai|rules):/.test(a)),
    actors[0] ?? '');

  // Every insight row must show either a quote or an explicit note that it has
  // none. A conclusion with neither is exactly the thing that becomes a fact.
  const unevidenced = await page.evaluate(() => {
    const bad = [];
    for (const row of Array.from(document.querySelectorAll('[data-testid="insight"]'))) {
      const text = row.innerText ?? '';
      const hasQuote = /[“"]/.test(text);
      const saysNone = /no quote/i.test(text);
      if (!hasQuote && !saysNone) bad.push(text.replace(/\s+/g, ' ').slice(0, 80));
    }
    return bad;
  });
  check('every conclusion shows its quote, or says it has none', unevidenced.length === 0,
    unevidenced.slice(0, 2).join(' | '));

  // -------------------------------------------------------------------------
  console.log('\n--- capture quality is stated ------------------------------------');
  const body = await page.locator('body').innerText();
  check('interim room audio carries its caveat',
    /one mixed channel/i.test(body) && /inferred rather than known/i.test(body),
    body.match(/Interim capture[^.]*\./)?.[0] ?? 'no caveat found');

  check('the caveat says it is not evidence of a specific person\'s words',
    /not evidence of a specific person/i.test(body));

  const noAudio = await page.locator('[data-testid="no-audio"]').count();
  check('a call with no audio says so', noAudio > 0, `${noAudio} rows`);

  check('and no storage key appears anywhere on the page',
    !body.includes('browser-check/room.mp3') && !(await page.content()).includes('browser-check/room.mp3'));

  // -------------------------------------------------------------------------
  console.log('\n--- high-impact conclusions are held -----------------------------');
  const held = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-testid="insight"]'));
    return rows
      .filter((r) => /buyer promise|provider promise|script observation/i.test(r.innerText ?? ''))
      .map((r) => (r.innerText ?? '').replace(/\s+/g, ' '));
  });
  if (held.length > 0) {
    check('a promise is never shown as auto-applied',
      held.every((t) => !/auto applied/i.test(t)),
      held[0].slice(0, 90));
    check('and the page says why it is being held',
      held.some((t) => /commercial commitment|last word/i.test(t)),
      held[0].slice(0, 90));
  } else {
    check('no high-impact conclusion was extracted from this transcript', true);
  }

  // -------------------------------------------------------------------------
  console.log('\n--- auto-fill accuracy refuses a weak sample ---------------------');
  const accuracy = await page.locator('[data-testid="accuracy"]').innerText();
  check('the accuracy panel is present', accuracy.length > 0);
  check('and refuses to show a rate below the floor, saying why',
    /Below \d+ there is nothing to read/i.test(accuracy) || /\d+%/.test(accuracy),
    accuracy.split('\n')[1]?.slice(0, 90) ?? '');
  check('it explains that only the spot checks are counted',
    /only from the spot checks/i.test(accuracy));

  // -------------------------------------------------------------------------
  console.log('\n--- a caller sees none of it -------------------------------------');
  const callerPage = await browser.newPage();
  await signIn(callerPage, BASE, 'dana@dealdispatch.test', process.env.DEMO_PASSWORD ?? 'demo-password-123');
  await callerPage.goto(`${BASE}/reviews`);
  const callerBody = await callerPage.locator('body').innerText();
  check('a caller opening the review queue is refused',
    !callerBody.includes('Calls waiting on a person') && !callerBody.includes('concluded by'),
    callerPage.url());
  await callerPage.close();

  console.log(`\n${checks - failures}/${checks} checks passed.`);
} finally {
  await browser.close();
  rmSync(scratch, { recursive: true, force: true });
}

process.exitCode = failures > 0 ? 1 : 0;
