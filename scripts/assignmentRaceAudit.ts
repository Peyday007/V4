/**
 * Two owners assigning the same production opportunity at the same instant.
 *
 * The invariant under test is the one that costs money when it breaks: a
 * prospect rung twice in an hour by two people from the same company, each of
 * whom was told the organisation was theirs. Application-level "is it taken?"
 * checks lose this race — both read "free", both write — so ownership is a
 * partial unique index on `PacketItem (routeId) WHERE status IN
 * ('PENDING','IN_PROGRESS')`, and the loser is expected to be *told* rather
 * than to see a database error.
 *
 * Run over real HTTP against the real endpoint, with real sessions. Nothing is
 * called at library level and no clock is injected: the point is that the path
 * a browser uses holds the line, not that the helper can.
 *
 *   BASE_URL=http://localhost:3111 npx tsx scripts/assignmentRaceAudit.ts
 *
 * Everything this writes is removed again, and production counts are compared
 * before and after.
 */

import { prisma } from '@/lib/db';
import { bucketsForRoutes } from '@/lib/demand/eligibility';

const BASE = process.env.BASE_URL ?? 'http://localhost:3111';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'demo-password-123';

let failures = 0;
let checks = 0;

function check(label: string, passed: boolean, detail = '') {
  checks += 1;
  if (!passed) failures += 1;
  console.log(`${passed ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
}

/** How many checks a complete run produces. A short run must not read as a clean one. */
const EXPECTED_CHECKS = 19;

/**
 * Anything that means the loser was shown our plumbing.
 *
 * A caller or an owner should never meet the words the database uses. "Unique
 * constraint failed on the fields: (`routeId`)" is not a sentence anybody can
 * act on, and it tells a stranger the shape of the schema.
 */
const RAW_DATABASE_LEAK = /P2002|unique constraint|duplicate key|prisma|PacketItem_|violates|SQLSTATE/i;

async function signIn(email: string): Promise<string> {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!response.ok) {
    throw new Error(`Sign-in failed for ${email}: HTTP ${response.status}${
      response.status === 429 ? ' — rate-limited, wait a minute and re-run' : ''}`);
  }
  const cookie = response.headers.get('set-cookie');
  if (!cookie) throw new Error('Sign-in returned no session cookie.');
  return cookie.split(';')[0];
}

async function post(path: string, body: unknown, cookie: string) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json().catch(() => ({})) as Record<string, any>,
  };
}

/** A zone where it is a weekday inside 8am–6pm right now, or null. */
function callableTimezone(): string | null {
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
const RACERS = 6;

async function main() {
  const org = await prisma.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });

  const before = await counts(org.id);
  const zone = callableTimezone();
  if (!zone) throw new Error('No timezone is inside calling hours right now; the race cannot be set up honestly.');

  // ---------------------------------------------------------------------
  // A real production opportunity to fight over.
  //
  // The pool is usually callable only during its own business hours, so one
  // contact's timezone is moved into the open window for the duration of the
  // run and put back exactly as it was. That is a smaller intervention than
  // injecting a clock, which would prove the endpoint tolerates a fake `now`
  // rather than that it holds under a real one.
  const candidates = await prisma.routeHypothesis.findMany({
    where: { orgId: org.id, dataMode: 'PRODUCTION', status: { notIn: ['EXPIRED', 'REJECTED', 'COLD'] } },
    select: { id: true, companyId: true },
    take: 200,
  });
  const buckets = await bucketsForRoutes({ orgId: org.id, routeIds: candidates.map((c) => c.id) });
  const target = candidates.find((c) => {
    const state = buckets.get(c.id);
    return state && !state.assigned && ['CALLABLE_NOW', 'WAITING_FOR_HOURS'].includes(state.bucket);
  });
  if (!target) throw new Error('No unassigned production opportunity is available to race over.');

  const contact = await prisma.contact.findFirst({
    where: { companyId: target.companyId, phone: { not: null } },
    select: { id: true, timezone: true },
  });
  if (!contact) throw new Error('The chosen opportunity has no contact with a phone; pick another dataset.');
  const originalTimezone = contact.timezone;

  const owner = await prisma.user.findFirstOrThrow({
    where: { orgId: org.id, email: 'owner@dealdispatch.test' }, select: { id: true },
  });

  const createdCallerIds: string[] = [];
  const createdPacketIds: string[] = [];

  try {
    await prisma.contact.update({ where: { id: contact.id }, data: { timezone: zone } });
    const nowBuckets = await bucketsForRoutes({ orgId: org.id, routeIds: [target.id] });
    check('a real production opportunity is callable and unowned',
      nowBuckets.get(target.id)?.bucket === 'CALLABLE_NOW' && !nowBuckets.get(target.id)?.assigned,
      `${nowBuckets.get(target.id)?.bucket} in ${zone}`);

    const cookie = await signIn('owner@dealdispatch.test');

    // Six production callers, so the race has more than two entrants. Two
    // proves the index fires; six proves it does not have a window that opens
    // under load.
    for (let i = 0; i < RACERS; i += 1) {
      const created = await post('/api/callers', {
        action: 'create',
        name: `Race Caller ${i} ${stamp}`,
        email: `race-caller-${stamp}-${i}@dealdispatch.test`,
        mode: 'PRODUCTION',
      }, cookie);
      if (created.status !== 200 || !created.body.callerId) {
        throw new Error(`Could not create racer ${i}: HTTP ${created.status} ${JSON.stringify(created.body)}`);
      }
      createdCallerIds.push(String(created.body.callerId));
    }
    check(`${RACERS} production callers are standing by`, createdCallerIds.length === RACERS);

    // -------------------------------------------------------------------
    // The race itself. One route, every caller, one instant.
    console.log(`\n--- ${RACERS} simultaneous confirmations, one opportunity ----------`);
    const results = await Promise.all(createdCallerIds.map((callerId) => post('/api/callers', {
      action: 'assign',
      callerId,
      routeIds: [target.id],
      name: `Race ${stamp}`,
    }, cookie)));

    for (const r of results) {
      if (r.body?.plan?.packetId) createdPacketIds.push(String(r.body.plan.packetId));
    }

    const serverErrors = results.filter((r) => r.status >= 500);
    check('no request fell over with a server error', serverErrors.length === 0,
      serverErrors.map((r) => `HTTP ${r.status}`).join(', ') || 'none');

    const answered = results.filter((r) => r.status === 200 || r.status === 409);
    check('every request got a considered answer', answered.length === RACERS,
      `${answered.length}/${RACERS} answered, statuses ${results.map((r) => r.status).join('/')}`);

    const winners = results.filter((r) => r.status === 200 && r.body?.plan?.items === 1);
    check('exactly one confirmation actually took the opportunity', winners.length === 1,
      `${winners.length} winners`);

    const losers = results.filter((r) => !(r.status === 200 && r.body?.plan?.items === 1));
    check('every loser is told somebody else got there first',
      losers.every((r) => {
        const dropped = Array.isArray(r.body?.dropped) ? r.body.dropped : [];
        const claimed = dropped.some((d: any) => d?.bucket === 'ALREADY_ASSIGNED');
        const said = typeof r.body?.error === 'string' && /still callable|changed since the preview/i.test(r.body.error);
        return claimed || said;
      }),
      `${losers.length} losers`);

    check('and told it in a sentence, not a status code',
      losers.every((r) => {
        const dropped = Array.isArray(r.body?.dropped) ? r.body.dropped : [];
        const reason = dropped.find((d: any) => d?.bucket === 'ALREADY_ASSIGNED');
        if (reason) return typeof reason.because === 'string' && reason.because.length > 40;
        return typeof r.body?.error === 'string' && r.body.error.length > 40;
      }),
      losers.map((r) => {
        const d = (Array.isArray(r.body?.dropped) ? r.body.dropped : [])
          .find((x: any) => x?.bucket === 'ALREADY_ASSIGNED');
        return (d?.because ?? r.body?.error ?? '').slice(0, 60);
      })[0] ?? '');

    const leaked = results.filter((r) => RAW_DATABASE_LEAK.test(JSON.stringify(r.body)));
    check('nobody is shown the database', leaked.length === 0,
      leaked.map((r) => JSON.stringify(r.body).slice(0, 120)).join(' | ') || 'no raw errors in any response');

    // -------------------------------------------------------------------
    // What the database actually holds, which is the claim that matters.
    const live = await prisma.packetItem.count({
      where: { routeId: target.id, status: { in: ['PENDING', 'IN_PROGRESS'] } },
    });
    check('exactly one live claim exists on that opportunity', live === 1, `${live} live items`);

    const owners = await prisma.packetItem.findMany({
      where: { routeId: target.id, status: { in: ['PENDING', 'IN_PROGRESS'] } },
      select: { callerId: true },
    });
    check('and exactly one caller owns it', new Set(owners.map((o) => o.callerId)).size === 1,
      `${new Set(owners.map((o) => o.callerId)).size} distinct owners`);

    // -------------------------------------------------------------------
    // A second race against the record now that it is owned: the answer must
    // be the same sentence, not a different failure mode.
    console.log('\n--- and again, now that it is owned --------------------------');
    const second = await Promise.all(createdCallerIds.slice(0, 2).map((callerId) => post('/api/callers', {
      action: 'assign', callerId, routeIds: [target.id], name: `Race again ${stamp}`,
    }, cookie)));
    for (const r of second) if (r.body?.plan?.packetId) createdPacketIds.push(String(r.body.plan.packetId));

    check('a later attempt is refused rather than queued',
      second.every((r) => r.status < 500 && !(r.body?.plan?.items >= 1)),
      second.map((r) => `HTTP ${r.status}`).join(', '));
    check('with the same explanation as the first race',
      second.every((r) => {
        const dropped = Array.isArray(r.body?.dropped) ? r.body.dropped : [];
        return dropped.some((d: any) => d?.bucket === 'ALREADY_ASSIGNED')
          || (typeof r.body?.error === 'string' && r.body.error.length > 40);
      }),
      (second[0]?.body?.error ?? '').slice(0, 70));
    check('and the opportunity still has exactly one owner',
      (await prisma.packetItem.count({
        where: { routeId: target.id, status: { in: ['PENDING', 'IN_PROGRESS'] } },
      })) === 1);
  } finally {
    // -------------------------------------------------------------------
    console.log('\n--- putting production back ---------------------------------');

    // The borrowed field goes back first and on its own. It is the only thing
    // here that was already real, and an earlier version of this script put it
    // last — so when the caller cleanup threw, a New York contact was left
    // sitting in London. Order the undo by what it would cost to get wrong.
    await prisma.contact.update({ where: { id: contact.id }, data: { timezone: originalTimezone } });
    const restored = await prisma.contact.findUnique({
      where: { id: contact.id }, select: { timezone: true },
    });
    check('the borrowed timezone is exactly as it was',
      restored?.timezone === originalTimezone, `${restored?.timezone ?? 'null'}`);

    if (createdPacketIds.length > 0) {
      await prisma.packetItem.deleteMany({ where: { packetId: { in: createdPacketIds } } });
      await prisma.workPacket.deleteMany({ where: { id: { in: createdPacketIds } } });
    }
    if (createdCallerIds.length > 0) {
      await prisma.packetItem.deleteMany({ where: { callerId: { in: createdCallerIds } } });
      await prisma.workPacket.deleteMany({ where: { callerId: { in: createdCallerIds } } });
      await prisma.callerProfile.deleteMany({ where: { userId: { in: createdCallerIds } } });
      await prisma.auditEvent.deleteMany({ where: { userId: { in: createdCallerIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdCallerIds } } });
    }

    const after = await counts(org.id);
    for (const key of ['routes', 'items', 'packets', 'attempts', 'callers'] as const) {
      check(`production ${key} is back where it started`, before[key] === after[key],
        `${before[key]} then ${after[key]}`);
    }
  }
}

async function counts(orgId: string) {
  const [routes, items, packets, attempts, callers] = await Promise.all([
    prisma.routeHypothesis.count({ where: { orgId, dataMode: 'PRODUCTION' } }),
    prisma.packetItem.count({ where: { orgId, dataMode: 'PRODUCTION' } }),
    prisma.workPacket.count({ where: { orgId, dataMode: 'PRODUCTION' } }),
    prisma.outreachAttempt.count({ where: { orgId, dataMode: 'PRODUCTION' } }),
    prisma.user.count({ where: { orgId, callerProfile: { isNot: null } } }),
  ]);
  return { routes, items, packets, attempts, callers };
}

main()
  .then(() => {
    if (checks !== EXPECTED_CHECKS) {
      console.log(` FAIL  the audit ran ${checks} checks, not the ${EXPECTED_CHECKS} a complete run produces.`);
      failures += 1;
    }
    console.log(`\n${checks - failures}/${checks} checks passed.`);
    process.exit(failures > 0 ? 1 : 0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
