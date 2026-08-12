import type { CallDisposition, ConsistencyKind, WorkCapability } from '@prisma/client';
import type { OrgConfig } from '@/lib/config';
import { withinCallingHours } from '@/lib/compliance';
import type { EvidenceRef } from './rules';

/**
 * Evidence consistency: where the record and the evidence do not line up.
 *
 * Every function in this file is written under one restriction, and it is worth
 * stating plainly because the restriction is the whole design: none of these
 * may conclude anything about why. A call logged as connected with no notes is
 * produced by a dropped save, by a thirty-second conversation that genuinely
 * had nothing in it, by a caller who typed the notes into the wrong screen, and
 * by somebody inflating their numbers. Those are four different situations with
 * four different responses, and the record alone cannot separate them.
 *
 * So a check produces: what was observed, what was expected, the records both
 * came from, a neutral question, and — mandatorily, enforced by the database —
 * the ordinary innocent explanations for the same observation. The last of
 * these is not politeness. A case that goes to a person with three benign
 * readings attached gets read as a question; the same case without them gets
 * read as an accusation, and the person answering it starts defending rather
 * than explaining.
 *
 * `confidence` here is confidence that the *mismatch is real* — that the two
 * records genuinely disagree — and never confidence about a person.
 */

export type Finding = {
  kind: ConsistencyKind;
  /** Stable across re-runs, so a nightly sweep does not stack copies. */
  dedupeKey: string;
  callerId: string | null;
  routeId: string | null;
  attemptId: string | null;
  sessionId: string | null;
  /** What the work needed, so the right circuit breaker is consulted. */
  capability: WorkCapability | null;
  /** When the thing being explained happened. */
  at: Date;
  observed: string;
  expected: string;
  evidence: EvidenceRef[];
  /** Never empty. The database refuses a case without one. */
  benignAlternatives: string[];
  /** How sure we are the two records disagree. Not a judgement of anybody. */
  confidence: number;
  /** Put to the caller as written. Neutral by construction. */
  question: string;
};

/** Dispositions that assert somebody was actually spoken to. */
export const CONNECTED_DISPOSITIONS: readonly CallDisposition[] = [
  'GATEKEEPER',
  'REACHED_RELEVANT_PERSON',
  'DECISION_MAKER_IDENTIFIED',
  'REACHED_DECISION_MAKER',
  'NEED_CONFIRMED',
  'NEED_UNCONFIRMED',
  'QUOTE_REQUESTED',
  'INTERESTED',
  'NEEDS_INFORMATION',
  'QUALIFIED_OPPORTUNITY',
  'ALREADY_HANDLED',
  'NOT_INTERESTED',
  'BAD_FIT',
  'DO_NOT_CONTACT',
];

/** Dispositions that assert nobody was reached. */
export const UNREACHED_DISPOSITIONS: readonly CallDisposition[] = [
  'NO_ANSWER',
  'LEFT_VOICEMAIL',
  'WRONG_NUMBER',
];

/** Dispositions that promise we will come back. */
const PROMISING_DISPOSITIONS: readonly CallDisposition[] = [
  'FOLLOW_UP',
  'NEEDS_INFORMATION',
  'QUOTE_REQUESTED',
  'INTERESTED',
];

export type AttemptRecord = {
  id: string;
  routeId: string;
  userId: string | null;
  disposition: CallDisposition;
  notes: string | null;
  discovery: Record<string, unknown>;
  occurredAt: Date;
  /** The call session, when one was opened. */
  sessionId?: string | null;
  /** Set when a transcript exists and could be compared. */
  transcript?: {
    sessionId: string;
    /** What the analysis read the call as. */
    suggestedDisposition: string | null;
    /** False for interim room audio, which cannot tell two voices apart. */
    speakerSeparated: boolean;
  } | null;
  /** The prospect's local timezone, for the calling-hours check. */
  timezone?: string;
  /** What the route is about, for the question's wording. */
  companyName?: string;
};

const ref = (label: string, id: string, at?: Date): EvidenceRef =>
  ({ label, ref: id, ...(at ? { at: at.toISOString() } : {}) });

function hasFacts(discovery: Record<string, unknown>): boolean {
  return Object.values(discovery ?? {}).some((v) => {
    if (v === null || v === undefined) return false;
    if (typeof v === 'string') return v.trim().length > 0;
    if (Array.isArray(v)) return v.length > 0;
    return true;
  });
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/**
 * A call recorded as connected that left nothing behind.
 *
 * Not "they did not call". A conversation with a named human that produced no
 * note and no fact is a conversation nobody can act on, whatever happened in
 * it, and that is worth a question on its own terms.
 */
export function attemptWithoutEvidence(attempt: AttemptRecord): Finding | null {
  if (!CONNECTED_DISPOSITIONS.includes(attempt.disposition)) return null;
  if ((attempt.notes ?? '').trim().length > 0) return null;
  if (hasFacts(attempt.discovery)) return null;

  return {
    kind: 'ATTEMPT_WITHOUT_EVIDENCE',
    dedupeKey: `attempt:${attempt.id}`,
    callerId: attempt.userId,
    routeId: attempt.routeId,
    attemptId: attempt.id,
    sessionId: attempt.sessionId ?? null,
    capability: 'CALL_PLACING',
    at: attempt.occurredAt,
    observed: `The call is recorded as "${words(attempt.disposition)}" and carries no notes and no facts.`,
    expected: 'A call that reached somebody usually leaves at least one thing behind — a name, a date, a price, or a sentence about what they said.',
    evidence: [ref('the attempt', `OutreachAttempt:${attempt.id}`, attempt.occurredAt)],
    benignAlternatives: [
      'The save dropped the notes after the disposition was recorded.',
      'The conversation was thirty seconds and genuinely had nothing in it worth keeping.',
      'The facts were typed into the deal record rather than the call form.',
      'They were mid-sentence when the line dropped and the caller logged what they had.',
    ],
    confidence: 0.9,
    question: `This call to ${attempt.companyName ?? 'the buyer'} is logged as ${words(attempt.disposition)} with nothing written down. Do you remember what was said, or did the form lose it?`,
  };
}

/** We said we would come back and no date was set. */
export function promiseNotScheduled(
  attempt: AttemptRecord,
  followUp: { snoozeUntil: Date | null } | null,
): Finding | null {
  if (!PROMISING_DISPOSITIONS.includes(attempt.disposition)) return null;
  if (followUp?.snoozeUntil) return null;

  return {
    kind: 'PROMISE_NOT_SCHEDULED',
    dedupeKey: `promise:${attempt.id}`,
    callerId: attempt.userId,
    routeId: attempt.routeId,
    attemptId: attempt.id,
    sessionId: attempt.sessionId ?? null,
    capability: 'CALL_PLACING',
    at: attempt.occurredAt,
    observed: `The call ended as "${words(attempt.disposition)}" and no follow-up date was set.`,
    expected: 'A call that ends with us owing them something has a date on it, or the promise is only in somebody\'s head.',
    evidence: [ref('the attempt', `OutreachAttempt:${attempt.id}`, attempt.occurredAt)],
    benignAlternatives: [
      'They asked us not to chase, and the disposition is the closest one on the list.',
      'The follow-up was set and then cleared by a later call on the same route.',
      'The date was entered and the save failed.',
    ],
    confidence: 0.85,
    question: 'Did this one need a callback? If it did, when — and if the form would not take the date, say so and it goes down as ours.',
  };
}

/**
 * The transcript reads one way and the caller recorded another.
 *
 * Deliberately unavailable for interim room audio. One microphone next to a
 * speakerphone cannot tell two voices apart, so a disagreement between it and
 * the caller is not evidence about the caller — it is evidence about the
 * microphone.
 */
export function dispositionContradictsTranscript(attempt: AttemptRecord): Finding | null {
  const transcript = attempt.transcript;
  if (!transcript?.suggestedDisposition) return null;
  if (!transcript.speakerSeparated) return null;

  const recorded = normalise(attempt.disposition);
  const suggested = normalise(transcript.suggestedDisposition);
  if (recorded.includes(suggested) || suggested.includes(recorded)) return null;

  // Reached-somebody versus reached-nobody is the disagreement that matters.
  // The rest are shades of the same conversation and not worth a person's time.
  const recordedReached = CONNECTED_DISPOSITIONS.includes(attempt.disposition);
  const suggestedReached = CONNECTED_DISPOSITIONS.some((d) => normalise(d) === suggested);
  if (recordedReached === suggestedReached) return null;

  return {
    kind: 'DISPOSITION_CONTRADICTS_TRANSCRIPT',
    dedupeKey: `disposition:${attempt.id}`,
    callerId: attempt.userId,
    routeId: attempt.routeId,
    attemptId: attempt.id,
    sessionId: transcript.sessionId,
    capability: 'CALL_PLACING',
    at: attempt.occurredAt,
    observed: `The caller recorded "${words(attempt.disposition)}" and the transcript reads as "${transcript.suggestedDisposition}".`,
    expected: 'The outcome on the record and the outcome in the recording describe the same call.',
    evidence: [
      ref('the attempt', `OutreachAttempt:${attempt.id}`, attempt.occurredAt),
      ref('the transcript', `CallSession:${transcript.sessionId}`),
    ],
    benignAlternatives: [
      'The transcript is partial — the recording started late or cut off.',
      'The caller knows something that was not said out loud on this call.',
      'The analysis read a gatekeeper as the decision-maker, or the reverse.',
      'Two calls were made and the transcript belongs to the other one.',
    ],
    confidence: 0.65,
    question: 'The recording and your note read differently on this call. Which is right? The recording is often the one that is wrong.',
  };
}

/** Marked qualified with nothing on file that qualifies it. */
export function qualifiedWithoutFacts(input: {
  routeId: string;
  callerId: string | null;
  status: string;
  confirmedNeed: string | null;
  confirmedTiming: string | null;
  budgetNote: string | null;
  hasRequirement: boolean;
  at: Date;
  companyName?: string;
}): Finding | null {
  if (input.status !== 'QUALIFIED') return null;
  if (input.hasRequirement) return null;
  if (input.confirmedNeed?.trim() || input.confirmedTiming?.trim() || input.budgetNote?.trim()) return null;

  return {
    kind: 'QUALIFIED_WITHOUT_FACTS',
    dedupeKey: `qualified:${input.routeId}`,
    callerId: input.callerId,
    routeId: input.routeId,
    attemptId: null,
    sessionId: null,
    capability: 'REQUIREMENT_CAPTURE',
    at: input.at,
    observed: 'This route is marked qualified and has no confirmed need, no timing, no budget note and no buyer requirement.',
    expected: 'Qualified means somebody told us something specific. Without one of those four, the word is doing no work.',
    evidence: [ref('the route', `RouteHypothesis:${input.routeId}`, input.at)],
    benignAlternatives: [
      'The facts were captured on the deal record and the outreach state was not refreshed.',
      'The status was set by a bulk action rather than by a call.',
      'The buyer confirmed verbally and asked us not to write specifics down yet.',
    ],
    confidence: 0.8,
    question: `${input.companyName ?? 'This buyer'} is marked qualified. What did they actually say that qualifies it?`,
  };
}

/**
 * Two calls to the same route inside a few minutes.
 *
 * The commonest cause by a distance is a redial after a dropped line, which is
 * why the benign list leads with it.
 */
export function duplicateAttempt(
  attempt: AttemptRecord,
  previous: { id: string; occurredAt: Date; disposition: CallDisposition } | null,
  withinMinutes = 5,
): Finding | null {
  if (!previous) return null;
  const gapMs = attempt.occurredAt.getTime() - previous.occurredAt.getTime();
  if (gapMs < 0 || gapMs > withinMinutes * 60_000) return null;

  return {
    kind: 'DUPLICATE_ATTEMPT',
    dedupeKey: `duplicate:${attempt.id}`,
    callerId: attempt.userId,
    routeId: attempt.routeId,
    attemptId: attempt.id,
    sessionId: attempt.sessionId ?? null,
    capability: 'CALL_PLACING',
    at: attempt.occurredAt,
    observed: `Two attempts on this route ${Math.max(1, Math.round(gapMs / 60_000))} minute(s) apart: "${words(previous.disposition)}" then "${words(attempt.disposition)}".`,
    expected: 'One conversation produces one attempt record, so the dial count means something.',
    evidence: [
      ref('the first attempt', `OutreachAttempt:${previous.id}`, previous.occurredAt),
      ref('the second attempt', `OutreachAttempt:${attempt.id}`, attempt.occurredAt),
    ],
    benignAlternatives: [
      'The line dropped and they called straight back — this is the usual reason.',
      'The first save appeared to fail, so it was entered again.',
      'They were transferred to a second person at the same site.',
      'A gatekeeper call and the real call, minutes apart.',
    ],
    confidence: 0.7,
    question: 'Two records went in close together here. Was that a redial after a dropped call, or did the first one look like it had not saved?',
  };
}

/** A call placed outside the hours the prospect's own state permits. */
export function attemptOutsideCallingHours(
  attempt: AttemptRecord,
  config: OrgConfig,
): Finding | null {
  const timezone = attempt.timezone ?? 'America/New_York';
  const verdict = withinCallingHours(timezone, attempt.occurredAt, config.callingRules);
  if (verdict.ok) return null;

  return {
    kind: 'ATTEMPT_OUTSIDE_CALLING_HOURS',
    dedupeKey: `hours:${attempt.id}`,
    callerId: attempt.userId,
    routeId: attempt.routeId,
    attemptId: attempt.id,
    sessionId: attempt.sessionId ?? null,
    capability: 'CALL_PLACING',
    at: attempt.occurredAt,
    observed: `Placed at a time the rules do not permit for ${timezone}: ${verdict.reason}.`,
    expected: `Calls go out between ${config.callingRules.earliestHourLocal}:00 and ${config.callingRules.latestHourLocal}:00 in the buyer's own time.`,
    evidence: [ref('the attempt', `OutreachAttempt:${attempt.id}`, attempt.occurredAt)],
    benignAlternatives: [
      'The buyer asked to be called at that hour, which the rules allow and the record cannot show.',
      'The timezone on the company is wrong — a head-office address on a site three states away.',
      'They returned our call and the attempt was logged from their end.',
      'The record was written up later and the timestamp is the write-up, not the dial.',
    ],
    confidence: 0.75,
    question: 'This one is logged outside calling hours for their state. Was it their request, a returned call, or is the timezone on the record wrong?',
  };
}

/** Nobody was reached, and facts about the buyer were recorded anyway. */
export function factsRecordedWithoutContact(attempt: AttemptRecord): Finding | null {
  if (!UNREACHED_DISPOSITIONS.includes(attempt.disposition)) return null;
  if (!hasFacts(attempt.discovery)) return null;

  return {
    kind: 'FACTS_RECORDED_WITHOUT_CONTACT',
    dedupeKey: `facts:${attempt.id}`,
    callerId: attempt.userId,
    routeId: attempt.routeId,
    attemptId: attempt.id,
    sessionId: attempt.sessionId ?? null,
    capability: 'REQUIREMENT_CAPTURE',
    at: attempt.occurredAt,
    observed: `Recorded as "${words(attempt.disposition)}", with buyer facts attached.`,
    expected: 'Facts about what a buyer needs come from somebody saying them. A call nobody answered is not a source.',
    evidence: [ref('the attempt', `OutreachAttempt:${attempt.id}`, attempt.occurredAt)],
    benignAlternatives: [
      'A receptionist gave the information before transferring, and the call still went to voicemail.',
      'The facts came from their website or a published tender and were entered here.',
      'A correction to something learned on an earlier call, entered against the latest attempt.',
    ],
    confidence: 0.7,
    question: 'Where did these details come from, given nobody picked up? If it was the website or a receptionist, say so and it gets sourced properly.',
  };
}

/** A promise we made whose date has passed with nothing done. */
export function followUpPromiseMissed(input: {
  routeId: string;
  callerId: string | null;
  dueAt: Date;
  now: Date;
  lastAttemptAt: Date | null;
  graceHours?: number;
  companyName?: string;
}): Finding | null {
  const grace = (input.graceHours ?? 24) * 3_600_000;
  if (input.now.getTime() - input.dueAt.getTime() < grace) return null;
  if (input.lastAttemptAt && input.lastAttemptAt.getTime() >= input.dueAt.getTime()) return null;

  const daysLate = Math.floor((input.now.getTime() - input.dueAt.getTime()) / 86_400_000);
  return {
    kind: 'FOLLOW_UP_PROMISE_MISSED',
    dedupeKey: `missed:${input.routeId}:${input.dueAt.toISOString().slice(0, 10)}`,
    callerId: input.callerId,
    routeId: input.routeId,
    attemptId: null,
    sessionId: null,
    capability: 'CALL_PLACING',
    at: input.dueAt,
    observed: `We said we would come back on ${input.dueAt.toISOString().slice(0, 10)} and nothing has been attempted since. ${daysLate} day(s) past.`,
    expected: 'A date we gave somebody is kept, or it is moved and they are told.',
    evidence: [ref('the route', `RouteHypothesis:${input.routeId}`, input.dueAt)],
    benignAlternatives: [
      'The route never appeared in anybody\'s queue — that would be ours, not theirs.',
      'The caller was restricted or off, and nobody picked the promise up.',
      'They rang us instead and the conversation was logged against a different record.',
      'The buyer asked to be left until later and the date was not moved.',
    ],
    confidence: 0.85,
    question: `${input.companyName ?? 'This buyer'} was expecting a call on ${input.dueAt.toISOString().slice(0, 10)}. Did it come up in your queue?`,
  };
}

function words(disposition: string): string {
  return disposition.toLowerCase().replace(/_/g, ' ');
}

function normalise(value: string): string {
  return value.toUpperCase().replace(/[^A-Z]/g, '');
}
