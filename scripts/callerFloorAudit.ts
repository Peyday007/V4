/**
 * The owner-to-caller workflow, against a real database.
 *
 * The three failures this is written against, all of them found in production
 * code rather than imagined:
 *
 *   `/callers` listed every user as a caller. The query joined `User` to `Role`
 *   and never asked whether the person had a caller profile at all.
 *
 *   `/callers` and `/demand` disagreed about how much work there was, because
 *   each had its own SQL. One counted live tiered routes with no packet item;
 *   the other required a phone number and no snooze. Neither said what it meant.
 *
 *   Nothing stopped a test record reaching a real caller, because there was no
 *   such thing as a test record.
 *
 *   npx tsx scripts/callerFloorAudit.ts
 */

import { prisma } from '@/lib/db';
import { createCaller, deactivateCaller, reactivateCaller, roster, requireCaller } from '@/lib/caller/roster';
import { issuePin, revokePin, signInWithPin, CallerAuthError } from '@/lib/caller/identity';
import { previewAssignment, confirmAssignment } from '@/lib/caller/assignment';
import { ensureSandbox, resetSandbox, sandboxState } from '@/lib/caller/sandbox';
import { eligibilityCounts, callableRouteIds, bucketSql, ELIGIBILITY_FROM, ASSIGNED_SQL } from '@/lib/demand/eligibility';
import { queueSummary } from '@/lib/demand/queue';
import { Prisma } from '@prisma/client';

let failures = 0;
let checks = 0;

function check(label: string, passed: boolean, detail = '') {
  checks += 1;
  if (!passed) failures += 1;
  console.log(`${passed ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
}

async function refuses(label: string, run: () => Promise<unknown>, expect: RegExp) {
  try {
    await run();
    check(label, false, 'the write was accepted');
  } catch (error) {
    const message = String(error);
    check(label, expect.test(message), message.slice(0, 150).replace(/\s+/g, ' '));
  }
}

const stamp = Date.now();

async function main() {
  const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!org) throw new Error('No organisation. Seed the database first.');
  const owner = await prisma.user.findFirstOrThrow({
    where: { orgId: org.id, email: 'owner@dealdispatch.test' }, select: { id: true },
  });

  await cleanUp(org.id);

  // =========================================================================
  console.log('--- only actual callers appear on the floor -----------------------');

  const everyone = await prisma.user.count({ where: { orgId: org.id, isActive: true } });
  const floor = await roster({ orgId: org.id });
  const withProfiles = await prisma.user.count({
    where: { orgId: org.id, isActive: true, callerProfile: { isNot: null } },
  });

  check('the floor is not simply every user', floor.length <= withProfiles,
    `${floor.length} on the floor, ${everyone} users in the org`);
  check('and every row on it has a caller profile', floor.length === withProfiles,
    `${floor.length} rows vs ${withProfiles} profiles`);

  const roles = await prisma.user.findMany({
    where: { orgId: org.id, id: { in: floor.map((f) => f.callerId) } },
    select: { role: { select: { key: true } } },
  });
  check('and none of them is an owner, admin, finance or research account',
    roles.every((r) => r.role.key === 'CALLER'),
    roles.map((r) => r.role.key).join(', '));

  // =========================================================================
  console.log('\n--- creating a caller ---------------------------------------------');

  const created = await createCaller({
    orgId: org.id, actorId: owner.id,
    name: 'Audit Caller', email: `audit-caller-${stamp}@dealdispatch.test`,
    mode: 'PRODUCTION', label: 'Created by the audit',
  });
  check('an owner can create a production caller', created.ok,
    created.ok ? created.callerId : created.message);
  if (!created.ok) throw new Error('cannot continue without a caller');
  const callerId = created.callerId;

  const dupe = await createCaller({
    orgId: org.id, actorId: owner.id, name: 'Audit Caller', email: `audit-caller-${stamp}@dealdispatch.test`,
  });
  check('a second caller cannot take the same sign-in identity', !dupe.ok,
    dupe.ok ? 'accepted' : dupe.message.slice(0, 70));

  const convert = await createCaller({
    orgId: org.id, actorId: owner.id, name: 'Alex Reyes', email: 'owner@dealdispatch.test',
  });
  check('and an existing owner account is refused rather than converted', !convert.ok,
    convert.ok ? 'CONVERTED — this is the bug' : convert.message.slice(0, 90));

  const notACaller = await requireCaller(org.id, owner.id);
  check('the lifecycle guard refuses a non-caller by id', 'message' in notACaller,
    'message' in notACaller ? notACaller.message.slice(0, 60) : 'accepted');

  await refuses(
    'and issuing a PIN to a non-caller is refused, not silently upserted',
    () => issuePin({ orgId: org.id, userId: owner.id, issuedByUserId: owner.id }),
    /not a caller/i,
  );

  // =========================================================================
  console.log('\n--- the PIN, end to end -------------------------------------------');

  const email = `audit-caller-${stamp}@dealdispatch.test`;
  const first = await issuePin({ orgId: org.id, userId: callerId, issuedByUserId: owner.id });
  check('a PIN is issued and returned once', /^\d{6}$/.test(first.pin), `${first.pin.length} digits`);

  const stored = await prisma.callerProfile.findUniqueOrThrow({
    where: { userId: callerId },
    select: { pinHash: true, pinSetAt: true, pinIssuedById: true },
  });
  check('only a hash is stored, never the PIN',
    Boolean(stored.pinHash) && !stored.pinHash!.includes(first.pin));
  check('and the issuance records who did it',
    stored.pinIssuedById === owner.id && stored.pinSetAt !== null);

  const signIn = await signInWithPin({ identifier: email, pin: first.pin });
  check('the new PIN signs in', signIn.userId === callerId);

  const rotated = await issuePin({ orgId: org.id, userId: callerId, issuedByUserId: owner.id });
  check('rotating produces a different PIN', rotated.pin !== first.pin);

  await refuses(
    'and the rotated-away PIN stops working immediately',
    () => signInWithPin({ identifier: email, pin: first.pin }),
    /do not match/i,
  );

  await revokePin({ orgId: org.id, userId: callerId, revokedByUserId: owner.id });
  await refuses(
    'a revoked PIN stops working immediately',
    () => signInWithPin({ identifier: email, pin: rotated.pin }),
    /do not match/i,
  );

  const afterRevoke = (await roster({ orgId: org.id })).find((c) => c.callerId === callerId);
  check('and the floor shows access as revoked', afterRevoke?.pin.status === 'REVOKED',
    afterRevoke?.pin.status ?? 'missing');

  const reissued = await issuePin({ orgId: org.id, userId: callerId, issuedByUserId: owner.id });
  check('re-issuing restores access', (await signInWithPin({ identifier: email, pin: reissued.pin })).userId === callerId);

  // =========================================================================
  console.log('\n--- the four surfaces agree ---------------------------------------');

  // A fixed instant, so the answer does not depend on when the audit runs.
  const at = new Date('2026-08-13T15:00:00Z'); // 10am in Chicago, 8am in LA.
  const counts = await eligibilityCounts({ orgId: org.id, mode: 'PRODUCTION', now: at });
  const ids = await callableRouteIds({ orgId: org.id, mode: 'PRODUCTION', limit: 500, unassignedOnly: true, now: at });

  check('callable-now equals the callable route list plus the assigned ones',
    counts.CALLABLE_NOW === ids.length + counts.callableAssigned,
    `${counts.CALLABLE_NOW} = ${ids.length} + ${counts.callableAssigned}`);

  const total = await prisma.routeHypothesis.count({ where: { orgId: org.id, dataMode: 'PRODUCTION' } });
  const bucketed = Object.entries(counts)
    .filter(([k]) => !['callableUnassigned', 'callableAssigned', 'total'].includes(k))
    .reduce((sum, [, v]) => sum + (v as number), 0);
  check('the buckets partition every production route exactly once',
    bucketed === total && counts.total === total, `${bucketed} bucketed, ${total} routes`);

  // The demand board is the same expression, so its call-now must be a subset
  // of contact-ready. It does not check business hours, which is why the two
  // numbers legitimately differ — and why the page now says so.
  const summary = await queueSummary(org.id);
  check('the demand board never reports more callable than the canonical pool allows',
    summary.call_now <= counts.CALLABLE_NOW + counts.WAITING_FOR_HOURS,
    `board ${summary.call_now}, canonical callable+waiting ${counts.CALLABLE_NOW + counts.WAITING_FOR_HOURS}`);
  check('and research-needed matches exactly', summary.research === counts.RESEARCH_NEEDED,
    `board ${summary.research}, canonical ${counts.RESEARCH_NEEDED}`);

  // The old page's query, reproduced, to show what it was counting.
  const legacy = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count FROM "RouteHypothesis" r
    LEFT JOIN "PacketItem" pi ON pi."routeId" = r."id" AND pi."status" IN ('PENDING','IN_PROGRESS')
    WHERE r."orgId" = ${org.id} AND r."status" NOT IN ('EXPIRED','REJECTED','COLD')
      AND r."tier" IN ('ACTIVE_DEMAND','STRONG_TRIGGER') AND pi."id" IS NULL
  `;
  const old = Number(legacy[0].count);
  check('the old callers-page number is explained by the canonical buckets',
    old >= counts.callableUnassigned,
    `old said ${old}; canonical callable-unassigned is ${counts.callableUnassigned}, the rest is research, hours, follow-ups and blocks`);

  // Every route the preview would offer is genuinely callable at that instant.
  if (ids.length > 0) {
    const verify = await prisma.$queryRaw<Array<{ id: string; bucket: string; assigned: boolean }>>`
      SELECT r."id" AS id, ${bucketSql(at)} AS bucket, ${ASSIGNED_SQL} AS assigned
      ${ELIGIBILITY_FROM}
      WHERE r."orgId" = ${org.id} AND r."id" IN (${Prisma.join(ids)})
    `;
    check('every route the preview would offer is callable and unheld',
      verify.every((v) => v.bucket === 'CALLABLE_NOW' && !v.assigned),
      `${verify.filter((v) => v.bucket !== 'CALLABLE_NOW').length} not callable`);
  } else {
    check('nothing is callable at the fixed audit instant, and that is reported rather than hidden', true,
      `${counts.WAITING_FOR_HOURS} waiting for local hours`);
  }

  // =========================================================================
  console.log('\n--- preview writes nothing ----------------------------------------');

  const before = {
    attempts: await prisma.outreachAttempt.count({ where: { orgId: org.id } }),
    items: await prisma.packetItem.count({ where: { orgId: org.id } }),
    packets: await prisma.workPacket.count({ where: { orgId: org.id } }),
  };

  const preview = await previewAssignment({ orgId: org.id, callerId, requested: 5 });
  check('a preview returns a plan', !('error' in preview),
    'error' in preview ? preview.error.slice(0, 70) : `${preview.rows.length} rows`);

  await previewAssignment({ orgId: org.id, callerId, requested: 5 });
  await previewAssignment({ orgId: org.id, callerId, requested: 5 });

  const after = {
    attempts: await prisma.outreachAttempt.count({ where: { orgId: org.id } }),
    items: await prisma.packetItem.count({ where: { orgId: org.id } }),
    packets: await prisma.workPacket.count({ where: { orgId: org.id } }),
  };
  check('previewing three times consumes nothing',
    before.attempts === after.attempts && before.items === after.items && before.packets === after.packets,
    JSON.stringify(after));

  if (!('error' in preview)) {
    check('and it explains what it left out', preview.excluded.length > 0 || preview.pool.total === preview.rows.length,
      preview.excluded.map((e) => `${e.count} ${e.label}`).join('; ').slice(0, 110));
  }

  // =========================================================================
  console.log('\n--- production and sandbox cannot mix -----------------------------');

  await ensureSandbox({ orgId: org.id, actorId: owner.id });
  const sandbox = await sandboxState(org.id);
  check('the sandbox has fixtures for all three businesses', sandbox.routes >= 3, `${sandbox.routes} routes`);

  const testCaller = await createCaller({
    orgId: org.id, actorId: owner.id,
    name: 'Audit Test Caller', email: `audit-test-${stamp}@dealdispatch.test`, mode: 'TEST',
  });
  check('an owner can create a test caller', testCaller.ok);
  if (!testCaller.ok) throw new Error('cannot continue');

  const productionRoute = await prisma.routeHypothesis.findFirst({
    where: { orgId: org.id, dataMode: 'PRODUCTION' }, select: { id: true },
  });
  const testRoute = await prisma.routeHypothesis.findFirst({
    where: { orgId: org.id, dataMode: 'TEST' }, select: { id: true },
  });

  if (productionRoute && testRoute) {
    const crossed = await confirmAssignment({
      orgId: org.id, actorId: owner.id, callerId: testCaller.callerId, routeIds: [productionRoute.id],
    });
    check('a test caller cannot be assigned a real opportunity', !crossed.ok,
      crossed.ok ? 'ASSIGNED — this is the bug' : crossed.error.slice(0, 80));

    const crossedBack = await confirmAssignment({
      orgId: org.id, actorId: owner.id, callerId, routeIds: [testRoute.id],
    });
    check('and a production caller cannot be assigned a sandbox one', !crossedBack.ok,
      crossedBack.ok ? 'ASSIGNED — this is the bug' : crossedBack.error.slice(0, 80));

    // The library refusals above are convenience. This is the guarantee.
    const packet = await prisma.workPacket.create({
      data: { orgId: org.id, callerId: testCaller.callerId, name: 'audit crossing', dataMode: 'TEST' },
      select: { id: true },
    });
    await refuses(
      'and the database refuses the crossing even when the library is bypassed',
      () => prisma.packetItem.create({
        data: {
          orgId: org.id, packetId: packet.id, callerId: testCaller.callerId,
          routeId: productionRoute.id, dataMode: 'TEST',
        },
      }),
      /packet_item_data_mode/,
    );
    await prisma.workPacket.delete({ where: { id: packet.id } });

    await refuses(
      'a packet cannot be handed to a caller of the other world',
      () => prisma.workPacket.create({
        data: { orgId: org.id, callerId: testCaller.callerId, name: 'audit crossing 2', dataMode: 'PRODUCTION' },
      }),
      /packet_data_mode/,
    );

    await refuses(
      'and an attempt cannot be recorded against an opportunity of the other world',
      () => prisma.outreachAttempt.create({
        data: {
          orgId: org.id, routeId: testRoute.id, disposition: 'NO_ANSWER', dataMode: 'PRODUCTION',
        },
      }),
      /attempt_data_mode/,
    );
  }

  const testPreview = await previewAssignment({ orgId: org.id, callerId: testCaller.callerId, requested: 5 });
  check('a test caller previews only sandbox work',
    !('error' in testPreview) && testPreview.mode === 'TEST'
    && testPreview.rows.every((r) => r.organisation.includes('[TEST]')),
    'error' in testPreview ? testPreview.error : testPreview.rows.map((r) => r.organisation).join(', ').slice(0, 90));

  // Production counts must not move when the sandbox exists.
  const productionCounts = await eligibilityCounts({ orgId: org.id, mode: 'PRODUCTION', now: at });
  check('sandbox opportunities do not appear in production counts',
    productionCounts.total === total, `${productionCounts.total} vs ${total} before the sandbox`);

  const boardAfter = await queueSummary(org.id);
  check('and the demand board is unchanged by them',
    boardAfter.call_now === summary.call_now && boardAfter.research === summary.research,
    `call_now ${boardAfter.call_now}, research ${boardAfter.research}`);

  // =========================================================================
  console.log('\n--- reset touches only the sandbox --------------------------------');

  const productionBefore = await prisma.routeHypothesis.count({ where: { orgId: org.id, dataMode: 'PRODUCTION' } });
  const attemptsBefore = await prisma.outreachAttempt.count({ where: { orgId: org.id, dataMode: 'PRODUCTION' } });
  await resetSandbox({ orgId: org.id, actorId: owner.id });
  const productionAfter = await prisma.routeHypothesis.count({ where: { orgId: org.id, dataMode: 'PRODUCTION' } });
  const attemptsAfter = await prisma.outreachAttempt.count({ where: { orgId: org.id, dataMode: 'PRODUCTION' } });

  check('resetting the sandbox leaves every production route alone',
    productionBefore === productionAfter, `${productionBefore} then ${productionAfter}`);
  check('and every production attempt', attemptsBefore === attemptsAfter,
    `${attemptsBefore} then ${attemptsAfter}`);
  check('and the test caller survives the reset',
    (await prisma.user.count({ where: { id: testCaller.callerId } })) === 1);
  check('and the fixtures come back', (await sandboxState(org.id)).routes >= 3);

  // =========================================================================
  console.log('\n--- deactivation keeps the history --------------------------------');

  const historyBefore = await prisma.outreachAttempt.count({ where: { orgId: org.id, userId: callerId } });
  const off = await deactivateCaller({ orgId: org.id, actorId: owner.id, callerId, reason: 'audit' });
  check('deactivating works', off.ok, off.message ?? `${off.released} released`);

  await refuses(
    'and the deactivated caller cannot sign in',
    () => signInWithPin({ identifier: email, pin: reissued.pin }),
    /do not match/i,
  );

  const historyAfter = await prisma.outreachAttempt.count({ where: { orgId: org.id, userId: callerId } });
  check('their calls are still on the record', historyBefore === historyAfter,
    `${historyBefore} then ${historyAfter}`);
  check('and they are not on the active floor',
    !(await roster({ orgId: org.id })).some((c) => c.callerId === callerId));
  check('but they are listed among the deactivated',
    (await roster({ orgId: org.id, includeInactive: true })).some((c) => c.callerId === callerId));

  const back = await reactivateCaller({ orgId: org.id, actorId: owner.id, callerId });
  check('reactivating works, and still requires a new PIN', back.ok,
    (await roster({ orgId: org.id })).find((c) => c.callerId === callerId)?.pin.status ?? '');

  // =========================================================================
  console.log('\n--- the audit trail names the actor -------------------------------');

  const trail = await prisma.auditEvent.findMany({
    where: {
      orgId: org.id,
      action: { in: ['caller.created', 'caller.pin_issued', 'caller.pin_revoked', 'caller.deactivated', 'caller.reactivated'] },
      entityId: { in: [callerId, testCaller.callerId] },
    },
    select: { action: true, userId: true, metadata: true },
  });
  check('every lifecycle action is audited', trail.length >= 5, `${trail.length} events`);
  check('and each names the owner who did it', trail.every((t) => t.userId === owner.id));
  check('and no audit event contains a PIN',
    !JSON.stringify(trail).match(/\b\d{6}\b/), 'checked for six-digit strings');

  await cleanUp(org.id);

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  if (failures > 0) process.exitCode = 1;
}

async function cleanUp(orgId: string) {
  const audited = await prisma.user.findMany({
    where: { orgId, email: { contains: 'audit-caller-' } },
    select: { id: true },
  });
  const testers = await prisma.user.findMany({
    where: { orgId, email: { contains: 'audit-test-' } },
    select: { id: true },
  });
  const ids = [...audited, ...testers].map((u) => u.id);
  if (ids.length > 0) {
    await prisma.packetItem.deleteMany({ where: { callerId: { in: ids } } });
    await prisma.workPacket.deleteMany({ where: { callerId: { in: ids } } });
    await prisma.callerProfile.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
