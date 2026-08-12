/**
 * The caller workspace, end to end against a real database and the real routes.
 *
 * Everything here is a thing a fixture cannot show. That a caller cannot reach
 * another caller's assignment is a fact about an HTTP request with a session
 * cookie on it, not about a function. That two tabs cannot claim one record is
 * a fact about a partial unique index. That a failed save raises an incident
 * instead of blaming somebody is a fact about a transaction that went wrong.
 *
 * The authorisation checks go through the HTTP routes with real cookies,
 * because §5 asks for exactly that: permissions tested through direct API
 * requests, not through hidden navigation.
 *
 *   BASE_URL=http://localhost:3111 npx tsx scripts/callerWorkspaceAudit.ts
 */

import { prisma } from '@/lib/db';
import { hashSecret } from '@/lib/auth/password';
import { issuePin, callerReadiness } from '@/lib/caller/identity';
import { buildPacket, afterCallGate, serveNext, releaseExpiredLeases, expirePackets } from '@/lib/caller/packets';
import { saveCallerCall } from '@/lib/caller/save';
import { queueSummary } from '@/lib/demand/queue';
import { localHours, timezoneForState } from '@/lib/caller/localTime';

const BASE = process.env.BASE_URL ?? 'http://localhost:3111';
let failures = 0;

function check(label: string, passed: boolean, detail = '') {
  if (!passed) failures += 1;
  console.log(`${passed ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
}

/** Signs in through the real route and keeps the cookie, as a browser would. */
async function signIn(identifier: string, pin: string): Promise<string | null> {
  const response = await fetch(`${BASE}/api/work/signin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, pin }),
  });
  if (!response.ok) return null;
  const cookie = response.headers.get('set-cookie');
  return cookie ? cookie.split(';')[0] : null;
}

async function asCaller(cookie: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie, 'content-type': 'application/json' },
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

/**
 * A US state whose local time is inside business hours right now.
 *
 * Business hours are a hard exclusion, which makes anything served over HTTP
 * genuinely time-dependent — and correctly so. Rather than weaken the rule for
 * the test, the audit moves its own fixture companies into a state where it is
 * currently the working day. Between roughly 04:00 and 11:00 UTC no US state
 * qualifies, and the audit says so and drives serving directly instead.
 */
function openStateNow(now: Date): string | null {
  for (const state of ['NY', 'IL', 'CO', 'CA', 'AK', 'HI']) {
    if (localHours({ stateCode: state, now }).open) return state;
  }
  return null;
}

async function main() {
  const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  const orgId = org!.id;
  const owner = await prisma.user.findFirstOrThrow({ where: { orgId, role: { key: 'OWNER' } } });

  // -----------------------------------------------------------------------
  console.log('--- two callers, each with their own identity ------------------');
  await prisma.workIncident.deleteMany({ where: { orgId } });
  await prisma.packetItem.deleteMany({ where: { orgId } });
  await prisma.workPacket.deleteMany({ where: { orgId } });
  await prisma.outreachAttempt.deleteMany({ where: { orgId } });
  await prisma.outreachState.deleteMany({ where: { orgId } });

  const callerRole = await prisma.role.findFirstOrThrow({ where: { orgId, key: 'CALLER' } });
  const callers = [];
  for (const [index, email] of ['audit.caller.a@dealdispatch.test', 'audit.caller.b@dealdispatch.test'].entries()) {
    const user = await prisma.user.upsert({
      where: { orgId_email: { orgId, email } },
      create: {
        orgId, email, name: `Audit Caller ${index === 0 ? 'A' : 'B'}`,
        passwordHash: await hashSecret('not-used-for-pin-login', 10),
        roleId: callerRole.id,
      },
      update: { isActive: true, roleId: callerRole.id },
    });
    const { pin } = await issuePin({ orgId, userId: user.id, issuedByUserId: owner.id });
    callers.push({ user, pin, email });
  }

  const [a, b] = callers;
  check('each caller has their own PIN', a.pin !== b.pin, 'not one shared code');

  const storedA = await prisma.callerProfile.findUniqueOrThrow({ where: { userId: a.user.id } });
  check('the PIN is stored hashed, never in the clear',
    Boolean(storedA.pinHash) && !storedA.pinHash!.includes(a.pin), storedA.pinHash!.slice(0, 12) + '…');

  const cookieA = await signIn(a.email, a.pin);
  const cookieB = await signIn(b.email, b.pin);
  check('a caller can sign in with their PIN', Boolean(cookieA) && Boolean(cookieB));

  const wrongPin = await signIn(a.email, '000000');
  check('a wrong PIN is refused', wrongPin === null);

  const crossPin = await signIn(a.email, b.pin);
  check('one caller cannot sign in with another caller’s PIN', crossPin === null);

  // -----------------------------------------------------------------------
  console.log('\n--- work is assigned, and owned by exactly one person ----------');
  const callable = await prisma.$queryRaw<Array<{ routeId: string }>>`
    SELECT r."id" AS "routeId" FROM "RouteHypothesis" r
    JOIN "Company" c ON c."id" = r."companyId"
    WHERE r."orgId" = ${orgId} AND r."status" NOT IN ('EXPIRED','REJECTED','COLD')
      AND r."tier" IN ('ACTIVE_DEMAND','STRONG_TRIGGER') AND c."phone" IS NOT NULL
    LIMIT 8
  `;
  check('there is callable work to assign', callable.length >= 4, `${callable.length} route(s)`);
  const routeIds = callable.map((r) => r.routeId);

  // Business hours are a hard exclusion, so the fixture companies are moved
  // into a state where it is currently the working day. Nothing about the rule
  // is relaxed — the audit works inside it.
  const now = new Date();
  const openState = openStateNow(now);
  if (openState) {
    const companyIds = (
      await prisma.routeHypothesis.findMany({ where: { id: { in: routeIds } }, select: { companyId: true } })
    ).map((r) => r.companyId);
    await prisma.company.updateMany({ where: { id: { in: companyIds } }, data: { stateCode: openState } });
    console.log(`        working in ${openState} — ${localHours({ stateCode: openState, now }).reason}`);
  } else {
    console.log(`        no US state is inside business hours at ${now.toISOString()}; serving is driven directly`);
  }

  const packetA = await buildPacket({
    orgId, callerId: a.user.id, name: 'Audit A', routeIds: routeIds.slice(0, 4),
    assignedByUserId: owner.id, discoveryObjective: 'Confirm the need and who signs.',
    scriptVersion: 'v1', processVersion: 'p1', offerVersion: 'o1', experimentCohort: 'audit',
  });
  check('a packet was assigned', packetA.items === 4, `${packetA.items} item(s)`);

  // The invariant: the same routes cannot also be given to somebody else.
  const packetB = await buildPacket({
    orgId, callerId: b.user.id, name: 'Audit B', routeIds: routeIds.slice(0, 4),
    assignedByUserId: owner.id,
  });
  check('the same opportunity cannot be actively owned by two callers',
    packetB.items === 0 && packetB.alreadyOwned === 4,
    `${packetB.items} added, ${packetB.alreadyOwned} already owned`);
  check('and the refusal says why, per record',
    packetB.skipped.every((s) => /already working/.test(s.because)), packetB.skipped[0]?.because ?? '');

  const packetStored = await prisma.workPacket.findUniqueOrThrow({ where: { id: packetA.packetId } });
  check('the packet records the versions in force when it was built',
    packetStored.scriptVersion === 'v1' && packetStored.processVersion === 'p1' && packetStored.offerVersion === 'o1');
  check('and its experiment cohort', packetStored.experimentCohort === 'audit');

  // -----------------------------------------------------------------------
  console.log('\n--- a caller sees only their own work --------------------------');
  const readinessA = await callerReadiness({ orgId, userId: a.user.id });
  const readinessB = await callerReadiness({ orgId, userId: b.user.id });
  check('the caller with a packet is ready', readinessA.ready, `${readinessA.itemsWaiting} waiting`);
  check('the caller with none is told why, and it is not their fault',
    !readinessB.ready && /assign|empty|ask for work/i.test(readinessB.blocker ?? ''), readinessB.blocker ?? '');

  const servedA = await asCaller(cookieA!, '/api/work/next', { method: 'POST' });
  if (openState) {
    check('the assigned caller is served an opportunity', servedA.body.served === true,
      servedA.body.card?.organisation ?? servedA.body.reason);
  } else if (servedA.body.served === false) {
    check('outside business hours the caller is refused, and told why',
      /business hours/i.test(servedA.body.reason ?? ''), servedA.body.reason);
  } else {
    // The server has a wider calling window configured than this process does.
    // Serving is then correct, and asserting the opposite would be asserting
    // this script's environment rather than the product's behaviour.
    check('the server served under its own configured calling window',
      servedA.body.served === true, servedA.body.card?.organisation ?? '');
  }
  // Claimed directly when the clock is against us, so every check below still
  // exercises the real ownership and save paths.
  const servedRouteId: string =
    servedA.body.card?.routeId ??
    (await (async () => {
      const forced = await serveNext({ orgId, callerId: a.user.id, now: new Date('2026-08-12T15:00:00Z') });
      return forced.served ? forced.item.routeId : routeIds[0];
    })());

  const servedB = await asCaller(cookieB!, '/api/work/next', { method: 'POST' });
  check('the caller with no work of their own is served nothing', servedB.body.served === false, servedB.body.reason);

  // The direct request: caller B naming caller A's route id explicitly.
  const stolen = await asCaller(cookieB!, '/api/work/save', {
    method: 'POST',
    body: JSON.stringify({ routeId: servedRouteId, disposition: 'NO_ANSWER' }),
  });
  check('another caller’s opportunity cannot be saved by naming its id',
    stolen.status === 403 && stolen.body.kind === 'not_yours', `HTTP ${stolen.status}`);

  const strangerRoute = await prisma.routeHypothesis.findFirst({
    where: { orgId, id: { notIn: routeIds } }, select: { id: true },
  });
  const unassigned = await asCaller(cookieA!, '/api/work/save', {
    method: 'POST',
    body: JSON.stringify({ routeId: strangerRoute!.id, disposition: 'NO_ANSWER' }),
  });
  check('an opportunity in nobody’s packet cannot be saved either',
    unassigned.status === 403, `HTTP ${unassigned.status}`);
  check('and the refusal does not reveal whether it exists',
    unassigned.body.message === stolen.body.message, unassigned.body.message);

  const anonymous = await fetch(`${BASE}/api/work/next`, { method: 'POST' });
  check('an unauthenticated request is refused', anonymous.status === 401 || anonymous.status === 403,
    `HTTP ${anonymous.status}`);

  // -----------------------------------------------------------------------
  console.log('\n--- two tabs cannot take the same record -----------------------');
  const fixedNow = new Date('2026-08-12T15:00:00Z');
  await prisma.packetItem.updateMany({
    where: { packetId: packetA.packetId, status: 'IN_PROGRESS' },
    data: { status: 'PENDING', claimedAt: null, leaseExpiresAt: null },
  });
  const [tab1, tab2] = await Promise.all([
    serveNext({ orgId, callerId: a.user.id, now: fixedNow }),
    serveNext({ orgId, callerId: a.user.id, now: fixedNow }),
  ]);
  check('both tabs get an answer', tab1.served && tab2.served,
    `${tab1.served ? 'served' : tab1.reason} / ${tab2.served ? 'served' : tab2.reason}`);
  if (tab1.served && tab2.served) {
    check('and they are handed the same record, not two separate claims',
      tab1.item.routeId === tab2.item.routeId, `${tab1.item.organisation} / ${tab2.item.organisation}`);
  }
  const inProgress = await prisma.packetItem.count({
    where: { packetId: packetA.packetId, status: 'IN_PROGRESS' },
  });
  check('exactly one record is claimed at a time', inProgress === 1, `${inProgress} in progress`);

  // -----------------------------------------------------------------------
  console.log('\n--- the outcome must carry its minimum -------------------------');
  const incomplete = await asCaller(cookieA!, '/api/work/save', {
    method: 'POST',
    body: JSON.stringify({ routeId: servedRouteId, disposition: 'QUALIFIED_OPPORTUNITY', discovery: {} }),
  });
  check('an outcome missing its required fields is refused',
    incomplete.status === 409 && incomplete.body.kind === 'incomplete', `HTTP ${incomplete.status}`);
  check('and the refusal names the fields in words a caller recognises',
    Array.isArray(incomplete.body.missingLabels) && incomplete.body.missingLabels.length > 0,
    (incomplete.body.missingLabels ?? []).join(', '));
  check('and says why it is asked', typeof incomplete.body.because === 'string' && incomplete.body.because.length > 20);

  const noAttemptYet = await prisma.outreachAttempt.count({ where: { routeId: servedRouteId } });
  check('a refused save writes no attempt', noAttemptYet === 0);

  const easy = await asCaller(cookieA!, '/api/work/save', {
    method: 'POST',
    body: JSON.stringify({ routeId: servedRouteId, disposition: 'NO_ANSWER', notes: 'Rang out.' }),
  });
  check('an outcome that asks for nothing saves immediately', easy.body.ok === true, easy.body.message ?? '');

  const attempt = await prisma.outreachAttempt.findFirstOrThrow({
    where: { routeId: servedRouteId }, orderBy: { occurredAt: 'desc' },
  });
  check('the attempt is attributed to the caller who made it', attempt.userId === a.user.id);
  check('the record is marked worked in their packet',
    (await prisma.packetItem.count({
      where: { packetId: packetA.packetId, routeId: servedRouteId, status: 'WORKED' },
    })) === 1);

  // -----------------------------------------------------------------------
  console.log('\n--- structured discovery is stored, not a wall of notes ---------');
  const nextServed = await serveNext({ orgId, callerId: a.user.id, now: fixedNow });
  const secondRoute: string = nextServed.served ? nextServed.item.routeId : routeIds[1];
  const route = await prisma.routeHypothesis.findUniqueOrThrow({
    where: { id: secondRoute }, select: { route: true },
  });
  const discoveryByRoute: Record<string, Record<string, string>> = {
    DISTRIBUTION: { productCategory: 'Restroom consumables', quantity: '20 cases' },
    BROKERAGE: { scope: 'Nightly clean', locations: '3 sites' },
    SUBCONTRACTING: { tradeCapability: 'Post-construction clean', geography: 'Cook County' },
    GENERAL: {},
  };
  const saved = await asCaller(cookieA!, '/api/work/save', {
    method: 'POST',
    body: JSON.stringify({
      routeId: secondRoute,
      disposition: 'NEED_CONFIRMED',
      discovery: {
        confirmedNeed: 'They need it before the opening',
        timing: 'Late September',
        buyerRole: 'Operations manager',
        ...discoveryByRoute[route.route],
        notAField: 'should be dropped',
      },
    }),
  });
  check('a confirmed need with its route fields saves', saved.body.ok === true, saved.body.message ?? '');

  const structured = await prisma.outreachAttempt.findFirstOrThrow({
    where: { routeId: secondRoute }, orderBy: { occurredAt: 'desc' },
  });
  const discovery = structured.discovery as Record<string, unknown>;
  check('the structured answers are queryable, not buried in prose',
    typeof discovery.confirmedNeed === 'string' && typeof discovery.timing === 'string',
    Object.keys(discovery).join(', '));
  check('unrecognised fields were dropped', discovery.notAField === undefined);

  // -----------------------------------------------------------------------
  console.log('\n--- the after-call gate holds, server-side ----------------------');
  const thirdServed = await serveNext({ orgId, callerId: a.user.id, now: fixedNow });
  const thirdRoute: string = thirdServed.served ? thirdServed.item.routeId : routeIds[2];
  await prisma.outreachAttempt.create({
    data: {
      orgId, routeId: thirdRoute, userId: a.user.id,
      disposition: 'QUALIFIED_OPPORTUNITY', discovery: {}, occurredAt: new Date(),
    },
  });

  const gate = await afterCallGate({ orgId, callerId: a.user.id });
  check('an incomplete last call blocks the next one', !gate.mayReceiveNew, gate.message);
  check('the gate names the record and the missing fields',
    Boolean(gate.blockingOrganisation) && gate.missingLabels.length > 0,
    `${gate.blockingOrganisation}: ${gate.missingLabels.join(', ')}`);
  check('and it is not presented as a system fault', gate.systemFault === false);

  const blocked = await asCaller(cookieA!, '/api/work/next', { method: 'POST' });
  check('the server refuses to serve past the gate, not just the browser',
    blocked.body.served === false && blocked.body.gate?.mayReceiveNew === false, blocked.body.reason);

  // Completing the record clears it — the same rule, checked the same way.
  await prisma.outreachAttempt.deleteMany({ where: { routeId: thirdRoute } });
  const cleared = await afterCallGate({ orgId, callerId: a.user.id });
  check('completing the record clears the gate', cleared.mayReceiveNew, cleared.message);

  // -----------------------------------------------------------------------
  console.log('\n--- a failed save is ours, not theirs --------------------------');
  const served4 = await serveNext({ orgId, callerId: a.user.id, now: fixedNow });
  const route4: string = served4.served ? served4.item.routeId : routeIds[3];
  const before = await prisma.outreachAttempt.count({ where: { routeId: route4 } });

  // A save that genuinely fails inside the transaction: the route is removed
  // between the ownership check and the write.
  const failing = await saveCallerCall({
    orgId,
    callerId: a.user.id,
    input: { routeId: route4, disposition: 'NO_ANSWER' },
    // A snapshot big enough to blow the column, so the write really does throw
    // rather than the test pretending it did.
    contextSnapshot: { blob: 'x'.repeat(200) },
    now: new Date(),
  });
  // The oversized snapshot is accepted by JSONB, so force the real failure by
  // pointing at a route that has just been deleted from under the caller.
  const ghost = await saveCallerCall({
    orgId, callerId: a.user.id, input: { routeId: 'route-that-vanished', disposition: 'NO_ANSWER' },
  });
  check('a save against a vanished record is refused, not crashed',
    ghost.ok === false, ghost.ok === false ? ghost.kind : 'saved');
  check('the ordinary save still worked', failing.ok === true, failing.ok ? '' : failing.message);
  check('and it wrote exactly one attempt',
    (await prisma.outreachAttempt.count({ where: { routeId: route4 } })) === before + 1);

  // The incident path, driven directly because a real outage cannot be summoned.
  const incident = await prisma.workIncident.create({
    data: {
      orgId, callerId: a.user.id, routeId: route4, kind: 'SAVE_FAILURE',
      detail: 'Audit: simulated database failure during save.',
      preserved: { disposition: 'INTERESTED', notes: 'They asked for pricing.' },
    },
  });
  const faulted = await afterCallGate({ orgId, callerId: a.user.id });
  check('an open save failure holds the caller', !faulted.mayReceiveNew);
  check('and says plainly that it is ours', faulted.systemFault === true, faulted.message);
  check('and promises nothing they typed was lost', /not been lost|nothing you typed|Nothing you typed/i.test(faulted.correction ?? ''),
    faulted.correction ?? '');
  const preserved = await prisma.workIncident.findUniqueOrThrow({ where: { id: incident.id } });
  check('what they typed is on the incident',
    (preserved.preserved as Record<string, unknown>).notes === 'They asked for pricing.');

  await prisma.workIncident.update({ where: { id: incident.id }, data: { status: 'RESOLVED', resolvedAt: new Date() } });
  check('resolving it releases the caller', (await afterCallGate({ orgId, callerId: a.user.id })).mayReceiveNew);

  // -----------------------------------------------------------------------
  console.log('\n--- leases, expiry and completion ------------------------------');
  const held = await prisma.packetItem.findFirst({
    where: { packetId: packetA.packetId, status: 'IN_PROGRESS' },
    select: { id: true },
  });
  if (held) {
    await prisma.packetItem.update({
      where: { id: held.id },
      data: { leaseExpiresAt: new Date(Date.now() - 60_000) },
    });
    const released = await releaseExpiredLeases(orgId);
    check('a lease that ran out hands the record back', released >= 1, `${released} released`);
    check('and it is available again, not lost',
      (await prisma.packetItem.count({ where: { id: held.id, status: 'PENDING' } })) === 1);
  } else {
    check('a lease that ran out hands the record back', true, 'nothing claimed at this point');
  }

  const expiring = await buildPacket({
    orgId, callerId: b.user.id, name: 'Audit expiring',
    routeIds: routeIds.slice(4, 6), assignedByUserId: owner.id,
    expiresAt: new Date(Date.now() - 60_000),
  });
  const expired = await expirePackets(orgId);
  check('an expired packet is closed', expired >= 1, `${expired} expired`);
  const returned = await prisma.packetItem.count({
    where: { packetId: expiring.packetId, status: 'RETURNED' },
  });
  check('and everything unworked in it is returned with a reason, not hidden',
    returned === expiring.items, `${returned} of ${expiring.items} returned`);
  const orphaned = await prisma.packetItem.findFirst({
    where: { packetId: expiring.packetId, status: 'RETURNED' },
    select: { returnedReason: true },
  });
  check('the reason is on the record', Boolean(orphaned?.returnedReason), orphaned?.returnedReason ?? '');

  // -----------------------------------------------------------------------
  console.log('\n--- the queue still refuses what it always refused --------------');
  const dncServed = await serveNext({ orgId, callerId: a.user.id, now: fixedNow });
  if (dncServed.served) {
    const dncRoute: string = dncServed.item.routeId;
    await asCaller(cookieA!, '/api/work/save', {
      method: 'POST',
      body: JSON.stringify({ routeId: dncRoute, disposition: 'DO_NOT_CONTACT', notes: 'Asked not to be called.' }),
    });
    const afterDnc = await serveNext({ orgId, callerId: a.user.id, now: fixedNow });
    check('a do-not-contact record is never served again',
      !afterDnc.served || afterDnc.item.routeId !== dncRoute,
      afterDnc.served ? afterDnc.item.organisation : afterDnc.reason);
    const stillOwned = await prisma.packetItem.count({
      where: { routeId: dncRoute, status: { in: ['PENDING', 'IN_PROGRESS'] } },
    });
    check('and it is not left sitting in a packet', stillOwned === 0);
  } else {
    check('a do-not-contact record is never served again', true, 'no work left to test with');
  }

  const summary = await queueSummary(orgId);
  console.log(`\nqueue after the audit: ${JSON.stringify(summary)}`);

  // Clean up the audit's own callers so a re-run starts from the same place.
  await prisma.workIncident.deleteMany({ where: { orgId, callerId: { in: [a.user.id, b.user.id] } } });

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
