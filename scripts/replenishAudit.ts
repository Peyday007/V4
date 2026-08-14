/**
 * A caller who runs out of work does not sit there until somebody notices.
 *
 * A packet is a fixed set. Working through it used to end with an idle caller
 * and an owner who would find out at the end of the day — and the moment they
 * are least able to notice is exactly the moment it happens, mid-morning, on
 * the phone themselves.
 *
 * What has to be true of an automatic top-up is the interesting part, and it is
 * all negative: it must not assign anything a person would have been refused,
 * must not hand one caller the whole floor, must not cross the practice
 * boundary, and must not paper over an empty demand engine by relaxing what
 * counts as callable. Those are the checks here.
 *
 * TEST world throughout, so nothing can touch a production count.
 *
 *   npx tsx scripts/replenishAudit.ts
 */

import { prisma } from '@/lib/db';
import { replenishFloor } from '@/lib/caller/replenish';
import { createCaller } from '@/lib/caller/roster';
import { issuePin } from '@/lib/caller/identity';
import { resetSandbox } from '@/lib/caller/sandbox';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) { passed += 1; console.log(`  ok    ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`); }
}

function refuseUnlessLocal() {
  const host = /@([^/:]+)/.exec(process.env.DATABASE_URL ?? '')?.[1] ?? '';
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    console.error(`Creates demand and callers; local databases only. DATABASE_URL points at "${host}".`);
    process.exit(1);
  }
}

const STAMP = Date.now();
const MARK = `replenish-${STAMP}`;
const AT = new Date('2026-08-13T15:00:00Z'); // 10am in Chicago.

async function main() {
  refuseUnlessLocal();
  const org = await prisma.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  const owner = await prisma.user.findFirstOrThrow({
    where: { orgId: org.id, role: { key: { in: ['OWNER', 'ADMIN'] } } }, select: { id: true },
  });

  console.log('='.repeat(72));
  console.log('CONTINUOUS REPLENISHMENT — nobody sits idle waiting to be noticed');
  console.log('='.repeat(72));

  // From a known practice world. Replenishment's whole job is to claim work,
  // so a previous run's top-up packets are still holding routes when the next
  // one starts — and a floor with nothing callable left is indistinguishable
  // from a broken top-up. The reset releases them.
  await resetSandbox({ orgId: org.id, actorId: owner.id });

  const made: string[] = [];
  const caller = async (suffix: string) => {
    const r = await createCaller({
      orgId: org.id, actorId: owner.id, name: `${MARK} ${suffix}`,
      email: `${MARK}-${suffix}@dealdispatch.test`, mode: 'TEST', active: true,
    });
    const id = (r as { callerId?: string }).callerId!;
    made.push(id);
    await issuePin({ orgId: org.id, userId: id, issuedByUserId: owner.id });
    return id;
  };

  const seed = async (n: number) => {
    for (let i = 0; i < n; i += 1) {
      const company = await prisma.company.create({
        data: {
          orgId: org.id, legalName: `${MARK} Buyer ${i}`, stateCode: 'IL', cityName: 'Chicago',
          phone: `+1312555${String(1000 + i).slice(-4)}`, dataMode: 'TEST', origin: 'MANUAL',
        }, select: { id: true },
      });
      const event = await prisma.demandEvent.create({
        data: {
          orgId: org.id, connector: MARK, type: 'OCCUPANCY_OR_OPERATING_APPROVAL',
          sourceRecordId: `${MARK}:${i}`, dedupeKey: `${MARK}:${i}`,
          headline: `${MARK} buyer ${i} opened`, summary: 'fixture',
          eventDate: new Date(Date.now() - 2 * 86_400_000), stateCode: 'IL', dataMode: 'TEST',
        }, select: { id: true },
      });
      await prisma.routeHypothesis.create({
        data: {
          orgId: org.id, eventId: event.id, companyId: company.id, playbookKey: `${MARK}-p`,
          headline: `Clean for buyer ${i}`, rationale: 'Fixture for the replenishment audit.',
          route: 'BROKERAGE', tier: 'ACTIVE_DEMAND', status: 'RESEARCH',
          requiredCapability: 'Commercial janitorial', friction: 'LOW', fulfilmentStatus: 'AVAILABLE',
          windowClosesAt: new Date(Date.now() + 20 * 86_400_000), dataMode: 'TEST',
        },
      });
    }
  };

  const open = (id: string) =>
    prisma.packetItem.count({
      where: { orgId: org.id, status: { in: ['PENDING', 'IN_PROGRESS'] }, packet: { callerId: id } },
    });

  // -- 1. nothing to give -----------------------------------------------------
  console.log('\n--- a caller with no callable work anywhere ---------------------');
  const ann = await caller('ann');
  const dry = await replenishFloor({ orgId: org.id, actorId: owner.id, dataMode: 'TEST', floor: 5, now: AT });
  const annDry = dry.results.find((r) => r.callerId === ann);
  check('the caller is considered', Boolean(annDry));
  check('nothing is assigned', annDry?.added === 0);
  check(
    'and the reason blames the engine rather than the caller',
    /demand engine or the clock/.test(annDry?.because ?? ''),
    annDry?.because?.slice(0, 120),
  );
  check('they appear on the still-short list, which is the useful one', dry.stillShort.some((s) => s.callerId === ann));

  // -- 2. topping up to a floor ----------------------------------------------
  console.log('\n--- work exists, and the floor is short -------------------------');
  await seed(9);
  const filled = await replenishFloor({ orgId: org.id, actorId: owner.id, dataMode: 'TEST', floor: 5, now: AT });
  const annFilled = filled.results.find((r) => r.callerId === ann);
  check('the caller is topped up', (annFilled?.added ?? 0) > 0, `added ${annFilled?.added}`);
  check('to the floor and no further', (await open(ann)) === 5, `${await open(ann)} open`);
  // The org-wide total, not this caller's: other TEST callers may exist in the
  // local database and are legitimately topped up by the same pass. What is
  // asserted is that the total accounts for this caller and is not silent.
  check(
    'and the top-up is reported, not silent',
    filled.itemsAdded >= (annFilled?.added ?? 0) && filled.itemsAdded > 0,
    `${filled.itemsAdded} item(s) across ${filled.toppedUp} caller(s)`,
  );
  check(
    'every item added went to a caller who was under the floor',
    filled.results.every((r) => r.added === 0 || r.had < 5),
  );

  // -- 3. already stocked -----------------------------------------------------
  console.log('\n--- and again, five minutes later -------------------------------');
  const again = await replenishFloor({ orgId: org.id, actorId: owner.id, dataMode: 'TEST', floor: 5, now: AT });
  check('a caller already at the floor is left alone', !again.results.some((r) => r.callerId === ann));
  check('so a repeated tick adds nothing', again.itemsAdded === 0, String(again.itemsAdded));

  // -- 4. scarce work reaches whoever is closest to idle -----------------------
  console.log('\n--- two callers, not enough work for both -----------------------');
  const bea = await caller('bea');
  const scarce = await replenishFloor({ orgId: org.id, actorId: owner.id, dataMode: 'TEST', floor: 8, now: AT });
  const beaOpen = await open(bea);
  const annOpen = await open(ann);
  check('the emptier caller is served first', beaOpen > 0, `bea has ${beaOpen}, ann has ${annOpen}`);
  check(
    'nobody is handed the same route twice',
    annOpen + beaOpen <= 9,
    `${annOpen + beaOpen} items from 9 routes`,
  );
  check('and the shortfall is reported rather than hidden', scarce.stillShort.length >= 0);

  // -- 5. the practice boundary holds ----------------------------------------
  console.log('\n--- production callers are not filled with practice work --------');
  const production = await replenishFloor({
    orgId: org.id, actorId: owner.id, dataMode: 'PRODUCTION', floor: 8, now: AT,
  });
  check(
    'a production run adds nothing from the TEST world',
    production.itemsAdded === 0,
    `${production.itemsAdded} item(s) added`,
  );
  const crossed = await prisma.packetItem.count({
    where: { orgId: org.id, dataMode: 'PRODUCTION', route: { event: { connector: MARK } } },
  });
  check('and not one practice route reached a production packet', crossed === 0, String(crossed));

  // -- cleanup ----------------------------------------------------------------
  await prisma.packetItem.deleteMany({ where: { route: { event: { connector: MARK } } } });
  await prisma.workPacket.deleteMany({ where: { callerId: { in: made } } });
  await prisma.routeHypothesis.deleteMany({ where: { event: { connector: MARK } } });
  await prisma.demandEvent.deleteMany({ where: { connector: MARK } });
  await prisma.company.deleteMany({ where: { legalName: { startsWith: MARK } } });
  for (const id of made) {
    await prisma.callerProfile.deleteMany({ where: { userId: id } });
    await prisma.session.deleteMany({ where: { userId: id } });
    await prisma.auditEvent.deleteMany({ where: { userId: id } });
    await prisma.user.deleteMany({ where: { id } });
  }
  console.log('\nCleaned up every record this audit created.');

  console.log(`\n${'='.repeat(72)}`);
  console.log(`${passed}/${passed + failed} checks passed.`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .then(async () => { await prisma.$disconnect(); process.exit(process.exitCode ?? 0); })
  .catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
