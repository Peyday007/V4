import type { CallType, MessageChannel } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getOrgConfig, type OrgConfig } from '@/lib/config';
import { clamp01, round } from './decisions';

export const OUTREACH_VERSION = 'outreach_channels@1';

export type Channel = 'CALL' | 'SMS' | 'EMAIL';

export type ChannelStats = {
  channel: Channel;
  attempts: number;
  reached: number;
  meaningful: number;
  optedOut: number;
  factsCaptured: number;
  opportunitiesAdvanced: number;
  totalCost: number;
  costPerAttempt: number;
  costPerReach: number | null;
  costPerMeaningful: number | null;
  reachRate: number;
  meaningfulRate: number;
  medianResponseMinutes: number | null;
};

export type ChannelRecommendation = {
  purpose: CallType;
  purposeLabel: string;
  recommended: Channel;
  reason: string;
  confidence: 'measured' | 'provisional' | 'default';
  sampleSize: number;
  stats: ChannelStats[];
  savingsPerHundred: number | null;
  caveats: string[];
};

/**
 * What each channel is structurally capable of.
 *
 * This is the part that stops the system chasing the cheapest number off a
 * cliff. SMS costs a fraction of a call, but you cannot extract a scope, a
 * price and an insurance limit over text — the reply is too short and the
 * follow-up questions never happen. So cost only decides between channels that
 * can both actually do the job.
 */
export const CHANNEL_CAPABILITY: Record<
  CallType,
  { viable: Channel[]; best: Channel; why: string; smsNote?: string }
> = {
  BUYER_QUALIFICATION: {
    viable: ['CALL'],
    best: 'CALL',
    why: 'Qualification is open-ended discovery — scope, timing, incumbent, budget, and the follow-up questions each answer creates. Text replies are too short to carry it, and a wrong assumption here poisons everything downstream.',
    smsNote: 'SMS can book the qualification call, which is cheaper than dialling until someone answers.',
  },
  PRIME_QUALIFICATION: {
    viable: ['CALL'],
    best: 'CALL',
    why: 'Same as buyer qualification, and the contact is usually senior enough that a cold text reads as a mistake.',
    smsNote: 'Use SMS only after a relationship exists, to schedule.',
  },
  SUBCONTRACTOR_RECRUITMENT: {
    viable: ['CALL', 'SMS'],
    best: 'CALL',
    why: 'You need capacity, territory, insurance limits and rates — several facts, each with conditions. A call gets them in one pass.',
    smsNote: 'Trades answer texts far more reliably than calls when they are on a job. A short "have capacity for X in Y?" text often gets a same-day yes that a call never would.',
  },
  SUPPLIER_QUALIFICATION: {
    viable: ['CALL', 'EMAIL'],
    best: 'CALL',
    why: 'Specification and pricing need back-and-forth, but suppliers are used to quoting from a written spec.',
    smsNote: 'Too much detail for SMS.',
  },
  AVAILABILITY_CONFIRMATION: {
    viable: ['SMS', 'CALL', 'EMAIL'],
    best: 'SMS',
    why: 'A single closed question with a yes or no answer. This is what texting is for, and it costs a fraction of a percent of a call.',
  },
  PRICING_REQUEST: {
    viable: ['EMAIL', 'CALL'],
    best: 'EMAIL',
    why: 'Pricing needs the written specification attached, and the supplier needs a document to quote against. Email carries it; a call makes them write it down themselves.',
    smsNote: 'Use SMS to nudge an unanswered emailed request.',
  },
  QUOTE_FOLLOW_UP: {
    viable: ['SMS', 'CALL', 'EMAIL'],
    best: 'SMS',
    why: 'A closed question — did you see it, what is the decision date. Texts get read; follow-up calls mostly reach voicemail, and a voicemail is a wasted call charged at full caller cost.',
  },
  TRIAL_ORDER_REQUEST: {
    viable: ['CALL', 'SMS'],
    best: 'CALL',
    why: 'You are asking for a commitment, and objections need handling in the moment.',
    smsNote: 'Reasonable for warm accounts that already know you.',
  },
  BACKUP_PROVIDER_POSITIONING: {
    viable: ['SMS', 'CALL', 'EMAIL'],
    best: 'SMS',
    why: 'A low-stakes ask that costs the buyer nothing to accept. It does not need a conversation, and text removes the friction of being interrupted.',
  },
  NEGOTIATION_SUPPORT: {
    viable: ['CALL'],
    best: 'CALL',
    why: 'Terms move in a conversation. Negotiating by text creates a written record of positions nobody meant to commit to.',
  },
  EXPANSION_REQUEST: {
    viable: ['CALL', 'SMS', 'EMAIL'],
    best: 'CALL',
    why: 'You have delivered and earned the conversation. Use it — expansion asks convert far better with a voice behind them.',
    smsNote: 'SMS works to book the expansion conversation.',
  },
  RELATIONSHIP_REACTIVATION: {
    viable: ['SMS', 'EMAIL', 'CALL'],
    best: 'SMS',
    why: 'Reactivation is a numbers game against a list that has gone cold. Calling it burns caller hours at a low hit rate; texting it costs almost nothing and surfaces the few who are back in market.',
  },
  FULFILLMENT_ISSUE: {
    viable: ['CALL'],
    best: 'CALL',
    why: 'Something has gone wrong. Texting about it reads as avoidance and makes an unhappy customer angrier.',
  },
};

export function humanPurpose(purpose: CallType): string {
  return purpose.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

/** Fully-loaded cost of one call: caller time dominates, not the carrier. */
export function callCost(durationSec: number, costs: OrgConfig['outreachCosts']): number {
  const occupiedSec = durationSec + costs.callWrapUpSeconds;
  const labour = (occupiedSec / 3600) * costs.callerHourlyRate;
  const carrier = (durationSec / 60) * costs.telephonyPerMinute;
  return round(labour + carrier, 4);
}

export function smsCost(segments: number, costs: OrgConfig['outreachCosts']): number {
  return round(segments * costs.smsPerSegment, 4);
}

/**
 * Picks a channel for a purpose from measured results where they exist, and
 * from structural capability where they do not.
 *
 * Cost only breaks ties between channels that can both do the job — otherwise
 * the cheapest channel always "wins" by failing more cheaply.
 */
export function recommendChannel(input: {
  purpose: CallType;
  stats: ChannelStats[];
  minimumSample: number;
}): { recommended: Channel; reason: string; confidence: 'measured' | 'provisional' | 'default'; caveats: string[] } {
  const capability = CHANNEL_CAPABILITY[input.purpose];
  const caveats: string[] = [];

  const viable = input.stats.filter((s) => capability.viable.includes(s.channel));
  const withData = viable.filter((s) => s.attempts >= input.minimumSample && s.costPerMeaningful !== null);

  if (withData.length < 2) {
    const measured = viable.filter((s) => s.attempts > 0);
    if (measured.length > 0) {
      caveats.push(
        `Only ${measured.map((s) => `${s.attempts} ${s.channel.toLowerCase()}`).join(', ')} attempt(s) on record — under the ${input.minimumSample} needed per channel to compare them fairly.`,
      );
    }
    return {
      recommended: capability.best,
      reason: capability.why,
      confidence: measured.length > 0 ? 'provisional' : 'default',
      caveats,
    };
  }

  const ranked = [...withData].sort((a, b) => (a.costPerMeaningful ?? Infinity) - (b.costPerMeaningful ?? Infinity));
  const winner = ranked[0];
  const runnerUp = ranked[1];

  // A channel that is cheaper per outcome but barely produces outcomes is a
  // false economy — it just fails cheaply and hands you a smaller pipeline.
  if (winner.meaningfulRate < runnerUp.meaningfulRate * 0.5) {
    caveats.push(
      `${winner.channel} is cheaper per result but produces meaningful responses at ${(winner.meaningfulRate * 100).toFixed(0)}% against ${runnerUp.channel}'s ${(runnerUp.meaningfulRate * 100).toFixed(0)}%. Cheaper per outcome is not the same as more outcomes — if you are capacity-constrained on deals rather than on budget, stay with ${runnerUp.channel}.`,
    );
  }
  if (winner.optedOut > 0) {
    caveats.push(`${winner.optedOut} contact(s) opted out via ${winner.channel}. Each one is permanently unreachable on that channel.`);
  }

  return {
    recommended: winner.channel,
    reason:
      `Measured over ${withData.reduce((sum, s) => sum + s.attempts, 0)} attempts: ${winner.channel} costs ` +
      `$${winner.costPerMeaningful?.toFixed(2)} per meaningful response against ${runnerUp.channel}'s $${runnerUp.costPerMeaningful?.toFixed(2)}. ` +
      capability.why,
    confidence: 'measured',
    caveats,
  };
}

/** Builds per-purpose channel comparisons from recorded history. */
export async function compareChannels(orgId: string): Promise<ChannelRecommendation[]> {
  const config = await getOrgConfig(orgId);
  const costs = config.outreachCosts;

  const [calls, messages] = await Promise.all([
    prisma.call.findMany({
      where: { orgId },
      include: { assignment: true, transcript: { include: { facts: true } } },
    }),
    prisma.message.findMany({ where: { orgId, direction: 'outbound' } }),
  ]);

  const purposes = new Set<CallType>();
  for (const call of calls) if (call.assignment?.callType) purposes.add(call.assignment.callType);
  for (const message of messages) if (message.purpose) purposes.add(message.purpose);
  // Always show the purposes where channel choice actually matters.
  for (const purpose of ['QUOTE_FOLLOW_UP', 'AVAILABILITY_CONFIRMATION', 'BACKUP_PROVIDER_POSITIONING', 'RELATIONSHIP_REACTIVATION', 'BUYER_QUALIFICATION'] as CallType[]) {
    purposes.add(purpose);
  }

  const recommendations: ChannelRecommendation[] = [];

  for (const purpose of purposes) {
    const purposeCalls = calls.filter((c) => c.assignment?.callType === purpose);
    const purposeMessages = messages.filter((m) => m.purpose === purpose);

    const callStats = buildCallStats(purposeCalls, costs);
    const smsStats = buildMessageStats('SMS', purposeMessages.filter((m) => m.channel === 'SMS'));
    const emailStats = buildMessageStats('EMAIL', purposeMessages.filter((m) => m.channel === 'EMAIL'));
    const stats = [callStats, smsStats, emailStats];

    const { recommended, reason, confidence, caveats } = recommendChannel({
      purpose,
      stats,
      minimumSample: config.outreachRules.minimumSampleForChannelRecommendation,
    });

    // What switching a hundred touches would save, when both are measurable.
    const current = callStats.costPerMeaningful;
    const proposed = stats.find((s) => s.channel === recommended)?.costPerMeaningful ?? null;
    const savingsPerHundred =
      recommended !== 'CALL' && current !== null && proposed !== null
        ? round((current - proposed) * 100)
        : null;

    const capability = CHANNEL_CAPABILITY[purpose];
    if (capability.smsNote && recommended !== 'SMS') caveats.push(`On SMS: ${capability.smsNote}`);

    recommendations.push({
      purpose,
      purposeLabel: humanPurpose(purpose),
      recommended,
      reason,
      confidence,
      sampleSize: stats.reduce((sum, s) => sum + s.attempts, 0),
      stats,
      savingsPerHundred,
      caveats,
    });
  }

  const order: Record<string, number> = { measured: 0, provisional: 1, default: 2 };
  recommendations.sort((a, b) => order[a.confidence] - order[b.confidence] || b.sampleSize - a.sampleSize);
  return recommendations;
}

type CallRow = {
  outcome: string | null;
  durationSec: number | null;
  transcript: { facts: unknown[] } | null;
  assignment: { opportunityId: string | null } | null;
};

function buildCallStats(calls: CallRow[], costs: OrgConfig['outreachCosts']): ChannelStats {
  const attempts = calls.length;
  const reached = calls.filter((c) => c.outcome === 'CONNECTED').length;
  const meaningful = calls.filter((c) => c.outcome === 'CONNECTED' && (c.durationSec ?? 0) >= 60).length;
  const factsCaptured = calls.reduce((sum, c) => sum + (c.transcript?.facts.length ?? 0), 0);
  const advanced = new Set(calls.filter((c) => c.outcome === 'CONNECTED').map((c) => c.assignment?.opportunityId).filter(Boolean)).size;
  const totalCost = round(calls.reduce((sum, c) => sum + callCost(c.durationSec ?? 45, costs), 0), 2);
  const optedOut = calls.filter((c) => c.outcome === 'DO_NOT_CALL').length;

  return {
    channel: 'CALL',
    attempts,
    reached,
    meaningful,
    optedOut,
    factsCaptured,
    opportunitiesAdvanced: advanced,
    totalCost,
    costPerAttempt: attempts ? round(totalCost / attempts, 3) : 0,
    costPerReach: reached ? round(totalCost / reached, 2) : null,
    costPerMeaningful: meaningful ? round(totalCost / meaningful, 2) : null,
    reachRate: attempts ? round(reached / attempts, 3) : 0,
    meaningfulRate: attempts ? round(meaningful / attempts, 3) : 0,
    medianResponseMinutes: null,
  };
}

type MessageRow = {
  outcome: string | null;
  costCents: number;
  responseTimeSec: number | null;
  opportunityId: string | null;
};

function buildMessageStats(channel: Channel, messages: MessageRow[]): ChannelStats {
  const attempts = messages.length;
  const delivered = messages.filter((m) => m.outcome !== 'UNDELIVERABLE').length;
  const replied = messages.filter((m) => m.outcome?.startsWith('REPLIED')).length;
  const meaningful = messages.filter((m) => m.outcome === 'REPLIED_POSITIVE' || m.outcome === 'REPLIED_NEUTRAL').length;
  const optedOut = messages.filter((m) => m.outcome === 'OPTED_OUT').length;
  const advanced = new Set(messages.filter((m) => m.outcome?.startsWith('REPLIED')).map((m) => m.opportunityId).filter(Boolean)).size;
  const totalCost = round(messages.reduce((sum, m) => sum + m.costCents / 100, 0), 4);

  const responseTimes = messages.map((m) => m.responseTimeSec).filter((t): t is number => t !== null).sort((a, b) => a - b);
  const median = responseTimes.length ? round(responseTimes[Math.floor(responseTimes.length / 2)] / 60, 1) : null;

  return {
    channel,
    attempts,
    reached: replied,
    meaningful,
    optedOut,
    factsCaptured: 0,
    opportunitiesAdvanced: advanced,
    totalCost,
    costPerAttempt: attempts ? round(totalCost / attempts, 4) : 0,
    costPerReach: replied ? round(totalCost / replied, 3) : null,
    costPerMeaningful: meaningful ? round(totalCost / meaningful, 3) : null,
    reachRate: delivered ? round(replied / delivered, 3) : 0,
    meaningfulRate: attempts ? round(meaningful / attempts, 3) : 0,
    medianResponseMinutes: median,
  };
}

export { clamp01 };
