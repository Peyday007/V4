import { describe, expect, it } from 'vitest';
import { estimateEconomics, meetsEconomicFloor } from '@/lib/demand/economics';
import { playbooksFor } from '@/lib/demand/playbooks';

/**
 * Modelled money is a band, and the band is the honest form.
 *
 * The failure this replaces was not an arithmetic error. The pipeline took a
 * playbook range, halved it, rounded it and stored $2,650 — a figure with four
 * significant digits derived from a band spanning five times its own floor.
 * Everything downstream then treated it as an estimate of a particular deal,
 * and the precision did the persuading.
 *
 * So what is tested here is mostly the *shape* of the answer rather than its
 * value: that a range stays a range, that it never leaves the playbook's band,
 * that it never collapses to a point, and that every decision made from it is
 * made from the end where being wrong is cheap.
 */

const playbook = playbooksFor('OCCUPANCY_OR_OPERATING_APPROVAL')[0];

describe('a modelled amount is a range', () => {
  it('produces a low and a high, not a figure', () => {
    const economics = estimateEconomics({ playbook, scaleHint: null, availableProviders: 3, friction: 'LOW' });
    expect(economics.buyerPrice!.low).toBeLessThan(economics.buyerPrice!.high);
    expect(economics.grossProfit!.low).toBeLessThan(economics.grossProfit!.high);
    expect(economics.providerCost!.low).toBeLessThan(economics.providerCost!.high);
  });

  it('stays inside the band the playbook says this work sells in', () => {
    const economics = estimateEconomics({ playbook, scaleHint: null, availableProviders: 3, friction: 'LOW' });
    expect(economics.buyerPrice!.low).toBeGreaterThanOrEqual(playbook.typicalBuyerPrice.low);
    expect(economics.buyerPrice!.high).toBeLessThanOrEqual(playbook.typicalBuyerPrice.high);
  });

  it('narrows for a stated scale without collapsing to a point', () => {
    // A permit's square footage says something about the size of the job and
    // nothing about the price per unit, so the remaining width is honest.
    const wide = estimateEconomics({ playbook, scaleHint: null, availableProviders: 3, friction: 'LOW' });
    const narrowed = estimateEconomics({ playbook, scaleHint: 4000, availableProviders: 3, friction: 'LOW' });
    const width = (r: { low: number; high: number }) => r.high - r.low;
    expect(width(narrowed.buyerPrice!)).toBeLessThan(width(wide.buyerPrice!));
    expect(width(narrowed.buyerPrice!)).toBeGreaterThan(0);
  });

  it('does not let a large permit licence a large deal', () => {
    const huge = estimateEconomics({ playbook, scaleHint: 900_000, availableProviders: 3, friction: 'LOW' });
    expect(huge.buyerPrice!.high).toBeLessThanOrEqual(playbook.typicalBuyerPrice.high);
  });

  it('says where the band came from and what moved it', () => {
    const economics = estimateEconomics({ playbook, scaleHint: 6000, availableProviders: 2, friction: 'LOW' });
    expect(economics.buyerPrice!.basis).toMatch(/not a quote/i);
    expect(economics.buyerPrice!.inputs.length).toBeGreaterThanOrEqual(3);
    expect(economics.buyerPrice!.inputs.join(' ')).toContain('6,000');
  });

  it('carries a midpoint for ranking, and never claims it is the answer', () => {
    const economics = estimateEconomics({ playbook, scaleHint: null, availableProviders: 3, friction: 'LOW' });
    const price = economics.buyerPrice!;
    expect(price.midpoint).toBeGreaterThanOrEqual(price.low);
    expect(price.midpoint).toBeLessThanOrEqual(price.high);
    expect(price.basis).not.toContain(String(price.midpoint));
  });
});

describe('decisions are made from the end where being wrong is cheap', () => {
  it('ranks by profit per hour at the low end of the band', () => {
    const economics = estimateEconomics({ playbook, scaleHint: null, availableProviders: 3, friction: 'LOW' });
    const fromLow = Math.round((economics.grossProfit!.low / economics.humanMinutes) * 60);
    expect(economics.profitPerHumanHour).toBe(fromLow);
    // And is therefore strictly below what the optimistic reading would give.
    const fromHigh = Math.round((economics.grossProfit!.high / economics.humanMinutes) * 60);
    expect(economics.profitPerHumanHour!).toBeLessThan(fromHigh);
  });

  it('keeps costing time as friction rises', () => {
    const easy = estimateEconomics({ playbook, scaleHint: null, availableProviders: 3, friction: 'LOW' });
    const hard = estimateEconomics({ playbook, scaleHint: null, availableProviders: 3, friction: 'HIGH' });
    expect(hard.humanMinutes).toBeGreaterThan(easy.humanMinutes);
    expect(hard.profitPerHumanHour!).toBeLessThan(easy.profitPerHumanHour!);
  });

  it('treats an unknown assessment as expensive rather than cheap', () => {
    // An unqualified board should not look attractive.
    const unknown = estimateEconomics({
      playbook, scaleHint: null, availableProviders: 3, friction: 'UNKNOWN_RESEARCH_REQUIRED',
    });
    const easy = estimateEconomics({ playbook, scaleHint: null, availableProviders: 3, friction: 'LOW' });
    expect(unknown.humanMinutes).toBeGreaterThan(easy.humanMinutes);
  });
});

describe('no provider means no cost side', () => {
  it('returns nulls rather than a confident zero', () => {
    const economics = estimateEconomics({ playbook, scaleHint: null, availableProviders: 0, friction: 'LOW' });
    expect(economics.buyerPrice).toBeNull();
    expect(economics.providerCost).toBeNull();
    expect(economics.grossProfit).toBeNull();
    expect(economics.profitPerHumanHour).toBeNull();
  });

  it('and says why, in a sentence naming what is missing', () => {
    const economics = estimateEconomics({ playbook, scaleHint: null, availableProviders: 0, friction: 'LOW' });
    expect(economics.basis).toMatch(/no provider/i);
    expect(economics.basis).toMatch(/prior, not a quote/i);
  });

  it('still costs the human time, because researching it is real work', () => {
    const economics = estimateEconomics({ playbook, scaleHint: null, availableProviders: 0, friction: 'HIGH' });
    expect(economics.humanMinutes).toBeGreaterThan(0);
  });
});

describe('the economic floor', () => {
  it('refuses a route whose economics cannot be estimated', () => {
    const floor = meetsEconomicFloor({ grossProfit: null, humanMinutes: 60, minimumProfitPerHour: 150 });
    expect(floor.passes).toBe(false);
    expect(floor.reason).toMatch(/cannot be estimated/);
  });

  it('names the figure and the floor rather than just failing', () => {
    const floor = meetsEconomicFloor({ grossProfit: 60, humanMinutes: 120, minimumProfitPerHour: 150 });
    expect(floor.passes).toBe(false);
    expect(floor.reason).toContain('$150');
    expect(floor.reason).toMatch(/not worth the attention/);
  });
});
