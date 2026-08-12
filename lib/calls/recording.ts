import type { CallSession, CaptureMode, Prisma, RecordingState } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getOrgConfig } from '@/lib/config';
import { RECORDING_ANNOUNCEMENT } from '@/lib/compliance';
import { recordingConsent, type ConsentDecision } from './consent';

/**
 * The record of a call, whether or not anything was captured.
 *
 * The session is written for every call — including the overwhelming majority
 * dialled from a caller's own handset with no audio at all — because the
 * directive is explicit that manual calling must not be blocked while proper
 * telephony is absent, and because a call that produced no recording is still a
 * call somebody should be able to look up.
 *
 * What this file will not do, ever, is write a storage key onto a session whose
 * audio was not stored. The database refuses it in both directions, and every
 * function here is arranged so the refusal never has to fire: audio is stored
 * first, and only then does the row learn where it is.
 */

/** How long stored audio is kept unless somebody sets otherwise. */
const DEFAULT_RETENTION_DAYS = 180;

export type StartInput = {
  orgId: string;
  routeId: string;
  callerId?: string | null;
  contactId?: string | null;
  provider?: string;
  providerCallId?: string | null;
  /** What the operator is attempting. Ambition, not outcome. */
  intendedCapture?: CaptureMode;
  /** Where the caller is. Recording law follows both parties, not the company. */
  callerState?: string | null;
  now?: Date;
};

export type StartResult = {
  session: CallSession;
  consent: ConsentDecision;
  /** Read out before recording starts, when one is needed. */
  announcement: string | null;
  /** True when audio may be captured on this call. */
  mayRecord: boolean;
};

/**
 * Open a session at the start of a call.
 *
 * The consent decision is made here and stored on the row in the words that
 * were true at the time, so a later change to the org's policy does not rewrite
 * what we believed when we recorded somebody.
 */
export async function startSession(input: StartInput): Promise<StartResult | null> {
  const now = input.now ?? new Date();

  const route = await prisma.routeHypothesis.findFirst({
    where: { id: input.routeId, orgId: input.orgId },
    select: {
      id: true,
      company: { select: { stateCode: true } },
      event: { select: { stateCode: true } },
    },
  });
  if (!route) return null;

  const contact = input.contactId
    ? await prisma.contact.findFirst({
        where: { id: input.contactId, orgId: input.orgId },
        select: { consentToRecord: true },
      })
    : null;

  const config = await getOrgConfig(input.orgId);
  const consent = recordingConsent({
    config,
    callerState: input.callerState,
    prospectState: route.company.stateCode ?? route.event.stateCode,
    contactConsent: contact?.consentToRecord,
  });

  // Ambition meets the law. An intended capture mode the consent decision does
  // not permit becomes NONE here rather than being attempted and failing later.
  const intended = input.intendedCapture ?? 'NONE';
  const captureMode: CaptureMode = consent.allowed ? intended : 'NONE';
  const recordingState: RecordingState = recordingStateFor(consent, intended);

  const session = await prisma.callSession.create({
    data: {
      orgId: input.orgId,
      routeId: route.id,
      callerId: input.callerId ?? null,
      contactId: input.contactId ?? null,
      provider: input.provider ?? 'manual',
      providerCallId: input.providerCallId ?? null,
      startedAt: now,
      captureMode,
      recordingState,
      consentState: consent.state,
      consentBasis: consent.basis,
      announcementText: consent.requiresAnnouncement ? RECORDING_ANNOUNCEMENT : null,
      callerJurisdiction: consent.callerJurisdiction,
      prospectJurisdiction: consent.prospectJurisdiction,
      // No transcript is attempted until there is audio to work from. Left as
      // NOT_ATTEMPTED rather than QUEUED, so the queue never contains work that
      // can only fail.
      transcriptState: 'NOT_ATTEMPTED',
    },
  });

  return {
    session,
    consent,
    announcement: consent.requiresAnnouncement ? RECORDING_ANNOUNCEMENT : null,
    mayRecord: consent.allowed && intended !== 'NONE',
  };
}

/** The starting state, given what was wanted and what is permitted. */
function recordingStateFor(consent: ConsentDecision, intended: CaptureMode): RecordingState {
  if (intended === 'NONE') return 'NOT_ATTEMPTED';
  if (consent.state === 'REFUSED') return 'CONSENT_REFUSED';
  if (!consent.allowed) return 'BLOCKED_BY_JURISDICTION';
  return 'CAPTURING';
}

/**
 * The prospect objected partway through.
 *
 * Stops the capture and marks why. Audio already stored is left alone here and
 * deleted by `deleteRecording` if somebody asks — conflating "stop recording"
 * with "destroy what exists" would make an operator hesitate to press it.
 */
export async function refuseRecording(options: {
  orgId: string;
  sessionId: string;
  note?: string;
}): Promise<void> {
  await prisma.callSession.updateMany({
    where: { id: options.sessionId, orgId: options.orgId, recordingState: { in: ['CAPTURING', 'NOT_ATTEMPTED'] } },
    data: {
      recordingState: 'CONSENT_REFUSED',
      consentState: 'REFUSED',
      consentBasis: options.note?.trim()
        || 'They asked partway through the call not to be recorded, and capture stopped.',
      captureMode: 'NONE',
    },
  });
}

export type FinishInput = {
  orgId: string;
  sessionId: string;
  endedAt?: Date;
  durationSec?: number | null;
  providerStatus?: string | null;
  /** Present only when audio genuinely reached storage. */
  stored?: {
    storageKey: string;
    mimeType: string;
    sizeBytes?: number | null;
    retentionDays?: number;
  } | null;
  /** Present when capture was attempted and did not work. */
  failure?: string | null;
  attemptId?: string | null;
  now?: Date;
};

/**
 * Close a session.
 *
 * The shape of the input is the safeguard: `stored` and `failure` are separate
 * fields, and a storage key can only arrive through the one whose name says the
 * audio exists. There is no path here that writes a key from a hopeful default.
 */
export async function finishSession(input: FinishInput): Promise<CallSession | null> {
  const now = input.now ?? new Date();

  const session = await prisma.callSession.findFirst({
    where: { id: input.sessionId, orgId: input.orgId },
  });
  if (!session) return null;

  const data: Prisma.CallSessionUpdateInput = {
    endedAt: input.endedAt ?? now,
    durationSec: input.durationSec ?? null,
    providerStatus: input.providerStatus ?? session.providerStatus,
  };

  if (input.attemptId) data.attempt = { connect: { id: input.attemptId } };

  if (input.stored) {
    const retentionDays = input.stored.retentionDays ?? DEFAULT_RETENTION_DAYS;
    data.recordingState = 'STORED';
    data.storageKey = input.stored.storageKey;
    data.mimeType = input.stored.mimeType;
    data.sizeBytes = input.stored.sizeBytes ?? null;
    // Set here rather than by a later sweep, because a recording of a named
    // person with no deletion date is one nobody ever gets round to deleting.
    data.retentionUntil = new Date(now.getTime() + retentionDays * 86_400_000);
    // Only now is there anything to transcribe.
    data.transcriptState = 'QUEUED';
  } else if (input.failure) {
    data.recordingState = 'FAILED';
    data.failureReason = input.failure;
    data.storageKey = null;
    data.transcriptState = 'NO_AUDIO';
  } else if (session.recordingState === 'CAPTURING') {
    // Capture was under way and produced nothing. That is a failure, and
    // saying so is better than a row that quietly reads "not attempted".
    data.recordingState = 'FAILED';
    data.failureReason = 'Capture was started and no audio arrived. The call itself is recorded; the audio is not.';
    data.transcriptState = 'NO_AUDIO';
  } else {
    data.transcriptState = 'NO_AUDIO';
  }

  return prisma.callSession.update({ where: { id: session.id }, data });
}

/**
 * Whether a transcript may claim to know who was speaking.
 *
 * Only a provider recording separates the channels. Interim room audio is one
 * microphone picking up a speakerphone, and any speaker labelling derived from
 * it is a guess that will end up attributed to a named buyer in a deal record.
 */
export function canSeparateSpeakers(captureMode: CaptureMode): boolean {
  return captureMode === 'PROVIDER_RECORDING';
}

/** What the operator is told about the quality of what was captured. */
export function captureCaveat(captureMode: CaptureMode): string | null {
  switch (captureMode) {
    case 'PROVIDER_RECORDING':
      return null;
    case 'INTERIM_ROOM_AUDIO':
      return 'Interim capture: a microphone next to a speakerphone. One mixed channel, so who said what is inferred rather than known. Not evidence of a specific person\'s words.';
    default:
      return 'No audio was captured on this call.';
  }
}

/**
 * Delete audio whose retention has run out.
 *
 * The row survives and says the audio expired, because "we deleted it on
 * schedule" and "it was never recorded" are different answers to the same
 * question and only one of them is a problem.
 */
export async function expireRecordings(options: {
  orgId: string;
  now?: Date;
  /** Injected so the sweep can be run without a storage backend in tests. */
  remove?: (storageKey: string) => Promise<void>;
}): Promise<{ expired: number; failed: number }> {
  const now = options.now ?? new Date();

  const due = await prisma.callSession.findMany({
    where: {
      orgId: options.orgId,
      recordingState: 'STORED',
      retentionUntil: { not: null, lte: now },
    },
    select: { id: true, storageKey: true },
  });

  let expired = 0;
  let failed = 0;

  for (const session of due) {
    try {
      if (options.remove && session.storageKey) await options.remove(session.storageKey);
      await prisma.callSession.update({
        where: { id: session.id },
        // Key cleared in the same statement as the state, because the check
        // constraint ties them together and would reject either alone.
        data: { recordingState: 'RETENTION_EXPIRED', storageKey: null },
      });
      expired += 1;
    } catch (error) {
      // The audio is still there. Leaving the row as STORED is correct: a row
      // claiming the file is gone while it sits in a bucket is worse than a
      // sweep that has to run again.
      console.error(`[recording] could not expire ${session.id}:`, String(error));
      failed += 1;
    }
  }

  return { expired, failed };
}

/** Delete on request, before retention. Same shape, different reason. */
export async function deleteRecording(options: {
  orgId: string;
  sessionId: string;
  reason: string;
  remove?: (storageKey: string) => Promise<void>;
}): Promise<{ ok: boolean; message?: string }> {
  const session = await prisma.callSession.findFirst({
    where: { id: options.sessionId, orgId: options.orgId },
  });
  if (!session) return { ok: false, message: 'That call is not on this account.' };
  if (session.recordingState !== 'STORED') {
    return { ok: false, message: `There is no stored audio on this call — it is ${session.recordingState.toLowerCase().replace(/_/g, ' ')}.` };
  }

  if (options.remove && session.storageKey) await options.remove(session.storageKey);

  await prisma.callSession.update({
    where: { id: session.id },
    data: {
      recordingState: 'DELETED_ON_REQUEST',
      storageKey: null,
      failureReason: null,
      consentBasis: `${session.consentBasis ?? ''} Audio deleted on request: ${options.reason}`.trim(),
    },
  });

  return { ok: true };
}
