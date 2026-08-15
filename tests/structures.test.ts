import { describe, expect, it } from 'vitest';
import { compareStructures, STRUCTURES, type StructureContext } from '@/lib/deal/structures';

/**
 * Twelve ways to transact the same deal, and what each one costs you.
 *
 * The decision this covers is the one that decides who gets sued and whose
 * money sits in the gap for six weeks, and it used to be made silently by a
 * heuristic. The tests are therefore about two things: that the catalogue
 * answers the five questions for every structure without exception, and that
 * the comparison refuses what a deal genuinely cannot support while leaving
 * everything else to the person who carries it.
 */

const context = (over: Partial<StructureContext> = {}): StructureContext => ({
  primeHoldsWork: false,
  involvesGoods: false,
  canContractWithBuyer: true,
  blockingCompliance: null,
  providerVerified: true,
  buyerPaymentKnown: true,
  workingCapitalCents: 5_000_00,
  grossProfitLow: 4_000,
  recurring: null,
  ...over,
});

describe('the catalogue', () => {
  it('holds twelve structures', () => {
    expect(STRUCTURES).toHaveLength(12);
  });

  it('answers all five questions for every one of them', () => {
    // A structure missing one of these is a structure an operator cannot choose
    // between, which is the same as not having it.
    for (const s of STRUCTURES) {
      expect(s.contractsWithBuyer.length, s.key).toBeGreaterThan(15);
      expect(s.invoices.length, s.key).toBeGreaterThan(15);
      expect(s.paidFirst.length, s.key).toBeGreaterThan(15);
      expect(s.carriesLiability.length, s.key).toBeGreaterThan(15);
      expect(s.fundsTheGap.length, s.key).toBeGreaterThan(10);
    }
  });

  it('says when each one does not fit, not only when it does', () => {
    for (const s of STRUCTURES) {
      expect(s.fits.length, s.key).toBeGreaterThan(20);
      expect(s.doesNotFit.length, s.key).toBeGreaterThan(20);
    }
  });

  it('names what has to be true before each is available', () => {
    for (const s of STRUCTURES) {
      expect(s.requires.length, s.key).toBeGreaterThan(0);
    }
  });

  it('has a unique key for each', () => {
    expect(new Set(STRUCTURES.map((s) => s.key)).size).toBe(STRUCTURES.length);
  });
});

describe('what a deal rules out', () => {
  it('refuses every contracting structure while a licence is outstanding', () => {
    // You cannot promise work you are not permitted to do.
    const compared = compareStructures(context({ blockingCompliance: 'a state contractor registration' }));
    const brokerage = compared.find((c) => c.structure.key === 'BROKERAGE')!;
    expect(brokerage.available).toBe(false);
    expect(brokerage.because).toContain('state contractor registration');

    // And leaves the ones where somebody else signs.
    expect(compared.find((c) => c.structure.key === 'REFERRAL')!.available).toBe(true);
    expect(compared.find((c) => c.structure.key === 'DIRECT_INTRODUCTION')!.available).toBe(true);
  });

  it('offers subcontracting only when somebody else holds the work', () => {
    const direct = compareStructures(context());
    expect(direct.find((c) => c.structure.key === 'SUBCONTRACTING')!.available).toBe(false);

    const under = compareStructures(context({ primeHoldsWork: true }));
    expect(under.find((c) => c.structure.key === 'SUBCONTRACTING')!.available).toBe(true);
  });

  it('rules out being the buyer’s supplier when a prime already is', () => {
    const compared = compareStructures(context({ primeHoldsWork: true }));
    expect(compared.find((c) => c.structure.key === 'BROKERAGE')!.available).toBe(false);
    expect(compared.find((c) => c.structure.key === 'WHITE_LABEL')!.available).toBe(false);
  });

  it('rules out goods structures when there are no goods', () => {
    const services = compareStructures(context({ involvesGoods: false }));
    expect(services.find((c) => c.structure.key === 'DISTRIBUTION_RESALE')!.available).toBe(false);
    expect(services.find((c) => c.structure.key === 'CONSIGNMENT')!.available).toBe(false);

    const goods = compareStructures(context({ involvesGoods: true }));
    expect(goods.find((c) => c.structure.key === 'DISTRIBUTION_RESALE')!.available).toBe(true);
  });

  it('rules out contracting when there is no way to reach the buyer', () => {
    const compared = compareStructures(context({ canContractWithBuyer: false }));
    expect(compared.find((c) => c.structure.key === 'BROKERAGE')!.available).toBe(false);
    expect(compared.find((c) => c.structure.key === 'REFERRAL')!.available).toBe(true);
  });

  it('gives a reason for everything it rules out', () => {
    const compared = compareStructures(context({ primeHoldsWork: true, blockingCompliance: 'an insurance limit' }));
    for (const assessment of compared.filter((c) => !c.available)) {
      expect(assessment.because.length, assessment.structure.key).toBeGreaterThan(25);
    }
  });
});

describe('what it warns about without deciding', () => {
  it('warns before you promise work an unverified provider would do', () => {
    const compared = compareStructures(context({ providerVerified: false }));
    const brokerage = compared.find((c) => c.structure.key === 'BROKERAGE')!;
    expect(brokerage.available).toBe(true);
    expect(brokerage.cautions.join(' ')).toMatch(/nobody has verified/i);
    // And says the fix is one call, because it is.
    expect(brokerage.cautions.join(' ')).toMatch(/One call/i);
  });

  it('reports an unrecorded risk appetite as unknown rather than assuming one', () => {
    const compared = compareStructures(context({ workingCapitalCents: null }));
    const brokerage = compared.find((c) => c.structure.key === 'BROKERAGE')!;
    expect(brokerage.unknowns.join(' ')).toMatch(/never been recorded/i);
    // Still available. Not knowing is not the same as being unable.
    expect(brokerage.available).toBe(true);
  });

  it('warns when the gap is large against the cash the owner will risk', () => {
    const compared = compareStructures(context({ workingCapitalCents: 100_00, grossProfitLow: 4_000 }));
    const brokerage = compared.find((c) => c.structure.key === 'BROKERAGE')!;
    expect(brokerage.cautions.join(' ')).toMatch(/paid after you are/i);
  });

  it('warns that an unknown payment record becomes your cash flow', () => {
    const compared = compareStructures(context({ buyerPaymentKnown: false }));
    expect(compared.find((c) => c.structure.key === 'SUBCONTRACTING' || c.structure.key === 'BROKERAGE')!
      .unknowns.join(' ')).toMatch(/how or when this buyer pays/i);
  });

  it('warns against a term contract for work nobody has shown recurs', () => {
    const compared = compareStructures(context({ recurring: null }));
    const managed = compared.find((c) => c.structure.key === 'MANAGED_SERVICE')!;
    expect(managed.cautions.join(' ')).toMatch(/recurs/i);
  });

  it('does not warn about recurrence once somebody has established it', () => {
    const compared = compareStructures(context({ recurring: true }));
    const managed = compared.find((c) => c.structure.key === 'MANAGED_SERVICE')!;
    expect(managed.cautions.join(' ')).not.toMatch(/recurs/i);
  });

  it('always warns about joint and several liability', () => {
    const compared = compareStructures(context());
    const jv = compared.find((c) => c.structure.key === 'JOINT_VENTURE')!;
    expect(jv.cautions.join(' ')).toMatch(/joint and several/i);
  });

  it('never ranks or recommends', () => {
    // The two things that decide this are the owner's cash and the owner's
    // trust, and neither is in the database. So the comparison carries no rank,
    // no score and no preferred option — and it returns the catalogue in its
    // own order rather than sorted into an implied recommendation.
    const compared = compareStructures(context());
    expect(compared).toHaveLength(12);
    expect(compared.map((c) => c.structure.key)).toEqual(STRUCTURES.map((s) => s.key));
    for (const assessment of compared) {
      expect(Object.keys(assessment).sort()).toEqual(['available', 'because', 'cautions', 'structure', 'unknowns']);
    }
  });
});
