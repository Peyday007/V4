import { describe, expect, it } from 'vitest';
import { capabilityTokens, isCatalogued, matchCapability } from '@/lib/discovery/capabilityMatch';

/**
 * Service-name matching.
 *
 * Exact string equality was rejecting seventeen of thirty-two hypotheses on a
 * real run for "no provider could fulfil this", when the actual problem was
 * that the capability catalogue said "Commercial janitorial" and the connector
 * said "Commercial cleaning". A vocabulary mismatch reported as a fulfilment
 * gap is a confident rejection of workable business.
 */

const CATALOGUE = [
  'Commercial janitorial',
  'Post-construction cleaning',
  'Day porter service',
  'Commercial electrical',
  'Mechanical and HVAC',
  'Structured cabling',
  'Last-mile delivery',
];

describe('the same trade under different names', () => {
  it('matches cleaning to janitorial', () => {
    const match = matchCapability('Commercial cleaning', CATALOGUE);
    expect(match.capability).toBe('Commercial janitorial');
    expect(match.sharedTerms.sort()).toEqual(['cleaning', 'commercial']);
  });

  it('ignores words describing the commercial structure rather than the work', () => {
    // "Subcontract" and "wholesale" say how we would transact, not what the
    // work is — and the business path already records that.
    expect(matchCapability('Post-construction cleaning subcontract', CATALOGUE).capability)
      .toBe('Post-construction cleaning');
  });

  it('canonicalises trade synonyms both ways', () => {
    expect(matchCapability('Commercial janitorial', ['Commercial cleaning']).capability).toBe('Commercial cleaning');
    expect(matchCapability('HVAC', ['Mechanical and HVAC']).capability).toBe('Mechanical and HVAC');
  });
});

describe('different trades stay different', () => {
  it('does not match across trades that share only a qualifier', () => {
    // "Commercial" is the qualifier, not the work. Matching on it alone would
    // put an electrician on a cleaning job.
    expect(matchCapability('Commercial electrical', ['Commercial janitorial']).capability).toBeNull();
  });

  it('does not match on one generic word out of two', () => {
    // High-rise window cleaning is a specialist trade a general commercial
    // crew cannot do. Half-overlap is deliberately below the threshold.
    expect(matchCapability('Window cleaning', ['Commercial janitorial']).capability).toBeNull();
  });

  it('returns nothing for an unrelated service', () => {
    expect(matchCapability('Aggregate supply', CATALOGUE).capability).toBeNull();
    expect(matchCapability(null, CATALOGUE).capability).toBeNull();
    expect(matchCapability('', CATALOGUE).capability).toBeNull();
  });

  it('returns nothing against an empty catalogue', () => {
    expect(isCatalogued('Commercial cleaning', [])).toBe(false);
  });
});

describe('tokenisation', () => {
  it('drops noise words and short fragments', () => {
    expect([...capabilityTokens('Janitorial supplies and consumables')]).toEqual(['cleaning']);
  });

  it('splits hyphenated trades', () => {
    expect([...capabilityTokens('Post-construction cleaning')].sort()).toEqual(['cleaning', 'construction', 'post']);
  });

  it('is stable under case and punctuation', () => {
    expect([...capabilityTokens('COMMERCIAL CLEANING!')].sort()).toEqual([...capabilityTokens('commercial cleaning')].sort());
  });
});

describe('a match names the words that decided it', () => {
  it('reports shared terms so a wrong match can be corrected', () => {
    // A silent fuzzy match is how a lead reaches a provider who cannot do the
    // job. The terms are recorded so the decision is arguable.
    const match = matchCapability('Medical facility cleaning', ['Healthcare facility cleaning']);
    expect(match.capability).toBe('Healthcare facility cleaning');
    expect(match.sharedTerms).toContain('cleaning');
    expect(match.score).toBeGreaterThan(0.6);
  });
});
