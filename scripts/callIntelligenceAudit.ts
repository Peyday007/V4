/**
 * Call intelligence against a real Postgres.
 *
 * The claim this audit exists to test is the directive's own: never manufacture
 * a recording row that implies audio exists. That is not something application
 * code can promise on its own — a later feature, a fixture, or a careless
 * backfill would eventually write a storage key onto a row whose audio was
 * never captured, and a screen would then offer a play button for a file nobody
 * has. So the database is asked directly, with the application bypassed.
 *
 * Also here: that a failure says what failed, that stored audio always has a
 * deletion date, that retention actually deletes, that a mixed-channel
 * transcript cannot claim to know who spoke, and that a reviewer's judgement
 * survives the next analysis.
 *
 *   npx tsx scripts/callIntelligenceAudit.ts
 */

import { prisma } from '@/lib/db';
import { startSession, finishSession, refuseRecording, expireRecordings, deleteRecording } from '@/lib/calls/recording';
import { transcribeSession, analyseSession, reviewInsight } from '@/lib/calls/analysis';
import { openReviewIfNeeded, completeReview, autoFillAccuracy } from '@/lib/calls/review';

let failures = 0;
let checks = 0;

function check(label: string, passed: boolean, detail = '') {
  checks += 1;
  if (!passed) failures += 1;
  console.log(`${passed ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
}

/** Did this database write fail? Used where the answer must be "yes". */
async function refused(write: () => Promise<unknown>): Promise<boolean> {
  try {
    await write();
    return false;
  } catch {
    return true;
  }
}

const TRANSCRIPT = [
  'Caller: Morning — I wanted to ask about your cleaning contract.',
  'Buyer: Our contract ends in March and we are with CleanCo at the moment.',
  'Buyer: Honestly the price is what matters most to us.',
  'Buyer: Can you send a quote over to me?',
  'Caller: I will send that through this afternoon.',
].join('\n');

async function main() {
  const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!org) throw new Error('No organisation. Seed the database first.');
  const orgId = org.id;

  const owner = await prisma.user.findFirst({ where: { orgId }, orderBy: { createdAt: 'asc' } });
  const ownerId = owner?.id ?? null;

  const route = await prisma.routeHypothesis.findFirst({
    where: { orgId },
    orderBy: { createdAt: 'asc' },
    include: { company: { select: { id: true, stateCode: true } } },
  });
  if (!route) throw new Error('No route. Run scripts/dealProgressionAudit.ts first.');

  await prisma.callReview.deleteMany({ where: { session: { routeId: route.id } } });
  await prisma.callInsight.deleteMany({ where: { session: { routeId: route.id } } });
  await prisma.callTranscript.deleteMany({ where: { session: { routeId: route.id } } });
  await prisma.callSession.deleteMany({ where: { routeId: route.id } });

  // -----------------------------------------------------------------------
  console.log('--- the database refuses to imply audio that does not exist ------');

  const base = {
    orgId, routeId: route.id, provider: 'audit', startedAt: new Date(),
  };

  check(
    'a storage key on a row that is not STORED is refused',
    await refused(() => prisma.callSession.create({
      data: { ...base, recordingState: 'NOT_ATTEMPTED', storageKey: 'audio/never-captured.mp3' },
    })),
  );

  check(
    'STORED with no storage key is refused',
    await refused(() => prisma.callSession.create({
      data: { ...base, recordingState: 'STORED', retentionUntil: new Date(Date.now() + 86_400_000) },
    })),
  );

  check(
    'a failure with no reason is refused',
    await refused(() => prisma.callSession.create({
      data: { ...base, recordingState: 'FAILED' },
    })),
  );

  check(
    'stored audio with no deletion date is refused',
    await refused(() => prisma.callSession.create({
      data: { ...base, recordingState: 'STORED', storageKey: 'audio/x.mp3' },
    })),
  );

  check(
    'a negative duration is refused',
    await refused(() => prisma.callSession.create({
      data: { ...base, durationSec: -1 },
    })),
  );

  // And the shapes that are legitimate are accepted.
  const clean = await prisma.callSession.create({
    data: { ...base, recordingState: 'NOT_ATTEMPTED', captureMode: 'NONE' },
  });
  check('a call with no audio at all is a perfectly ordinary row', clean.id.length > 0);
  await prisma.callSession.delete({ where: { id: clean.id } });

  // -----------------------------------------------------------------------
  console.log('\n--- consent decides what is even attempted -----------------------');

  // The prospect's company is used for their jurisdiction. Move it somewhere
  // one-party so the permitted path can be exercised.
  await prisma.company.update({ where: { id: route.company.id }, data: { stateCode: 'TX' } });

  const blocked = await startSession({
    orgId, routeId: route.id, callerId: ownerId,
    intendedCapture: 'PROVIDER_RECORDING',
    // Illinois is all-party. Nobody has consented.
    callerState: 'IL',
  });
  check('a session opens even when recording is not allowed', blocked !== null);
  check('and records that the caller\'s own jurisdiction blocked it',
    blocked?.session.recordingState === 'BLOCKED_BY_JURISDICTION',
    blocked?.session.recordingState);
  check('with no capture mode set', blocked?.session.captureMode === 'NONE');
  check('and the reason kept in words', Boolean(blocked?.session.consentBasis), blocked?.session.consentBasis ?? '');
  check('the caller is told not to record', blocked?.mayRecord === false);

  const unknown = await startSession({
    orgId, routeId: route.id, callerId: ownerId, intendedCapture: 'PROVIDER_RECORDING',
    callerState: null,
  });
  check('an unknown caller jurisdiction refuses rather than assuming',
    unknown?.session.consentState === 'UNKNOWN' && unknown?.mayRecord === false);

  const allowed = await startSession({
    orgId, routeId: route.id, callerId: ownerId, intendedCapture: 'PROVIDER_RECORDING',
    callerState: 'TX',
  });
  check('one-party on both sides permits capture', allowed?.mayRecord === true);
  check('and the announcement is still handed to the caller',
    Boolean(allowed?.announcement), allowed?.announcement?.slice(0, 40) ?? 'none');
  check('the session starts in CAPTURING', allowed?.session.recordingState === 'CAPTURING');

  // -----------------------------------------------------------------------
  console.log('\n--- finishing, both ways -----------------------------------------');

  const failed = await finishSession({
    orgId, sessionId: allowed!.session.id, durationSec: 240,
    failure: 'The provider returned a 500 when the recording was requested.',
  });
  check('a capture failure is recorded as one', failed?.recordingState === 'FAILED');
  check('with no storage key', failed?.storageKey === null);
  check('and the reason kept', Boolean(failed?.failureReason));
  check('and no transcription is queued for audio that does not exist',
    failed?.transcriptState === 'NO_AUDIO', failed?.transcriptState);

  const silent = await startSession({
    orgId, routeId: route.id, callerId: ownerId, intendedCapture: 'PROVIDER_RECORDING', callerState: 'TX',
  });
  const abandoned = await finishSession({ orgId, sessionId: silent!.session.id, durationSec: 12 });
  check('capture that started and produced nothing is a failure, not "not attempted"',
    abandoned?.recordingState === 'FAILED' && (abandoned?.failureReason ?? '').includes('no audio arrived'),
    abandoned?.recordingState);

  const stored = await startSession({
    orgId, routeId: route.id, callerId: ownerId, intendedCapture: 'PROVIDER_RECORDING', callerState: 'TX',
  });
  const done = await finishSession({
    orgId, sessionId: stored!.session.id, durationSec: 300,
    stored: { storageKey: 'audit/recording.mp3', mimeType: 'audio/mpeg', sizeBytes: 1024, retentionDays: 30 },
  });
  check('stored audio is stored', done?.recordingState === 'STORED' && done?.storageKey !== null);
  check('with a deletion date set at the time', done?.retentionUntil !== null);
  check('and transcription queued', done?.transcriptState === 'QUEUED');

  // -----------------------------------------------------------------------
  console.log('\n--- a refusal partway through -------------------------------------');

  const midCall = await startSession({
    orgId, routeId: route.id, callerId: ownerId, intendedCapture: 'PROVIDER_RECORDING', callerState: 'TX',
  });
  await refuseRecording({ orgId, sessionId: midCall!.session.id, note: 'They asked me to stop recording.' });
  const refusedRow = await prisma.callSession.findUniqueOrThrow({ where: { id: midCall!.session.id } });
  check('a mid-call refusal stops capture', refusedRow.recordingState === 'CONSENT_REFUSED');
  check('and records their words as the basis',
    (refusedRow.consentBasis ?? '').includes('asked me to stop'), refusedRow.consentBasis ?? '');

  // -----------------------------------------------------------------------
  console.log('\n--- transcription and speaker separation --------------------------');

  const transcribed = await transcribeSession({
    orgId, sessionId: done!.id, syntheticText: TRANSCRIPT,
  });
  check('a stored call transcribes', transcribed.ok, transcribed.message ?? '');

  const transcript = await prisma.callTranscript.findUniqueOrThrow({ where: { sessionId: done!.id } });
  check('a provider recording may claim speaker separation', transcript.speakerSeparated === true);

  // The interim mode cannot, and the database is what says so.
  const interim = await startSession({
    orgId, routeId: route.id, callerId: ownerId, intendedCapture: 'INTERIM_ROOM_AUDIO', callerState: 'TX',
  });
  await finishSession({
    orgId, sessionId: interim!.session.id, durationSec: 60,
    stored: { storageKey: 'audit/room.mp3', mimeType: 'audio/mpeg', retentionDays: 30 },
  });
  await transcribeSession({ orgId, sessionId: interim!.session.id, syntheticText: TRANSCRIPT });
  const roomTranscript = await prisma.callTranscript.findUniqueOrThrow({ where: { sessionId: interim!.session.id } });
  check('interim room audio does not claim speaker separation', roomTranscript.speakerSeparated === false);

  check(
    'and the database refuses to let it, even written directly',
    await refused(() => prisma.callTranscript.update({
      where: { sessionId: interim!.session.id },
      data: { speakerSeparated: true },
    })),
  );

  const noAudio = await startSession({ orgId, routeId: route.id, callerId: ownerId, callerState: 'TX' });
  await finishSession({ orgId, sessionId: noAudio!.session.id, durationSec: 30 });
  const nothing = await transcribeSession({ orgId, sessionId: noAudio!.session.id });
  check('transcribing a call with no audio refuses rather than producing an empty transcript',
    !nothing.ok && (nothing.message ?? '').includes('nothing to transcribe'));

  // -----------------------------------------------------------------------
  console.log('\n--- analysis, and what it is allowed to decide --------------------');

  const analysis = await analyseSession({ orgId, sessionId: done!.id, callerDisposition: 'QUOTE_REQUESTED' });
  check('the analysis runs', analysis.ok, analysis.message ?? '');
  check('and produces conclusions', analysis.insights > 0, `${analysis.insights}`);

  const insights = await prisma.callInsight.findMany({ where: { sessionId: done!.id } });
  check('every conclusion names who reached it',
    insights.every((i) => i.actor.trim().length > 0),
    insights.map((i) => i.actor)[0] ?? '');

  const promises = insights.filter((i) => i.kind === 'BUYER_PROMISE' || i.kind === 'PROVIDER_PROMISE');
  check('no promise was applied automatically',
    promises.every((i) => i.state === 'NEEDS_REVIEW'),
    promises.map((i) => `${i.kind}:${i.state}`).join(',') || 'none extracted');

  check('nothing without a quote was applied automatically',
    insights.filter((i) => i.state === 'AUTO_APPLIED').every((i) => Boolean(i.evidenceQuote)));

  check(
    'confidence outside 0..1 is refused by the database',
    await refused(() => prisma.callInsight.create({
      data: { orgId, sessionId: done!.id, kind: 'TIMING', value: 'x', confidence: 1.4, actor: 'test' },
    })),
  );

  check(
    'an unattributed conclusion is refused',
    await refused(() => prisma.callInsight.create({
      data: { orgId, sessionId: done!.id, kind: 'TIMING', value: 'x', confidence: 0.5, actor: '   ' },
    })),
  );

  // -----------------------------------------------------------------------
  console.log('\n--- review ---------------------------------------------------------');

  const opened = await openReviewIfNeeded({ orgId, sessionId: done!.id, callerDisposition: 'QUOTE_REQUESTED' });
  check('a review is opened where one is warranted', opened.opened, opened.because);

  const again = await openReviewIfNeeded({ orgId, sessionId: done!.id });
  check('and re-analysing does not stack a second one', !again.opened);

  const stillOpen = await prisma.callInsight.findMany({
    where: { sessionId: done!.id, state: 'NEEDS_REVIEW' },
  });
  const premature = await completeReview({ orgId, sessionId: done!.id, reviewerId: ownerId! });
  check('a review cannot be closed with conclusions still undecided',
    stillOpen.length === 0 || (!premature.ok && (premature.message ?? '').includes('waiting on a decision')),
    premature.message ?? 'nothing was undecided');

  for (const insight of stillOpen) {
    await reviewInsight({
      orgId, insightId: insight.id,
      decision: insight.kind === 'BUYER_PROMISE' ? 'CORRECTED' : 'CONFIRMED',
      correctedValue: insight.kind === 'BUYER_PROMISE' ? 'They asked us to send a price; nothing was promised beyond that.' : undefined,
      reviewerId: ownerId!,
    });
  }

  const corrected = await prisma.callInsight.findFirst({
    where: { sessionId: done!.id, state: 'CORRECTED' },
  });
  if (corrected) {
    check('a correction sits beside the original rather than over it',
      corrected.value !== corrected.correctedValue && corrected.correctedValue !== null,
      `"${corrected.value.slice(0, 40)}" → "${(corrected.correctedValue ?? '').slice(0, 40)}"`);
  } else {
    check('a correction sits beside the original rather than over it', true, 'no promise extracted to correct');
  }

  const closed = await completeReview({ orgId, sessionId: done!.id, reviewerId: ownerId!, notes: 'Checked.' });
  check('the review closes once everything has a decision', closed.ok, closed.message ?? '');

  const review = await prisma.callReview.findUniqueOrThrow({ where: { sessionId: done!.id } });
  check('and counts the corrections rather than taking the reviewer\'s word',
    review.correctionsMade === (corrected ? 1 : 0), `${review.correctionsMade}`);

  // A human judgement must survive the next analysis.
  await analyseSession({ orgId, sessionId: done!.id });
  const survived = await prisma.callInsight.count({
    where: { sessionId: done!.id, state: { in: ['CONFIRMED', 'CORRECTED', 'REJECTED'] } },
  });
  check('a reviewer\'s decisions survive a re-analysis', survived > 0, `${survived} kept`);

  const accuracy = await autoFillAccuracy({ orgId });
  check('auto-fill accuracy refuses a rate below the sample floor',
    accuracy.agreementRate === null && accuracy.verdict.includes('Below'),
    accuracy.verdict.slice(0, 70));

  // -----------------------------------------------------------------------
  console.log('\n--- retention deletes, and the row says so ------------------------');

  const removed: string[] = [];
  await prisma.callSession.update({
    where: { id: done!.id },
    data: { retentionUntil: new Date(Date.now() - 86_400_000) },
  });

  const swept = await expireRecordings({
    orgId,
    remove: async (key) => { removed.push(key); },
  });
  check('the sweep expires what is due', swept.expired >= 1, `${swept.expired} expired, ${swept.failed} failed`);
  check('and asks the storage layer to delete it', removed.includes('audit/recording.mp3'), removed.join(','));

  const expired = await prisma.callSession.findUniqueOrThrow({ where: { id: done!.id } });
  check('the row survives and says the audio expired',
    expired.recordingState === 'RETENTION_EXPIRED' && expired.storageKey === null);
  check('which is a different answer from never having recorded',
    expired.recordingState !== 'NOT_ATTEMPTED');

  // A failure to delete must leave the row claiming the audio is still there.
  const stubborn = await startSession({
    orgId, routeId: route.id, callerId: ownerId, intendedCapture: 'PROVIDER_RECORDING', callerState: 'TX',
  });
  await finishSession({
    orgId, sessionId: stubborn!.session.id, durationSec: 10,
    stored: { storageKey: 'audit/stubborn.mp3', mimeType: 'audio/mpeg', retentionDays: 30 },
  });
  await prisma.callSession.update({
    where: { id: stubborn!.session.id },
    data: { retentionUntil: new Date(Date.now() - 86_400_000) },
  });
  const failedSweep = await expireRecordings({
    orgId,
    remove: async () => { throw new Error('storage unavailable'); },
  });
  const stillStored = await prisma.callSession.findUniqueOrThrow({ where: { id: stubborn!.session.id } });
  check('a failed deletion leaves the row saying the audio is still there',
    failedSweep.failed >= 1 && stillStored.recordingState === 'STORED',
    `${failedSweep.failed} failed, state ${stillStored.recordingState}`);

  const deleted = await deleteRecording({
    orgId, sessionId: stubborn!.session.id, reason: 'They asked us to delete it.',
  });
  check('deletion on request works', deleted.ok, deleted.message ?? '');
  const goneRow = await prisma.callSession.findUniqueOrThrow({ where: { id: stubborn!.session.id } });
  check('and is distinguishable from expiry', goneRow.recordingState === 'DELETED_ON_REQUEST');

  const twice = await deleteRecording({ orgId, sessionId: stubborn!.session.id, reason: 'again' });
  check('deleting audio that is already gone refuses with a reason',
    !twice.ok && (twice.message ?? '').includes('no stored audio'), twice.message ?? '');

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
