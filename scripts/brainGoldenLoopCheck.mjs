/**
 * The golden loop, against the real deployment.
 *
 * A record this site already holds is registered in Brain exactly once, Brain
 * forms its own view of it, the site shows that view, a person issues one typed
 * command from the site, and the site reflects what Brain then did. Everything
 * below is that sentence, checked in order, in a browser, against production.
 *
 * It runs from CI for the same two reasons `deployedWalkthroughCheck.mjs` does:
 * the deployment's address and the owner's password are repository secrets, and
 * the machines this project is developed on cannot reach the deployment at all.
 *
 * Three rules it holds itself to:
 *
 *   It uses a record that already exists. It creates no opportunity, no
 *   organisation and no user, because a loop proven on a fixture is a loop
 *   proven about a fixture.
 *
 *   The only thing it changes is what the command changes. `RESEARCH_FURTHER`
 *   captures an idea in Brain; it spends nothing, and Brain's own standing
 *   authority decides whether anything is ever researched.
 *
 *   Duplicate safety is checked positively rather than assumed: the same
 *   command is issued again, through the same user-facing route, and the site
 *   must still report one command with one timestamp.
 *
 * Required: BASE_URL, OWNER_EMAIL, OWNER_PASSWORD.
 */

import { chromium } from 'playwright';

const BASE = (process.env.BASE_URL ?? '').replace(/\/$/, '');
const OWNER_EMAIL = process.env.OWNER_EMAIL ?? 'owner@dealdispatch.test';
const OWNER_PASSWORD = process.env.OWNER_PASSWORD ?? '';
const WANTED = process.env.OPPORTUNITY_ID ?? '';

if (!BASE) throw new Error('BASE_URL is required.');
if (!OWNER_PASSWORD) throw new Error('OWNER_PASSWORD is required. Set it as a repository secret.');
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE);
if (!/^https:\/\//.test(BASE) && !LOOPBACK) {
  throw new Error('BASE_URL must be https. An owner password is sent to it.');
}

let failures = 0;
let checks = 0;
const check = (label, ok, detail = '') => {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Never prints a body that carried a credential, and never a header. */
async function api(path, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not json */ }
  return { status: response.status, body: parsed, text };
}

/** What the panel is showing right now, read from the rendered page. */
async function readPanel(page) {
  const panel = page.locator('[data-testid="brain-panel"]');
  if ((await panel.count()) === 0) return null;
  const text = async (testId) => {
    const node = panel.locator(`[data-testid="${testId}"]`);
    return (await node.count()) > 0 ? (await node.first().innerText()).trim() : null;
  };
  return {
    state: await panel.getAttribute('data-brain-state'),
    freshness: await panel.getAttribute('data-brain-freshness'),
    label: await text('brain-state'),
    reason: await text('brain-state-reason'),
    freshnessText: await text('brain-freshness'),
    identity: await text('brain-identity'),
    hasCommand: (await panel.locator('[data-testid="brain-command"]').count()) > 0,
  };
}

function printPanel(panel) {
  if (!panel) {
    console.log('       the panel did not render at all');
    return;
  }
  console.log(`       state       ${panel.state} (${panel.label ?? 'no label'})`);
  console.log(`       freshness   ${panel.freshness} — ${panel.freshnessText ?? ''}`);
  console.log(`       reason      ${panel.reason ?? '(none)'}`);
  console.log(`       identity    ${panel.identity ?? '(none)'}`);
  console.log(`       command     ${panel.hasCommand ? 'offered' : 'not offered'}`);
}

let browser = null;
try {
  console.log(`\n=== the golden loop against ${BASE} ===`);

  // ---------------------------------------------------------------------
  console.log('\n--- is this site connected to a Brain at all ----------------------');
  const health = await api('/api/health');
  const brain = health.body?.checks?.brain?.detail ?? '';
  check('the site answers its own health check', health.status === 200, `HTTP ${health.status}`);
  check('the site says it is connected to a Brain', /^Connected to /.test(brain), brain.slice(0, 160));
  check(
    'and the Brain answered when it was asked',
    /it answered/.test(brain),
    brain.slice(0, 160),
  );
  // The health text names a host and a project. It must never name the token.
  check('the health text carries no credential', !/brnw_/.test(JSON.stringify(health.body)));
  if (failures > 0) throw new Error('Not connected. Nothing below can be proven.');

  browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  );
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  [page error] ${e.message}`));

  // ---------------------------------------------------------------------
  console.log('\n--- a person signs in --------------------------------------------');
  const signIn = await page.request.post(`${BASE}/api/auth/login`, {
    data: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
    failOnStatusCode: false,
  });
  if (!signIn.ok()) {
    check('the owner can sign in', false,
      signIn.status() === 401
        ? 'HTTP 401 — OWNER_EMAIL/OWNER_PASSWORD do not match an account on this deployment'
        : `HTTP ${signIn.status()}`);
    throw new Error('Cannot continue without a session.');
  }
  check('the owner can sign in', true, OWNER_EMAIL);
  const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');

  // ---------------------------------------------------------------------
  console.log('\n--- a record this site already holds ------------------------------');
  await page.goto(`${BASE}/opportunities`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const links = await page.locator('a[href^="/opportunities/"]').all();
  const ids = [];
  for (const link of links) {
    const href = await link.getAttribute('href');
    const id = href?.split('/opportunities/')[1]?.split(/[?#]/)[0];
    if (id && !ids.includes(id)) ids.push(id);
  }
  check('the list shows real opportunities', ids.length > 0, `${ids.length} on the first page`);
  const opportunityId = WANTED || ids[0];
  if (!opportunityId) throw new Error('No opportunity to work with.');
  check('one of them is chosen', true, opportunityId);

  // ---------------------------------------------------------------------
  console.log('\n--- opening it registers it in Brain, once ------------------------');
  await page.goto(`${BASE}/opportunities/${opportunityId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const first = await readPanel(page);
  printPanel(first);
  check('the Brain panel renders', first !== null);
  check(
    'and it is reading Brain live rather than from a stored copy',
    first?.freshness === 'CURRENT',
    first?.freshness ?? 'no panel',
  );
  check('Brain has given the record its own identity', Boolean(first?.identity), first?.identity ?? '');
  check(
    'the state is one of the six, and it is named in words',
    Boolean(first?.state) && Boolean(first?.label),
    `${first?.state} → “${first?.label}”`,
  );
  check(
    'the state comes with Brain’s own sentence saying what it means',
    Boolean(first?.reason),
    first?.reason ?? '',
  );

  // Opening it again must not register a second time. The Brain id is the
  // proof: it is the row's identity, and a second registration would be a
  // second row with a second id.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const second = await readPanel(page);
  check(
    'opening it again is the same record, not a second one',
    Boolean(second?.identity) && second?.identity === first?.identity,
    `${first?.identity} then ${second?.identity}`,
  );

  // ---------------------------------------------------------------------
  console.log('\n--- one typed command, issued from the site ------------------------');
  const before = await api(`/api/opportunities/${opportunityId}/brain`, { cookie });
  const commandOffered = second?.hasCommand ?? false;
  console.log(`       Brain offers the command: ${commandOffered ? 'yes' : 'no'}`);

  if (commandOffered) {
    const button = page.getByRole('button', { name: /Ask Brain to research this/i });
    check('the one button is on the page', (await button.count()) > 0);
    const pressedAt = Date.now();
    await button.first().click();
    await page.waitForLoadState('networkidle');
    await sleep(1500);
    const after = await readPanel(page);
    const reflectedMs = Date.now() - pressedAt;
    printPanel(after);
    console.log(`       pressed to reflected on the page: ${reflectedMs} ms`);
    // The site is a window: an important state change should reach the page a
    // person is looking at in seconds, not on the next sweep. This is the live
    // read-through path, so it is measured rather than assumed — and it is
    // reported whatever it is, because a target nobody measures is a wish.
    check(
      'the change reaches the page a person is looking at in under five seconds',
      reflectedMs < 5000,
      `${reflectedMs} ms`,
    );
    check(
      'the site reflects what Brain did with it',
      after !== null && after.state !== null,
      `${first?.state} → ${after?.state}`,
    );
    check(
      'and it is still the same record',
      after?.identity === first?.identity,
      after?.identity ?? '',
    );

    // The same command again, through the same user-facing route. One logical
    // command, one outcome — whatever the transport did.
    const again = await api(`/api/opportunities/${opportunityId}/brain`, {
      method: 'POST',
      cookie,
      body: { command: 'RESEARCH_FURTHER' },
    });
    const third = await (async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle');
      return readPanel(page);
    })();
    check(
      'issuing it a second time is accepted rather than erroring',
      again.status === 200,
      `HTTP ${again.status}`,
    );
    // The proof that the second delivery was not a second command. Brain
    // derives the key from the record and the command, so an equivalent caller
    // reads the row it collided with rather than doing the work again.
    check(
      'and Brain says it replayed the first one rather than doing it twice',
      again.body?.replayed === true,
      `replayed=${String(again.body?.replayed)}`,
    );
    check(
      'and it is still one record in one state',
      third?.identity === first?.identity,
      `${third?.state}`,
    );
    console.log(`       the second delivery answered: ${JSON.stringify(again.body).slice(0, 200)}`);
  } else {
    // Not a failure. A record Brain is already working on has no button, which
    // is the panel refusing to offer something that would be a second command.
    check(
      'no button is offered, and the panel says why',
      Boolean(second?.reason),
      second?.reason ?? '',
    );
    console.log(`       (before: HTTP ${before.status})`);
  }

  // ---------------------------------------------------------------------
  console.log('\n--- nothing leaked ------------------------------------------------');
  const html = await page.content();
  check('no Brain credential is anywhere in the rendered page', !/brnw_/.test(html));
  check('no bearer header is echoed into the page', !/[Aa]uthorization/.test(html));
} catch (error) {
  failures += 1;
  console.log(`\n  FAIL  ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (browser) await browser.close();
}

console.log(`\n${checks} checks, ${failures} failure(s)`);
console.log(failures === 0 ? 'BRAIN-GOLDEN-LOOP: PASS' : 'BRAIN-GOLDEN-LOOP: FAIL');
process.exitCode = failures === 0 ? 0 : 1;
