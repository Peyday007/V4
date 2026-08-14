import { describe, it, expect } from 'vitest';
import {
  calculate,
  confirmed,
  inferred,
  isSupported,
  observed,
  present,
  totalOf,
  unknown,
  weakest,
  type EvidenceClass,
} from '@/lib/evidence/class';
import {
  buyerPriceOf,
  grossProfitOf,
  presentMoney,
  providerCostOf,
  type RouteMoney,
} from '@/lib/evidence/economics';

/**
 * A number is only as good as its worst input.
 *
 * The product already graded its facts four different ways and none of the
 * gradings was consulted at the point a figure went on a screen, so a gross
 * profit derived from a playbook's typical range times an assumed margin sat in
 * the same row, in the same typeface, as money that had been invoiced.
 */

describe('composition', () => {
  it('ranks the classes so that a gap beats a guess downwards', () => {
    expect(weakest('CONFIRMED_BY_PERSON', 'INFERRED')).toBe('INFERRED');
    expect(weakest('INFERRED', 'UNKNOWN')).toBe('UNKNOWN');
    expect(weakest('CONFIRMED_BY_PERSON', 'EXTERNALLY_OBSERVED')).toBe('EXTERNALLY_OBSERVED');
  });

  it('treats confirmed, observed and calculated as showable and nothing else', () => {
    const showable: EvidenceClass[] = [
      'CONFIRMED_BY_PERSON',
      'EXTERNALLY_OBSERVED',
      'CALCULATED_FROM_CONFIRMED_INPUTS',
    ];
    for (const c of showable) expect(isSupported(c)).toBe(true);
    expect(isSupported('INFERRED')).toBe(false);
    expect(isSupported('UNKNOWN')).toBe(false);
  });

  it('makes a calculation from real inputs a calculation', () => {
    const result = calculate(
      [observed(1000, 'the provider quoted it'), confirmed(400, 'they agreed it')],
      ([a, b]) => a - b,
      (parts) => parts.join(' '),
    );
    expect(result.value).toBe(600);
    expect(result.evidence).toBe('CALCULATED_FROM_CONFIRMED_INPUTS');
    expect(isSupported(result.evidence)).toBe(true);
  });

  it('makes a calculation with one guess in it a guess', () => {
    // The rule the whole module exists for. Arithmetic does not launder an
    // assumption into a fact, however sound the subtraction.
    const result = calculate(
      [inferred(1000, 'the playbook midpoint', 'ask a provider'), confirmed(400, 'they agreed it')],
      ([a, b]) => a - b,
      (parts) => parts.join(' '),
    );
    expect(result.value).toBe(600);
    expect(result.evidence).toBe('INFERRED');
    expect(isSupported(result.evidence)).toBe(false);
    expect(result.toConfirm).toBe('ask a provider');
  });

  it('yields nothing rather than a partial sum when an input is missing', () => {
    const result = calculate(
      [observed(1000, 'quoted'), unknown<number>('nobody has priced the work', 'ask a provider')],
      ([a, b]) => a - b,
      (parts) => parts.join(' '),
    );
    expect(result.value).toBeNull();
    expect(result.evidence).toBe('UNKNOWN');
    expect(result.source).toMatch(/nobody has priced the work/);
  });
});

describe('presentation', () => {
  const fmt = (n: number) => `$${n}`;

  it('shows a supported figure', () => {
    const shown = present(observed(500, 'the source published it'), fmt);
    expect(shown).toMatchObject({ show: true, label: '$500' });
  });

  it('suppresses an inference and says what it rests on', () => {
    const hidden = present(inferred(500, 'a playbook prior', 'get a quote'), fmt);
    expect(hidden.show).toBe(false);
    if (hidden.show) throw new Error('unreachable');
    expect(hidden.instead).toMatch(/our inference/);
    expect(hidden.instead).toMatch(/a playbook prior/);
    // A blank would be quieter. This has to be actionable.
    expect(hidden.toConfirm).toBe('get a quote');
  });

  it('never renders a suppressed value as a dash or a zero', () => {
    const hidden = present(unknown<number>('nothing is known', 'find out'), fmt);
    if (hidden.show) throw new Error('unreachable');
    expect(hidden.instead).not.toMatch(/^[-—0]$/);
    expect(hidden.instead).toBe('nothing is known');
  });
});

describe('totals', () => {
  it('sums only the supported rows and says what it left out', () => {
    const result = totalOf([
      observed(100, 'quoted'),
      confirmed(200, 'agreed'),
      inferred(9_000_000, 'a playbook prior', 'get a quote'),
    ]);
    expect(result.total).toBe(300);
    expect(result.counted).toBe(2);
    expect(result.excluded).toBe(1);
    expect(result.note).toMatch(/1 excluded/);
  });

  it('refuses to produce a total when every row is a guess', () => {
    const result = totalOf([
      inferred(500, 'prior', 'quote it'),
      inferred(700, 'prior', 'quote it'),
    ]);
    expect(result.counted).toBe(0);
    expect(result.evidence).toBe('UNKNOWN');
    expect(result.note).toMatch(/the sum of a set of guesses/);
  });
});

describe('route economics read the basis already recorded', () => {
  const priced: RouteMoney = {
    basis: 'QUOTE',
    buyerPrice: 4200,
    providerCost: 2800,
    costSideMissing: false,
  };
  const prior: RouteMoney = {
    basis: 'PRIOR',
    buyerPrice: 4200,
    providerCost: 2800,
    costSideMissing: false,
  };
  const noCost: RouteMoney = {
    basis: 'ESTIMATE',
    buyerPrice: 4200,
    providerCost: null,
    costSideMissing: true,
  };

  it('shows gross profit once a provider has actually quoted', () => {
    const gp = grossProfitOf(priced);
    expect(gp.value).toBe(1400);
    const shown = presentMoney(gp);
    expect(shown).toMatchObject({ show: true, label: '$1,400' });
  });

  it('suppresses the identical arithmetic when it rests on a playbook prior', () => {
    // Same three numbers. The difference is entirely in what is under them,
    // and that difference is the point.
    const gp = grossProfitOf(prior);
    expect(gp.value).toBe(1400);
    expect(presentMoney(gp).show).toBe(false);
  });

  it('says there is no cost side rather than treating a missing cost as zero', () => {
    const gp = grossProfitOf(noCost);
    expect(gp.value).toBeNull();
    const shown = presentMoney(gp);
    if (shown.show) throw new Error('unreachable');
    expect(shown.instead).toMatch(/No provider has priced this work/);
    // The classic bug: price minus nothing read as pure profit.
    expect(shown.instead).not.toMatch(/\$4,200/);
  });

  it('treats a commitment as confirmed by a person and a quote as observed', () => {
    expect(buyerPriceOf({ ...priced, basis: 'COMMITMENT' }).evidence).toBe('CONFIRMED_BY_PERSON');
    expect(buyerPriceOf(priced).evidence).toBe('EXTERNALLY_OBSERVED');
    expect(providerCostOf({ ...priced, basis: 'REALISED' }).evidence).toBe('CONFIRMED_BY_PERSON');
  });

  it('tells the reader what would make an unsupported figure real', () => {
    const gp = grossProfitOf(prior);
    expect(gp.toConfirm).toMatch(/Get a provider to price the work/);
  });
});
