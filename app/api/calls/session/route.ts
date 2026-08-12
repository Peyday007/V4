import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requirePermission, requireUser } from '@/lib/auth/session';
import { handleRouteError, json, rateLimit } from '@/lib/api';
import { startSession, finishSession, refuseRecording, deleteRecording } from '@/lib/calls/recording';
import { enqueue } from '@/lib/jobs/queue';
import { audit } from '@/lib/audit';
import { capabilityGate } from '@/lib/manager/gate';

export const dynamic = 'force-dynamic';

/**
 * The lifecycle of one call, from the caller's side.
 *
 * `call.place` rather than a deal permission: this is the act of making a call,
 * and callers have it. What they do not have is the ability to delete a
 * recording, which sits behind `admin.config` — a caller who can erase the
 * audio of their own call can erase the evidence of it.
 *
 * The `stored` field on finish is the one that matters. It is the only route by
 * which a storage key reaches the database, and it is named for what it means,
 * so nothing can pass a key while reporting a failure.
 */
const Start = z.object({
  action: z.literal('start'),
  routeId: z.string().min(1),
  contactId: z.string().optional(),
  provider: z.string().max(40).optional(),
  providerCallId: z.string().max(200).optional(),
  intendedCapture: z.enum(['PROVIDER_RECORDING', 'INTERIM_ROOM_AUDIO', 'NONE']).optional(),
  /** Where the caller is sitting. Recording law follows both parties. */
  callerState: z.string().length(2).optional(),
});

const Finish = z.object({
  action: z.literal('finish'),
  sessionId: z.string().min(1),
  durationSec: z.number().int().min(0).max(86_400).optional(),
  providerStatus: z.string().max(80).optional(),
  attemptId: z.string().optional(),
  /** Present only when audio genuinely reached storage. */
  stored: z.object({
    storageKey: z.string().min(1).max(500),
    mimeType: z.string().min(1).max(80),
    sizeBytes: z.number().int().min(0).optional(),
    retentionDays: z.number().int().min(1).max(3650).optional(),
  }).optional(),
  /** Present when capture was attempted and did not work. */
  failure: z.string().max(1000).optional(),
  /** Manually logged notes, transcribed as-is when there is no audio. */
  notes: z.string().max(20_000).optional(),
});

const Refuse = z.object({
  action: z.literal('refuse_recording'),
  sessionId: z.string().min(1),
  note: z.string().max(500).optional(),
});

const Delete = z.object({
  action: z.literal('delete_recording'),
  sessionId: z.string().min(1),
  reason: z.string().min(1).max(1000),
});

const Schema = z.discriminatedUnion('action', [Start, Finish, Refuse, Delete]);

export async function POST(request: Request) {
  try {
    await requireUser();
    const body = Schema.parse(await request.json());

    // Erasing audio is not part of making a call.
    const user = body.action === 'delete_recording'
      ? await requirePermission('admin.config')
      : await requirePermission('call.place');
    await rateLimit(`calls.session:${user.id}`, 240, 60_000);

    if (body.action === 'start') {
      // Checked at the start of the call, not at the end of it. A caller who is
      // told after the conversation that their account was paused has already
      // made the call, and the record of it is now in an awkward half-state.
      //
      // Only starting is gated: finishing a call that is already under way
      // always goes through, because losing what somebody typed to enforce a
      // restriction would punish the buyer as well as the caller.
      const gate = await capabilityGate({
        orgId: user.orgId, userId: user.id, capability: 'CALL_PLACING',
      });
      if (!gate.allowed) {
        return json({ error: gate.message, kind: gate.kind, restorationRule: gate.restorationRule }, 423);
      }

      // Recording is a separate capability, and losing it must not cost
      // somebody the call. The session opens either way, with capture off.
      let intendedCapture = body.intendedCapture;
      let captureRefusal: string | null = null;
      if (intendedCapture && intendedCapture !== 'NONE') {
        const recording = await capabilityGate({
          orgId: user.orgId, userId: user.id, capability: 'CALL_RECORDING',
        });
        if (!recording.allowed) {
          intendedCapture = 'NONE';
          captureRefusal = recording.message;
        }
      }

      const result = await startSession({
        orgId: user.orgId,
        routeId: body.routeId,
        callerId: user.id,
        contactId: body.contactId,
        provider: body.provider,
        providerCallId: body.providerCallId,
        intendedCapture,
        callerState: body.callerState,
      });
      if (!result) return json({ error: 'That route is not on this account.' }, 404);

      await audit({
        orgId: user.orgId, userId: user.id, action: 'call.session_started',
        entityType: 'CallSession', entityId: result.session.id,
        metadata: { consent: result.consent.state, mayRecord: result.mayRecord },
      });

      return json({
        ok: true,
        sessionId: result.session.id,
        mayRecord: result.mayRecord,
        // Present when capture was turned off by a restriction or an outage
        // rather than by the consent rules. Different reason, different words.
        captureRefusal,
        // Returned so the caller reads the right words rather than improvising.
        announcement: result.announcement,
        consent: {
          state: result.consent.state,
          basis: result.consent.basis,
          callerJurisdiction: result.consent.callerJurisdiction,
          prospectJurisdiction: result.consent.prospectJurisdiction,
        },
      });
    }

    if (body.action === 'refuse_recording') {
      await refuseRecording({ orgId: user.orgId, sessionId: body.sessionId, note: body.note });
      await audit({
        orgId: user.orgId, userId: user.id, action: 'call.recording_refused',
        entityType: 'CallSession', entityId: body.sessionId,
      });
      return json({ ok: true });
    }

    if (body.action === 'delete_recording') {
      const result = await deleteRecording({
        orgId: user.orgId, sessionId: body.sessionId, reason: body.reason,
      });
      if (!result.ok) return json({ error: result.message }, 409);
      await audit({
        orgId: user.orgId, userId: user.id, action: 'call.recording_deleted',
        entityType: 'CallSession', entityId: body.sessionId, metadata: { reason: body.reason },
      });
      return json({ ok: true });
    }

    const session = await finishSession({
      orgId: user.orgId,
      sessionId: body.sessionId,
      durationSec: body.durationSec,
      providerStatus: body.providerStatus,
      stored: body.stored ?? null,
      failure: body.failure ?? null,
      attemptId: body.attemptId,
    });
    if (!session) return json({ error: 'That call is not on this account.' }, 404);

    // Transcription is queued only when there is something to work from —
    // stored audio, or notes the caller typed. Queuing it otherwise fills the
    // queue with work that can only fail.
    let queued = false;
    if (session.transcriptState === 'QUEUED') {
      queued = Boolean(await enqueue({
        orgId: user.orgId,
        kind: 'call.transcribe',
        payload: { sessionId: session.id },
        priority: 55,
        idempotencyKey: `call.transcribe:${session.id}`,
        skipIfCompleted: true,
      }));
    } else if (body.notes?.trim()) {
      await prisma.callSession.update({
        where: { id: session.id },
        data: { transcriptState: 'QUEUED' },
      });
      queued = Boolean(await enqueue({
        orgId: user.orgId,
        kind: 'call.transcribe',
        payload: { sessionId: session.id, syntheticText: body.notes },
        priority: 55,
        idempotencyKey: `call.transcribe:${session.id}`,
        skipIfCompleted: true,
      }));
    }

    return json({
      ok: true,
      sessionId: session.id,
      recordingState: session.recordingState,
      transcriptState: session.transcriptState,
      transcriptionQueued: queued,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
