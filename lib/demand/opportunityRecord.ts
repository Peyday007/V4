import { prisma } from '@/lib/db';
import { humaniseEvent } from './events';
import { contactProvenanceFor } from '@/lib/enrichment/report';
import type { Thesis } from './thesis';

/**
 * Everything known about one commercial relationship, assembled without
 * rewriting any of it.
 *
 * The owner's record, not the caller's. A caller gets the handful of facts they
 * will say out loud; this is the thing somebody opens when they need to know
 * where a deal actually stands and why — and the discipline that makes it
 * useful is that it *assembles* rather than summarises. Every line traces to a
 * row that already existed: an event a source published, an attempt a caller
 * wrote, a provenance record the resolver stamped.
 *
 * The categories the spec insists on are kept apart in the shape itself rather
 * than in the styling, because a rendering choice is not a guarantee:
 *
 *   confirmedBySource   — the source said it
 *   confirmedByPerson   — a caller heard it from them
 *   calculated          — arithmetic on stored figures
 *   inferred            — our hypothesis, labelled as ours
 *   unknown             — named, because a missing fact that nobody names is a
 *                         missing fact nobody goes and gets
 */

export type OpportunityRecord = {
  routeId: string;
  organisation: string;
  companyId: string;
  location: string | null;

  standing: {
    status: string;
    statusReason: string | null;
    tier: string;
    outreachStatus: string;
    attempts: number;
    nextAction: string | null;
    nextActionBy: string | null;
    snoozeUntil: string | null;
    assignedTo: string | null;
  };

  /** The source said this. */
  confirmedBySource: string[];
  /** A person told a caller this. */
  confirmedByPerson: Array<{ field: string; value: string; on: string; by: string | null }>;
  /** Arithmetic on figures already stored. */
  calculated: Array<{ label: string; value: string; from: string }>;
  /** Our hypothesis. Never presented as theirs. */
  inferred: string[];
  /** Named gaps. */
  unknown: string[];

  event: {
    label: string;
    externalDate: string | null;
    firstSeenByUs: string;
    connector: string;
    sourceUrl: string | null;
  };

  contacts: {
    phone: string | null;
    confidence: string | null;
    blocker: string | null;
    provenance: Array<{ field: string; value: string; source: string; matchMethod: string | null; retrievedAt: string; superseded: boolean }>;
  };

  supply: {
    status: string;
    reason: string | null;
    providerCount: number;
    /** Candidate found is not fulfilment secured, and the wording says so. */
    secured: boolean;
  };

  /** Other routes on this account, so one business reads as one business. */
  siblingRoutes: Array<{ routeId: string; route: string; headline: string; status: string }>;

  /** Append-only, newest first. Nothing here is ever edited. */
  timeline: Array<{
    at: string;
    kind: string;
    summary: string;
    actor: string | null;
    detail: string | null;
  }>;
};

export async function loadOpportunityRecord(params: {
  orgId: string;
  routeId: string;
}): Promise<OpportunityRecord | null> {
  const route = await prisma.routeHypothesis.findFirst({
    where: { id: params.routeId, orgId: params.orgId },
    include: {
      event: true,
      company: { include: { contacts: { orderBy: [{ isDecisionMaker: 'desc' }], take: 5 } } },
      outreach: true,
      outreachAttempts: {
        orderBy: { occurredAt: 'desc' },
        take: 50,
        include: { user: { select: { name: true } } },
      },
    },
  });
  if (!route) return null;

  const [provenance, siblings, packetItem] = await Promise.all([
    contactProvenanceFor(params.orgId, route.companyId),
    prisma.routeHypothesis.findMany({
      where: { orgId: params.orgId, companyId: route.companyId, id: { not: route.id } },
      select: { id: true, route: true, headline: true, status: true },
      take: 10,
    }),
    prisma.packetItem.findFirst({
      where: { routeId: route.id, status: { in: ['PENDING', 'IN_PROGRESS'] } },
      select: { packet: { select: { caller: { select: { name: true } } } } },
    }),
  ]);

  const thesis = (route.thesis as unknown as Thesis | null) ?? null;
  const state = route.outreach;

  // --- what a person actually told us ------------------------------------
  //
  // Read off the state a caller wrote, each with the attempt that produced it,
  // so "they confirmed the need" always carries who heard it and when.
  const confirmedByPerson: OpportunityRecord['confirmedByPerson'] = [];
  const latestWith = (key: string) =>
    route.outreachAttempts.find((a) => {
      const discovery = (a.discovery ?? {}) as Record<string, unknown>;
      return typeof discovery[key] === 'string' && (discovery[key] as string).trim().length > 0;
    });

  for (const [key, label] of [
    ['confirmedNeed', 'Confirmed need'],
    ['timing', 'Timing'],
    ['decisionAuthority', 'Who decides'],
    ['buyerRole', 'Who we spoke to'],
    ['incumbent', 'Current provider'],
    ['currentSupplier', 'Current supplier'],
    ['contractEnd', 'Contract end or decision date'],
    ['objections', 'Objections'],
    ['disqualifyReason', 'Disqualifying fact'],
    ['nextStep', 'What we promised'],
  ] as const) {
    const attempt = latestWith(key);
    if (!attempt) continue;
    const discovery = (attempt.discovery ?? {}) as Record<string, unknown>;
    confirmedByPerson.push({
      field: label,
      value: String(discovery[key]),
      on: attempt.occurredAt.toISOString(),
      by: attempt.user?.name ?? null,
    });
  }

  // --- arithmetic, labelled as arithmetic ---------------------------------
  const calculated: OpportunityRecord['calculated'] = [];
  if (route.estimatedGrossProfit !== null && (route.estimatedHumanMinutes ?? 0) > 0) {
    calculated.push({
      label: 'Expected profit per hour of attention',
      value: `$${Math.round((Number(route.estimatedGrossProfit) / route.estimatedHumanMinutes!) * 60)}`,
      from: 'estimated gross profit ÷ estimated human minutes. A playbook prior, not a quote.',
    });
  }
  if (route.estimatedGrossProfit !== null) {
    calculated.push({
      label: 'Estimated gross profit',
      value: `$${Math.round(Number(route.estimatedGrossProfit))}`,
      from: route.economicsBasis ?? 'playbook prior',
    });
  }

  // --- what is missing, named --------------------------------------------
  const unknown = [...route.missingInfo];
  if (!provenance || provenance.status !== 'RESOLVED') {
    unknown.push(provenance?.blocker ?? 'a verified contact route');
  }
  if (!confirmedByPerson.some((c) => c.field === 'Confirmed need')) {
    unknown.push('whether they actually need this — nobody has confirmed it');
  }
  if (!confirmedByPerson.some((c) => c.field === 'Who decides')) {
    unknown.push('who signs');
  }

  const timeline: OpportunityRecord['timeline'] = [
    {
      at: route.event.discoveredAt.toISOString(),
      kind: 'discovered',
      summary: `${humaniseEvent(route.event.type)} found by ${route.event.connector}`,
      actor: null,
      detail: route.event.headline,
    },
    {
      at: route.createdAt.toISOString(),
      kind: 'routed',
      summary: `Routed as ${route.route.toLowerCase()} — ${route.playbookKey}`,
      actor: null,
      detail: route.rationale,
    },
    ...route.outreachAttempts.map((attempt) => ({
      at: attempt.occurredAt.toISOString(),
      kind: 'call',
      summary: attempt.disposition.toLowerCase().replace(/_/g, ' '),
      actor: attempt.user?.name ?? null,
      detail: attempt.notes,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return {
    routeId: route.id,
    organisation: route.company.legalName,
    companyId: route.companyId,
    location:
      [route.company.cityName ?? route.event.cityName, route.company.stateCode ?? route.event.stateCode]
        .filter(Boolean)
        .join(', ') || null,

    standing: {
      status: route.status,
      statusReason: route.statusReason,
      tier: route.tier,
      outreachStatus: state?.status ?? 'NEW',
      attempts: state?.attempts ?? 0,
      nextAction: route.nextAction,
      nextActionBy: route.nextActionBy?.toISOString() ?? null,
      snoozeUntil: state?.snoozeUntil?.toISOString() ?? null,
      assignedTo: packetItem?.packet.caller.name ?? null,
    },

    confirmedBySource: (route.event.confirmedFacts as unknown as string[]) ?? [],
    confirmedByPerson,
    calculated,
    inferred: [
      ...((route.event.inferredFacts as unknown as string[]) ?? []),
      ...(route.needIsConfirmed
        ? []
        : ['That this event creates a need for what we sell. Our conclusion, not theirs.']),
      ...(thesis?.whyNow ? [thesis.whyNow] : []),
    ],
    unknown: [...new Set(unknown)],

    event: {
      label: humaniseEvent(route.event.type),
      externalDate: route.event.eventDate?.toISOString() ?? null,
      firstSeenByUs: route.event.discoveredAt.toISOString(),
      connector: route.event.connector,
      sourceUrl: route.event.sourceUrl,
    },

    contacts: {
      phone: state?.correctedPhone ?? route.company.phone ?? route.company.contacts[0]?.phone ?? null,
      confidence: provenance?.confidence ?? null,
      blocker: provenance?.blocker ?? null,
      provenance:
        provenance?.fields.map((f) => ({
          field: f.field,
          value: f.value,
          source: f.source,
          matchMethod: f.matchMethod,
          retrievedAt: f.retrievedAt,
          superseded: f.superseded,
        })) ?? [],
    },

    supply: {
      status: route.fulfilmentStatus,
      reason: route.fulfilmentReason,
      providerCount: route.providerCount,
      // AVAILABLE is the only state that means a verified provider exists.
      secured: route.fulfilmentStatus === 'AVAILABLE',
    },

    siblingRoutes: siblings.map((s) => ({
      routeId: s.id,
      route: s.route,
      headline: s.headline,
      status: s.status,
    })),

    timeline,
  };
}
