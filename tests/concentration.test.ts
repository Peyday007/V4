import { describe, it, expect } from 'vitest';
import { category, coverage, configuredCoverage } from '@/lib/portfolio/concentration';

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

describe('coverage', () => {
  it('reads reachability from the shipped configuration, not from what was collected', () => {
    // Honest on an empty board, which is exactly when somebody needs it. A
    // measure derived from collected rows says nothing when nothing arrived.
    const c = configuredCoverage();
    expect(c.reachable).toEqual(['CA', 'IL', 'WA']);
  });

  it('names the states nothing working covers, and why', () => {
    const c = configuredCoverage();
    expect(c.unreachable.map((u) => u.state)).toContain('TX');
    expect(c.unreachable.map((u) => u.state)).toContain('MD');
    // The reason is the portal's, carried through rather than summarised away.
    expect(c.unreachable.find((u) => u.state === 'MD')?.because).toMatch(/ArcGIS/);
  });

  it('does not call a state unreachable when another working source covers it', () => {
    const c = coverage({
      jurisdictions: [
        { state: 'IL', label: 'Chicago licences' },
        { state: 'IL', label: 'Chicago permits', unusableReason: 'moved' },
      ],
      portals: [],
    });
    expect(c.reachable).toEqual(['IL']);
    expect(c.unreachable).toEqual([]);
  });

  it('says collection is the question when nothing works at all', () => {
    const c = coverage({
      jurisdictions: [{ state: 'IL', label: 'Chicago', unusableReason: 'gone' }],
      portals: [],
    });
    expect(c.verdict).toMatch(/Concentration is not the question; collection is/);
  });

  it('frames concentration as forced rather than chosen', () => {
    // The distinction that stops an owner hunting for a discipline problem in
    // how work is picked when the constraint is in what arrives.
    expect(configuredCoverage().verdict).toMatch(/shape collection forces, not a choice/);
  });
});
