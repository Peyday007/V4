import type { ContactConfidence, ContactResolutionStatus, ContactScope, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { buildIdentity } from '@/lib/discovery/identity';
import { callableRouteCount } from '@/lib/demand/queue';
import { decideContact, mayReplace, releasesToCallQueue, type ContactCandidate } from './candidates';
import { fingerprintOf, isStale, nextAttemptFor } from './policy';
import { assertProductionOnly } from '@/lib/safety/outbound';
import {
  CONTACT_SOURCES,
  SourceNotConfiguredError,
  SourceUnavailableError,
  freshDaysFor,
  websiteDomain,
  type ResolutionSubject,
} from './sources';

/**
 * Resolving one organisation's contact route.
 *
 * This is the shared implementation the operator asked for: the immediate
 * trigger after a source run, the recurring worker, the backfill and the retry
 * buttons all end up here, and there is no second path any of them can take.
 * That is what makes the guarantees below true everywhere rather than in the
 * one place somebody remembered them.
 *
 * The order is fixed. Data we already hold is searched first, and if it settles
 * the question no external provider is called at all — which is both cheaper
 * and better, because our own callers' confirmations live there. External
 * sources answer only what is left.
 *
 * Every exit from this function writes a result. There are no silent early
 * returns: `finish` is the only way out, and it always leaves a status, a
 * confidence, a blocker where one applies and a next attempt where one is due.
 * A record that vanished without explanation is the failure mode this workflow
 * exists to remove.
 */

export type ResolutionResult = {
  companyId: string;
  organisation: string;
  status: ContactResolutionStatus;
  confidence: ContactConfidence | null;
  /** The number written, when one was. */
  phone: string | null;
  scope: ContactScope;
  blocker: string | null;
  sources: string[];
  /** Routes for this account that are callable now. */
  callableRoutes: number;
  /** True when this attempt is what made them callable. */
  released: boolean;
  nextAttemptAt: Date | null;
  note: string;
};

export async function resolveCompanyContact(params: {
  orgId: string;
  companyId: string;
  workerId?: string;
  /** Ignore the schedule and the fingerprint. What a retry button does. */
  force?: boolean;
  now?: Date;
}): Promise<ResolutionResult> {
  // An external directory lookup is an outbound request with a cost and a
  // rate limit attached. Sandbox companies do not exist, so asking about them
  // spends real quota to learn nothing.
  await assertProductionOnly({ companyId: params.companyId }, 'resolving a contact from external sources');

  const now = params.now ?? new Date();
  const { orgId, companyId } = params;

  const company = await prisma.company.findFirst({
    where: { id: companyId, orgId },
    select: {
      id: true,
      legalName: true,
      website: true,
      phone: true,
      cityName: true,
      stateCode: true,
      externalPlaceId: true,
      normalizedAddress: true,
      locations: {
        select: { line1: true, city: true, state: true, postalCode: true },
        orderBy: { isHeadquarters: 'desc' },
        take: 1,
      },
      contacts: { select: { id: true, phone: true, mobile: true, email: true }, take: 5 },
      contactResolution: true,
    },
  });

  if (!company) {
    // Not ours to resolve. Nothing is written because there is no row to write
    // against, and saying so is the result.
    return {
      companyId,
      organisation: '(unknown)',
      status: 'FAILED',
      confidence: 'FAILED',
      phone: null,
      scope: 'UNKNOWN',
      blocker: 'That organisation does not exist in this workspace.',
      sources: [],
      callableRoutes: 0,
      released: false,
      nextAttemptAt: null,
      note: 'No such organisation.',
    };
  }

  const existing = company.contactResolution;
  const callableBefore = await callableRouteCount(orgId, companyId);

  // The address the event gave us, when the company record has none of its own.
  // A licence record's street address is the single most useful thing for
  // telling one branch from another, so it is worth reaching for.
  const location = company.locations[0];
  const eventAddress =
    location?.line1 && location.city
      ? null
      : await prisma.demandEvent.findFirst({
          where: { orgId, parties: { some: { companyId } }, addressLine1: { not: null } },
          orderBy: { eventDate: 'desc' },
          select: { addressLine1: true, cityName: true, stateCode: true, postalCode: true },
        });

  const subject: ResolutionSubject = {
    orgId,
    companyId,
    name: company.legalName,
    addressLine1: location?.line1 ?? eventAddress?.addressLine1 ?? null,
    cityName: company.cityName ?? location?.city ?? eventAddress?.cityName ?? null,
    stateCode: company.stateCode ?? location?.state ?? eventAddress?.stateCode ?? null,
    postalCode: location?.postalCode ?? eventAddress?.postalCode ?? null,
    website: company.website,
    externalPlaceId: company.externalPlaceId,
  };

  const rejectedValues = existing?.rejectedValues ?? [];
  const fingerprint = fingerprintOf({ ...subject, rejectedValues });

  /**
   * The single exit. Writes the resolution row, the provenance and the
   * schedule, then reports what actually changed in the calling queue.
   */
  const finish = async (outcome: {
    status: ContactResolutionStatus;
    confidence: ContactConfidence | null;
    blocker: string | null;
    sources: string[];
    phone?: string | null;
    scope?: ContactScope;
    failureKind?: string | null;
    failureDetail?: string | null;
    fixInstruction?: string | null;
    candidates?: unknown[];
    ambiguityReason?: string | null;
    transientFailures?: number;
    freshDays?: number;
  }): Promise<ResolutionResult> => {
    const retry = nextAttemptFor({
      status: outcome.status,
      failureKind: outcome.failureKind,
      transientFailures: outcome.transientFailures,
      freshDays: outcome.freshDays,
      now,
    });

    const merged = [...new Set([...(existing?.sourcesAttempted ?? []), ...outcome.sources])];

    await prisma.contactResolution.upsert({
      where: { companyId },
      create: {
        orgId,
        companyId,
        status: outcome.status,
        confidence: outcome.confidence,
        blocker: outcome.blocker,
        sourcesAttempted: merged,
        lastSources: outcome.sources,
        attempts: 1,
        transientFailures: outcome.transientFailures ?? 0,
        lastAttemptAt: now,
        resolvedAt: outcome.status === 'RESOLVED' ? now : null,
        nextAttemptAt: retry.nextAttemptAt,
        candidates: (outcome.candidates ?? []) as Prisma.InputJsonValue,
        ambiguityReason: outcome.ambiguityReason ?? null,
        failureKind: outcome.failureKind ?? null,
        failureDetail: outcome.failureDetail ?? null,
        fixInstruction: outcome.fixInstruction ?? null,
        rejectedValues,
        sourceFingerprint: fingerprint,
        lockedAt: null,
        lockedBy: null,
      },
      update: {
        status: outcome.status,
        confidence: outcome.confidence,
        blocker: outcome.blocker,
        sourcesAttempted: merged,
        lastSources: outcome.sources,
        attempts: { increment: 1 },
        transientFailures: outcome.transientFailures ?? 0,
        lastAttemptAt: now,
        // Kept from the previous success when this attempt did not succeed, so
        // an outage cannot make a resolved record look like it never was.
        resolvedAt: outcome.status === 'RESOLVED' ? now : (existing?.resolvedAt ?? null),
        nextAttemptAt: retry.nextAttemptAt,
        candidates: (outcome.candidates ?? []) as Prisma.InputJsonValue,
        ambiguityReason: outcome.ambiguityReason ?? null,
        failureKind: outcome.failureKind ?? null,
        failureDetail: outcome.failureDetail ?? null,
        fixInstruction: outcome.fixInstruction ?? null,
        sourceFingerprint: fingerprint,
        lockedAt: null,
        lockedBy: null,
      },
    });

    const callableAfter = await callableRouteCount(orgId, companyId);
    return {
      companyId,
      organisation: company.legalName,
      status: outcome.status,
      confidence: outcome.confidence,
      phone: outcome.phone ?? null,
      scope: outcome.scope ?? 'UNKNOWN',
      blocker: outcome.blocker,
      sources: outcome.sources,
      callableRoutes: callableAfter,
      released: callableAfter > callableBefore,
      nextAttemptAt: retry.nextAttemptAt,
      note: retry.note,
    };
  };

  // ---------------------------------------------------------------------
  // Already answered
  // ---------------------------------------------------------------------
  //
  // A number a caller confirmed, or one already held and still current, is a
  // better answer than anything a fresh search will produce, and re-buying it
  // from a provider every fortnight is money spent to learn nothing.
  const heldPhone = company.phone ?? company.contacts.find((c) => c.phone ?? c.mobile)?.phone ?? null;
  if (heldPhone && !params.force) {
    const held = await strongestProvenance(companyId, 'phone');
    const staleness = held ? freshDaysFor(held.source) : 365;
    const heldIsCurrent = !held || !isStale({ retrievedAt: held.retrievedAt, freshDays: staleness, now });

    if (heldIsCurrent && !rejectedValues.includes(heldPhone)) {
      if (!held) {
        // Held with no record of where it came from — from an import, a seed or
        // a hand edit before this workflow existed. Recorded now so it has a
        // provenance like everything else, and marked for what it is.
        await writeProvenance({
          orgId,
          companyId,
          field: 'phone',
          value: heldPhone,
          source: 'held_before_resolution',
          sourceUrl: null,
          externalId: null,
          retrievedAt: now,
          confidence: 'PROBABLE',
          scope: 'UNKNOWN',
          verified: false,
          matchMethod: 'already on the account record when contact resolution first ran',
        });
      }
      return finish({
        status: 'RESOLVED',
        confidence: held?.confidence ?? 'PROBABLE',
        blocker: null,
        sources: ['existing_platform_data'],
        phone: heldPhone,
        scope: held?.scope ?? 'UNKNOWN',
        freshDays: staleness,
      });
    }
  }

  // ---------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------
  const candidates: ContactCandidate[] = [];
  const consulted: string[] = [];
  const failures: Array<{ key: string; error: unknown; configuration: boolean }> = [];

  for (const source of CONTACT_SOURCES) {
    // One source being unavailable never stops the rest. A missing optional
    // provider is a narrower search, not a failed one.
    try {
      const found = await source.search(subject);
      consulted.push(source.key);
      candidates.push(...found);
    } catch (error) {
      failures.push({
        key: source.key,
        error,
        configuration: error instanceof SourceNotConfiguredError,
      });
      continue;
    }

    // Held data that already settles it means the external lookup is not worth
    // buying. Checked between sources rather than after all of them.
    if (!source.external) {
      const interim = decideContact({ target: identityOf(subject), candidates, rejectedValues });
      if (interim.confidence === 'VERIFIED' && interim.chosen) break;
    }
  }

  const decision = decideContact({
    target: identityOf(subject),
    candidates,
    rejectedValues,
    allSourcesFailed: consulted.length === 0 && failures.length > 0,
  });

  // ---------------------------------------------------------------------
  // Failure — kept strictly apart from "nothing found"
  // ---------------------------------------------------------------------
  if (decision.confidence === 'FAILED') {
    const configuration = failures.find((f) => f.configuration);
    const transient = (existing?.transientFailures ?? 0) + (configuration ? 0 : 1);
    return finish({
      status: 'FAILED',
      confidence: 'FAILED',
      blocker: configuration
        ? `Contact lookup is not configured: ${String(configuration.error).slice(0, 200)}`
        : `Every contact source failed. ${failures.map((f) => `${f.key}: ${String(f.error).slice(0, 120)}`).join(' | ')}`,
      sources: [],
      failureKind: configuration ? 'configuration' : 'provider_unavailable',
      failureDetail: failures.map((f) => `${f.key}: ${String(f.error).slice(0, 300)}`).join(' | ').slice(0, 2000),
      fixInstruction: configuration ? (configuration.error as SourceNotConfiguredError).fixInstruction : null,
      transientFailures: transient,
    });
  }

  // Some sources answered and some did not. The search happened, so its result
  // stands — but a partial search that found nothing is not the same as a
  // complete one, and the blocker says which sources were missing.
  const partialNote =
    failures.length > 0
      ? ` Not every source could be consulted: ${failures.map((f) => f.key).join(', ')} ` +
        `(${failures.map((f) => (f.configuration ? 'not configured' : 'unavailable')).join(', ')}).`
      : '';

  // A configuration gap that stopped one source is still worth naming with its
  // remedy, even though the others answered. Without this the operator sees
  // "nothing published" on records that were only half searched, and the one
  // thing they could actually change is never mentioned.
  const partialConfiguration = failures.find((f) => f.configuration);
  const partialFailure = partialConfiguration
    ? {
        failureKind: 'partial_configuration',
        failureDetail: failures
          .map((f) => `${f.key}: ${String(f.error).slice(0, 300)}`)
          .join(' | ')
          .slice(0, 2000),
        fixInstruction: (partialConfiguration.error as SourceNotConfiguredError).fixInstruction,
      }
    : failures.length > 0
      ? {
          failureKind: 'partial_provider_unavailable',
          failureDetail: failures.map((f) => `${f.key}: ${String(f.error).slice(0, 300)}`).join(' | ').slice(0, 2000),
          fixInstruction: null,
        }
      : {};

  // ---------------------------------------------------------------------
  // Ambiguous
  // ---------------------------------------------------------------------
  if (decision.confidence === 'AMBIGUOUS') {
    return finish({
      status: 'AMBIGUOUS',
      confidence: 'AMBIGUOUS',
      blocker: `${decision.blocker}${partialNote}`,
      sources: consulted,
      candidates: decision.competing,
      ambiguityReason: decision.ambiguityReason,
      ...partialFailure,
    });
  }

  // ---------------------------------------------------------------------
  // Nothing defensible
  // ---------------------------------------------------------------------
  if (!decision.chosen || !releasesToCallQueue(decision.confidence, decision.scope)) {
    // A listing for the same chain somewhere else is still worth keeping. It is
    // recorded and labelled, never promoted to this location's number.
    for (const other of decision.otherLocations) {
      if (!other.phone) continue;
      await writeProvenance({
        orgId,
        companyId,
        field: 'phone',
        value: other.phone,
        source: other.source,
        sourceUrl: null,
        externalId: null,
        retrievedAt: now,
        confidence: 'UNRESOLVED',
        scope: 'PARENT_OR_CENTRAL',
        verified: false,
        matchMethod: `same business name at ${other.location ?? 'another address'} — a different site, not this one`,
      });
    }

    return finish({
      status: 'UNRESOLVED',
      confidence: 'UNRESOLVED',
      blocker: `${decision.blocker ?? 'No defensible contact route found.'}${partialNote}`,
      sources: consulted,
      candidates: decision.otherLocations,
      ...partialFailure,
    });
  }

  // ---------------------------------------------------------------------
  // Resolved — write it, without trampling anything stronger
  // ---------------------------------------------------------------------
  const chosen = decision.chosen;
  const written = await applyContact({
    orgId,
    companyId,
    candidate: chosen,
    confidence: decision.confidence,
    scope: decision.scope,
    method: decision.method,
    now,
  });

  return finish({
    status: 'RESOLVED',
    confidence: decision.confidence,
    blocker: null,
    sources: consulted,
    phone: written.phone,
    scope: decision.scope,
    freshDays: freshDaysFor(chosen.source),
  });
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function identityOf(subject: ResolutionSubject) {
  return buildIdentity({
    name: subject.name,
    externalPlaceId: subject.externalPlaceId,
    phone: null,
    // Only when a street line exists. "Chicago IL" is a place, not an address,
    // and letting it stand as one makes every unaddressed listing look like a
    // different branch.
    address: subject.addressLine1
      ? [subject.addressLine1, subject.cityName, subject.stateCode].filter(Boolean).join(' ')
      : null,
    city: subject.cityName,
    state: subject.stateCode,
  });
}

/**
 * Puts the chosen contact on the account.
 *
 * Nothing here overwrites a value backed by stronger evidence, and nothing
 * deletes. A person is only created when a source actually named one — a main
 * line goes on the company, where the queue already reads it from, rather than
 * being dressed up as a contact called "Main Line" who does not exist.
 */
async function applyContact(params: {
  orgId: string;
  companyId: string;
  candidate: ContactCandidate;
  confidence: ContactConfidence;
  scope: ContactScope;
  method: string | null;
  now: Date;
}): Promise<{ phone: string | null; website: string | null }> {
  const { orgId, companyId, candidate, confidence, scope, method, now } = params;
  const result: { phone: string | null; website: string | null } = { phone: null, website: null };

  if (candidate.phone) {
    const existing = await strongestProvenance(companyId, 'phone');
    // Finding the same number again is confirmation, not competition. It is
    // written back rather than skipped, because `mayReplace` answers "is this
    // better than what stands", and the standing value cannot beat itself —
    // which would otherwise leave the account with provenance for a number and
    // no number on the record for the queue to read.
    const confirmsStanding = existing?.value === candidate.phone;

    if (confirmsStanding || mayReplace(existing, { confidence, verified: candidate.verified })) {
      await prisma.company.update({
        where: { id: companyId },
        data: { phone: candidate.phone, lastEnrichedAt: now },
      });
      if (!confirmsStanding) {
        await supersede(companyId, 'phone', candidate.phone, 'a better-evidenced number replaced it');
      }
      if (confirmsStanding && existing.enteredByOperator) {
        // A caller established this number. Re-finding it in a directory does
        // not make it a directory's number, so only the timestamp moves.
        await prisma.contactProvenance.update({
          where: { id: existing.id },
          data: { retrievedAt: candidate.retrievedAt },
        });
      } else {
        await writeProvenance({
          orgId,
          companyId,
          field: 'phone',
          value: candidate.phone,
          source: candidate.source,
          sourceUrl: candidate.sourceUrl,
          externalId: candidate.externalId,
          retrievedAt: candidate.retrievedAt,
          confidence,
          scope,
          verified: candidate.verified,
          matchMethod: method,
        });
      }
      result.phone = candidate.phone;
    } else {
      // A different number, backed by weaker evidence. The stronger value
      // stays, and this one is recorded as seen-and-not-used so the next
      // attempt does not treat it as news.
      await writeProvenance({
        orgId,
        companyId,
        field: 'phone',
        value: candidate.phone,
        source: candidate.source,
        sourceUrl: candidate.sourceUrl,
        externalId: candidate.externalId,
        retrievedAt: candidate.retrievedAt,
        confidence,
        scope,
        verified: candidate.verified,
        matchMethod: `${method ?? 'found'}; not applied because a better-evidenced number is already held`,
        supersededAt: now,
        supersededReason: 'a stronger value was already on the account',
      });
      result.phone = null;
    }
  }

  if (candidate.website) {
    const existing = await strongestProvenance(companyId, 'website');
    const confirmsStanding = existing?.value === candidate.website;
    if (confirmsStanding || mayReplace(existing, { confidence, verified: candidate.verified })) {
      await prisma.company.update({ where: { id: companyId }, data: { website: candidate.website } });
      if (!confirmsStanding) {
        await supersede(companyId, 'website', candidate.website, 'a better-evidenced website replaced it');
      }
      await writeProvenance({
        orgId,
        companyId,
        field: 'website',
        value: candidate.website,
        source: candidate.source,
        sourceUrl: candidate.sourceUrl,
        externalId: candidate.externalId,
        retrievedAt: candidate.retrievedAt,
        confidence,
        scope,
        verified: candidate.verified,
        matchMethod: method,
      });
      result.website = candidate.website;
    }
  }

  // The provider's own identifier for this place. Durable under the Places
  // terms where the rest of the listing is not, which makes it the join key
  // for re-checking rather than re-searching next time.
  if (candidate.externalPlaceId) {
    await prisma.company.updateMany({
      where: { id: companyId, externalPlaceId: null },
      data: { externalPlaceId: candidate.externalPlaceId },
    });
  }

  // A person, only where a source named one.
  if (candidate.contactName) {
    const [firstName, ...rest] = candidate.contactName.trim().split(/\s+/);
    const lastName = rest.join(' ');
    if (firstName && lastName) {
      const already = await prisma.contact.findFirst({
        where: { orgId, companyId, firstName, lastName },
        select: { id: true },
      });
      const data = {
        title: candidate.contactRole ?? undefined,
        phone: candidate.phone ?? undefined,
        email: candidate.email ?? undefined,
        // Found in a listing is not the same as spoken to. Only a call moves
        // this on, and only the disposition workflow records a call.
        verificationStatus: candidate.verified ? ('VERIFIED_BY_CALL' as const) : ('UNVERIFIED' as const),
        // Nothing here establishes that this person decides or signs, so the
        // flag stays false and the role stays an assertion by the source.
        contactKind: candidate.contactRole ? ('DIRECT' as const) : ('ROUTING' as const),
        roleTier: 'SOURCE_FACT' as const,
      };
      if (already) {
        await prisma.contact.update({ where: { id: already.id }, data });
      } else {
        await prisma.contact.create({ data: { orgId, companyId, firstName, lastName, ...data } });
      }
      await writeProvenance({
        orgId,
        companyId,
        field: 'contactName',
        value: candidate.contactName,
        source: candidate.source,
        sourceUrl: candidate.sourceUrl,
        externalId: candidate.externalId,
        retrievedAt: candidate.retrievedAt,
        confidence,
        scope,
        verified: candidate.verified,
        matchMethod: method,
      });
    }
  }

  // A general address published by a source. Never a generated pattern, and
  // never marked verified on the strength of having been generated.
  if (candidate.email) {
    await writeProvenance({
      orgId,
      companyId,
      field: 'email',
      value: candidate.email,
      source: candidate.source,
      sourceUrl: candidate.sourceUrl,
      externalId: candidate.externalId,
      retrievedAt: candidate.retrievedAt,
      confidence,
      scope,
      verified: candidate.verified,
      matchMethod: method,
    });
  }

  // Where the match was made, so the caller card can say which location this
  // number belongs to rather than implying it is head office.
  const place = [candidate.addressLine1, candidate.cityName, candidate.stateCode].filter(Boolean).join(', ');
  if (place) {
    await writeProvenance({
      orgId,
      companyId,
      field: 'location',
      value: place,
      source: candidate.source,
      sourceUrl: candidate.sourceUrl,
      externalId: candidate.externalId,
      retrievedAt: candidate.retrievedAt,
      confidence,
      scope,
      verified: candidate.verified,
      matchMethod: method,
    });
  }

  return result;
}

export async function writeProvenance(row: {
  orgId: string;
  companyId: string;
  field: string;
  value: string;
  source: string;
  sourceUrl: string | null;
  externalId: string | null;
  retrievedAt: Date;
  confidence: ContactConfidence;
  scope: ContactScope;
  verified: boolean;
  enteredByOperator?: boolean;
  matchMethod?: string | null;
  supersededAt?: Date | null;
  supersededReason?: string | null;
}): Promise<void> {
  const data = {
    source: row.source,
    sourceUrl: row.sourceUrl,
    externalId: row.externalId,
    retrievedAt: row.retrievedAt,
    confidence: row.confidence,
    scope: row.scope,
    verified: row.verified,
    enteredByOperator: row.enteredByOperator ?? false,
    matchMethod: row.matchMethod ?? null,
    supersededAt: row.supersededAt ?? null,
    supersededReason: row.supersededReason ?? null,
  };
  await prisma.contactProvenance.upsert({
    where: { companyId_field_value: { companyId: row.companyId, field: row.field, value: row.value } },
    create: { orgId: row.orgId, companyId: row.companyId, field: row.field, value: row.value, ...data },
    update: data,
  });
}

/** The best evidence currently standing behind one field. */
export async function strongestProvenance(companyId: string, field: string) {
  const rows = await prisma.contactProvenance.findMany({
    where: { companyId, field, supersededAt: null },
    orderBy: [{ enteredByOperator: 'desc' }, { verified: 'desc' }, { retrievedAt: 'desc' }],
    take: 5,
  });
  const rank: Record<ContactConfidence, number> = { VERIFIED: 3, PROBABLE: 2, AMBIGUOUS: 1, UNRESOLVED: 0, FAILED: 0 };
  return (
    rows.sort((a, b) => {
      if (a.enteredByOperator !== b.enteredByOperator) return a.enteredByOperator ? -1 : 1;
      if (a.verified !== b.verified) return a.verified ? -1 : 1;
      return rank[b.confidence] - rank[a.confidence];
    })[0] ?? null
  );
}

/** Stamps every other standing value for a field, without deleting any. */
async function supersede(companyId: string, field: string, keeping: string, reason: string): Promise<void> {
  await prisma.contactProvenance.updateMany({
    where: { companyId, field, value: { not: keeping }, supersededAt: null, enteredByOperator: false },
    data: { supersededAt: new Date(), supersededReason: reason },
  });
}

export { websiteDomain };
