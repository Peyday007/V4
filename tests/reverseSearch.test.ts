import { describe, expect, it } from 'vitest';
import { briefsFor, type SupplyPosition } from '@/lib/supply/reverse';
import { MINI_PATHS } from '@/lib/universe/registry';

/**
 * Working backwards from capacity, without inventing demand on the way.
 *
 * The temptation in a supply-first search is enormous and specific: a provider
 * exists, a category exists, therefore an opportunity exists. That reasoning
 * produces a full board out of nothing at all, and every row on it would be a
 * company that has never been contacted about a need nobody has stated.
 *
 * So the tests are mostly about refusals — that an unverified claim produces
 * nothing, that a path only reachable from a published trigger cannot be
 * entered from the supply side, and that what comes out reads as questions
 * rather than as deals.
 */

const position = (over: Partial<SupplyPosition> = {}): SupplyPosition => ({
  companyId: 'co1',
  name: 'Halsted Storage',
  location: 'Chicago, IL',
  stateCode: 'IL',
  verifiedCapabilities: [
    { name: 'Warehousing', verifiedAt: new Date('2026-08-01'), how: 'Confirmed on a call with the operator' },
  ],
  claimedCapabilities: [],
  capacity: [
    { what: 'Four unlet bays through the autumn', verifiedAt: new Date('2026-08-01'), detail: '4 bays · Chicago' },
  ],
  territories: ['Cook County'],
  ...over,
});

describe('nothing is generated from an unverified claim', () => {
  it('produces no briefs when nothing has been verified', () => {
    // A directory entry is the company describing itself. Building a week of
    // calling on it would be a hypothesis resting on a hypothesis.
    expect(briefsFor(position({ verifiedCapabilities: [], claimedCapabilities: ['Warehousing'] }))).toEqual([]);
  });

  it('produces no briefs when the provider has nothing recorded at all', () => {
    expect(briefsFor(position({ verifiedCapabilities: [], claimedCapabilities: [], capacity: [] }))).toEqual([]);
  });
});

describe('what a verified provider generates', () => {
  const briefs = briefsFor(position());

  it('finds at least one path the capacity could serve', () => {
    expect(briefs.length).toBeGreaterThan(0);
  });

  it('only enters paths that support market development', () => {
    // Some paths only work off a published trigger, and no amount of provider
    // capacity creates one.
    for (const brief of briefs) {
      const path = MINI_PATHS.find((p) => p.key === brief.miniPathKey)!;
      expect(path.lanes).toContain('MARKET_DEVELOPMENT');
    }
  });

  it('names buyer types rather than companies', () => {
    // Nobody on the list has been looked at, and a named company would read as
    // a lead.
    for (const brief of briefs) {
      expect(brief.buyerTypes.length).toBeGreaterThan(0);
      expect(brief.buyerTypes.join(' ')).not.toContain('Halsted');
    }
  });

  it('says plainly that nobody has asked for this', () => {
    expect(briefs[0].becauseThisProvider).toMatch(/Nobody has said they want it/i);
  });

  it('quotes the verification rather than asserting it', () => {
    expect(briefs[0].becauseThisProvider).toContain('warehousing');
    expect(briefs[0].becauseThisProvider).toContain('2026-08-01');
  });

  it('uses the provider’s own geography rather than a market name', () => {
    expect(briefs[0].geography).toBe('Chicago, IL');
    expect(briefs[0].toEstablish.join(' ')).toContain('Chicago, IL');
  });

  it('produces questions to ask a person, not fields to fill in', () => {
    const questions = briefs[0].toEstablish.join(' ');
    expect(questions).toMatch(/Ring/);
    expect(questions).toMatch(/who they use now/i);
    expect(questions).not.toMatch(/establish demand\.?$/i);
  });

  it('asks how often it happens, because a twice-a-year problem is not an account', () => {
    expect(briefs[0].toEstablish.join(' ')).toMatch(/how often/i);
  });

  it('states what would make it wrong, as an amount of evidence rather than a mood', () => {
    expect(briefs[0].wouldFalsifyIt).toMatch(/Three conversations/);
    expect(briefs[0].wouldFalsifyIt).toMatch(/close this thesis/i);
  });

  it('carries no money, score or priority', () => {
    // A market-development brief that looks like a deal gets worked like one,
    // and the first call then assumes somebody wants this.
    const text = JSON.stringify(briefs[0]);
    expect(text).not.toMatch(/\$\d/);
    expect(text).not.toMatch(/probability|score|priority/i);
  });
});

describe('matching is conservative', () => {
  it('does not match a capability that shares no language with the path', () => {
    const briefs = briefsFor(position({
      verifiedCapabilities: [
        { name: 'Payroll', verifiedAt: new Date('2026-08-01'), how: 'Confirmed on a call' },
      ],
    }));
    expect(briefs).toEqual([]);
  });

  it('ignores short words that would match nearly anything', () => {
    const briefs = briefsFor(position({
      verifiedCapabilities: [
        { name: 'and the', verifiedAt: new Date('2026-08-01'), how: 'Confirmed on a call' },
      ],
    }));
    expect(briefs).toEqual([]);
  });

  it('falls back to a plain phrase when the provider has no location', () => {
    const briefs = briefsFor(position({ location: null }));
    expect(briefs[0].geography).toBe('their own area');
  });
});
