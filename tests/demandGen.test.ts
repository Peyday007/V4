import { describe, expect, it } from 'vitest';
import { choosePlatform, computeEconomics, decideVerdict } from '@/lib/ai/demandGen';

describe('choosePlatform', () => {
  it('sends emergency work to search, where the buyer already is', () => {
    const result = choosePlatform('Emergency water damage restoration');
    expect(result.platform).toBe('GOOGLE_SEARCH');
    expect(result.reason).toMatch(/24\/7|first company to answer/i);
  });

  it('sends recurring facility services to search with local services behind it', () => {
    const result = choosePlatform('Commercial janitorial');
    expect(result.platform).toBe('GOOGLE_SEARCH');
    expect(result.secondary).toBe('GOOGLE_LOCAL_SERVICES');
    expect(result.secondaryReason).toMatch(/insurance/i);
  });

  it('does not recommend paid ads for trade subcontracting', () => {
    // The buyers are a small, nameable set of general contractors. Paid search
    // mostly buys homeowner traffic at commercial prices.
    const result = choosePlatform('Commercial electrical');
    expect(result.platform).toBe('DIRECT_OUTREACH');
    expect(result.reason).toMatch(/general contractors/i);
  });

  it('sends role-targeted B2B work to LinkedIn', () => {
    expect(choosePlatform('IT field service').platform).toBe('LINKEDIN');
  });

  it('falls back to search for anything unrecognised', () => {
    const result = choosePlatform('Underwater basket weaving');
    expect(result.platform).toBe('GOOGLE_SEARCH');
    expect(result.secondary).toBeUndefined();
  });

  it('builds location-specific keywords', () => {
    const result = choosePlatform('Commercial janitorial');
    const keywords = result.keywords('Commercial janitorial', 'Dallas');
    expect(keywords.every((k) => k.includes('Dallas'))).toBe(true);
    expect(keywords.some((k) => k.startsWith('commercial'))).toBe(true);
  });
});

describe('decideVerdict', () => {
  const base = { readyProviders: 3, unverifiedProviders: 0, demandEvidence: 4, grossProfitPerDeal: 4000, minimumProviders: 3 };

  it('refuses outright when nobody can fulfil the work', () => {
    const result = decideVerdict({ ...base, readyProviders: 0, unverifiedProviders: 0 });
    expect(result.verdict).toBe('DO_NOT_RUN');
    expect(result.providersNeeded).toBe(3);
    expect(result.reason).toMatch(/turn down/i);
  });

  it('says prepare first when coverage is thin', () => {
    const result = decideVerdict({ ...base, readyProviders: 1, unverifiedProviders: 2 });
    expect(result.verdict).toBe('PREPARE_FIRST');
    expect(result.providersNeeded).toBe(2);
    expect(result.reason).toMatch(/One provider is not coverage/i);
  });

  it('refuses when the margin cannot pay for acquisition', () => {
    const result = decideVerdict({ ...base, grossProfitPerDeal: 200 });
    expect(result.verdict).toBe('DO_NOT_RUN');
    expect(result.reason).toMatch(/cannot pay for itself/i);
  });

  it('runs when capacity exists but demand is unproven, and says why', () => {
    const result = decideVerdict({ ...base, demandEvidence: 0 });
    expect(result.verdict).toBe('RUN');
    expect(result.reason).toMatch(/buying information/i);
  });

  it('runs when both capacity and demand are present', () => {
    const result = decideVerdict(base);
    expect(result.verdict).toBe('RUN');
    expect(result.providersNeeded).toBe(0);
  });
});

describe('computeEconomics', () => {
  it('works the affordable lead price back from margin and close rate', () => {
    const result = computeEconomics({
      grossProfitPerDeal: 4000,
      leadToDealRate: 0.15,
      monthlyDealCapacity: 6,
      acquisitionShare: 0.3,
    });
    // 4000 × 0.15 × 0.30 = 180
    expect(result.maxCostPerLead).toBe(180);
    // 6 deals ÷ 0.15 = 40 leads × $180 = $7,200
    expect(result.suggestedMonthlyBudget).toBe(7200);
  });

  it('refuses to invent a budget without a real profit figure', () => {
    const result = computeEconomics({
      grossProfitPerDeal: null,
      leadToDealRate: 0.1,
      monthlyDealCapacity: 4,
      acquisitionShare: 0.3,
    });
    expect(result.maxCostPerLead).toBeNull();
    expect(result.suggestedMonthlyBudget).toBeNull();
    expect(result.budgetReason).toMatch(/no honest way to set a bid/i);
  });

  it('caps the budget at what fulfillment can actually absorb', () => {
    const constrained = computeEconomics({ grossProfitPerDeal: 4000, leadToDealRate: 0.15, monthlyDealCapacity: 2, acquisitionShare: 0.3 });
    const roomy = computeEconomics({ grossProfitPerDeal: 4000, leadToDealRate: 0.15, monthlyDealCapacity: 10, acquisitionShare: 0.3 });
    expect(constrained.suggestedMonthlyBudget!).toBeLessThan(roomy.suggestedMonthlyBudget!);
    expect(constrained.budgetReason).toMatch(/Buying past your capacity/i);
  });

  it('suggests nothing when there is no capacity to fill', () => {
    const result = computeEconomics({ grossProfitPerDeal: 4000, leadToDealRate: 0.15, monthlyDealCapacity: 0, acquisitionShare: 0.3 });
    expect(result.suggestedMonthlyBudget).toBe(0);
  });
});
