/**
 * The System Manager over real HTTP.
 *
 * The authorization question here is sharper than anywhere else in this
 * codebase, because the objects being protected are judgements about people:
 *
 *   A caller may answer a question about their own work and may run their own
 *   readiness check. They may not see the manager screen, resolve a case, apply
 *   an intervention, or answer a question about somebody else — and a question
 *   about somebody else is a 404 rather than a 403, because the existence of a
 *   case about a colleague is itself information they should not have.
 *
 *   Concluding that somebody was at fault is a supervisor's act. No rule in the
 *   system can reach it, and neither can the person it is about.
 *
 *   The two rungs that touch somebody's standing rather than their workflow
 *   need the owner, and a manager pressing the button gets a refusal that says
 *   whose decision it is.
 *
 *   A restriction that is in force produces a 423 at the route that does the
 *   work — not a 403, because the person is permitted to do this and is
 *   temporarily stopped, and the two are different facts.
 *
 *   BASE_URL=http://localhost:3111 npx tsx scripts/systemManagerHttpAudit.ts
 */

import { prisma } from '@/lib/db';
import { RESTORATION } from '@/lib/manager/ladder';

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
const EXPECTED_CHECKS = 31;

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

  const caller = await prisma.user.findFirst({ where: { orgId: org.id, email: 'dana@dealdispatch.test' } });
  const owner = await prisma.user.findFirst({ where: { orgId: org.id, email: 'owner@dealdispatch.test' } });
  const route = await prisma.routeHypothesis.findFirst({ where: { orgId: org.id }, orderBy: { createdAt: 'asc' } });
  if (!caller || !owner || !route) throw new Error('Seed the database and run scripts/dealProgressionAudit.ts first.');

  await cleanUp(org.id);

  // Two cases: one about the caller, one about somebody else.
  const mine = await prisma.consistencyCase.create({
    data: {
      orgId: org.id, callerId: caller.id, routeId: route.id,
      kind: 'ATTEMPT_WITHOUT_EVIDENCE', dedupeKey: `http-audit-mine-${Date.now()}`,
      observed: 'HTTP audit fixture: a call with nothing recorded.',
      expected: 'HTTP audit fixture: something recorded.',
      evidence: [{ label: 'fixture', ref: 'Audit:1' }],
      benignAlternatives: ['The save dropped the notes.'],
      producedBy: 'audit', ruleVersion: 'audit@1', confidence: 0.9,
      question: 'HTTP audit fixture question.',
    },
  });
  const somebodyElses = await prisma.consistencyCase.create({
    data: {
      orgId: org.id, callerId: owner.id, routeId: route.id,
      kind: 'DUPLICATE_ATTEMPT', dedupeKey: `http-audit-theirs-${Date.now()}`,
      observed: 'HTTP audit fixture: two attempts close together.',
      expected: 'HTTP audit fixture: one conversation, one record.',
      evidence: [{ label: 'fixture', ref: 'Audit:1' }],
      benignAlternatives: ['A redial after a dropped call.'],
      producedBy: 'audit', ruleVersion: 'audit@1', confidence: 0.7,
      question: 'HTTP audit fixture question about somebody else.',
    },
  });

  // -----------------------------------------------------------------------
  console.log('--- nobody at all ------------------------------------------------');

  for (const body of [
    { action: 'sweep' },
    { action: 'resolve_case', caseId: mine.id, state: 'CONFIRMED', resolution: 'x' },
    { action: 'readiness' },
  ]) {
    const anonymous = await post('/api/manager', body);
    check(`/api/manager refuses an unauthenticated ${String(body.action)}`,
      anonymous.status === 401, `got ${anonymous.status}`);
  }

  const page = await fetch(`${BASE}/manager`, { redirect: 'manual' });
  check('the manager screen is not public',
    page.status === 307 || page.status === 302 || page.status === 401, `got ${page.status}`);

  // -----------------------------------------------------------------------
  console.log('\n--- a caller answers for their own work, and nothing else --------');

  const callerCookie = await signIn('dana@dealdispatch.test');

  const ownAnswer = await post('/api/manager', {
    action: 'answer_case', caseId: mine.id,
    answer: 'The line dropped as I was typing. I remember the call.',
  }, callerCookie);
  check('a caller can answer a question about their own call', ownAnswer.status === 200, `got ${ownAnswer.status}`);

  const stored = await prisma.consistencyCase.findUniqueOrThrow({ where: { id: mine.id } });
  check('and their words are recorded before anybody judges them',
    (stored.answer ?? '').includes('line dropped') && stored.state === 'OPEN', stored.state);

  const otherAnswer = await post('/api/manager', {
    action: 'answer_case', caseId: somebodyElses.id, answer: 'Not mine.',
  }, callerCookie);
  check('answering somebody else\'s case is a 404, not a 403 — its existence is not theirs to learn',
    otherAnswer.status === 404, `got ${otherAnswer.status}`);

  const callerResolve = await post('/api/manager', {
    action: 'resolve_case', caseId: mine.id, state: 'DISMISSED', resolution: 'Nothing to see.',
  }, callerCookie);
  check('a caller cannot close a case about themselves', callerResolve.status === 403, `got ${callerResolve.status}`);

  const callerApply = await post('/api/manager', {
    action: 'apply_intervention', caseId: mine.id,
  }, callerCookie);
  check('and cannot apply an intervention', callerApply.status === 403, `got ${callerApply.status}`);

  const callerSweep = await post('/api/manager', { action: 'sweep' }, callerCookie);
  check('and cannot run the sweep', callerSweep.status === 403, `got ${callerSweep.status}`);

  // An outage is staged first, so the blocker assertion below is checking a
  // blocker rather than passing vacuously on an empty list.
  const outage = await prisma.circuitBreaker.create({
    data: {
      orgId: org.id, capability: 'CALL_PLACING', state: 'OPEN',
      openedAt: new Date(), openedBecause: 'HTTP audit fixture: the dialer is down.',
      evidence: [{ label: 'fixture', ref: 'Audit:1' }],
      failureCount: 9, observedCount: 10, windowMinutes: 60,
      retryAt: new Date(Date.now() + 30 * 60_000),
      producedBy: 'audit', ruleVersion: 'audit@1',
    },
  });

  const callerReadiness = await post('/api/manager', { action: 'readiness' }, callerCookie);
  check('but can run their own readiness check', callerReadiness.status === 200, `got ${callerReadiness.status}`);

  const readiness = callerReadiness.body.readiness as
    { state: string; headline: string; blockers: Array<{ whose: string; what: string }> } | undefined;
  check('an outage produces a blocker rather than an empty list',
    (readiness?.blockers ?? []).length > 0, `${readiness?.blockers?.length ?? 0} blockers`);
  check('and every blocker on it says whose problem it is, with the outage marked ours',
    (readiness?.blockers ?? []).every((b) => b.whose === 'ours' || b.whose === 'yours')
    && (readiness?.blockers ?? []).some((b) => b.whose === 'ours'),
    JSON.stringify(readiness?.blockers ?? []).slice(0, 120));
  check('and the shift is blocked by the system, in those words',
    readiness?.state === 'BLOCKED_BY_SYSTEM' && /not your fault/.test(readiness?.headline ?? ''),
    `${readiness?.state}: ${readiness?.headline?.slice(0, 80)}`);

  await prisma.circuitBreaker.update({
    where: { id: outage.id },
    data: { state: 'CLOSED', closedAt: new Date(), closedBecause: 'HTTP audit fixture teardown.' },
  });

  const callerPage = await fetch(`${BASE}/manager`, { headers: { cookie: callerCookie }, redirect: 'manual' });
  check('a caller cannot open the manager screen, which is full of judgements about callers',
    callerPage.status !== 200, `got ${callerPage.status}`);

  // -----------------------------------------------------------------------
  console.log('\n--- a restriction is a 423, not a 403 ----------------------------');

  const restriction = await prisma.intervention.create({
    data: {
      orgId: org.id, callerId: caller.id, rung: 'RESTRICTED_MODE', capability: 'REQUIREMENT_CAPTURE',
      attribution: 'OPERATOR', reason: 'HTTP audit fixture: a live restriction.',
      evidence: [{ label: 'fixture', ref: 'Audit:1' }],
      restorationRule: RESTORATION.REQUIREMENT_CAPTURE,
      producedBy: 'audit', ruleVersion: 'audit@1',
      state: 'ACTIVE', shadow: false, enforcedAt: new Date(),
    },
  });

  const managerCookie = await signIn('manager@dealdispatch.test');
  const ownerCookie = await signIn('owner@dealdispatch.test');

  // The restriction is on the caller, so it is checked against a user who has
  // one. The deal manager and owner are unaffected, which is the point.
  const unaffected = await post('/api/deal/requirement', {
    action: 'capture', routeId: route.id, summary: 'HTTP audit: unaffected by somebody else\'s restriction.',
  }, managerCookie);
  check('a restriction on one person does not stop anybody else',
    unaffected.status === 200, `got ${unaffected.status}`);

  // And the same person, restricted, is stopped with the way out in the body.
  const restrictedCall = await post('/api/deal/requirement', {
    action: 'capture', routeId: route.id, summary: 'HTTP audit: should be refused.',
  }, callerCookie);
  // A caller does not hold `deal.write`, so this is a 403 for them regardless —
  // which is why the gate is checked against a user who does hold it below.
  check('a caller without the permission is refused before the gate is reached',
    restrictedCall.status === 403, `got ${restrictedCall.status}`);

  const managerRestriction = await prisma.intervention.create({
    data: {
      orgId: org.id, callerId: (await prisma.user.findFirstOrThrow({ where: { orgId: org.id, email: 'manager@dealdispatch.test' } })).id,
      rung: 'RESTRICTED_MODE', capability: 'REQUIREMENT_CAPTURE',
      attribution: 'OPERATOR', reason: 'HTTP audit fixture: a live restriction on somebody who can do the work.',
      evidence: [{ label: 'fixture', ref: 'Audit:1' }],
      restorationRule: RESTORATION.REQUIREMENT_CAPTURE,
      producedBy: 'audit', ruleVersion: 'audit@1',
      state: 'ACTIVE', shadow: false, enforcedAt: new Date(),
    },
  });

  const stoppedNow = await post('/api/deal/requirement', {
    action: 'capture', routeId: route.id, summary: 'HTTP audit: should be locked.',
  }, managerCookie);
  check('somebody who may do the work and is restricted gets a 423, not a 403',
    stoppedNow.status === 423, `got ${stoppedNow.status}`);
  check('and the refusal carries the way back out of it',
    typeof stoppedNow.body.restorationRule === 'string' && String(stoppedNow.body.error).includes('It ends when:'),
    String(stoppedNow.body.error ?? '').slice(0, 120));

  await prisma.intervention.delete({ where: { id: managerRestriction.id } });

  // -----------------------------------------------------------------------
  console.log('\n--- a shadow row stops nobody -------------------------------------');

  const shadow = await prisma.intervention.create({
    data: {
      orgId: org.id, callerId: caller.id, rung: 'CAPABILITY_PAUSE', capability: 'CALL_PLACING',
      attribution: 'OPERATOR', reason: 'HTTP audit fixture: recorded, doing nothing.',
      evidence: [{ label: 'fixture', ref: 'Audit:1' }],
      restorationRule: RESTORATION.CALL_PLACING,
      producedBy: 'audit', ruleVersion: 'audit@1', state: 'SHADOW', shadow: true,
    },
  });

  const stillCalling = await post('/api/calls/session', {
    action: 'start', routeId: route.id,
  }, callerCookie);
  check('a shadow-mode pause does not stop a caller placing a call',
    stillCalling.status === 200, `got ${stillCalling.status}`);
  if (stillCalling.status === 200) {
    await prisma.callSession.deleteMany({ where: { id: String(stillCalling.body.sessionId ?? '') } });
  }
  await prisma.intervention.delete({ where: { id: shadow.id } });

  // -----------------------------------------------------------------------
  console.log('\n--- concluding somebody was at fault ------------------------------');

  const resolved = await post('/api/manager', {
    action: 'resolve_case', caseId: mine.id, state: 'CONFIRMED',
    resolution: 'HTTP audit: confirmed after reading their answer.',
  }, managerCookie);
  check('a supervisor can conclude a case', resolved.status === 200, `got ${resolved.status}`);

  const confirmed = await prisma.consistencyCase.findUniqueOrThrow({ where: { id: mine.id } });
  check('and only then does anything become OPERATOR',
    confirmed.attribution === 'OPERATOR', confirmed.attribution);

  const twice = await post('/api/manager', {
    action: 'resolve_case', caseId: mine.id, state: 'DISMISSED', resolution: 'again',
  }, managerCookie);
  check('closing a closed case is refused with a reason', twice.status === 409, `got ${twice.status}`);

  // -----------------------------------------------------------------------
  console.log('\n--- the two rungs only an owner may apply -------------------------');

  const ownerOnly = await prisma.intervention.create({
    data: {
      orgId: org.id, callerId: caller.id, rung: 'SECURITY_RESTRICTION', capability: 'CALL_PLACING',
      attribution: 'OPERATOR', reason: 'HTTP audit fixture: proposed, not applied.',
      evidence: [{ label: 'fixture', ref: 'Audit:1' }],
      restorationRule: RESTORATION.CALL_PLACING,
      producedBy: 'audit', ruleVersion: 'audit@1', state: 'PROPOSED', shadow: true,
    },
  });

  const managerTries = await post('/api/manager', {
    action: 'enforce_intervention', interventionId: ownerOnly.id,
  }, managerCookie);
  check('a manager cannot apply a security restriction',
    managerTries.status === 409 && /owner/i.test(String(managerTries.body.error ?? '')),
    String(managerTries.body.error ?? '').slice(0, 100));

  const ownerApplies = await post('/api/manager', {
    action: 'enforce_intervention', interventionId: ownerOnly.id,
  }, ownerCookie);
  check('and an owner can', ownerApplies.status === 200, `got ${ownerApplies.status}`);

  const liftedWithNothing = await post('/api/manager', {
    action: 'lift_intervention', interventionId: ownerOnly.id, because: 'Feels fine now.',
  }, ownerCookie);
  check('lifting a restriction with no evidence is refused',
    liftedWithNothing.status === 409, `got ${liftedWithNothing.status}`);

  const liftedProperly = await post('/api/manager', {
    action: 'lift_intervention', interventionId: ownerOnly.id,
    because: 'Ten consecutive calls logged with notes, reviewed.',
    evidence: [{ label: 'the reviewed calls', ref: 'OutreachAttempt:audit-fixture' }],
  }, ownerCookie);
  check('and lifting it on evidence works', liftedProperly.status === 200, `got ${liftedProperly.status}`);

  // -----------------------------------------------------------------------
  console.log('\n--- the manager screen -------------------------------------------');

  const screen = await fetch(`${BASE}/manager`, { headers: { cookie: managerCookie } });
  check('a supervisor can open it', screen.status === 200, `got ${screen.status}`);
  const html = await screen.text();
  check('and shadow-mode decisions are labelled as doing nothing',
    html.includes('Recorded, doing nothing') || html.includes('Nothing has been decided in shadow'));
  check('and every open question shows its innocent explanations',
    html.includes('Ordinary reasons this happens') || html.includes('Nothing is out of line'));

  const malformed = await post('/api/manager', { action: 'resolve_case' }, managerCookie);
  check('a malformed request is a 400', malformed.status === 400, `got ${malformed.status}`);

  await prisma.intervention.deleteMany({ where: { id: restriction.id } });
  await cleanUp(org.id);

  if (checks !== EXPECTED_CHECKS) {
    failures += 1;
    console.log(` FAIL  the audit ran every check it has — ran ${checks} of ${EXPECTED_CHECKS}`);
  }

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  if (failures > 0) process.exitCode = 1;
}

async function cleanUp(orgId: string) {
  await prisma.intervention.deleteMany({ where: { orgId, producedBy: 'audit' } });
  await prisma.consistencyCase.deleteMany({ where: { orgId, producedBy: 'audit' } });
  await prisma.circuitBreaker.deleteMany({ where: { orgId, producedBy: 'audit' } });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
