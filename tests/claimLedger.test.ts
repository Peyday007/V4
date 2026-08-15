import { describe, expect, it } from 'vitest';
import type { Claim } from '@prisma/client';
import { validateClaim, claimToEvidenced, ledgerSummary, type ClaimInput } from '@/lib/evidence/ledger';
import { discoveryClaims } from '@/lib/evidence/discoveryClaims';
import type { MoneyRange } from '@/lib/demand/economics';
import { answersAgree, callClaims } from '@/lib/evidence/callClaims';

/**
 * The rules that decide what may go on the record and what it means once it is
 * there.
 *
 * The store itself is proved against Postgres in `claimLedgerAudit` — a
 * contradiction is a two-row transaction and testing it against a mock would
 * prove the mock. What is tested here is everything that decides *what* gets
 * written, because that is where a product quietly starts claiming more than it
 * knows.
 */

const base: ClaimInput = {
  routeId: 'r1',
  about: 'BUYER',
  key: 'buyer.need',
  statement: 'They need overflow storage.',
  standing: 'CONFIRMED',
  sourceKind: 'PERSON',
  sourceLabel: 'The facilities manager said so on 2026-08-01.',
};

describe('what may be recorded', () => {
  it('accepts a confirmed claim with no corrective action', () => {
    expect(validateClaim(base)).toBeNull();
  });

  it('refuses an inference that does not say what would settle it', () => {
    const problem = validateClaim({ ...base, standing: 'INFERRED', confidence: 0.4 });
    expect(problem).toMatch(/what would settle it/);
  });

  it('refuses a gap that does not say what would settle it', () => {
    // The rule that stops the ledger becoming a list of shrugs. An unknown
    // nobody can act on is worse than an omission, because it looks like work.
    expect(validateClaim({ ...base, standing: 'UNKNOWN', value: undefined })).toMatch(/what would settle it/);
  });

  it('refuses a confidence on a confirmed fact', () => {
    expect(validateClaim({ ...base, confidence: 0.9 })).toMatch(/only meaningful on an inference/);
  });

  it('refuses a confidence outside nought and one', () => {
    const problem = validateClaim({
      ...base, standing: 'INFERRED', confidence: 4, correctiveAction: 'Ring them.',
    });
    expect(problem).toMatch(/between nought and one/);
  });

  it('refuses an unknown carrying a value', () => {
    // A value under an "unknown" is an inference that has escaped its label.
    const problem = validateClaim({
      ...base, standing: 'UNKNOWN', value: { amount: 4000 }, correctiveAction: 'Ask them.',
    });
    expect(problem).toMatch(/carries no value/);
  });

  it('refuses a claim that does not say where it came from', () => {
    expect(validateClaim({ ...base, sourceLabel: '  ' })).toMatch(/where it came from/);
  });
});

// ---------------------------------------------------------------------------

const claim = (over: Partial<Claim>): Claim => ({
  id: 'c1',
  orgId: 'o1',
  dataMode: 'PRODUCTION',
  routeId: 'r1',
  about: 'BUYER',
  key: 'buyer.need',
  statement: 'They need overflow storage.',
  value: null,
  standing: 'CONFIRMED',
  sourceKind: 'PERSON',
  sourceLabel: 'A person said so.',
  sourceRef: null,
  observedAt: null,
  recordedAt: new Date('2026-08-01'),
  confidence: null,
  correctiveAction: null,
  supersededAt: null,
  supersededById: null,
  contradictsId: null,
  companyId: null,
  contactId: null,
  ...over,
} as Claim);

describe('a claim, in the shape the screens already grade', () => {
  it('a person confirming something is confirmed by a person', () => {
    expect(claimToEvidenced(claim({})).evidence).toBe('CONFIRMED_BY_PERSON');
  });

  it('a published record is externally observed rather than confirmed', () => {
    const graded = claimToEvidenced(claim({ sourceKind: 'PUBLISHED_RECORD' }));
    expect(graded.evidence).toBe('EXTERNALLY_OBSERVED');
  });

  it('a disagreement grades as unknown, not as a weaker guess', () => {
    // The distinction that matters. Two sources disagreeing about a square
    // footage does not mean we roughly know it; averaging them would be the
    // worst answer available.
    const graded = claimToEvidenced(
      claim({ standing: 'CONTRADICTED', value: { answer: '40,000 sq ft' }, correctiveAction: 'Ring back.' }),
    );
    expect(graded.evidence).toBe('UNKNOWN');
    expect(graded.value).toBeNull();
    expect(graded.source).toMatch(/disagree/);
  });

  it('carries the corrective action through as what would confirm it', () => {
    const graded = claimToEvidenced(
      claim({ standing: 'INFERRED', confidence: 0.4, correctiveAction: 'Ring them and ask.' }),
    );
    expect(graded.toConfirm).toBe('Ring them and ask.');
  });

  it('states when the source said it, separately from when we wrote it down', () => {
    const graded = claimToEvidenced(claim({ observedAt: new Date('2026-01-14') }));
    expect(graded.source).toContain('2026-01-14');
  });
});

describe('what a ledger says about itself', () => {
  it('reports counts rather than a completeness score', () => {
    const summary = ledgerSummary([
      claim({ id: 'a' }),
      claim({ id: 'b', standing: 'INFERRED', key: 'x', confidence: 0.3, correctiveAction: 'Ask.' }),
      claim({ id: 'c', standing: 'UNKNOWN', key: 'y', correctiveAction: 'Ask.' }),
    ]);
    expect(summary.sentence).not.toMatch(/%/);
    expect(summary.confirmed).toBe(1);
    expect(summary.inferred).toBe(1);
    expect(summary.unknown).toBe(1);
  });

  it('puts disagreements at the front of the work queue', () => {
    const summary = ledgerSummary([
      claim({ id: 'a', standing: 'UNKNOWN', key: 'y', correctiveAction: 'Ask.' }),
      claim({ id: 'b', standing: 'CONTRADICTED', key: 'z', correctiveAction: 'Ring back.', contradictsId: 'a' }),
    ]);
    expect(summary.needsAction[0].standing).toBe('CONTRADICTED');
    expect(summary.sentence).toMatch(/unsafe to act on/);
  });

  it('ignores superseded readings when counting what is current', () => {
    const summary = ledgerSummary([
      claim({ id: 'a' }),
      claim({ id: 'old', supersededAt: new Date('2026-08-02'), supersededById: 'a' }),
    ]);
    expect(summary.confirmed).toBe(1);
  });
});

// ---------------------------------------------------------------------------

/** A modelled band, in the shape the pipeline now produces. */
const money = (low: number, high: number): MoneyRange => ({
  low,
  high,
  midpoint: Math.round((low + high) / 2),
  basis: 'Category prior for overflow storage, not a quote.',
  inputs: ['Overflow storage sells between $18,000 and $30,000 in this catalogue.'],
});

const discovery = {
  routeId: 'r1',
  companyId: 'co1',
  organisation: 'Northside Logistics',
  event: {
    type: 'OCCUPANCY_OR_OPERATING_APPROVAL',
    headline: 'Warehouse occupancy approved, 40,000 sq ft',
    sourceUrl: 'https://data.cityofchicago.org/record/1',
    connector: 'municipal_open_data',
    eventDate: new Date('2026-07-01'),
  },
  playbook: { key: 'warehouse.brokerage.overflow', label: 'Overflow storage', route: 'BROKERAGE' },
  needIsConfirmed: false,
  rationale: 'A new distribution centre often runs short of space in its first quarter.',
  buyerRole: 'BUYER',
  window: { label: 'Likely buying in the next 60 days', closesAt: new Date('2026-09-01') },
  fulfilment: { status: 'PROVIDERS_AVAILABLE', reason: 'Three matched.', providerCount: 3 },
  economics: {
    buyerPrice: money(18_000, 30_000),
    providerCost: money(13_500, 22_500),
    grossProfit: money(4_500, 7_500),
    basis: 'CATEGORY_TYPICAL',
  },
  compliance: { status: 'UNKNOWN', gaps: [] },
  structure: { structure: 'BROKERED_SERVICE', reason: 'We hold the buyer contract.' },
};

describe('what discovery claims when it builds a route', () => {
  const claims = discoveryClaims(discovery);
  const byKey = (key: string) => claims.find((c) => c.key === key);

  it('claims only the event itself as confirmed', () => {
    const confirmed = claims.filter((c) => c.standing === 'CONFIRMED');
    expect(confirmed.map((c) => c.key)).toEqual(['demand.event']);
  });

  it('records an unstated need as an inference naming the playbook and the call', () => {
    const need = byKey('buyer.need');
    expect(need?.standing).toBe('INFERRED');
    expect(need?.sourceKind).toBe('ENGINE_INFERENCE');
    // Concrete, not "verify the need".
    expect(need?.correctiveAction).toContain('Northside Logistics');
  });

  it('records a stated need as confirmed by the published record', () => {
    const stated = discoveryClaims({ ...discovery, needIsConfirmed: true }).find((c) => c.key === 'buyer.need');
    expect(stated?.standing).toBe('CONFIRMED');
    expect(stated?.sourceKind).toBe('PUBLISHED_RECORD');
    expect(stated?.correctiveAction).toBeUndefined();
  });

  it('never records money as anything but an inference', () => {
    const money = claims.filter((c) => c.key.startsWith('economics.'));
    expect(money.length).toBeGreaterThan(0);
    expect(money.every((c) => c.standing === 'INFERRED' || c.standing === 'UNKNOWN')).toBe(true);
    // And every figure that is shown is a band, never a point.
    expect(money.every((c) => c.standing !== 'INFERRED' || /between \$[\d,]+ and \$[\d,]+/.test(c.statement)))
      .toBe(true);
  });

  it('records a missing figure as a gap with an owner rather than omitting it', () => {
    const bare = discoveryClaims({
      ...discovery,
      economics: { buyerPrice: null, providerCost: null, grossProfit: null, basis: null },
    });
    const cost = bare.find((c) => c.key === 'economics.providerCost');
    expect(cost?.standing).toBe('UNKNOWN');
    expect(cost?.value).toBeUndefined();
    expect(cost?.correctiveAction).toMatch(/price it/);
  });

  it('records matched providers as an inference, never as available capacity', () => {
    const supply = byKey('provider.supply');
    expect(supply?.standing).toBe('INFERRED');
    // A directory listing is the provider's claim about themselves.
    expect(supply?.correctiveAction).toMatch(/capacity/);
  });

  it('records an event with no durable link as unverified rather than confirmed', () => {
    const unlinked = discoveryClaims({ ...discovery, event: { ...discovery.event, sourceUrl: null } });
    const event = unlinked.find((c) => c.key === 'demand.event');
    expect(event?.standing).toBe('INFERRED');
    expect(event?.correctiveAction).toMatch(/link/);
  });

  it('records an absent window as an open question with a next action', () => {
    const undated = discoveryClaims({ ...discovery, window: null });
    const timing = undated.find((c) => c.key === 'timing.window');
    expect(timing?.standing).toBe('UNKNOWN');
    expect(timing?.correctiveAction).toMatch(/when they need it/i);
  });

  it('gives every claim that is not confirmed something a person can do', () => {
    const unsettled = claims.filter((c) => c.standing !== 'CONFIRMED');
    expect(unsettled.length).toBeGreaterThan(0);
    for (const c of unsettled) expect(c.correctiveAction?.length ?? 0).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------

const call = {
  routeId: 'r1',
  companyId: 'co1',
  organisation: 'Northside Logistics',
  disposition: 'NEED_CONFIRMED' as const,
  discovery: { confirmedNeed: 'Two thousand pallet positions from October', timing: 'October', buyerRole: 'Ops manager' },
  callerName: 'Dana Whitlock',
  attemptId: 'a1',
  calledAt: new Date('2026-08-10'),
};

describe('what a call establishes', () => {
  it('records the answers as confirmed by a named person on a dated call', () => {
    const claims = callClaims(call);
    const need = claims.find((c) => c.key === 'buyer.need');
    expect(need?.standing).toBe('CONFIRMED');
    expect(need?.sourceKind).toBe('PERSON');
    expect(need?.sourceLabel).toContain('Dana Whitlock');
    expect(need?.sourceLabel).toContain('2026-08-10');
    expect(need?.sourceRef).toBe('attempt:a1');
  });

  it('records a negative outcome as a confirmed negative, not as an absence', () => {
    // Otherwise the next pipeline pass rebuilds the same hypothesis and
    // somebody rings them again.
    const claims = callClaims({
      ...call,
      disposition: 'NEED_UNCONFIRMED',
      discovery: { disqualifyReason: 'They own the building next door and use it for overflow.' },
    });
    const need = claims.find((c) => c.key === 'buyer.need');
    expect(need?.standing).toBe('CONFIRMED');
    expect(need?.value).toMatchObject({ confirmed: false });
    expect(need?.statement).toContain('next door');
  });

  it('does not leave a requirement standing on a call that ruled the deal out', () => {
    const claims = callClaims({
      ...call,
      disposition: 'NOT_INTERESTED',
      discovery: { disqualifyReason: 'Budget frozen.', confirmedNeed: 'Two thousand pallet positions' },
    });
    const needs = claims.filter((c) => c.key === 'buyer.need');
    expect(needs).toHaveLength(1);
    expect(needs[0].value).toMatchObject({ confirmed: false });
  });

  it('ignores fields the route does not recognise', () => {
    const claims = callClaims({ ...call, discovery: { ...call.discovery, somethingElse: 'x' } });
    expect(claims.every((c) => c.key !== 'somethingElse')).toBe(true);
  });

  it('routes a credentials answer to compliance rather than to the buyer', () => {
    const claims = callClaims({
      ...call,
      discovery: { credentials: 'Two million general liability, and a Chicago business licence.' },
    });
    const credentials = claims.find((c) => c.key === 'compliance.credentials');
    expect(credentials?.about).toBe('COMPLIANCE');
  });
});

describe('whether two answers disagree', () => {
  it('treats a restatement as agreement', () => {
    expect(answersAgree({ answer: 'October' }, { answer: 'October' })).toBe(true);
    expect(answersAgree({ answer: 'october ' }, { answer: 'October' })).toBe(true);
  });

  it('treats a fuller answer containing the earlier one as agreement', () => {
    expect(answersAgree({ answer: 'Early October, before the peak' }, { answer: 'October' })).toBe(true);
  });

  it('treats a materially different answer as disagreement', () => {
    expect(answersAgree({ answer: 'Twelve thousand square feet' }, { answer: 'Forty thousand square feet' }))
      .toBe(false);
  });

  it('errs towards flagging rather than towards silently overwriting', () => {
    // "12,000 sq ft" against "twelve thousand square feet" is flagged and a
    // person dismisses it in a moment. The opposite error loses information.
    expect(answersAgree({ answer: '12,000 sq ft' }, { answer: 'twelve thousand square feet' })).toBe(false);
  });

  it('treats a missing side as agreement rather than inventing a dispute', () => {
    expect(answersAgree(null, { answer: 'October' })).toBe(true);
  });
});
