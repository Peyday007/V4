import type { ContactConfidence, ContactScope } from '@prisma/client';
import { buildIdentity, normalizeCompanyName, normalizePhone, sameCompany, type IdentityKeys } from '@/lib/discovery/identity';

/**
 * Deciding whether a contact we found belongs to the organisation we are
 * looking at.
 *
 * All of it pure, because this is the part that must never be settled by
 * whichever row happened to come back first. The rules here are the difference
 * between releasing a real phone number into the calling queue and putting a
 * caller through to a completely different business with the same name.
 *
 * The identity ladder is not reimplemented — `sameCompany` in the discovery
 * module already encodes it, and it is the same question. What is added here is
 * what to *do* with the answer when several candidates disagree.
 */

/** One contact route offered by one source, with everything needed to judge it. */
export type ContactCandidate = {
  /** The adapter that produced it. */
  source: string;
  sourceUrl: string | null;
  /** The provider's own identifier, where it issues one. */
  externalId: string | null;
  retrievedAt: Date;

  /** The organisation as this source names it. */
  name: string;
  phone: string | null;
  website: string | null;
  email: string | null;
  contactName: string | null;
  contactRole: string | null;

  addressLine1: string | null;
  cityName: string | null;
  stateCode: string | null;
  postalCode: string | null;
  externalPlaceId: string | null;

  /**
   * True only when the value was checked rather than merely found. A directory
   * listing is not a check; a caller reaching the number is.
   */
  verified: boolean;
  /** Set when the source itself says this is a head office or central line. */
  declaredScope?: ContactScope;
  /** Business details that help a person confirm the match on the call. */
  businessDetails?: string[];
};

export type LocationVerdict =
  /** Same organisation, same site. */
  | 'SAME_LOCATION'
  /** Same organisation, same town, and nothing contradicts the address. */
  | 'SAME_ORG_SAME_CITY'
  /** Same organisation, demonstrably somewhere else. A different branch. */
  | 'SAME_ORG_DIFFERENT_LOCATION'
  /** Not the same organisation. */
  | 'DIFFERENT';

export type JudgedCandidate = {
  candidate: ContactCandidate;
  verdict: LocationVerdict;
  /** 0–1 from the identity ladder. Zero when the verdict is not a match. */
  score: number;
  /** Which key settled it: placeId, phone, addressAndName, nameAndCity. */
  via: string | null;
};

/**
 * Where one candidate sits relative to the organisation we are resolving.
 *
 * The case worth naming is the third one. Two branches of the same chain in
 * different towns pass a name comparison perfectly, and a system that stops at
 * the name will hand a caller the wrong site's number and call it verified.
 * A candidate that names the same business at a demonstrably different place
 * is reported as exactly that, and never used as this location's number.
 */
export function judgeCandidate(target: IdentityKeys, candidate: ContactCandidate): JudgedCandidate {
  const keys = buildIdentity({
    name: candidate.name,
    externalPlaceId: candidate.externalPlaceId,
    phone: candidate.phone,
    // Only when there is a street line. A city and a state alone are not an
    // address, and treating them as one makes an unaddressed listing look like
    // it contradicts the address we hold — which turns a perfectly good
    // same-city match into a phantom different-branch verdict.
    address: candidate.addressLine1
      ? [candidate.addressLine1, candidate.cityName, candidate.stateCode].filter(Boolean).join(' ')
      : null,
    city: candidate.cityName,
    state: candidate.stateCode,
  });

  const match = sameCompany(target, keys);
  if (match.matched) {
    return {
      candidate,
      verdict: match.confidence >= 0.9 ? 'SAME_LOCATION' : 'SAME_ORG_SAME_CITY',
      score: match.confidence,
      via: match.via,
    };
  }

  // The name is the same and the identity ladder still said no. That is the
  // branch case, and it is information rather than a miss: it tells us the
  // chain exists and that this particular listing is not this site.
  if (target.normalizedName && normalizeCompanyName(candidate.name) === target.normalizedName) {
    return { candidate, verdict: 'SAME_ORG_DIFFERENT_LOCATION', score: 0, via: null };
  }

  return { candidate, verdict: 'DIFFERENT', score: 0, via: null };
}

export type ResolutionVerdict = {
  confidence: ContactConfidence;
  /** The candidate to write, when there is one. */
  chosen: ContactCandidate | null;
  /** What the chosen value actually reaches. */
  scope: ContactScope;
  /** How the decision was reached, kept with the value as provenance. */
  method: string | null;
  /** Why it is not resolved, in the operator's words. Null when it is. */
  blocker: string | null;
  /** Competing candidates, when the answer is that we cannot tell. */
  competing: Array<{ name: string; phone: string | null; location: string | null; source: string }>;
  ambiguityReason: string | null;
  /**
   * Same-organisation listings at other addresses. Kept and labelled rather
   * than used, so a franchisor's switchboard is visible without being dialled
   * as though it were the branch.
   */
  otherLocations: Array<{ name: string; phone: string | null; location: string | null; source: string }>;
};

const UNRESOLVED_EMPTY: ResolutionVerdict = {
  confidence: 'UNRESOLVED',
  chosen: null,
  scope: 'UNKNOWN',
  method: null,
  blocker: null,
  competing: [],
  ambiguityReason: null,
  otherLocations: [],
};

function describe(judged: JudgedCandidate) {
  const c = judged.candidate;
  return {
    name: c.name,
    phone: c.phone,
    location: [c.addressLine1, c.cityName, c.stateCode].filter(Boolean).join(', ') || null,
    source: c.source,
  };
}

/**
 * Turns a pile of candidates into one answer, or an honest refusal.
 *
 * Two candidates agreeing on the phone number corroborate each other and raise
 * confidence. Two candidates disagreeing about the phone number for what claims
 * to be the same site is not a tie to be broken by ordering — it is genuine
 * ambiguity, and the record is held for a person with both candidates named.
 */
export function decideContact(input: {
  target: IdentityKeys;
  candidates: ContactCandidate[];
  /** Values a caller has already established are wrong. */
  rejectedValues?: string[];
  /** True when every source consulted threw rather than answering. */
  allSourcesFailed?: boolean;
}): ResolutionVerdict {
  if (input.allSourcesFailed) {
    return {
      ...UNRESOLVED_EMPTY,
      confidence: 'FAILED',
      blocker: 'Every contact source failed. This is a system fault, not a finding about this organisation.',
    };
  }

  const rejected = new Set((input.rejectedValues ?? []).map((v) => normalizePhone(v) ?? v.toLowerCase()));
  const usable = input.candidates.filter((c) => {
    if (!c.phone) return true;
    const key = normalizePhone(c.phone) ?? c.phone.toLowerCase();
    return !rejected.has(key);
  });

  const judged = usable.map((c) => judgeCandidate(input.target, c)).filter((j) => j.verdict !== 'DIFFERENT');

  const elsewhere = judged.filter((j) => j.verdict === 'SAME_ORG_DIFFERENT_LOCATION' && j.candidate.phone);
  const otherLocations = elsewhere.map(describe);

  // Only listings tied to *this* site are dialable. A branch elsewhere is real
  // information and is reported below, but it is never a candidate here.
  const withPhone = judged.filter(
    (j) => j.candidate.phone && (j.verdict === 'SAME_LOCATION' || j.verdict === 'SAME_ORG_SAME_CITY'),
  );

  // Checked before the empty case, because "we found the number and a caller
  // has already told us it is wrong" is a finding, and reporting it as "nothing
  // was found" would send the search round the same loop.
  if (usable.length === 0 && input.candidates.length > 0) {
    return {
      ...UNRESOLVED_EMPTY,
      blocker: 'Every number found has already been reported wrong by a caller. Looking for another route.',
    };
  }

  if (withPhone.length === 0) {
    // Nothing to dial. Whether anything at all was found still matters, so the
    // two cases get different words.
    return {
      ...UNRESOLVED_EMPTY,
      otherLocations,
      blocker:
        otherLocations.length > 0
          ? `Found ${otherLocations.length} listing(s) for this business at other addresses, but none at this location. ` +
            'A branch in another town is a different site, so its number was recorded but not used.'
          : input.candidates.length > 0
            ? 'Every source was searched. The listings found carry no phone number.'
            : 'Every source was searched and none publishes a contact for this organisation.',
    };
  }

  for (const tier of ['SAME_LOCATION', 'SAME_ORG_SAME_CITY'] as const) {
    const group = withPhone.filter((j) => j.verdict === tier);
    if (group.length === 0) continue;

    const phones = new Set(group.map((j) => normalizePhone(j.candidate.phone) ?? j.candidate.phone!));
    if (phones.size > 1) {
      return {
        ...UNRESOLVED_EMPTY,
        confidence: 'AMBIGUOUS',
        competing: group.map(describe),
        otherLocations,
        ambiguityReason:
          `${group.length} listings match this organisation at this location but give ${phones.size} different ` +
          'phone numbers. Picking one would be a guess.',
        blocker: `Competing contact records — ${group.length} candidates, ${phones.size} different numbers. Needs a person to choose.`,
      };
    }

    // One number, however many sources agree on it. A source that already
    // checked the value outranks one that merely listed it.
    const best = [...group].sort((a, b) => {
      if (a.candidate.verified !== b.candidate.verified) return a.candidate.verified ? -1 : 1;
      if (b.score !== a.score) return b.score - a.score;
      return b.candidate.retrievedAt.getTime() - a.candidate.retrievedAt.getTime();
    })[0];

    const corroborated = group.length > 1;
    const confidence: ContactConfidence =
      best.candidate.verified || tier === 'SAME_LOCATION' ? 'VERIFIED' : corroborated ? 'VERIFIED' : 'PROBABLE';

    return {
      confidence,
      chosen: best.candidate,
      scope: best.candidate.declaredScope ?? 'LOCATION',
      method: methodFor(best, corroborated ? group.length : 1),
      blocker: null,
      competing: [],
      ambiguityReason: null,
      otherLocations,
    };
  }

  return { ...UNRESOLVED_EMPTY, otherLocations, blocker: 'No candidate could be tied to this location.' };
}

function methodFor(judged: JudgedCandidate, agreeing: number): string {
  const base =
    judged.candidate.verified
      ? 'confirmed by a person'
      : judged.via === 'placeId'
        ? 'matched on the provider place ID'
        : judged.via === 'phone'
          ? 'matched on an existing phone number'
          : judged.via === 'addressAndName'
            ? 'matched on business name and street address'
            : 'matched on business name, city and state';
  return agreeing > 1 ? `${base}; ${agreeing} sources agree on the number` : base;
}

/**
 * Whether a newly found value may replace one already held.
 *
 * The rule the operator asked for, in one place: stronger evidence wins, equal
 * evidence does not, and nothing a machine found ever displaces something a
 * person confirmed. Its consequence is the one that matters — a provider having
 * a bad day cannot downgrade a number a caller verified last week.
 */
const STRENGTH: Record<ContactConfidence, number> = {
  VERIFIED: 3,
  PROBABLE: 2,
  AMBIGUOUS: 1,
  UNRESOLVED: 0,
  FAILED: 0,
};

export function mayReplace(
  existing: { confidence: ContactConfidence; enteredByOperator: boolean; verified: boolean } | null,
  incoming: { confidence: ContactConfidence; verified: boolean },
): boolean {
  if (!existing) return true;
  if (existing.enteredByOperator) return false;
  if (existing.verified && !incoming.verified) return false;
  return STRENGTH[incoming.confidence] > STRENGTH[existing.confidence];
}

/** A contact good enough to put in front of a caller. */
export function releasesToCallQueue(confidence: ContactConfidence, scope: ContactScope): boolean {
  if (scope === 'PARENT_OR_CENTRAL') return false;
  return confidence === 'VERIFIED' || confidence === 'PROBABLE';
}
