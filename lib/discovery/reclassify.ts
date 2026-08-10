import type { Contact, CompanyLocation, DiscoverySignal, LeadRole, LeadStage } from '@prisma/client';
import { prisma } from '@/lib/db';
import { audit } from '@/lib/audit';
import { getActivePaths } from '@/lib/paths';
import { buildIdentity, normalizeAddress, normalizePhone, sameCompany, type IdentityKeys } from './identity';
import {
  decideStage,
  describeRelevance,
  scoreAccountFit,
  scoreContactability,
  scoreFulfilmentReadiness,
  scoreIntent,
  scorePriority,
  type IntentSignal,
  type QualificationEvidence,
} from './qualification';

/**
 * Rebuilds accounts, hypotheses and scores from records already ingested.
 *
 * Existing signals were created under a model that could not distinguish
 * "exists" from "buying", so they cannot simply be re-scored — the companies
 * themselves are duplicated across paths and sources. This collapses them onto
 * identity, attaches one hypothesis per company per path, and scores each on
 * evidence that actually exists.
 *
 * Idempotent: running it twice produces the same result, because it derives
 * everything from source records rather than from previous output.
 */

export type BeforeAfterRow = {
  company: string;
  cityState: string;
  before: {
    signalIds: string[];
    duplicateCards: number;
    score: number;
    claimedStage: string;
    claimedRelevance: string;
  };
  after: {
    companyId: string;
    mergedFrom: number;
    stage: LeadStage;
    accountFit: number;
    intent: number;
    contactability: number;
    fulfilment: number;
    priority: number;
    paths: string[];
    missing: string[];
    relevance: string;
  };
};

export type ReclassifyResult = {
  signalsExamined: number;
  companiesBefore: number;
  companiesAfter: number;
  companiesMerged: number;
  hypothesesCreated: number;
  intentEventsFound: number;
  stageCounts: Record<string, number>;
  rows: BeforeAfterRow[];
};

/** Company roles that supply rather than buy. */
const SUPPLY_ROLES: LeadRole[] = ['PROVIDER', 'SUPPLIER', 'SUBCONTRACTOR', 'PARTNER'];

export async function reclassify(params: { orgId: string; userId: string; dryRun?: boolean }): Promise<ReclassifyResult> {
  const { orgId } = params;

  const [signals, paths, markets, companies] = await Promise.all([
    prisma.discoverySignal.findMany({
      where: { orgId, origin: 'LIVE_DISCOVERY' },
      include: {
        company: { include: { contacts: true, locations: true } },
        path: true,
        market: true,
        dataSource: true,
        evidence: true,
      },
      orderBy: { createdAt: 'asc' },
    }),
    getActivePaths(orgId),
    prisma.market.findMany({ where: { orgId, isEnabled: true } }),
    prisma.company.count({ where: { orgId, origin: 'LIVE_DISCOVERY' } }),
  ]);

  const result: ReclassifyResult = {
    signalsExamined: signals.length,
    companiesBefore: companies,
    companiesAfter: 0,
    companiesMerged: 0,
    hypothesesCreated: 0,
    intentEventsFound: 0,
    stageCounts: {},
    rows: [],
  };
  if (signals.length === 0) return result;

  // --- 1. Collapse signals onto company identity -------------------------
  type Cluster = {
    identity: IdentityKeys;
    companyIds: Set<string>;
    signals: typeof signals;
    primary: typeof signals[number]['company'] & { contacts: Contact[]; locations: CompanyLocation[] };
  };

  const clusters: Cluster[] = [];

  for (const signal of signals) {
    if (!signal.company) continue;
    const location = signal.company.locations[0];
    const identity = buildIdentity({
      name: signal.company.legalName,
      externalPlaceId: signal.company.externalPlaceId,
      phone: signal.company.phone ?? signal.company.contacts[0]?.phone,
      address: location ? [location.line1, location.city, location.state].filter(Boolean).join(' ') : null,
      city: location?.city ?? signal.cityName,
      state: location?.state ?? signal.stateCode,
    });

    const existing = clusters.find((c) => sameCompany(c.identity, identity).matched);
    if (existing) {
      existing.companyIds.add(signal.company.id);
      existing.signals.push(signal);
      // Keep the richest identity: a later record may carry the place ID or
      // address the first one lacked.
      existing.identity = {
        ...existing.identity,
        externalPlaceId: existing.identity.externalPlaceId ?? identity.externalPlaceId,
        normalizedPhone: existing.identity.normalizedPhone ?? identity.normalizedPhone,
        normalizedAddress: existing.identity.normalizedAddress ?? identity.normalizedAddress,
        cityName: existing.identity.cityName ?? identity.cityName,
        stateCode: existing.identity.stateCode ?? identity.stateCode,
      };
    } else {
      clusters.push({ identity, companyIds: new Set([signal.company.id]), signals: [signal], primary: signal.company });
    }
  }

  result.companiesAfter = clusters.length;
  result.companiesMerged = clusters.reduce((sum, c) => sum + Math.max(0, c.companyIds.size - 1), 0);

  // --- 2. One hypothesis per company per path ----------------------------
  for (const cluster of clusters) {
    const company = cluster.primary;
    const contacts = company.contacts ?? [];
    const location = company.locations?.[0];

    const beforeScores = cluster.signals.map((s) => Math.round(s.strength * 100));
    const before = {
      signalIds: cluster.signals.map((s) => s.id),
      duplicateCards: cluster.signals.length,
      score: beforeScores.length ? Math.max(...beforeScores) : 0,
      claimedStage: 'presented as a qualified lead',
      claimedRelevance: cluster.signals[0]?.whyRelevant?.slice(0, 120) ?? '',
    };

    if (!params.dryRun) {
      await prisma.company.update({
        where: { id: company.id },
        data: {
          normalizedPhone: cluster.identity.normalizedPhone,
          normalizedAddress: cluster.identity.normalizedAddress,
          cityName: cluster.identity.cityName ?? location?.city ?? null,
          stateCode: cluster.identity.stateCode ?? location?.state ?? null,
          externalPlaceId: company.externalPlaceId ?? cluster.identity.externalPlaceId,
        },
      });
    }

    // Intent events are found, never assumed. A place listing produces none.
    const intentSignals: IntentSignal[] = [];
    for (const signal of cluster.signals) {
      const kind = intentKindFor(signal);
      if (!kind) continue;
      // Only a source-dated event counts; ingestion time is not an event date.
      const occurredAt = signal.sourcePublishedAt ?? datedFromPayload(signal);
      if (!occurredAt) continue;
      intentSignals.push({ kind, occurredAt, tier: 'SOURCE_FACT' });
    }
    result.intentEventsFound += intentSignals.length;

    const intent = scoreIntent(intentSignals);

    // Group this cluster's signals by the path each proposed.
    const byPath = new Map<string, typeof cluster.signals>();
    for (const signal of cluster.signals) {
      const key = signal.path?.id ?? paths[0]?.id;
      if (!key) continue;
      byPath.set(key, [...(byPath.get(key) ?? []), signal]);
    }

    const rowPaths: string[] = [];
    let rowStage: LeadStage = 'DISCOVERED_ACCOUNT';
    let rowMissing: string[] = [];
    let topPriority = 0;
    let fitScore = 0;
    let contactScore = 0;
    let fulfilScore = 0;
    let relevance = '';

    for (const [pathId, pathSignals] of byPath) {
      const path = paths.find((p) => p.id === pathId);
      if (!path) continue;
      const lead = pathSignals[0];
      const role = lead.leadRole;

      const fit = scoreAccountFit({
        pathSegments: path.segments,
        segment: lead.segment,
        hasRelevantService: Boolean(lead.requiredService),
        inServedMarket: markets.some((m) => m.id === lead.marketId),
        sourceVerified: lead.dataSource?.isLive ?? false,
      });

      const routing = contacts.filter((c) => !c.isDecisionMaker);
      const contact = scoreContactability({
        hasRoutingPhone: routing.some((c) => Boolean(c.phone)),
        hasDirectPhone: contacts.some((c) => Boolean(c.mobile)),
        hasEmail: contacts.some((c) => Boolean(c.email)),
        hasIdentifiedDecisionMaker: contacts.some((c) => c.isDecisionMaker),
        decisionMakerVerified: contacts.some((c) => c.isDecisionMaker && c.verificationStatus !== 'UNVERIFIED'),
      });

      const fulfil = scoreFulfilmentReadiness({
        availableProviders: 0,
        minimumProviders: 3,
        requiresSupply: !SUPPLY_ROLES.includes(role),
      });

      const priority = scorePriority({
        accountFit: fit.score,
        intent: intent.score,
        contactability: contact.score,
        fulfilmentReadiness: fulfil.score,
      });

      // Nothing here has been confirmed by anyone, which is the point.
      const evidence: QualificationEvidence = {
        need: { present: intent.score > 0, tier: intent.score > 0 ? 'SOURCE_FACT' : 'SYSTEM_INFERENCE' },
        decisionMaker: { present: contacts.some((c) => c.isDecisionMaker), verified: false },
        timing: { present: intent.lastSignalAt !== null },
        fit: { present: fit.score >= 0.75 },
        nextStep: { present: false },
      };

      const stage = decideStage({ intentScore: intent.score, accountFit: fit.score, evidence });
      relevance = describeRelevance(role, lead.requiredService, intent.score > 0);

      if (!params.dryRun) {
        const hypothesis = await prisma.pathHypothesis.upsert({
          where: { companyId_pathId: { companyId: company.id, pathId } },
          create: {
            orgId,
            companyId: company.id,
            pathId,
            stage: stage.stage,
            accountFitScore: fit.score,
            intentScore: intent.score,
            contactabilityScore: contact.score,
            fulfillmentReadinessScore: fulfil.score,
            priorityScore: priority.score,
            scoreExplanation: {
              accountFit: fit.reason,
              intent: intent.reason,
              contactability: contact.reason,
              fulfilment: fulfil.reason,
              priority: priority.reason,
            } as object,
            firstDiscoveredAt: lead.firstDiscoveredAt ?? lead.createdAt,
            lastSeenAt: lead.lastSeenAt,
            lastIntentSignalAt: intent.lastSignalAt,
          },
          update: {
            stage: stage.stage,
            accountFitScore: fit.score,
            intentScore: intent.score,
            contactabilityScore: contact.score,
            fulfillmentReadinessScore: fulfil.score,
            priorityScore: priority.score,
            lastSeenAt: lead.lastSeenAt,
            lastIntentSignalAt: intent.lastSignalAt,
          },
        });
        result.hypothesesCreated += 1;

        await prisma.discoverySignal.updateMany({
          where: { id: { in: pathSignals.map((s) => s.id) } },
          data: {
            hypothesisId: hypothesis.id,
            whyRelevant: relevance,
            cityName: cluster.identity.cityName,
            stateCode: cluster.identity.stateCode,
            // Places and CMS state that an organisation exists. The path we
            // attached to it is ours, so the record is an inference.
            tier: intent.score > 0 ? 'SOURCE_FACT' : 'SYSTEM_INFERENCE',
          },
        });
      } else {
        result.hypothesesCreated += 1;
      }

      rowPaths.push(`${path.name} (${stage.stage.toLowerCase().replace(/_/g, ' ')})`);
      if (priority.score > topPriority) {
        topPriority = priority.score;
        rowStage = stage.stage;
        rowMissing = stage.missing;
        fitScore = fit.score;
        contactScore = contact.score;
        fulfilScore = fulfil.score;
      }
      result.stageCounts[stage.stage] = (result.stageCounts[stage.stage] ?? 0) + 1;
    }

    result.rows.push({
      company: company.legalName,
      cityState: [cluster.identity.cityName, cluster.identity.stateCode].filter(Boolean).join(', ') || 'unknown',
      before,
      after: {
        companyId: company.id,
        mergedFrom: cluster.companyIds.size,
        stage: rowStage,
        accountFit: Math.round(fitScore * 100),
        intent: Math.round(intent.score * 100),
        contactability: Math.round(contactScore * 100),
        fulfilment: Math.round(fulfilScore * 100),
        priority: topPriority,
        paths: rowPaths,
        missing: rowMissing,
        relevance,
      },
    });
  }

  if (!params.dryRun) {
    await audit({
      orgId,
      userId: params.userId,
      action: 'discovery.reclassified',
      entityType: 'Organization',
      entityId: orgId,
      metadata: {
        signals: result.signalsExamined,
        merged: result.companiesMerged,
        hypotheses: result.hypothesesCreated,
        stages: result.stageCounts,
      },
    });
  }

  return result;
}

/**
 * Which intent kind, if any, a signal represents.
 *
 * Directory and registry listings return null, and that is the correct answer
 * — a business existing is not an event.
 */
export function intentKindFor(signal: Pick<DiscoverySignal, 'signalKey' | 'category'> & { dataSource?: { connector: string } | null }): IntentSignal['kind'] | null {
  const connector = signal.dataSource?.connector ?? '';
  if (connector === 'google_places' || connector === 'nppes_healthcare') return null;
  if (connector === 'socrata_open_data') return 'PERMIT_FILED';
  if (connector === 'usaspending_awards') return 'CONTRACT_AWARD';
  if (connector === 'sam_gov_opportunities') return 'PURCHASING_NOTICE';

  const key = signal.signalKey;
  if (key.startsWith('sourced_')) return null;
  if (/permit/.test(key)) return 'PERMIT_FILED';
  if (/hiring|job/.test(key)) return 'JOB_POSTING';
  if (/award/.test(key)) return 'CONTRACT_AWARD';
  if (/quote|rfq|bid/.test(key)) return 'RFQ_ISSUED';
  if (/new_facility|opening/.test(key)) return 'FACILITY_OPENING';
  if (/expansion|territory/.test(key)) return 'EXPANSION';
  return null;
}

/** A source-stated date from the payload, or null. Never the ingestion time. */
function datedFromPayload(signal: DiscoverySignal & { evidence?: { discoveredAt: Date } | null }): Date | null {
  const payload = signal.contactHint as Record<string, unknown> | null;
  const candidate = payload?.occurredAt;
  if (typeof candidate === 'string') {
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return signal.sourcePublishedAt ?? null;
}

export { normalizePhone, normalizeAddress };
