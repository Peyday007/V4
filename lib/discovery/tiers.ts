import type { IntentKind, LeadTier } from '@prisma/client';
import { INTENT_WEIGHTS, intentDecay, type IntentSignal } from './qualification';

/**
 * Lead tiers, rejection rules and buying windows.
 *
 * The board currently shows twenty-odd accounts, every one of which came from
 * a directory or a registry, all ranked against each other as though the order
 * meant something. It does not. Ranking within a population that contains no
 * demand evidence at all just sorts one kind of nothing above another kind of
 * nothing, and the priority score cannot say so because its job is to compare
 * records, not to judge the population.
 *
 * The tier is that judgement. It is a second axis, orthogonal to the lifecycle
 * stage:
 *
 *   stage — how far *we* have worked this hypothesis
 *   tier  — how much *the world* has done to create the need
 *
 * Both are needed. A record can be advanced through stages indefinitely
 * without ever acquiring a reason to buy. A tier cannot be earned by
 * processing: only a dated external event moves a record up.
 */

export type TierInput = {
  intentSignals: IntentSignal[];
  /** True when a person has confirmed the need in conversation. */
  conversationConfirmed?: boolean;
  /** Inbound: they contacted us. The strongest evidence there is. */
  inbound?: boolean;
  /** Matches a pattern that has produced completed work before. */
  matchesProvenPattern?: boolean;
  now?: Date;
};

export type TierResult = {
  tier: LeadTier;
  reason: string;
  /** The event that decided it, for the audit trail. */
  decidedBy: IntentKind | 'inbound' | 'proven_pattern' | 'none';
};

/**
 * Events that constitute someone actively trying to buy, as opposed to events
 * that merely make buying likely.
 *
 * The distinction is the whole tier model. A published solicitation is a buyer
 * in market with a deadline. A building permit says construction is happening,
 * which usually creates a need, but nobody has asked for anything.
 */
const ACTIVE_DEMAND_KINDS: IntentKind[] = [
  'RFQ_ISSUED',
  'PURCHASING_NOTICE',
  'VENDOR_REGISTRATION',
  'CONVERSATION_CONFIRMED',
];

const STRONG_TRIGGER_KINDS: IntentKind[] = [
  'PERMIT_FILED',
  'FACILITY_OPENING',
  'EXPANSION',
  'CONTRACT_AWARD',
  'CONTRACT_EXPIRY',
  'INCUMBENT_CHANGE',
  'JOB_POSTING',
];

/**
 * Beyond this many days an event stops being current.
 *
 * An expired solicitation is not a Tier A lead — it is a record of something
 * that already happened, and treating it as active demand is how a pipeline
 * fills with work that closed months ago. Triggers get longer because their
 * consequences last: a facility that opened ninety days ago still needs a
 * cleaning contract.
 */
const ACTIVE_DEMAND_MAX_AGE_DAYS = 45;
const TRIGGER_MAX_AGE_DAYS = 180;

function ageInDays(occurredAt: Date, now: Date): number {
  return Math.max(0, (now.getTime() - occurredAt.getTime()) / 86_400_000);
}

export function classifyTier(input: TierInput): TierResult {
  const now = input.now ?? new Date();

  if (input.inbound) {
    return {
      tier: 'ACTIVE_DEMAND',
      reason: 'They contacted us. Nothing outranks an inbound request.',
      decidedBy: 'inbound',
    };
  }

  const dated = input.intentSignals.filter((s) => !Number.isNaN(s.occurredAt.getTime()));

  const active = dated
    .filter((s) => ACTIVE_DEMAND_KINDS.includes(s.kind))
    .filter((s) => ageInDays(s.occurredAt, now) <= ACTIVE_DEMAND_MAX_AGE_DAYS)
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0];

  if (active) {
    const days = Math.round(ageInDays(active.occurredAt, now));
    return {
      tier: 'ACTIVE_DEMAND',
      reason:
        `${humanKind(active.kind)} ${days === 0 ? 'today' : `${days} day(s) ago`}. ` +
        `A buyer is in market with a stated requirement.`,
      decidedBy: active.kind,
    };
  }

  const trigger = dated
    .filter((s) => STRONG_TRIGGER_KINDS.includes(s.kind))
    .filter((s) => ageInDays(s.occurredAt, now) <= TRIGGER_MAX_AGE_DAYS)
    .sort((a, b) => INTENT_WEIGHTS[b.kind] - INTENT_WEIGHTS[a.kind])[0];

  if (trigger) {
    const days = Math.round(ageInDays(trigger.occurredAt, now));
    return {
      tier: 'STRONG_TRIGGER',
      reason:
        `${humanKind(trigger.kind)} ${days} day(s) ago. No request has been made — this is an event that ` +
        `usually creates the need, not the need itself.`,
      decidedBy: trigger.kind,
    };
  }

  // An event exists but has aged out. Worth saying so rather than silently
  // demoting it to look like a record that never had one.
  const stale = dated.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0];
  if (stale) {
    return {
      tier: 'PREDICTED_NEED',
      reason:
        `${humanKind(stale.kind)} ${Math.round(ageInDays(stale.occurredAt, now))} day(s) ago, which is too old to ` +
        `treat as current. Kept as a pattern match, not as live demand.`,
      decidedBy: stale.kind,
    };
  }

  if (input.matchesProvenPattern) {
    return {
      tier: 'PREDICTED_NEED',
      reason:
        'Fits a profile that has produced completed work before, but nothing has happened at this organisation. ' +
        'Campaign material, not a lead.',
      decidedBy: 'proven_pattern',
    };
  }

  return {
    tier: 'DIRECTORY_PROSPECT',
    reason:
      'Firmographic fit only. A directory or registry established that this organisation exists and roughly what ' +
      'it does. No event, no request, no trigger — there is no reason to think they need anything today.',
    decidedBy: 'none',
  };
}

function humanKind(kind: IntentKind): string {
  const labels: Record<IntentKind, string> = {
    PERMIT_FILED: 'Building permit filed',
    FACILITY_OPENING: 'Facility opening',
    EXPANSION: 'Expansion announced',
    JOB_POSTING: 'Relevant job posting',
    VENDOR_REGISTRATION: 'Vendor registration opened',
    PURCHASING_NOTICE: 'Purchasing notice published',
    CONTRACT_AWARD: 'Contract awarded',
    CONTRACT_EXPIRY: 'Contract approaching expiry',
    INCUMBENT_CHANGE: 'Incumbent provider changed',
    RFQ_ISSUED: 'Request for quote issued',
    CONVERSATION_CONFIRMED: 'Confirmed in conversation',
  };
  return labels[kind];
}

// ---------------------------------------------------------------------------
// Rejection
// ---------------------------------------------------------------------------

export type RejectionInput = {
  hasIdentifiableBuyer: boolean;
  hasContactRoute: boolean;
  /** Null when the source published no deadline. Not a rejection on its own. */
  deadline: Date | null;
  /** Providers able to serve this lead, from the provider index. */
  availableProviders: number;
  /**
   * Whether the supply network contains anybody at all.
   *
   * Without this the no-provider rule fires on every buyer record the moment
   * the network is empty, and rejects half the board for a setup gap while
   * reporting it as a judgement about each opportunity. An empty network is
   * one problem to fix once, not a verdict on two hundred leads.
   */
  networkHasProviders: boolean;
  requiresSupply: boolean;
  /** Estimated gross profit, where one can be estimated at all. */
  estimatedGrossProfit: number | null;
  minimumGrossProfit: number;
  /** Set when the opportunity is known to be closed or awarded elsewhere. */
  alreadyAwarded?: boolean;
  quarantined?: boolean;
  now?: Date;
};

/**
 * Automatic rejection.
 *
 * Rejected records stay searchable and stay in the database. They are removed
 * from the active pipeline, not from the system — a record that cannot be
 * worked today may become workable when a provider is onboarded or a contact
 * is found, and deleting it loses the discovery.
 *
 * Each flag names the specific rule, because "rejected" with no reason is a
 * decision nobody can argue with or fix.
 */
export function rejectionFlags(input: RejectionInput): string[] {
  const now = input.now ?? new Date();
  const flags: string[] = [];

  if (!input.hasIdentifiableBuyer) flags.push('no identifiable buying organisation');
  if (input.quarantined) flags.push('identity cannot be verified well enough to act on');
  if (input.alreadyAwarded) flags.push('already awarded to someone else');

  if (input.deadline && input.deadline.getTime() < now.getTime()) {
    flags.push('deadline has passed');
  }


  if (
    input.estimatedGrossProfit !== null &&
    input.estimatedGrossProfit < input.minimumGrossProfit
  ) {
    flags.push(
      `expected gross profit of $${Math.round(input.estimatedGrossProfit).toLocaleString()} is below the ` +
        `$${Math.round(input.minimumGrossProfit).toLocaleString()} floor`,
    );
  }

  // Two things are deliberately NOT rejections, because both are tasks:
  //
  //   No contact route. A live solicitation with no named person is worth the
  //   research, and discarding it would throw away the best leads the system
  //   finds.
  //
  //   No provider able to fulfil. That is a gap in the supply network, and the
  //   response is to go and recruit one — rejecting the demand instead means
  //   the network can never grow toward the work that exists. It surfaces as a
  //   fulfilment-readiness score of zero and a visible sourcing task.
  return flags;
}

// ---------------------------------------------------------------------------
// Buying window
// ---------------------------------------------------------------------------

export type BuyingWindow = 'ACTIVE_NOW' | 'WITHIN_7_DAYS' | 'WITHIN_30_DAYS' | 'WITHIN_90_DAYS' | 'LATER' | 'UNKNOWN';

/**
 * When to make contact.
 *
 * A correct lead at the wrong time is still a bad lead: contacting a permit
 * filer the week they broke ground reaches somebody who has not thought about
 * cleaning yet, and burns the one introduction available. The window drives a
 * nurture queue rather than repeated outreach.
 */
export function estimateBuyingWindow(input: {
  tier: LeadTier;
  deadline: Date | null;
  strongestSignal: IntentSignal | null;
  now?: Date;
}): { window: BuyingWindow; reason: string } {
  const now = input.now ?? new Date();

  if (input.deadline) {
    const days = Math.ceil((input.deadline.getTime() - now.getTime()) / 86_400_000);
    if (days < 0) return { window: 'UNKNOWN', reason: 'The stated deadline has passed.' };
    if (days <= 7) return { window: 'WITHIN_7_DAYS', reason: `Stated deadline in ${days} day(s).` };
    if (days <= 30) return { window: 'WITHIN_30_DAYS', reason: `Stated deadline in ${days} days.` };
    return { window: 'WITHIN_90_DAYS', reason: `Stated deadline in ${days} days.` };
  }

  if (input.tier === 'ACTIVE_DEMAND') {
    return { window: 'ACTIVE_NOW', reason: 'A request is open. The window is now, whether or not a date was published.' };
  }

  if (input.tier === 'STRONG_TRIGGER' && input.strongestSignal) {
    const age = ageInDays(input.strongestSignal.occurredAt, now);
    // Triggers have a lead time. A permit filed today means work months out; a
    // facility that opened last month needs a provider immediately.
    const leadTime = input.strongestSignal.kind === 'PERMIT_FILED' ? 90 : 30;
    const remaining = Math.round(leadTime - age);
    if (remaining <= 0) return { window: 'ACTIVE_NOW', reason: 'The trigger has had time to become a real requirement.' };
    if (remaining <= 30) return { window: 'WITHIN_30_DAYS', reason: `Roughly ${remaining} days before this trigger typically becomes a purchase.` };
    return { window: 'WITHIN_90_DAYS', reason: `Roughly ${remaining} days before this trigger typically becomes a purchase.` };
  }

  return {
    window: 'UNKNOWN',
    reason: 'Nothing dated to estimate from. Contacting now would be a guess at timing as well as at need.',
  };
}

/**
 * Outreach intensity a tier justifies.
 *
 * Channel cost has to scale with evidence, or the expensive channels get spent
 * on the weakest records simply because there are more of them.
 */
export const TIER_OUTREACH: Record<LeadTier, { channels: string[]; note: string }> = {
  ACTIVE_DEMAND: {
    channels: ['phone', 'email', 'portal'],
    note: 'Immediate multi-channel pursuit. A live requirement justifies a call.',
  },
  STRONG_TRIGGER: {
    channels: ['email', 'phone'],
    note: 'Personalised email referencing the trigger; call only if the economics justify it.',
  },
  PREDICTED_NEED: {
    channels: ['email'],
    note: 'Personalised email and limited follow-up. No calling — there is nothing specific to call about.',
  },
  DIRECTORY_PROSPECT: {
    channels: ['email'],
    note: 'Automated campaign material only. Never a call: there is no reason for contact beyond that they exist.',
  },
  REJECTED: {
    channels: [],
    note: 'No outreach. The record stays searchable in case the rejection reason is resolved.',
  },
};

export const TIER_LABEL: Record<LeadTier, string> = {
  ACTIVE_DEMAND: 'A — active demand',
  STRONG_TRIGGER: 'B — strong trigger',
  PREDICTED_NEED: 'C — predicted need',
  DIRECTORY_PROSPECT: 'D — directory prospect',
  REJECTED: 'Rejected',
};

export const TIER_ORDER: LeadTier[] = [
  'ACTIVE_DEMAND',
  'STRONG_TRIGGER',
  'PREDICTED_NEED',
  'DIRECTORY_PROSPECT',
  'REJECTED',
];
