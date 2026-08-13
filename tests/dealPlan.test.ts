import { describe, expect, it } from 'vitest';
import { buildDealPlan, type DemandContext } from '@/lib/deal/plan';
import type { DealRecord } from '@/lib/deal/record';

/**
 * The rules that decide what an owner is told to do next.
 *
 * Worth testing hard rather than eyeballing on a page, because every one of
 * these distinctions is one somebody under time pressure would otherwise
 * collapse: a candidate into fulfilment, an accepted quote into a commitment,
 * an invoice into money, a waiting deal into a broken one.
 */

const demand = (over: Partial<DemandContext> = {}): DemandContext => ({
  externalDate: new Date('2026-08-01'),
  windowClosesAt: new Date('2026-12-01'),
  deadlineAt: null,
  hasContactRoute: true,
  contactBlocker: null,
  discoveryAttempts: 1,
  lastAttemptAt: new Date('2026-08-05'),
  terminalReason: null,
  ...over,
});

/** A record whose every stage is unfinished, to be filled in per test. */
function record(over: Record<string, unknown> = {}): DealRecord {
  const base = {
    routeId: 'route-1',
    requirement: { current: null, history: [], confirmed: [], ready: false, missing: ['No buyer requirement recorded.'], headline: '' },
    supply: {
      best: null, secured: false, candidateCount: 0, liveCount: 0,
      staleCostIds: [], overduePromiseIds: [], headline: 'Nobody yet.', candidates: [],
    },
    quotes: { live: null, history: [], basisLabel: null, blocking: [], headline: '' },
    deal: { record: null, money: null, headline: '' },
    room: {
      exists: false, state: null, proofStep: null, openCount: 0, sentAt: null,
      firstOpenAt: null, expiresAt: null, responseNote: null, engagement: [], headline: '',
    },
    events: [],
  };
  return { ...base, ...over } as unknown as DealRecord;
}

const plan = (r: DealRecord, d = demand()) => buildDealPlan({ record: r, demand: d });

describe('the chain from demand to money', () => {
  it('names the first rung that is actually ours to move', () => {
    const result = plan(record());
    expect(result.firstBroken?.key).toBe('REQUIREMENT');
    expect(result.headline).toContain('requirement');
  });

  it('blocks on the contact before the conversation, because you cannot call nobody', () => {
    const result = plan(record(), demand({ hasContactRoute: false, discoveryAttempts: 0 }));
    expect(result.firstBroken?.key).toBe('RESOLVED_CONTACT');
  });

  it('blocks on a date the source stated, never on our own first-seen timestamp', () => {
    const result = plan(record(), demand({ externalDate: null }));
    expect(result.firstBroken?.key).toBe('DATED_DEMAND');
  });

  it('gives every stage an owner, a completion condition and an evidence requirement', () => {
    for (const stage of plan(record()).stages) {
      expect(stage.owner.length).toBeGreaterThan(0);
      expect(stage.completionCondition.length).toBeGreaterThan(0);
      expect(stage.evidenceRequired.length).toBeGreaterThan(0);
    }
  });

  it('gives every blocked stage a next action, and every finished stage none', () => {
    const result = plan(record());
    for (const stage of result.stages) {
      if (stage.state === 'BLOCKED') expect(stage.nextAction, stage.key).toBeTruthy();
      if (stage.state === 'DONE') expect(stage.nextAction, stage.key).toBeNull();
    }
  });
});

describe('a candidate is not fulfilment', () => {
  const ready = {
    requirement: { current: {}, history: [], confirmed: [], ready: true, missing: [], headline: '' },
  };

  it('treats an unverified candidate as a blocked provider stage', () => {
    const result = plan(record({
      ...ready,
      supply: {
        best: 'IDENTIFIED', secured: false, candidateCount: 1, liveCount: 1,
        staleCostIds: [], overduePromiseIds: [], headline: 'One candidate.',
        candidates: [{ costAmount: null, costExpiresAt: null }],
      },
    }));
    expect(result.firstBroken?.key).toBe('PROVIDER');
    expect(result.firstBroken?.because).toMatch(/candidate is a name, not fulfilment/i);
  });

  it('moves to cost only once somebody has verified the provider', () => {
    const result = plan(record({
      ...ready,
      supply: {
        best: 'VERIFIED', secured: false, candidateCount: 1, liveCount: 1,
        staleCostIds: [], overduePromiseIds: [], headline: 'Verified.',
        candidates: [{ costAmount: null, costExpiresAt: null }],
      },
    }));
    expect(result.firstBroken?.key).toBe('PROVIDER_COST');
  });

  it('refuses to treat an expired cost as a cost', () => {
    const result = plan(record({
      ...ready,
      supply: {
        best: 'QUOTED', secured: false, candidateCount: 1, liveCount: 1,
        staleCostIds: ['c1'], overduePromiseIds: [], headline: 'Quoted.',
        candidates: [{ costAmount: 100, costExpiresAt: new Date('2020-01-01') }],
      },
    }));
    expect(result.firstBroken?.key).toBe('PROVIDER_COST');
    expect(result.firstBroken?.because).toMatch(/expired/i);
  });
});

describe('waiting is not the same as blocked', () => {
  const priced = {
    requirement: { current: {}, history: [], confirmed: [], ready: true, missing: [], headline: '' },
    supply: {
      best: 'QUOTED', secured: false, candidateCount: 1, liveCount: 1,
      staleCostIds: [], overduePromiseIds: [], headline: 'Quoted.',
      candidates: [{ costAmount: 100, costExpiresAt: new Date('2099-01-01') }],
    },
  };

  it('a sent quote is waiting on them, not broken for us', () => {
    const result = plan(record({
      ...priced,
      quotes: { live: { state: 'SENT', validUntil: null }, history: [], basisLabel: null, blocking: [], headline: '' },
    }));
    expect(result.stages.find((s) => s.key === 'OFFER')?.state).toBe('WAITING_EXTERNAL');
    expect(result.firstBroken).toBeNull();
    expect(result.waitingOn.map((s) => s.key)).toContain('OFFER');
    expect(result.headline).toMatch(/waiting on somebody outside/i);
  });

  it('a drafted quote awaiting approval is ours to move', () => {
    const result = plan(record({
      ...priced,
      quotes: {
        live: { state: 'DRAFT', validUntil: null }, history: [], basisLabel: null,
        blocking: [{ id: 'a1' }], headline: '',
      },
    }));
    expect(result.firstBroken?.key).toBe('OFFER');
    expect(result.firstBroken?.nextAction).toMatch(/approve/i);
  });

  it('marks sending a price as needing authority', () => {
    const offer = plan(record(priced)).stages.find((s) => s.key === 'OFFER');
    expect(offer?.needsAuthority).toBe(true);
  });
});

describe('an accepted quote is not a commitment', () => {
  const accepted = {
    requirement: { current: {}, history: [], confirmed: [], ready: true, missing: [], headline: '' },
    supply: {
      best: 'QUOTED', secured: false, candidateCount: 1, liveCount: 1,
      staleCostIds: [], overduePromiseIds: [], headline: '',
      candidates: [{ costAmount: 100, costExpiresAt: new Date('2099-01-01') }],
    },
    quotes: { live: { state: 'ACCEPTED', validUntil: null }, history: [], basisLabel: null, blocking: [], headline: '' },
  };

  it('still demands a recorded commitment after acceptance', () => {
    const result = plan(record(accepted));
    expect(result.firstBroken?.key).toBe('COMMITMENTS');
    expect(result.firstBroken?.because).toMatch(/accepted quote is not a commitment/i);
  });

  it('says plainly when the buyer is committed and the provider is not', () => {
    const result = plan(record({
      ...accepted,
      deal: {
        record: { buyerCommittedAt: new Date(), buyerCommitmentBasis: 'EMAIL', providerCommittedAt: null, milestones: [], payments: [] },
        money: null, headline: '',
      },
    }));
    expect(result.firstBroken?.key).toBe('COMMITMENTS');
    expect(result.firstBroken?.because).toMatch(/exposed/i);
  });
});

describe('invoiced, paid and collected are different things', () => {
  const delivered = {
    requirement: { current: {}, history: [], confirmed: [], ready: true, missing: [], headline: '' },
    supply: {
      best: 'COMMITTED', secured: true, candidateCount: 1, liveCount: 1,
      staleCostIds: [], overduePromiseIds: [], headline: '',
      candidates: [{ costAmount: 100, costExpiresAt: new Date('2099-01-01') }],
    },
    quotes: { live: { state: 'ACCEPTED', validUntil: null }, history: [], basisLabel: null, blocking: [], headline: '' },
  };
  const dealAt = (over: Record<string, unknown>) => ({
    record: {
      buyerCommittedAt: new Date(), buyerCommitmentBasis: 'EMAIL',
      providerCommittedAt: new Date(), providerCommitmentBasis: 'EMAIL',
      deliveryStartedAt: new Date(), deliveryCompletedAt: new Date(),
      milestones: [], payments: [], ...over,
    },
    headline: '',
  });

  it('delivered but unbilled blocks on the invoice', () => {
    const result = plan(record({ ...delivered, deal: { ...dealAt({}), money: null } }));
    expect(result.firstBroken?.key).toBe('INVOICE');
  });

  it('invoiced and unpaid waits on the buyer rather than blocking us', () => {
    const result = plan(record({
      ...delivered,
      deal: {
        ...dealAt({}),
        money: { invoiced: 5000, collected: 0, paidOut: 0, outstanding: 5000, collectedGrossProfit: 0, fullySettled: false },
      },
    }));
    expect(result.stages.find((s) => s.key === 'PAYMENT')?.state).toBe('WAITING_EXTERNAL');
    expect(result.firstBroken?.key).toBe('COLLECTED_PROFIT');
  });

  it('reports collected gross profit only once everything has settled', () => {
    const unsettled = plan(record({
      ...delivered,
      deal: {
        ...dealAt({}),
        money: { invoiced: 5000, collected: 5000, paidOut: 0, outstanding: 0, collectedGrossProfit: 5000, fullySettled: false },
      },
    }));
    expect(unsettled.stages.find((s) => s.key === 'COLLECTED_PROFIT')?.state).not.toBe('DONE');
    expect(unsettled.stages.find((s) => s.key === 'COLLECTED_PROFIT')?.because).toMatch(/only claims/i);

    const settled = plan(record({
      ...delivered,
      deal: {
        ...dealAt({}),
        money: { invoiced: 5000, collected: 5000, paidOut: 3000, outstanding: 0, collectedGrossProfit: 2000, fullySettled: true },
      },
    }));
    expect(settled.stages.find((s) => s.key === 'COLLECTED_PROFIT')?.state).toBe('DONE');
    expect(settled.firstBroken).toBeNull();
  });
});

describe('a dead route stops generating work', () => {
  it('replaces every outstanding action with the reason it was closed', () => {
    const result = plan(record(), demand({ terminalReason: 'They asked never to be contacted again.' }));
    expect(result.firstBroken).toBeNull();
    expect(result.headline).toMatch(/never to be contacted/i);
    for (const stage of result.stages) expect(stage.nextAction).toBeNull();
  });
});
