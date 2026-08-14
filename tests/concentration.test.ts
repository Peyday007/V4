import { describe, it, expect } from 'vitest';
import { category } from '@/lib/portfolio/concentration';

/**
 * The audit found 54 routes that looked like a portfolio and were two events
 * refracted, 85% of it in one trade because of one hardcoded line. Nothing
 * noticed, because nothing was counting.
 */

describe('category', () => {
  it('reads the trade from the capability, not from the connector that found it', () => {
    expect(category('Commercial janitorial')).toBe('cleaning / janitorial');
    expect(category('Janitorial consumables')).toBe('cleaning / janitorial');
    expect(category('Snow removal')).toBe('grounds');
    expect(category('HVAC maintenance')).toBe('building trades');
  });

  it('says unstated rather than guessing', () => {
    expect(category(null)).toBe('unstated');
    expect(category('')).toBe('unstated');
  });

  it('keeps an unrecognised capability rather than bucketing it as other', () => {
    // An unknown trade is information; folding it into "other" loses the one
    // detail that would let somebody add a bucket for it.
    expect(category('Pest control')).toBe('pest control');
  });
});
