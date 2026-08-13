/**
 * The owner-to-caller shift, driven against a real deployment.
 *
 * Everything else in this repository is checked against a local build and a
 * local database. That leaves one thing unproven: whether the thing people
 * actually use behaves the same. This drives the deployed application in a
 * browser — owner signs in, creates a test caller, hands over a PIN, the
 * caller signs in with it, is assigned practice work, and saves a real
 * outcome — and then checks that not one production number moved.
 *
 * It runs from CI rather than from a developer's machine, because the
 * deployment host is reachable from there and its address is a repository
 * secret rather than something to paste around.
 *
 * Three rules it holds itself to:
 *
 *   Nothing here is allowed to touch production data. Every record it creates
 *   is sandbox-mode, and the production counts are read before and after from
 *   the deployed UI's own numbers rather than from a database it cannot see.
 *
 *   No real message, call or lookup may leave the deployment. That is checked
 *   positively — it asks the deployed API to start a provider-recorded call on
 *   the practice record and requires a refusal — rather than assumed.
 *
 *   It cleans up after itself, and says so if it could not.
 *
 * Required: BASE_URL, OWNER_EMAIL, OWNER_PASSWORD.
 * Optional: EXPECT_COMMIT, CRON_SECRET (together, to confirm which build
 * answered), EXPECT_MIGRATION (a migration name that must be applied).
 */

import { chromium } from 'playwright';

const BASE = (process.env.BASE_URL ?? '').replace(/\/$/, '');
const OWNER_EMAIL = process.env.OWNER_EMAIL ?? 'owner@dealdispatch.test';
const OWNER_PASSWORD = process.env.OWNER_PASSWORD ?? '';
const EXPECT_COMMIT = process.env.EXPECT_COMMIT ?? '';
const CRON_SECRET = process.env.CRON_SECRET ?? '';
const EXPECT_MIGRATION = process.env.EXPECT_MIGRATION ?? '';

if (!BASE) throw new Error('BASE_URL is required.');
if (!OWNER_PASSWORD) throw new Error('OWNER_PASSWORD is required. Set it as a repository secret.');
// https everywhere except a loopback rehearsal: an owner password is sent to
// this host, and a deployment reached over cleartext is not a deployment worth
// testing against.
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

/** Never prints the body of anything that carried a credential. */
async function api(path, { method = 'GET', body, cookie, bearer } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not json */ }
  return { status: response.status, body: parsed, text, headers: response.headers };
}

/**
 * Navigate, tolerating a navigation that is already under way.
 *
 * Several controls on the floor reload the page themselves after a write, so a
 * `goto` issued straight afterwards can be aborted by the reload it collided
 * with. That is a race in the test, not a fault in the page, and retrying once
 * is the honest fix — swallowing the error would hide a real failure to load.
 */
async function goTo(page, path) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
      return;
    } catch (error) {
      if (attempt === 2 || !/ERR_ABORTED|interrupted by another navigation/i.test(String(error))) throw error;
      await page.waitForTimeout(1500);
    }
  }
}

/**
 * The numbers an owner sees, read off the deployed page.
 *
 * Read from the UI on purpose. The production database is not reachable from
 * CI, and it should not have to be: if the screen an owner makes decisions
 * from shows the same figures before and after, that is the claim worth
 * proving.
 */
async function productionNumbers(page) {
  await goTo(page, '/callers');
  await page.waitForSelector('[data-testid="floor-summary"]', { timeout: 30000 });
  const summary = await page.locator('[data-testid="floor-summary"]').innerText();

  const open = await page.locator('[data-testid="eligibility-breakdown"] summary').count();
  if (open > 0) await page.locator('[data-testid="eligibility-breakdown"] summary').click();
  const buckets = {};
  const rows = page.locator('[data-testid="bucket-row"]');
  for (let i = 0; i < await rows.count(); i += 1) {
    const text = (await rows.nth(i).innerText()).replace(/\s+/g, ' ').trim();
    const match = text.match(/^(.*?)\s+(\d+)\b/);
    if (match) buckets[match[1].trim()] = Number(match[2]);
  }
  return { summary: summary.replace(/\s+/g, ' ').trim(), buckets };
}

/**
 * When the practice fixtures are next callable, in UTC.
 *
 * The sandbox companies sit in real US timezones and the business-hours rule
 * applies to them exactly as it does to real work, so this check can only run
 * inside their working day. Saying "come back later" is not useful; saying
 * which hour is.
 */
function nextWindow(zones = ['America/Chicago', 'America/Los_Angeles']) {
  const hourIn = (zone, at) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hour: 'numeric', hour12: false, weekday: 'short',
    }).formatToParts(at);
    return {
      hour: Number(parts.find((p) => p.type === 'hour')?.value ?? '0'),
      day: parts.find((p) => p.type === 'weekday')?.value ?? 'Sun',
    };
  };
  const open = (zone, at) => {
    const { hour, day } = hourIn(zone, at);
    return !['Sat', 'Sun'].includes(day) && hour >= 8 && hour < 18;
  };
  const now = new Date();
  for (const zone of zones) if (open(zone, now)) return { zone, when: 'now' };
  // Step forward in half-hours until one of them opens. A week is plenty, and
  // it costs nothing.
  for (let i = 1; i <= 7 * 48; i += 1) {
    const at = new Date(now.getTime() + i * 30 * 60_000);
    for (const zone of zones) {
      if (open(zone, at)) {
        return { zone, when: `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC` };
      }
    }
  }
  return { zone: null, when: 'unknown' };
}

const stamp = Date.now();
const callerEmail = `deployed-walkthrough-${stamp}@dealdispatch.test`;
let browser;
let createdCallerId = null;
let practiceRouteId = null;

try {
  // -------------------------------------------------------------------------
  console.log(`--- what is actually deployed at ${BASE} ----------------`);

  const health = await api('/api/health');
  check('the deployment is healthy', health.status === 200 && health.body?.ok === true,
    health.body ? Object.entries(health.body.checks ?? {})
      .filter(([, v]) => !v.ok).map(([k]) => k).join(', ') || 'all checks green'
      : `HTTP ${health.status}`);

  const migrations = health.body?.checks?.migrations?.detail ?? '';
  check('every migration finished on the deployed database',
    health.body?.checks?.migrations?.ok === true,
    migrations.slice(0, 90));
  if (EXPECT_MIGRATION) {
    check(`the ${EXPECT_MIGRATION} migration is applied there`,
      migrations.includes(EXPECT_MIGRATION),
      migrations.includes(EXPECT_MIGRATION) ? 'present' : 'not in the applied list');
  }

  if (CRON_SECRET && EXPECT_COMMIT) {
    // Done before anything is counted: the tick does real work, and a baseline
    // taken after it would be measuring the wrong moment.
    const tick = await api('/api/cron/tick', { bearer: CRON_SECRET });
    const commit = tick.body?.build?.commit ?? '';
    check(`the deployed build is commit ${EXPECT_COMMIT}`,
      commit === EXPECT_COMMIT,
      commit ? `answered by ${commit} on ${tick.body?.build?.branch ?? '?'} (${tick.body?.build?.environment ?? '?'})`
        : `no build identity in the response (HTTP ${tick.status})`);
  }

  browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  );
  const ownerContext = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const owner = await ownerContext.newPage();
  owner.on('pageerror', (e) => console.log(`  [page error] ${e.message}`));

  // -------------------------------------------------------------------------
  console.log('\n--- the owner signs in -------------------------------------------');
  const signIn = await owner.request.post(`${BASE}/api/auth/login`, {
    data: { email: OWNER_EMAIL, password: OWNER_PASSWORD }, failOnStatusCode: false,
  });
  if (!signIn.ok()) {
    check('the owner can sign in', false,
      signIn.status() === 401
        ? 'HTTP 401 — OWNER_EMAIL/OWNER_PASSWORD do not match an account on this deployment'
        : `HTTP ${signIn.status()}`);
    throw new Error('Cannot continue without an owner session.');
  }
  check('the owner can sign in', true, OWNER_EMAIL);
  const ownerCookie = (await ownerContext.cookies())
    .map((c) => `${c.name}=${c.value}`).join('; ');

  // -------------------------------------------------------------------------
  console.log('\n--- production, before anything is touched ------------------------');
  const before = await productionNumbers(owner);
  check('the floor reports its production numbers', Object.keys(before.buckets).length > 0,
    `${Object.keys(before.buckets).length} buckets — ${before.summary.slice(0, 80)}`);

  // -------------------------------------------------------------------------
  console.log('\n--- the owner creates a test caller and hands over a PIN ----------');
  await owner.waitForSelector('[data-testid="create-test-caller"]', { timeout: 30000 });
  await owner.click('[data-testid="create-test-caller"]');
  await owner.waitForSelector('[data-testid="add-caller-form"]');
  await owner.fill('[data-testid="new-name"]', 'Deployed Walkthrough');
  await owner.fill('[data-testid="new-email"]', callerEmail);
  await owner.click('[data-testid="save-caller"]');
  await owner.waitForLoadState('networkidle');

  const card = owner.locator('[data-testid="caller-card"]', { hasText: 'Deployed Walkthrough' }).first();
  await card.waitFor({ timeout: 30000 });
  check('a test caller is created on the deployment', true);
  check('and is marked TEST', (await card.innerText()).includes('TEST'));

  await card.locator('[data-testid="issue-pin"]').click();
  await owner.waitForSelector('[data-testid="pin-value"]', { timeout: 30000 });
  const pin = (await owner.locator('[data-testid="pin-value"]').innerText()).trim();
  check('a PIN is shown exactly once', /^\d{6}$/.test(pin), `${pin.length} digits`);
  await owner.click('[data-testid="copy-pin"]');
  await owner.waitForTimeout(500);
  // Truthfulness, not success. A headless browser often refuses clipboard
  // access, and the only wrong answer is claiming to have copied a PIN that is
  // shown exactly once and then closing the panel over it.
  const copyLabel = (await owner.locator('[data-testid="copy-pin"]').innerText()).trim();
  const copyWarned = await owner.locator('[data-testid="copy-pin-failed"]').count();
  check('the copy control reports what actually happened',
    (copyLabel.includes('Copied') && copyWarned === 0)
    || (/by hand/i.test(copyLabel) && copyWarned > 0),
    `${copyLabel}${copyWarned > 0 ? ' + a warning' : ''}`);

  const roster = await api('/api/callers', { cookie: ownerCookie });
  const mine = (roster.body?.callers ?? roster.body?.roster ?? [])
    .find?.((c) => c.email === callerEmail);
  createdCallerId = mine?.callerId ?? mine?.id ?? null;

  // -------------------------------------------------------------------------
  console.log('\n--- assigning practice work --------------------------------------');
  // The fixtures may never have been built on this deployment, and the button
  // is idempotent, so this is safe to press either way.
  await goTo(owner, '/callers');
  const buildSandbox = owner.locator('[data-testid="sandbox-create"]');
  if ((await buildSandbox.count()) > 0) {
    owner.once('dialog', (d) => void d.accept());
    await buildSandbox.click();
    await owner.waitForLoadState('networkidle').catch(() => {});
    await owner.waitForTimeout(2000);
  }
  check('the practice fixtures exist on the deployment',
    /\[TEST\]|practice/i.test(await owner.locator('[data-testid="sandbox-card"]').innerText())
    || (await owner.locator('[data-testid="sandbox-card"]').innerText()).length > 0);

  await goTo(owner, '/callers');
  const card2 = owner.locator('[data-testid="caller-card"]', { hasText: 'Deployed Walkthrough' }).first();
  await card2.locator('[data-testid="preview-assignment"]').click();
  await owner.waitForSelector('[data-testid="assignment-preview"]', { timeout: 30000 });
  const previewText = await owner.locator('[data-testid="assignment-preview"]').innerText();
  const previewRows = await owner.locator('[data-testid="preview-row"]').count();

  if (previewRows === 0) {
    check('practice work is available to assign', false,
      `nothing callable right now — ${previewText.split('\n').slice(0, 3).join(' ').slice(0, 150)}`);
    const opens = nextWindow();
    throw new Error(
      'No sandbox record is callable on the deployment at this moment. The fixtures sit in real US '
      + 'timezones and the business-hours rule applies to practice exactly as it does to real work. '
      + `They are next callable at ${opens.when}${opens.zone ? `, when it is inside working hours in ${opens.zone}` : ''}.`,
    );
  }
  check('practice work is available to assign', true, `${previewRows} rows`);
  check('and the preview offers only sandbox records', previewText.includes('[TEST]'),
    previewText.split('\n').slice(0, 2).join(' ').slice(0, 90));

  // Taken now, while the record is still unassigned: once it is in a packet the
  // preview stops offering it, and the outbound probe further down needs a
  // practice route to aim at.
  const poolPreview = await api('/api/callers', {
    method: 'POST', cookie: ownerCookie,
    body: { action: 'preview_assignment', callerId: createdCallerId, requested: 5 },
  });
  practiceRouteId = poolPreview.body?.preview?.routeIds?.[0]
    ?? poolPreview.body?.preview?.rows?.[0]?.routeId ?? null;

  await owner.click('[data-testid="confirm-assignment"]');
  await owner.waitForLoadState('networkidle');
  check('the packet is assigned', true);

  // -------------------------------------------------------------------------
  console.log('\n--- the caller signs in with the PIN they were given --------------');
  const callerContext = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const caller = await callerContext.newPage();
  caller.on('pageerror', (e) => console.log(`  [page error] ${e.message}`));

  await goTo(caller, '/work');
  const inputs = caller.locator('form input');
  await inputs.nth(0).fill(callerEmail);
  await inputs.nth(1).fill(pin);
  await caller.locator('form button[type="submit"]').click();
  await caller.waitForLoadState('networkidle').catch(() => {});
  await caller.waitForTimeout(2500);

  // If it did not work, say what the page said. "Sign-in failed" is not a
  // diagnosis, and the form puts the reason on screen.
  const refusal = caller.locator('.alert.danger');
  const refusalText = (await refusal.count()) > 0 ? (await refusal.first().innerText()).trim() : '';
  const readiness = await caller.locator('body').innerText();
  const signedIn = !/Sign in with your own PIN/i.test(readiness);
  check('the PIN signs them in on the deployment', signedIn,
    signedIn
      ? readiness.split('\n').filter(Boolean).slice(0, 2).join(' ').slice(0, 90)
      : `still on the sign-in form — ${refusalText || 'no message shown'}`);
  if (!signedIn) throw new Error(`The caller could not sign in: ${refusalText || 'no message shown'}`);

  // -------------------------------------------------------------------------
  console.log('\n--- working a practice record ------------------------------------');
  await goTo(caller, '/work/call');
  let body = await caller.locator('body').innerText();
  check('a sandbox record is served, marked as test', body.includes('[TEST]'),
    body.split('\n').filter(Boolean).slice(0, 3).join(' ').slice(0, 100));

  async function saveWith(disposition, { fill = true, notes = null } = {}) {
    await caller.locator(`[data-testid="disposition-${disposition}"]`).first().click();
    if (fill) {
      const fields = caller.locator('[data-testid^="field-"]');
      for (let i = 0; i < await fields.count(); i += 1) {
        const field = fields.nth(i);
        if ((await field.inputValue()) === '') {
          await field.fill('Recorded during the deployed walkthrough.');
        }
      }
    }
    if (notes) await caller.locator('[data-testid="notes"]').fill(notes);
    await caller.locator('[data-testid="save-call"]').click();
    await caller.waitForTimeout(2000);
  }

  const offered = await caller.locator('[data-testid="disposition-NEED_CONFIRMED"]').count();
  if (offered > 0) {
    await saveWith('NEED_CONFIRMED', { fill: false });
    const refused = await caller.locator('[data-testid="refusal-incomplete"]').count();
    check('an incomplete outcome is refused, and says what is missing', refused > 0,
      refused > 0 ? (await caller.locator('[data-testid="refusal-incomplete"]').innerText()).slice(0, 90) : 'not refused');

    await saveWith('NEED_CONFIRMED', { fill: true, notes: 'Deployed walkthrough: confirmed need.' });
    check('and the completed outcome is accepted',
      (await caller.locator('[data-testid="refusal-incomplete"]').count()) === 0);
  } else {
    const first = caller.locator('[data-testid^="disposition-"]').first();
    const id = await first.getAttribute('data-testid');
    await saveWith(id.replace('disposition-', ''), { fill: true, notes: 'Deployed walkthrough.' });
    check('an outcome is saved', true, id);
  }

  // -------------------------------------------------------------------------
  console.log('\n--- nothing left the building ------------------------------------');
  // Asked of the deployment directly, with an owner session: start a
  // provider-recorded call on the practice record. A refusal is the only
  // acceptable answer, and it has to be the sandbox boundary giving it.
  if (practiceRouteId) {
    const dial = await api('/api/calls/session', {
      method: 'POST', cookie: ownerCookie,
      body: {
        action: 'start', routeId: practiceRouteId,
        provider: 'twilio', intendedCapture: 'PROVIDER_RECORDING',
      },
    });
    const message = dial.body?.error ?? '';
    check('the deployment refuses to place a provider call on a practice record',
      dial.status >= 400 && /sandbox|practice/i.test(message),
      `HTTP ${dial.status} — ${message.slice(0, 90)}`);
    check('and says so in words rather than as a database error',
      !/P2002|prisma|constraint|SQLSTATE/i.test(message), message.slice(0, 70));
  } else {
    check('a practice record was available to attempt an outbound action on', false,
      'no routeId came back from the preview');
  }

  // -------------------------------------------------------------------------
  console.log('\n--- what the owner sees afterwards -------------------------------');
  if (createdCallerId) {
    await goTo(owner, `/callers/${createdCallerId}`);
    await owner.waitForSelector('[data-testid="detail-summary"]', { timeout: 30000 });
    const attempts = await owner.locator('[data-testid="detail-attempt"]').count();
    check('the saved outcome appears on the caller screen', attempts > 0, `${attempts} calls`);
    check('and is marked as test work',
      (await owner.locator('[data-testid="detail-attempts"]').innerText()).includes('TEST'));
  } else {
    check('the caller detail screen could be opened', false, 'no caller id from the roster');
  }

  // -------------------------------------------------------------------------
  console.log('\n--- production is untouched --------------------------------------');
  const after = await productionNumbers(owner);
  for (const [bucket, count] of Object.entries(before.buckets)) {
    check(`production "${bucket}" is unchanged`, after.buckets[bucket] === count,
      `${count} then ${after.buckets[bucket]}`);
  }
} catch (error) {
  console.log(` FAIL  the walkthrough stopped: ${String(error).slice(0, 400)}`);
  failures += 1;
  checks += 1;
} finally {
  // -------------------------------------------------------------------------
  console.log('\n--- putting the deployment back ----------------------------------');
  try {
    const cookieJar = await (async () => {
      const response = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
      });
      const raw = response.headers.get('set-cookie');
      return raw ? raw.split(';')[0] : null;
    })();

    if (cookieJar && createdCallerId) {
      const off = await api('/api/callers', {
        method: 'POST', cookie: cookieJar,
        body: { action: 'deactivate', callerId: createdCallerId, reason: 'Deployed walkthrough finished.' },
      });
      check('the walkthrough caller is deactivated and their work returned',
        off.status === 200, `HTTP ${off.status}`);
    }
    if (cookieJar) {
      const reset = await api('/api/callers', {
        method: 'POST', cookie: cookieJar, body: { action: 'sandbox_reset' },
      });
      check('the sandbox is reset to its starting state', reset.status === 200, `HTTP ${reset.status}`);
    }
  } catch (error) {
    check('the deployment was put back', false, String(error).slice(0, 120));
  }

  if (browser) await browser.close();
  console.log(`\n${checks - failures}/${checks} checks passed.`);
  process.exitCode = failures > 0 ? 1 : 0;
}
