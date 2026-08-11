import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildBoard, missingEvidence, type BoardAccount, type BoardHypothesis } from '@/lib/discovery/board';
import { describeDiscoveryTime, eventRecency } from '@/lib/discovery/eventTime';
import { needLabel, scorePriority } from '@/lib/discovery/qualification';

/**
 * The board as the operator actually sees it.
 *
 * Every test here corresponds to something that reached production and was
 * caught by a person reading the screen: 49 cards for 35 businesses, 47 of
 * them scoring exactly 88 under a zero-intent cap of 35, "Source gave no
 * publication date" printed next to "Published 0 days ago", and a category
 * match labelled "Identified need".
 */

const DAY = 86_400_000;
const NOW = new Date('2026-03-01T12:00:00Z');

function hypothesis(over: Partial<BoardHypothesis> = {}): BoardHypothesis {
  return {
    id: over.id ?? 'h1',
    pathId: 'p1',
    pathName: 'Brokerage',
    leadRole: 'BUYER',
    stage: 'OPPORTUNITY_HYPOTHESIS',
    accountFit: 0.6,
    intent: 0,
    contactability: 0.3,
    fulfilment: 0,
    priority: 22,
    tier: 'DIRECTORY_PROSPECT',
    tierReason: 'Firmographic fit only.',
    rejectionFlags: [],
    buyingWindow: 'UNKNOWN',
    scoreExplanation: {},
    requiredService: 'Medical facility cleaning',
    missing: [],
    sourceNames: ['Google Places'],
    sourceUrl: 'https://example.test/1',
    sourcePublishedAt: null,
    firstDiscoveredAt: NOW,
    lastSeenAt: NOW,
    lastIntentSignalAt: null,
    signalCount: 1,
    evidence: [],
    marketName: 'Nationwide',
    isLiveSource: true,
    ...over,
  };
}

function account(over: Partial<BoardAccount> = {}): BoardAccount {
  return {
    companyId: over.companyId ?? 'c1',
    name: over.name ?? 'Apex Clinic',
    cityName: 'Dallas',
    stateCode: 'TX',
    phone: '214-555-0142',
    email: null,
    website: null,
    origin: 'LIVE_DISCOVERY',
    externalPlaceId: 'ChIJapex',
    normalizedPhone: '2145550142',
    normalizedAddress: '1200 main st',
    hypotheses: [hypothesis()],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Discovery time is never event time
// ---------------------------------------------------------------------------

describe('ingestion time cannot become event time', () => {
  it('reports recency as unknown when the source published no date', () => {
    // The Places listing that scored "fresh" had no publication date at all.
    const recency = eventRecency(null, NOW);
    expect(recency.known).toBe(false);
    expect(recency.freshness).toBeNull();
    expect(recency.label).toMatch(/no event date/i);
    expect(recency.label).not.toMatch(/published \d+ day/i);
  });

  it('measures a known event from the source date, not from today', () => {
    const recency = eventRecency(new Date(NOW.getTime() - 45 * DAY), NOW);
    expect(recency.freshness).toBe('AGEING');
    expect(recency.days).toBe(45);
  });

  it('never labels a discovery timestamp as a publication', () => {
    const text = describeDiscoveryTime(NOW, NOW);
    expect(text).toMatch(/our timestamp, not an event/i);
    expect(text.toLowerCase()).not.toContain('publish');
  });

  it('carries no freshness weight for a record discovered today with no source date', () => {
    // This is the exact record that scored 88: ingested this morning, no
    // publication date, and every freshness term maxed out.
    const board = buildBoard({
      accounts: [account({ hypotheses: [hypothesis({ sourcePublishedAt: null, firstDiscoveredAt: NOW })] })],
      unassessedSignals: 0,
      now: NOW,
    });
    const rendered = board.accounts[0].hypotheses[0];
    expect(rendered.recency.known).toBe(false);
    expect(rendered.priority).toBeLessThanOrEqual(35);
  });
});

// ---------------------------------------------------------------------------
// A category match is an inference, never a stated need
// ---------------------------------------------------------------------------

describe('category-derived demand is labelled as an inference', () => {
  it('does not call a zero-intent buyer record an identified need', () => {
    const label = needLabel('BUYER', 0);
    expect(label.asserted).toBe(false);
    expect(label.heading).toMatch(/possible need/i);
    expect(label.heading).not.toMatch(/identified/i);
    expect(label.basis).toMatch(/not from anything they said/i);
  });

  it('calls a provider listing a claim, not a need', () => {
    const label = needLabel('PROVIDER', 0);
    expect(label.heading).toMatch(/claimed capability/i);
    expect(label.heading).not.toMatch(/need/i);
  });

  it('only asserts a need once a dated event exists', () => {
    expect(needLabel('BUYER', 0.6).heading).toBe('Stated need');
    expect(needLabel('BUYER', 0.6).asserted).toBe(true);
  });

  it('never emits the phrase that put words in a business’s mouth', () => {
    for (const role of ['BUYER', 'PROVIDER', 'SUPPLIER', 'CONTRACTOR'] as const) {
      for (const intent of [0, 0.5, 1]) {
        expect(needLabel(role, intent).heading).not.toMatch(/identified need/i);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// One business is one card
// ---------------------------------------------------------------------------

describe('accounts are the unit of display', () => {
  it('shows one card for a business found by two sources on two paths', () => {
    // The healthcare record legitimately has brokerage and distribution
    // candidacies. That is two hypotheses and one business.
    const board = buildBoard({
      accounts: [
        account({
          hypotheses: [
            hypothesis({ id: 'h1', pathName: 'Brokerage', priority: 22 }),
            hypothesis({ id: 'h2', pathId: 'p2', pathName: 'Distribution', priority: 18 }),
          ],
        }),
      ],
      unassessedSignals: 0,
      now: NOW,
    });

    expect(board.accounts).toHaveLength(1);
    expect(board.accounts[0].hypotheses).toHaveLength(2);
    expect(board.counts.accounts).toBe(1);
    expect(board.counts.hypotheses).toBe(2);
    // The account ranks on its strongest candidacy, not the sum of them.
    expect(board.accounts[0].topPriority).toBe(22);
  });

  it('counts collapsed duplicate records rather than rendering them', () => {
    // Anytime Fitness matched four Places queries and produced four signals.
    const board = buildBoard({
      accounts: [account({ name: 'Anytime Fitness', hypotheses: [hypothesis({ signalCount: 4 })] })],
      unassessedSignals: 0,
      now: NOW,
    });
    expect(board.accounts).toHaveLength(1);
    expect(board.accounts[0].collapsedSignals).toBe(3);
    expect(board.counts.signals).toBe(4);
    expect(board.counts.duplicateSignals).toBe(3);
  });

  it('reports unassessed records separately and gives them no score', () => {
    const board = buildBoard({ accounts: [account()], unassessedSignals: 12, now: NOW });
    expect(board.counts.unassessedSignals).toBe(12);
    // They are counted in the raw total but produce no account and no number.
    expect(board.counts.accounts).toBe(1);
    expect(board.counts.signals).toBe(13);
  });
});

// ---------------------------------------------------------------------------
// The board refuses to imply an order it cannot support
// ---------------------------------------------------------------------------

describe('a degenerate board declines to rank', () => {
  const uniform = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      account({
        companyId: `c${i}`,
        name: `Business ${String(i).padStart(2, '0')}`,
        externalPlaceId: `ChIJ${i}`,
        hypotheses: [hypothesis({ id: `h${i}`, accountFit: 1, contactability: 0.3, intent: 0, priority: 35 })],
      }),
    );

  it('withholds the ranking when every dimension is constant', () => {
    // Fit 100 and Contact 30 for twenty heterogeneous businesses: the exact
    // board that was shipped and presented as a work queue.
    const board = buildBoard({ accounts: uniform(20), unassessedSignals: 0, now: NOW });
    expect(board.diagnostics.verdict).toBe('NOT_CREDIBLE');
    expect(board.ranked).toBe(false);
    expect(board.rankingRefusedBecause).toMatch(/alphabetical order, not priority order/i);
  });

  it('orders alphabetically when it will not rank, so the order claims nothing', () => {
    const board = buildBoard({ accounts: uniform(20).reverse(), unassessedSignals: 0, now: NOW });
    const names = board.accounts.map((a) => a.name);
    expect(names).toEqual([...names].sort());
  });

  it('ranks by priority once the dimensions genuinely vary', () => {
    const varied = Array.from({ length: 12 }, (_, i) =>
      account({
        companyId: `c${i}`,
        name: `Business ${i}`,
        externalPlaceId: `ChIJ${i}`,
        hypotheses: [
          hypothesis({
            id: `h${i}`,
            accountFit: 0.2 + (i % 5) * 0.2,
            contactability: (i % 4) * 0.15,
            intent: (i % 3) * 0.3,
            fulfilment: (i % 4) * 0.25,
            priority: 10 + i * 3,
          }),
        ],
      }),
    );
    const board = buildBoard({ accounts: varied, unassessedSignals: 0, now: NOW });
    expect(board.ranked).toBe(true);
    const priorities = board.accounts.map((a) => a.topPriority ?? 0);
    expect(priorities).toEqual([...priorities].sort((a, b) => b - a));
  });

  it('sinks quarantined accounts below ranked ones', () => {
    const board = buildBoard({
      accounts: [
        // No place ID, phone or address: cannot be matched, so it is held.
        account({ companyId: 'q', name: 'Aaa Held', externalPlaceId: null, normalizedPhone: null, phone: null, normalizedAddress: null, hypotheses: [hypothesis({ id: 'hq', priority: 35 })] }),
        account({ companyId: 'r', name: 'Zzz Ranked', hypotheses: [hypothesis({ id: 'hr', priority: 10 })] }),
      ],
      unassessedSignals: 0,
      now: NOW,
    });
    expect(board.accounts[0].name).toBe('Zzz Ranked');
    expect(board.accounts[1].quarantined).toBe(true);
  });

  it('excludes quarantined accounts from the credibility assessment', () => {
    // Otherwise a batch of held records could invent or mask a distribution
    // problem in the population actually being worked.
    const board = buildBoard({
      accounts: [
        ...Array.from({ length: 10 }, (_, i) =>
          account({
            companyId: `c${i}`,
            name: `Ranked ${i}`,
            externalPlaceId: `ChIJ${i}`,
            hypotheses: [
              hypothesis({
                id: `h${i}`,
                accountFit: 0.2 + (i % 5) * 0.2,
                contactability: (i % 4) * 0.15,
                fulfilment: (i % 3) * 0.3,
                intent: (i % 4) * 0.2,
                priority: 5 + i * 2,
              }),
            ],
          }),
        ),
        ...Array.from({ length: 10 }, (_, i) =>
          account({
            companyId: `q${i}`,
            name: `Held ${i}`,
            externalPlaceId: null,
            phone: null,
            normalizedPhone: null,
            normalizedAddress: null,
            hypotheses: [hypothesis({ id: `hq${i}`, accountFit: 1, contactability: 0.3, priority: 35 })],
          }),
        ),
      ],
      unassessedSignals: 0,
      now: NOW,
    });
    expect(board.counts.quarantined).toBe(10);
    expect(board.diagnostics.distributions.find((d) => d.dimension === 'accountFit')?.count).toBe(10);
    expect(board.diagnostics.verdict).not.toBe('NOT_CREDIBLE');
  });
});

// ---------------------------------------------------------------------------
// No second scorer can reach the board
// ---------------------------------------------------------------------------

describe('there is exactly one score source', () => {
  it('has no second scorer left for the board to fall back to', () => {
    // The 88s came from a second scorer the page reached whenever a record had
    // no hypothesis attached. Deleting it is the fix, so the guard is against
    // any scoring path other than the stored hypothesis reappearing in the
    // render layer — a fallback is easy to reintroduce and invisible once it is.
    const root = resolve(__dirname, '..');
    expect(existsSync(join(root, 'lib/discovery/leadScore.ts'))).toBe(false);

    const files = ['app/(app)/leads/page.tsx', 'lib/discovery/board.ts'];
    for (const file of files) {
      // Comments discuss these names on purpose; only executable code counts.
      const code = readFileSync(join(root, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(code).not.toMatch(/scoreLead|leadScore/);
      // The ingestion timestamp. Reading it in the render path is how
      // "discovered today" became "published today".
      expect(code).not.toMatch(/observedAt/);
    }
  });

  it('cannot show a priority above the zero-intent cap', () => {
    // Every combination of the other three dimensions, at their maximum.
    for (const fit of [0, 0.5, 1]) {
      for (const contact of [0, 0.5, 1]) {
        for (const fulfil of [0, 0.5, 1]) {
          const { score } = scorePriority({ accountFit: fit, intent: 0, contactability: contact, fulfilmentReadiness: fulfil });
          expect(score).toBeLessThanOrEqual(35);
        }
      }
    }
  });

  it('lists the open qualification gates rather than only a stage name', () => {
    expect(
      missingEvidence({ needEvidence: null, decisionMakerId: null, timingEvidence: null, accountFit: 0.6, nextStep: null }),
    ).toEqual(['a stated need', 'a named decision-maker', 'any timing', 'sufficient account fit', 'an agreed next step']);

    expect(
      missingEvidence({ needEvidence: { x: 1 }, decisionMakerId: 'd1', timingEvidence: { y: 2 }, accountFit: 0.9, nextStep: 'call Tuesday' }),
    ).toEqual([]);
  });
});
