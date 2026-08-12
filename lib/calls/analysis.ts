import { z } from 'zod';
import type { CallDisposition, InsightKind, InsightState } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getLLM } from '@/lib/providers/llm';
import { getTranscription } from '@/lib/providers/transcription';
import { canSeparateSpeakers } from './recording';

/**
 * What the call established, extracted with its evidence attached.
 *
 * Two rules govern everything here, and they pull in opposite directions on
 * purpose.
 *
 * The first is practical: reviewing hundreds of calls by hand is not a plan, so
 * confident, routine classifications are applied without waiting for anybody.
 *
 * The second is the limit on that: an insight without a quote from the
 * transcript is an assertion rather than evidence, low-confidence conclusions
 * go to a person, and there is a category of conclusion the AI never gets the
 * last word on however confident it is — fraud, employment, pay, permanent
 * access, legal compliance, and anything that binds us commercially. Those are
 * decisions with consequences a correction cannot undo, and confidence is not
 * the relevant question about them.
 */

/** Above this, a routine classification is applied without waiting. */
export const AUTO_APPLY_THRESHOLD = 0.85;

/**
 * Conclusions the AI never finalises, whatever the confidence.
 *
 * Not because the model is bad at them. Because being wrong about them costs
 * somebody their job, their pay, or a contract we have to honour, and a
 * correction three days later does not put that back.
 */
export const NEVER_AUTO_APPLIED: InsightKind[] = [
  // A promise made to a buyer is a commercial commitment.
  'BUYER_PROMISE',
  // A promise made by a provider is one we will repeat to a buyer.
  'PROVIDER_PROMISE',
  // Script observations feed caller performance, which feeds pay and standing.
  'SCRIPT_OBSERVATION',
];

/** The reason each of those is held, in words, for whoever opens the review. */
export const HIGH_IMPACT_REASON: Partial<Record<InsightKind, string>> = {
  BUYER_PROMISE: 'A promise to a buyer is a commercial commitment. A person confirms what we actually said.',
  PROVIDER_PROMISE: 'We will repeat this to a buyer as though it were secured. A person confirms it first.',
  SCRIPT_OBSERVATION: 'Observations about a caller feed performance and standing. A machine does not get the last word on that.',
};

export type ExtractedInsight = {
  kind: InsightKind;
  value: string;
  confidence: number;
  evidenceQuote: string | null;
  evidenceStartSec: number | null;
};

const InsightSchema = z.object({
  insights: z.array(z.object({
    kind: z.enum([
      'PERSON_REACHED', 'CONFIRMED_NEED', 'SCOPE', 'TIMING', 'PROCESS', 'OBJECTION',
      'INCUMBENT', 'BUYER_PROMISE', 'PROVIDER_PROMISE', 'NEXT_ACTION',
      'QUALIFICATION_FIELD', 'ROUTE_FIT', 'SCRIPT_OBSERVATION', 'DISPOSITION_SUGGESTION',
    ]),
    value: z.string().min(1).max(600),
    confidence: z.number().min(0).max(1),
    evidenceQuote: z.string().max(600).nullable(),
    evidenceStartSec: z.number().int().min(0).nullable(),
  })).max(40),
});

/**
 * Decide what happens to one extracted conclusion.
 *
 * Pure, so the policy can be read and tested without a model or a database —
 * which matters more here than anywhere else in the codebase, because this is
 * the function that decides when a machine's opinion becomes a record.
 */
export function gateInsight(insight: ExtractedInsight): {
  state: InsightState;
  reviewReason: string | null;
} {
  if (NEVER_AUTO_APPLIED.includes(insight.kind)) {
    return {
      state: 'NEEDS_REVIEW',
      reviewReason: HIGH_IMPACT_REASON[insight.kind]
        ?? 'This kind of conclusion is not one the analysis finalises on its own.',
    };
  }

  // No quote, no evidence. A conclusion nobody can check against the words
  // that produced it is exactly the thing this system does not store as fact.
  if (!insight.evidenceQuote || insight.evidenceQuote.trim().length === 0) {
    return {
      state: 'NEEDS_REVIEW',
      reviewReason: 'No quote from the transcript backs this, so there is nothing to check it against.',
    };
  }

  if (insight.confidence < AUTO_APPLY_THRESHOLD) {
    return {
      state: 'NEEDS_REVIEW',
      reviewReason: `Confidence ${(insight.confidence * 100).toFixed(0)}% is below the ${(AUTO_APPLY_THRESHOLD * 100).toFixed(0)}% needed to apply something without a person seeing it.`,
    };
  }

  return { state: 'AUTO_APPLIED', reviewReason: null };
}

// ---------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------

/**
 * Turn stored audio into a transcript, or record why there is none.
 *
 * Refuses to run on a session with no audio rather than producing an empty
 * transcript that later reads as "the call had nothing in it".
 */
export async function transcribeSession(options: {
  orgId: string;
  sessionId: string;
  /** For manually logged calls: the caller's own notes, transcribed as-is. */
  syntheticText?: string;
}): Promise<{ ok: boolean; message?: string }> {
  const session = await prisma.callSession.findFirst({
    where: { id: options.sessionId, orgId: options.orgId },
  });
  if (!session) return { ok: false, message: 'That call is not on this account.' };

  const hasAudio = session.recordingState === 'STORED' && session.storageKey !== null;
  if (!hasAudio && !options.syntheticText) {
    await prisma.callSession.update({
      where: { id: session.id },
      data: { transcriptState: 'NO_AUDIO' },
    });
    return { ok: false, message: 'There is no audio on this call, so there is nothing to transcribe.' };
  }

  await prisma.callSession.update({ where: { id: session.id }, data: { transcriptState: 'PROCESSING' } });

  try {
    const result = await getTranscription().transcribe({
      audioRef: session.storageKey ?? `manual:${session.id}`,
      syntheticText: options.syntheticText,
    });

    const text = result.text?.trim() ?? '';
    if (text.length === 0) {
      await failTranscript(options.orgId, session.id, 'The transcription provider returned nothing.');
      return { ok: false, message: 'The transcription came back empty.' };
    }

    await prisma.$transaction(async (tx) => {
      await tx.callTranscript.upsert({
        where: { sessionId: session.id },
        create: {
          orgId: options.orgId,
          sessionId: session.id,
          state: 'READY',
          provider: result.provider,
          language: result.language,
          text,
          segments: result.segments as never,
          // Read from the capture mode, never from the provider's claim. A
          // single mixed channel cannot be separated, and a database trigger
          // refuses this row if it says otherwise.
          speakerSeparated: canSeparateSpeakers(session.captureMode),
          processedAt: new Date(),
        },
        update: {
          state: 'READY',
          provider: result.provider,
          text,
          segments: result.segments as never,
          speakerSeparated: canSeparateSpeakers(session.captureMode),
          failureReason: null,
          processedAt: new Date(),
        },
      });
      await tx.callSession.update({ where: { id: session.id }, data: { transcriptState: 'READY' } });
    });

    return { ok: true };
  } catch (error) {
    await failTranscript(options.orgId, session.id, String(error).slice(0, 1000));
    return { ok: false, message: 'Transcription failed. The call record still exists and says so.' };
  }
}

async function failTranscript(orgId: string, sessionId: string, reason: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.callTranscript.upsert({
      where: { sessionId },
      create: { orgId, sessionId, state: 'FAILED', failureReason: reason },
      update: { state: 'FAILED', failureReason: reason },
    });
    await tx.callSession.update({ where: { id: sessionId }, data: { transcriptState: 'FAILED' } });
  });
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

const SYSTEM = `You extract facts from a sales call transcript for a commercial brokerage.

Rules you must follow:
- Every insight must quote the transcript. If you cannot quote it, do not report it.
- Report what was said, not what it implies. "They mentioned budget season" is a fact; "they have budget" is not.
- Confidence is how certain you are that the transcript says this, not how promising it is.
- Never invent a name, a number, a date or a commitment that is not in the words.
- If the transcript is too thin to conclude anything, return no insights.`;

/**
 * Run the analysis over a ready transcript.
 *
 * Falls back to a deterministic rule-based extraction when no model is
 * configured, so this works end to end with no credentials — and the fallback
 * is labelled as the actor, so nothing produced by it can later be mistaken for
 * a model's conclusion.
 */
export async function analyseSession(options: {
  orgId: string;
  sessionId: string;
  /** The caller's own disposition, so disagreement can be spotted. */
  callerDisposition?: CallDisposition | null;
}): Promise<{ ok: boolean; insights: number; autoApplied: number; message?: string }> {
  const session = await prisma.callSession.findFirst({
    where: { id: options.sessionId, orgId: options.orgId },
    include: { transcript: true, route: { select: { route: true } } },
  });
  if (!session) return { ok: false, insights: 0, autoApplied: 0, message: 'That call is not on this account.' };

  const transcript = session.transcript;
  if (!transcript || transcript.state !== 'READY' || !transcript.text) {
    return {
      ok: false,
      insights: 0,
      autoApplied: 0,
      message: `No transcript to analyse — it is ${(transcript?.state ?? session.transcriptState).toLowerCase().replace(/_/g, ' ')}.`,
    };
  }

  const promptVersion = 'call_analysis@1';
  const result = await getLLM().structured({
    promptVersion,
    system: SYSTEM,
    user: [
      `Route type: ${session.route.route}.`,
      transcript.speakerSeparated
        ? 'The channels were separated, so speaker labels are reliable.'
        : 'This is a single mixed channel. Speaker labels are guesses — do not attribute a quote to a named person.',
      '',
      'Transcript:',
      transcript.text.slice(0, 20_000),
    ].join('\n'),
    schema: InsightSchema,
    fallback: () => ({ insights: fallbackExtraction(transcript.text ?? '') }),
  });

  const actor = result.usedFallback
    ? 'rules:call_analysis@1'
    : `ai:${result.modelName}@${promptVersion}`;

  let autoApplied = 0;

  await prisma.$transaction(async (tx) => {
    // Re-analysing replaces the machine's own previous conclusions and leaves
    // every human judgement alone. A reviewer's correction outliving a re-run
    // is the entire point of having had them look.
    await tx.callInsight.deleteMany({
      where: { sessionId: session.id, state: { in: ['AUTO_APPLIED', 'NEEDS_REVIEW'] } },
    });

    for (const raw of result.data.insights) {
      const insight: ExtractedInsight = {
        kind: raw.kind,
        value: raw.value,
        confidence: raw.confidence,
        evidenceQuote: raw.evidenceQuote,
        evidenceStartSec: raw.evidenceStartSec,
      };

      // A quote that is not in the transcript is a fabrication, and the
      // cheapest place to catch one is here.
      const quoted = insight.evidenceQuote
        && (transcript.text ?? '').toLowerCase().includes(insight.evidenceQuote.trim().toLowerCase().slice(0, 40));
      const checked: ExtractedInsight = quoted ? insight : { ...insight, evidenceQuote: null };

      const gate = gateInsight(checked);
      if (gate.state === 'AUTO_APPLIED') autoApplied += 1;

      await tx.callInsight.create({
        data: {
          orgId: options.orgId,
          sessionId: session.id,
          kind: checked.kind,
          value: checked.value,
          confidence: checked.confidence,
          evidenceQuote: checked.evidenceQuote,
          evidenceStartSec: checked.evidenceStartSec,
          state: gate.state,
          reviewReason: !quoted && insight.evidenceQuote
            ? 'The quote offered does not appear in the transcript, so it was dropped and this held for review.'
            : gate.reviewReason,
          actor,
        },
      });
    }
  });

  return { ok: true, insights: result.data.insights.length, autoApplied };
}

/**
 * A deterministic extraction for when no model is configured.
 *
 * Deliberately timid: it finds a handful of things that can be established by
 * looking for words, gives them modest confidence, and quotes the line it found
 * them on. Everything it produces goes to review, because a keyword match is
 * not a reading of a conversation and should not be treated as one.
 */
export function fallbackExtraction(text: string): ExtractedInsight[] {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const found: ExtractedInsight[] = [];

  const look = (pattern: RegExp, kind: InsightKind, describe: (line: string) => string) => {
    const line = lines.find((l) => pattern.test(l));
    if (!line) return;
    found.push({
      kind,
      value: describe(line),
      // Below the auto-apply threshold on purpose. A keyword match is a hint.
      confidence: 0.5,
      evidenceQuote: line.slice(0, 400),
      evidenceStartSec: null,
    });
  };

  look(/\b(contract|agreement)\b.{0,40}\b(ends?|expir|renew)/i, 'TIMING',
    () => 'The contract end or renewal was mentioned.');
  // Two shapes, because people name an incumbent both ways and the second is
  // commoner: "our current supplier is X" and "we're with X at the moment".
  // The first pattern alone missed every conversation phrased the second way.
  look(/\b(current|existing)\b.{0,20}\b(supplier|provider|vendor|cleaner|contractor)/i, 'INCUMBENT',
    () => 'An incumbent supplier was mentioned.');
  look(/\b(we(?:'| a)?re with|we use|we'?re using|stick with|stay with)\b\s+[A-Z]/, 'INCUMBENT',
    () => 'An incumbent supplier was named.');
  look(/\b(too expensive|price is|budget|cost)\b/i, 'OBJECTION',
    () => 'Price or budget was raised.');
  look(/\b(send|email|quote|proposal)\b.{0,30}\b(over|through|me|us)\b/i, 'NEXT_ACTION',
    () => 'Something was asked to be sent.');
  look(/\b(i'?ll|we'?ll|i will|we will)\b.{0,40}\b(send|call|get back|follow up)\b/i, 'BUYER_PROMISE',
    () => 'A promise was made on the call.');

  return found;
}

// ---------------------------------------------------------------------------
// Correction
// ---------------------------------------------------------------------------

/**
 * A person's judgement on one conclusion.
 *
 * Corrections are stored beside the original rather than over it. The original
 * is what the analysis said, and overwriting it would destroy the only signal
 * that says whether auto-fill is worth keeping.
 */
export async function reviewInsight(options: {
  orgId: string;
  insightId: string;
  decision: 'CONFIRMED' | 'CORRECTED' | 'REJECTED';
  correctedValue?: string | null;
  note?: string | null;
  reviewerId: string;
}): Promise<{ ok: boolean; message?: string }> {
  if (options.decision === 'CORRECTED' && !options.correctedValue?.trim()) {
    return { ok: false, message: 'A correction needs the corrected value.' };
  }

  const insight = await prisma.callInsight.findFirst({
    where: { id: options.insightId, orgId: options.orgId },
  });
  if (!insight) return { ok: false, message: 'That conclusion is not on this account.' };

  await prisma.callInsight.update({
    where: { id: insight.id },
    data: {
      state: options.decision,
      correctedValue: options.decision === 'CORRECTED' ? options.correctedValue : null,
      correctionNote: options.note ?? null,
      reviewedById: options.reviewerId,
      reviewedAt: new Date(),
    },
  });

  return { ok: true };
}

/** What the record now says, after any human correction. */
export function effectiveValue(insight: { value: string; correctedValue: string | null; state: InsightState }): string | null {
  if (insight.state === 'REJECTED') return null;
  return insight.correctedValue ?? insight.value;
}
