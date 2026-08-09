import type { Company, CompanyRole, DataOrigin, DataSource, LeadRole, MarketSegment } from '@prisma/client';
import { prisma } from '@/lib/db';
import { recordActivity } from '@/lib/audit';
import { classifyCompanyRole } from '@/lib/ai/classify';
import { recordDecision } from '@/lib/ai/decisions';
import type { BusinessPath } from '@prisma/client';
import { contentHash, getConnector, type MarketContext, type RawRecord } from './connector';
import { ensureConnectorsRegistered } from './connectors';
import { hasCredential } from './http';
import { detectSignals } from './signals';
import { choosePathFor, getActivePaths } from '@/lib/paths';

export type DiscoveryRunResult = {
  dataSourceKey: string;
  marketName: string | null;
  isLive: boolean;
  recordsFetched: number;
  evidenceCreated: number;
  signalsCreated: number;
  signalsDuplicate: number;
  companiesCreated: number;
  errors: string[];
};

/**
 * Runs one data source end to end: fetch -> evidence -> company resolution ->
 * signal detection. De-duplication happens at both the evidence and signal
 * layer so re-running a source is safe and idempotent.
 */
export async function runDiscoveryForSource(params: {
  orgId: string;
  dataSourceId: string;
  maxRecords?: number;
  configOverride?: Record<string, unknown>;
  /** Which market to search. Defaults to the source's own, then the org default. */
  marketId?: string;
}): Promise<DiscoveryRunResult> {
  ensureConnectorsRegistered();

  const dataSource = await prisma.dataSource.findFirst({
    where: { id: params.dataSourceId, orgId: params.orgId },
  });
  if (!dataSource) throw new Error('Data source not found');
  if (!dataSource.isEnabled) throw new Error(`Data source ${dataSource.key} is disabled`);

  const connector = getConnector(dataSource.connector);
  if (!connector) throw new Error(`No connector registered for "${dataSource.connector}"`);

  const market = await resolveMarket({
    orgId: params.orgId,
    marketId: params.marketId ?? dataSource.marketId ?? undefined,
  });

  const result: DiscoveryRunResult = {
    dataSourceKey: dataSource.key,
    marketName: market?.name ?? null,
    isLive: connector.isLive,
    recordsFetched: 0,
    evidenceCreated: 0,
    signalsCreated: 0,
    signalsDuplicate: 0,
    companiesCreated: 0,
    errors: [],
  };

  // A geographic connector with no market would otherwise search nowhere and
  // report success. Failing loudly here is the difference between "no leads
  // today" and "no leads ever, silently".
  if (connector.requiresMarket && !market) {
    const message = `${dataSource.name} needs a market to search. Add one under Markets and enable it.`;
    result.errors.push(message);
    await recordSourceOutcome(dataSource.id, { status: `error: ${message}`, failed: true, records: 0 });
    return result;
  }

  if (!hasCredential(connector.credentialEnvVar)) {
    const message = `${dataSource.name} needs ${connector.credentialEnvVar}, which is not set.`;
    result.errors.push(message);
    await recordSourceOutcome(dataSource.id, { status: `error: ${message}`, failed: true, records: 0 });
    return result;
  }

  let records: RawRecord[] = [];
  try {
    records = await connector.fetch({
      orgId: params.orgId,
      dataSourceId: dataSource.id,
      config: { ...(dataSource.config as Record<string, unknown>), ...(params.configOverride ?? {}) },
      maxRecords: params.maxRecords ?? 50,
      since: dataSource.lastRunAt ?? undefined,
      market,
      credentialEnvVar: connector.credentialEnvVar ?? null,
      rateLimitPerMin: dataSource.rateLimitPerMin,
    });
  } catch (error) {
    result.errors.push(`fetch failed: ${String(error)}`);
    await recordSourceOutcome(dataSource.id, { status: `error: ${String(error).slice(0, 200)}`, failed: true, records: 0 });
    return result;
  }

  result.recordsFetched = records.length;

  const origin: DataOrigin = connector.isLive ? 'LIVE_DISCOVERY' : 'SEED_DEMO';
  // Loaded once per run rather than per record: paths change rarely and a
  // record loop can be hundreds long.
  const paths = await getActivePaths(params.orgId);

  for (const record of records) {
    try {
      const outcome = await ingestRecord({
        orgId: params.orgId,
        dataSource,
        connectorKey: connector.key,
        record,
        sourceType: connector.sourceType,
        defaultCategory: connector.defaultCategory,
        origin,
        marketId: market?.id ?? null,
        paths,
      });
      result.evidenceCreated += outcome.evidenceCreated ? 1 : 0;
      result.companiesCreated += outcome.companyCreated ? 1 : 0;
      result.signalsCreated += outcome.signalsCreated;
      result.signalsDuplicate += outcome.signalsDuplicate;
    } catch (error) {
      result.errors.push(`${record.externalId}: ${String(error)}`);
    }
  }

  await recordSourceOutcome(dataSource.id, {
    status: result.errors.length ? `partial (${result.errors.length} errors)` : 'ok',
    failed: false,
    records: result.recordsFetched,
  });

  return result;
}

async function recordSourceOutcome(
  dataSourceId: string,
  outcome: { status: string; failed: boolean; records: number },
): Promise<void> {
  await prisma.dataSource.update({
    where: { id: dataSourceId },
    data: {
      lastRunAt: new Date(),
      lastRunStatus: outcome.status,
      lastRecordCount: outcome.records,
      ...(outcome.failed
        ? { lastErrorAt: new Date(), consecutiveFailures: { increment: 1 } }
        : { consecutiveFailures: 0 }),
    },
  });
}

/** The source's own market, else the org default, else the first enabled one. */
export async function resolveMarket(params: {
  orgId: string;
  marketId?: string;
}): Promise<MarketContext | null> {
  const market = params.marketId
    ? await prisma.market.findFirst({ where: { id: params.marketId, orgId: params.orgId, isEnabled: true } })
    : ((await prisma.market.findFirst({ where: { orgId: params.orgId, isEnabled: true, isDefault: true } })) ??
      (await prisma.market.findFirst({ where: { orgId: params.orgId, isEnabled: true }, orderBy: { createdAt: 'asc' } })));

  if (!market) return null;

  return {
    id: market.id,
    name: market.name,
    slug: market.slug,
    state: market.state,
    centerLat: market.centerLat,
    centerLng: market.centerLng,
    radiusMeters: market.radiusMeters,
    postalCodes: market.postalCodes,
    cities: market.cities,
    counties: market.counties,
    sourceConfig: (market.sourceConfig ?? {}) as Record<string, unknown>,
  };
}

/**
 * Runs every enabled source across every enabled market.
 *
 * Sources bound to one market run only there; unbound sources run once per
 * market, because "find cleaning providers" means something different in each
 * one. Non-geographic sources run once overall.
 */
export async function runDiscoveryAcrossMarkets(params: {
  orgId: string;
  maxRecordsPerRun?: number;
  liveOnly?: boolean;
}): Promise<DiscoveryRunResult[]> {
  ensureConnectorsRegistered();

  const [sources, markets] = await Promise.all([
    prisma.dataSource.findMany({ where: { orgId: params.orgId, isEnabled: true } }),
    prisma.market.findMany({ where: { orgId: params.orgId, isEnabled: true }, orderBy: { isDefault: 'desc' } }),
  ]);

  const results: DiscoveryRunResult[] = [];

  for (const source of sources) {
    const connector = getConnector(source.connector);
    if (!connector) continue;
    if (params.liveOnly && !connector.isLive) continue;

    const targets = connector.requiresMarket
      ? source.marketId
        ? markets.filter((m) => m.id === source.marketId)
        : markets
      : [null];

    for (const target of targets) {
      results.push(
        await runDiscoveryForSource({
          orgId: params.orgId,
          dataSourceId: source.id,
          maxRecords: params.maxRecordsPerRun ?? 50,
          marketId: target?.id,
        }),
      );
    }
  }

  return results;
}

type IngestOutcome = {
  evidenceCreated: boolean;
  companyCreated: boolean;
  signalsCreated: number;
  signalsDuplicate: number;
};

async function ingestRecord(params: {
  orgId: string;
  dataSource: DataSource;
  connectorKey: string;
  record: RawRecord;
  sourceType: import('@prisma/client').SourceType;
  defaultCategory: import('@prisma/client').SignalCategory;
  origin: DataOrigin;
  marketId: string | null;
  paths: BusinessPath[];
}): Promise<IngestOutcome> {
  const { orgId, dataSource, record } = params;
  const outcome: IngestOutcome = { evidenceCreated: false, companyCreated: false, signalsCreated: 0, signalsDuplicate: 0 };

  // 1. Resolve the company before evidence, so evidence can attach to it.
  let company: Company | null = null;
  if (record.companyName) {
    const resolved = await resolveCompany({
      orgId,
      name: record.companyName,
      website: record.companyWebsite,
      // Only store the excerpt as the company's description when it is the
      // company describing itself; otherwise it describes a transaction.
      description: record.describesSubject ? record.excerpt : null,
      situationText: record.excerpt,
      roleHint: record.subjectRole,
      inferRoleFromText: record.describesSubject === true,
      location: record.location,
      state: record.state,
      origin: params.origin,
      externalPlaceId: record.externalPlaceId,
    });
    company = resolved.company;
    outcome.companyCreated = resolved.created;

    // Contact detail the source published. Written only when the source
    // actually carried it — an empty contact row is worse than none, because
    // it makes a lead look reachable when nobody can reach it.
    if (record.contact && (record.contact.phone || record.contact.email)) {
      await upsertSourcedContact({ orgId, companyId: company.id, contact: record.contact, origin: params.origin });
    }
  }

  // 2. Evidence is content-hashed; re-running a source updates lastCheckedAt
  //    rather than duplicating the record.
  const hash = contentHash([dataSource.key, record.externalId, record.excerpt]);
  const existingEvidence = await prisma.sourceEvidence.findUnique({
    where: { orgId_contentHash: { orgId, contentHash: hash } },
  });

  const evidence = existingEvidence
    ? await prisma.sourceEvidence.update({
        where: { id: existingEvidence.id },
        data: { lastCheckedAt: new Date(), companyId: company?.id ?? existingEvidence.companyId },
      })
    : await prisma.sourceEvidence.create({
        data: {
          orgId,
          dataSourceId: dataSource.id,
          companyId: company?.id ?? null,
          sourceType: params.sourceType,
          sourceUrl: record.sourceUrl ?? null,
          title: record.title,
          excerpt: record.excerpt,
          rawPayload: (record.payload ?? {}) as object,
          // Source material is evidence, not confirmation. A human or a call
          // has to confirm anything that drives a commitment.
          status: 'INFERRED',
          confidence: 0.55,
          origin: params.origin,
          discoveredAt: record.observedAt ?? new Date(),
          createdByProcess: `discovery:${params.connectorKey}`,
          contentHash: hash,
        },
      });
  outcome.evidenceCreated = !existingEvidence;

  // 3. Signal detection over title + excerpt.
  const text = `${record.title}\n${record.excerpt}`;
  const detected = detectSignals(text);

  /** Attributes every signal from this record shares, whatever triggered it. */
  const leadFields = {
    origin: params.origin,
    marketId: params.marketId,
    leadRole: record.leadRole ?? leadRoleFromCompanyRole(record.subjectRole),
    segment: record.segment ?? ('MIXED' as MarketSegment),
    requiredService: record.requiredService ?? null,
    sourceUrl: record.sourceUrl ?? null,
    contactHint: (record.contact ?? {}) as object,
    lastSeenAt: new Date(),
  };

  for (const hit of detected) {
    const dedupe = contentHash([hit.definition.key, company?.id ?? record.companyName ?? '', record.externalId]);
    const existing = await prisma.discoverySignal.findUnique({
      where: { orgId_dedupeHash: { orgId, dedupeHash: dedupe } },
    });
    if (existing) {
      // Re-seeing a record is meaningful: it proves the lead is still live.
      // Refreshing rather than skipping is what keeps freshness honest.
      await prisma.discoverySignal.update({
        where: { id: existing.id },
        data: { lastSeenAt: new Date(), sourceUrl: leadFields.sourceUrl ?? existing.sourceUrl },
      });
      outcome.signalsDuplicate += 1;
      continue;
    }

    const category = record.category ?? hit.definition.category;
    await prisma.discoverySignal.create({
      data: {
        orgId,
        dataSourceId: dataSource.id,
        evidenceId: evidence.id,
        companyId: company?.id ?? null,
        pathId: choosePathFor(params.paths, { category, leadRole: leadFields.leadRole, segment: leadFields.segment })?.id ?? null,
        classificationEvidence: hit.matches.slice(0, 8),
        category,
        signalKey: hit.definition.key,
        headline: `${hit.definition.label}${company ? ` — ${company.legalName}` : ''}`,
        detail: `${record.title}. Matched: ${hit.matches.join(' | ')}`,
        location: record.location ?? null,
        strength: hit.strength,
        confidence: Math.min(0.75, 0.35 + hit.matches.length * 0.1),
        status: 'NEW',
        dedupeHash: dedupe,
        observedAt: record.observedAt ?? new Date(),
        ...leadFields,
        whyRelevant: record.whyRelevant ?? hit.definition.label,
        recommendedAction: recommendNextStep(leadFields.leadRole, category, Boolean(record.contact?.phone)),
      },
    });
    outcome.signalsCreated += 1;
  }

  // 4. A record can be a lead without matching any keyword rule.
  //
  // The rules were written for prose — award notices, job posts, press
  // releases. A place-directory listing has no prose to match, so under the
  // old behaviour every provider and every commercial premises found by a live
  // search produced exactly zero signals and vanished. When the connector has
  // told us what the record is, that is sufficient on its own.
  if (detected.length === 0 && record.leadRole && record.whyRelevant) {
    const signalKey = `sourced_${record.leadRole.toLowerCase()}`;
    const dedupe = contentHash([signalKey, company?.id ?? record.companyName ?? '', record.externalId]);
    const existing = await prisma.discoverySignal.findUnique({
      where: { orgId_dedupeHash: { orgId, dedupeHash: dedupe } },
    });

    if (existing) {
      await prisma.discoverySignal.update({ where: { id: existing.id }, data: { lastSeenAt: new Date() } });
      outcome.signalsDuplicate += 1;
    } else {
      const category = record.category ?? params.defaultCategory;
      await prisma.discoverySignal.create({
        data: {
          orgId,
          dataSourceId: dataSource.id,
          evidenceId: evidence.id,
          companyId: company?.id ?? null,
          pathId: choosePathFor(params.paths, { category, leadRole: record.leadRole, segment: leadFields.segment })?.id ?? null,
          // No keyword matched, so the evidence is what the source itself
          // asserted about the record rather than text we recognised.
          classificationEvidence: [
            `Source classified as ${record.leadRole.toLowerCase()}`,
            ...(record.requiredService ? [`Service: ${record.requiredService}`] : []),
            ...(record.payload?.retrievedFor ? [`Matched query: ${String(record.payload.retrievedFor)}`] : []),
          ],
          category,
          signalKey,
          headline: `${humaniseLeadRole(record.leadRole)}${company ? ` — ${company.legalName}` : ''}`,
          detail: record.title,
          location: record.location ?? null,
          // No keyword evidence, so this is weaker than a matched signal by
          // construction. It is a candidate to qualify, not a live need.
          strength: 0.4,
          confidence: 0.5,
          status: 'NEW',
          dedupeHash: dedupe,
          observedAt: record.observedAt ?? new Date(),
          ...leadFields,
          whyRelevant: record.whyRelevant,
          recommendedAction: recommendNextStep(record.leadRole, category, Boolean(record.contact?.phone)),
        },
      });
      outcome.signalsCreated += 1;
    }
  }

  if (company && outcome.signalsCreated > 0) {
    await recordActivity({
      orgId,
      companyId: company.id,
      actorType: 'ai',
      verb: 'discovery.signals_detected',
      summary: `${outcome.signalsCreated} signal(s) detected from ${dataSource.name}`,
      payload: { dataSource: dataSource.key, externalId: record.externalId },
    });
  }

  return outcome;
}

/** A company's standing role, narrowed to what it is to us in this record. */
export function leadRoleFromCompanyRole(role: CompanyRole | undefined): LeadRole {
  switch (role) {
    case 'BUYER':
      return 'BUYER';
    case 'SUBCONTRACTOR':
      return 'SUBCONTRACTOR';
    case 'SUPPLIER':
    case 'DISTRIBUTOR':
    case 'MANUFACTURER':
      return 'SUPPLIER';
    case 'PRIME_CONTRACTOR':
      return 'CONTRACTOR';
    case 'CARRIER':
      return 'PARTNER';
    default:
      return 'UNKNOWN';
  }
}

function humaniseLeadRole(role: LeadRole): string {
  const labels: Record<LeadRole, string> = {
    BUYER: 'Potential buyer identified',
    PROVIDER: 'Potential provider identified',
    SUPPLIER: 'Potential supply partner identified',
    PARTNER: 'Potential partner identified',
    CONTRACTOR: 'Contractor who subcontracts work identified',
    SUBCONTRACTOR: 'Potential subcontractor identified',
    UNKNOWN: 'Lead identified',
  };
  return labels[role];
}

/**
 * The single next step, decided deterministically.
 *
 * A lead without a next action is a to-do item disguised as intelligence. What
 * is missing usually determines the step: with no phone number the work is
 * research, with one it is a conversation, and which conversation depends on
 * which side of the deal the lead sits on.
 */
export function recommendNextStep(role: LeadRole, category: string, hasPhone: boolean): string {
  if (!hasPhone) {
    return 'Find a direct contact and decision-maker before assigning a call — no reachable number on the source record.';
  }
  switch (role) {
    case 'PROVIDER':
    case 'SUBCONTRACTOR':
      return 'Call to confirm capacity, service area, crew count, insurance and licensing, then qualify as a fulfilment partner.';
    case 'SUPPLIER':
      return 'Call to obtain wholesale pricing, stocked lines, minimum order and delivery terms.';
    case 'CONTRACTOR':
      return 'Call to ask about vendor registration and overflow work, and get onto the approved subcontractor list.';
    case 'BUYER':
      return category === 'DISTRIBUTION'
        ? 'Call to confirm current supplier, order frequency and spend on consumables, and identify the reorder decision-maker.'
        : 'Call to confirm the service need, incumbent provider, contract end date and who signs.';
    default:
      return 'Call to establish what this organisation buys or supplies before routing it to a path.';
  }
}

/**
 * Writes the contact a source published, without inventing one.
 *
 * Discovered contacts are never SMS-consented and are not assumed to be
 * mobiles: a number on a directory listing is a business line, and the SMS gate
 * is stricter than the calling gate for good reason.
 */
async function upsertSourcedContact(params: {
  orgId: string;
  companyId: string;
  contact: NonNullable<RawRecord['contact']>;
  origin: DataOrigin;
}): Promise<void> {
  const { orgId, companyId, contact } = params;
  const phone = contact.phone?.trim() || null;
  const email = contact.email?.trim() || null;
  if (!phone && !email) return;

  const existing = await prisma.contact.findFirst({
    where: {
      orgId,
      companyId,
      OR: [...(phone ? [{ phone }] : []), ...(email ? [{ email }] : [])],
    },
  });
  if (existing) return;

  const [firstName, ...rest] = (contact.name ?? '').trim().split(/\s+/).filter(Boolean);

  await prisma.contact.create({
    data: {
      orgId,
      companyId,
      // A main line with no named person is the normal case for a directory
      // listing. Saying so beats inventing a plausible name.
      firstName: firstName || 'Main',
      lastName: rest.join(' ') || (firstName ? '' : 'line'),
      phone,
      email,
      hasMobile: false,
      consentToSms: false,
      decisionAuthority: 'unknown',
    },
  });
}

/**
 * Company resolution: exact name match first, then normalised name, then a
 * website-host match. Deliberately conservative — a false merge corrupts the
 * graph far worse than a duplicate a reviewer can fix.
 */
export async function resolveCompany(params: {
  orgId: string;
  name: string;
  website?: string | null;
  /** Text the company wrote about itself. Safe to use for role inference. */
  description?: string | null;
  /** Text about a situation the company is involved in. Not role evidence. */
  situationText?: string | null;
  /** Role stated by the connector, based on the record type. Wins if present. */
  roleHint?: CompanyRole;
  /** Set only when `description` genuinely describes this company. */
  inferRoleFromText?: boolean;
  /** Provenance for a newly created company. Never downgrades an existing one. */
  origin?: DataOrigin;
  /** Stable place identifier, where the source provides one. */
  externalPlaceId?: string;
  location?: string | null;
  state?: string | null;
}): Promise<{ company: Company; created: boolean }> {
  const name = params.name.trim();

  const exact = await prisma.company.findFirst({
    where: { orgId: params.orgId, legalName: { equals: name, mode: 'insensitive' } },
  });
  if (exact) return { company: exact, created: false };

  if (params.website) {
    const host = safeHost(params.website);
    if (host) {
      const byHost = await prisma.company.findFirst({
        where: { orgId: params.orgId, website: { contains: host, mode: 'insensitive' } },
      });
      if (byHost) return { company: byHost, created: false };
    }
  }

  const normalized = normalizeCompanyName(name);
  const candidates = await prisma.company.findMany({
    where: { orgId: params.orgId },
    select: { id: true, legalName: true },
    take: 500,
  });
  const fuzzy = candidates.find((c) => normalizeCompanyName(c.legalName) === normalized);
  if (fuzzy) {
    const full = await prisma.company.findUnique({ where: { id: fuzzy.id } });
    if (full) return { company: full, created: false };
  }

  // Role resolution order: the connector's structural hint, then keyword
  // inference but only over self-description, then UNKNOWN. Guessing a role
  // from transaction text is how a buyer ends up filed as a supplier.
  const inferred = params.inferRoleFromText
    ? classifyCompanyRole({ description: params.description })
    : { role: 'UNKNOWN' as CompanyRole, confidence: 0.1, rationale: 'Source record describes a transaction, not the company; role not inferred from its text.' };
  const roleGuess = params.roleHint
    ? {
        role: params.roleHint,
        confidence: 0.7,
        rationale: `Role taken from the source record structure: the company is the subject of this record as ${params.roleHint.toLowerCase().replace(/_/g, ' ')}.`,
      }
    : inferred;

  const company = await prisma.company.create({
    data: {
      orgId: params.orgId,
      legalName: name,
      website: params.website ?? null,
      description: (params.description ?? params.situationText)?.slice(0, 1000) ?? null,
      companyRole: roleGuess.role,
      accountStage: 'DISCOVERED',
      origin: params.origin ?? 'LIVE_DISCOVERY',
      externalPlaceId: params.externalPlaceId ?? null,
      lastEnrichedAt: new Date(),
      locations: params.location
        ? {
            create: {
              label: 'Discovered',
              city: params.location.split(',')[0]?.trim() || null,
              state: params.state ?? params.location.split(',')[1]?.trim() ?? null,
              isHeadquarters: true,
            },
          }
        : undefined,
    },
  });

  await recordDecision({
    orgId: params.orgId,
    process: 'discovery.company_resolution',
    decision: `Created company "${name}" with inferred role ${roleGuess.role}`,
    reason: roleGuess.rationale,
    inputs: { name, website: params.website, location: params.location },
    outputs: { companyId: company.id, role: roleGuess.role },
    confidence: roleGuess.confidence,
    rulesApplied: params.roleHint ? ['connector_role_hint'] : ['company_role_lexicon'],
    modelName: 'deterministic',
    promptVersion: 'classify@2',
  });

  return { company, created: true };
}

export function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\b(inc|llc|l\.l\.c|ltd|corp|corporation|company|co|group|holdings|services|service)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeHost(url: string): string | null {
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).host.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Runs every enabled source for an org, once per market where the source needs
 * one. Kept as the entry point the job queue calls.
 */
export async function runAllDiscovery(orgId: string): Promise<DiscoveryRunResult[]> {
  try {
    return await runDiscoveryAcrossMarkets({ orgId });
  } catch (error) {
    return [
      {
        dataSourceKey: 'all',
        marketName: null,
        isLive: false,
        recordsFetched: 0,
        evidenceCreated: 0,
        signalsCreated: 0,
        signalsDuplicate: 0,
        companiesCreated: 0,
        errors: [String(error)],
      },
    ];
  }
}
