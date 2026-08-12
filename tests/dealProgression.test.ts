import { describe, expect, it } from 'vitest';
import { computeEconomics, exposureDays, paymentTermDays, BASIS_LABELS } from '@/lib/deal/economics';
import { approvalsRequired } from '@/lib/deal/approval';
import { confidentDate, priceability, requirementFromDiscovery, MATERIAL_FIELDS } from '@/lib/deal/requirement';
import { supplyPosture, costIsUsable, STATE_LABELS, STATE_MEANING, TERMINAL_STATES } from '@/lib/deal/provider';
import { moneyPosition } from '@/lib/deal/commit';
import { DEFAULT_CONFIG } from '@/lib/config';
import type { BuyerRequirement, ProviderCandidate } from '@prisma/client';

/**
 * The pure rules of the deal layer.
 *
 * Everything here is arithmetic and policy with no database in it, which is
 * exactly the part that has to be right before anybody trusts a number on a
 * screen. The invariants under test are the ones the directive is explicit
 * about: a missing cost is not a zero cost, a candidate is not secured
 * fulfilment, an estimate is not realised money, and an invoice is not money
 * at all.
 */

const NOW = new Date('2026-08-12T15:00:00.000Z');

function candidate(overrides: Partial<ProviderCandidate> = {}): ProviderCandidate {
  return {
    id: 'c1', orgId: 'o1', routeId: 'r1', providerCompanyId: 'p1',
    state: 'CANDIDATE_FOUND', stateReason: null, stateChangedAt: NOW,
    matchBasis: 'capability and geography', capabilityNotes: null, geographyNotes: null,
    capabilityVerifiedAt: null, capabilityEvidence: null,
    credentialsVerifiedAt: null, credentialsEvidence: null,
    availabilityVerifiedAt: null, availableFrom: null, availableUntil: null, capacityNotes: null,
    costAmount: null, costUnit: null, costBasis: null, costTerms: null,
    costReceivedAt: null, costExpiresAt: null,
    promiseText: null, promiseDueAt: null, promiseKeptAt: null,
    conflictNote: null, rejectedReason: null,
    createdAt: NOW, updatedAt: NOW,
    ...overrides,
  } as ProviderCandidate;
}

function requirement(overrides: Partial<BuyerRequirement> = {}): BuyerRequirement {
  return {
    id: 'req1', orgId: 'o1', routeId: 'r1', version: 1, state: 'CURRENT',
    summary: 'Nightly cleaning across three sites', specification: 'Nightly janitorial, 5 nights',
    quantity: null, unit: null, frequency: '5 nights a week', locationCount: 3, locations: 'Chicago',
    startsAt: null, decisionBy: null, timingNote: 'before the contract ends in March', processNotes: null,
    constraints: [], incumbent: null, incumbentNotes: null,
    decisionMakerContactId: null, decisionMakerRole: 'Facilities Director', authorityConfirmed: true,
    budgetMechanism: 'UNKNOWN', budgetAmount: null, budgetBasis: null,
    confirmedFields: ['summary'], sourceAttemptId: null, capturedById: null, capturedBy: 'caller',
    supersededById: null, supersededAt: null, supersedeReason: null, withdrawnReason: null,
    createdAt: NOW, updatedAt: NOW,
    ...overrides,
  } as BuyerRequirement;
}

// ---------------------------------------------------------------------------

describe('economics: a missing cost is not a zero cost', () => {
  it('refuses to calculate gross profit without a provider cost', () => {
    const result = computeEconomics({ providerCost: null, buyerPrice: 10_000 });
    expect(result.grossProfit).toBeNull();
    expect(result.grossMarginPct).toBeNull();
    expect(result.costSideMissing).toBe(true);
    expect(result.warnings.some((w) => w.includes('must not be ranked on profit'))).toBe(true);
  });

  it('does not let freight and fees fabricate a total from an unknown cost', () => {
    const result = computeEconomics({ providerCost: null, freight: 500, fees: 200, buyerPrice: 10_000 });
    expect(result.totalCost).toBeNull();
  });

  it('calculates only when both sides are real', () => {
    const result = computeEconomics({ providerCost: 6_000, freight: 400, fees: 100, contingency: 500, buyerPrice: 10_000 });
    expect(result.totalCost).toBe(7_000);
    expect(result.grossProfit).toBe(3_000);
    expect(result.grossMarginPct).toBe(30);
  });

  it('reports a below-cost price as a loss rather than a small margin', () => {
    const result = computeEconomics({ providerCost: 12_000, buyerPrice: 10_000 });
    expect(result.grossProfit).toBe(-2_000);
    expect(result.warnings.some((w) => w.includes('below cost'))).toBe(true);
  });
});

describe('economics: basis and confidence answer different questions', () => {
  it('is a PRIOR when nobody has been asked anything', () => {
    expect(computeEconomics({ providerCost: null, buyerPrice: null }).basis).toBe('PRIOR');
  });

  it('is an ESTIMATE when one side is real', () => {
    expect(computeEconomics({ providerCost: 5_000, buyerPrice: null }).basis).toBe('ESTIMATE');
    expect(computeEconomics({ providerCost: null, buyerPrice: 8_000 }).basis).toBe('ESTIMATE');
  });

  it('is a QUOTE only when the cost came from the provider and a price is set', () => {
    expect(computeEconomics({ providerCost: 5_000, buyerPrice: 8_000, costIsQuoted: false }).basis).toBe('ESTIMATE');
    expect(computeEconomics({ providerCost: 5_000, buyerPrice: 8_000, costIsQuoted: true }).basis).toBe('QUOTE');
  });

  it('keeps realised money above every other basis even when fields are thin', () => {
    const result = computeEconomics({ providerCost: 1, buyerPrice: 2, realised: true, requirementReady: false });
    expect(result.basis).toBe('REALISED');
    expect(result.confidence).toBe('HIGH');
  });

  it('holds a real quote at medium confidence when the requirement behind it is incomplete', () => {
    const shaky = computeEconomics({ providerCost: 5_000, buyerPrice: 8_000, costIsQuoted: true, requirementReady: false });
    const solid = computeEconomics({ providerCost: 5_000, buyerPrice: 8_000, costIsQuoted: true, requirementReady: true });
    expect(shaky.basis).toBe('QUOTE');
    expect(shaky.confidence).toBe('MEDIUM');
    expect(solid.confidence).toBe('HIGH');
  });

  it('never describes an estimate in the words used for realised money', () => {
    expect(BASIS_LABELS.ESTIMATE).not.toMatch(/realised/i);
    expect(BASIS_LABELS.REALISED).toMatch(/actually moved/i);
  });
});

describe('economics: payment terms are parsed only when unambiguous', () => {
  it('reads the standard forms', () => {
    expect(paymentTermDays('Net 30')).toBe(30);
    expect(paymentTermDays('net45')).toBe(45);
    expect(paymentTermDays('14 days')).toBe(14);
    expect(paymentTermDays('due on receipt')).toBe(0);
  });

  it('refuses to guess at anything else', () => {
    expect(paymentTermDays('on completion')).toBeNull();
    expect(paymentTermDays('when the job signs off')).toBeNull();
    expect(paymentTermDays('')).toBeNull();
    expect(paymentTermDays(null)).toBeNull();
  });

  it('returns no exposure figure when either side of the term is unknown', () => {
    expect(exposureDays({ buyerTerms: 'Net 60', providerTerms: null })).toBeNull();
    expect(exposureDays({ buyerTerms: 'on completion', providerTerms: 'Net 30' })).toBeNull();
  });

  it('sizes exposure when both sides are known, and never negatively', () => {
    expect(exposureDays({ buyerTerms: 'Net 60', providerTerms: 'Net 15', deliveryDays: 10 })).toBe(55);
    expect(exposureDays({ buyerTerms: 'Net 15', providerTerms: 'Net 60' })).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('approvals: the owner sees what the business cannot get back', () => {
  const base = {
    config: DEFAULT_CONFIG,
    provider: candidate({
      state: 'SELECTED',
      capabilityEvidence: 'named three comparable sites',
      credentialsVerifiedAt: NOW,
      costAmount: 6_000 as never,
      costExpiresAt: new Date('2026-09-30T00:00:00.000Z'),
    }),
    buyerPaymentTerms: 'Net 30',
    providerPaymentTerms: 'Net 15',
    complianceGaps: [] as string[],
    now: NOW,
  };

  it('raises a margin exception below the configured floor', () => {
    const economics = computeEconomics({ providerCost: 9_500, buyerPrice: 10_000, costIsQuoted: true, requirementReady: true });
    const required = approvalsRequired({ ...base, economics });
    expect(required.map((r) => r.type)).toContain('MARGIN_EXCEPTION');
  });

  it('treats a price with no cost behind it as unknown rather than thin', () => {
    const economics = computeEconomics({ providerCost: null, buyerPrice: 10_000 });
    const required = approvalsRequired({ ...base, provider: null, economics });
    const pricing = required.find((r) => r.type === 'PRICING');
    expect(pricing).toBeDefined();
    expect(pricing?.summary).toMatch(/unknown rather than thin/);
  });

  it('raises working capital only past the configured limit', () => {
    const under = computeEconomics({
      providerCost: 1_000, buyerPrice: 5_000, costIsQuoted: true, requirementReady: true,
      workingCapitalAmount: DEFAULT_CONFIG.approvalLimits.cashExposureLimit - 1, workingCapitalDays: 30,
    });
    const over = computeEconomics({
      providerCost: 1_000, buyerPrice: 5_000, costIsQuoted: true, requirementReady: true,
      workingCapitalAmount: DEFAULT_CONFIG.approvalLimits.cashExposureLimit + 1, workingCapitalDays: 30,
    });
    expect(approvalsRequired({ ...base, economics: under }).map((r) => r.type)).not.toContain('WORKING_CAPITAL');
    expect(approvalsRequired({ ...base, economics: over }).map((r) => r.type)).toContain('WORKING_CAPITAL');
  });

  it('raises credit terms for anything longer than standard, and for terms it cannot size', () => {
    const economics = computeEconomics({ providerCost: 6_000, buyerPrice: 10_000, costIsQuoted: true, requirementReady: true });
    expect(approvalsRequired({ ...base, economics, buyerPaymentTerms: 'Net 90' }).map((r) => r.type)).toContain('CREDIT_TERMS');
    expect(approvalsRequired({ ...base, economics, buyerPaymentTerms: 'when the job signs off' }).map((r) => r.type)).toContain('CREDIT_TERMS');
    expect(approvalsRequired({ ...base, economics, buyerPaymentTerms: 'Net 30' }).map((r) => r.type)).not.toContain('CREDIT_TERMS');
  });

  it('refuses to call fulfilment safe when the provider has not agreed to anything', () => {
    const economics = computeEconomics({ providerCost: 6_000, buyerPrice: 10_000, costIsQuoted: true, requirementReady: true });
    const required = approvalsRequired({
      ...base,
      economics,
      provider: candidate({ state: 'CANDIDATE_FOUND', capabilityEvidence: 'directory listing' }),
    });
    const risk = required.find((r) => r.type === 'HIGH_RISK_FULFILMENT');
    expect(risk).toBeDefined();
    expect(risk?.summary).toMatch(/not an agreement to do the work/);
  });

  it('flags an expired provider cost as fulfilment risk', () => {
    const economics = computeEconomics({ providerCost: 6_000, buyerPrice: 10_000, costIsQuoted: true, requirementReady: true });
    const required = approvalsRequired({
      ...base,
      economics,
      provider: candidate({
        state: 'SELECTED',
        capabilityEvidence: 'reference checked',
        credentialsVerifiedAt: NOW,
        costAmount: 6_000 as never,
        costExpiresAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
    });
    expect(required.find((r) => r.type === 'HIGH_RISK_FULFILMENT')?.summary).toMatch(/cost has expired/);
  });

  it('always escalates a compliance gap, whatever the numbers look like', () => {
    const economics = computeEconomics({ providerCost: 1_000, buyerPrice: 10_000, costIsQuoted: true, requirementReady: true });
    const required = approvalsRequired({ ...base, economics, complianceGaps: ['bonding'] });
    expect(required.map((r) => r.type)).toContain('HIGH_RISK_FULFILMENT');
  });

  it('lets a small clean deal through without an approval', () => {
    const economics = computeEconomics({
      providerCost: 600, buyerPrice: 1_000, costIsQuoted: true, requirementReady: true, contingency: 50,
    });
    expect(approvalsRequired({ ...base, economics })).toEqual([]);
  });

  it('does not let the auto-approve floor suppress a margin exception on a small deal', () => {
    const economics = computeEconomics({
      providerCost: 990, buyerPrice: 1_000, costIsQuoted: true, requirementReady: true, contingency: 5,
    });
    const types = approvalsRequired({ ...base, economics }).map((r) => r.type);
    expect(types).toContain('MARGIN_EXCEPTION');
    expect(types).not.toContain('DEAL_TERMS');
  });

  it('asks separately about signing a contract', () => {
    const economics = computeEconomics({ providerCost: 6_000, buyerPrice: 10_000, costIsQuoted: true, requirementReady: true, contingency: 100 });
    expect(approvalsRequired({ ...base, economics, legalCommitment: true }).map((r) => r.type)).toContain('CONTRACT_EXECUTION');
  });
});

// ---------------------------------------------------------------------------

describe('requirements: theirs, ours, or nothing', () => {
  it('records nothing when the buyer described nothing', () => {
    expect(requirementFromDiscovery('BROKERAGE', {})).toBeNull();
    expect(requirementFromDiscovery('BROKERAGE', { objections: 'busy' })).toBeNull();
    expect(requirementFromDiscovery('DISTRIBUTION', { confirmedNeed: '   ' })).toBeNull();
  });

  it('reads a brokerage call into scope, sites and the decision date', () => {
    const input = requirementFromDiscovery('BROKERAGE', {
      confirmedNeed: 'Nightly cleaning, three sites',
      scope: 'Nightly janitorial including restrooms',
      locations: '3 sites in Chicago',
      frequency: '5 nights a week',
      incumbent: 'CleanCo',
      contractEnd: '2027-03-31',
      siteVisitRequired: true,
      decisionAuthority: 'Facilities Director signs',
    });
    expect(input).not.toBeNull();
    expect(input?.specification).toBe('Nightly janitorial including restrooms');
    expect(input?.locations).toBe('3 sites in Chicago');
    expect(input?.incumbent).toBe('CleanCo');
    expect(input?.decisionBy?.toISOString().slice(0, 10)).toBe('2027-03-31');
    expect(input?.authorityConfirmed).toBe(true);
    expect(input?.constraints).toContain('Site visit required before a price can be given.');
    // Everything present came from them, so it is all listed as theirs.
    expect(input?.confirmed).toContain('specification');
    expect(input?.confirmed).toContain('locations');
  });

  it('reads a distribution call into quantity and reorder cycle', () => {
    const input = requirementFromDiscovery('DISTRIBUTION', {
      productCategory: 'Nitrile gloves',
      specification: 'Blue, 5 mil, no substitutions',
      quantity: '40 cases',
      reorderCycle: 'monthly',
      currentSupplier: 'Grainger',
      sampleOrQuoteRequested: true,
    });
    expect(input?.quantity).toBe('40 cases');
    expect(input?.frequency).toBe('monthly');
    expect(input?.incumbent).toBe('Grainger');
    expect(input?.budgetMechanism).toBe('QUOTE_REQUESTED');
  });

  it('keeps vague timing as the buyer said it rather than inventing a date', () => {
    const input = requirementFromDiscovery('BROKERAGE', {
      scope: 'Post-construction clean',
      contractEnd: 'sometime after budget season',
    });
    expect(input?.timingNote).toBe('sometime after budget season');
    expect(input?.decisionBy).toBeUndefined();
  });

  it('parses a date only when the text unambiguously is one', () => {
    expect(confidentDate('2027-03-31')?.toISOString().slice(0, 10)).toBe('2027-03-31');
    expect(confidentDate('March 31, 2027')).not.toBeNull();
    expect(confidentDate('3/31/2027')).not.toBeNull();
    expect(confidentDate('Q2')).toBeNull();
    expect(confidentDate('next spring')).toBeNull();
    expect(confidentDate('when the contract ends')).toBeNull();
  });

  it('refuses the answers that Date() would silently turn into January the first', () => {
    // These are the dangerous ones, and the reason the guard exists at all.
    // Every string below is something a buyer genuinely says, and `new Date()`
    // parses every one of them into a real date nobody chose — "spring 2027"
    // becomes New Year's Day, and a follow-up gets scheduled for it.
    for (const vague of ['spring 2027', 'Fall 2027', 'March 2027', 'Jan 2027', '2027', '2027-03']) {
      expect(Number.isNaN(new Date(vague).getTime())).toBe(false);
      expect(confidentDate(vague)).toBeNull();
    }
  });
});

describe('requirements: priceability names the gap', () => {
  it('will not price nothing', () => {
    const result = priceability(null);
    expect(result.ready).toBe(false);
    expect(result.missing[0]).toMatch(/No buyer requirement/);
  });

  it('will not price a withdrawn requirement', () => {
    expect(priceability(requirement({ state: 'WITHDRAWN' })).ready).toBe(false);
  });

  it('names each missing piece rather than returning a bare false', () => {
    const result = priceability(requirement({
      specification: null, quantity: null, frequency: null, locations: null,
      timingNote: null, authorityConfirmed: false,
    }));
    expect(result.ready).toBe(false);
    expect(result.missing.length).toBe(4);
  });

  it('is ready when scope, size, timing and authority are all known', () => {
    expect(priceability(requirement()).ready).toBe(true);
  });

  it('treats every field that changes the price as material', () => {
    // A guard on the versioning rule: if somebody adds a pricing input to the
    // model and not to this list, a scope change silently edits a priced
    // requirement in place instead of writing a new version.
    expect(MATERIAL_FIELDS).toContain('specification');
    expect(MATERIAL_FIELDS).toContain('quantity');
    expect(MATERIAL_FIELDS).toContain('frequency');
    expect(MATERIAL_FIELDS).toContain('locations');
    expect(MATERIAL_FIELDS).toContain('constraints');
  });
});

// ---------------------------------------------------------------------------

describe('supply: a candidate is not fulfilment', () => {
  it('says so when there is nobody at all, without dropping the demand', () => {
    const posture = supplyPosture([]);
    expect(posture.secured).toBe(false);
    expect(posture.best).toBeNull();
    expect(posture.headline).toMatch(/demand is still real/);
  });

  it('reports secured only at COMMITTED', () => {
    for (const state of ['CANDIDATE_FOUND', 'CONTACTED', 'CAPABILITY_VERIFIED', 'AVAILABILITY_VERIFIED', 'COST_RECEIVED', 'SELECTED'] as const) {
      expect(supplyPosture([candidate({ state })]).secured).toBe(false);
    }
    expect(supplyPosture([candidate({ state: 'COMMITTED' })]).secured).toBe(true);
  });

  it('never describes a non-committed state in words that sound like a promise', () => {
    for (const state of ['CANDIDATE_FOUND', 'CONTACTED', 'CAPABILITY_VERIFIED', 'AVAILABILITY_VERIFIED', 'COST_RECEIVED', 'SELECTED'] as const) {
      expect(STATE_MEANING[state]).not.toMatch(/fulfilment is secured/);
    }
    expect(STATE_MEANING.COMMITTED).toMatch(/fulfilment is secured/);
    expect(STATE_LABELS.CANDIDATE_FOUND).toBe('Candidate found');
  });

  it('takes the furthest live candidate, ignoring ones that dropped out', () => {
    const posture = supplyPosture([
      candidate({ id: 'a', state: 'COST_RECEIVED' }),
      candidate({ id: 'b', state: 'REJECTED' }),
      candidate({ id: 'c', state: 'CONTACTED' }),
    ]);
    expect(posture.best).toBe('COST_RECEIVED');
    expect(posture.liveCount).toBe(2);
    expect(posture.candidateCount).toBe(3);
  });

  it('says the route needs a new candidate when every one has ended', () => {
    const posture = supplyPosture([candidate({ state: 'REJECTED' }), candidate({ id: 'b', state: 'WITHDRAWN' })]);
    expect(posture.liveCount).toBe(0);
    expect(posture.headline).toMatch(/needs a new one/);
    expect(TERMINAL_STATES).toEqual(['REJECTED', 'WITHDRAWN']);
  });

  it('flags an expired cost and an overdue promise', () => {
    const posture = supplyPosture([
      candidate({ id: 'stale', state: 'COST_RECEIVED', costAmount: 100 as never, costExpiresAt: new Date('2026-01-01') }),
      candidate({ id: 'late', state: 'CONTACTED', promiseDueAt: new Date('2026-08-01'), promiseKeptAt: null }),
    ], NOW);
    expect(posture.staleCostIds).toEqual(['stale']);
    expect(posture.overduePromiseIds).toEqual(['late']);
  });

  it('treats a cost with no expiry as unusable rather than as good forever', () => {
    expect(costIsUsable(candidate({ costAmount: 5_000 as never, costExpiresAt: null }), NOW)).toBe(false);
    expect(costIsUsable(candidate({ costAmount: 5_000 as never, costExpiresAt: new Date('2026-09-01') }), NOW)).toBe(true);
    expect(costIsUsable(candidate({ costAmount: null, costExpiresAt: new Date('2026-09-01') }), NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('money: an invoice is a claim, not money', () => {
  it('counts nothing unsettled toward collected gross profit', () => {
    const money = moneyPosition([
      { direction: 'INBOUND', kind: 'INVOICE', amount: 10_000, settledAt: null },
      { direction: 'INBOUND', kind: 'PAYMENT', amount: 10_000, settledAt: null },
      { direction: 'OUTBOUND', kind: 'PAYMENT', amount: 6_000, settledAt: null },
    ]);
    expect(money.invoiced).toBe(10_000);
    expect(money.collected).toBe(0);
    expect(money.paidOut).toBe(0);
    expect(money.collectedGrossProfit).toBe(0);
    expect(money.outstanding).toBe(10_000);
  });

  it('counts only what settled, on both sides', () => {
    const money = moneyPosition([
      { direction: 'INBOUND', kind: 'INVOICE', amount: 10_000, settledAt: new Date('2026-08-01') },
      { direction: 'INBOUND', kind: 'PAYMENT', amount: 10_000, settledAt: new Date('2026-08-10') },
      { direction: 'OUTBOUND', kind: 'PAYMENT', amount: 6_000, settledAt: new Date('2026-08-05') },
    ]);
    expect(money.collected).toBe(10_000);
    expect(money.paidOut).toBe(6_000);
    expect(money.collectedGrossProfit).toBe(4_000);
    expect(money.fullySettled).toBe(true);
  });

  it('subtracts a refund and a chargeback from what we collected', () => {
    const money = moneyPosition([
      { direction: 'INBOUND', kind: 'PAYMENT', amount: 10_000, settledAt: new Date('2026-08-10') },
      { direction: 'INBOUND', kind: 'REFUND', amount: 2_000, settledAt: new Date('2026-08-20') },
      { direction: 'INBOUND', kind: 'CHARGEBACK', amount: 1_000, settledAt: new Date('2026-08-21') },
      { direction: 'OUTBOUND', kind: 'PAYMENT', amount: 6_000, settledAt: new Date('2026-08-05') },
    ]);
    expect(money.collected).toBe(7_000);
    expect(money.collectedGrossProfit).toBe(1_000);
  });

  it('can report a loss', () => {
    const money = moneyPosition([
      { direction: 'INBOUND', kind: 'PAYMENT', amount: 4_000, settledAt: new Date('2026-08-10') },
      { direction: 'OUTBOUND', kind: 'PAYMENT', amount: 6_000, settledAt: new Date('2026-08-05') },
    ]);
    expect(money.collectedGrossProfit).toBe(-2_000);
  });

  it('does not call a deal settled when nothing was ever invoiced', () => {
    expect(moneyPosition([]).fullySettled).toBe(false);
  });
});
