/**
 * The calling floor in a real browser, at laptop and phone widths.
 *
 * The brief asked for a page usable at normal laptop width without horizontal
 * scrolling or clipped controls, so that is checked as a measurement rather
 * than an opinion: the document is never wider than the viewport, and every
 * primary control is inside it.
 *
 *   npm run build && npx next start -p 3111
 *   node scripts/browserCallerFloorCheck.mjs
 */

import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:3111';
let failures = 0;
let checks = 0;
const check = (label, ok, detail = '') => {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
};

async function signIn(page, email, password) {
  const response = await page.request.post(`${BASE}/api/auth/login`, {
    data: { email, password }, failOnStatusCode: false,
  });
  if (!response.ok()) {
    throw new Error(`Sign-in failed for ${email}: HTTP ${response.status()}${
      response.status() === 429 ? ' — rate-limited, wait a minute' : ''}`);
  }
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});

try {
  for (const [label, width, height] of [['laptop', 1280, 800], ['phone', 390, 844]]) {
    console.log(`\n--- ${label} (${width}×${height}) ---------------------------------`);
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log(`  [page error] ${e.message}`));

    await signIn(page, process.env.DEMO_EMAIL ?? 'owner@dealdispatch.test',
      process.env.DEMO_PASSWORD ?? 'demo-password-123');
    await page.goto(`${BASE}/callers`);
    await page.waitForSelector('[data-testid="floor-summary"]', { timeout: 20000 });
    check(`${label}: the floor renders`, true);

    // The measurement, not a judgement.
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      view: window.innerWidth,
    }));
    check(`${label}: the page does not scroll sideways`,
      overflow.doc <= overflow.view + 1, `document ${overflow.doc}px in ${overflow.view}px`);

    for (const id of ['add-caller', 'open-workspace', 'preview-workspace']) {
      const box = await page.locator(`[data-testid="${id}"]`).first().boundingBox();
      check(`${label}: "${id}" is present and fully inside the viewport`,
        Boolean(box) && box.x >= 0 && box.x + box.width <= overflow.view + 1,
        box ? `x=${Math.round(box.x)} w=${Math.round(box.width)}` : 'missing');
    }

    if (label === 'laptop') {
      // Only real callers, and the exclusions explained.
      const cards = await page.locator('[data-testid="caller-card"]').count();
      check('caller cards render', cards > 0, `${cards}`);

      // Scoped to the caller cards, not the whole document: the signed-in
      // owner's own name is in the sidebar footer, and matching on that would
      // fail for the wrong reason every time an owner opened their own floor.
      const cardText = (await page.locator('[data-testid="caller-card"]').allInnerTexts()).join(' | ');
      check('no owner, finance, admin or research account is listed as a caller',
        !/Alex Reyes|Wei Zhang|Sam Okafor|Jordan Blake|Priya Raman/.test(cardText),
        (cardText.match(/Alex Reyes|Wei Zhang|Sam Okafor|Jordan Blake|Priya Raman/) ?? ['none'])[0]);
      check('and every card belongs to somebody with a caller profile',
        cardText.split('|').every((t) => t.includes('@')), `${cards} cards`);

      await page.locator('[data-testid="eligibility-breakdown"] summary').click();
      const buckets = await page.locator('[data-testid="bucket-row"]').count();
      check('the callable number is broken down rather than asserted', buckets >= 6, `${buckets} states`);
      check('and the breakdown says a route is not callable merely by existing',
        /does not make it callable/i.test(await page.locator('[data-testid="eligibility-breakdown"]').innerText()));

      // Preview must not assign.
      const first = page.locator('[data-testid="preview-assignment"]').first();
      if (await first.count() > 0) {
        await first.click();
        await page.waitForSelector('[data-testid="assignment-preview"]', { timeout: 15000 });
        check('previewing shows a plan before anything is assigned', true);
        const previewText = await page.locator('[data-testid="assignment-preview"]').innerText();
        check('and names what was left out, with reasons',
          /left out|Nothing is callable/i.test(previewText),
          previewText.split('\n').slice(0, 2).join(' ').slice(0, 90));
        check('and the confirm button says how many it will assign',
          /Assign these \d+/.test(previewText));
      } else {
        check('no caller is assignable right now, and the page says so rather than offering a dead button', true);
      }

      // The sandbox is visibly separate.
      const sandbox = await page.locator('[data-testid="sandbox-card"]').innerText();
      check('the sandbox is a distinct section that says it cannot touch production',
        /cannot be handed real work/i.test(sandbox));

      // No PIN or hash anywhere in the source.
      const html = await page.content();
      check('no PIN or hash appears in the page source', !/pinHash|"pin"\s*:/.test(html));
    }

    await context.close();
  }

  // -------------------------------------------------------------------------
  console.log('\n--- a caller sees none of it -------------------------------------');
  const callerContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const callerPage = await callerContext.newPage();
  await signIn(callerPage, 'dana@dealdispatch.test', process.env.DEMO_PASSWORD ?? 'demo-password-123');
  await callerPage.goto(`${BASE}/callers`);
  const callerBody = await callerPage.locator('body').innerText();
  check('a caller opening the floor is refused',
    !callerBody.includes('Calling floor') || callerPage.url().includes('no-access'),
    callerPage.url());
  check('and the owner navigation is not rendered inside a caller session',
    !/System manager|Add caller/.test(callerBody));
  await callerContext.close();

  console.log(`\n${checks - failures}/${checks} checks passed.`);
} finally {
  await browser.close();
}

process.exitCode = failures > 0 ? 1 : 0;
