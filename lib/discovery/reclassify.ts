import type { Contact, CompanyLocation, DiscoverySignal, LeadRole, LeadStage } from '@prisma/client';
import { prisma } from '@/lib/db';
import { audit } from '@/lib/audit';
import { getActivePaths } from '@/lib/paths';
import { assessIdentity, buildIdentity, normalizeAddress, normalizePhone, sameCompany, type IdentityKeys } from './identity';
import { diagnose, type RunDiagnostics } from './diagnostics';
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
  /** One row per hypothesis, so the path each account was included for is visible. */
  path: string;
  leadRole: string;
  /** Held out of ranking because its identity cannot be trusted. */
  quarantined: boolean;
  quarantineReason: string | null;
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
  /**
   * Counted per hypothesis, not per account. An account with two path
   * candidacies contributes two entries — which is why this total exceeds
   * `companiesAfter`.
   */
  stageCounts: Record<string, number>;
  /** The same tally collapsed to one entry per account, by its best stage. */
  accountStageCounts: Record<string, number>;
  quarantinedAccounts: number;
  /** The run's assessment of its own output. */
  diagnostics: RunDiagnostics;
  rows: BeforeAfterRow[];
};

function emptyDiagnostics(): RunDiagnostics {
  return { distributions: [], warnings: [], dataQuality: [], verdict: 'CREDIBLE', verdictReason: 'Nothing to assess.' };
}

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
    accountStageCounts: {},
    quarantinedAccounts: 0,
    diagnostics: emptyDiagnostics(),
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

  // Capability names we actually hold, lowercased, so "service is catalogued"
  // is a real check rather than "the connector set a string".
  const catalogue = new Set(
    (await prisma.capability.findMany({ where: { orgId }, select: { name: true } })).map((c) => c.name.toLowerCase()),
  );

  // Supply-side companies indexed by capability and state, so fulfilment can
  // be answered per lead rather than assumed.
  const providerIndex = await buildProviderIndex(orgId);

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

    const quarantine = assessIdentity(cluster.identity);
    if (quarantine.quarantined) result.quarantinedAccounts += 1;

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

      const marketForLead = markets.find((m) => m.id === lead.marketId);
      const fit = scoreAccountFit({
        pathSegments: path.segments,
        segment: lead.segment,
        pathRoles: path.leadRoles,
        leadRole: role,
        // A capability already in the catalogue can be priced and matched; a
        // connector's generic label cannot.
        serviceIsCatalogued: lead.requiredService
          ? catalogue.has(lead.requiredService.toLowerCase())
          : false,
        locationPrecision: cluster.identity.cityName
          ? 'CITY'
          : cluster.identity.stateCode
            ? 'STATE'
            : 'UNKNOWN',
        // The nationwide sweep is coverage, not a market anyone is working.
        matchedLocalMarket: Boolean(marketForLead && marketForLead.scope !== 'NATIONAL'),
      });

      const routing = contacts.filter((c) => !c.isDecisionMaker);
      const contact = scoreContactability({
        hasRoutingPhone: routing.some((c) => Boolean(c.phone)),
        hasDirectPhone: contacts.some((c) => Boolean(c.mobile)),
        hasEmail: contacts.some((c) => Boolean(c.email)),
        hasWebsite: Boolean(company.website),
        // "Main line" is the placeholder the ingest path writes when a source
        // gives a number but no person, so it does not count as a named one.
        hasNamedPerson: contacts.some((c) => c.firstName && c.firstName !== 'Main'),
        hasIdentifiedDecisionMaker: contacts.some((c) => c.isDecisionMaker),
        decisionMakerVerified: contacts.some((c) => c.isDecisionMaker && c.verificationStatus !== 'UNVERIFIED'),
      });

      // Real capacity, not a placeholder. The first version hardcoded zero,
      // which made fulfilment exactly 0 for every buyer and exactly 1 for
      // every supply-side lead — the same class of defect as a fit score that
      // could not be unticked.
      const fulfil = scoreFulfilmentReadiness({
        availableProviders: providersFor(providerIndex, lead.requiredService, cluster.identity.stateCode),
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

      // One row per hypothesis. An account with two paths produces two rows,
      // which is why the stage tally exceeds the account count — each row is a
      // path candidacy, not a company.
      result.rows.push({
        company: company.legalName,
        cityState: [cluster.identity.cityName, cluster.identity.stateCode].filter(Boolean).join(', ') || 'unknown',
        path: path.name,
        leadRole: role,
        quarantined: quarantine.quarantined,
        quarantineReason: quarantine.reason,
        before: { ...before },
        after: {
          companyId: company.id,
          mergedFrom: cluster.companyIds.size,
          stage: stage.stage,
          accountFit: Math.round(fit.score * 100),
          intent: Math.round(intent.score * 100),
          contactability: Math.round(contact.score * 100),
          fulfilment: Math.round(fulfil.score * 100),
          priority: priority.score,
          paths: [path.name],
          missing: stage.missing,
          relevance,
        },
      });

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

    result.accountStageCounts[rowStage] = (result.accountStageCounts[rowStage] ?? 0) + 1;
  }

  // Quarantined records are excluded from the distribution check: they are
  // held out of ranking, so including them would describe a population the
  // operator is not being asked to act on.
  const ranked = result.rows.filter((r) => !r.quarantined);
  result.diagnostics = diagnose({
    fit: ranked.map((r) => r.after.accountFit),
    intent: ranked.map((r) => r.after.intent),
    contactability: ranked.map((r) => r.after.contactability),
    fulfilment: ranked.map((r) => r.after.fulfilment),
    priority: ranked.map((r) => r.after.priority),
    records: result.rows.map((r) => ({
      company: r.company,
      cityState: r.cityState,
      quarantined: r.quarantined,
      quarantineReason: r.quarantineReason,
      contactability: r.after.contactability,
      intent: r.after.intent,
    })),
  });

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
        quarantined: result.quarantinedAccounts,
        verdict: result.diagnostics.verdict,
        warnings: result.diagnostics.warnings.map((w) => `${w.severity} ${w.dimension}: ${w.finding}`),
      },
    });
  }

  return result;
}

export type ProviderIndex = {
  /** Lowercased capability name -> set of state codes where a provider holds it. */
  byCapability: Map<string, Map<string, number>>;
  /** Providers with no stated capability, counted per state as a weak fallback. */
  byStateOnly: Map<string, number>;
  total: number;
};

/**
 * Counts supply-side companies by capability and state.
 *
 * Built once per run rather than queried per lead: a reclassification touches
 * every record and a per-lead query would multiply into hundreds of round
 * trips for a number that does not change during the run.
 */
export async function buildProviderIndex(orgId: string): Promise<ProviderIndex> {
  const providers = await prisma.company.findMany({
    where: { orgId, companyRole: { in: ['SUPPLIER', 'DISTRIBUTOR', 'SUBCONTRACTOR', 'CARRIER', 'MANUFACTURER'] } },
    select: {
      stateCode: true,
      locations: { select: { state: true }, take: 1 },
      capabilities: { select: { capability: { select: { name: true } } } },
    },
  });

  const byCapability = new Map<string, Map<string, number>>();
  const byStateOnly = new Map<string, number>();

  for (const provider of providers) {
    const state = (provider.stateCode ?? provider.locations[0]?.state ?? '').toUpperCase() || 'UNKNOWN';
    if (provider.capabilities.length === 0) {
      byStateOnly.set(state, (byStateOnly.get(state) ?? 0) + 1);
      continue;
    }
    for (const link of provider.capabilities) {
      const key = link.capability.name.toLowerCase();
      const states = byCapability.get(key) ?? new Map<string, number>();
      states.set(state, (states.get(state) ?? 0) + 1);
      byCapability.set(key, states);
    }
  }

  return { byCapability, byStateOnly, total: providers.length };
}

/**
 * Providers able to serve this lead.
 *
 * Same state counts fully; other states count as a fraction, because a crew
 * three states away is not nothing but is not local coverage either. A lead
 * with no known state falls back to the national total for the capability.
 */
export function providersFor(index: ProviderIndex, service: string | null, stateCode: string | null): number {
  if (!service) return 0;
  const states = index.byCapability.get(service.toLowerCase());
  if (!states) return 0;

  if (!stateCode) {
    return [...states.values()].reduce((sum, n) => sum + n, 0);
  }
  const local = states.get(stateCode.toUpperCase()) ?? 0;
  const elsewhere = [...states.entries()]
    .filter(([state]) => state !== stateCode.toUpperCase())
    .reduce((sum, [, n]) => sum + n, 0);
  return local + elsewhere * 0.25;
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
