import { normalizeCompanyName } from './run';

/**
 * Company identity.
 *
 * The same Planet Fitness reached through a place search, a building permit
 * and a CSV import is one company. Previously it was three, because matching
 * was by name alone and a permit says "PLANET FITNESS #4412" while Places says
 * "Planet Fitness" and the import says "Planet Fitness Inc".
 *
 * Identity keys are checked strongest-first, and a match on any one of them is
 * the same company. Order matters: a place ID is issued by a provider and is
 * exact; a phone number is nearly exact; an address plus a name is a judgement.
 */

export type IdentityKeys = {
  /** Provider-issued identifier. Exact when present. */
  externalPlaceId: string | null;
  /** Digits only, last 10 for US numbers. */
  normalizedPhone: string | null;
  /** Street address reduced to comparable form. */
  normalizedAddress: string | null;
  /** Legal-suffix-stripped, lowercased name. */
  normalizedName: string;
  cityName: string | null;
  stateCode: string | null;
};

/**
 * US numbers reduce to their last ten digits, which drops country codes,
 * punctuation and the leading 1 that half of all sources include.
 */
export function normalizePhone(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

const STREET_TYPES: Record<string, string> = {
  street: 'st', st: 'st',
  avenue: 'ave', ave: 'ave', av: 'ave',
  road: 'rd', rd: 'rd',
  boulevard: 'blvd', blvd: 'blvd',
  drive: 'dr', dr: 'dr',
  lane: 'ln', ln: 'ln',
  court: 'ct', ct: 'ct',
  parkway: 'pkwy', pkwy: 'pkwy',
  highway: 'hwy', hwy: 'hwy',
  suite: 'ste', ste: 'ste',
  north: 'n', south: 's', east: 'e', west: 'w',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
};

/**
 * Addresses are normalised rather than compared literally: "1200 Main Street,
 * Suite 400" and "1200 Main St Ste 400" are one building, and any dedupe that
 * cannot see that will hold both.
 */
export function normalizeAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value
    .toLowerCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;

  const tokens = cleaned.split(' ').map((token) => STREET_TYPES[token] ?? token);
  // Trailing postcodes vary in format between sources and add nothing once the
  // street and number match.
  const withoutZip = tokens.filter((t) => !/^\d{5}(-\d{4})?$/.test(t));
  const normalised = withoutZip.join(' ').trim();
  return normalised.length >= 4 ? normalised : null;
}

export function buildIdentity(input: {
  name: string;
  externalPlaceId?: string | null;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
}): IdentityKeys {
  return {
    externalPlaceId: input.externalPlaceId?.trim() || null,
    normalizedPhone: normalizePhone(input.phone),
    normalizedAddress: normalizeAddress(input.address),
    normalizedName: normalizeCompanyName(input.name),
    cityName: input.city?.trim() || null,
    stateCode: input.state?.trim().toUpperCase() || null,
  };
}

export type IdentityMatch = {
  matched: boolean;
  /** Which key established it, for the audit trail. */
  via: 'placeId' | 'phone' | 'addressAndName' | 'nameAndCity' | null;
  confidence: number;
};

/**
 * Whether two identities are the same organisation at the same location.
 *
 * Name-and-city is included but is the weakest rule and is deliberately
 * restricted: two Planet Fitness branches in the same city are genuinely
 * different sites, so it only fires when neither record carries an address to
 * distinguish them. Merging two real locations is worse than holding a
 * duplicate a reviewer can see.
 */
export function sameCompany(a: IdentityKeys, b: IdentityKeys): IdentityMatch {
  if (a.externalPlaceId && b.externalPlaceId) {
    return a.externalPlaceId === b.externalPlaceId
      ? { matched: true, via: 'placeId', confidence: 1 }
      : { matched: false, via: null, confidence: 0 };
  }

  if (a.normalizedPhone && b.normalizedPhone && a.normalizedPhone === b.normalizedPhone) {
    return { matched: true, via: 'phone', confidence: 0.95 };
  }

  if (
    a.normalizedAddress &&
    b.normalizedAddress &&
    a.normalizedAddress === b.normalizedAddress &&
    a.normalizedName === b.normalizedName
  ) {
    return { matched: true, via: 'addressAndName', confidence: 0.9 };
  }

  const bothLackAddress = !a.normalizedAddress || !b.normalizedAddress;
  if (
    bothLackAddress &&
    a.normalizedName &&
    a.normalizedName === b.normalizedName &&
    a.cityName &&
    b.cityName &&
    a.cityName.toLowerCase() === b.cityName.toLowerCase() &&
    a.stateCode === b.stateCode
  ) {
    return { matched: true, via: 'nameAndCity', confidence: 0.7 };
  }

  return { matched: false, via: null, confidence: 0 };
}
