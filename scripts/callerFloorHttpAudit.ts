/**
 * The calling floor over real HTTP, tested against the API rather than the UI.
 *
 * The brief for this work said it plainly: test through direct API calls, not
 * only hidden UI. That is the right instruction, because the page this replaces
 * was protected mainly by not rendering a button — `/api/work/pin` would create
 * a caller profile for any user id in a request body, so a caller who could
 * read their own network tab could have minted themselves a colleague.
 *
 *   BASE_URL=http://localhost:3111 npx tsx scripts/callerFloorHttpAudit.ts
 */

import { prisma } from '@/lib/db';

const BASE = process.env.BASE_URL ?? 'http://localhost:3111';
const PASSWORD = 'demo-password-123';

let failures = 0;
let checks = 0;

function check(label: string, passed: boolean, detail = '') {
  checks += 1;
  if (!passed) failures += 1;
  console.log(`${passed ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
}

/** How many checks this audit runs when nothing is skipped. */
const EXPECTED_CHECKS = 25;

/** Throws rather than skipping. A partial run must not read as a clean one. */
async function signIn(email: string): Promise<string> {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!response.ok) {
    const hint = response.status === 429
      ? 'rate-limited — ten attempts a minute per address. Wait a minute and re-run.'
      : await response.text().catch(() => '');
    throw new Error(`Sign-in failed for ${email}: HTTP ${response.status} — ${hint}`);
  }
  const cookie = response.headers.get('set-cookie');
  if (!cookie) throw new Error(`Sign-in for ${email} returned no session cookie.`);
  return cookie.split(';')[0];
}

async function post(path: string, body: unknown, cookie?: string | null) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
}

const stamp = Date.now();

async function main() {
  const org = await prisma.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  const someCaller = await prisma.user.findFirst({
    where: { orgId: org.id, callerProfile: { isNot: null }, isActive: true },
    select: { id: true, email: true },
  });
  const owner = await prisma.user.findFirstOrThrow({
    where: { orgId: org.id, email: 'owner@dealdispatch.test' }, select: { id: true },
  });
  if (!someCaller) throw new Error('No caller in the seed. Run the seed first.');

  // -----------------------------------------------------------------------
  console.log('--- nobody at all ------------------------------------------------');

  for (const body of [
    { action: 'create', name: 'Anon', email: `anon-${stamp}@x.test` },
    { action: 'issue_pin', callerId: someCaller.id },
    { action: 'preview_assignment', callerId: someCaller.id, requested: 5 },
  ]) {
    const anonymous = await post('/api/callers', body);
    check(`/api/callers refuses an unauthenticated ${String(body.action)}`,
      anonymous.status === 401, `got ${anonymous.status}`);
  }

  const page = await fetch(`${BASE}/callers`, { redirect: 'manual' });
  check('the floor is not public', page.status === 307 || page.status === 302, `got ${page.status}`);

  // -----------------------------------------------------------------------
  console.log('\n--- a caller cannot run the floor ---------------------------------');

  const caller = await signIn('dana@dealdispatch.test');

  const attempts: Array<[string, Record<string, unknown>]> = [
    ['create a caller', { action: 'create', name: 'Sneaky', email: `sneaky-${stamp}@x.test` }],
    ['issue a PIN', { action: 'issue_pin', callerId: someCaller.id }],
    ['revoke a PIN', { action: 'revoke_pin', callerId: someCaller.id }],
    ['deactivate somebody', { action: 'deactivate', callerId: someCaller.id }],
    ['assign a packet', { action: 'assign', callerId: someCaller.id, routeIds: ['x'] }],
    ['preview an assignment', { action: 'preview_assignment', callerId: someCaller.id, requested: 5 }],
    ['create sandbox data', { action: 'sandbox_create' }],
    ['reset the sandbox', { action: 'sandbox_reset' }],
  ];
  for (const [what, body] of attempts) {
    const result = await post('/api/callers', body, caller);
    check(`a caller cannot ${what}`, result.status === 403, `got ${result.status}`);
  }

  const rosterAsCaller = await fetch(`${BASE}/api/callers`, { headers: { cookie: caller } });
  check('and cannot read the roster of other callers',
    rosterAsCaller.status === 403, `got ${rosterAsCaller.status}`);

  const floorAsCaller = await fetch(`${BASE}/callers`, { headers: { cookie: caller }, redirect: 'manual' });
  check('and cannot open the floor page', floorAsCaller.status !== 200, `got ${floorAsCaller.status}`);

  // The old endpoint, checked directly: it must no longer mint a profile.
  const legacyPin = await post('/api/work/pin', { userId: owner.id }, caller);
  check('the legacy PIN endpoint refuses a caller outright',
    legacyPin.status === 403, `got ${legacyPin.status}`);

  // -----------------------------------------------------------------------
  console.log('\n--- an owner runs the floor ---------------------------------------');

  const ownerCookie = await signIn('owner@dealdispatch.test');

  const made = await post('/api/callers', {
    action: 'create', name: 'HTTP Audit Caller', email: `http-audit-${stamp}@dealdispatch.test`,
  }, ownerCookie);
  check('an owner can create a caller', made.status === 200, `got ${made.status}`);
  const newCallerId = String(made.body.callerId ?? '');

  const converted = await post('/api/callers', {
    action: 'issue_pin', callerId: owner.id,
  }, ownerCookie);
  check('issuing a PIN to the owner account is refused, not silently allowed',
    converted.status === 409, `got ${converted.status}: ${String(converted.body.error ?? '').slice(0, 60)}`);

  const pin = await post('/api/callers', { action: 'issue_pin', callerId: newCallerId }, ownerCookie);
  check('and can issue a PIN to a real caller', pin.status === 200, `got ${pin.status}`);
  check('which comes back exactly once, as six digits',
    /^\d{6}$/.test(String(pin.body.pin ?? '')), `${String(pin.body.pin ?? '').length} chars`);

  // The critical read-back check: no subsequent API read may return it.
  const rosterRead = await fetch(`${BASE}/api/callers`, { headers: { cookie: ownerCookie } });
  const rosterText = await rosterRead.text();
  check('and no later read returns it, or any hash',
    !rosterText.includes(String(pin.body.pin)) && !/pinHash/.test(rosterText),
    rosterRead.status === 200 ? 'roster read clean' : `roster status ${rosterRead.status}`);

  const floorHtml = await fetch(`${BASE}/callers`, { headers: { cookie: ownerCookie } }).then((r) => r.text());
  check('and it is not in the page source either',
    !floorHtml.includes(String(pin.body.pin)) && !/pinHash/.test(floorHtml));

  // -----------------------------------------------------------------------
  console.log('\n--- preview is a read ---------------------------------------------');

  const before = await prisma.packetItem.count({ where: { orgId: org.id } });
  await post('/api/callers', { action: 'preview_assignment', callerId: newCallerId, requested: 10 }, ownerCookie);
  await post('/api/callers', { action: 'preview_assignment', callerId: newCallerId, requested: 10 }, ownerCookie);
  const after = await prisma.packetItem.count({ where: { orgId: org.id } });
  check('previewing twice over HTTP assigns nothing', before === after, `${before} then ${after}`);

  const previewPage = await fetch(`${BASE}/callers/preview`, { headers: { cookie: ownerCookie } });
  const attemptsBefore = await prisma.outreachAttempt.count({ where: { orgId: org.id } });
  await fetch(`${BASE}/callers/preview`, { headers: { cookie: ownerCookie } });
  const attemptsAfter = await prisma.outreachAttempt.count({ where: { orgId: org.id } });
  check('and loading the read-only workspace preview records no attempt',
    previewPage.status === 200 && attemptsBefore === attemptsAfter,
    `status ${previewPage.status}, ${attemptsBefore} then ${attemptsAfter}`);

  // -----------------------------------------------------------------------
  console.log('\n--- revocation bites ----------------------------------------------');

  const email = `http-audit-${stamp}@dealdispatch.test`;
  const signInOk = await post('/api/work/signin', { identifier: email, pin: pin.body.pin }, null);
  check('the issued PIN signs in at the workspace', signInOk.status === 200, `got ${signInOk.status}`);

  await post('/api/callers', { action: 'revoke_pin', callerId: newCallerId }, ownerCookie);
  const signInAfter = await post('/api/work/signin', { identifier: email, pin: pin.body.pin }, null);
  check('and stops the moment it is revoked', signInAfter.status === 401, `got ${signInAfter.status}`);

  // -----------------------------------------------------------------------
  await prisma.packetItem.deleteMany({ where: { callerId: newCallerId } });
  await prisma.workPacket.deleteMany({ where: { callerId: newCallerId } });
  await prisma.callerProfile.deleteMany({ where: { userId: newCallerId } });
  await prisma.user.deleteMany({ where: { id: newCallerId } });

  if (checks !== EXPECTED_CHECKS) {
    failures += 1;
    console.log(` FAIL  the audit ran every check it has — ran ${checks} of ${EXPECTED_CHECKS}`);
  }

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
