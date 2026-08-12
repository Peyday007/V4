import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { attribute, mayNameAPerson } from '@/lib/manager/attribution';
import {
  attemptOutsideCallingHours,
  attemptWithoutEvidence,
  dispositionContradictsTranscript,
  duplicateAttempt,
  factsRecordedWithoutContact,
  followUpPromiseMissed,
  promiseNotScheduled,
  qualifiedWithoutFacts,
  type AttemptRecord,
} from '@/lib/manager/consistency';
import { recommend, RESTORATION } from '@/lib/manager/ladder';
import { findStrengths } from '@/lib/manager/strengths';
import {
  ALL_CAPABILITIES, CAPABILITY_LABELS, needsOwnerAuthority, restrictsWork,
  RUNG_LABELS, RUNG_ORDER, rungRank,
} from '@/lib/manager/rules';
import { DEFAULT_CONFIG } from '@/lib/config';
import type { CallerScorecard } from '@/lib/measure/analytics';

const RULES = DEFAULT_CONFIG.managerRules;

const attempt = (over: Partial<AttemptRecord> = {}): AttemptRecord => ({
  id: 'a1',
  routeId: 'r1',
  userId: 'u1',
  disposition: 'REACHED_DECISION_MAKER',
  notes: 'Spoke to the facilities manager; contract renews in March.',
  discovery: { incumbent: 'CleanCo' },
  occurredAt: new Date('2026-08-11T15:00:00Z'),
  timezone: 'America/New_York',
  companyName: 'Ironside Manufacturing',
  ...over,
});

// ---------------------------------------------------------------------------
describe('the ladder is a ladder', () => {
  it('has exactly the eight rungs the directive names, in its order', () => {
    expect(RUNG_ORDER).toEqual([
      'INLINE_GUIDANCE', 'REQUIRED_CORRECTION', 'MICRO_COACHING', 'WARNING',
      'RESTRICTED_MODE', 'CAPABILITY_PAUSE', 'SECURITY_RESTRICTION', 'OWNER_ESCALATION',
    ]);
  });

  it('ranks strictly increasing, so "no lower than last time" means something', () => {
    for (let at = 1; at < RUNG_ORDER.length; at += 1) {
      expect(rungRank(RUNG_ORDER[at])).toBeGreaterThan(rungRank(RUNG_ORDER[at - 1]));
    }
  });

  it('every rung has words a person can read', () => {
    for (const rung of RUNG_ORDER) expect(RUNG_LABELS[rung].length).toBeGreaterThan(4);
  });

  it('every capability has a restoration rule written in advance', () => {
    for (const capability of ALL_CAPABILITIES) {
      expect(RESTORATION[capability]).toBeTruthy();
      // A restoration rule has to describe evidence, not a mood. Every one of
      // these names a countable thing.
      expect(RESTORATION[capability]).toMatch(/\b(one|two|three|ten|a week)\b/i);
      expect(CAPABILITY_LABELS[capability].length).toBeGreaterThan(3);
    }
  });

  it('the rungs that stop work are exactly the ones that need a restoration rule', () => {
    const stopping = RUNG_ORDER.filter(restrictsWork);
    expect(stopping).toEqual(['RESTRICTED_MODE', 'CAPABILITY_PAUSE', 'SECURITY_RESTRICTION']);
  });

  it('and the database holds the same list, so the two cannot drift apart', () => {
    const sql = readFileSync('prisma/migrations/20260812220000_system_manager/migration.sql', 'utf8');
    for (const rung of RUNG_ORDER.filter(restrictsWork)) {
      expect(sql).toContain(`'${rung}'`);
    }
    expect(sql).toContain('Intervention_restrictions_define_their_own_end');
    expect(sql).toContain('Intervention_system_faults_are_never_a_persons_fault');
  });

  it('two rungs are the owner\'s whatever the configuration says', () => {
    expect(needsOwnerAuthority('SECURITY_RESTRICTION')).toBe(true);
    expect(needsOwnerAuthority('OWNER_ESCALATION')).toBe(true);
    expect(needsOwnerAuthority('CAPABILITY_PAUSE')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('a system failure is never somebody\'s fault', () => {
  const at = new Date('2026-08-11T15:00:00Z');

  it('an intrinsic failure of ours settles it before anything else is asked', () => {
    const verdict = attribute({ at, callerId: 'u1', intrinsic: 'TRANSCRIPTION_FAILED' });
    expect(verdict.attribution).toBe('SYSTEM_FAULT');
    expect(verdict.because).toMatch(/not counted against anybody/);
    expect(mayNameAPerson(verdict.attribution)).toBe(false);
  });

  it('an open incident on the same work covers it', () => {
    const verdict = attribute({
      at,
      callerId: 'u1',
      incidents: [{
        id: 'i1', kind: 'SAVE_FAILURE', createdAt: new Date('2026-08-11T14:30:00Z'),
        resolvedAt: null, callerId: 'u1', routeId: null, detail: 'The save failed on our side.',
      }],
    });
    expect(verdict.attribution).toBe('SYSTEM_FAULT');
    expect(verdict.evidence[0].ref).toContain('WorkIncident:i1');
  });

  it('an unresolved incident has not ended, so a later observation is still covered', () => {
    const verdict = attribute({
      at: new Date('2026-08-11T23:00:00Z'),
      callerId: 'u1',
      incidents: [{
        id: 'i1', kind: 'INTEGRATION_FAILURE', createdAt: new Date('2026-08-11T09:00:00Z'),
        resolvedAt: null, callerId: 'u1', routeId: null, detail: 'The dialer is down.',
      }],
    });
    expect(verdict.attribution).toBe('SYSTEM_FAULT');
  });

  it('a resolved incident from days ago does not', () => {
    const verdict = attribute({
      at,
      callerId: 'u1',
      incidents: [{
        id: 'i1', kind: 'SAVE_FAILURE', createdAt: new Date('2026-08-05T09:00:00Z'),
        resolvedAt: new Date('2026-08-05T10:00:00Z'), callerId: 'u1', routeId: null, detail: 'Fixed.',
      }],
    });
    expect(verdict.attribution).toBe('UNDETERMINED');
  });

  it('an incident about a different person does not cover this one', () => {
    const verdict = attribute({
      at,
      callerId: 'u1',
      incidents: [{
        id: 'i1', kind: 'SAVE_FAILURE', createdAt: at, resolvedAt: null,
        callerId: 'somebody-else', routeId: null, detail: 'Theirs, not this.',
      }],
    });
    expect(verdict.attribution).toBe('UNDETERMINED');
  });

  it('an open breaker on the capability the work needed covers it', () => {
    const verdict = attribute({
      at,
      callerId: 'u1',
      capability: 'CALL_RECORDING',
      breakers: [{
        id: 'b1', capability: 'CALL_RECORDING',
        openedAt: new Date('2026-08-11T08:00:00Z'), closedAt: null,
        openedBecause: '9 of 10 captures produced nothing.',
      }],
    });
    expect(verdict.attribution).toBe('SYSTEM_FAULT');
    expect(verdict.because).toMatch(/recording calls was stopped/);
  });

  it('a breaker on a different capability does not', () => {
    const verdict = attribute({
      at,
      callerId: 'u1',
      capability: 'CALL_PLACING',
      breakers: [{
        id: 'b1', capability: 'DEAL_ROOM_SENDING', openedAt: new Date('2026-08-11T08:00:00Z'),
        closedAt: null, openedBecause: 'Email is down.',
      }],
    });
    expect(verdict.attribution).toBe('UNDETERMINED');
  });

  it('and nothing in the file can ever conclude a person was at fault', () => {
    const source = readFileSync('lib/manager/attribution.ts', 'utf8');
    // The value appears in the type import and in the "may name a person"
    // helper; it must never appear as a returned attribution.
    expect(source).not.toMatch(/attribution:\s*'OPERATOR'/);
    for (const input of [
      { at, callerId: 'u1' },
      { at, callerId: null, capability: 'CALL_PLACING' as const },
      { at, callerId: 'u1', incidents: [], breakers: [] },
    ]) {
      expect(attribute(input).attribution).not.toBe('OPERATOR');
    }
  });

  it('says the health was checked either way, so nobody has to wonder', () => {
    expect(attribute({ at, callerId: 'u1' }).healthChecked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('consistency findings are questions, not accusations', () => {
  const all = () => [
    attemptWithoutEvidence(attempt({ notes: null, discovery: {} })),
    promiseNotScheduled(attempt({ disposition: 'FOLLOW_UP' }), null),
    duplicateAttempt(
      attempt({ id: 'a2', occurredAt: new Date('2026-08-11T15:02:00Z') }),
      { id: 'a1', occurredAt: new Date('2026-08-11T15:00:00Z'), disposition: 'NO_ANSWER' },
    ),
    attemptOutsideCallingHours(attempt({ occurredAt: new Date('2026-08-11T04:00:00Z') }), DEFAULT_CONFIG),
    factsRecordedWithoutContact(attempt({ disposition: 'NO_ANSWER' })),
    qualifiedWithoutFacts({
      routeId: 'r1', callerId: 'u1', status: 'QUALIFIED',
      confirmedNeed: null, confirmedTiming: null, budgetNote: null,
      hasRequirement: false, at: new Date(), companyName: 'Ironside',
    }),
    followUpPromiseMissed({
      routeId: 'r1', callerId: 'u1',
      dueAt: new Date('2026-08-01T12:00:00Z'), now: new Date('2026-08-11T12:00:00Z'),
      lastAttemptAt: null, companyName: 'Ironside',
    }),
  ].filter((f) => f !== null);

  it('produces every kind it claims to', () => {
    expect(all().length).toBe(7);
  });

  it('every finding names more than one ordinary innocent explanation', () => {
    for (const finding of all()) {
      // More than one, deliberately. A single alternative reads as a token
      // gesture next to the observation; two or three make the point that the
      // record genuinely cannot tell these apart.
      expect(finding!.benignAlternatives.length).toBeGreaterThan(1);
      for (const alternative of finding!.benignAlternatives) {
        expect(alternative.length).toBeGreaterThan(20);
      }
    }
  });

  it('and every finding that a system failure could produce says so', () => {
    // The one explanation that must never be missing. Each of these is a
    // finding whose commonest innocent cause is our own machinery, and a list
    // that omits it puts an outage in front of somebody as their question.
    // Deliberately narrow. "They typed it into the other screen" is an
    // explanation in which the person did something; this asks for one in which
    // our own machinery lost it, which is the reading nobody volunteers.
    const systemExplains = /\bsave\b[^.]*\b(drop|dropped|fail|failed|lost)\b|fail(ed)? on our side|never (appeared|reached)/i;
    for (const finding of [
      attemptWithoutEvidence(attempt({ notes: null, discovery: {} })),
      promiseNotScheduled(attempt({ disposition: 'FOLLOW_UP' }), null),
      followUpPromiseMissed({
        routeId: 'r1', callerId: 'u1',
        dueAt: new Date('2026-08-01T12:00:00Z'), now: new Date('2026-08-11T12:00:00Z'),
        lastAttemptAt: null,
      }),
    ]) {
      expect(finding).not.toBeNull();
      expect(
        finding!.benignAlternatives.some((a) => systemExplains.test(a)),
        `${finding!.kind} offers no explanation in which the system was at fault: ${finding!.benignAlternatives.join(' | ')}`,
      ).toBe(true);
    }
  });

  it('every finding points at the records it was read from', () => {
    for (const finding of all()) {
      expect(finding!.evidence.length).toBeGreaterThan(0);
      expect(finding!.evidence[0].ref).toMatch(/^[A-Za-z]+:/);
    }
  });

  it('every question is neutrally worded and never says a person did something wrong', () => {
    for (const finding of all()) {
      expect(finding!.question.length).toBeGreaterThan(20);
      expect(finding!.question).not.toMatch(/\b(lied|lying|falsif|fraud|dishonest|padding your|made up)\b/i);
    }
  });

  it('a call with notes is not a finding', () => {
    expect(attemptWithoutEvidence(attempt())).toBeNull();
  });

  it('a call with facts but no notes is not a finding either — a fact is evidence', () => {
    expect(attemptWithoutEvidence(attempt({ notes: null }))).toBeNull();
  });

  it('an unanswered call with nothing recorded is not a finding, because that is the norm', () => {
    expect(attemptWithoutEvidence(attempt({
      disposition: 'NO_ANSWER', notes: null, discovery: {},
    }))).toBeNull();
  });

  it('a promise with a date on it is not a finding', () => {
    expect(promiseNotScheduled(
      attempt({ disposition: 'FOLLOW_UP' }),
      { snoozeUntil: new Date('2026-08-20T12:00:00Z') },
    )).toBeNull();
  });

  it('a transcript disagreement is withheld when the audio cannot tell voices apart', () => {
    const withInterimAudio = attempt({
      disposition: 'REACHED_DECISION_MAKER',
      transcript: { sessionId: 's1', suggestedDisposition: 'NO_ANSWER', speakerSeparated: false },
    });
    expect(dispositionContradictsTranscript(withInterimAudio)).toBeNull();
  });

  it('and raised when it can', () => {
    const finding = dispositionContradictsTranscript(attempt({
      disposition: 'REACHED_DECISION_MAKER',
      transcript: { sessionId: 's1', suggestedDisposition: 'NO_ANSWER', speakerSeparated: true },
    }));
    expect(finding?.kind).toBe('DISPOSITION_CONTRADICTS_TRANSCRIPT');
    // And it says out loud that the recording is often the wrong one.
    expect(finding?.question).toMatch(/recording is often the one that is wrong/);
  });

  it('shades of the same outcome are not a disagreement worth anybody\'s time', () => {
    expect(dispositionContradictsTranscript(attempt({
      disposition: 'REACHED_DECISION_MAKER',
      transcript: { sessionId: 's1', suggestedDisposition: 'INTERESTED', speakerSeparated: true },
    }))).toBeNull();
  });

  it('two attempts far apart are not a duplicate', () => {
    expect(duplicateAttempt(
      attempt({ id: 'a2', occurredAt: new Date('2026-08-11T16:00:00Z') }),
      { id: 'a1', occurredAt: new Date('2026-08-11T15:00:00Z'), disposition: 'NO_ANSWER' },
    )).toBeNull();
  });

  it('a redial is the first explanation offered, not the last', () => {
    const finding = duplicateAttempt(
      attempt({ id: 'a2', occurredAt: new Date('2026-08-11T15:02:00Z') }),
      { id: 'a1', occurredAt: new Date('2026-08-11T15:00:00Z'), disposition: 'NO_ANSWER' },
    );
    expect(finding?.benignAlternatives[0]).toMatch(/dropped/i);
  });

  it('a call inside hours is not a finding', () => {
    // 15:00 UTC is 11:00 in New York, comfortably inside 08:00–20:00.
    expect(attemptOutsideCallingHours(attempt(), DEFAULT_CONFIG)).toBeNull();
  });

  it('a call judged against the buyer\'s clock, not ours', () => {
    // 03:00 UTC is 20:00 the previous evening in Los Angeles: outside, because
    // the window ends at 20:00. The same instant is 23:00 in New York.
    const pacific = attemptOutsideCallingHours(
      attempt({ occurredAt: new Date('2026-08-12T03:00:00Z'), timezone: 'America/Los_Angeles' }),
      DEFAULT_CONFIG,
    );
    expect(pacific?.kind).toBe('ATTEMPT_OUTSIDE_CALLING_HOURS');
    expect(pacific?.observed).toContain('America/Los_Angeles');
  });

  it('a missed follow-up inside the grace period is not yet a finding', () => {
    expect(followUpPromiseMissed({
      routeId: 'r1', callerId: 'u1',
      dueAt: new Date('2026-08-11T09:00:00Z'), now: new Date('2026-08-11T15:00:00Z'),
      lastAttemptAt: null,
    })).toBeNull();
  });

  it('and one that was actually called is never a finding', () => {
    expect(followUpPromiseMissed({
      routeId: 'r1', callerId: 'u1',
      dueAt: new Date('2026-08-01T09:00:00Z'), now: new Date('2026-08-11T15:00:00Z'),
      lastAttemptAt: new Date('2026-08-01T14:00:00Z'),
    })).toBeNull();
  });

  it('a qualified route with any one confirmed fact is not a finding', () => {
    for (const facts of [
      { confirmedNeed: 'They need nightly cleaning for two sites.' },
      { confirmedTiming: 'March, when the current contract ends.' },
      { budgetNote: 'Around forty thousand a year.' },
    ]) {
      expect(qualifiedWithoutFacts({
        routeId: 'r1', callerId: 'u1', status: 'QUALIFIED',
        confirmedNeed: null, confirmedTiming: null, budgetNote: null,
        hasRequirement: false, at: new Date(), ...facts,
      })).toBeNull();
    }
  });

  it('and one with a captured requirement is not, whatever the outreach fields say', () => {
    expect(qualifiedWithoutFacts({
      routeId: 'r1', callerId: 'u1', status: 'QUALIFIED',
      confirmedNeed: null, confirmedTiming: null, budgetNote: null,
      hasRequirement: true, at: new Date(),
    })).toBeNull();
  });

  it('confidence is about the records disagreeing, never about a person', () => {
    for (const finding of all()) {
      expect(finding!.confidence).toBeGreaterThan(0);
      expect(finding!.confidence).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
describe('the smallest sufficient intervention', () => {
  const base = {
    kind: 'ATTEMPT_WITHOUT_EVIDENCE' as const,
    attribution: 'OPERATOR' as const,
    priorConfirmed: 0,
    priorRungs: [],
    attempts: 60,
    rules: RULES,
  };

  it('nothing at all follows from a system failure', () => {
    const result = recommend({ ...base, attribution: 'SYSTEM_FAULT' });
    expect(result.rung).toBeNull();
    expect(result.reason).toMatch(/incident, not an intervention/);
  });

  it('nothing follows from a case nobody has concluded', () => {
    expect(recommend({ ...base, attribution: 'UNDETERMINED' }).rung).toBeNull();
  });

  it('nothing follows from a caller with too little work to read', () => {
    const result = recommend({ ...base, attempts: 4 });
    expect(result.rung).toBeNull();
    expect(result.reason).toMatch(/not enough work here to call anything a pattern/);
  });

  it('the first time is a record to fix, not a warning', () => {
    expect(recommend(base).rung).toBe('REQUIRED_CORRECTION');
  });

  it('the second is coaching', () => {
    expect(recommend({ ...base, priorConfirmed: 1, priorRungs: ['REQUIRED_CORRECTION'] }).rung)
      .toBe('MICRO_COACHING');
  });

  it('the third is a warning', () => {
    expect(recommend({ ...base, priorConfirmed: 2, priorRungs: ['REQUIRED_CORRECTION', 'MICRO_COACHING'] }).rung)
      .toBe('WARNING');
  });

  it('a restriction needs a body of confirmed cases behind it, not a bad sequence', () => {
    // Four occurrences would ordinarily reach RESTRICTED_MODE. With the floor
    // set above the count, the answer is nothing at all rather than a
    // restriction — the sequence alone does not earn one.
    const thin = recommend({
      ...base,
      priorConfirmed: 3,
      priorRungs: ['REQUIRED_CORRECTION', 'MICRO_COACHING', 'WARNING'],
      rules: { ...RULES, minCasesBeforeRestriction: 5 },
    });
    expect(thin.rung).toBeNull();

    // And with the floor met, the same input does reach one — so the test above
    // is measuring the floor rather than some other refusal.
    const met = recommend({
      ...base,
      priorConfirmed: 3,
      priorRungs: ['REQUIRED_CORRECTION', 'MICRO_COACHING', 'WARNING'],
      rules: { ...RULES, minCasesBeforeRestriction: 3 },
    });
    expect(met.rung).toBe('RESTRICTED_MODE');
  });

  it('and when it comes, it is on the capability the mistake was in', () => {
    const restricted = recommend({
      ...base,
      priorConfirmed: 3,
      priorRungs: ['REQUIRED_CORRECTION', 'MICRO_COACHING', 'WARNING'],
    });
    expect(restricted.rung).toBe('RESTRICTED_MODE');
    expect(restricted.capability).toBe('CALL_PLACING');
    expect(restricted.restorationRule).toBe(RESTORATION.CALL_PLACING);
  });

  it('a requirement-capture mistake never costs somebody the phone', () => {
    const restricted = recommend({
      ...base,
      kind: 'QUALIFIED_WITHOUT_FACTS',
      priorConfirmed: 3,
      priorRungs: ['REQUIRED_CORRECTION', 'MICRO_COACHING', 'WARNING'],
    });
    expect(restricted.capability).toBe('REQUIREMENT_CAPTURE');
  });

  it('a compliance breach starts higher and reaches a pause sooner', () => {
    const first = recommend({ ...base, kind: 'ATTEMPT_OUTSIDE_CALLING_HOURS' });
    expect(first.rung).toBe('REQUIRED_CORRECTION');
    expect(first.reason).toMatch(/compliance rule/);

    const third = recommend({
      ...base,
      kind: 'ATTEMPT_OUTSIDE_CALLING_HOURS',
      priorConfirmed: 3,
      priorRungs: ['REQUIRED_CORRECTION', 'WARNING'],
    });
    expect(third.rung).toBe('CAPABILITY_PAUSE');
  });

  it('never goes backwards from a rung somebody has already had', () => {
    const result = recommend({ ...base, priorConfirmed: 0, priorRungs: ['WARNING'] });
    expect(result.rung === null || rungRank(result.rung) > rungRank('WARNING')).toBe(true);
  });

  it('everything above coaching is recorded in shadow by default', () => {
    const warning = recommend({
      ...base, priorConfirmed: 2, priorRungs: ['REQUIRED_CORRECTION', 'MICRO_COACHING'],
    });
    expect(warning.rung).toBe('WARNING');
    expect(warning.enforce).toBe(false);
    expect(warning.enforcementNote).toMatch(/shadow/i);
  });

  it('and the default operating rules enable only the three that do not stop work', () => {
    expect(RULES.enforceableRungs).toEqual(['INLINE_GUIDANCE', 'REQUIRED_CORRECTION', 'MICRO_COACHING']);
    for (const rung of RULES.enforceableRungs) expect(restrictsWork(rung)).toBe(false);
  });

  it('an owner-only rung is never enforced by a rule, whatever the flags say', () => {
    const permissive = { ...RULES, enforceableRungs: [...RUNG_ORDER] };
    const escalation = recommend({
      ...base,
      kind: 'ATTEMPT_OUTSIDE_CALLING_HOURS',
      priorConfirmed: 9,
      priorRungs: ['CAPABILITY_PAUSE', 'SECURITY_RESTRICTION'],
      rules: permissive,
    });
    expect(escalation.rung).toBe('OWNER_ESCALATION');
    expect(needsOwnerAuthority(escalation.rung!)).toBe(true);
    expect(escalation.enforce).toBe(false);
    expect(escalation.ownerOnly).toBe(true);
    expect(escalation.enforcementNote).toMatch(/owner's to apply/);
  });

  it('every rung that stops work carries the way back out of it', () => {
    const permissive = { ...RULES, enforceableRungs: [...RUNG_ORDER], minCasesBeforeRestriction: 0 };
    let restricting = 0;
    for (let prior = 0; prior < 8; prior += 1) {
      const result = recommend({ ...base, priorConfirmed: prior, priorRungs: RUNG_ORDER.slice(0, prior), rules: permissive });
      if (result.rung && restrictsWork(result.rung)) {
        restricting += 1;
        expect(result.restorationRule).toBeTruthy();
        expect(result.capability).not.toBeNull();
      }
    }
    // Without this the loop above passes by never reaching a restricting rung,
    // which is the shape of a test that checks nothing.
    expect(restricting).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe('strengths are found, and withheld honestly', () => {
  const card = (over: Partial<CallerScorecard> = {}): CallerScorecard => ({
    callerId: 'u1',
    name: 'Dana',
    assigned: 100, worked: 90, untouched: 10,
    organisationsContacted: 60, attempts: 90,
    answered: rate(30, 90), relevantPerson: rate(20, 90),
    needConfirmed: rate(5, 90), quoteRequested: rate(2, 90),
    promisesMade: 10, promisesKept: 10,
    discoveryCompleteness: rate(80, 90),
    emptyOutcomes: 0,
    dealsInfluenced: 0, collectedGrossProfitInfluenced: 0,
    mix: {}, insufficientEvidence: null, systemIncidents: 0,
    ...over,
  });

  it('refuses to compare a single caller against themselves', () => {
    const found = findStrengths([card()]);
    expect(found.strengths).toHaveLength(0);
    expect(found.withheld.join(' ')).toMatch(/"best of one" is not a finding/);
  });

  it('names the callers left out for a thin sample rather than dropping them silently', () => {
    const found = findStrengths([
      card(),
      card({ callerId: 'u2', name: 'Sam', insufficientEvidence: 'Only 3 attempts.' }),
      card({ callerId: 'u3', name: 'Kim' }),
    ]);
    expect(found.withheld.join(' ')).toMatch(/1 caller\(s\) are absent/);
  });

  it('does not reward reaching more people while writing less down', () => {
    const speedy = card({
      callerId: 'u2', name: 'Fast',
      relevantPerson: rate(60, 90),
      discoveryCompleteness: rate(10, 90),
      emptyOutcomes: 14,
    });
    const found = findStrengths([speedy, card(), card({ callerId: 'u3', name: 'Kim' })]);
    expect(found.strengths.some((s) => s.callerName === 'Fast' && /Gets to the person/.test(s.what))).toBe(false);
  });

  it('credits somebody who is genuinely ahead, with the interval on the claim', () => {
    const strong = card({
      callerId: 'u2', name: 'Ada',
      relevantPerson: rate(60, 120),
      discoveryCompleteness: rate(115, 120),
      attempts: 120,
    });
    const found = findStrengths([strong, card({ callerId: 'u3', name: 'Kim', relevantPerson: rate(8, 90) }), card()]);
    const claim = found.strengths.find((s) => s.callerName === 'Ada');
    expect(claim).toBeTruthy();
    expect(claim!.evidence).toMatch(/%–\d+%/);
  });

  it('a lead that the interval does not support is not a strength', () => {
    // 40% against a median of 30% looks like a clear lead and is not one: on
    // thirty attempts the interval runs from about 25% to 59%, which includes
    // the pack. This is the difference between a finding and a fortnight.
    const ahead = card({
      callerId: 'u2', name: 'Lucky',
      attempts: 30, relevantPerson: rate(12, 30), discoveryCompleteness: rate(27, 30),
      promisesMade: 10, promisesKept: 10, emptyOutcomes: 0,
    });
    const pack = [
      card({ callerId: 'u3', name: 'Sam', attempts: 30, relevantPerson: rate(9, 30), discoveryCompleteness: rate(27, 30) }),
      card({ callerId: 'u4', name: 'Kim', attempts: 30, relevantPerson: rate(9, 30), discoveryCompleteness: rate(27, 30) }),
    ];
    expect(rate(12, 30).rate!).toBeGreaterThan(0.3);
    expect(rate(12, 30).low!).toBeLessThan(0.3);

    const found = findStrengths([ahead, ...pack]);
    expect(found.strengths.filter((s) => s.callerName === 'Lucky')).toHaveLength(0);
  });

  it('three identical callers produce no ranking at all, and say so', () => {
    const flat = [card(), card({ callerId: 'u2', name: 'Sam' }), card({ callerId: 'u3', name: 'Kim' })];
    const found = findStrengths(flat);
    // Identical scorecards: nobody's interval can clear the median, so the
    // honest output is nothing plus an explanation. A ranking here would be
    // three-way noise presented as a league table.
    expect(found.strengths.filter((s) => /Gets to the person/.test(s.what))).toHaveLength(0);
    expect(found.withheld.join(' ')).toMatch(/not evidence that nobody did well|absent from this section/);
  });

  it('a suggestion is always something to do, never a compliment', () => {
    const strong = card({
      callerId: 'u2', name: 'Ada',
      relevantPerson: rate(60, 120), discoveryCompleteness: rate(115, 120), attempts: 120,
      collectedGrossProfitInfluenced: 4200, dealsInfluenced: 2,
    });
    const found = findStrengths([strong, card({ callerId: 'u3', name: 'Kim' }), card()]);
    for (const claim of found.strengths) {
      expect(claim.suggestion).not.toMatch(/^(well done|great|excellent)/i);
      expect(claim.suggestion.length).toBeGreaterThan(30);
    }
  });
});

function rate(successes: number, trials: number) {
  const p = trials > 0 ? successes / trials : null;
  // Enough of a Wilson interval for the tests that read one; the real thing is
  // exercised in the measurement suite.
  const z = 1.96;
  if (p === null) return { successes, trials, rate: null, low: null, high: null, width: null, weak: true };
  const denom = 1 + (z * z) / trials;
  const centre = (p + (z * z) / (2 * trials)) / denom;
  const spread = (z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))) / denom;
  return {
    successes, trials, rate: p,
    low: Math.max(0, centre - spread),
    high: Math.min(1, centre + spread),
    width: 2 * spread,
    weak: trials < 20,
  };
}
