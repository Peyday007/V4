import { describe, expect, it } from 'vitest';
import { callCost, CHANNEL_CAPABILITY, recommendChannel, smsCost, type ChannelStats } from '@/lib/ai/outreach';
import { countSegments } from '@/lib/providers/sms';
import { DEFAULT_CONFIG } from '@/lib/config';

function stats(channel: 'CALL' | 'SMS' | 'EMAIL', overrides: Partial<ChannelStats> = {}): ChannelStats {
  return {
    channel,
    attempts: 0,
    reached: 0,
    meaningful: 0,
    optedOut: 0,
    factsCaptured: 0,
    opportunitiesAdvanced: 0,
    totalCost: 0,
    costPerAttempt: 0,
    costPerReach: null,
    costPerMeaningful: null,
    reachRate: 0,
    meaningfulRate: 0,
    medianResponseMinutes: null,
    ...overrides,
  };
}

describe('countSegments', () => {
  it('bills a short plain message as one segment', () => {
    expect(countSegments('Are you free Thursday?')).toBe(1);
  });

  it('splits long messages the way carriers bill them', () => {
    expect(countSegments('a'.repeat(160))).toBe(1);
    expect(countSegments('a'.repeat(161))).toBe(2);
    expect(countSegments('a'.repeat(400))).toBe(3);
  });

  it('drops to 70 characters when a single non-GSM character appears', () => {
    // One curly quote or emoji switches the whole message to UCS-2. Missing
    // this understates cost by more than double on a normal-looking message.
    expect(countSegments('a'.repeat(100))).toBe(1);
    expect(countSegments('a'.repeat(100) + '😀')).toBe(2);
  });
});

describe('cost model', () => {
  it('prices a call on caller time, not the carrier', () => {
    const cost = callCost(300, DEFAULT_CONFIG.outreachCosts);
    // 5 min call + 2 min wrap-up = 7 min of a $22/hr caller ≈ $2.57, plus pennies of carrier.
    expect(cost).toBeGreaterThan(2.5);
    expect(cost).toBeLessThan(2.7);
  });

  it('counts wrap-up time, because a 30-second call still occupies a caller', () => {
    const withWrap = callCost(30, DEFAULT_CONFIG.outreachCosts);
    const rawTalkTime = (30 / 3600) * DEFAULT_CONFIG.outreachCosts.callerHourlyRate;
    expect(withWrap).toBeGreaterThan(rawTalkTime * 4);
  });

  it('makes SMS orders of magnitude cheaper than a call', () => {
    const call = callCost(300, DEFAULT_CONFIG.outreachCosts);
    const sms = smsCost(1, DEFAULT_CONFIG.outreachCosts);
    expect(sms).toBeLessThan(call / 100);
  });
});

describe('CHANNEL_CAPABILITY', () => {
  it('keeps open-ended qualification on the phone', () => {
    expect(CHANNEL_CAPABILITY.BUYER_QUALIFICATION.viable).toEqual(['CALL']);
    expect(CHANNEL_CAPABILITY.PRIME_QUALIFICATION.viable).toEqual(['CALL']);
  });

  it('keeps negotiation and complaints on the phone', () => {
    expect(CHANNEL_CAPABILITY.NEGOTIATION_SUPPORT.viable).toEqual(['CALL']);
    expect(CHANNEL_CAPABILITY.FULFILLMENT_ISSUE.viable).toEqual(['CALL']);
  });

  it('sends closed questions to SMS', () => {
    expect(CHANNEL_CAPABILITY.AVAILABILITY_CONFIRMATION.best).toBe('SMS');
    expect(CHANNEL_CAPABILITY.QUOTE_FOLLOW_UP.best).toBe('SMS');
    expect(CHANNEL_CAPABILITY.RELATIONSHIP_REACTIVATION.best).toBe('SMS');
  });

  it('sends spec-bearing requests to email', () => {
    expect(CHANNEL_CAPABILITY.PRICING_REQUEST.best).toBe('EMAIL');
  });
});

describe('recommendChannel', () => {
  const minimumSample = 20;

  it('falls back to capability when there is no data at all', () => {
    const result = recommendChannel({
      purpose: 'BUYER_QUALIFICATION',
      stats: [stats('CALL'), stats('SMS'), stats('EMAIL')],
      minimumSample,
    });
    expect(result.recommended).toBe('CALL');
    expect(result.confidence).toBe('default');
  });

  it('stays provisional below the sample threshold and says so', () => {
    const result = recommendChannel({
      purpose: 'QUOTE_FOLLOW_UP',
      stats: [
        stats('CALL', { attempts: 5, meaningful: 2, costPerMeaningful: 6.4, meaningfulRate: 0.4 }),
        stats('SMS', { attempts: 4, meaningful: 2, costPerMeaningful: 0.02, meaningfulRate: 0.5 }),
      ],
      minimumSample,
    });
    expect(result.confidence).toBe('provisional');
    expect(result.caveats.join(' ')).toMatch(/under the 20 needed/i);
  });

  it('switches to the cheaper channel once both have a real sample', () => {
    const result = recommendChannel({
      purpose: 'QUOTE_FOLLOW_UP',
      stats: [
        stats('CALL', { attempts: 40, meaningful: 12, costPerMeaningful: 8.5, meaningfulRate: 0.3 }),
        stats('SMS', { attempts: 40, meaningful: 14, costPerMeaningful: 0.03, meaningfulRate: 0.35 }),
      ],
      minimumSample,
    });
    expect(result.recommended).toBe('SMS');
    expect(result.confidence).toBe('measured');
  });

  it('never recommends a channel that cannot do the job, however cheap', () => {
    // SMS at a thousandth of the cost still cannot run a qualification call.
    const result = recommendChannel({
      purpose: 'BUYER_QUALIFICATION',
      stats: [
        stats('CALL', { attempts: 50, meaningful: 20, costPerMeaningful: 9.0, meaningfulRate: 0.4 }),
        stats('SMS', { attempts: 50, meaningful: 25, costPerMeaningful: 0.01, meaningfulRate: 0.5 }),
      ],
      minimumSample,
    });
    expect(result.recommended).toBe('CALL');
  });

  it('warns when the cheaper channel simply fails more cheaply', () => {
    const result = recommendChannel({
      purpose: 'QUOTE_FOLLOW_UP',
      stats: [
        stats('CALL', { attempts: 40, meaningful: 20, costPerMeaningful: 5.0, meaningfulRate: 0.5 }),
        stats('SMS', { attempts: 200, meaningful: 20, costPerMeaningful: 0.08, meaningfulRate: 0.1 }),
      ],
      minimumSample,
    });
    expect(result.recommended).toBe('SMS');
    expect(result.caveats.join(' ')).toMatch(/not the same as more outcomes/i);
  });

  it('flags opt-outs, which are permanent', () => {
    const result = recommendChannel({
      purpose: 'RELATIONSHIP_REACTIVATION',
      stats: [
        stats('CALL', { attempts: 30, meaningful: 6, costPerMeaningful: 12, meaningfulRate: 0.2 }),
        stats('SMS', { attempts: 30, meaningful: 7, costPerMeaningful: 0.04, meaningfulRate: 0.23, optedOut: 3 }),
      ],
      minimumSample,
    });
    expect(result.caveats.join(' ')).toMatch(/opted out/i);
  });
});
