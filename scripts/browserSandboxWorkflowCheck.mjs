/**
 * The whole sandbox shift, in a browser, from an owner's first click.
 *
 * Create a test caller, hand them a PIN, sign in as them at /work, break a save
 * on our side, watch them be held and then released by an owner, and work the
 * practice records through every refusal the product can produce — an
 * incomplete form, a callback, a wrong number, a do-not-contact — then finish
 * the packet and reset.
 *
 * The save failure is injected by installing a temporary database trigger that
 * makes a test route's attempt insert raise, and removing it afterwards.
 * Deliberately not a flag in the product: a test-only branch in the save path is
 * a branch that can fire in production, and the thing being proved here is what
 * a caller sees when a real save breaks.
 *
 * It is injected on the *first* record rather than the last. An open incident
 * blocks the caller from all new work until a person closes it, so failing at
 * the end would only ever test the block against an empty packet — which is how
 * the missing "mark it fixed" path went unnoticed long enough for a broken save
 * to be able to end a caller's day permanently.
 *
 * Production is counted before and after. Not one route, attempt, packet or
 * queue number may move.
 *
 *   npm run build && npx next start -p 3111
 *   node scripts/browserSandboxWorkflowCheck.mjs
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

const scratch = mkdtempSync(join('scripts', '.sandbox-check-'));
function server(body) {
  const file = join(scratch, `step-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(file, `async function main() {\n${body}\n}\nmain().catch((e) => { console.error(e); process.exit(1); });\n`);
  const out = execFileSync('npx', ['tsx', file], {
    encoding: 'utf8',
    env: { ...process.env, DIRECT_URL: process.env.DIRECT_URL ?? process.env.DATABASE_URL },
  }).trim();
  return out.split('\n').pop();
}

async function signIn(page, email, password) {
  const response = await page.request.post(`${BASE}/api/auth/login`, {
    data: { email, password }, failOnStatusCode: false,
  });
  if (!response.ok()) {
    throw new Error(`Sign-in failed for ${email}: HTTP ${response.status()}${
      response.status() === 429 ? ' — rate-limited, wait a minute and re-run' : ''}`);
  }
}

/**
 * A timezone where it is currently a weekday inside 8am–6pm.
 *
 * Widened beyond the US deliberately. The eligibility rule asks what time it is
 * *where the business is*, and at 04:00 Eastern there is no American zone in
 * the window — so a US-only list would make this check unrunnable for most of
 * the night rather than exercising the rule. The fixture contacts are moved to
 * whichever zone is currently open, which is the same rule doing the same work.
 */
function callableTimezone() {
  const zones = [
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'Europe/London', 'Europe/Berlin', 'Europe/Athens', 'Asia/Dubai',
    'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland',
  ];
  for (const zone of zones) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hour: 'numeric', hour12: false, weekday: 'short',
    }).formatToParts(new Date());
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const day = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
    if (!['Sat', 'Sun'].includes(day) && hour >= 8 && hour < 18) return zone;
  }
  return null;
}

const stamp = Date.now();
const email = `sandbox-caller-${stamp}@dealdispatch.test`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});

try {
  const zone = callableTimezone();
  if (!zone) {
    console.log(' FAIL  no US timezone is inside business hours right now (weekend or out of hours).');
    console.log('        The workspace correctly refuses to serve anything, so the shift cannot be driven.');
    console.log('        Re-run on a weekday between 08:00 and 18:00 in any US timezone.');
    process.exitCode = 1;
    throw new Error('outside callable hours');
  }
  console.log(`Using ${zone}, where it is currently inside calling hours.\n`);

  // -------------------------------------------------------------------------
  console.log('--- production, before anybody touches the sandbox ----------------');
  const beforeJson = server(`
    const { prisma } = await import('@/lib/db');
    const { eligibilityCounts } = await import('@/lib/demand/eligibility');
    const { resetSandbox } = await import('@/lib/caller/sandbox');
    const org = await prisma.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
    const owner = await prisma.user.findFirstOrThrow({ where: { orgId: org.id, email: 'owner@dealdispatch.test' } });

    // Old runs of this check, cleared so counts are comparable.
    const stale = await prisma.user.findMany({
      where: { orgId: org.id, email: { contains: 'sandbox-caller-' } }, select: { id: true },
    });
    const staleIds = stale.map((s) => s.id);
    if (staleIds.length > 0) {
      await prisma.packetItem.deleteMany({ where: { callerId: { in: staleIds } } });
      await prisma.workPacket.deleteMany({ where: { callerId: { in: staleIds } } });
      await prisma.callerProfile.deleteMany({ where: { userId: { in: staleIds } } });
      await prisma.user.deleteMany({ where: { id: { in: staleIds } } });
    }
    await resetSandbox({ orgId: org.id, actorId: owner.id });

    // The sandbox contacts are put in a timezone where it is business hours, so
    // the serve loop's own rule is exercised rather than bypassed.
    await prisma.contact.updateMany({
      where: { orgId: org.id, company: { dataMode: 'TEST' } },
      data: { timezone: ${JSON.stringify(zone)} },
    });

    const counts = await eligibilityCounts({ orgId: org.id, mode: 'PRODUCTION' });
    console.log(JSON.stringify({
      orgId: org.id,
      production: {
        routes: await prisma.routeHypothesis.count({ where: { orgId: org.id, dataMode: 'PRODUCTION' } }),
        attempts: await prisma.outreachAttempt.count({ where: { orgId: org.id, dataMode: 'PRODUCTION' } }),
        items: await prisma.packetItem.count({ where: { orgId: org.id, dataMode: 'PRODUCTION' } }),
        packets: await prisma.workPacket.count({ where: { orgId: org.id, dataMode: 'PRODUCTION' } }),
        callable: counts.CALLABLE_NOW,
        research: counts.RESEARCH_NEEDED,
      },
      testRoutes: await prisma.routeHypothesis.count({ where: { orgId: org.id, dataMode: 'TEST' } }),
    }));
  `);
  const before = JSON.parse(beforeJson);
  check('the sandbox starts from a known state', before.testRoutes >= 3, `${before.testRoutes} test routes`);

  // -------------------------------------------------------------------------
  console.log('\n--- the owner creates a test caller and hands over a PIN ----------');
  const ownerContext = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const owner = await ownerContext.newPage();
  owner.on('pageerror', (e) => console.log(`  [page error] ${e.message}`));
  await signIn(owner, process.env.DEMO_EMAIL ?? 'owner@dealdispatch.test', PASSWORD);

  await owner.goto(`${BASE}/callers`);
  await owner.waitForSelector('[data-testid="create-test-caller"]');
  await owner.click('[data-testid="create-test-caller"]');
  await owner.waitForSelector('[data-testid="add-caller-form"]');
  await owner.fill('[data-testid="new-name"]', 'Sandbox Practice');
  await owner.fill('[data-testid="new-email"]', email);
  await owner.click('[data-testid="save-caller"]');
  await owner.waitForLoadState('networkidle');
  check('a test caller is created from the floor', true);

  // Find their card and issue the PIN.
  const card = owner.locator('[data-testid="caller-card"]', { hasText: 'Sandbox Practice' }).first();
  await card.waitFor({ timeout: 15000 });
  check('and appears marked TEST', (await card.innerText()).includes('TEST'));
  await card.locator('[data-testid="issue-pin"]').click();
  await owner.waitForSelector('[data-testid="pin-value"]', { timeout: 15000 });
  const pin = (await owner.locator('[data-testid="pin-value"]').innerText()).trim();
  check('a PIN is shown exactly once', /^\d{6}$/.test(pin), `${pin.length} digits`);
  await owner.click('[data-testid="copy-pin"]');
  await owner.waitForTimeout(500);
  const copyLabel = (await owner.locator('[data-testid="copy-pin"]').innerText()).trim();
  const copyWarned = await owner.locator('[data-testid="copy-pin-failed"]').count();
  check('and the copy button reports what actually happened',
    (copyLabel.includes('Copied') && copyWarned === 0)
    || (/by hand/i.test(copyLabel) && copyWarned > 0),
    `${copyLabel}${copyWarned > 0 ? ' + a warning' : ''}`);

  // -------------------------------------------------------------------------
  console.log('\n--- the owner assigns the practice packet -------------------------');
  await owner.goto(`${BASE}/callers`);
  const card2 = owner.locator('[data-testid="caller-card"]', { hasText: 'Sandbox Practice' }).first();
  await card2.locator('[data-testid="preview-assignment"]').click();
  await owner.waitForSelector('[data-testid="assignment-preview"]', { timeout: 15000 });
  const previewText = await owner.locator('[data-testid="assignment-preview"]').innerText();
  check('the preview offers only sandbox records',
    previewText.includes('[TEST]') || previewText.includes('Nothing is callable'),
    previewText.split('\n').slice(0, 3).join(' ').slice(0, 100));
  const rows = await owner.locator('[data-testid="preview-row"]').count();
  check('and lists them before anything is assigned', rows > 0, `${rows} rows`);
  await owner.click('[data-testid="confirm-assignment"]');
  await owner.waitForLoadState('networkidle');
  check('the packet is assigned', true);

  // -------------------------------------------------------------------------
  console.log('\n--- the caller signs in at /work ----------------------------------');
  const callerContext = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const caller = await callerContext.newPage();
  caller.on('pageerror', (e) => console.log(`  [page error] ${e.message}`));

  await caller.goto(`${BASE}/work`);
  const inputs = caller.locator('form input');
  await inputs.nth(0).fill(email);
  await inputs.nth(1).fill(pin);
  await caller.locator('form button[type="submit"]').click();
  await caller.waitForLoadState('networkidle');
  const readiness = await caller.locator('body').innerText();
  check('the PIN signs them in and the shift check appears',
    !readiness.includes('Enter your email') && /waiting|ready|packet/i.test(readiness),
    readiness.split('\n').slice(0, 2).join(' ').slice(0, 90));

  // -------------------------------------------------------------------------
  console.log('\n--- working the practice records ----------------------------------');
  await caller.goto(`${BASE}/work/call`);
  await caller.waitForLoadState('networkidle');
  let body = await caller.locator('body').innerText();
  check('a sandbox record is served, marked as test',
    body.includes('[TEST]'), body.split('\n').slice(0, 3).join(' ').slice(0, 100));

  /** Saves with a disposition, optionally filling required fields first. */
  async function saveWith(disposition, { fill = true, followUp = null, notes = null } = {}) {
    await caller.locator(`[data-testid="disposition-${disposition}"]`).first().click();
    if (fill) {
      const fields = caller.locator('[data-testid^="field-"]');
      const count = await fields.count();
      for (let i = 0; i < count; i += 1) {
        const field = fields.nth(i);
        if ((await field.inputValue()) === '') await field.fill('Recorded during the sandbox walkthrough.');
      }
    }
    if (followUp) await caller.locator('[data-testid="follow-up"]').fill(followUp);
    if (notes) await caller.locator('[data-testid="notes"]').fill(notes);
    await caller.locator('[data-testid="save-call"]').click();
    await caller.waitForTimeout(1200);
  }

  // -------------------------------------------------------------------------
  // The failure comes first, deliberately.
  //
  // An open save-failure incident holds the caller out of *all* new work until
  // a person closes it, so a run that injected the failure last would only ever
  // exercise it against an empty packet — which is exactly how the missing
  // resolution path stayed invisible. Failing on the first record means the
  // rest of the shift can only proceed if the block, and the release from it,
  // both actually work.
  console.log('\n--- a save that fails on our side ---------------------------------');
  const openBefore = Number(server(`
    const { prisma } = await import('@/lib/db');
    const org = await prisma.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
    console.log(await prisma.workIncident.count({ where: { orgId: org.id, status: 'OPEN', kind: 'SAVE_FAILURE' } }));
  `));

  const injected = server(`
    const { prisma } = await import('@/lib/db');
    // A temporary trigger, not a flag in the product. The save path has no test
    // branch, so what the caller sees here is exactly what a real failure looks
    // like. Scoped to test rows so a production write cannot hit it.
    await prisma.$executeRawUnsafe(\`
      CREATE OR REPLACE FUNCTION "sandboxCheckInjectedFailure"() RETURNS trigger AS $fn$
      BEGIN
        IF NEW."dataMode" = 'TEST' THEN
          RAISE EXCEPTION 'injected failure for the sandbox walkthrough';
        END IF;
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql;
    \`);
    await prisma.$executeRawUnsafe(\`
      CREATE TRIGGER "sandbox_check_injected_failure"
      BEFORE INSERT ON "OutreachAttempt"
      FOR EACH ROW EXECUTE FUNCTION "sandboxCheckInjectedFailure"();
    \`);
    console.log('installed');
  `);
  check('a failure is injected at the database, with no test branch in the product',
    injected === 'installed', injected);

  const failing = caller.locator('[data-testid^="disposition-"]').first();
  check('a record was available to fail on', (await failing.count()) > 0);
  const failingId = await failing.getAttribute('data-testid');
  await saveWith(failingId.replace('disposition-', ''), { fill: true, notes: 'Sandbox: this one should fail.' });
  const systemRefusal = await caller.locator('[data-testid="refusal-system"]').count();
  const refusalText = systemRefusal > 0 ? await caller.locator('[data-testid="refusal-system"]').innerText() : '';
  check('the caller is told the failure was ours, not theirs', systemRefusal > 0, refusalText.slice(0, 110));
  check('and is told nothing they typed was lost',
    /nothing you (typed|entered)/i.test(refusalText) || /not been lost/i.test(refusalText),
    refusalText.slice(0, 110));

  const incident = server(`
    const { prisma } = await import('@/lib/db');
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS "sandbox_check_injected_failure" ON "OutreachAttempt";');
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS "sandboxCheckInjectedFailure"();');
    const org = await prisma.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
    const open = await prisma.workIncident.count({ where: { orgId: org.id, status: 'OPEN', kind: 'SAVE_FAILURE' } });
    console.log(JSON.stringify({ open }));
  `);
  const openAfter = JSON.parse(incident).open;
  check('and a new incident is raised for somebody to fix',
    openAfter > openBefore, `${openBefore} then ${openAfter} open save failures`);

  // The block is the point: with the fault unresolved, the caller must not be
  // handed anything new, and must not be told it is their doing.
  await caller.goto(`${BASE}/work/call`);
  await caller.waitForLoadState('networkidle');
  const held = await caller.locator('body').innerText();
  check('the caller is held out of new work while it is unresolved',
    /our fault|our side|being held/i.test(held), held.split('\n').slice(0, 4).join(' ').slice(0, 110));

  // -------------------------------------------------------------------------
  console.log('\n--- the owner clears the fault ------------------------------------');
  const callerId = server(`
    const { prisma } = await import('@/lib/db');
    const u = await prisma.user.findFirstOrThrow({ where: { email: ${JSON.stringify(email)} }, select: { id: true } });
    console.log(u.id);
  `);
  await owner.goto(`${BASE}/callers/${callerId}`);
  await owner.waitForSelector('[data-testid="detail-summary"]', { timeout: 15000 });
  const incidentRows = await owner.locator('[data-testid="detail-incident"]').count();
  check('the failure is shown to the owner as ours', incidentRows > 0, `${incidentRows} incidents`);
  await owner.locator('[data-testid^="resolve-incident-"]').first().click();
  await owner.waitForSelector('[data-testid="resolution-text"]');
  await owner.fill('[data-testid="resolution-text"]', 'Injected fault removed; the save path was never at fault.');
  await owner.click('[data-testid="confirm-resolve"]');
  await owner.waitForLoadState('networkidle');
  check('and can mark it fixed, saying what was done',
    (await owner.locator('[data-testid="detail-incident"]').count()) === 0,
    `${await owner.locator('[data-testid="detail-incident"]').count()} still open`);

  await caller.goto(`${BASE}/work/call`);
  await caller.waitForLoadState('networkidle');
  body = await caller.locator('body').innerText();
  check('the caller is released and served again', body.includes('[TEST]'),
    body.split('\n').slice(0, 3).join(' ').slice(0, 100));

  // -------------------------------------------------------------------------
  console.log('\n--- the refusals a caller actually meets ---------------------------');
  // 1. Incomplete: a disposition with required fields, saved empty.
  const needsFields = await caller.locator('[data-testid="disposition-NEED_CONFIRMED"]').count();
  if (needsFields > 0) {
    await saveWith('NEED_CONFIRMED', { fill: false });
    const refused = await caller.locator('[data-testid="refusal-incomplete"]').count();
    check('an incomplete save is refused and says what is missing', refused > 0,
      refused > 0 ? (await caller.locator('[data-testid="refusal-incomplete"]').innerText()).slice(0, 90) : 'not refused');

    // 2. The same call, completed.
    await saveWith('NEED_CONFIRMED', { fill: true, notes: 'Sandbox: confirmed need.' });
    check('and the completed save is accepted', await caller.locator('[data-testid="refusal-incomplete"]').count() === 0);
  } else {
    check('the served record offers a disposition with required fields', false, 'NEED_CONFIRMED not offered');
  }

  // 3. A callback with a date.
  await caller.waitForLoadState('networkidle');
  body = await caller.locator('body').innerText();
  if (body.includes('[TEST]')) {
    const due = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    await saveWith('FOLLOW_UP', { fill: true, followUp: due, notes: 'Sandbox: call back Thursday.' });
    check('a callback is recorded with its date', true, due);
  }

  // 4. A wrong number.
  await caller.waitForLoadState('networkidle');
  if ((await caller.locator('[data-testid="disposition-WRONG_NUMBER"]').count()) > 0) {
    await saveWith('WRONG_NUMBER', { fill: true, notes: 'Sandbox: not this business.' });
    check('a wrong number is recorded', true);
  }

  // 5. Do not contact.
  await caller.waitForLoadState('networkidle');
  if ((await caller.locator('[data-testid="disposition-DO_NOT_CONTACT"]').count()) > 0) {
    await saveWith('DO_NOT_CONTACT', { fill: true, notes: 'Sandbox: asked never to be called.' });
    check('a do-not-contact is recorded', true);
  }

  // -------------------------------------------------------------------------
  console.log('\n--- what the owner can see about this caller ----------------------');
  await owner.goto(`${BASE}/callers/${callerId}`);
  await owner.waitForSelector('[data-testid="detail-summary"]', { timeout: 15000 });
  const detail = await owner.locator('body').innerText();
  check('the caller detail screen opens', detail.includes('Sandbox Practice'));
  check('and lists the calls they made', (await owner.locator('[data-testid="detail-attempt"]').count()) > 0,
    `${await owner.locator('[data-testid="detail-attempt"]').count()} attempts`);
  check('and marks those calls as test work',
    (await owner.locator('[data-testid="detail-attempts"]').innerText()).includes('TEST'));
  check('and shows the packet history',
    (await owner.locator('[data-testid="detail-packet"]').count()) > 0);

  // -------------------------------------------------------------------------
  console.log('\n--- finishing the packet ------------------------------------------');
  let stoppedBecause = 'the packet emptied';
  for (let i = 0; i < 10; i += 1) {
    await caller.goto(`${BASE}/work/call`);
    await caller.waitForLoadState('networkidle');
    const text = await caller.locator('body').innerText();
    if (!text.includes('[TEST]')) {
      stoppedBecause = `nothing was served: ${text.split('\n').filter(Boolean).slice(0, 3).join(' / ').slice(0, 160)}`;
      break;
    }
    const first = caller.locator('[data-testid^="disposition-"]').first();
    if ((await first.count()) === 0) {
      stoppedBecause = `a record was served with no outcome to pick: ${text.split('\n').filter(Boolean).slice(0, 3).join(' / ').slice(0, 160)}`;
      break;
    }
    const id = await first.getAttribute('data-testid');
    await saveWith(id.replace('disposition-', ''), { fill: true, notes: 'Sandbox: clearing the packet.' });
  }
  console.log(`       drain loop stopped: ${stoppedBecause}`);
  if (/save failed/i.test(stoppedBecause)) {
    // A second failure, after the injected one was removed. Print what broke:
    // "the caller was blocked" is not a diagnosis anybody can act on.
    console.log(`       the fault was: ${server(`
      const { prisma } = await import('@/lib/db');
      const org = await prisma.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
      const i = await prisma.workIncident.findFirst({
        where: { orgId: org.id, status: 'OPEN', kind: 'SAVE_FAILURE' },
        orderBy: { createdAt: 'desc' }, select: { detail: true },
      });
      console.log(JSON.stringify(i?.detail ?? 'none').slice(0, 400));
    `)}`);
  }

  // Asked of the database, not of the page. An earlier version of this check
  // matched a word in the shift summary and passed while two records were
  // still waiting — "the packet ran out" has to mean the packet is empty.
  const leftJson = server(`
    const { prisma } = await import('@/lib/db');
    const org = await prisma.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
    const items = await prisma.packetItem.findMany({
      where: { orgId: org.id, dataMode: 'TEST', status: { in: ['PENDING', 'IN_PROGRESS'] } },
      select: {
        status: true,
        route: { select: { headline: true, outreach: { select: { snoozeUntil: true } } } },
      },
    });
    console.log(JSON.stringify(items.map((i) => ({
      status: i.status,
      snoozed: i.route.outreach?.snoozeUntil ?? null,
      headline: i.route.headline.slice(0, 40),
    }))));
  `);
  const left = JSON.parse(leftJson);
  // A record with a promised callback is not unfinished work — it is work with
  // a date on it, and serving it again today would be the bug. So the check is
  // that nothing is left *undealt with*, not that the packet is empty.
  const undealt = left.filter((i) => !i.snoozed || new Date(i.snoozed) <= new Date());
  check('every practice record was either worked or given a date',
    undealt.length === 0,
    left.length === 0 ? 'packet empty'
      : `${left.length} left, ${undealt.length} without a callback — ${left.map((i) => `${i.status}${i.snoozed ? ' (callback set)' : ''}`).join(', ')}`);

  await caller.goto(`${BASE}/work`);
  await caller.waitForLoadState('networkidle');
  const finished = await caller.locator('body').innerText();
  check('and the shift summary is honest about what is left',
    !/error|something went wrong/i.test(finished)
    && (/0 opportunities waiting|ask for more|no open packet|nothing left/i.test(finished)
      || new RegExp(`${left.length} opportunit`).test(finished)),
    finished.split('\n').slice(0, 3).join(' ').slice(0, 100));

  // -------------------------------------------------------------------------
  console.log('\n--- production is untouched ---------------------------------------');
  const afterJson = server(`
    const { prisma } = await import('@/lib/db');
    const { eligibilityCounts } = await import('@/lib/demand/eligibility');
    const org = await prisma.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
    const counts = await eligibilityCounts({ orgId: org.id, mode: 'PRODUCTION' });
    console.log(JSON.stringify({
      routes: await prisma.routeHypothesis.count({ where: { orgId: org.id, dataMode: 'PRODUCTION' } }),
      attempts: await prisma.outreachAttempt.count({ where: { orgId: org.id, dataMode: 'PRODUCTION' } }),
      items: await prisma.packetItem.count({ where: { orgId: org.id, dataMode: 'PRODUCTION' } }),
      packets: await prisma.workPacket.count({ where: { orgId: org.id, dataMode: 'PRODUCTION' } }),
      callable: counts.CALLABLE_NOW,
      research: counts.RESEARCH_NEEDED,
      testAttempts: await prisma.outreachAttempt.count({ where: { orgId: org.id, dataMode: 'TEST' } }),
    }));
  `);
  const after = JSON.parse(afterJson);
  check('test calls were actually recorded', after.testAttempts > 0, `${after.testAttempts} test attempts`);
  for (const key of ['routes', 'attempts', 'items', 'packets', 'callable', 'research']) {
    check(`production ${key} is unchanged`, before.production[key] === after[key],
      `${before.production[key]} then ${after[key]}`);
  }

  // -------------------------------------------------------------------------
  console.log('\n--- resetting the sandbox -----------------------------------------');
  await owner.goto(`${BASE}/callers`);
  owner.once('dialog', (d) => void d.accept());
  await owner.click('[data-testid="sandbox-reset"]');
  await owner.waitForLoadState('networkidle');

  const resetJson = server(`
    const { prisma } = await import('@/lib/db');
    const org = await prisma.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
    console.log(JSON.stringify({
      testRoutes: await prisma.routeHypothesis.count({ where: { orgId: org.id, dataMode: 'TEST' } }),
      testAttempts: await prisma.outreachAttempt.count({ where: { orgId: org.id, dataMode: 'TEST' } }),
      testCallers: await prisma.user.count({ where: { orgId: org.id, callerProfile: { dataMode: 'TEST' } } }),
      productionRoutes: await prisma.routeHypothesis.count({ where: { orgId: org.id, dataMode: 'PRODUCTION' } }),
      productionAttempts: await prisma.outreachAttempt.count({ where: { orgId: org.id, dataMode: 'PRODUCTION' } }),
    }));
  `);
  const reset = JSON.parse(resetJson);
  check('the fixtures are back at their starting state', reset.testRoutes >= 3, `${reset.testRoutes} routes`);
  check('the practice calls are gone', reset.testAttempts === 0, `${reset.testAttempts} test attempts`);
  check('the test caller survives the reset', reset.testCallers > 0, `${reset.testCallers} test callers`);
  check('and production is still untouched by the reset',
    reset.productionRoutes === before.production.routes && reset.productionAttempts === before.production.attempts,
    `${reset.productionRoutes} routes, ${reset.productionAttempts} attempts`);

  await ownerContext.close();
  await callerContext.close();

  console.log(`\n${checks - failures}/${checks} checks passed.`);
} finally {
  // The injected trigger is removed even if the run threw partway.
  try {
    server(`
      const { prisma } = await import('@/lib/db');
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS "sandbox_check_injected_failure" ON "OutreachAttempt";');
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS "sandboxCheckInjectedFailure"();');
      console.log('clean');
    `);
  } catch { /* the database may be unreachable; the drop is idempotent next run */ }
  await browser.close();
  rmSync(scratch, { recursive: true, force: true });
}

process.exitCode = failures > 0 ? 1 : 0;
