import { describe, expect, it } from 'vitest';
import {
  TIER_ORDER,
  TIER_OUTREACH,
  classifyTier,
  estimateBuyingWindow,
  rejectionFlags,
} from '@/lib/discovery/tiers';
import { buildBoard, type BoardAccount, type BoardHypothesis } from '@/lib/discovery/board';
import type { IntentSignal } from '@/lib/discovery/qualification';

/**
 * Lead tiers.
 *
 * The distinction the board was missing: a stage says how far we have worked a
 * record, a tier says how much the world has done to create the need. Every
 * account on the live board sat in OPPORTUNITY_HYPOTHESIS, which read like
 * progress, when the truth was that not one of them had a reason to buy.
 */

const NOW = new Date('2026-03-01T12:00:00Z');
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

const signal = (kind: IntentSignal['kind'], days: number): IntentSignal => ({
  kind,
  occurredAt: ago(days),
  tier: 'SOURCE_FACT',
});

describe('tiers are earned by evidence, never by processing', () => {
  it('puts a directory listing at the bottom and says why', () => {
    const result = classifyTier({ intentSignals: [], now: NOW });
    expect(result.tier).toBe('DIRECTORY_PROSPECT');
    expect(result.decidedBy).toBe('none');
    expect(result.reason).toMatch(/no reason to think they need anything today/i);
  });

  it('separates an open solicitation from an event that merely implies need', () => {
    // The core of the model. A purchasing notice is a buyer in market. A
    // permit is construction happening, which is not the same thing.
    expect(classifyTier({ intentSignals: [signal('PURCHASING_NOTICE', 3)], now: NOW }).tier).toBe('ACTIVE_DEMAND');
    expect(classifyTier({ intentSignals: [signal('PERMIT_FILED', 3)], now: NOW }).tier).toBe('STRONG_TRIGGER');
  });

  it('treats an inbound request as the strongest evidence available', () => {
    const result = classifyTier({ intentSignals: [], inbound: true, now: NOW });
    expect(result.tier).toBe('ACTIVE_DEMAND');
    expect(result.reason).toMatch(/they contacted us/i);
  });

  it('demotes an expired solicitation rather than treating it as live demand', () => {
    // An RFQ from six months ago closed. Ranking it as Tier A fills the queue
    // with work that is already awarded.
    const result = classifyTier({ intentSignals: [signal('RFQ_ISSUED', 180)], now: NOW });
    expect(result.tier).toBe('PREDICTED_NEED');
    expect(result.reason).toMatch(/too old to treat as current/i);
  });

  it('gives a trigger a longer life than a request, because its consequences last', () => {
    // A facility that opened 90 days ago still needs a cleaning contract.
    expect(classifyTier({ intentSignals: [signal('FACILITY_OPENING', 90)], now: NOW }).tier).toBe('STRONG_TRIGGER');
    // A quote request from 90 days ago has been answered by somebody.
    expect(classifyTier({ intentSignals: [signal('RFQ_ISSUED', 90)], now: NOW }).tier).not.toBe('ACTIVE_DEMAND');
  });

  it('picks the strongest trigger when several exist', () => {
    const result = classifyTier({
      intentSignals: [signal('JOB_POSTING', 10), signal('FACILITY_OPENING', 20)],
      now: NOW,
    });
    expect(result.decidedBy).toBe('FACILITY_OPENING');
  });

  it('does not promote a pattern match above a real event', () => {
    const pattern = classifyTier({ intentSignals: [], matchesProvenPattern: true, now: NOW });
    expect(pattern.tier).toBe('PREDICTED_NEED');
    expect(TIER_ORDER.indexOf(pattern.tier)).toBeGreaterThan(
      TIER_ORDER.indexOf(classifyTier({ intentSignals: [signal('PERMIT_FILED', 5)], now: NOW }).tier),
    );
  });
});

describe('rejection names the rule it tripped', () => {
  const base = {
    hasIdentifiableBuyer: true,
    hasContactRoute: true,
    deadline: null,
    availableProviders: 4,
    networkHasProviders: true,
    requiresSupply: true,
    estimatedGrossProfit: null,
    minimumGrossProfit: 500,
    now: NOW,
  };

  it('accepts a workable record', () => {
    expect(rejectionFlags(base)).toEqual([]);
  });

  it('does not reject demand for want of a provider — that is a sourcing task', () => {
    // Rejecting the demand means the supply network can never grow toward the
    // work that exists. The first version of this rule rejected seventeen of
    // thirty-two hypotheses on a real run, and the actual cause was that the
    // capability catalogue used different words for the same trade.
    expect(rejectionFlags({ ...base, availableProviders: 0 })).toEqual([]);
    expect(rejectionFlags({ ...base, availableProviders: 0, networkHasProviders: false })).toEqual([]);
    // It still shows up: fulfilment readiness scores zero and the gap is visible.
  });

  it('rejects a passed deadline and an already-awarded opportunity', () => {
    expect(rejectionFlags({ ...base, deadline: ago(1) })).toContain('deadline has passed');
    expect(rejectionFlags({ ...base, alreadyAwarded: true })).toContain('already awarded to someone else');
  });

  it('rejects economics below the floor, quoting both numbers', () => {
    const flags = rejectionFlags({ ...base, estimatedGrossProfit: 120, minimumGrossProfit: 500 });
    expect(flags[0]).toMatch(/\$120.*below.*\$500/);
  });

  it('does NOT reject a good opportunity for lacking a contact', () => {
    // Finding the contact is the task. Discarding a live solicitation because
    // nobody is named would throw away the best leads the system produces.
    expect(rejectionFlags({ ...base, hasContactRoute: false })).toEqual([]);
  });

  it('rejects an identity too incomplete to act on', () => {
    expect(rejectionFlags({ ...base, quarantined: true })[0]).toMatch(/identity cannot be verified/i);
  });
});

describe('buying window decides when, not just whether', () => {
  it('uses a stated deadline over anything inferred', () => {
    const result = estimateBuyingWindow({ tier: 'ACTIVE_DEMAND', deadline: new Date(NOW.getTime() + 5 * DAY), strongestSignal: null, now: NOW });
    expect(result.window).toBe('WITHIN_7_DAYS');
    expect(result.reason).toMatch(/stated deadline/i);
  });

  it('treats an open request as active even with no published date', () => {
    expect(estimateBuyingWindow({ tier: 'ACTIVE_DEMAND', deadline: null, strongestSignal: null, now: NOW }).window)
      .toBe('ACTIVE_NOW');
  });

  it('gives a fresh permit a lead time instead of contacting on day one', () => {
    // Calling the week they broke ground reaches somebody who has not thought
    // about cleaning yet, and burns the one introduction available.
    const fresh = estimateBuyingWindow({ tier: 'STRONG_TRIGGER', deadline: null, strongestSignal: signal('PERMIT_FILED', 2), now: NOW });
    expect(fresh.window).toBe('WITHIN_90_DAYS');

    const matured = estimateBuyingWindow({ tier: 'STRONG_TRIGGER', deadline: null, strongestSignal: signal('PERMIT_FILED', 95), now: NOW });
    expect(matured.window).toBe('ACTIVE_NOW');
  });

  it('admits it does not know rather than guessing', () => {
    const result = estimateBuyingWindow({ tier: 'DIRECTORY_PROSPECT', deadline: null, strongestSignal: null, now: NOW });
    expect(result.window).toBe('UNKNOWN');
    expect(result.reason).toMatch(/guess at timing/i);
  });
});

describe('outreach intensity scales with evidence', () => {
  it('never authorises a call on a directory prospect', () => {
    expect(TIER_OUTREACH.DIRECTORY_PROSPECT.channels).not.toContain('phone');
    expect(TIER_OUTREACH.PREDICTED_NEED.channels).not.toContain('phone');
  });

  it('authorises multi-channel pursuit only for active demand', () => {
    expect(TIER_OUTREACH.ACTIVE_DEMAND.channels).toContain('phone');
    expect(TIER_OUTREACH.REJECTED.channels).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The board states the funnel honestly
// ---------------------------------------------------------------------------

function hypothesis(over: Partial<BoardHypothesis> = {}): BoardHypothesis {
  return {
    id: 'h', pathId: 'p', pathName: 'Brokerage', leadRole: 'BUYER', stage: 'OPPORTUNITY_HYPOTHESIS',
    accountFit: 0.6, intent: 0, contactability: 0.3, fulfilment: 0, priority: 22,
    tier: 'DIRECTORY_PROSPECT', tierReason: 'Firmographic fit only.', rejectionFlags: [], buyingWindow: 'UNKNOWN',
    scoreExplanation: {}, requiredService: 'Cleaning', missing: [], sourceNames: ['Google Places'],
    sourceUrl: null, sourcePublishedAt: null, firstDiscoveredAt: NOW, lastSeenAt: NOW, lastIntentSignalAt: null,
    signalCount: 1, evidence: [], marketName: null, isLiveSource: true, ...over,
  };
}

function account(i: number, over: Partial<BoardHypothesis> = {}): BoardAccount {
  return {
    companyId: `c${i}`, name: `Business ${i}`, cityName: 'Dallas', stateCode: 'TX',
    phone: '214-555-0142', email: null, website: null, origin: 'LIVE_DISCOVERY',
    externalPlaceId: `ChIJ${i}`, normalizedPhone: `214555014${i}`, normalizedAddress: `${i} main st`,
    hypotheses: [hypothesis({ id: `h${i}`, ...over })],
  };
}

describe('pipeline truth', () => {
  it('says outright when a whole board carries no demand evidence', () => {
    // Twenty-two accounts, every one a directory listing. The board previously
    // presented this as a ranked work queue.
    const board = buildBoard({
      accounts: Array.from({ length: 22 }, (_, i) => account(i)),
      unassessedSignals: 0,
      now: NOW,
    });
    expect(board.pipeline.actionable).toBe(0);
    expect(board.noDemandFound).toMatch(/sourcing gap, not a scoring one/i);
    expect(board.noDemandFound).toMatch(/SAM\.gov|USAspending|permit/);
  });

  it('stops saying it as soon as one real lead exists', () => {
    const board = buildBoard({
      accounts: [
        ...Array.from({ length: 21 }, (_, i) => account(i)),
        account(99, { tier: 'ACTIVE_DEMAND', tierReason: 'Purchasing notice published 3 days ago.' }),
      ],
      unassessedSignals: 0,
      now: NOW,
    });
    expect(board.pipeline.actionable).toBe(1);
    expect(board.noDemandFound).toBeNull();
  });

  it('counts each tier separately rather than reporting one pipeline number', () => {
    const board = buildBoard({
      accounts: [
        account(1, { tier: 'ACTIVE_DEMAND' }),
        account(2, { tier: 'STRONG_TRIGGER' }),
        account(3, { tier: 'STRONG_TRIGGER' }),
        account(4, { tier: 'PREDICTED_NEED' }),
        account(5, { tier: 'DIRECTORY_PROSPECT' }),
        account(6, { tier: 'REJECTED', rejectionFlags: ['no provider in the network could fulfil this'] }),
      ],
      unassessedSignals: 4,
      now: NOW,
    });
    const counts = Object.fromEntries(board.pipeline.byTier.map((t) => [t.tier, t.count]));
    expect(counts).toMatchObject({
      ACTIVE_DEMAND: 1, STRONG_TRIGGER: 2, PREDICTED_NEED: 1, DIRECTORY_PROSPECT: 1, REJECTED: 1,
    });
    expect(board.pipeline.actionable).toBe(3);
    // Raw records include the unassessed ones; hypotheses do not.
    expect(board.pipeline.rawRecords).toBe(10);
    expect(board.pipeline.hypotheses).toBe(6);
  });

  it('does not count a rejected record as pipeline', () => {
    const board = buildBoard({
      accounts: [account(1, { tier: 'REJECTED', rejectionFlags: ['deadline has passed'] })],
      unassessedSignals: 0,
      now: NOW,
    });
    expect(board.pipeline.actionable).toBe(0);
    expect(board.pipeline.qualified).toBe(0);
  });
});
