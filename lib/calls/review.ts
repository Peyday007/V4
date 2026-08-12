import { createHash } from 'node:crypto';
import type { CallDisposition, ReviewReason } from '@prisma/client';
import { prisma } from '@/lib/db';
import { NEVER_AUTO_APPLIED } from './analysis';

/**
 * Which calls a person looks at.
 *
 * Three kinds, and the third is the one that is easy to leave out and matters
 * most. Low-confidence conclusions are reviewed because the analysis said it
 * was unsure. High-impact conclusions are reviewed because being wrong about
 * them is expensive whatever the confidence. And a sample of the *confident*
 * cases is reviewed because otherwise nobody ever finds out whether the
 * confident ones are right — auto-fill would be trusted on the strength of its
 * own self-assessment, which is not evidence of anything.
 *
 * The sampling is deterministic on the session id, so the same call is either
 * in the sample or it is not, however many times this runs. A random draw per
 * invocation would let a retry pull a different set and quietly change the
 * measured accuracy.
 */

/** Share of confident calls pulled for a spot check. */
export const DEFAULT_SAMPLE_RATE = 0.1;

/**
 * Whether this session falls in the sample.
 *
 * Hashed rather than drawn, for the same reason experiment assignment is
 * hashed: stability. `salt` lets an operator re-sample deliberately without
 * making every previous decision unreproducible.
 */
export function inSample(sessionId: string, rate: number, salt = 'review'): boolean {
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  const digest = createHash('sha256').update(`${salt}:${sessionId}`).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000 < rate;
}

export type ReviewDecision = {
  needed: boolean;
  reason: ReviewReason | null;
  /** Written for the reviewer opening it cold, months later. */
  because: string;
};

export type ReviewInput = {
  sessionId: string;
  insights: Array<{
    kind: string;
    confidence: number;
    state: string;
    value: string;
  }>;
  /** What the caller themselves recorded. */
  callerDisposition?: CallDisposition | null;
  sampleRate?: number;
  /** True when an operator asked for this one specifically. */
  flagged?: boolean;
};

/**
 * Whether this call needs a person, and why.
 *
 * The order is the priority order: an operator's own request first, then the
 * things that are dangerous, then the things that are uncertain, then the
 * sample. A call that qualifies on several grounds is reported under the most
 * serious one, because the reason is what tells the reviewer how to read it.
 */
export function reviewNeeded(input: ReviewInput): ReviewDecision {
  if (input.flagged) {
    return {
      needed: true,
      reason: 'OPERATOR_FLAGGED',
      because: 'Somebody asked for this call to be looked at.',
    };
  }

  const highImpact = input.insights.filter((i) => NEVER_AUTO_APPLIED.includes(i.kind as never));
  if (highImpact.length > 0) {
    return {
      needed: true,
      reason: 'HIGH_IMPACT',
      because: `The analysis reported ${highImpact.length} conclusion${highImpact.length === 1 ? '' : 's'} of a kind it never finalises on its own: ${Array.from(new Set(highImpact.map((i) => label(i.kind)))).join(', ')}.`,
    };
  }

  // The analysis and the caller disagreeing is a strong signal that one of them
  // is wrong, and which one is not something to guess at.
  const suggested = input.insights.find((i) => i.kind === 'DISPOSITION_SUGGESTION');
  if (suggested && input.callerDisposition && !agrees(suggested.value, input.callerDisposition)) {
    return {
      needed: true,
      reason: 'DISAGREEMENT',
      because: `The analysis read this call as "${suggested.value}" and the caller recorded "${input.callerDisposition.toLowerCase().replace(/_/g, ' ')}". One of them is wrong.`,
    };
  }

  const uncertain = input.insights.filter((i) => i.state === 'NEEDS_REVIEW');
  if (uncertain.length > 0) {
    return {
      needed: true,
      reason: 'LOW_CONFIDENCE',
      because: `${uncertain.length} conclusion${uncertain.length === 1 ? ' was' : 's were'} not confident enough to apply without somebody seeing ${uncertain.length === 1 ? 'it' : 'them'}.`,
    };
  }

  const rate = input.sampleRate ?? DEFAULT_SAMPLE_RATE;
  if (inSample(input.sessionId, rate)) {
    return {
      needed: true,
      reason: 'RANDOM_SAMPLE',
      because: `Everything on this call was applied automatically. It is in the ${Math.round(rate * 100)}% spot check, which is the only way anybody finds out whether the confident ones are right.`,
    };
  }

  return {
    needed: false,
    reason: null,
    because: 'Everything was confident, routine and evidenced. Not selected for the spot check.',
  };
}

/** Loose agreement between a suggested disposition and the recorded one. */
function agrees(suggestion: string, recorded: CallDisposition): boolean {
  const normalise = (value: string) => value.toUpperCase().replace(/[^A-Z]/g, '');
  return normalise(suggestion).includes(normalise(recorded))
    || normalise(recorded).includes(normalise(suggestion));
}

function label(kind: string): string {
  return kind.toLowerCase().replace(/_/g, ' ');
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Open a review if one is warranted.
 *
 * Idempotent per session: re-analysing a call does not stack a second review,
 * and a review already completed is not reopened by a re-run — a reviewer's
 * judgement surviving the next analysis is what makes doing the review worth
 * anybody's time.
 */
export async function openReviewIfNeeded(options: {
  orgId: string;
  sessionId: string;
  callerDisposition?: CallDisposition | null;
  sampleRate?: number;
  flagged?: boolean;
}): Promise<{ opened: boolean; reason: ReviewReason | null; because: string }> {
  const existing = await prisma.callReview.findUnique({ where: { sessionId: options.sessionId } });
  if (existing) {
    return {
      opened: false,
      reason: existing.reason,
      because: existing.state === 'OPEN'
        ? 'A review is already open on this call.'
        : 'This call has already been reviewed, and a re-analysis does not undo that.',
    };
  }

  const insights = await prisma.callInsight.findMany({
    where: { orgId: options.orgId, sessionId: options.sessionId },
    select: { kind: true, confidence: true, state: true, value: true },
  });

  const decision = reviewNeeded({
    sessionId: options.sessionId,
    insights,
    callerDisposition: options.callerDisposition,
    sampleRate: options.sampleRate,
    flagged: options.flagged,
  });

  if (!decision.needed || !decision.reason) {
    return { opened: false, reason: null, because: decision.because };
  }

  await prisma.callReview.create({
    data: {
      orgId: options.orgId,
      sessionId: options.sessionId,
      reason: decision.reason,
      because: decision.because,
      state: 'OPEN',
    },
  });

  return { opened: true, reason: decision.reason, because: decision.because };
}

export type ReviewOutcome = {
  ok: boolean;
  message?: string;
};

/**
 * Close a review.
 *
 * `correctionsMade` is counted from the insights rather than reported by the
 * reviewer, because it is the number that decides whether auto-fill keeps its
 * privileges and a self-reported one would drift.
 */
export async function completeReview(options: {
  orgId: string;
  sessionId: string;
  reviewerId: string;
  notes?: string | null;
  /** Set when the reviewer could not judge — audio gone, wrong account. */
  abandoned?: boolean;
}): Promise<ReviewOutcome> {
  const review = await prisma.callReview.findFirst({
    where: { sessionId: options.sessionId, orgId: options.orgId },
  });
  if (!review) return { ok: false, message: 'There is no review open on that call.' };
  if (review.state !== 'OPEN') return { ok: false, message: 'That review is already closed.' };

  const insights = await prisma.callInsight.findMany({
    where: { orgId: options.orgId, sessionId: options.sessionId },
    select: { state: true },
  });

  const undecided = insights.filter((i) => i.state === 'NEEDS_REVIEW').length;
  if (undecided > 0 && !options.abandoned) {
    return {
      ok: false,
      message: `${undecided} conclusion${undecided === 1 ? ' is' : 's are'} still waiting on a decision. Confirm, correct or reject each before closing this.`,
    };
  }

  const corrections = insights.filter((i) => i.state === 'CORRECTED' || i.state === 'REJECTED').length;

  await prisma.callReview.update({
    where: { id: review.id },
    data: {
      state: options.abandoned ? 'ABANDONED' : 'DONE',
      completedAt: new Date(),
      reviewerId: options.reviewerId,
      notes: options.notes ?? null,
      correctionsMade: corrections,
      agreed: options.abandoned ? null : corrections === 0,
    },
  });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type AutoFillAccuracy = {
  reviewed: number;
  agreed: number;
  corrected: number;
  /** Null until enough reviews exist to mean anything. */
  agreementRate: number | null;
  /** Said plainly rather than left as a low number nobody interprets. */
  verdict: string;
};

/** Below this many completed reviews, the accuracy figure is noise. */
export const MIN_REVIEWS_FOR_ACCURACY = 20;

/**
 * Whether auto-fill is earning its place.
 *
 * Read only from the sampled confident calls. Including the low-confidence
 * reviews would measure the cases the system already said it was unsure about,
 * which tells nobody anything about the ones it applied without asking.
 */
export async function autoFillAccuracy(params: {
  orgId: string;
  since?: Date;
}): Promise<AutoFillAccuracy> {
  const reviews = await prisma.callReview.findMany({
    where: {
      orgId: params.orgId,
      reason: 'RANDOM_SAMPLE',
      state: 'DONE',
      ...(params.since ? { completedAt: { gte: params.since } } : {}),
    },
    select: { agreed: true, correctionsMade: true },
  });

  const reviewed = reviews.length;
  const agreed = reviews.filter((r) => r.agreed === true).length;
  const corrected = reviews.filter((r) => r.correctionsMade > 0).length;

  if (reviewed < MIN_REVIEWS_FOR_ACCURACY) {
    return {
      reviewed,
      agreed,
      corrected,
      agreementRate: null,
      verdict: `${reviewed} spot check${reviewed === 1 ? '' : 's'} completed. Below ${MIN_REVIEWS_FOR_ACCURACY} there is nothing to read from this, and a rate shown here would be a story about a handful of calls.`,
    };
  }

  const agreementRate = agreed / reviewed;
  return {
    reviewed,
    agreed,
    corrected,
    agreementRate: Math.round(agreementRate * 1000) / 1000,
    verdict: agreementRate >= 0.9
      ? `Reviewers agreed with the analysis on ${agreed} of ${reviewed} spot checks. Auto-fill is holding up.`
      : `Reviewers changed something on ${corrected} of ${reviewed} spot checks. That is high enough to stop applying these without a person.`,
  };
}
