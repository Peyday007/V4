/**
 * Deal rooms against a real Postgres.
 *
 * The unit tests cover what the room says. This covers the things only the
 * database can answer, and they are the ones that would embarrass us:
 *
 *   Whether a preview really writes nothing. An owner who appears in the
 *   engagement history as the prospect makes the only number this feature
 *   produces worthless.
 *
 *   Whether the ladder is genuinely idempotent under repeats — a refresh, a
 *   double-clicked button, a mail scanner following the link.
 *
 *   Whether a token grants exactly one page, with no id anywhere that could be
 *   used to walk to a second.
 *
 *   Whether the snapshot holds. A prospect opening the link three weeks later
 *   must see what we sent, not what the engine believes today.
 *
 *   npx tsx scripts/dealRoomAudit.ts
 */

import { prisma } from '@/lib/db';
import { captureRequirement } from '@/lib/deal/requirement';
import { addCandidate, advanceCandidate } from '@/lib/deal/provider';
import { createRoom, markSent, markDelivered, openRoom, recordProspectAction, expireRooms } from '@/lib/room/rooms';
import { buildRoomContent } from '@/lib/room/content';
import { loadDealRecord } from '@/lib/deal/record';

let failures = 0;
let checks = 0;

function check(label: string, passed: boolean, detail = '') {
  checks += 1;
  if (!passed) failures += 1;
  console.log(`${passed ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
}

const HUMAN = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/128 Safari/537.36';
const SCANNER = 'Slackbot-LinkExpanding 1.0';

async function main() {
  const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!org) throw new Error('No organisation. Seed the database first.');
  const orgId = org.id;

  const owner = await prisma.user.findFirst({ where: { orgId }, orderBy: { createdAt: 'asc' } });
  const ownerId = owner?.id ?? null;

  const route = await prisma.routeHypothesis.findFirst({
    where: { orgId, event: { eventDate: { not: null } } },
    orderBy: { createdAt: 'asc' },
  });
  if (!route) throw new Error('No route with a dated event. Run scripts/dealProgressionAudit.ts first.');

  const providerCompany = await prisma.company.findFirst({
    where: { orgId, id: { not: route.companyId } },
    orderBy: { createdAt: 'asc' },
  });
  if (!providerCompany) throw new Error('Need a second company to act as a provider.');

  // Clean slate for this route's rooms only.
  await prisma.dealRoomEvent.deleteMany({ where: { room: { routeId: route.id } } });
  await prisma.dealRoom.deleteMany({ where: { routeId: route.id } });

  // -----------------------------------------------------------------------
  console.log('--- a room refuses to exist without something to say ------------');

  // In dependency order. A priced requirement cannot be deleted while a quote
  // points at it — `onDelete: Restrict`, deliberately, so history cannot be
  // dropped by tidying — so the money layer comes off first.
  await prisma.dealPayment.deleteMany({ where: { deal: { routeId: route.id } } });
  await prisma.dealMilestone.deleteMany({ where: { deal: { routeId: route.id } } });
  await prisma.routeDeal.deleteMany({ where: { routeId: route.id } });
  await prisma.approval.deleteMany({ where: { routeId: route.id } });
  await prisma.routeQuote.deleteMany({ where: { routeId: route.id } });
  await prisma.buyerRequirement.deleteMany({ where: { routeId: route.id } });
  await prisma.providerCandidate.deleteMany({ where: { routeId: route.id } });

  const bare = await buildRoomContent({ orgId, routeId: route.id });
  const thin = await createRoom({ orgId, routeId: route.id, actorId: ownerId });

  if (bare?.tooThinToSend) {
    check('a route with nothing confirmed is refused a room', !thin.ok && thin.kind === 'too_thin',
      thin.ok ? 'created anyway' : thin.detail.join(' '));
  } else {
    // The fixture route carries confirmed facts from its event, which is a
    // legitimate basis for a room. Recorded rather than skipped.
    check('the fixture route already has enough to send', thin.ok, 'no thin-content case available');
  }

  // Give it real material.
  await captureRequirement({
    orgId,
    routeId: route.id,
    input: {
      summary: 'Nightly cleaning, three sites',
      specification: 'Nightly janitorial including restrooms',
      locations: '3 sites in Chicago',
      frequency: '5 nights a week',
      timingNote: 'before the contract ends in March',
      decisionMakerRole: 'Facilities Director',
      authorityConfirmed: true,
      confirmed: ['summary', 'specification', 'locations', 'frequency', 'timingNote', 'decisionMakerRole'],
    },
    actorId: ownerId,
  });

  const candidate = await addCandidate({
    orgId, routeId: route.id, providerCompanyId: providerCompany.id,
    matchBasis: 'Capability and geography matched by the catalogue.',
  });
  await advanceCandidate({
    orgId, candidateId: candidate.id, to: 'CAPABILITY_VERIFIED', reason: 'Reference checked.',
    fields: {
      capabilityEvidence: 'Three comparable nightly contracts.',
      credentialsEvidence: 'COI on file.',
    },
  });

  // -----------------------------------------------------------------------
  console.log('\n--- creating -----------------------------------------------------');

  await prisma.dealRoom.deleteMany({ where: { routeId: route.id } });
  const created = await createRoom({ orgId, routeId: route.id, actorId: ownerId });
  check('a room is created once there is real material', created.ok,
    created.ok ? '' : created.detail.join(' '));
  if (!created.ok) throw new Error('Cannot continue without a room.');

  const room = created.room;
  check('the token is long enough to be a secret', room.token.length >= 32, `${room.token.length} chars`);
  check('the token is not derived from anything about the prospect',
    !room.token.toLowerCase().includes(route.id.slice(0, 8).toLowerCase())
    && !room.token.toLowerCase().includes('cleaning'));
  check('it expires', room.expiresAt.getTime() > Date.now());
  check('a CREATED event is recorded',
    (await prisma.dealRoomEvent.count({ where: { roomId: room.id, kind: 'CREATED' } })) === 1);

  const second = await createRoom({ orgId, routeId: route.id, actorId: ownerId });
  check('a route cannot have two live rooms', !second.ok && second.kind === 'already_live');

  // The database, not the code, is what makes that true.
  let indexHeld = false;
  try {
    await prisma.dealRoom.create({
      data: {
        orgId, routeId: route.id, token: 'x'.repeat(48), state: 'SENT',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
  } catch { indexHeld = true; }
  check('the database refuses a second live room', indexHeld);

  let tokenGuardHeld = false;
  try {
    await prisma.dealRoom.create({
      data: {
        orgId, routeId: route.id, token: 'short', state: 'EXPIRED',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
  } catch { tokenGuardHeld = true; }
  check('the database refuses a short token', tokenGuardHeld);

  // -----------------------------------------------------------------------
  console.log('\n--- the preview writes nothing -----------------------------------');

  const before = await prisma.dealRoomEvent.count({ where: { roomId: room.id } });
  const preview1 = await openRoom({ token: room.token, preview: true });
  const preview2 = await openRoom({ token: room.token, preview: true, userAgent: HUMAN });
  const after = await prisma.dealRoomEvent.count({ where: { roomId: room.id } });

  check('a preview renders the same content', preview1?.content.organisation === created.content.organisation);
  check('previewing twice records no event', after === before, `${before} → ${after}`);
  const stillDraft = await prisma.dealRoom.findUniqueOrThrow({ where: { id: room.id } });
  check('and does not move the state or the counter',
    stillDraft.state === 'DRAFT' && stillDraft.openCount === 0 && stillDraft.firstOpenAt === null);
  check('the preview carries the room id, so the owner page can act on it', preview1?.roomId === room.id);
  check('a public open never carries an id', preview2 !== null && (await openRoom({ token: room.token, preview: false, userAgent: SCANNER }))?.roomId === null);

  // -----------------------------------------------------------------------
  console.log('\n--- opening ------------------------------------------------------');

  await prisma.dealRoomEvent.deleteMany({ where: { roomId: room.id, kind: 'OPENED' } });
  await prisma.dealRoom.update({
    where: { id: room.id },
    data: { state: 'DRAFT', openCount: 0, firstOpenAt: null, lastOpenAt: null },
  });

  const contact = await prisma.contact.findFirst({ where: { orgId, companyId: route.companyId } })
    ?? await prisma.contact.findFirst({ where: { orgId } });
  if (contact) {
    const sent = await markSent({ orgId, roomId: room.id, contactId: contact.id, channel: 'email', actorId: ownerId });
    check('a room can be marked sent', sent.ok);
    await markDelivered({ orgId, roomId: room.id });
    const delivered = await prisma.dealRoom.findUniqueOrThrow({ where: { id: room.id } });
    check('delivery is a separate fact from sending',
      delivered.state === 'DELIVERED' && delivered.deliveredAt !== null && delivered.sentAt !== null);
  }

  // A mail scanner follows the link first, as they do.
  await openRoom({ token: room.token, userAgent: SCANNER });
  const afterScanner = await prisma.dealRoom.findUniqueOrThrow({ where: { id: room.id } });
  check('a link scanner does not count as a reader',
    afterScanner.openCount === 0 && afterScanner.firstOpenAt === null,
    `openCount ${afterScanner.openCount}`);
  check('but the fetch is still recorded, classified as automated',
    (await prisma.dealRoomEvent.count({
      where: { roomId: room.id, kind: 'OPENED', userAgentClass: 'automated' },
    })) === 1);

  // Then the person opens it, three times.
  await openRoom({ token: room.token, userAgent: HUMAN });
  await openRoom({ token: room.token, userAgent: HUMAN });
  await openRoom({ token: room.token, userAgent: HUMAN });

  const opened = await prisma.dealRoom.findUniqueOrThrow({ where: { id: room.id } });
  check('a person opening it moves the state', opened.state === 'OPENED' && opened.firstOpenAt !== null);
  check('three refreshes in one day count as one open', opened.openCount === 1, `openCount ${opened.openCount}`);
  check('and produce one human OPENED event',
    (await prisma.dealRoomEvent.count({
      where: { roomId: room.id, kind: 'OPENED', userAgentClass: 'human' },
    })) === 1);

  // -----------------------------------------------------------------------
  console.log('\n--- what the prospect does --------------------------------------');

  const first = await recordProspectAction({ token: room.token, action: 'QUOTE_REQUESTED', note: 'Send a price for all three sites.' });
  const again = await recordProspectAction({ token: room.token, action: 'QUOTE_REQUESTED', note: 'Send a price for all three sites.' });

  check('a request is recorded', first.ok && !first.alreadyRecorded);
  check('a double-clicked button is not two requests', again.ok && again.alreadyRecorded);
  check('and the prospect is told the same thing either way', first.message === again.message);
  check('exactly one event exists for it',
    (await prisma.dealRoomEvent.count({ where: { roomId: room.id, kind: 'QUOTE_REQUESTED' } })) === 1);

  const responded = await prisma.dealRoom.findUniqueOrThrow({ where: { id: room.id } });
  check('the room records what they wrote, in their words',
    responded.responseNote === 'Send a price for all three sites.' && responded.state === 'RESPONDED');

  const trail = await prisma.dealEvent.findFirst({
    where: { routeId: route.id, kind: 'room.quote_requested' },
  });
  check('it reaches the deal trail as evidence', trail !== null && trail.evidence !== null);

  // Twenty simultaneous requests, as a retrying client would produce.
  const burst = await Promise.allSettled(
    Array.from({ length: 20 }, () => recordProspectAction({ token: room.token, action: 'NEXT_STEP_REQUESTED' })),
  );
  const bursted = await prisma.dealRoomEvent.count({ where: { roomId: room.id, kind: 'NEXT_STEP_REQUESTED' } });
  check('twenty simultaneous clicks produce one event', bursted === 1, `${bursted} events`);
  check('and none of them errors at the prospect',
    burst.every((r) => r.status === 'fulfilled' && r.value.ok),
    burst.filter((r) => r.status === 'rejected').length + ' rejected');

  // -----------------------------------------------------------------------
  console.log('\n--- the snapshot holds -------------------------------------------');

  const snapshotBefore = (await prisma.dealRoom.findUniqueOrThrow({ where: { id: room.id } })).content as { sections: unknown[] };

  // The engine learns something new after the room was sent.
  await captureRequirement({
    orgId,
    routeId: route.id,
    input: { quantity: '9 sites now', locations: '9 sites in Chicago', confirmed: ['quantity', 'locations'] },
    actorId: ownerId,
  });

  const reopened = await openRoom({ token: room.token, preview: true });
  const stillSays = JSON.stringify(reopened?.content.sections) === JSON.stringify(snapshotBefore.sections);
  check('a room opened later still says what we sent', stillSays);

  const fresh = await buildRoomContent({ orgId, routeId: route.id });
  check('while a newly built room would say something different',
    JSON.stringify(fresh?.sections) !== JSON.stringify(snapshotBefore.sections));

  // -----------------------------------------------------------------------
  console.log('\n--- token safety --------------------------------------------------');

  check('an unknown token is nothing at all', (await openRoom({ token: 'x'.repeat(43) })) === null);
  check('a token from another shape is nothing at all', (await openRoom({ token: route.id })) === null);

  const view = await openRoom({ token: room.token, userAgent: HUMAN });
  const serialised = JSON.stringify(view);
  for (const [label, id] of [
    ['the route id', route.id],
    ['the company id', route.companyId],
    ['the room id', room.id],
    ['the org id', orgId],
  ] as const) {
    check(`the public view does not carry ${label}`, !serialised.includes(id));
  }

  // -----------------------------------------------------------------------
  console.log('\n--- declining ----------------------------------------------------');

  const declined = await recordProspectAction({ token: room.token, action: 'DECLINED', note: 'We renewed last month.' });
  check('declining is accepted', declined.ok);
  check('and the acknowledgement promises to stop', declined.message.toLowerCase().includes('will not follow up'));

  const closed = await openRoom({ token: room.token, userAgent: HUMAN });
  check('a declined room stops serving', closed !== null && closed.live === false);
  check('and says so without blaming them', (closed?.closedReason ?? '').includes('closed at your request'));

  const openAfterDecline = await prisma.dealRoomEvent.count({
    where: { roomId: room.id, kind: 'OPENED', userAgentClass: 'human' },
  });
  check('a closed room records no further opens', openAfterDecline === 1, `${openAfterDecline}`);

  // -----------------------------------------------------------------------
  console.log('\n--- expiry --------------------------------------------------------');

  await prisma.dealRoom.deleteMany({ where: { routeId: route.id } });
  const toExpire = await createRoom({ orgId, routeId: route.id, actorId: ownerId });
  if (toExpire.ok) {
    // Aged, rather than backdated. The check constraint refuses an expiry
    // earlier than the creation — correctly, since a room cannot have died
    // before it existed — so both dates move together, which is exactly the
    // shape a genuinely old room has.
    const createdAt = new Date(Date.now() - 3 * 86_400_000);
    await prisma.dealRoom.update({
      where: { id: toExpire.room.id },
      data: { createdAt, expiresAt: new Date(createdAt.getTime() + 86_400_000) },
    });

    const beforeSweep = await openRoom({ token: toExpire.room.token, userAgent: HUMAN });
    check('a room past its date stops serving before any sweep runs', beforeSweep?.live === false);

    const swept = await expireRooms({ orgId });
    const afterSweep = await prisma.dealRoom.findUniqueOrThrow({ where: { id: toExpire.room.id } });
    check('the sweep marks it expired', swept >= 1 && afterSweep.state === 'EXPIRED');

    const action = await recordProspectAction({ token: toExpire.room.token, action: 'QUOTE_REQUESTED' });
    check('an expired room accepts no actions', !action.ok);
  }

  // -----------------------------------------------------------------------
  console.log('\n--- the owner record ----------------------------------------------');

  const record = await loadDealRecord({ orgId, routeId: route.id });
  check('the opportunity record shows the room', record.room.exists);
  check('and never carries the token', !JSON.stringify(record).includes(toExpire.ok ? toExpire.room.token : 'impossible'));

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
