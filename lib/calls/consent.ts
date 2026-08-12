import type { ConsentState } from '@prisma/client';
import type { OrgConfig } from '@/lib/config';

/**
 * Whether this call may be recorded, decided from where both people are
 * standing.
 *
 * The rule that makes this non-trivial: recording law follows the parties, not
 * the company. A caller in Illinois speaking to a prospect in Texas is subject
 * to Illinois' all-party rule even though Texas is one-party, and checking only
 * the prospect's state — which is what a naive implementation does, because the
 * prospect's state is the one on the record — produces an illegal recording
 * that looks compliant in the database.
 *
 * So both jurisdictions are resolved, the stricter one wins, and an unknown
 * jurisdiction refuses rather than assuming the permissive case. A call that
 * goes unrecorded costs a transcript. A call recorded illegally costs
 * considerably more, and the asymmetry decides every default here.
 */

export type ConsentDecision = {
  allowed: boolean;
  /** The state to store on the session. */
  state: ConsentState;
  /** Why, in words, at the time. Stored so a later change of policy does not rewrite history. */
  basis: string;
  /** True when an announcement has to be played before recording starts. */
  requiresAnnouncement: boolean;
  /** The jurisdictions that decided it. */
  callerJurisdiction: string | null;
  prospectJurisdiction: string | null;
  /** Which side imposed the stricter rule, when one did. */
  strictestSide: 'caller' | 'prospect' | 'both' | null;
};

export type ConsentInput = {
  config: OrgConfig;
  /** Where the caller is sitting. */
  callerState: string | null | undefined;
  /** Where the prospect is. */
  prospectState: string | null | undefined;
  /** Explicit consent already on file for this contact, if any. */
  contactConsent: boolean | null | undefined;
  /** True once the announcement has been played and nobody objected. */
  announced?: boolean;
  /** Set when the prospect said no on this call. */
  refusedNow?: boolean;
};

export function recordingConsent(input: ConsentInput): ConsentDecision {
  const callerJurisdiction = normalise(input.callerState);
  const prospectJurisdiction = normalise(input.prospectState);
  const allParty = input.config.callingRules.recordingRequiresBothPartyConsent;

  // A refusal ends it, whatever any jurisdiction permits. Somebody saying no
  // is not a legal question.
  if (input.refusedNow === true || input.contactConsent === false) {
    return {
      allowed: false,
      state: 'REFUSED',
      basis: 'They asked not to be recorded. That decision stands regardless of what the jurisdiction allows.',
      requiresAnnouncement: false,
      callerJurisdiction,
      prospectJurisdiction,
      strictestSide: null,
    };
  }

  // An unknown jurisdiction is not a permissive one.
  //
  // Written as an explicit pair of null tests rather than a count, so the
  // compiler can see that both are known below. A `.length > 0` guard reads
  // the same to a person and narrows nothing.
  if (callerJurisdiction === null || prospectJurisdiction === null) {
    const unknown: string[] = [];
    if (callerJurisdiction === null) unknown.push('the caller');
    if (prospectJurisdiction === null) unknown.push('the prospect');
    return {
      allowed: false,
      state: 'UNKNOWN',
      basis: `We do not know where ${unknown.join(' or ')} ${unknown.length === 1 ? 'is' : 'are'}, so the recording rules cannot be established. Not recorded.`,
      requiresAnnouncement: false,
      callerJurisdiction,
      prospectJurisdiction,
      strictestSide: null,
    };
  }

  const caller = callerJurisdiction;
  const prospect = prospectJurisdiction;

  const callerAllParty = allParty.includes(caller);
  const prospectAllParty = allParty.includes(prospect);
  const strictestSide = callerAllParty && prospectAllParty
    ? 'both'
    : callerAllParty
      ? 'caller'
      : prospectAllParty
        ? 'prospect'
        : null;

  if (callerAllParty || prospectAllParty) {
    // Explicit consent clears it outright.
    if (input.contactConsent === true) {
      return {
        allowed: true,
        state: 'GRANTED',
        basis: `${describeSide(strictestSide)} requires everybody's agreement, and this contact has given it.`,
        requiresAnnouncement: true,
        callerJurisdiction,
        prospectJurisdiction,
        strictestSide,
      };
    }

    // An announcement with no objection is the ordinary route to compliance in
    // an all-party state, and it only counts once it has actually been played.
    if (input.announced === true) {
      return {
        allowed: true,
        state: 'ANNOUNCED',
        basis: `${describeSide(strictestSide)} requires everybody's agreement. The announcement was played and nobody objected.`,
        requiresAnnouncement: true,
        callerJurisdiction,
        prospectJurisdiction,
        strictestSide,
      };
    }

    return {
      allowed: false,
      state: 'UNKNOWN',
      basis: `${describeSide(strictestSide)} requires everybody's agreement, and nobody has given it yet. Play the announcement first.`,
      requiresAnnouncement: true,
      callerJurisdiction,
      prospectJurisdiction,
      strictestSide,
    };
  }

  // One-party on both sides. We are a party, so our own consent suffices — and
  // the announcement is still played, because being legally entitled to record
  // somebody without telling them is not a reason to do it.
  return {
    allowed: true,
    state: 'NOT_REQUIRED',
    basis: `Neither ${caller} nor ${prospect} requires all-party consent, and we are a party to the call.`,
    requiresAnnouncement: true,
    callerJurisdiction,
    prospectJurisdiction,
    strictestSide: null,
  };
}

function describeSide(side: 'caller' | 'prospect' | 'both' | null): string {
  switch (side) {
    case 'caller': return 'The caller\'s jurisdiction';
    case 'prospect': return 'The prospect\'s jurisdiction';
    case 'both': return 'Both jurisdictions';
    default: return 'This jurisdiction';
  }
}

function normalise(state: string | null | undefined): string | null {
  if (!state) return null;
  const trimmed = state.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(trimmed) ? trimmed : null;
}
