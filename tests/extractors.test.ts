import { describe, expect, it } from 'vitest';
import {
  computeTalkRatio,
  extractCommitments,
  extractComplianceConcerns,
  extractFacts,
  extractObjections,
  isOurSide,
  type Segment,
} from '@/lib/ai/extractors';

function segments(lines: Array<[string, string]>): Segment[] {
  let cursor = 0;
  return lines.map(([speaker, text]) => {
    const duration = Math.max(3, Math.round(text.split(/\s+/).length / 2.6));
    const segment = { speaker, startSec: cursor, endSec: cursor + duration, text };
    cursor += duration;
    return segment;
  });
}

describe('isOurSide', () => {
  it('matches our caller by name token', () => {
    expect(isOurSide('Dana', 'Dana Whitfield')).toBe(true);
    expect(isOurSide('Whitfield', 'Dana Whitfield')).toBe(true);
  });

  it('matches generic labels for our side', () => {
    expect(isOurSide('Caller')).toBe(true);
    expect(isOurSide('Agent')).toBe(true);
  });

  it('does not treat a contact name containing a hint substring as our side', () => {
    // "Marcus" contains "us" and "Mel" contains "me" — substring matching here
    // would silently discard everything the other party said.
    expect(isOurSide('Marcus Bell', 'Dana Whitfield')).toBe(false);
    expect(isOurSide('Mel Ramirez', 'Dana Whitfield')).toBe(false);
    expect(isOurSide('Agatha Prescott', 'Dana Whitfield')).toBe(false);
  });
});

describe('extractFacts', () => {
  it('extracts money, quantity, dates and crews from the other party only', () => {
    const facts = extractFacts(
      segments([
        ['Caller', 'We can definitely do it for $50,000 with ten crews.'],
        ['Marcus Bell', 'We spend about $14,000 per month across nine properties.'],
        ['Marcus Bell', 'We would want to start 2026-09-01.'],
        ['Marcus Bell', 'We run four crews out of the Fairview yard.'],
      ]),
      'Dana Whitfield',
    );

    const keys = facts.map((f) => f.factKey);
    expect(keys).toContain('pricing.monthly_amount');
    expect(keys).toContain('need.start_date');
    expect(keys).toContain('capacity.crew_count');

    // The caller's own $50,000 must not become a business fact about them.
    expect(facts.every((f) => f.factValue !== '50000')).toBe(true);
  });

  it('records a licence number as claimed, never confirmed', () => {
    const facts = extractFacts(segments([['Rosa Delgado', 'Our license number is OH-EL-44821.']]));
    const licence = facts.find((f) => f.factKey === 'capacity.license');
    expect(licence?.factValue).toBe('OH-EL-44821');
    // A number read out on a call is a claim until the issuing authority
    // confirms it — treating it as confirmed is how unlicensed work gets let.
    expect(licence?.status).toBe('CLAIMED');
  });

  it('flags relative dates as estimated rather than claimed', () => {
    const facts = extractFacts(segments([['Rosa Delgado', 'We could start next month if the scope is ready.']]));
    const date = facts.find((f) => f.factKey.includes('date') || f.factKey.includes('start'));
    expect(date?.status).toBe('ESTIMATED');
  });

  it('captures incumbent dissatisfaction and switching posture', () => {
    const facts = extractFacts(
      segments([
        ['Marcus Bell', 'We use Nationwide Facility Products and they had repeated stockouts last quarter.'],
        ['Marcus Bell', 'We are shopping around at this point.'],
      ]),
    );
    expect(facts.some((f) => f.factKey === 'need.current_provider' && f.factValue.includes('Nationwide'))).toBe(true);
    expect(facts.some((f) => f.factKey === 'need.provider_issue')).toBe(true);
    expect(facts.some((f) => f.factKey === 'need.switching_willingness' && f.factValue === 'open')).toBe(true);
  });

  it('detects a locked relationship distinctly from an open one', () => {
    const facts = extractFacts(segments([['Terrence Boone', 'We are under contract with them through next year.']]));
    expect(facts.some((f) => f.factKey === 'need.switching_willingness' && f.factValue === 'locked')).toBe(true);
  });

  it('carries the source quote on every fact', () => {
    const facts = extractFacts(segments([['Marcus Bell', 'The budget is about $14,000 per month.']]));
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.every((f) => f.sourceQuote.length > 0)).toBe(true);
  });
});

describe('extractCommitments', () => {
  it('separates authorised commitments from ones exceeding caller authority', () => {
    const commitments = extractCommitments(
      segments([
        ['Caller', "I'll send you the scope this afternoon."],
        ['Caller', 'I guarantee we can beat their price.'],
        ['Marcus Bell', "I'll review it and get back to you Friday."],
      ]),
      'Dana Whitfield',
    );

    const ours = commitments.filter((c) => c.madeBy === 'us');
    const theirs = commitments.filter((c) => c.madeBy === 'them');

    expect(theirs.length).toBeGreaterThan(0);
    expect(ours.some((c) => !c.isAuthorized && /guarantee/i.test(c.text))).toBe(true);
    expect(ours.some((c) => c.isAuthorized && /send/i.test(c.text))).toBe(true);
  });

  it('flags exclusivity discussion by our own caller', () => {
    const commitments = extractCommitments(segments([['Caller', 'We can give you exclusivity in Fairview.']]), 'Dana Whitfield');
    expect(commitments.some((c) => !c.isAuthorized && c.issue === 'Discussed exclusivity')).toBe(true);
  });
});

describe('extractObjections and compliance', () => {
  it('categorises objections from the other party', () => {
    const objections = extractObjections(
      segments([
        ['Marcus Bell', 'Honestly that is too expensive for what we are getting.'],
        ['Marcus Bell', "I don't make that decision, you would need to speak to procurement."],
      ]),
    );
    expect(objections.map((o) => o.category)).toEqual(expect.arrayContaining(['price', 'authority']));
  });

  it('detects do-not-call and recording refusals', () => {
    const concerns = extractComplianceConcerns(
      segments([
        ['Marcus Bell', 'Take me off your list please.'],
        ['Marcus Bell', 'And do not record this call.'],
      ]),
    );
    expect(concerns.map((c) => c.concern)).toEqual(expect.arrayContaining(['do_not_call_request', 'recording_refusal']));
  });
});

describe('computeTalkRatio', () => {
  it('measures our share of the conversation', () => {
    const ratio = computeTalkRatio(
      segments([
        ['Caller', 'a '.repeat(50)],
        ['Marcus Bell', 'b '.repeat(50)],
      ]),
      'Dana Whitfield',
    );
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(0.6);
  });
});

describe('insurance and pricing keys', () => {
  it('keys insurance limits by coverage type so two limits do not collide', () => {
    const facts = extractFacts(
      segments([['Rosa Delgado', 'We carry $2,000,000 general liability and $1,000,000 workers comp.']]),
    );
    const keys = facts.map((f) => f.factKey);
    expect(keys).toContain('capacity.insurance_limit.general_liability');
    expect(keys).toContain('capacity.insurance_limit.workers_comp');
    // Same key for both would make the second reading look like a contradiction.
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('distinguishes a monthly rate from a one-off job price', () => {
    const monthly = extractFacts(segments([['Marcus Bell', 'We spend $14,000 per month on that.']]));
    expect(monthly.some((f) => f.factKey === 'pricing.monthly_amount')).toBe(true);

    const oneOff = extractFacts(segments([['Elena Vasquez', 'The cleaning package is about $85,000 for the job.']]));
    expect(oneOff.some((f) => f.factKey === 'pricing.amount')).toBe(true);
  });
});
