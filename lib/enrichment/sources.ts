import type { ContactScope } from '@prisma/client';
import { prisma } from '@/lib/db';
import { hasCredential, HttpError, MissingCredentialError } from '@/lib/discovery/http';
import { lookupPlace, PLACES_RETENTION } from '@/lib/discovery/connectors/googlePlaces';
import { parseAddress } from '@/lib/discovery/location';
import { normalizeCompanyName, normalizePhone } from '@/lib/discovery/identity';
import type { ContactCandidate } from './candidates';

/**
 * Where contact information comes from.
 *
 * One adapter interface, one registry, one order of consultation — used by
 * ordinary lead enrichment and by demand opportunities alike, because they are
 * the same job. Adding a provider means adding an entry here, not a second
 * workflow.
 *
 * The order is not arbitrary. Data we already hold is free, is often better
 * than anything a directory will give us, and includes what our own callers
 * have confirmed; external sources are consulted only for what it does not
 * answer. Consulting them in the other order would spend money re-finding
 * numbers already on the premises.
 *
 * ## What each adapter may keep
 *
 * The Places terms allow the place ID to be stored indefinitely and treat the
 * rest of the listing as content to confirm rather than cache. That constraint
 * is not a nuisance here, it is the staleness policy: a Places-sourced phone
 * number is stamped with when it was retrieved and re-resolved once it passes
 * the retention horizon, which is also when it stops being trustworthy.
 */

/** A source that cannot run until somebody sets something. Not a fault. */
export class SourceNotConfiguredError extends Error {
  constructor(
    message: string,
    readonly fixInstruction: string,
  ) {
    super(message);
    this.name = 'SourceNotConfiguredError';
  }
}

/** A source that should have worked and did not. Worth retrying. */
export class SourceUnavailableError extends Error {
  constructor(
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = 'SourceUnavailableError';
  }
}

/** The organisation being resolved, as the adapters need to see it. */
export type ResolutionSubject = {
  orgId: string;
  companyId: string;
  name: string;
  addressLine1: string | null;
  cityName: string | null;
  stateCode: string | null;
  postalCode: string | null;
  website: string | null;
  externalPlaceId: string | null;
};

export type ContactSource = {
  key: string;
  label: string;
  /** Null when the adapter needs no credential. */
  credentialEnvVar: string | null;
  /** What to do when the credential is missing. */
  fixInstruction: string;
  /** How long a value from this source stays trustworthy. */
  freshDays: number;
  /** Whether it costs money or an external round trip. */
  external: boolean;
  search(subject: ResolutionSubject): Promise<ContactCandidate[]>;
};

// ---------------------------------------------------------------------------
// Data we already hold
// ---------------------------------------------------------------------------

/**
 * Everything on the premises, before anybody pays a provider.
 *
 * Searches three places, all of which routinely carry a number that the demand
 * record did not: other company rows that are the same business reached by a
 * different route, the contacts beneath them, and the contact hints discovery
 * connectors stored alongside their signals.
 *
 * Matching is deliberately generous here and strict later. This adapter's job
 * is to surface everything that might be the same organisation; deciding
 * whether it actually is belongs to `decideContact`, which is pure and tested.
 * A candidate that turns out to be a branch in another town is a useful thing
 * to have found, not a mistake to have surfaced.
 */
const platformSource: ContactSource = {
  key: 'existing_platform_data',
  label: 'Records we already hold',
  credentialEnvVar: null,
  fixInstruction: '',
  // Our own records do not expire the way a licensed directory listing does.
  freshDays: 365,
  external: false,

  async search(subject) {
    const normalized = normalizeCompanyName(subject.name);
    if (!normalized || normalized.length < 2) return [];

    const domain = websiteDomain(subject.website);
    const candidates: ContactCandidate[] = [];

    // --- other company rows, and their contacts --------------------------
    //
    // Narrowed in SQL on the keys the operator listed, so this stays one
    // indexed query rather than a scan of every company in the organisation.
    const siblings = await prisma.company.findMany({
      where: {
        orgId: subject.orgId,
        id: { not: subject.companyId },
        OR: [
          ...(subject.externalPlaceId ? [{ externalPlaceId: subject.externalPlaceId }] : []),
          ...(domain ? [{ website: { contains: domain, mode: 'insensitive' as const } }] : []),
          ...(subject.cityName ? [{ cityName: { equals: subject.cityName, mode: 'insensitive' as const } }] : []),
          { legalName: { contains: firstWord(subject.name), mode: 'insensitive' as const } },
        ],
      },
      select: {
        id: true,
        legalName: true,
        operatingName: true,
        website: true,
        phone: true,
        cityName: true,
        stateCode: true,
        externalPlaceId: true,
        updatedAt: true,
        locations: { select: { line1: true, city: true, state: true, postalCode: true }, take: 1 },
        contacts: {
          select: {
            firstName: true,
            lastName: true,
            title: true,
            phone: true,
            mobile: true,
            email: true,
            verificationStatus: true,
            isDecisionMaker: true,
            updatedAt: true,
          },
          orderBy: [{ isDecisionMaker: 'desc' }, { createdAt: 'asc' }],
          take: 3,
        },
      },
      take: 200,
    });

    for (const sibling of siblings) {
      const location = sibling.locations[0];
      const base = {
        source: 'existing_platform_data',
        sourceUrl: null,
        externalId: sibling.id,
        name: sibling.legalName,
        website: sibling.website,
        addressLine1: location?.line1 ?? null,
        cityName: sibling.cityName ?? location?.city ?? null,
        stateCode: sibling.stateCode ?? location?.state ?? null,
        postalCode: location?.postalCode ?? null,
        externalPlaceId: sibling.externalPlaceId,
        businessDetails: [`Already held as "${sibling.legalName}" in this workspace.`],
      };

      if (sibling.phone) {
        candidates.push({
          ...base,
          retrievedAt: sibling.updatedAt,
          phone: sibling.phone,
          email: null,
          contactName: null,
          contactRole: null,
          verified: false,
        });
      }

      for (const contact of sibling.contacts) {
        if (!contact.phone && !contact.mobile && !contact.email) continue;
        candidates.push({
          ...base,
          retrievedAt: contact.updatedAt,
          phone: contact.phone ?? contact.mobile,
          email: contact.email,
          contactName: `${contact.firstName} ${contact.lastName}`.trim() || null,
          contactRole: contact.title,
          // A call is the only thing that verifies a number, and the contact
          // record already records whether one happened.
          verified: contact.verificationStatus === 'VERIFIED_BY_CALL',
        });
      }
    }

    // --- contact hints stored beside discovery signals -------------------
    //
    // A Places sweep that found this business months ago recorded its phone
    // number here. Re-finding it externally would be paying twice for the
    // same fact.
    const signals = await prisma.discoverySignal.findMany({
      where: {
        orgId: subject.orgId,
        status: { not: 'DISMISSED' },
        OR: [
          { companyId: subject.companyId },
          { headline: { contains: firstWord(subject.name), mode: 'insensitive' } },
        ],
      },
      select: {
        headline: true,
        contactHint: true,
        sourceUrl: true,
        cityName: true,
        stateCode: true,
        location: true,
        lastSeenAt: true,
        origin: true,
      },
      orderBy: { lastSeenAt: 'desc' },
      take: 100,
    });

    for (const signal of signals) {
      // A seeded demonstration row is not evidence about a real business.
      if (signal.origin === 'SEED_DEMO') continue;
      const hint = (signal.contactHint ?? {}) as Record<string, unknown>;
      const phone = typeof hint.phone === 'string' ? hint.phone : null;
      const website = typeof hint.website === 'string' ? hint.website : null;
      const email = typeof hint.email === 'string' ? hint.email : null;
      if (!phone && !email) continue;

      const parsed = parseAddress(typeof hint.address === 'string' ? hint.address : signal.location);
      candidates.push({
        source: 'existing_platform_data',
        sourceUrl: signal.sourceUrl,
        externalId: null,
        retrievedAt: signal.lastSeenAt,
        // The headline is "<name> — <service>"; the name is the part before it.
        name: signal.headline.split('—')[0].trim() || signal.headline,
        phone,
        website,
        email,
        contactName: null,
        contactRole: null,
        addressLine1: parsed.line1 ?? null,
        cityName: signal.cityName ?? parsed.city ?? null,
        stateCode: signal.stateCode ?? parsed.state ?? null,
        postalCode: parsed.postalCode ?? null,
        externalPlaceId: null,
        verified: false,
        businessDetails: ['Found earlier by a discovery source in this workspace.'],
      });
    }

    return dedupe(candidates);
  },
};

// ---------------------------------------------------------------------------
// Google Places
// ---------------------------------------------------------------------------

/**
 * The licensed directory lookup.
 *
 * Chosen because it is already configured, already paid for, and its terms
 * permit exactly what is needed here. It is asked one question — is this named
 * business at this address listed — and the answer carries the two fields that
 * unblock a call: the national phone number and the website.
 *
 * No decision-maker email, and none is invented. Where a source does not
 * publish a person, the workflow says so rather than generating an address
 * from a pattern and marking it found.
 */
const placesSource: ContactSource = {
  key: 'google_places',
  label: 'Google Places',
  credentialEnvVar: 'GOOGLE_PLACES_API_KEY',
  fixInstruction:
    'Set GOOGLE_PLACES_API_KEY in the deployment environment, with "Places API (New)" enabled on the project and ' +
    'billing active. Until then contact resolution runs on held data only.',
  freshDays: PLACES_RETENTION.cacheDays,
  external: true,

  async search(subject) {
    if (!hasCredential('GOOGLE_PLACES_API_KEY')) {
      throw new SourceNotConfiguredError('GOOGLE_PLACES_API_KEY is not set.', placesSource.fixInstruction);
    }

    let places;
    try {
      places = await lookupPlace({
        name: subject.name,
        addressLine1: subject.addressLine1,
        cityName: subject.cityName,
        stateCode: subject.stateCode,
        postalCode: subject.postalCode,
      });
    } catch (error) {
      if (error instanceof MissingCredentialError) {
        throw new SourceNotConfiguredError(error.message, placesSource.fixInstruction);
      }
      // A key the project will not accept is a configuration problem wearing an
      // HTTP status. Retrying it every fifteen minutes fixes nothing and the
      // operator never learns what to change.
      if (/API_KEY_SERVICE_BLOCKED|are blocked|PERMISSION_DENIED|API key not valid/i.test(String(error))) {
        throw new SourceNotConfiguredError(
          `Google Places rejected the key: ${String(error).slice(0, 200)}`,
          'In Google Cloud → Credentials, check the key\'s API restrictions allow "Places API (New)", and that the ' +
            'key belongs to the project where that API is enabled and billing is active.',
        );
      }
      if (error instanceof HttpError) {
        throw new SourceUnavailableError(
          `Google Places returned ${error.status}.`,
          error.retryable,
        );
      }
      throw new SourceUnavailableError(String(error).slice(0, 300));
    }

    const now = new Date();
    return places.map((place) => {
      const parsed = parseAddress(place.formattedAddress);
      const state =
        place.addressComponents?.find((c) => c.types?.includes('administrative_area_level_1'))?.shortText ??
        parsed.state ??
        null;
      const city =
        place.addressComponents?.find((c) => c.types?.includes('locality'))?.longText ?? parsed.city ?? null;

      return {
        source: 'google_places',
        // The place ID is the durable identifier and the link a person can
        // open to check the match themselves.
        sourceUrl: `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(place.id!)}`,
        externalId: place.id ?? null,
        retrievedAt: now,
        name: place.displayName!.text!.trim(),
        phone: place.nationalPhoneNumber ?? null,
        website: place.websiteUri ?? null,
        // Places does not publish email addresses, and a pattern-generated one
        // would be a guess presented as a finding.
        email: null,
        contactName: null,
        contactRole: null,
        addressLine1: parsed.line1 ?? null,
        cityName: city,
        stateCode: state,
        postalCode: parsed.postalCode ?? null,
        externalPlaceId: place.id ?? null,
        // Listed, not checked.
        verified: false,
        declaredScope: 'UNKNOWN' as ContactScope,
        businessDetails: [
          place.formattedAddress ? `Listed at ${place.formattedAddress}.` : '',
          place.primaryType ? `Category: ${place.primaryType.replace(/_/g, ' ')}.` : '',
          place.businessStatus ? `Status: ${place.businessStatus.toLowerCase()}.` : '',
        ].filter(Boolean),
      } satisfies ContactCandidate;
    });
  },
};

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/** Consulted in this order. Held data first, paid lookups after. */
export const CONTACT_SOURCES: ContactSource[] = [platformSource, placesSource];

export function contactSource(key: string): ContactSource | undefined {
  return CONTACT_SOURCES.find((s) => s.key === key);
}

/**
 * How long a value from a given source stays trustworthy.
 *
 * Used to decide when a resolved organisation is re-resolved. An unknown source
 * is treated as the shortest horizon rather than the longest, because guessing
 * long on staleness means calling numbers that stopped working months ago.
 */
export function freshDaysFor(source: string): number {
  return contactSource(source)?.freshDays ?? PLACES_RETENTION.cacheDays;
}

/** Sources that cannot run right now, with the reason and the remedy. */
export function unavailableSources(): Array<{ key: string; label: string; reason: string; fix: string }> {
  return CONTACT_SOURCES.filter((source) => !hasCredential(source.credentialEnvVar)).map((source) => ({
    key: source.key,
    label: source.label,
    reason: `${source.credentialEnvVar} is not set.`,
    fix: source.fixInstruction,
  }));
}

// ---------------------------------------------------------------------------

function firstWord(name: string): string {
  const cleaned = normalizeCompanyName(name);
  const word = cleaned.split(' ').find((w) => w.length >= 3) ?? cleaned;
  return word.slice(0, 40);
}

function websiteDomain(website: string | null): string | null {
  if (!website) return null;
  try {
    const url = new URL(website.startsWith('http') ? website : `https://${website}`);
    return url.hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** One row per distinct number or address, keeping the richest version. */
function dedupe(candidates: ContactCandidate[]): ContactCandidate[] {
  const seen = new Map<string, ContactCandidate>();
  for (const candidate of candidates) {
    const key = [
      normalizeCompanyName(candidate.name),
      normalizePhone(candidate.phone) ?? '',
      candidate.email?.toLowerCase() ?? '',
    ].join('|');
    const existing = seen.get(key);
    if (!existing || (!existing.verified && candidate.verified)) seen.set(key, candidate);
  }
  return [...seen.values()];
}

export { websiteDomain };
