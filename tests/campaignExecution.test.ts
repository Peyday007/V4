import { describe, expect, it } from 'vitest';
import { campaignTargets } from '@/lib/campaign/assign';
import type { CampaignOutcome } from '@/lib/campaign/outcomes';

/**
 * What a campaign is trying to reach, and whether it is getting there.
 *
 * The rule being tested is that targets are *derived* rather than typed. A
 * target somebody enters into a box has no consequence attached to it, and a
 * campaign that misses one carries on regardless; the kill and expand
 * conditions already on the record have consequences by construction, so they
 * are the targets, and deriving them means the two can never drift apart.
 *
 * The other half is the sentence. "3 of 3" tells an operator nothing about
 * whether to worry. "3 against a floor of 3, with two days before this applies"
 * tells them what to do this week, and that is the difference between a
 * dashboard and an operating system.
 */

const outcome = (over: Partial<CampaignOutcome> = {}): CampaignOutcome => ({
  campaignId: 'c1',
  routesGenerated: 12,
  conversationsHeld: 6,
  requirementsConfirmed: 1,
  providersVerified: 2,
  quotesSent: 0,
  commitmentsWon: 0,
  collectedGrossProfit: 0,
  spendCents: 0,
  daysRunning: 10,
  returnOnSpend: null,
  firstEmptyStage: 'QUOTES_SENT',
  ...over,
});

const kill = {
  kind: 'KILL',
  metric: 'REQUIREMENTS_CONFIRMED',
  comparator: 'AT_OR_BELOW',
  threshold: 0,
  afterDays: 21,
  statement: 'Three weeks with nobody confirming a requirement means the demand is not there.',
};

const expand = {
  kind: 'EXPAND',
  metric: 'REQUIREMENTS_CONFIRMED',
  comparator: 'AT_OR_ABOVE',
  threshold: 3,
  afterDays: 21,
  statement: 'Three buyers stating the same requirement is a market rather than a coincidence.',
};

describe('targets come from the conditions', () => {
  it('produces one target per condition and no others', () => {
    const targets = campaignTargets({ conditions: [kill, expand], outcome: outcome() });
    expect(targets).toHaveLength(2);
    expect(targets.map((t) => t.kind).sort()).toEqual(['EXPAND', 'KILL']);
  });

  it('reads the current value from the outcome rather than storing one', () => {
    const targets = campaignTargets({ conditions: [expand], outcome: outcome({ requirementsConfirmed: 2 }) });
    expect(targets[0].current).toBe(2);
    expect(targets[0].target).toBe(3);
  });

  it('treats a missing metric as nought rather than as unknown progress', () => {
    const targets = campaignTargets({
      conditions: [{ ...expand, metric: 'COLLECTED_GROSS_PROFIT' }],
      outcome: outcome({ collectedGrossProfit: 0 }),
    });
    expect(targets[0].current).toBe(0);
  });
});

describe('what the standing sentence says', () => {
  it('says a kill floor is cleared when it is', () => {
    const targets = campaignTargets({ conditions: [kill], outcome: outcome({ requirementsConfirmed: 2 }) });
    expect(targets[0].standing).toMatch(/Clear of this/);
  });

  it('warns while a kill condition would fire, before its date arrives', () => {
    // The whole value of this: an operator finds out on day ten, not day
    // twenty-one.
    const targets = campaignTargets({
      conditions: [kill],
      outcome: outcome({ requirementsConfirmed: 0, daysRunning: 10 }),
    });
    expect(targets[0].standing).toMatch(/11 day\(s\) before this applies/);
    expect(targets[0].standing).toMatch(/would stop the campaign/);
  });

  it('says a kill condition applies now once its date has passed', () => {
    const targets = campaignTargets({
      conditions: [kill],
      outcome: outcome({ requirementsConfirmed: 0, daysRunning: 30 }),
    });
    expect(targets[0].standing).toMatch(/applies now/);
    expect(targets[0].daysUntilJudged).toBe(0);
  });

  it('says an expand threshold is reached when it is', () => {
    const targets = campaignTargets({ conditions: [expand], outcome: outcome({ requirementsConfirmed: 4 }) });
    expect(targets[0].standing).toMatch(/^Reached/);
  });

  it('counts towards an expand threshold rather than scoring it', () => {
    const targets = campaignTargets({ conditions: [expand], outcome: outcome({ requirementsConfirmed: 1 }) });
    expect(targets[0].standing).toMatch(/^1 of 3/);
    expect(targets[0].standing).not.toMatch(/%/);
  });

  it('carries no days-remaining figure for a condition with no date', () => {
    const targets = campaignTargets({ conditions: [{ ...expand, afterDays: 0 }], outcome: outcome() });
    expect(targets[0].daysUntilJudged).toBeNull();
  });

  it('keeps the owner’s own statement rather than paraphrasing it', () => {
    const targets = campaignTargets({ conditions: [kill], outcome: outcome() });
    expect(targets[0].statement).toBe(kill.statement);
  });
});
