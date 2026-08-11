import type {
  DemandEvent,
  EventLifecycle,
  CompanyRole,
  EventPartyRole,
  FrictionLevel,
  LeadTier,
  Prisma,
} from '@prisma/client';
import { prisma } from '@/lib/db';
import { audit } from '@/lib/audit';
import { getActivePaths } from '@/lib/paths';
import { normalizeCompanyName, normalizeAddress, normalizePhone, cleanCity, cleanState } from '@/lib/discovery/identity';
import { matchCapability } from '@/lib/discovery/capabilityMatch';
import { buildProviderIndex, providersFor, type ProviderIndex } from '@/lib/discovery/reclassify';
import {
  assertTierEligibility,
  assessEventIdentity,
  assessExpiry,
  eventDedupeKey,
  humaniseEvent,
  type RawDemandEvent,
} from './events';
import { playbooksFor, windowFor, type Playbook } from './playbooks';
import { assessFriction, qualifiesForLowFrictionQueue, UNKNOWN_SIGNALS, type FrictionSignals } from './friction';
import { chooseStructure, estimateEconomics, meetsEconomicFloor } from './economics';

/**
 * The demand pipeline. One implementation, used by every entry point.
 *
 *   dated event discovered
 *   → verified
 *   → involved accounts resolved
 *   → playbooks matched
 *   → routes constructed
 *   → friction assessed
 *   → fulfilment checked
 *   → economics estimated
 *   → admitted, held for research, expired, or rejected
 *
 * Initial discovery, the recurring worker, a manual refresh and the re-audit
 * all call `ingestEvents` and `rebuildRoutes`. There is no second path, which
 * is the point: a fallback that skipped verification would reintroduce exactly
 * the category-template behaviour this replaces.
 */

export type IngestOutcome = {
  examined: number;
  created: number;
  updated: number;
  rejected: number;
  quarantined: number;
  rejectionReasons: string[];
};

/**
 * Writes raw events, deduplicating across sources.
 *
 * Idempotent by dedupe key: re-ingesting the same record updates `lastSeenAt`
 * and adds evidence rather than creating a second event. Two sources
 * describing one opening converge on one row, which is what makes multiple
 * independent signals raise confidence instead of inflating the board.
 */
export async function ingestEvents(params: {
  orgId: string;
  connector: string;
  events: RawDemandEvent[];
  sourceReliability?: number;
  now?: Date;
}): Promise<IngestOutcome> {
  const now = params.now ?? new Date();
  const outcome: IngestOutcome = {
    examined: params.events.length,
    created: 0,
    updated: 0,
    rejected: 0,
    quarantined: 0,
    rejectionReasons: [],
  };

  for (const raw of params.events) {
    const { key, basis } = eventDedupeKey({
      connector: params.connector,
      sourceRecordId: raw.sourceRecordId,
      naturalKey: raw.naturalKey,
      type: raw.type,
      eventDate: raw.eventDate,
      addressLine1: raw.addressLine1,
      cityName: raw.cityName,
      stateCode: raw.stateCode,
      parties: raw.parties,
    });

    const identity = assessEventIdentity({
      parties: raw.parties,
      eventDate: raw.eventDate,
      addressLine1: raw.addressLine1,
      cityName: raw.cityName,
      stateCode: raw.stateCode,
      dedupeBasis: basis,
    });

    const expiry = assessExpiry({ type: raw.type, eventDate: raw.eventDate, deadlineAt: raw.deadlineAt, now });

    const lifecycle: EventLifecycle = identity.quarantined
      ? 'QUARANTINED'
      : expiry.expired
        ? 'EXPIRED'
        : 'DISCOVERED';

    if (identity.quarantined) outcome.quarantined += 1;
    if (expiry.expired) {
      outcome.rejected += 1;
      if (expiry.reason) outcome.rejectionReasons.push(expiry.reason);
    }

    const data = {
      type: raw.type,
      lifecycle,
      connector: params.connector,
      sourceRecordId: raw.sourceRecordId,
      sourceUrl: raw.sourceUrl ?? null,
      rawPayload: raw.rawPayload as Prisma.InputJsonValue,
      // The source's date. Nothing of ours ever lands in this column.
      eventDate: raw.eventDate,
      deadlineAt: raw.deadlineAt ?? null,
      opensAt: raw.opensAt ?? null,
      completesAt: raw.completesAt ?? null,
      effectiveAt: raw.effectiveAt ?? null,
      headline: raw.headline.slice(0, 300),
      summary: raw.summary.slice(0, 4000),
      cityName: cleanCity(raw.cityName),
      stateCode: cleanState(raw.stateCode),
      postalCode: raw.postalCode ?? null,
      addressLine1: raw.addressLine1 ?? null,
      confirmedFacts: raw.confirmedFacts as Prisma.InputJsonValue,
      inferredFacts: raw.inferredFacts as Prisma.InputJsonValue,
      mentionedNames: raw.parties.map((p) => p.name),
      confidence: raw.confidence,
      sourceReliability: params.sourceReliability ?? 0.5,
      relatedCapabilities: raw.relatedCapabilities,
      expiredReason: expiry.reason,
      quarantineReason: identity.reason,
    };

    const existing = await prisma.demandEvent.findUnique({
      where: { orgId_dedupeKey: { orgId: params.orgId, dedupeKey: key } },
    });

    if (existing) {
      await prisma.demandEvent.update({
        where: { id: existing.id },
        data: {
          lastSeenAt: now,
          // A second source seeing the same event corroborates it. The event
          // date itself is never overwritten by a later, weaker record.
          confidence: Math.min(1, Math.max(existing.confidence, raw.confidence) + 0.05),
          sourceUrl: existing.sourceUrl ?? data.sourceUrl,
          deadlineAt: existing.deadlineAt ?? data.deadlineAt,
          lifecycle: existing.lifecycle === 'REJECTED' ? existing.lifecycle : lifecycle,
          expiredReason: expiry.reason,
        },
      });
      outcome.updated += 1;
      await linkEvidence(raw.evidenceId, existing.id);
      await createParties(existing.id, raw.parties);
    } else {
      const created = await prisma.demandEvent.create({ data: { orgId: params.orgId, dedupeKey: key, ...data } });
      outcome.created += 1;
      await createParties(created.id, raw.parties);
      await linkEvidence(raw.evidenceId, created.id);
    }
  }

  return outcome;
}

/**
 * Marks a staged first-party record as consumed.
 *
 * The intake connector selects on `demandEventId: null`, so without this a
 * staged row is re-read on every poll forever. Harmless while the dedupe key
 * holds, and a slow leak of work that grows with every event ever entered.
 */
async function linkEvidence(evidenceId: string | undefined, eventId: string): Promise<void> {
  if (!evidenceId) return;
  await prisma.sourceEvidence.updateMany({
    where: { id: evidenceId, demandEventId: null },
    data: { demandEventId: eventId },
  });
}

async function createParties(eventId: string, parties: RawDemandEvent['parties']): Promise<void> {
  for (const party of parties) {
    const name = party.name.trim();
    if (!name) continue;
    await prisma.demandEventParty.upsert({
      where: { eventId_role_sourceName: { eventId, role: party.role, sourceName: name } },
      create: { eventId, role: party.role, sourceName: name },
      update: {},
    });
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export type VerificationOutcome = {
  verified: number;
  expired: number;
  quarantined: number;
  failed: number;
};

/**
 * Machine verification.
 *
 * Answers only what can be answered without a person: is the date present and
 * current, is the deadline still open, is the location real, is an
 * organisation named and resolvable. Anything requiring judgement — whether
 * vendors are already selected, who signs — stays a verification question on
 * the route and is never marked verified here.
 */
export async function verifyEvents(params: { orgId: string; now?: Date }): Promise<VerificationOutcome> {
  const now = params.now ?? new Date();
  const outcome: VerificationOutcome = { verified: 0, expired: 0, quarantined: 0, failed: 0 };

  const events = await prisma.demandEvent.findMany({
    where: { orgId: params.orgId, lifecycle: { in: ['DISCOVERED', 'VERIFIED'] } },
    include: { parties: true },
  });

  for (const event of events) {
    const expiry = assessExpiry({
      type: event.type,
      eventDate: event.eventDate,
      deadlineAt: event.deadlineAt,
      now,
    });

    if (expiry.expired) {
      await prisma.demandEvent.update({
        where: { id: event.id },
        data: { lifecycle: 'EXPIRED', expiredReason: expiry.reason, lastVerifiedAt: now },
      });
      outcome.expired += 1;
      continue;
    }

    const identity = assessEventIdentity({
      parties: event.parties.map((p) => ({ role: p.role, name: p.sourceName })),
      eventDate: event.eventDate,
      addressLine1: event.addressLine1,
      cityName: event.cityName,
      stateCode: event.stateCode,
      dedupeBasis: event.dedupeKey.startsWith('nk:')
        ? 'natural'
        : event.dedupeKey.startsWith('oad:')
          ? 'org_address_date'
          : 'source_record',
    });

    if (identity.quarantined) {
      await prisma.demandEvent.update({
        where: { id: event.id },
        data: { lifecycle: 'QUARANTINED', quarantineReason: identity.reason, lastVerifiedAt: now },
      });
      outcome.quarantined += 1;
      continue;
    }

    // Everything a machine can check has passed. That is not the same as
    // somebody having confirmed it, and the enum keeps the two apart.
    await prisma.demandEvent.update({
      where: { id: event.id },
      data: {
        lifecycle: 'VERIFIED',
        verification: event.verification === 'HUMAN_VERIFIED' ? 'HUMAN_VERIFIED' : 'AUTO_VERIFIED',
        lastVerifiedAt: now,
        expiredReason: null,
        quarantineReason: null,
      },
    });
    outcome.verified += 1;
  }

  return outcome;
}

// ---------------------------------------------------------------------------
// Account resolution
// ---------------------------------------------------------------------------

/**
 * Attaches each named organisation to a company, or leaves it unattached.
 *
 * The distinctions that matter here are the ones a name alone cannot settle:
 * legal entity versus trading name, parent versus branch, brand versus
 * franchisee, project owner versus property manager, prime versus buyer. Where
 * the evidence cannot settle one, `companyId` stays null and the name is kept
 * for review. A guess here silently attaches a real event to the wrong
 * business, which is worse than an unattached event.
 */
export async function resolveEventAccounts(params: { orgId: string }): Promise<{ resolved: number; unresolved: number }> {
  const parties = await prisma.demandEventParty.findMany({
    where: { companyId: null, event: { orgId: params.orgId, lifecycle: 'VERIFIED' } },
    include: { event: true },
  });

  let resolved = 0;
  let unresolved = 0;

  for (const party of parties) {
    const event = party.event;
    const normalized = normalizeCompanyName(party.sourceName);
    if (!normalized || normalized.length < 2) {
      unresolved += 1;
      continue;
    }

    // An address match plus a name match is a location, not just a brand: it
    // separates one franchise branch from another.
    const address = normalizeAddress(
      [event.addressLine1, event.cityName, event.stateCode].filter(Boolean).join(' ') || null,
    );

    const candidates = await prisma.company.findMany({
      where: { orgId: params.orgId },
      select: { id: true, legalName: true, normalizedAddress: true, cityName: true, stateCode: true },
      take: 1000,
    });

    let match: { id: string; confidence: number; method: string } | null = null;

    for (const candidate of candidates) {
      if (normalizeCompanyName(candidate.legalName) !== normalized) continue;
      if (address && candidate.normalizedAddress && candidate.normalizedAddress === address) {
        match = { id: candidate.id, confidence: 0.95, method: 'name and address' };
        break;
      }
      if (
        event.cityName &&
        candidate.cityName &&
        candidate.cityName.toLowerCase() === event.cityName.toLowerCase() &&
        candidate.stateCode === event.stateCode
      ) {
        // Same brand in the same city with no address on either side could be
        // two branches. Recorded at a confidence that says so.
        match = { id: candidate.id, confidence: 0.7, method: 'name and city' };
      }
    }

    if (!match) {
      // No existing company. Create one from the event, because the event is
      // the reason to care about it — this is an account discovered *by*
      // demand rather than a directory entry hoping for some.
      const created = await prisma.company.create({
        data: {
          orgId: params.orgId,
          legalName: party.sourceName.slice(0, 200),
          origin: 'LIVE_DISCOVERY',
          companyRole: companyRoleFor(party.role),
          cityName: event.cityName,
          stateCode: event.stateCode,
          normalizedAddress: address,
          accountStage: 'DISCOVERED',
          locations: event.addressLine1
            ? {
                create: {
                  label: 'From demand event',
                  line1: event.addressLine1,
                  city: event.cityName,
                  state: event.stateCode,
                  postalCode: event.postalCode,
                  isHeadquarters: true,
                },
              }
            : undefined,
        },
      });
      match = { id: created.id, confidence: 0.8, method: 'created from event' };
    }

    await prisma.demandEventParty.update({
      where: { id: party.id },
      data: {
        companyId: match.id,
        resolutionConfidence: match.confidence,
        resolutionMethod: match.method,
      },
    });
    resolved += 1;
  }

  return { resolved, unresolved };
}

/**
 * The company role implied by the part a party plays in an event.
 *
 * Conservative on purpose. A property manager named on a licence record is a
 * buyer of services as far as this business is concerned, but nothing on the
 * record says whether they also supply anything, so anything unclear stays
 * UNKNOWN rather than being filed on a side of the deal it may not be on.
 */
function companyRoleFor(role: EventPartyRole): CompanyRole {
  switch (role) {
    case 'PRIME_CONTRACTOR':
      return 'PRIME_CONTRACTOR';
    case 'INCUMBENT_PROVIDER':
      return 'SUBCONTRACTOR';
    case 'BUYER':
    case 'PROPERTY_MANAGER':
    case 'PROPERTY_OWNER':
      return 'BUYER';
    default:
      return 'UNKNOWN';
  }
}

// ---------------------------------------------------------------------------
// Route construction
// ---------------------------------------------------------------------------

export type RouteBuildOutcome = {
  eventsConsidered: number;
  routesCreated: number;
  routesUpdated: number;
  routesExpired: number;
  skipped: Array<{ event: string; playbook: string; because: string }>;
  byRoute: Record<string, number>;
  byTier: Record<string, number>;
  byFriction: Record<string, number>;
  lowFrictionQueue: number;
};

/**
 * Turns verified events into commercial routes.
 *
 * One event can support several: a gym opening produces a pre-opening clean
 * and a recurring contract (brokerage), and an opening stock order and a
 * replenishment conversation (distribution). It produces a subcontracting
 * route only when a prime contractor or an explicit capacity request is in the
 * evidence — a playbook whose required evidence is absent does not fire, and
 * the reason is recorded rather than silently dropped.
 */
export async function rebuildRoutes(params: { orgId: string; now?: Date }): Promise<RouteBuildOutcome> {
  const now = params.now ?? new Date();
  const outcome: RouteBuildOutcome = {
    eventsConsidered: 0,
    routesCreated: 0,
    routesUpdated: 0,
    routesExpired: 0,
    skipped: [],
    byRoute: {},
    byTier: {},
    byFriction: {},
    lowFrictionQueue: 0,
  };

  const [events, paths, providerIndex, catalogue] = await Promise.all([
    prisma.demandEvent.findMany({
      where: { orgId: params.orgId, lifecycle: { in: ['VERIFIED', 'EXPIRED'] } },
      include: { parties: { include: { company: { include: { contacts: true } } } } },
    }),
    getActivePaths(params.orgId),
    buildProviderIndex(params.orgId),
    prisma.capability.findMany({ where: { orgId: params.orgId }, select: { name: true } }),
  ]);

  const capabilityNames = catalogue.map((c) => c.name);

  for (const event of events) {
    outcome.eventsConsidered += 1;

    // An expired event keeps its routes but they stop being work.
    if (event.lifecycle === 'EXPIRED') {
      const updated = await prisma.routeHypothesis.updateMany({
        where: { eventId: event.id, status: { not: 'EXPIRED' } },
        data: { status: 'EXPIRED', statusReason: event.expiredReason ?? 'the underlying event expired' },
      });
      outcome.routesExpired += updated.count;
      continue;
    }

    const playbooks = playbooksFor(event.type);
    if (playbooks.length === 0) {
      outcome.skipped.push({
        event: event.headline,
        playbook: '—',
        because: `no playbook covers ${humaniseEvent(event.type)}`,
      });
      continue;
    }

    for (const playbook of playbooks) {
      const decision = evaluatePlaybook({ event, playbook, now });
      if (!decision.applies) {
        outcome.skipped.push({ event: event.headline, playbook: playbook.key, because: decision.because });
        continue;
      }

      const account = decision.account;
      if (!account) {
        outcome.skipped.push({
          event: event.headline,
          playbook: playbook.key,
          because: 'no resolved account fills the buying role this route needs',
        });
        continue;
      }

      const tier = assertTierEligibility({
        type: event.type,
        eventDate: event.eventDate,
        sourceUrl: event.sourceUrl,
        sourceRecordId: event.sourceRecordId,
        // We hold the intake row itself, so it needs no external link.
        isFirstParty: event.connector === 'inbound_intake',
        deadlineAt: event.deadlineAt,
        now,
      });

      const friction = assessFriction({
        signals: decision.frictionSignals,
        playbook,
        humanMinutes: playbook.typicalHumanMinutes,
      });

      const capabilityMatch = matchCapability(playbook.requiredCapability, capabilityNames);
      const providers = providersFor(providerIndex, playbook.requiredCapability, event.stateCode);
      const fulfilment = describeFulfilment(providers, providerIndex, capabilityMatch.capability);

      const economics = estimateEconomics({
        playbook,
        scaleHint: decision.scaleHint,
        availableProviders: providers,
        friction: friction.level,
      });

      const structure = chooseStructure({
        route: playbook.route,
        primeHoldsWork: playbook.route === 'SUBCONTRACTING',
        canContractWithBuyer: true,
        involvesGoods: playbook.route === 'DISTRIBUTION',
        friction: friction.level,
        grossProfit: economics.grossProfit,
        blockingCompliance: null,
      });

      const window = windowFor(playbook, event.eventDate);
      const floor = meetsEconomicFloor({
        grossProfit: economics.grossProfit,
        humanMinutes: economics.humanMinutes,
        minimumProfitPerHour: 150,
      });

      const status = decideStatus({
        tier: tier.tier,
        fulfilment,
        friction: friction.level,
        economicsPass: floor.passes,
        windowClosed: window ? window.closesAt.getTime() < now.getTime() : false,
      });

      const missing = collectMissing({ event, playbook, account, fulfilment, friction: friction.level, tier });

      const path = paths.find((p) => p.key.toUpperCase() === playbook.route) ?? null;

      const record = {
        orgId: params.orgId,
        route: playbook.route,
        playbookKey: playbook.key,
        pathId: path?.id ?? null,
        headline: `${playbook.label} — ${account.legalName}`,
        rationale: decision.rationale,
        tier: tier.tier,
        friction: friction.level,
        frictionReason: friction.reason,
        frictionFactors: friction.factors as unknown as Prisma.InputJsonValue,
        // Only an inbound request or an explicit solicitation is a stated need.
        // Everything a playbook concludes from an opening is ours.
        needIsConfirmed: decision.needIsConfirmed,
        requiredCapability: playbook.requiredCapability,
        buyerRole: decision.buyerRole,
        buyingWindow: window ? describeWindow(window, now) : 'UNKNOWN',
        windowOpensAt: window?.opensAt ?? null,
        windowClosesAt: window?.closesAt ?? null,
        fulfilmentStatus: fulfilment.status,
        providerCount: providers,
        estimatedBuyerPrice: economics.buyerPrice,
        estimatedProviderCost: economics.providerCost,
        estimatedGrossProfit: economics.grossProfit,
        estimatedHumanMinutes: economics.humanMinutes,
        economicsBasis: economics.basis,
        commercialStructure: structure.structure,
        structureReason: structure.reason,
        status: status.status,
        statusReason: status.reason,
        missingInfo: missing,
        nextAction: nextActionFor({ playbook, fulfilment, friction: friction.level, missing, status: status.status }),
        nextActionBy: window?.closesAt ?? event.deadlineAt ?? null,
      };

      const existing = await prisma.routeHypothesis.findUnique({
        where: {
          eventId_companyId_playbookKey: {
            eventId: event.id,
            companyId: account.id,
            playbookKey: playbook.key,
          },
        },
      });

      if (existing) {
        await prisma.routeHypothesis.update({ where: { id: existing.id }, data: record });
        outcome.routesUpdated += 1;
      } else {
        await prisma.routeHypothesis.create({
          data: { ...record, eventId: event.id, companyId: account.id },
        });
        outcome.routesCreated += 1;
      }

      outcome.byRoute[playbook.route] = (outcome.byRoute[playbook.route] ?? 0) + 1;
      outcome.byTier[tier.tier] = (outcome.byTier[tier.tier] ?? 0) + 1;
      outcome.byFriction[friction.level] = (outcome.byFriction[friction.level] ?? 0) + 1;
      if (qualifiesForLowFrictionQueue(friction.level) && status.status !== 'EXPIRED') {
        outcome.lowFrictionQueue += 1;
      }
    }
  }

  return outcome;
}

type EventWithParties = DemandEvent & {
  parties: Array<{
    role: EventPartyRole;
    sourceName: string;
    resolutionConfidence: number;
    company: ({ id: string; legalName: string; contacts: Array<{ phone: string | null; email: string | null; isDecisionMaker: boolean }> } & Record<string, unknown>) | null;
  }>;
};

type PlaybookDecision =
  | { applies: false; because: string }
  | {
      applies: true;
      account: { id: string; legalName: string } | null;
      rationale: string;
      needIsConfirmed: boolean;
      buyerRole: EventPartyRole;
      frictionSignals: FrictionSignals;
      scaleHint: number | null;
    };

/**
 * Whether a playbook fires for this event, and why.
 *
 * The required-evidence check is the guard that stops the engine drifting back
 * into category templating. A subcontracting playbook needs a named prime and
 * a stated capacity requirement; without them it does not fire, however much
 * the event looks adjacent.
 */
export function evaluatePlaybook(input: {
  event: EventWithParties;
  playbook: Playbook;
  now: Date;
}): PlaybookDecision {
  const { event, playbook } = input;

  if (!event.eventDate) {
    return { applies: false, because: 'the source published no event date, so no window can be established' };
  }

  // The account this route would be for: the first resolved party holding a
  // role the playbook buys from.
  const buyingParty =
    playbook.likelyBuyerRoles
      .map((role) => event.parties.find((p) => p.role === role && p.company))
      .find(Boolean) ?? null;

  if (!buyingParty?.company) {
    return {
      applies: false,
      because: `no resolved ${playbook.likelyBuyerRoles.join(' or ').toLowerCase()} on this event`,
    };
  }

  // Subcontracting demands evidence that somebody else holds the work. A
  // contract award on its own does not establish that they need capacity.
  if (playbook.route === 'SUBCONTRACTING') {
    const prime = event.parties.find((p) => p.role === 'PRIME_CONTRACTOR');
    if (!prime) {
      return { applies: false, because: 'no prime contractor is named, so there is no one to subcontract from' };
    }
    const requestsCapacity =
      event.type === 'SUBCONTRACTOR_REQUEST' ||
      event.type === 'STAFFING_OR_CAPACITY_GAP' ||
      event.type === 'VENDOR_REQUEST' ||
      event.type === 'INBOUND_REQUEST';
    if (!requestsCapacity) {
      return {
        applies: false,
        because:
          'the event names a prime but contains no request for local capacity — an award is not an open ' +
          'subcontracting job',
      };
    }
  }

  const confirmed = (event.confirmedFacts as unknown as string[]) ?? [];
  const haystack = [event.summary, event.headline, ...confirmed].join(' ').toLowerCase();

  const scaleHint = extractScale(event.rawPayload as Record<string, unknown>);

  // A need is stated only when a party asked. An opening implies a need; it
  // does not assert one, and the difference is the whole discipline here.
  const needIsConfirmed =
    event.type === 'INBOUND_REQUEST' ||
    event.type === 'ACTIVE_RFP' ||
    event.type === 'ACTIVE_RFQ' ||
    event.type === 'VENDOR_REQUEST' ||
    event.type === 'SUBCONTRACTOR_REQUEST' ||
    event.type === 'PROCUREMENT_NOTICE';

  const rationale = needIsConfirmed
    ? `${humaniseEvent(event.type)} on ${event.eventDate.toISOString().slice(0, 10)} states this requirement directly. ` +
      `${playbook.label} is the route that answers it.`
    : `${humaniseEvent(event.type)} on ${event.eventDate.toISOString().slice(0, 10)} at ${event.addressLine1 ?? event.cityName ?? 'this location'}. ` +
      `Our inference, not their statement: an event of this kind usually creates ${playbook.label.toLowerCase()} work ` +
      `in the window ${playbook.window.reason.toLowerCase()}`;

  return {
    applies: true,
    account: { id: buyingParty.company.id, legalName: buyingParty.company.legalName },
    rationale,
    needIsConfirmed,
    buyerRole: buyingParty.role,
    frictionSignals: deriveFrictionSignals({ event, playbook, haystack, buyingParty }),
    scaleHint,
  };
}

/**
 * Friction signals read from the event, leaving unknown what is unknown.
 *
 * Most of these cannot be answered from a licence record, and that is the
 * point: the assessment comes back UNKNOWN_RESEARCH_REQUIRED and the route
 * carries a research action rather than appearing in the low-friction queue on
 * the strength of nothing having been found.
 */
function deriveFrictionSignals(input: {
  event: EventWithParties;
  playbook: Playbook;
  haystack: string;
  buyingParty: EventWithParties['parties'][number];
}): FrictionSignals {
  const { event, playbook, haystack, buyingParty } = input;
  const signals: FrictionSignals = { ...UNKNOWN_SIGNALS };

  // --- Known from the playbook ------------------------------------------
  signals.oneTimeTransaction = [
    'cleaning.brokerage.pre_opening',
    'cleaning.brokerage.turnover',
    'cleaning.distribution.initial_stock',
  ].includes(playbook.key);
  signals.standardScope = !playbook.key.includes('solicitation');
  // Recurring cleaning happens after hours and needs keys or codes. A one-off
  // clean before opening, or a box of consumables, does not.
  signals.sensitiveAccess = playbook.key === 'cleaning.brokerage.recurring';

  // --- Known from the event type ----------------------------------------
  //
  // A private business getting a city licence is not running a procurement
  // process. Saying so is a real answer, not an assumption: procurement is a
  // property of the *event*, and a licence issuance is not one.
  signals.formalProcurement =
    event.type === 'ACTIVE_RFP' || event.type === 'PROCUREMENT_NOTICE' || event.type === 'ACTIVE_RFQ';
  signals.vendorOnboarding = signals.formalProcurement;

  // Nobody has an incumbent cleaner at premises that have not opened. This is
  // the single most useful thing an opening event tells us about friction.
  const isNewPremises =
    event.type === 'OCCUPANCY_OR_OPERATING_APPROVAL' ||
    event.type === 'NEW_LOCATION' ||
    event.type === 'FACILITY_OPENING' ||
    event.type === 'NEW_LEASE';
  if (event.parties.some((p) => p.role === 'INCUMBENT_PROVIDER')) {
    signals.incumbentPresent = true;
  } else if (isNewPremises && event.eventDate && event.eventDate.getTime() >= Date.now() - 30 * 86_400_000) {
    signals.incumbentPresent = false;
  }

  // --- Known from the text ----------------------------------------------
  //
  // Franchise and enterprise markers appear in the legal name far more often
  // than in a description, so both are searched.
  const names = event.parties.map((p) => p.sourceName).join(' ');
  const corpus = `${haystack} ${names}`.toLowerCase();
  if (/franchis|corporate office|national account|head office|holdings? (llc|inc|lp)|group inc|trust\b/i.test(corpus)) {
    signals.chainOrEnterpriseControl = true;
    // A chain decides centrally by definition.
    signals.localPurchasingAuthority = false;
  } else if (isNewPremises) {
    // A single new licence with no chain markers is as close as a public
    // record gets to "independent operator". Still an inference, and it is
    // recorded as one — but it is a better answer than refusing to have one.
    signals.chainOrEnterpriseControl = false;
    signals.localPurchasingAuthority = true;
  }

  if (/insurance|bond|certificat|w-?9|\bcoi\b/i.test(corpus)) {
    signals.heavyCompliance = true;
  } else if (!signals.formalProcurement) {
    // Standard commercial cleaning needs ordinary liability cover, which every
    // provider already carries. Nothing here is beyond the ordinary.
    signals.heavyCompliance = false;
  }
  if (/vendor registration|supplier portal|onboard/i.test(corpus)) signals.vendorOnboarding = true;

  // --- Known from what we hold ------------------------------------------
  //
  // No contact is a definite "not reachable yet", not an unknown: it is the
  // reason the route carries a research task.
  const contacts = buyingParty.company?.contacts ?? [];
  signals.buyerReachable = contacts.some((c) => c.phone || c.email);

  return signals;
}

function extractScale(payload: Record<string, unknown>): number | null {
  for (const key of ['total_new_add_sqft', 'square_feet', 'sqft', 'estimated_cost', 'valuation']) {
    const raw = payload[key];
    const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.replace(/[^0-9.]/g, '')) : NaN;
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

type Fulfilment = { status: string; note: string };

function describeFulfilment(providers: number, index: ProviderIndex, matched: string | null): Fulfilment {
  if (providers > 0) {
    return {
      status: 'AVAILABLE',
      note: `${providers.toFixed(2).replace(/\.00$/, '')} provider(s) hold ${matched ?? 'this capability'} within reach.`,
    };
  }
  if (index.total === 0) {
    return {
      status: 'UNKNOWN',
      note: 'The provider network is empty, so fulfilment cannot be assessed at all yet.',
    };
  }
  return {
    status: 'UNAVAILABLE',
    note: 'No provider in the network holds this capability in this state. The demand stands; the supply does not exist yet.',
  };
}

/**
 * Where a route sits.
 *
 * Missing fulfilment blocks serious pursuit without destroying the demand —
 * the event stays, the sourcing task appears, and if nobody is found before
 * the window closes the route expires with a named reason.
 */
function decideStatus(input: {
  tier: LeadTier;
  fulfilment: Fulfilment;
  friction: FrictionLevel;
  economicsPass: boolean;
  windowClosed: boolean;
}): { status: string; reason: string } {
  if (input.windowClosed) {
    return { status: 'EXPIRED', reason: 'The buying window for this route has closed.' };
  }
  if (input.tier === 'DIRECTORY_PROSPECT' || input.tier === 'REJECTED') {
    return { status: 'COLD', reason: 'No dated demand evidence behind this route.' };
  }
  if (input.fulfilment.status !== 'AVAILABLE') {
    return {
      status: 'BLOCKED_ON_SUPPLY',
      reason: `${input.fulfilment.note} Held out of serious pursuit until a provider exists, and kept until the window closes.`,
    };
  }
  if (input.friction === 'UNKNOWN_RESEARCH_REQUIRED') {
    return {
      status: 'RESEARCH',
      reason: 'Demand and supply are both real; how hard the relationship will be is not yet known.',
    };
  }
  if (!input.economicsPass) {
    return { status: 'RESEARCH', reason: 'Economics cannot yet be estimated well enough to commit attention.' };
  }
  return { status: 'PURSUE', reason: 'Dated demand, a provider who can deliver, and a known relationship cost.' };
}

function collectMissing(input: {
  event: EventWithParties;
  playbook: Playbook;
  account: { id: string; legalName: string };
  fulfilment: Fulfilment;
  friction: FrictionLevel;
  tier: { tier: LeadTier; blockedBy: string | null };
}): string[] {
  const missing: string[] = [];
  if (input.tier.blockedBy) missing.push(input.tier.blockedBy);
  if (input.friction === 'UNKNOWN_RESEARCH_REQUIRED') missing.push('relationship friction is unassessed');
  if (input.fulfilment.status !== 'AVAILABLE') missing.push('a provider who can deliver this');
  const party = input.event.parties.find((p) => p.company?.id === input.account.id);
  if (!party?.company?.contacts.some((c) => c.phone || c.email)) missing.push('any contact route to the buyer');
  if (!party?.company?.contacts.some((c) => c.isDecisionMaker)) missing.push('a named decision-maker');
  return missing;
}

function nextActionFor(input: {
  playbook: Playbook;
  fulfilment: Fulfilment;
  friction: FrictionLevel;
  missing: string[];
  status: string;
}): string {
  if (input.status === 'EXPIRED') return 'Close this route — the window has passed.';
  if (input.fulfilment.status !== 'AVAILABLE') {
    return `Source a provider for ${input.playbook.requiredCapability.toLowerCase()} in this market before approaching the buyer.`;
  }
  if (input.missing.includes('any contact route to the buyer')) {
    return 'Find a contact route to the buying organisation. Nothing can be worked until somebody can be reached.';
  }
  if (input.friction === 'UNKNOWN_RESEARCH_REQUIRED') {
    return `Research call: ${input.playbook.verificationQuestions[0]}`;
  }
  return input.playbook.firstAction;
}

function describeWindow(window: { opensAt: Date; closesAt: Date }, now: Date): string {
  const day = 86_400_000;
  const opensIn = Math.round((window.opensAt.getTime() - now.getTime()) / day);
  const closesIn = Math.round((window.closesAt.getTime() - now.getTime()) / day);
  if (closesIn < 0) return 'CLOSED';
  if (opensIn > 0) return `OPENS_IN_${opensIn}_DAYS`;
  if (closesIn <= 7) return 'WITHIN_7_DAYS';
  if (closesIn <= 30) return 'WITHIN_30_DAYS';
  return 'ACTIVE_NOW';
}

// ---------------------------------------------------------------------------
// The whole pipeline
// ---------------------------------------------------------------------------

export type PipelineResult = {
  verification: VerificationOutcome;
  resolution: { resolved: number; unresolved: number };
  routes: RouteBuildOutcome;
};

/**
 * Verify, resolve, route. The steps after ingestion, in order.
 *
 * Called by the recurring worker, by a manual refresh and by the re-audit, so
 * there is exactly one definition of what the pipeline does.
 */
export async function runDemandPipeline(params: {
  orgId: string;
  userId?: string;
  now?: Date;
}): Promise<PipelineResult> {
  const verification = await verifyEvents({ orgId: params.orgId, now: params.now });
  const resolution = await resolveEventAccounts({ orgId: params.orgId });
  const routes = await rebuildRoutes({ orgId: params.orgId, now: params.now });

  if (params.userId) {
    await audit({
      orgId: params.orgId,
      userId: params.userId,
      action: 'demand.pipeline_run',
      entityType: 'Organization',
      entityId: params.orgId,
      metadata: {
        verified: verification.verified,
        expired: verification.expired,
        quarantined: verification.quarantined,
        accountsResolved: resolution.resolved,
        routesCreated: routes.routesCreated,
        routesUpdated: routes.routesUpdated,
        byRoute: routes.byRoute,
        byTier: routes.byTier,
        byFriction: routes.byFriction,
        lowFriction: routes.lowFrictionQueue,
      },
    });
  }

  return { verification, resolution, routes };
}

export { normalizePhone };
