import { describe, expect, it } from 'vitest';
import {
  gradeOpportunity,
  gradeOpportunityMoney,
  gradeMatchScore,
  presentMatchScore,
  claimsChip,
  STAGE_ORDER,
  type ScorableOpportunity,
} from '@/lib/evidence/opportunity';
import { gradeRate, presentPercent } from '@/lib/evidence/claims';

/**
 * The rule the screens were missing, stated as tests.
 *
 * The fault that produced these was not that the grading did not exist — it did,
 * on the money — but that six other surfaces printed raw floats beside it. So
 * the invariants here are about what may reach a screen, not about the
 * arithmetic: an unscored opportunity yields no figures at all, a probability
 * without a history yields no percentage, and a suppressed value always carries
 * a sentence rather than a dash.
 */

const unscored: ScorableOpportunity = {
  id: 'o1',
  type: 'BROKERAGE',
  stage: 'SIGNAL_DISCOVERED',
  closingProbability: 0.1,
  fulfillmentConfidence: 0.3,
  informationCompleteness: 0,
  relationshipVulnerability: 0.275,
  expectedValue: null,
  estimatedGrossProfit: null,
  missingInformation: [],
  hasScore: false,
};

const scored: ScorableOpportunity = {
  ...unscored,
  hasScore: true,
  stage: 'QUOTE_DELIVERED',
  closingProbability: 0.62,
  fulfillmentConfidence: 0.8,
  informationCompleteness: 0.75,
  estimatedGrossProfit: 4000,
};

describe('opportunity claims', () => {
  it('shows nothing on an opportunity the scorer has never touched', () => {
    const claims = gradeOpportunity({ opportunity: unscored, closedComparables: 200 });

    // The column defaults are 0.1 / 0.3 / 0 and every one of them was on a
    // screen. None survives.
    expect(claims.shown.closingProbability.show).toBe(false);
    expect(claims.shown.fulfillmentConfidence.show).toBe(false);
    expect(claims.shown.informationCompleteness.show).toBe(false);
    expect(claims.shown.relationshipVulnerability.show).toBe(false);
  });

  it('says what is missing rather than going blank', () => {
    const claims = gradeOpportunity({ opportunity: unscored, closedComparables: 200 });
    for (const shown of Object.values(claims.shown)) {
      expect(shown.show).toBe(false);
      if (shown.show === false) {
        // A dash is a quieter screen, not a more honest one.
        expect(shown.instead).not.toBe('—');
        expect(shown.instead.length).toBeGreaterThan(30);
      }
    }
  });

  it('withholds a closing rate until enough deals of that kind have closed', () => {
    const thin = gradeOpportunity({ opportunity: scored, closedComparables: 3 });
    expect(thin.shown.closingProbability.show).toBe(false);
    if (thin.shown.closingProbability.show === false) {
      expect(thin.shown.closingProbability.instead).toMatch(/3 comparable/);
    }

    const thick = gradeOpportunity({ opportunity: scored, closedComparables: 40 });
    expect(thick.shown.closingProbability.show).toBe(true);
    if (thick.shown.closingProbability.show) expect(thick.shown.closingProbability.label).toBe('62%');
  });

  it('refuses an expected value built on a probability it would not show', () => {
    // The composition rule doing the work it exists for: a real gross-profit
    // estimate times an unshowable probability is not a smaller number, it is
    // no number.
    const claims = gradeOpportunity({ opportunity: scored, closedComparables: 3 });
    expect(claims.expectedValue.value).toBeNull();
  });

  it('keeps a relationship-vulnerability figure only where signals were recorded', () => {
    const withoutSignals = gradeOpportunity({ opportunity: scored, closedComparables: 40 });
    expect(withoutSignals.shown.relationshipVulnerability.show).toBe(false);

    const withSignals = gradeOpportunity({
      opportunity: { ...scored, incumbentIssues: 2, movabilitySignals: 1 },
      closedComparables: 40,
    });
    expect(withSignals.shown.relationshipVulnerability.show).toBe(true);
  });

  it('gives a card a short true fragment instead of a fabricated one', () => {
    expect(claimsChip(gradeOpportunity({ opportunity: unscored, closedComparables: 0 })))
      .toBe('No closing rate yet');
    expect(claimsChip(gradeOpportunity({ opportunity: scored, closedComparables: 40 })))
      .toContain('Closes 62%');
  });
});

describe('opportunity money', () => {
  it('will not show a playbook estimate as a price', () => {
    const cash = gradeOpportunityMoney({
      estimatedValue: 25_000,
      estimatedGrossProfit: 5_000,
      quote: null,
    });
    expect(cash.value.evidence).toBe('INFERRED');
    expect(cash.grossProfit.evidence).toBe('INFERRED');
  });

  it('shows a quote that has a supplier cost behind it', () => {
    const cash = gradeOpportunityMoney({
      estimatedValue: 25_000,
      estimatedGrossProfit: 5_000,
      quote: { total: 30_000, costTotal: 22_000, grossProfit: 8_000 },
    });
    expect(cash.grossProfit.evidence).toBe('EXTERNALLY_OBSERVED');
    expect(cash.grossProfit.value).toBe(8_000);
  });

  it('treats a quote with no cost entered as no margin at all', () => {
    const cash = gradeOpportunityMoney({
      estimatedValue: 25_000,
      estimatedGrossProfit: 5_000,
      quote: { total: 30_000, costTotal: 0, grossProfit: 30_000 },
    });
    // The dangerous case: costTotal defaults to 0, so grossProfit equals the
    // whole total and reads as 100% margin.
    expect(cash.grossProfit.evidence).toBe('INFERRED');
    expect(cash.grossProfit.value).not.toBe(30_000);
  });
});

describe('match scores', () => {
  it('is an inference about records until somebody verified the capability', () => {
    const graded = gradeMatchScore({ score: 0.9, missingInformation: ['insurance'], capabilityVerified: false });
    expect(graded.evidence).toBe('INFERRED');
    expect(presentMatchScore(graded).show).toBe(false);
  });

  it('becomes showable once the capability was checked', () => {
    const graded = gradeMatchScore({ score: 0.9, missingInformation: [], capabilityVerified: true });
    const shown = presentMatchScore(graded);
    expect(shown.show).toBe(true);
    if (shown.show) expect(shown.label).toBe('90%');
  });
});

describe('rates', () => {
  it('withholds a ratio over too few observations and shows the counts instead', () => {
    const shown = presentPercent(gradeRate({ numerator: 2, denominator: 3, what: 'quote-to-close rate' }));
    expect(shown.show).toBe(false);
    if (shown.show === false) {
      expect(shown.instead).toContain('2 of 3');
      // The reason has to be the one that matters: how much one more moves it.
      expect(shown.instead).toMatch(/33 points/);
    }
  });

  it('shows a ratio once the denominator carries it', () => {
    const shown = presentPercent(gradeRate({ numerator: 12, denominator: 40, what: 'connect rate' }));
    expect(shown.show).toBe(true);
    if (shown.show) expect(shown.label).toBe('30%');
  });

  it('does not read a rate into nothing having happened', () => {
    const shown = presentPercent(gradeRate({ numerator: 0, denominator: 0, what: 'escalation rate' }));
    expect(shown.show).toBe(false);
    if (shown.show === false) expect(shown.instead).not.toContain('0%');
  });
});

describe('stage order', () => {
  it('runs from discovery through to expansion without gaps', () => {
    expect(STAGE_ORDER[0]).toBe('SIGNAL_DISCOVERED');
    expect(STAGE_ORDER.at(-1)).toBe('REPEAT_OR_EXPANSION');
    expect(new Set(STAGE_ORDER).size).toBe(STAGE_ORDER.length);
  });

  it('scores fulfilment confidence higher the further supply has actually got', () => {
    const early = gradeOpportunity({
      opportunity: { ...scored, stage: 'SUPPLIER_REQUIRED' },
      closedComparables: 40,
    });
    const late = gradeOpportunity({
      opportunity: { ...scored, stage: 'PRICING_REQUIRED' },
      closedComparables: 40,
    });
    expect(early.shown.fulfillmentConfidence.show).toBe(false);
    expect(late.shown.fulfillmentConfidence.show).toBe(true);
  });
});
