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
import { compete } from './competition';
import { assessFriction, qualifiesForLowFrictionQueue, UNKNOWN_SIGNALS, type FrictionSignals } from './friction';
import { chooseStructure, estimateEconomics, meetsEconomicFloor } from './economics';
import { assessFulfilment, loadProviders, type FulfilmentAssessment, type ProviderCandidate } from './fulfilment';
import {
  assessCompliance,
  assessCounterpartyRisk,
  assessPaymentRisk,
  assessWorkingCapital,
  riskBlocksPursuit,
} from './risk';
import { buildThesis } from './thesis';
import { recordOutcome, recordPipelineMilestones } from './performance';
import { discoveryClaims } from '@/lib/evidence/discoveryClaims';
import { recordEngineClaims } from '@/lib/evidence/ledger';
import { scheduleContactResolution } from '@/lib/enrichment/schedule';
import { enqueue } from '@/lib/jobs/queue';

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
      // The top of the chain. Counted here so a source's record volume can
      // always be compared against what it eventually produced.
      await recordOutcome({
        orgId: params.orgId,
        connector: params.connector,
        eventId: created.id,
        stage: 'DEMAND_EVENT',
      });
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
    let nameOnly: { id: string } | null = null;

    for (const candidate of candidates) {
      if (normalizeCompanyName(candidate.legalName) !== normalized) continue;
      // Remembered separately: a name that matches with nothing corroborating
      // it is still the same row as far as the database is concerned, and
      // creating a second is impossible. What varies is how much we believe it.
      nameOnly ??= { id: candidate.id };

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

    // The name matches and nothing corroborates it. Attaching at a confidence
    // that says so is better than both alternatives: creating would violate
    // the one-name-per-org constraint, and claiming a strong match would let
    // an unverified identity through the risk model as verified.
    if (!match && nameOnly) {
      match = { id: nameOnly.id, confidence: 0.5, method: 'name only — location not corroborated' };
    }

    if (!match) {
      // No existing company. Create one from the event, because the event is
      // the reason to care about it — this is an account discovered *by*
      // demand rather than a directory entry hoping for some.
      const created = await createCompanyForEvent({
        orgId: params.orgId,
        legalName: party.sourceName.slice(0, 200),
        role: companyRoleFor(party.role),
        event,
        address,
      });
      if (!created) {
        unresolved += 1;
        continue;
      }
      match = { id: created.id, confidence: 0.8, method: 'created from event' };
    }

    if (!match) {
      unresolved += 1;
      continue;
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
/**
 * Creates the account an event named, tolerating a concurrent creation.
 *
 * Two workers polling different sources can both discover the same business in
 * the same second. One loses the unique-name constraint, and losing it is not
 * an error — the row it wanted now exists, so it looks it up rather than
 * failing the whole run over a race it does not care about.
 */
async function createCompanyForEvent(params: {
  orgId: string;
  legalName: string;
  role: CompanyRole;
  event: { cityName: string | null; stateCode: string | null; addressLine1: string | null; postalCode: string | null };
  address: string | null;
}): Promise<{ id: string } | null> {
  try {
    return await prisma.company.create({
      data: {
        orgId: params.orgId,
        legalName: params.legalName,
        origin: 'LIVE_DISCOVERY',
        companyRole: params.role,
        cityName: params.event.cityName,
        stateCode: params.event.stateCode,
        normalizedAddress: params.address,
        accountStage: 'DISCOVERED',
        locations: params.event.addressLine1
          ? {
              create: {
                label: 'From demand event',
                line1: params.event.addressLine1,
                city: params.event.cityName,
                state: params.event.stateCode,
                postalCode: params.event.postalCode,
                isHeadquarters: true,
              },
            }
          : undefined,
      },
      select: { id: true },
    });
  } catch {
    return prisma.company.findFirst({
      where: { orgId: params.orgId, legalName: params.legalName },
      select: { id: true },
    });
  }
}

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
  /** Claims written to the ledger, and disagreements the rebuild uncovered. */
  claimsRecorded: number;
  claimsContradicted: number;
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
    claimsRecorded: 0,
    claimsContradicted: 0,
  };

  const [events, paths, providerIndex, catalogue, providers] = await Promise.all([
    prisma.demandEvent.findMany({
      where: { orgId: params.orgId, lifecycle: { in: ['VERIFIED', 'EXPIRED'] } },
      include: { parties: { include: { company: { include: { contacts: true } } } } },
    }),
    getActivePaths(params.orgId),
    buildProviderIndex(params.orgId),
    prisma.capability.findMany({ where: { orgId: params.orgId }, select: { name: true } }),
    // Loaded once: a fulfilment check per route would be hundreds of round
    // trips for a set that does not change during the run.
    loadProviders(params.orgId),
  ]);

  const capabilityNames = catalogue.map((c) => c.name);
  // Gathered as routes are written so the source-to-profit chain starts full
  // rather than being reconstructed later, when attribution is impossible.
  const milestones: Parameters<typeof recordPipelineMilestones>[0]['routes'] = [];

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

    // ---- one event, one primary reading ---------------------------------
    //
    // This used to be `for (const playbook of playbooks)`, creating a route for
    // every playbook that matched. That is how two events became 54 routes and
    // a board that looked like a business turned out to be two phone calls.
    // Every applicable reading now states its case, the cases are scored
    // against the same six questions, and one wins.
    // Narrowed to the applying branch, so everything downstream keeps the fields
    // an applicable decision carries without re-checking `applies` at each one.
    type Applied = Extract<PlaybookDecision, { applies: true }>;
    const applicable: Array<{ playbook: Playbook; decision: Applied }> = [];
    for (const playbook of playbooks) {
      const decision = evaluatePlaybook({ event, playbook, now });
      if (!decision.applies) {
        outcome.skipped.push({ event: event.headline, playbook: playbook.key, because: decision.because });
        continue;
      }
      if (!decision.account) {
        outcome.skipped.push({
          event: event.headline,
          playbook: playbook.key,
          because: 'no resolved account fills the buying role this route needs',
        });
        continue;
      }
      applicable.push({ playbook, decision: decision as Applied });
    }

    const competition = compete({
      eventType: event.type,
      candidates: applicable.map(({ playbook, decision }) => ({
        playbook,
        confirmedFacts: factStrings(event.confirmedFacts),
        inferredFacts: factStrings(event.inferredFacts),
        // Scored before a winner is chosen, because supply feasibility is one
        // of the things that decides which reading is credible at all.
        providerCount: assessFulfilment({
          requiredCapability: playbook.requiredCapability,
          stateCode: event.stateCode,
          cityName: event.cityName,
          neededBy: event.deadlineAt ?? null,
          providers,
          now,
        }).matched.length,
        buyerIdentified: Boolean(decision.account),
        insideWindow: windowFor(playbook, event.eventDate) !== null,
        headline: event.headline,
        scopeText: typeof (event.rawPayload as Record<string, unknown>)?.__scope === 'string'
          ? ((event.rawPayload as Record<string, unknown>).__scope as string)
          : null,
      })),
    });

    // The decision is recorded whether or not anything won, because a silent
    // refusal is an unusable decision — an operator seeing nothing on the board
    // has to be able to find out that a reading was considered and rejected.
    await prisma.demandEvent.update({
      where: { id: event.id },
      data: { competition: competition as unknown as Prisma.InputJsonValue },
    }).catch(() => {
      // A diagnostic write must never take the ingest down with it.
    });

    if (!competition.primary) {
      outcome.skipped.push({
        event: event.headline,
        playbook: applicable[0]?.playbook.key ?? '—',
        because: competition.verdict,
      });
      continue;
    }

    const winner = applicable.find((a) => a.playbook.key === competition.primary!.playbookKey);
    // Alternatives are kept on the event above and deliberately not queued.
    for (const alternative of competition.alternatives) {
      outcome.skipped.push({
        event: event.headline,
        playbook: alternative.playbookKey,
        because: `Kept as a secondary hypothesis, not queued. ${alternative.lostBecause ?? ''}`.trim(),
      });
    }

    for (const { playbook, decision } of winner ? [winner] : []) {
      const account = decision.account;
      if (!account) continue;

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

      const window = windowFor(playbook, event.eventDate);

      // Six checks rather than a count: capability, geography, capacity,
      // credentials, pricing and timing are different questions, and a gap in
      // one names itself instead of collapsing into "no provider".
      const fulfilment = assessFulfilment({
        requiredCapability: playbook.requiredCapability,
        stateCode: event.stateCode,
        cityName: event.cityName,
        neededBy: window?.closesAt ?? event.deadlineAt ?? null,
        providers,
        now,
      });
      const providerCount = fulfilment.matched.length;

      const economics = estimateEconomics({
        playbook,
        scaleHint: decision.scaleHint,
        availableProviders: providerCount,
        friction: friction.level,
      });

      const compliance = assessCompliance({
        playbook,
        satisfied: fulfilment.matched.some((m) => m.hasInsurance) ? ['insurance'] : [],
        knownBlockers: [],
        providerInsured: fulfilment.matched.length > 0 ? fulfilment.matched.some((m) => m.hasInsurance) : null,
      });

      const structure = chooseStructure({
        route: playbook.route,
        // Subcontracting means somebody else holds the customer contract. That
        // is a fact about the event, not about which playbook fired.
        primeHoldsWork: decision.primeHoldsWork,
        canContractWithBuyer: true,
        involvesGoods: playbook.route === 'DISTRIBUTION',
        friction: friction.level,
        // The pessimistic end. Choosing to carry delivery risk on the strength
        // of the optimistic reading of a category prior is exactly the decision
        // this product should never make for somebody.
        grossProfit: economics.grossProfit?.low ?? null,
        blockingCompliance: compliance.status === 'STRUCTURALLY_UNQUALIFIED' ? compliance.gaps[0] : null,
      });

      const capital = assessWorkingCapital({
        structure: structure.structure,
        // The high end: working capital exposure is the number where being
        // wrong in the optimistic direction costs money.
        providerCost: economics.providerCost?.high ?? null,
        buyerPaymentDays: null,
        supplierTermsDays: null,
        depositPct: null,
      });

      const paymentRisk = assessPaymentRisk({
        isPublicSector: decision.isPublicSector,
        hasPaidBefore: null,
        isNewlyEstablished: decision.isNewlyEstablished,
        statedTermsDays: null,
        exposure: capital.maxCashExposure,
      });

      const counterpartyRisk = assessCounterpartyRisk({
        // Resolved against a licence, permit or award record, which is a
        // public record naming them at this address.
        identityVerified: decision.identityVerified,
        scopeIsClear: decision.needIsConfirmed ? true : null,
        knownDisputes: null,
        reachable: decision.frictionSignals.buyerReachable,
      });

      const riskBlock = riskBlocksPursuit({
        paymentRisk: paymentRisk.level,
        counterpartyRisk: counterpartyRisk.level,
        maxCashExposure: capital.maxCashExposure,
      });

      const floor = meetsEconomicFloor({
        // The floor is a question about whether this is worth somebody's
        // morning, so it is asked of the pessimistic end.
        grossProfit: economics.grossProfit?.low ?? null,
        humanMinutes: economics.humanMinutes,
        minimumProfitPerHour: 150,
      });

      const status = decideStatus({
        tier: tier.tier,
        fulfilment,
        friction: friction.level,
        economicsPass: floor.passes,
        windowClosed: window ? window.closesAt.getTime() < now.getTime() : false,
        complianceBlocks: compliance.blocksPursuit,
        complianceReason: compliance.reason,
        riskBlocks: riskBlock.blocks,
        riskReason: riskBlock.reason,
      });

      const missing = collectMissing({
        event,
        playbook,
        account,
        fulfilment,
        friction: friction.level,
        tier,
        paymentRisk: paymentRisk.level,
        counterpartyRisk: counterpartyRisk.level,
        compliance,
      });

      const nextAction = nextActionFor({
        playbook,
        fulfilment,
        friction: friction.level,
        missing,
        status: status.status,
      });

      const path = paths.find((p) => p.key.toUpperCase() === playbook.route) ?? null;

      const record = {
        orgId: params.orgId,
        // A route is about the same world as the event that produced it.
        // Without this the record defaulted to PRODUCTION and the isolation
        // trigger refused every route built from a practice event — which
        // meant the sandbox could never exercise the real pipeline, and every
        // "end to end" proof had to go around the thing it was proving.
        dataMode: event.dataMode,
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
        fulfilmentReason: fulfilment.reason,
        matchedProviderIds: fulfilment.matched.slice(0, 5).map((m) => m.id),
        providerCount: providerCount,
        estimatedBuyerPrice: economics.buyerPrice?.midpoint ?? null,
        estimatedBuyerPriceLow: economics.buyerPrice?.low ?? null,
        estimatedBuyerPriceHigh: economics.buyerPrice?.high ?? null,
        estimatedProviderCost: economics.providerCost?.midpoint ?? null,
        estimatedProviderCostLow: economics.providerCost?.low ?? null,
        estimatedProviderCostHigh: economics.providerCost?.high ?? null,
        estimatedGrossProfit: economics.grossProfit?.midpoint ?? null,
        estimatedGrossProfitLow: economics.grossProfit?.low ?? null,
        estimatedGrossProfitHigh: economics.grossProfit?.high ?? null,
        estimatedHumanMinutes: economics.humanMinutes,
        economicsBasis: economics.basis,
        economicsInputs: economics.buyerPrice?.inputs ?? [],
        commercialStructure: structure.structure,
        structureReason: structure.reason,
        status: status.status,
        statusReason: status.reason,
        missingInfo: missing,
        nextAction,
        nextActionBy: window?.closesAt ?? event.deadlineAt ?? null,

        maxCashExposure: capital.maxCashExposure,
        daysCapitalExposed: capital.daysExposed,
        paymentRisk: paymentRisk.level,
        counterpartyRisk: counterpartyRisk.level,
        complianceStatus: compliance.status,
        complianceGaps: compliance.gaps,
        riskNotes: [
          { kind: 'workingCapital', note: capital.reason },
          { kind: 'paymentRisk', note: paymentRisk.reason, toResolve: paymentRisk.toResolve },
          { kind: 'counterpartyRisk', note: counterpartyRisk.reason, toResolve: counterpartyRisk.toResolve },
          { kind: 'compliance', note: compliance.reason },
        ] as unknown as Prisma.InputJsonValue,

        // Written for the person about to pick up the phone. Every tier A and
        // B route carries one; the board reports any part that is missing.
        thesis: buildThesis({
          organisation: account.legalName,
          location: [event.cityName, event.stateCode].filter(Boolean).join(', ') || null,
          eventType: event.type,
          eventDate: event.eventDate,
          confirmedFacts: (event.confirmedFacts as unknown as string[]) ?? [],
          playbook,
          tier: tier.tier,
          tierReason: tier.reason,
          needIsConfirmed: decision.needIsConfirmed,
          friction: friction.level,
          frictionReason: friction.reason,
          fulfilmentStatus: fulfilment.status,
          fulfilmentReason: fulfilment.reason,
          buyingWindow: window ? describeWindow(window, now) : 'UNKNOWN',
          windowClosesAt: window?.closesAt ?? null,
          grossProfit: economics.grossProfit?.low ?? null,
          grossProfitHigh: economics.grossProfit?.high ?? null,
          humanMinutes: economics.humanMinutes,
          economicsBasis: economics.basis,
          paymentRisk: paymentRisk.level,
          counterpartyRisk: counterpartyRisk.level,
          complianceGaps: compliance.gaps,
          missingInfo: missing,
          nextAction,
          now,
        }) as unknown as Prisma.InputJsonValue,
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

      const saved = existing
        ? await prisma.routeHypothesis.update({ where: { id: existing.id }, data: record })
        : await prisma.routeHypothesis.create({ data: { ...record, eventId: event.id, companyId: account.id } });
      if (existing) outcome.routesUpdated += 1;
      else outcome.routesCreated += 1;

      // What this route claims, and what each claim rests on.
      //
      // The columns above hold the current reading; this holds its provenance.
      // Written on every pass, and yielding on every key a person has already
      // established — a nightly rebuild must not overwrite what a caller
      // learned with the category prior it started from.
      //
      // Failures are swallowed deliberately. A malformed claim is a defect
      // worth fixing and is never worth losing a route over, and the pipeline
      // processes hundreds of events per run.
      try {
        const written = await recordEngineClaims({
          orgId: params.orgId,
          routeId: saved.id,
          claims: discoveryClaims({
            routeId: saved.id,
            companyId: account.id,
            organisation: account.legalName,
            event: {
              type: event.type,
              headline: event.headline,
              sourceUrl: event.sourceUrl,
              connector: event.connector,
              eventDate: event.eventDate,
            },
            playbook: { key: playbook.key, label: playbook.label, route: playbook.route },
            needIsConfirmed: decision.needIsConfirmed,
            rationale: decision.rationale,
            buyerRole: decision.buyerRole,
            window: window ? { label: describeWindow(window, now), closesAt: window.closesAt } : null,
            fulfilment: {
              status: fulfilment.status,
              reason: fulfilment.reason,
              providerCount: fulfilment.matched.length,
            },
            economics: {
              buyerPrice: economics.buyerPrice,
              providerCost: economics.providerCost,
              grossProfit: economics.grossProfit,
              basis: economics.basis,
            },
            compliance: { status: compliance.status, gaps: compliance.gaps },
            structure: { structure: structure.structure, reason: structure.reason },
          }),
          now,
        });
        outcome.claimsRecorded += written.recorded;
      } catch {
        // Left uncounted rather than reported as recorded.
      }

      milestones.push({
        id: saved.id,
        eventId: event.id,
        connector: event.connector,
        playbookKey: playbook.key,
        route: playbook.route,
        tier: tier.tier,
        status: status.status,
      });

      outcome.byRoute[playbook.route] = (outcome.byRoute[playbook.route] ?? 0) + 1;
      outcome.byTier[tier.tier] = (outcome.byTier[tier.tier] ?? 0) + 1;
      outcome.byFriction[friction.level] = (outcome.byFriction[friction.level] ?? 0) + 1;
      if (qualifiesForLowFrictionQueue(friction.level) && status.status !== 'EXPIRED') {
        outcome.lowFrictionQueue += 1;
      }
    }
  }

  await recordPipelineMilestones({ orgId: params.orgId, routes: milestones });

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
      /** Somebody else holds the customer contract and we would work under them. */
      primeHoldsWork: boolean;
      /** Government body or public institution, where the event establishes it. */
      isPublicSector: boolean | null;
      /** Trading for under a year, per a licence or registration date. */
      isNewlyEstablished: boolean | null;
      /** Named on a public record at this address. */
      identityVerified: boolean | null;
    };

/**
 * Whether a playbook fires for this event, and why.
 *
 * The required-evidence check is the guard that stops the engine drifting back
 * into category templating. A subcontracting playbook needs a named prime and
 * a stated capacity requirement; without them it does not fire, however much
 * the event looks adjacent.
 */
/**
 * The stated facts on an event, flattened to strings for evidence matching.
 *
 * `confirmedFacts` and `inferredFacts` are stored as loose JSON because sources
 * publish different shapes. Anything that is not a readable string is dropped
 * rather than stringified, because `[object Object]` matching nothing is
 * better than it matching everything.
 */
function factStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>;
        const parts = [record.label, record.field, record.value, record.claim]
          .filter((p): p is string => typeof p === 'string');
        return parts.join(' ');
      }
      return '';
    })
    .filter((s) => s.length > 0);
}

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
      event.type === 'INBOUND_REQUEST' ||
      // The award playbook is the one exception, and it earns it: its own
      // required evidence — a geography mismatch between the prime and the
      // place of performance — is checked immediately below and is stricter
      // than this test. Without that exception, awards could never produce a
      // subcontracting route at all, and automatic discovery of primes needing
      // local crews would not exist.
      playbook.readsAwardsAsCapacityGap === true;
    if (!requestsCapacity) {
      return {
        applies: false,
        because:
          'the event names a prime but contains no request for local capacity — an award is not an open ' +
          'subcontracting job',
      };
    }
  }

  // The capacity-gap hypothesis, and the check that keeps it honest.
  //
  // An award is not an open subcontracting job. What it can support is
  // narrower: work performed in a state where the winner has no presence needs
  // crews on the ground there. That requires the geography to actually differ,
  // and the award to say where the prime is based. Where it does not say, no
  // hypothesis is available and the route does not fire.
  if (playbook.readsAwardsAsCapacityGap) {
    const payload = event.rawPayload as Record<string, unknown>;
    const primeState = typeof payload.__recipientState === 'string' ? payload.__recipientState : null;
    if (!primeState) {
      return {
        applies: false,
        because:
          'the award does not say where the prime is based, so no local-capacity gap can be established — an ' +
          'award alone is not an open subcontracting job',
      };
    }
    if (!event.stateCode) {
      return { applies: false, because: 'the award has no place of performance to compare the prime against' };
    }
    if (primeState.toUpperCase() === event.stateCode.toUpperCase()) {
      return {
        applies: false,
        because: `the prime is already based in ${event.stateCode}, so there is no reason to think they need a local crew`,
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
    // A fact about the event: is there a prime holding the customer contract?
    // Never inferred from which playbook happened to fire.
    primeHoldsWork: event.parties.some((p) => p.role === 'PRIME_CONTRACTOR' && p.company?.id === buyingParty.company?.id),
    isPublicSector: /\b(city|county|district|authority|department|agency|state of|public|municipal|school)\b/i.test(
      buyingParty.sourceName,
    )
      ? true
      : event.connector === 'municipal_solicitations' || event.connector === 'contract_awards'
        ? true
        : null,
    // A licence issued within the last year says the business is new. The
    // absence of one says nothing.
    isNewlyEstablished:
      (event.type === 'OCCUPANCY_OR_OPERATING_APPROVAL' || event.type === 'NEW_LOCATION') &&
      event.eventDate !== null &&
      event.eventDate.getTime() > Date.now() - 365 * 86_400_000
        ? true
        : null,
    // Named on a licence, permit or award record at this address. That is a
    // public record vouching for them, which is more than most leads have.
    identityVerified: buyingParty.resolutionConfidence >= 0.8 ? true : null,
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

/**
 * Where a route sits.
 *
 * Missing fulfilment blocks serious pursuit without destroying the demand —
 * the event stays, the sourcing task appears, and if nobody is found before
 * the window closes the route expires with a named reason.
 */
function decideStatus(input: {
  tier: LeadTier;
  fulfilment: FulfilmentAssessment;
  friction: FrictionLevel;
  economicsPass: boolean;
  windowClosed: boolean;
  complianceBlocks: boolean;
  complianceReason: string;
  riskBlocks: boolean;
  riskReason: string | null;
}): { status: string; reason: string } {
  if (input.windowClosed) {
    return { status: 'EXPIRED', reason: 'The buying window for this route has closed.' };
  }
  if (input.tier === 'DIRECTORY_PROSPECT' || input.tier === 'REJECTED') {
    return { status: 'COLD', reason: 'No dated demand evidence behind this route.' };
  }
  // Something we cannot legally or contractually perform is not worth an
  // afternoon, however real the demand is.
  if (input.complianceBlocks) {
    return { status: 'REJECTED', reason: input.complianceReason };
  }
  if (input.fulfilment.blocksPursuit) {
    return {
      status: 'BLOCKED_ON_SUPPLY',
      reason: `${input.fulfilment.reason} Held out of serious pursuit until a provider exists, and kept until the window closes.`,
    };
  }
  if (input.riskBlocks && input.riskReason) {
    return { status: 'RESEARCH', reason: input.riskReason };
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
  fulfilment: FulfilmentAssessment;
  friction: FrictionLevel;
  tier: { tier: LeadTier; blockedBy: string | null };
  paymentRisk: string;
  counterpartyRisk: string;
  compliance: { gaps: string[] };
}): string[] {
  const missing: string[] = [];
  if (input.tier.blockedBy) missing.push(input.tier.blockedBy);
  if (input.friction === 'UNKNOWN_RESEARCH_REQUIRED') missing.push('relationship friction is unassessed');
  if (input.fulfilment.status !== 'AVAILABLE') {
    // Names the specific check rather than "no provider", so the gap is
    // actionable: a missing certificate and an empty network are different jobs.
    const failed = input.fulfilment.checks.filter((c) => c.passed === false).map((c) => c.name);
    missing.push(failed.length > 0 ? `fulfilment: ${failed.join(', ')}` : 'a provider who can deliver this');
  }
  if (input.paymentRisk === 'UNKNOWN') missing.push('any idea whether this buyer pays');
  if (input.counterpartyRisk === 'UNKNOWN') missing.push('a counterparty assessment');
  for (const gap of input.compliance.gaps.slice(0, 2)) missing.push(gap);
  const party = input.event.parties.find((p) => p.company?.id === input.account.id);
  if (!party?.company?.contacts.some((c) => c.phone || c.email)) missing.push('any contact route to the buyer');
  if (!party?.company?.contacts.some((c) => c.isDecisionMaker)) missing.push('a named decision-maker');
  return missing;
}

function nextActionFor(input: {
  playbook: Playbook;
  fulfilment: FulfilmentAssessment;
  friction: FrictionLevel;
  missing: string[];
  status: string;
}): string {
  if (input.status === 'EXPIRED') return 'Close this route — the window has passed.';
  if (input.fulfilment.sourcingTask) return input.fulfilment.sourcingTask;
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
  /** Organisations newly put into the contact-resolution workflow. */
  contactResolution: { scheduled: number; unscheduledRemaining: number };
};

/**
 * Verify, resolve, route, then find a way to ring them.
 *
 * Called by the recurring worker, by a manual refresh and by the re-audit, so
 * there is exactly one definition of what the pipeline does.
 *
 * The last step is the bridge the board was missing. Routing an event produced
 * an opportunity nobody could contact, and finding the contact was left to a
 * person — so almost everything landed in Research needed and stayed there.
 * Scheduling happens here because this is the first moment the organisation
 * behind an event is actually known: `resolveEventAccounts` has just attached
 * it. The work itself is queued rather than done inline, so a slow provider
 * cannot hold up routing.
 */
export async function runDemandPipeline(params: {
  orgId: string;
  userId?: string;
  now?: Date;
}): Promise<PipelineResult> {
  const verification = await verifyEvents({ orgId: params.orgId, now: params.now });
  const resolution = await resolveEventAccounts({ orgId: params.orgId });
  const routes = await rebuildRoutes({ orgId: params.orgId, now: params.now });

  const contactResolution = await scheduleContactResolution({ orgId: params.orgId });
  await enqueue({
    orgId: params.orgId,
    kind: 'enrichment.resolve_contacts',
    priority: 35,
    // One in flight. Routing several sources in a row must not stack a worker
    // per source when they would all claim from the same table anyway.
    idempotencyKey: 'enrichment.resolve_contacts:pipeline',
  });

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
        contactResolutionScheduled: contactResolution.scheduled,
      },
    });
  }

  return { verification, resolution, routes, contactResolution };
}

export { normalizePhone };
