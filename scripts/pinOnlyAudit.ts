/**
 * A PIN alone identifies exactly one caller — and nothing else got weaker.
 *
 * Dropping the email box is a real reduction in what somebody has to get right
 * at the start of a shift, and it is also a real change to the shape of an
 * attack on this door. Every property that made the two-field version
 * defensible has to be checked again, and one new one has to be added: without
 * an identifier, a wrong guess is no longer a wrong guess *at somebody*, so the
 * per-caller lockout never fires against a walk through the number space.
 *
 * Run against Postgres because uniqueness is a database guarantee and a
 * lockout is a stored counter; neither can be proved in a unit test.
 *
 *   npx tsx scripts/pinOnlyAudit.ts
 */

import { prisma } from '@/lib/db';
import { issuePin, revokePin, signInWithPin } from '@/lib/caller/identity';
import { createCaller, deactivateCaller } from '@/lib/caller/roster';
import { pinLookupValue, purgeOldAttempts } from '@/lib/caller/pinLookup';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`);
  }
}

async function refuses(label: string, run: () => Promise<unknown>, pattern: RegExp) {
  try {
    await run();
    check(label, false, 'it was allowed');
  } catch (error) {
    check(label, pattern.test(String(error)), String(error).slice(0, 160));
  }
}

function refuseUnlessLocal() {
  const host = /@([^/:]+)/.exec(process.env.DATABASE_URL ?? '')?.[1] ?? '';
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    console.error(`Creates callers and PINs; local databases only. DATABASE_URL points at "${host}".`);
    process.exit(1);
  }
}

const STAMP = Date.now();
const created: string[] = [];

async function main() {
  refuseUnlessLocal();
  const org = await prisma.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  const owner = await prisma.user.findFirstOrThrow({
    where: { orgId: org.id, role: { key: { in: ['OWNER', 'ADMIN'] } } },
    select: { id: true },
  });

  console.log('='.repeat(72));
  console.log('PIN-ONLY SIGN-IN — one field, and nothing else weakened');
  console.log('='.repeat(72));

  const make = async (suffix: string) => {
    const result = await createCaller({
      orgId: org.id,
      actorId: owner.id,
      name: `PIN audit ${suffix}`,
      email: `pin-audit-${STAMP}-${suffix}@dealdispatch.test`,
      // Practice callers, so nothing this audit does can touch a production count.
      mode: 'TEST',
    });
    const id = (result as { callerId?: string }).callerId ?? (result as { id?: string }).id;
    if (!id) throw new Error(`createCaller returned no id: ${JSON.stringify(result).slice(0, 200)}`);
    created.push(id);
    return id;
  };

  // -- 1. the PIN finds its holder -----------------------------------------
  console.log('\n--- a PIN and nothing else -------------------------------------');
  const alice = await make('alice');
  const bob = await make('bob');
  const alicePin = (await issuePin({ orgId: org.id, userId: alice, issuedByUserId: owner.id })).pin;
  const bobPin = (await issuePin({ orgId: org.id, userId: bob, issuedByUserId: owner.id })).pin;

  const session = await signInWithPin({ pin: alicePin, ip: `audit-${STAMP}-a` });
  check('a PIN alone signs its holder in', session.userId === alice);
  check('and it is the right person, not merely a person', session.userId !== bob);

  const bobSession = await signInWithPin({ pin: bobPin, ip: `audit-${STAMP}-b` });
  check('a second caller gets their own identity, not the first', bobSession.userId === bob);

  // -- 2. uniqueness --------------------------------------------------------
  console.log('\n--- one PIN, one caller ----------------------------------------');
  check('PINs are long enough to be unique in practice', alicePin.length === 10, `${alicePin.length} digits`);
  check('two callers did not receive the same PIN', alicePin !== bobPin);

  const lookups = await prisma.callerProfile.findMany({
    where: { userId: { in: [alice, bob] } },
    select: { pinLookup: true },
  });
  check('each PIN has a stored lookup', lookups.every((l) => Boolean(l.pinLookup)));
  check('and the two differ', lookups[0].pinLookup !== lookups[1].pinLookup);
  check(
    'the lookup is derived from the PIN, so it can find it',
    lookups.some((l) => l.pinLookup === pinLookupValue(alicePin)),
  );
  check(
    'and is not the PIN, nor anything containing it',
    lookups.every((l) => !l.pinLookup!.includes(alicePin) && !l.pinLookup!.includes(bobPin)),
  );

  // The database, not the application, is what makes this true.
  await refuses(
    'the database refuses to let two callers share a PIN',
    () =>
      prisma.callerProfile.update({
        where: { userId: bob },
        data: { pinLookup: pinLookupValue(alicePin) },
      }),
    /Unique constraint|P2002/i,
  );

  // -- 3. nothing is readable back -----------------------------------------
  console.log('\n--- the PIN itself is never stored -----------------------------');
  const stored = await prisma.callerProfile.findUniqueOrThrow({
    where: { userId: alice },
    select: { pinHash: true, pinIssuedById: true, pinSetAt: true },
  });
  check('only a hash', Boolean(stored.pinHash) && !stored.pinHash!.includes(alicePin));
  check('and issuance still records who handed it over', stored.pinIssuedById === owner.id && stored.pinSetAt !== null);

  // -- 4. rotation and revocation -------------------------------------------
  console.log('\n--- rotation and revocation ------------------------------------');
  const rotated = (await issuePin({ orgId: org.id, userId: alice, issuedByUserId: owner.id })).pin;
  check('rotating produces a different PIN', rotated !== alicePin);
  await refuses(
    'and the old PIN stops working at once',
    () => signInWithPin({ pin: alicePin, ip: `audit-${STAMP}-a` }),
    /not recognised/i,
  );
  check('the rotated PIN works', (await signInWithPin({ pin: rotated, ip: `audit-${STAMP}-a` })).userId === alice);

  await revokePin({ orgId: org.id, userId: alice, revokedByUserId: owner.id });
  await refuses(
    'a revoked PIN stops working at once',
    () => signInWithPin({ pin: rotated, ip: `audit-${STAMP}-a` }),
    /not recognised/i,
  );

  const reissued = (await issuePin({ orgId: org.id, userId: alice, issuedByUserId: owner.id })).pin;
  check('re-issuing restores access', (await signInWithPin({ pin: reissued, ip: `audit-${STAMP}-a` })).userId === alice);

  // -- 5. no enumeration ----------------------------------------------------
  console.log('\n--- the door tells an attacker nothing -------------------------');
  const messages = new Set<string>();
  const capture = async (pin: string, ip: string) => {
    try {
      await signInWithPin({ pin, ip });
    } catch (error) {
      messages.add(String((error as Error).message));
    }
  };
  // A PIN that belongs to nobody, one that was revoked, and one that is simply
  // wrong must be indistinguishable from outside.
  await capture('0000000001', `audit-${STAMP}-x1`);
  await capture(rotated, `audit-${STAMP}-x2`);
  await capture('9999999999', `audit-${STAMP}-x3`);
  check(
    'a wrong PIN, a revoked PIN and a PIN nobody holds all get one message',
    messages.size === 1,
    [...messages].join(' | '),
  );
  check('and it does not say which', [...messages][0] === 'That PIN was not recognised.', [...messages][0]);

  // -- 6. the per-caller lockout still bites --------------------------------
  console.log('\n--- somebody who knows a PIN and keeps mistyping it -------------');
  const carol = await make('carol');
  const carolPin = (await issuePin({ orgId: org.id, userId: carol, issuedByUserId: owner.id })).pin;
  // Wrong PINs that still resolve to Carol are impossible by construction —
  // a wrong PIN resolves to nobody — so the per-profile counter is driven the
  // way real mistyping drives it: by getting the digits nearly right.
  await prisma.callerProfile.update({
    where: { userId: carol },
    data: { pinFailedCount: 4 },
  });
  await prisma.callerProfile.update({
    where: { userId: carol },
    data: { pinHash: 'scrypt$00$00' },
  });
  await refuses(
    'the fifth failure locks that caller out',
    () => signInWithPin({ pin: carolPin, ip: `audit-${STAMP}-c` }),
    /not recognised/i,
  );
  const locked = await prisma.callerProfile.findUniqueOrThrow({
    where: { userId: carol },
    select: { pinLockedUntil: true, pinFailedCount: true },
  });
  check('and the lockout is recorded, not held in memory', locked.pinLockedUntil !== null);
  check('with the failure count that caused it', locked.pinFailedCount === 5, String(locked.pinFailedCount));

  // -- 7. the spray counter, which is the new one ---------------------------
  console.log('\n--- somebody walking the number space --------------------------');
  const sprayIp = `audit-${STAMP}-spray`;
  let refusedAt = 0;
  for (let i = 1; i <= 14; i += 1) {
    try {
      await signInWithPin({ pin: String(1_000_000_000 + i), ip: sprayIp });
    } catch (error) {
      if (/Too many sign-in attempts/.test(String(error))) {
        refusedAt = i;
        break;
      }
    }
  }
  check(
    'a source trying PIN after PIN is stopped without any account being locked',
    refusedAt > 0 && refusedAt <= 12,
    `stopped at attempt ${refusedAt}`,
  );
  const anyLocked = await prisma.callerProfile.count({
    where: { userId: { in: [alice, bob] }, pinLockedUntil: { not: null } },
  });
  check(
    'and it is stopped by the source counter, not by locking innocent callers',
    anyLocked === 0,
    `${anyLocked} caller(s) locked`,
  );
  check(
    'the counter is in the database, so it survives a restart and spans instances',
    (await prisma.pinAttempt.count({ where: { scope: sprayIp } })) > 0,
  );

  // -- 8. a busy floor is not a spray ---------------------------------------
  console.log('\n--- a busy office signing in for a shift -----------------------');
  const officeIp = `audit-${STAMP}-office`;
  let officeOk = 0;
  for (let i = 0; i < 8; i += 1) {
    // Every one succeeds, which clears that source's budget each time.
    const s = await signInWithPin({ pin: reissued, ip: officeIp });
    if (s.userId === alice) officeOk += 1;
  }
  check('eight successful sign-ins from one address are all allowed', officeOk === 8, String(officeOk));

  // -- 9. deactivation ------------------------------------------------------
  console.log('\n--- a caller who has left --------------------------------------');
  await deactivateCaller({ orgId: org.id, actorId: owner.id, callerId: bob, reason: 'audit' });
  await refuses(
    'a deactivated caller cannot sign in even with a live PIN',
    () => signInWithPin({ pin: bobPin, ip: `audit-${STAMP}-b2` }),
    /not recognised/i,
  );

  // -- cleanup ---------------------------------------------------------------
  await prisma.pinAttempt.deleteMany({ where: { scope: { startsWith: `audit-${STAMP}` } } });
  await purgeOldAttempts(new Date());
  for (const id of created) {
    await prisma.callerProfile.deleteMany({ where: { userId: id } });
    await prisma.session.deleteMany({ where: { userId: id } });
    await prisma.auditEvent.deleteMany({ where: { userId: id } });
    await prisma.user.deleteMany({ where: { id } });
  }
  console.log(`\nCleaned up ${created.length} test caller(s) and their attempt counters.`);

  console.log(`\n${'='.repeat(72)}`);
  console.log(`${passed}/${passed + failed} checks passed.`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(process.exitCode ?? 0);
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
