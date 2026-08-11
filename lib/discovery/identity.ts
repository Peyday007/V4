
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

/**
 * Strips legal suffixes and punctuation so "Planet Fitness Inc" and "Planet
 * Fitness" compare equal. Lives here rather than in the ingest module because
 * it is an identity key, and keeping it there forced `identity.ts` to import
 * from `run.ts` — a cycle between the two modules that most need to be
 * loadable on their own.
 */
export function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\b(inc|llc|l\.l\.c|ltd|corp|corporation|company|co|group|holdings|services|service)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

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

/**
 * Two-letter US state codes, so "TX" is accepted and "Suite" is not.
 */
const STATE_CODES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA',
  'MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX',
  'UT','VT','VA','WA','WV','WI','WY','PR','VI','GU','AS','MP',
]);

/**
 * Rejects a city that is not a city.
 *
 * Several connectors build a location string by joining fields, and the
 * downstream split can leave a house number or a postcode where the city
 * should be — which is how "633" ended up displayed as a lead's location. A
 * name with no letters is not a place, and storing it is worse than storing
 * nothing, because null is visibly unknown while "633" looks like data.
 */
export function isPlausibleCityName(value: string | null | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed.length > 60) return false;
  // Must contain at least two consecutive letters; digits alone or mixed
  // fragments like "633" and "STE 4" are address parts, not city names.
  if (!/[A-Za-z]{2}/.test(trimmed)) return false;
  if (/^\d/.test(trimmed)) return false;
  if (/^(ste|suite|apt|unit|floor|fl|bldg|po box)\b/i.test(trimmed)) return false;
  return true;
}

export function isPlausibleStateCode(value: string | null | undefined): boolean {
  if (!value) return false;
  return STATE_CODES.has(value.trim().toUpperCase());
}

/** Keeps a plausible city or returns null, never a fragment. */
export function cleanCity(value: string | null | undefined): string | null {
  return isPlausibleCityName(value) ? value!.trim() : null;
}

export function cleanState(value: string | null | undefined): string | null {
  return isPlausibleStateCode(value) ? value!.trim().toUpperCase() : null;
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
    // Validated rather than trusted: a malformed fragment is discarded so the
    // interface shows "location unknown" instead of a house number.
    cityName: cleanCity(input.city),
    stateCode: cleanState(input.state),
  };
}

export type QuarantineVerdict = { quarantined: boolean; reason: string | null };

/**
 * Whether an identity is complete enough to rank and act on.
 *
 * Quarantine rather than delete or merge. A record with a name and nothing
 * else may be perfectly real — the source was just thin — and destroying it
 * loses information. Merging it is worse: with no distinguishing key, any
 * merge is a guess, and a wrong merge silently fuses two real businesses.
 * Holding it aside keeps it inspectable and keeps it out of the ranking.
 */
export function assessIdentity(keys: IdentityKeys): QuarantineVerdict {
  const hasStrongKey = Boolean(keys.externalPlaceId || keys.normalizedPhone || keys.normalizedAddress);
  const hasLocation = Boolean(keys.cityName || keys.stateCode);

  if (!keys.normalizedName || keys.normalizedName.length < 2) {
    return { quarantined: true, reason: 'no usable organisation name' };
  }
  if (!hasStrongKey && !hasLocation) {
    return {
      quarantined: true,
      reason: 'only a name — no place ID, phone, address, city or state, so it cannot be matched or located',
    };
  }
  if (!hasStrongKey) {
    return {
      quarantined: true,
      reason: 'no place ID, phone or address, so any deduplication against it would be a guess',
    };
  }
  return { quarantined: false, reason: null };
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
