import type { Company, CompanyRole, DataSource } from '@prisma/client';
import { prisma } from '@/lib/db';
import { recordActivity } from '@/lib/audit';
import { classifyCompanyRole } from '@/lib/ai/classify';
import { recordDecision } from '@/lib/ai/decisions';
import { contentHash, getConnector, type RawRecord } from './connector';
import { ensureConnectorsRegistered } from './connectors';
import { detectSignals } from './signals';

export type DiscoveryRunResult = {
  dataSourceKey: string;
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
}): Promise<DiscoveryRunResult> {
  ensureConnectorsRegistered();

  const dataSource = await prisma.dataSource.findFirst({
    where: { id: params.dataSourceId, orgId: params.orgId },
  });
  if (!dataSource) throw new Error('Data source not found');
  if (!dataSource.isEnabled) throw new Error(`Data source ${dataSource.key} is disabled`);

  const connector = getConnector(dataSource.connector);
  if (!connector) throw new Error(`No connector registered for "${dataSource.connector}"`);

  const result: DiscoveryRunResult = {
    dataSourceKey: dataSource.key,
    recordsFetched: 0,
    evidenceCreated: 0,
    signalsCreated: 0,
    signalsDuplicate: 0,
    companiesCreated: 0,
    errors: [],
  };

  let records: RawRecord[] = [];
  try {
    records = await connector.fetch({
      orgId: params.orgId,
      dataSourceId: dataSource.id,
      config: { ...(dataSource.config as Record<string, unknown>), ...(params.configOverride ?? {}) },
      maxRecords: params.maxRecords ?? 50,
      since: dataSource.lastRunAt ?? undefined,
    });
  } catch (error) {
    result.errors.push(`fetch failed: ${String(error)}`);
    await prisma.dataSource.update({
      where: { id: dataSource.id },
      data: { lastRunAt: new Date(), lastRunStatus: `error: ${String(error).slice(0, 200)}` },
    });
    return result;
  }

  result.recordsFetched = records.length;

  for (const record of records) {
    try {
      const outcome = await ingestRecord({ orgId: params.orgId, dataSource, connectorKey: connector.key, record, sourceType: connector.sourceType, defaultCategory: connector.defaultCategory });
      result.evidenceCreated += outcome.evidenceCreated ? 1 : 0;
      result.companiesCreated += outcome.companyCreated ? 1 : 0;
      result.signalsCreated += outcome.signalsCreated;
      result.signalsDuplicate += outcome.signalsDuplicate;
    } catch (error) {
      result.errors.push(`${record.externalId}: ${String(error)}`);
    }
  }

  await prisma.dataSource.update({
    where: { id: dataSource.id },
    data: {
      lastRunAt: new Date(),
      lastRunStatus: result.errors.length ? `partial (${result.errors.length} errors)` : 'ok',
    },
  });

  return result;
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
    });
    company = resolved.company;
    outcome.companyCreated = resolved.created;
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
          discoveredAt: record.observedAt ?? new Date(),
          createdByProcess: `discovery:${params.connectorKey}`,
          contentHash: hash,
        },
      });
  outcome.evidenceCreated = !existingEvidence;

  // 3. Signal detection over title + excerpt.
  const text = `${record.title}\n${record.excerpt}`;
  const detected = detectSignals(text);

  for (const hit of detected) {
    const dedupe = contentHash([hit.definition.key, company?.id ?? record.companyName ?? '', record.externalId]);
    const existing = await prisma.discoverySignal.findUnique({
      where: { orgId_dedupeHash: { orgId, dedupeHash: dedupe } },
    });
    if (existing) {
      outcome.signalsDuplicate += 1;
      continue;
    }

    await prisma.discoverySignal.create({
      data: {
        orgId,
        dataSourceId: dataSource.id,
        evidenceId: evidence.id,
        companyId: company?.id ?? null,
        category: hit.definition.category,
        signalKey: hit.definition.key,
        headline: `${hit.definition.label}${company ? ` — ${company.legalName}` : ''}`,
        detail: `${record.title}. Matched: ${hit.matches.join(' | ')}`,
        location: record.location ?? null,
        strength: hit.strength,
        confidence: Math.min(0.75, 0.35 + hit.matches.length * 0.1),
        status: 'NEW',
        dedupeHash: dedupe,
        observedAt: record.observedAt ?? new Date(),
      },
    });
    outcome.signalsCreated += 1;
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

/** Runs every enabled source for an org. */
export async function runAllDiscovery(orgId: string): Promise<DiscoveryRunResult[]> {
  const sources = await prisma.dataSource.findMany({ where: { orgId, isEnabled: true } });
  const results: DiscoveryRunResult[] = [];
  for (const source of sources) {
    try {
      results.push(await runDiscoveryForSource({ orgId, dataSourceId: source.id }));
    } catch (error) {
      results.push({
        dataSourceKey: source.key,
        recordsFetched: 0,
        evidenceCreated: 0,
        signalsCreated: 0,
        signalsDuplicate: 0,
        companiesCreated: 0,
        errors: [String(error)],
      });
    }
  }
  return results;
}
