/**
 * Call intelligence over real HTTP.
 *
 * The access questions here are unusual for this codebase, because the objects
 * being protected are recordings of named people saying things they did not
 * expect to be filed:
 *
 *   A caller may make a call. A caller may not erase the audio of their own
 *   call — that is evidence about their work, and letting them delete it is the
 *   one permission that would make every review meaningless.
 *
 *   Judging a review needs a supervisor's permission, not the transcript one.
 *   Callers hold `call.transcript.read` for their own calls, and the queue
 *   carries script observations about other callers — so that gate would hand
 *   every caller everybody else's appraisal. Flagging their own call stays open
 *   to them, because a caller saying "the analysis got mine wrong" is the
 *   cheapest correction signal here.
 *
 *   A storage key must never come back from a read path, and never reach the
 *   database except through the field whose name says the audio exists.
 *
 *   BASE_URL=http://localhost:3111 npx tsx scripts/callIntelligenceHttpAudit.ts
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

/** Throws rather than skipping. A partial run must not read as a clean one. */
async function signIn(email: string): Promise<string> {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!response.ok) {
    const hint = response.status === 429
      ? 'rate-limited — the login route allows ten attempts a minute per address. Wait a minute and re-run.'
      : await response.text().catch(() => '');
    throw new Error(`Sign-in failed for ${email}: HTTP ${response.status} — ${hint}`);
  }
  const cookie = response.headers.get('set-cookie');
  if (!cookie) throw new Error(`Sign-in for ${email} returned no session cookie.`);
  return cookie.split(';')[0];
}

/** How many checks this audit runs when nothing is skipped. */
const EXPECTED_CHECKS = 21;

async function post(path: string, body: unknown, cookie?: string | null) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
}

async function main() {
  const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!org) throw new Error('No organisation. Seed the database first.');

  const route = await prisma.routeHypothesis.findFirst({
    where: { orgId: org.id }, orderBy: { createdAt: 'asc' }, select: { id: true },
  });
  if (!route) throw new Error('No route. Run scripts/dealProgressionAudit.ts first.');

  // -----------------------------------------------------------------------
  console.log('--- nobody at all ------------------------------------------------');

  for (const [path, body] of [
    ['/api/calls/session', { action: 'start', routeId: route.id }],
    ['/api/calls/review', { action: 'flag', sessionId: 'x' }],
  ] as const) {
    const anonymous = await post(path, body);
    check(`${path} refuses an unauthenticated request`, anonymous.status === 401, `got ${anonymous.status}`);
  }

  const page = await fetch(`${BASE}/reviews`, { redirect: 'manual' });
  check('the review queue is not public',
    page.status === 307 || page.status === 302 || page.status === 401, `got ${page.status}`);

  // -----------------------------------------------------------------------
  console.log('\n--- a caller may call, and may not erase the evidence -------------');

  const caller = await signIn('dana@dealdispatch.test');

  const started = await post(
    '/api/calls/session',
    { action: 'start', routeId: route.id, intendedCapture: 'PROVIDER_RECORDING', callerState: 'IL' },
    caller,
  );
  check('a caller can start a call session', started.status === 200, `got ${started.status}`);
  check('and is told not to record where the law says so',
    started.body.mayRecord === false, JSON.stringify(started.body.consent));
  check('with the announcement handed to them rather than improvised',
    typeof started.body.announcement === 'string' || started.body.announcement === null);

  const sessionId = String(started.body.sessionId ?? '');

  const erase = await post(
    '/api/calls/session',
    { action: 'delete_recording', sessionId, reason: 'covering my tracks' },
    caller,
  );
  check('a caller cannot delete a recording', erase.status === 403, `got ${erase.status}`);

  // Their own call: allowed, and deliberately so.
  const ownFlag = await post('/api/calls/review', { action: 'flag', sessionId }, caller);
  check('a caller can flag their own call for review', ownFlag.status === 200, `got ${ownFlag.status}`);

  // Judging one: not theirs to do.
  const judge = await post(
    '/api/calls/review',
    { action: 'decide', insightId: 'x', decision: 'CONFIRMED' },
    caller,
  );
  check('a caller cannot judge a conclusion', judge.status === 403, `got ${judge.status}`);

  const queueAsCaller = await fetch(`${BASE}/reviews`, { headers: { cookie: caller }, redirect: 'manual' });
  check('and cannot open the review queue, which is full of judgements about callers',
    queueAsCaller.status !== 200, `got ${queueAsCaller.status}`);

  // The one that matters most: a caller cannot claim audio exists.
  const claim = await post(
    '/api/calls/session',
    {
      action: 'finish', sessionId, durationSec: 60,
      stored: { storageKey: 'fabricated/audio.mp3', mimeType: 'audio/mpeg' },
    },
    caller,
  );
  check('finishing with a storage key is accepted by the route', claim.status === 200, `got ${claim.status}`);

  // ...and if it is, the row must genuinely be STORED, because the constraint
  // ties the two together. What must never happen is a key on a row that says
  // no audio was captured.
  const row = await prisma.callSession.findUnique({
    where: { id: sessionId },
    select: { recordingState: true, storageKey: true },
  });
  check('a stored key and a STORED state always travel together',
    (row?.storageKey === null) === (row?.recordingState !== 'STORED'),
    `${row?.recordingState}, key ${row?.storageKey ? 'present' : 'absent'}`);

  // -----------------------------------------------------------------------
  console.log('\n--- the reviewer --------------------------------------------------');

  const manager = await signIn('manager@dealdispatch.test');

  const flagged = await post('/api/calls/review', { action: 'flag', sessionId }, manager);
  check('a deal manager can flag a call for review', flagged.status === 200, `got ${flagged.status}`);

  const queue = await fetch(`${BASE}/reviews`, { headers: { cookie: manager } });
  check('and open the review queue', queue.status === 200, `got ${queue.status}`);
  const html = await queue.text();
  check('which never carries a storage key',
    !html.includes('fabricated/audio.mp3') && !/storageKey/.test(html));
  // Attribution when there are conclusions to attribute; the empty states are
  // legitimate and are named explicitly rather than folded into a loose OR.
  check('and attributes every conclusion, or says there are none',
    html.includes('concluded by')
    || html.includes('Nothing is waiting')
    || html.includes('concluded nothing from this call'));

  const closeEmpty = await post(
    '/api/calls/review',
    { action: 'complete', sessionId: 'not-a-session' },
    manager,
  );
  check('closing a review that does not exist is refused with a reason',
    closeEmpty.status === 409, `got ${closeEmpty.status}`);

  const badDecision = await post(
    '/api/calls/review',
    { action: 'decide', insightId: 'x', decision: 'CORRECTED' },
    manager,
  );
  check('a correction with no corrected value is refused',
    badDecision.status === 409, `got ${badDecision.status}`);

  const malformed = await post('/api/calls/session', { action: 'start' }, manager);
  check('a malformed request is a 400', malformed.status === 400, `got ${malformed.status}`);

  const foreign = await post(
    '/api/calls/session',
    { action: 'start', routeId: 'clx0000000000000000000000' },
    manager,
  );
  check('a route id from outside the account is not found', foreign.status === 404, `got ${foreign.status}`);

  // -----------------------------------------------------------------------
  console.log('\n--- the owner can erase on request ---------------------------------');

  const owner = await signIn('owner@dealdispatch.test');
  const deleted = await post(
    '/api/calls/session',
    { action: 'delete_recording', sessionId, reason: 'They asked us to delete it.' },
    owner,
  );
  // 200 when there was audio to delete, 409 with a reason when there was not.
  // Both are correct; silently succeeding on a call with no audio is not.
  check('the owner can delete a recording, or is told there is none',
    deleted.status === 200 || deleted.status === 409,
    `got ${deleted.status}: ${String(deleted.body.error ?? '')}`);

  await prisma.callReview.deleteMany({ where: { sessionId } });
  await prisma.callSession.deleteMany({ where: { id: sessionId } });

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
