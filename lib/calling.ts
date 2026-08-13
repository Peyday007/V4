import type { CallOutcome } from '@prisma/client';
import { prisma } from '@/lib/db';
import { audit, recordActivity } from '@/lib/audit';
import { checkContactability, RECORDING_ANNOUNCEMENT } from '@/lib/compliance';
import { getStorage } from '@/lib/providers/storage';
import { getTelephony } from '@/lib/providers/telephony';
import { enqueue } from '@/lib/jobs/queue';
import { recordDecision } from '@/lib/ai/decisions';
import { assertProductionOnly } from '@/lib/safety/outbound';

export type StartCallResult = {
  callId: string;
  providerCallId: string | null;
  recording: boolean;
  recordingBasis: string;
  announcement: string | null;
};

/**
 * Places a call from an assignment.
 *
 * Every path through here passes the compliance gate first. Recording is
 * enabled only when the jurisdiction and the contact's consent both allow it,
 * and the basis for that decision is stored on the call record.
 */
export async function startCall(params: {
  orgId: string;
  assignmentId: string;
  callerId: string;
  overrideNumber?: string;
}): Promise<StartCallResult> {
  const assignment = await prisma.callAssignment.findFirstOrThrow({
    where: { id: params.assignmentId, orgId: params.orgId },
    include: { contact: true, company: { include: { locations: true } } },
  });

  if (assignment.assignedToId && assignment.assignedToId !== params.callerId) {
    throw new Error('This call is assigned to another caller');
  }
  if (assignment.attemptCount >= assignment.maxAttempts) {
    throw new Error(`Attempt limit reached (${assignment.maxAttempts}). Stop calling this contact.`);
  }

  // The dialler is the loudest external action in the product, and this is the
  // first question asked about it — ahead of the compliance gate, deliberately.
  // When the guard sat after that gate, a sandbox record outside calling hours
  // was refused for the hour rather than for being practice, so the boundary
  // was only ever exercised between 8am and 8pm. A rule that holds during
  // office hours is not a rule.
  await assertProductionOnly(
    { companyId: assignment.companyId, contactId: assignment.contactId },
    'placing a call',
  );

  const state = assignment.company.locations.find((l) => l.isHeadquarters)?.state ?? assignment.company.locations[0]?.state ?? null;
  const compliance = await checkContactability({
    orgId: params.orgId,
    contactId: assignment.contactId,
    phone: params.overrideNumber ?? assignment.contact?.phone ?? assignment.company.phone,
    state,
  });

  if (!compliance.allowed) {
    await prisma.callAssignment.update({
      where: { id: assignment.id },
      data: { status: compliance.reasons.some((r) => r.startsWith('Outside')) ? 'RESCHEDULED' : 'BLOCKED_BY_COMPLIANCE' },
    });
    await audit({
      orgId: params.orgId,
      userId: params.callerId,
      action: 'call.blocked',
      entityType: 'CallAssignment',
      entityId: assignment.id,
      metadata: { reasons: compliance.reasons },
    });
    throw new Error(`Call blocked: ${compliance.reasons.join('; ')}`);
  }

  const toNumber = params.overrideNumber ?? assignment.contact?.phone ?? assignment.contact?.mobile ?? assignment.company.phone;
  if (!toNumber) throw new Error('No phone number available for this assignment');

  const telephony = getTelephony();
  let providerCallId: string | null = null;
  let fromNumber: string | null = null;

  try {
    const placed = await telephony.placeCall({
      to: toNumber,
      record: compliance.recordingAllowed,
      announcement: compliance.requiresAnnouncement ? RECORDING_ANNOUNCEMENT : undefined,
      metadata: { assignmentId: assignment.id, orgId: params.orgId },
    });
    providerCallId = placed.providerCallId;
    fromNumber = placed.from;
  } catch (error) {
    // A carrier failure must not lose the attempt — log it and let the caller
    // dial manually, then record the outcome.
    console.error('[calling] provider placeCall failed:', String(error));
  }

  const call = await prisma.call.create({
    data: {
      orgId: params.orgId,
      assignmentId: assignment.id,
      contactId: assignment.contactId,
      callerId: params.callerId,
      direction: 'OUTBOUND',
      providerCallId,
      fromNumber,
      toNumber,
      recordingConsent: compliance.recordingAllowed,
      consentBasis: compliance.recordingBasis,
    },
  });

  await prisma.callAssignment.update({
    where: { id: assignment.id },
    data: { status: 'IN_PROGRESS', attemptCount: { increment: 1 } },
  });

  await audit({
    orgId: params.orgId,
    userId: params.callerId,
    action: 'call.started',
    entityType: 'Call',
    entityId: call.id,
    metadata: { assignmentId: assignment.id, recording: compliance.recordingAllowed, basis: compliance.recordingBasis },
  });

  return {
    callId: call.id,
    providerCallId,
    recording: compliance.recordingAllowed,
    recordingBasis: compliance.recordingBasis,
    announcement: compliance.requiresAnnouncement ? RECORDING_ANNOUNCEMENT : null,
  };
}

/**
 * Ends a call and hands off to the analysis pipeline.
 *
 * `transcriptText` lets a caller log a conversation that happened outside the
 * dialer, or a demo run without audio — either way the same extraction path
 * runs, so records update without manual data entry.
 */
export async function endCall(params: {
  orgId: string;
  callId: string;
  callerId: string;
  outcome: CallOutcome;
  notes?: string;
  transcriptText?: string;
  durationSec?: number;
}): Promise<{ callId: string; queuedAnalysis: boolean }> {
  const call = await prisma.call.findFirstOrThrow({
    where: { id: params.callId, orgId: params.orgId },
    include: { assignment: true },
  });

  const endedAt = new Date();
  const durationSec = params.durationSec ?? Math.max(1, Math.round((endedAt.getTime() - call.startedAt.getTime()) / 1000));

  await prisma.call.update({
    where: { id: call.id },
    data: { outcome: params.outcome, endedAt, durationSec, notes: params.notes ?? null },
  });

  // Store the recording reference when the provider produced one.
  if (call.recordingConsent && call.providerCallId) {
    const storage = getStorage();
    const storageKey = `recordings/${params.orgId}/${call.id}.mp3`;
    const existing = await prisma.callRecording.findUnique({ where: { callId: call.id } });
    if (!existing) {
      // The mock provider has no audio; the record still captures the consent
      // trail and the storage key the real provider would write to.
      await prisma.callRecording.create({
        data: {
          callId: call.id,
          storageKey,
          provider: getTelephony().name,
          durationSec,
          announcementPlayed: true,
          retentionUntil: new Date(Date.now() + 365 * 86_400_000),
        },
      });
      void storage;
    }
  }

  let queuedAnalysis = false;
  if (params.outcome === 'CONNECTED' && params.transcriptText) {
    await enqueue({
      orgId: params.orgId,
      kind: 'transcription.process',
      payload: { callId: call.id, syntheticText: params.transcriptText },
      priority: 20,
      idempotencyKey: `transcribe:${call.id}`,
    });
    queuedAnalysis = true;
  }

  if (call.assignmentId) {
    const nextStatus =
      params.outcome === 'CONNECTED'
        ? 'COMPLETED'
        : params.outcome === 'NO_ANSWER' || params.outcome === 'GATEKEEPER'
          ? 'RESCHEDULED'
          : params.outcome === 'VOICEMAIL'
            ? 'VOICEMAIL'
            : params.outcome === 'DO_NOT_CALL' || params.outcome === 'REFUSED'
              ? 'CANCELLED'
              : 'COMPLETED';

    await prisma.callAssignment.update({
      where: { id: call.assignmentId },
      data: {
        status: nextStatus,
        completedAt: params.outcome === 'CONNECTED' ? endedAt : null,
        scheduledFor:
          nextStatus === 'RESCHEDULED' ? new Date(Date.now() + 24 * 3_600_000) : call.assignment?.scheduledFor ?? null,
      },
    });

    // Attempt limit reached without contact — stop rather than keep dialling.
    const assignment = await prisma.callAssignment.findUnique({ where: { id: call.assignmentId } });
    if (assignment && assignment.attemptCount >= assignment.maxAttempts && nextStatus === 'RESCHEDULED') {
      await prisma.callAssignment.update({ where: { id: assignment.id }, data: { status: 'CANCELLED' } });
      await recordDecision({
        orgId: params.orgId,
        opportunityId: assignment.opportunityId,
        process: 'calling',
        decision: 'Stopped calling this contact',
        reason: `${assignment.attemptCount} attempts made against a limit of ${assignment.maxAttempts} with no contact. Further dialling is wasted effort and a nuisance to the recipient.`,
        confidence: 0.9,
        rulesApplied: ['max_attempts_per_contact'],
        modelName: 'deterministic',
        promptVersion: 'calling@1',
      });
    }
  }

  await recordActivity({
    orgId: params.orgId,
    opportunityId: call.assignment?.opportunityId ?? null,
    companyId: call.assignment?.companyId ?? null,
    contactId: call.contactId,
    userId: params.callerId,
    actorType: 'user',
    verb: 'call.completed',
    summary: `Call ended: ${params.outcome.toLowerCase().replace(/_/g, ' ')} (${durationSec}s)`,
    payload: { callId: call.id, outcome: params.outcome },
  });

  await audit({
    orgId: params.orgId,
    userId: params.callerId,
    action: 'call.ended',
    entityType: 'Call',
    entityId: call.id,
    metadata: { outcome: params.outcome, durationSec },
  });

  return { callId: call.id, queuedAnalysis };
}
