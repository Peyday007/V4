import { createHash } from 'node:crypto';
import type { DemandEventType, EventPartyRole, LeadTier } from '@prisma/client';
import { cleanCity, cleanState } from '@/lib/discovery/identity';

/**
 * The demand event: a dated thing that happened in the world.
 *
 * This is the object the previous acquisition model had no room for. It found
 * companies, matched categories and inferred needs, and none of those steps
 * involves anything happening. A gym existing is not a cleaning opportunity. A
 * gym opening on the first of the month is, because an opening creates a final
 * clean, a recurring contract, an opening stock order and — later — a
 * replenishment conversation.
 *
 * Two rules are enforced by the types rather than by discipline:
 *
 *   1. `eventDate` is what the *source* said. `discoveredAt` is when we wrote
 *      the row. There is no code path that can substitute one for the other,
 *      because `RawDemandEvent` has no field for our own clock.
 *   2. Tier A and B require both an event date and a durable source reference.
 *      `assertTierEligibility` is the only way to reach those tiers, and it
 *      refuses without them.
 */

/** What a connector emits. Deliberately has no field for our own timestamps. */
export type RawDemandEvent = {
  type: DemandEventType;
  /** Identifier within the source. Half of the durable reference. */
  sourceRecordId: string;
  /** The other half. A record we cannot link back to is not evidence. */
  sourceUrl?: string;
  headline: string;
  /** The source's own words. Never our paraphrase. */
  summary: string;

  /** The date the source states. Null when it published none. */
  eventDate: Date | null;
  deadlineAt?: Date | null;
  opensAt?: Date | null;
  completesAt?: Date | null;
  effectiveAt?: Date | null;

  /** Location as published. Never a search anchor, market or jurisdiction name. */
  cityName?: string | null;
  stateCode?: string | null;
  postalCode?: string | null;
  addressLine1?: string | null;

  /** Organisations the record names, with the part each plays. */
  parties: Array<{ role: EventPartyRole; name: string }>;

  /** Things the source states outright. */
  confirmedFacts: string[];
  /** Things we concluded. Stored apart so the two can never be confused. */
  inferredFacts: string[];

  confidence: number;
  relatedCapabilities: string[];
  rawPayload: Record<string, unknown>;

  /**
   * Source-specific identity, when the source has a real one: a permit number,
   * a solicitation number, a licence number. Used ahead of the derived key.
   */
  naturalKey?: string | null;

  /**
   * The evidence row this came from, for first-party sources.
   *
   * Set so ingestion can mark the row consumed. Without it a staged intake is
   * re-read on every poll: harmless while the dedupe key holds, and a slow
   * leak of work that grows with every event ever entered.
   */
  evidenceId?: string;
};

/**
 * Event types that constitute somebody actively trying to buy.
 *
 * Distinguished from types that make buying likely. A published request is a
 * buyer in market; an occupancy approval is a building that is about to need
 * things. Both are useful and they are not the same, and the tier model exists
 * to keep them apart.
 */
export const ACTIVE_DEMAND_EVENTS: DemandEventType[] = [
  'ACTIVE_RFP',
  'ACTIVE_RFQ',
  'PROCUREMENT_NOTICE',
  'VENDOR_REQUEST',
  'SUBCONTRACTOR_REQUEST',
  'INBOUND_REQUEST',
];

export const STRONG_TRIGGER_EVENTS: DemandEventType[] = [
  'FACILITY_OPENING',
  'OCCUPANCY_OR_OPERATING_APPROVAL',
  'RENOVATION_OR_CONSTRUCTION',
  'EXPANSION',
  'PROPERTY_TURNOVER',
  'NEW_LOCATION',
  'NEW_LEASE',
  'CONTRACT_EXPIRATION',
  'VENDOR_FAILURE_OR_COMPLAINT',
  'STAFFING_OR_CAPACITY_GAP',
  'CONTRACT_AWARD',
];

/** How long each family stays current. */
const ACTIVE_MAX_AGE_DAYS = 45;
const TRIGGER_MAX_AGE_DAYS = 180;

export type TierEligibility = {
  tier: LeadTier;
  reason: string;
  /** Populated when the record fails to reach the tier its type implies. */
  blockedBy: string | null;
};

/**
 * The only route to Tier A or B.
 *
 * Both require an external event date and a durable reference. Without a date
 * there is no way to say the event is current; without a reference there is no
 * way for anyone to check it. A record missing either is not rejected — it
 * becomes Tier C and says why.
 *
 * "Durable" means the record can be reopened, not that it has a URL. An
 * external source must give one, because the record lives on somebody else's
 * server. First-party data — an inbound request, an event an operator recorded
 * — is durable because we hold it: the intake row is the evidence, and
 * demanding a URL for it would push the single strongest kind of demand this
 * business has down to Tier C for want of a link to itself.
 */
export function assertTierEligibility(input: {
  type: DemandEventType;
  eventDate: Date | null;
  sourceUrl: string | null;
  sourceRecordId: string;
  /** True when we hold the underlying record rather than linking to one. */
  isFirstParty?: boolean;
  deadlineAt?: Date | null;
  now?: Date;
}): TierEligibility {
  const now = input.now ?? new Date();
  const wantsHighTier =
    ACTIVE_DEMAND_EVENTS.includes(input.type) || STRONG_TRIGGER_EVENTS.includes(input.type);

  if (!wantsHighTier) {
    return {
      tier: 'DIRECTORY_PROSPECT',
      reason: 'This event type does not establish demand on its own.',
      blockedBy: null,
    };
  }

  if (!input.eventDate) {
    return {
      tier: 'PREDICTED_NEED',
      reason:
        'The source published no date for this event, so there is no way to say whether it is current. ' +
        'Recency is unknown, and unknown is not recent.',
      blockedBy: 'no external event date',
    };
  }

  const durable = Boolean(input.sourceRecordId) && (Boolean(input.sourceUrl) || input.isFirstParty === true);
  if (!durable) {
    return {
      tier: 'PREDICTED_NEED',
      reason:
        'No durable reference back to the source record, so nobody can check this. Evidence that cannot be ' +
        'reopened is not evidence.',
      blockedBy: 'no durable source reference',
    };
  }

  // A published deadline overrides everything: past it, the thing is over.
  if (input.deadlineAt && input.deadlineAt.getTime() < now.getTime()) {
    return {
      tier: 'PREDICTED_NEED',
      reason: `The published deadline passed on ${input.deadlineAt.toISOString().slice(0, 10)}.`,
      blockedBy: 'deadline passed',
    };
  }

  const ageDays = (now.getTime() - input.eventDate.getTime()) / 86_400_000;

  if (ACTIVE_DEMAND_EVENTS.includes(input.type)) {
    if (ageDays > ACTIVE_MAX_AGE_DAYS) {
      return {
        tier: 'PREDICTED_NEED',
        reason: `Published ${Math.round(ageDays)} days ago. A request that old has been answered by somebody.`,
        blockedBy: 'request too old to be open',
      };
    }
    return {
      tier: 'ACTIVE_DEMAND',
      reason: `${humaniseEvent(input.type)} dated ${input.eventDate.toISOString().slice(0, 10)}. A buyer is in market.`,
      blockedBy: null,
    };
  }

  // Forward-dated triggers — an opening three weeks away — are the best kind.
  if (ageDays > TRIGGER_MAX_AGE_DAYS) {
    return {
      tier: 'PREDICTED_NEED',
      reason: `${humaniseEvent(input.type)} was ${Math.round(ageDays)} days ago, too long to still be creating need.`,
      blockedBy: 'trigger too old',
    };
  }

  return {
    tier: 'STRONG_TRIGGER',
    reason:
      `${humaniseEvent(input.type)} dated ${input.eventDate.toISOString().slice(0, 10)}. ` +
      `Nobody has asked for anything — this is the event that usually creates the need.`,
    blockedBy: null,
  };
}

export function humaniseEvent(type: DemandEventType): string {
  const labels: Record<DemandEventType, string> = {
    ACTIVE_RFP: 'Request for proposals',
    ACTIVE_RFQ: 'Request for quotes',
    PROCUREMENT_NOTICE: 'Procurement notice',
    VENDOR_REQUEST: 'Vendor request',
    SUBCONTRACTOR_REQUEST: 'Subcontractor request',
    CONTRACT_AWARD: 'Contract award',
    FACILITY_OPENING: 'Facility opening',
    OCCUPANCY_OR_OPERATING_APPROVAL: 'Occupancy or operating approval',
    RENOVATION_OR_CONSTRUCTION: 'Renovation or construction',
    EXPANSION: 'Expansion',
    PROPERTY_TURNOVER: 'Property turnover',
    NEW_LOCATION: 'New location',
    NEW_LEASE: 'New lease',
    CONTRACT_EXPIRATION: 'Contract expiring',
    VENDOR_FAILURE_OR_COMPLAINT: 'Vendor failure or complaint',
    STAFFING_OR_CAPACITY_GAP: 'Staffing or capacity gap',
    INBOUND_REQUEST: 'Inbound request',
  };
  return labels[type];
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/**
 * Identity for an event across sources.
 *
 * The same opening can appear as a business licence, a certificate of
 * occupancy and a press mention. Those are one event with three pieces of
 * evidence, not three leads — and merging them must be safe, because a wrong
 * merge fuses two real openings at neighbouring addresses.
 *
 * Preference order:
 *   1. A number the source itself issued (permit, licence, solicitation).
 *      Exact, and the only key used alone.
 *   2. Organisation + address + event date. Three independent facts agreeing.
 *   3. Connector + record id. Deduplicates re-ingestion of the same record
 *      without claiming anything about other sources.
 */
export function eventDedupeKey(input: {
  connector: string;
  sourceRecordId: string;
  naturalKey?: string | null;
  type: DemandEventType;
  eventDate: Date | null;
  addressLine1?: string | null;
  cityName?: string | null;
  stateCode?: string | null;
  parties: Array<{ role: EventPartyRole; name: string }>;
}): { key: string; basis: 'natural' | 'org_address_date' | 'source_record' } {
  if (input.naturalKey && input.naturalKey.trim().length >= 4) {
    return { key: `nk:${normalise(input.naturalKey)}`, basis: 'natural' };
  }

  const org = input.parties.find((p) => p.role !== 'ISSUING_AUTHORITY')?.name;
  const address = input.addressLine1;
  if (org && address && input.eventDate) {
    const day = input.eventDate.toISOString().slice(0, 10);
    const parts = [normalise(org), normalise(address), normalise(input.cityName ?? ''), day, input.type];
    return { key: `oad:${hash(parts.join('|'))}`, basis: 'org_address_date' };
  }

  return { key: `src:${input.connector}:${normalise(input.sourceRecordId)}`, basis: 'source_record' };
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

/**
 * Whether an event's identity is solid enough to act on.
 *
 * Quarantine rather than merge or drop. An event dated but nameless may be
 * perfectly real and simply thin; guessing which company it belongs to is how
 * two businesses become one.
 */
export function assessEventIdentity(input: {
  parties: Array<{ role: EventPartyRole; name: string }>;
  eventDate: Date | null;
  addressLine1?: string | null;
  cityName?: string | null;
  stateCode?: string | null;
  dedupeBasis: 'natural' | 'org_address_date' | 'source_record';
}): { quarantined: boolean; reason: string | null } {
  const named = input.parties.filter((p) => p.role !== 'ISSUING_AUTHORITY' && p.name.trim().length >= 3);
  if (named.length === 0) {
    return {
      quarantined: true,
      reason: 'no named organisation, so the event cannot be attached to an account',
    };
  }

  const hasLocation = Boolean(cleanCity(input.cityName) || cleanState(input.stateCode) || input.addressLine1);
  if (!hasLocation) {
    return {
      quarantined: true,
      reason: 'no usable location, so it cannot be matched to a market or a provider',
    };
  }

  if (input.dedupeBasis === 'source_record' && !input.eventDate) {
    return {
      quarantined: true,
      reason:
        'neither a source-issued identifier nor a date and address to identify it by — any deduplication ' +
        'against it would be a guess',
    };
  }

  return { quarantined: false, reason: null };
}

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

export type ExpiryVerdict = { expired: boolean; reason: string | null };

/**
 * Whether an event's own window has closed.
 *
 * Expiry keeps the event — an expired solicitation is still evidence that this
 * buyer buys this thing, and deleting it loses that. It only stops it being
 * presented as something to act on.
 */
export function assessExpiry(input: {
  type: DemandEventType;
  eventDate: Date | null;
  deadlineAt?: Date | null;
  now?: Date;
}): ExpiryVerdict {
  const now = input.now ?? new Date();

  if (input.deadlineAt && input.deadlineAt.getTime() < now.getTime()) {
    return { expired: true, reason: `the published deadline passed on ${input.deadlineAt.toISOString().slice(0, 10)}` };
  }

  if (!input.eventDate) return { expired: false, reason: null };

  const ageDays = (now.getTime() - input.eventDate.getTime()) / 86_400_000;
  const limit = ACTIVE_DEMAND_EVENTS.includes(input.type) ? ACTIVE_MAX_AGE_DAYS : TRIGGER_MAX_AGE_DAYS;

  if (ageDays > limit) {
    return {
      expired: true,
      reason: `${humaniseEvent(input.type)} was ${Math.round(ageDays)} days ago, past the ${limit}-day window for this event type`,
    };
  }

  return { expired: false, reason: null };
}
