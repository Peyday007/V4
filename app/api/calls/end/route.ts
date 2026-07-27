import { z } from 'zod';
import { requirePermission } from '@/lib/auth/session';
import { endCall } from '@/lib/calling';
import { processJobs } from '@/lib/jobs/runner';
import { handleRouteError, json } from '@/lib/api';

export const dynamic = 'force-dynamic';

const schema = z.object({
  callId: z.string().min(1),
  outcome: z.enum(['CONNECTED', 'NO_ANSWER', 'VOICEMAIL', 'GATEKEEPER', 'WRONG_NUMBER', 'CALLBACK_SCHEDULED', 'REFUSED', 'DO_NOT_CALL']),
  notes: z.string().max(5000).optional(),
  transcriptText: z.string().max(100_000).optional(),
  durationSec: z.number().int().positive().max(36_000).optional(),
  /** Process the transcript immediately rather than waiting for a worker. */
  processNow: z.boolean().default(true),
});

export async function POST(request: Request) {
  try {
    const user = await requirePermission('call.place');
    const body = schema.parse(await request.json());

    const result = await endCall({
      orgId: user.orgId,
      callId: body.callId,
      callerId: user.id,
      outcome: body.outcome,
      notes: body.notes,
      transcriptText: body.transcriptText,
      durationSec: body.durationSec,
    });

    let processed = 0;
    if (result.queuedAnalysis && body.processNow) {
      // Transcription enqueues analysis, which enqueues scoring -> matching ->
      // deal configuration -> next action. Drain until the chain settles.
      for (let pass = 0; pass < 8; pass++) {
        const tick = await processJobs(10);
        processed += tick.processed;
        if (tick.processed === 0) break;
      }
    }

    return json({ ok: true, ...result, jobsProcessed: processed });
  } catch (error) {
    return handleRouteError(error);
  }
}
