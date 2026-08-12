import { describe, expect, it } from 'vitest';
import { recordingConsent } from '@/lib/calls/consent';
import { canSeparateSpeakers, captureCaveat } from '@/lib/calls/recording';
import { gateInsight, fallbackExtraction, effectiveValue, NEVER_AUTO_APPLIED, AUTO_APPLY_THRESHOLD } from '@/lib/calls/analysis';
import { reviewNeeded, inSample, DEFAULT_SAMPLE_RATE } from '@/lib/calls/review';
import { DEFAULT_CONFIG } from '@/lib/config';
import { CaptureMode, InsightKind } from '@prisma/client';

/**
 * The rules behind call intelligence.
 *
 * Two of these decide whether the system breaks the law, and one decides
 * whether a machine's opinion silently becomes a record. They are the parts
 * worth testing hardest.
 */

const config = DEFAULT_CONFIG;

// ---------------------------------------------------------------------------

describe('recording consent follows both parties', () => {
  it('records in a one-party state on both sides', () => {
    const decision = recordingConsent({
      config, callerState: 'TX', prospectState: 'GA', contactConsent: null,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.state).toBe('NOT_REQUIRED');
  });

  it('refuses when the caller sits in an all-party state, even where the prospect does not', () => {
    // The trap: the prospect's state is the one on the record, so an
    // implementation that checks only that would record this illegally.
    const decision = recordingConsent({
      config, callerState: 'IL', prospectState: 'TX', contactConsent: null,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.strictestSide).toBe('caller');
    expect(decision.basis).toMatch(/caller's jurisdiction/i);
  });

  it('refuses when the prospect is in an all-party state and the caller is not', () => {
    const decision = recordingConsent({
      config, callerState: 'TX', prospectState: 'CA', contactConsent: null,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.strictestSide).toBe('prospect');
  });

  it('allows an all-party call once the announcement has actually been played', () => {
    const before = recordingConsent({ config, callerState: 'IL', prospectState: 'CA', contactConsent: null });
    const after = recordingConsent({ config, callerState: 'IL', prospectState: 'CA', contactConsent: null, announced: true });
    expect(before.allowed).toBe(false);
    expect(after.allowed).toBe(true);
    expect(after.state).toBe('ANNOUNCED');
  });

  it('allows an all-party call on explicit consent already on file', () => {
    const decision = recordingConsent({ config, callerState: 'CA', prospectState: 'CA', contactConsent: true });
    expect(decision.allowed).toBe(true);
    expect(decision.state).toBe('GRANTED');
    expect(decision.strictestSide).toBe('both');
  });

  it('treats an unknown jurisdiction as a refusal, not a permission', () => {
    for (const [caller, prospect] of [[null, 'TX'], ['TX', null], [null, null]] as const) {
      const decision = recordingConsent({ config, callerState: caller, prospectState: prospect, contactConsent: null });
      expect(decision.allowed).toBe(false);
      expect(decision.state).toBe('UNKNOWN');
      expect(decision.basis).toMatch(/do not know where/);
    }
  });

  it('lets a refusal override every jurisdiction and every prior consent', () => {
    const refusedNow = recordingConsent({
      config, callerState: 'TX', prospectState: 'TX', contactConsent: true, refusedNow: true,
    });
    expect(refusedNow.allowed).toBe(false);
    expect(refusedNow.state).toBe('REFUSED');

    const onFile = recordingConsent({
      config, callerState: 'TX', prospectState: 'TX', contactConsent: false,
    });
    expect(onFile.allowed).toBe(false);
  });

  it('announces even where the law does not require it', () => {
    // Being legally entitled to record somebody without telling them is not a
    // reason to do it.
    const decision = recordingConsent({ config, callerState: 'TX', prospectState: 'GA', contactConsent: null });
    expect(decision.allowed).toBe(true);
    expect(decision.requiresAnnouncement).toBe(true);
  });

  it('ignores rubbish in the state field rather than matching on it', () => {
    const decision = recordingConsent({
      config, callerState: 'Illinois', prospectState: 'TX', contactConsent: null,
    });
    expect(decision.state).toBe('UNKNOWN');
    expect(decision.callerJurisdiction).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('capture quality is never overstated', () => {
  it('only a provider recording separates speakers', () => {
    expect(canSeparateSpeakers('PROVIDER_RECORDING')).toBe(true);
    expect(canSeparateSpeakers('INTERIM_ROOM_AUDIO')).toBe(false);
    expect(canSeparateSpeakers('NONE')).toBe(false);
  });

  it('labels interim room audio as what it is', () => {
    const caveat = captureCaveat('INTERIM_ROOM_AUDIO');
    expect(caveat).toMatch(/one mixed channel/i);
    expect(caveat).toMatch(/inferred rather than known/i);
    expect(caveat).not.toBeNull();
  });

  it('says plainly when nothing was captured', () => {
    expect(captureCaveat('NONE')).toMatch(/No audio was captured/i);
  });

  it('adds no caveat to a proper recording', () => {
    expect(captureCaveat('PROVIDER_RECORDING')).toBeNull();
  });

  it('has a position on every capture mode the schema allows', () => {
    for (const mode of Object.values(CaptureMode)) {
      expect(typeof canSeparateSpeakers(mode as CaptureMode)).toBe('boolean');
    }
  });
});

// ---------------------------------------------------------------------------

describe('the AI never gets the last word on what matters', () => {
  const confident = (kind: InsightKind) => ({
    kind,
    value: 'something',
    confidence: 0.99,
    evidenceQuote: 'they said the thing',
    evidenceStartSec: 10,
  });

  it('holds every high-impact conclusion for a person, however confident', () => {
    for (const kind of NEVER_AUTO_APPLIED) {
      const gate = gateInsight(confident(kind));
      expect(gate.state, kind).toBe('NEEDS_REVIEW');
      expect(gate.reviewReason, kind).toBeTruthy();
    }
  });

  it('holds anything without a quote from the transcript', () => {
    const gate = gateInsight({ ...confident('CONFIRMED_NEED'), evidenceQuote: null });
    expect(gate.state).toBe('NEEDS_REVIEW');
    expect(gate.reviewReason).toMatch(/nothing to check it against/);
  });

  it('treats an empty quote as no quote', () => {
    const gate = gateInsight({ ...confident('CONFIRMED_NEED'), evidenceQuote: '   ' });
    expect(gate.state).toBe('NEEDS_REVIEW');
  });

  it('holds anything under the confidence threshold', () => {
    const below = gateInsight({ ...confident('TIMING'), confidence: AUTO_APPLY_THRESHOLD - 0.01 });
    const at = gateInsight({ ...confident('TIMING'), confidence: AUTO_APPLY_THRESHOLD });
    expect(below.state).toBe('NEEDS_REVIEW');
    expect(below.reviewReason).toMatch(/below the/);
    expect(at.state).toBe('AUTO_APPLIED');
  });

  it('applies a confident, evidenced, routine conclusion without waiting', () => {
    const gate = gateInsight(confident('INCUMBENT'));
    expect(gate.state).toBe('AUTO_APPLIED');
    expect(gate.reviewReason).toBeNull();
  });

  it('never auto-applies a promise, which is a commercial commitment', () => {
    expect(NEVER_AUTO_APPLIED).toContain('BUYER_PROMISE');
    expect(NEVER_AUTO_APPLIED).toContain('PROVIDER_PROMISE');
    // Observations about a caller feed performance and standing.
    expect(NEVER_AUTO_APPLIED).toContain('SCRIPT_OBSERVATION');
  });
});

describe('the rule-based fallback is deliberately timid', () => {
  const transcript = [
    'Caller: Morning, I wanted to ask about your cleaning contract.',
    'Buyer: Our contract ends in March and we are with CleanCo at the moment.',
    'Buyer: Honestly the price is what matters most to us.',
    'Buyer: Can you send a quote over to me?',
    'Caller: I will send that through this afternoon.',
  ].join('\n');

  it('finds what a keyword match can honestly find', () => {
    const found = fallbackExtraction(transcript);
    const kinds = found.map((f) => f.kind);
    expect(kinds).toContain('TIMING');
    expect(kinds).toContain('INCUMBENT');
    expect(kinds).toContain('OBJECTION');
  });

  it('quotes the line it found each one on', () => {
    for (const insight of fallbackExtraction(transcript)) {
      expect(insight.evidenceQuote).toBeTruthy();
      expect(transcript).toContain(insight.evidenceQuote!);
    }
  });

  it('never reaches the auto-apply threshold', () => {
    // A keyword match is a hint, not a reading of a conversation, and every
    // one of these must land in front of a person.
    for (const insight of fallbackExtraction(transcript)) {
      expect(insight.confidence).toBeLessThan(AUTO_APPLY_THRESHOLD);
      expect(gateInsight(insight).state).toBe('NEEDS_REVIEW');
    }
  });

  it('finds nothing in a transcript with nothing in it', () => {
    expect(fallbackExtraction('Caller: Hello?\nBuyer: Wrong number.')).toEqual([]);
  });
});

describe('a correction sits beside the original, not over it', () => {
  it('reads the corrected value once somebody has corrected it', () => {
    expect(effectiveValue({ value: 'March', correctedValue: 'May', state: 'CORRECTED' })).toBe('May');
  });

  it('reads the original when it was confirmed', () => {
    expect(effectiveValue({ value: 'March', correctedValue: null, state: 'CONFIRMED' })).toBe('March');
  });

  it('reads nothing at all when it was rejected', () => {
    expect(effectiveValue({ value: 'March', correctedValue: null, state: 'REJECTED' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('review selection', () => {
  const evidenced = { kind: 'INCUMBENT', confidence: 0.95, state: 'AUTO_APPLIED', value: 'CleanCo' };

  it('takes an operator request above everything else', () => {
    const decision = reviewNeeded({
      sessionId: 'a', insights: [evidenced], flagged: true, sampleRate: 0,
    });
    expect(decision.reason).toBe('OPERATOR_FLAGGED');
  });

  it('takes a high-impact conclusion above an uncertain one', () => {
    const decision = reviewNeeded({
      sessionId: 'a',
      insights: [
        { kind: 'BUYER_PROMISE', confidence: 0.99, state: 'NEEDS_REVIEW', value: 'send a quote' },
        { kind: 'TIMING', confidence: 0.4, state: 'NEEDS_REVIEW', value: 'March' },
      ],
      sampleRate: 0,
    });
    expect(decision.reason).toBe('HIGH_IMPACT');
    expect(decision.because).toMatch(/never finalises on its own/);
  });

  it('flags disagreement between the analysis and the caller', () => {
    const decision = reviewNeeded({
      sessionId: 'a',
      insights: [{ kind: 'DISPOSITION_SUGGESTION', confidence: 0.9, state: 'AUTO_APPLIED', value: 'NOT_INTERESTED' }],
      callerDisposition: 'NEED_CONFIRMED',
      sampleRate: 0,
    });
    expect(decision.reason).toBe('DISAGREEMENT');
    expect(decision.because).toMatch(/One of them is wrong/);
  });

  it('does not flag agreement', () => {
    const decision = reviewNeeded({
      sessionId: 'a',
      insights: [{ kind: 'DISPOSITION_SUGGESTION', confidence: 0.9, state: 'AUTO_APPLIED', value: 'NEED_CONFIRMED' }],
      callerDisposition: 'NEED_CONFIRMED',
      sampleRate: 0,
    });
    expect(decision.reason).not.toBe('DISAGREEMENT');
  });

  it('reviews anything the analysis was unsure about', () => {
    const decision = reviewNeeded({
      sessionId: 'a',
      insights: [{ kind: 'TIMING', confidence: 0.4, state: 'NEEDS_REVIEW', value: 'March' }],
      sampleRate: 0,
    });
    expect(decision.reason).toBe('LOW_CONFIDENCE');
  });

  it('spot-checks confident calls, which is the only way accuracy is ever known', () => {
    const decision = reviewNeeded({ sessionId: 'a', insights: [evidenced], sampleRate: 1 });
    expect(decision.reason).toBe('RANDOM_SAMPLE');
    expect(decision.because).toMatch(/only way anybody finds out/);
  });

  it('lets a clean, confident, unsampled call through', () => {
    const decision = reviewNeeded({ sessionId: 'a', insights: [evidenced], sampleRate: 0 });
    expect(decision.needed).toBe(false);
    expect(decision.reason).toBeNull();
  });
});

describe('sampling is stable', () => {
  it('gives the same answer for the same session every time', () => {
    const first = inSample('session-abc', DEFAULT_SAMPLE_RATE);
    for (let i = 0; i < 300; i += 1) {
      expect(inSample('session-abc', DEFAULT_SAMPLE_RATE)).toBe(first);
    }
  });

  it('samples roughly the requested share', () => {
    const sessions = Array.from({ length: 4000 }, (_, i) => `session-${i}`);
    const picked = sessions.filter((id) => inSample(id, 0.1)).length;
    expect(picked).toBeGreaterThan(300);
    expect(picked).toBeLessThan(500);
  });

  it('takes nothing at zero and everything at one', () => {
    const sessions = Array.from({ length: 200 }, (_, i) => `session-${i}`);
    expect(sessions.filter((id) => inSample(id, 0)).length).toBe(0);
    expect(sessions.filter((id) => inSample(id, 1)).length).toBe(200);
  });

  it('re-samples deliberately when the salt changes', () => {
    const sessions = Array.from({ length: 500 }, (_, i) => `session-${i}`);
    const before = sessions.filter((id) => inSample(id, 0.2, 'review')).join(',');
    const after = sessions.filter((id) => inSample(id, 0.2, 'review-2')).join(',');
    expect(before).not.toBe(after);
  });
});
