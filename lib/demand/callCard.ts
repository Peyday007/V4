import { prisma } from '@/lib/db';
import { buildCallBrief, type CallBrief } from './callBrief';
import { humaniseEvent } from './events';
import { attemptHistory } from './outreach';
import { contactProvenanceFor, type ContactProvenanceView } from '@/lib/enrichment/report';
import { isCallable } from './queue';
import type { Thesis } from './thesis';

/**
 * Everything one caller view needs, in one query.
 *
 * The full dossier is deliberately not part of this. The caller gets the
 * handful of facts they will actually say out loud; the evidence sits behind a
 * separate request so a person about to dial is not scrolling past a risk
 * assessment to find the phone number.
 */

export type CallCard = {
  routeId: string;
  callable: boolean;
  notCallableReason: string | null;

  organisation: string;
  companyId: string;
  location: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;

  tier: string;
  route: string;
  friction: string;
  frictionReason: string | null;
  profitPerHour: number | null;
  /**
   * The low end of the modelled gross-profit band.
   *
   * Named `expected` for continuity and deliberately pessimistic: a caller
   * choosing between two records should be comparing the floor of each, not the
   * middle of two categories.
   */
  expectedGrossProfit: number | null;
  /** The high end, so the width of the band is visible beside the floor. */
  expectedGrossProfitHigh: number | null;

  eventType: string;
  eventLabel: string;
  /** The source's date. Never our first-seen timestamp. */
  eventDate: string | null;
  deadlineAt: string | null;
  sourceUrl: string | null;
  connector: string;
  /** Shown as our timestamp, labelled as ours. */
  discoveredAt: string;

  requiredCapability: string | null;
  needIsConfirmed: boolean;
  buyingWindow: string | null;
  windowClosesAt: string | null;
  fulfilmentStatus: string;
  fulfilmentReason: string | null;
  supplySecured: boolean;

  brief: CallBrief;

  /** Other routes on the same account, so one business reads as one business. */
  siblingRoutes: Array<{ routeId: string; route: string; headline: string; sameEvent: boolean }>;

  /**
   * Where this number came from, and how much it can be relied on.
   *
   * A caller who knows the number was matched on business name and street
   * address from a directory listing retrieved on a stated date opens the call
   * differently from one who has been told it is confirmed. Null when no
   * resolution has been recorded for the account.
   */
  contactProvenance: ContactProvenanceView | null;

  outreach: {
    status: string;
    attempts: number;
    lastAttemptAt: string | null;
    lastDisposition: string | null;
    contactName: string | null;
    contactRole: string | null;
    snoozeUntil: string | null;
    confirmedNeed: string | null;
    confirmedTiming: string | null;
    incumbentStatus: string | null;
  };

  history: Array<{
    id: string;
    disposition: string;
    notes: string | null;
    occurredAt: string;
    by: string | null;
  }>;
};

export async function loadCallCard(params: { orgId: string; routeId: string }): Promise<CallCard | null> {
  const route = await prisma.routeHypothesis.findFirst({
    where: { id: params.routeId, orgId: params.orgId },
    include: {
      event: true,
      company: {
        include: {
          contacts: { orderBy: [{ isDecisionMaker: 'desc' }, { createdAt: 'asc' }], take: 3 },
        },
      },
      outreach: true,
    },
  });
  if (!route) return null;

  const [callable, history, siblings, contactProvenance] = await Promise.all([
    isCallable(params.orgId, params.routeId),
    attemptHistory(params.orgId, params.routeId),
    prisma.routeHypothesis.findMany({
      where: { companyId: route.companyId, orgId: params.orgId, id: { not: route.id } },
      select: { id: true, route: true, headline: true, eventId: true },
      take: 8,
    }),
    contactProvenanceFor(params.orgId, route.companyId),
  ]);

  const contact = route.company.contacts[0];
  const thesis = (route.thesis as unknown as Thesis | null) ?? null;

  // The operator's correction wins over the directory: they spoke to a person.
  const phone = route.outreach?.correctedPhone ?? route.company.phone ?? contact?.phone ?? contact?.mobile ?? null;
  const email = route.outreach?.correctedEmail ?? contact?.email ?? null;

  // Routes built before economics became a band carry only a midpoint. Falling
  // back to it keeps them rankable; nothing pretends the band is known.
  const lowGrossProfit =
    route.estimatedGrossProfitLow !== null
      ? Number(route.estimatedGrossProfitLow)
      : route.estimatedGrossProfit !== null
        ? Number(route.estimatedGrossProfit)
        : null;

  const brief = buildCallBrief({
    organisation: route.company.legalName,
    eventType: route.event.type,
    eventDate: route.event.eventDate,
    deadlineAt: route.event.deadlineAt,
    confirmedFacts: (route.event.confirmedFacts as unknown as string[]) ?? [],
    playbookKey: route.playbookKey,
    route: route.route,
    requiredCapability: route.requiredCapability,
    needIsConfirmed: route.needIsConfirmed,
    tier: route.tier,
    friction: route.friction,
    fulfilmentStatus: route.fulfilmentStatus,
    thesis,
    knownContactName: route.outreach?.contactName ?? null,
    previousDisposition: route.outreach?.lastDisposition ?? null,
  });

  return {
    routeId: route.id,
    callable: callable.callable,
    notCallableReason: callable.reason,

    organisation: route.company.legalName,
    companyId: route.companyId,
    location: [route.company.cityName ?? route.event.cityName, route.company.stateCode ?? route.event.stateCode]
      .filter(Boolean)
      .join(', ') || null,
    phone,
    email,
    website: route.company.website,

    tier: route.tier,
    route: route.route,
    friction: route.friction,
    frictionReason: route.frictionReason,
    // The pessimistic end of the modelled band, falling back to the stored
    // midpoint on routes built before economics became a range. This figure
    // decides which call somebody makes first; the optimistic reading of a
    // category prior is the wrong thing to sort a morning by.
    profitPerHour:
      lowGrossProfit !== null && (route.estimatedHumanMinutes ?? 0) > 0
        ? Math.round((lowGrossProfit / route.estimatedHumanMinutes!) * 60)
        : null,
    expectedGrossProfit: lowGrossProfit === null ? null : Math.round(lowGrossProfit),
    expectedGrossProfitHigh:
      route.estimatedGrossProfitHigh === null ? null : Math.round(Number(route.estimatedGrossProfitHigh)),

    eventType: route.event.type,
    eventLabel: humaniseEvent(route.event.type),
    eventDate: route.event.eventDate?.toISOString() ?? null,
    deadlineAt: route.event.deadlineAt?.toISOString() ?? null,
    sourceUrl: route.event.sourceUrl,
    connector: route.event.connector,
    discoveredAt: route.event.discoveredAt.toISOString(),

    requiredCapability: route.requiredCapability,
    needIsConfirmed: route.needIsConfirmed,
    buyingWindow: route.buyingWindow,
    windowClosesAt: route.windowClosesAt?.toISOString() ?? null,
    fulfilmentStatus: route.fulfilmentStatus,
    fulfilmentReason: route.fulfilmentReason,
    // Named plainly, because "blocked on supply" reads like the opportunity
    // was rejected when it means the opposite: the demand is real and we have
    // nobody to do the work yet.
    supplySecured: route.fulfilmentStatus === 'AVAILABLE',

    brief,

    contactProvenance,

    siblingRoutes: siblings.map((s) => ({
      routeId: s.id,
      route: s.route,
      headline: s.headline,
      sameEvent: s.eventId === route.eventId,
    })),

    outreach: {
      status: route.outreach?.status ?? 'NEW',
      attempts: route.outreach?.attempts ?? 0,
      lastAttemptAt: route.outreach?.lastAttemptAt?.toISOString() ?? null,
      lastDisposition: route.outreach?.lastDisposition ?? null,
      contactName: route.outreach?.contactName ?? contact?.firstName ?? null,
      contactRole: route.outreach?.contactRole ?? contact?.title ?? null,
      snoozeUntil: route.outreach?.snoozeUntil?.toISOString() ?? null,
      confirmedNeed: route.outreach?.confirmedNeed ?? null,
      confirmedTiming: route.outreach?.confirmedTiming ?? null,
      incumbentStatus: route.outreach?.incumbentStatus ?? null,
    },

    history: history.map((h) => ({
      id: h.id,
      disposition: h.disposition,
      notes: h.notes,
      occurredAt: h.occurredAt.toISOString(),
      by: h.user?.name ?? h.user?.email ?? null,
    })),
  };
}

/**
 * The full dossier, fetched only when asked for.
 *
 * This is the card the board used to render 152 of. It still exists in full —
 * the engine's reasoning has to stay inspectable — it simply is not loaded
 * until somebody wants it.
 */
export async function loadEvidence(params: { orgId: string; routeId: string }) {
  const route = await prisma.routeHypothesis.findFirst({
    where: { id: params.routeId, orgId: params.orgId },
    include: {
      event: { include: { parties: { include: { company: { select: { legalName: true } } } } } },
      company: { select: { legalName: true, cityName: true, stateCode: true, website: true } },
      path: { select: { name: true } },
    },
  });
  if (!route) return null;

  return {
    routeId: route.id,
    headline: route.headline,
    rationale: route.rationale,
    playbookKey: route.playbookKey,
    tier: route.tier,
    friction: route.friction,
    frictionReason: route.frictionReason,
    frictionFactors: route.frictionFactors,
    needIsConfirmed: route.needIsConfirmed,
    requiredCapability: route.requiredCapability,
    status: route.status,
    statusReason: route.statusReason,
    missingInfo: route.missingInfo,
    nextAction: route.nextAction,
    thesis: route.thesis,

    event: {
      type: route.event.type,
      label: humaniseEvent(route.event.type),
      // The source's date and our first-seen date, labelled separately so one
      // can never be read as the other.
      externalEventDate: route.event.eventDate?.toISOString() ?? null,
      firstSeenByUs: route.event.discoveredAt.toISOString(),
      deadlineAt: route.event.deadlineAt?.toISOString() ?? null,
      sourceUrl: route.event.sourceUrl,
      connector: route.event.connector,
      headline: route.event.headline,
      summary: route.event.summary,
      confirmedFacts: route.event.confirmedFacts,
      inferredFacts: route.event.inferredFacts,
      lifecycle: route.event.lifecycle,
      verification: route.event.verification,
      parties: route.event.parties.map((p) => ({
        role: p.role,
        sourceName: p.sourceName,
        resolvedTo: p.company?.legalName ?? null,
        confidence: p.resolutionConfidence,
        method: p.resolutionMethod,
      })),
    },

    fulfilment: {
      status: route.fulfilmentStatus,
      reason: route.fulfilmentReason,
      providerCount: route.providerCount,
      matchedProviderIds: route.matchedProviderIds,
    },

    economics: {
      buyerPrice: route.estimatedBuyerPrice,
      buyerPriceLow: route.estimatedBuyerPriceLow,
      buyerPriceHigh: route.estimatedBuyerPriceHigh,
      providerCost: route.estimatedProviderCost,
      providerCostLow: route.estimatedProviderCostLow,
      providerCostHigh: route.estimatedProviderCostHigh,
      grossProfit: route.estimatedGrossProfit,
      grossProfitLow: route.estimatedGrossProfitLow,
      grossProfitHigh: route.estimatedGrossProfitHigh,
      humanMinutes: route.estimatedHumanMinutes,
      basis: route.economicsBasis,
      inputs: route.economicsInputs,
      structure: route.commercialStructure,
      structureReason: route.structureReason,
    },

    risk: {
      maxCashExposure: route.maxCashExposure,
      daysCapitalExposed: route.daysCapitalExposed,
      paymentRisk: route.paymentRisk,
      counterpartyRisk: route.counterpartyRisk,
      complianceStatus: route.complianceStatus,
      complianceGaps: route.complianceGaps,
      notes: route.riskNotes,
    },

    window: {
      label: route.buyingWindow,
      opensAt: route.windowOpensAt?.toISOString() ?? null,
      closesAt: route.windowClosesAt?.toISOString() ?? null,
    },
  };
}
