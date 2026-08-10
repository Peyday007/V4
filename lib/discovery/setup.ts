import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { listConnectors } from './connector';
import { ensureConnectorsRegistered } from './connectors';
import { hasCredential } from './http';
import { ensureMarkets } from './markets';

/**
 * Installing live sources and a first market.
 *
 * A connector existing in code does nothing — discovery iterates DataSource
 * rows, so a source nobody inserted is a source that never runs. This is the
 * bridge, and it is idempotent so it can be called on every deploy.
 *
 * Live sources are installed **disabled** when their credential is missing.
 * The alternative is a source that fails on every scheduled run and fills the
 * health view with noise that means nothing except "you have not signed up for
 * that yet".
 */

export type SourceInstallResult = {
  created: string[];
  updated: string[];
  disabledMissingCredential: string[];
};

const SOURCE_NAMES: Record<string, string> = {
  socrata_open_data: 'Municipal open data (permits and licences)',
  google_places: 'Google Places business search',
  sam_gov_opportunities: 'SAM.gov federal opportunities',
  nppes_healthcare: 'CMS healthcare facility registry (nationwide)',
  usaspending_awards: 'USAspending federal award recipients (nationwide)',
};

/**
 * Requests per minute per source.
 *
 * A nationwide source partitions its query — NPPES issues one request per
 * state per taxonomy — so a limit tuned for a single-city portal throttles a
 * national sweep into never finishing. These are set to what each API is
 * documented and built to serve, not to one conservative number for everything.
 */
const RATE_LIMITS: Record<string, number> = {
  // Federal bulk-oriented APIs, no key, designed for programmatic use.
  nppes_healthcare: 90,
  usaspending_awards: 60,
  // Billed per request, so the limit is about cost control as much as courtesy.
  google_places: 60,
  // Non-federal keys allow roughly ten calls a day. One request per run.
  sam_gov_opportunities: 5,
  // Shared municipal infrastructure; be a good neighbour.
  socrata_open_data: 20,
};

/** Sources that stay off until the operator turns them on deliberately. */
const OFF_BY_DEFAULT = new Set([
  // Public-sector work carries long award and payment cycles. It is available,
  // but it should not be the first thing a new deployment fills its board with.
  'sam_gov_opportunities',
]);

export async function installLiveSources(orgId: string): Promise<SourceInstallResult> {
  ensureConnectorsRegistered();
  const result: SourceInstallResult = { created: [], updated: [], disabledMissingCredential: [] };

  for (const connector of listConnectors()) {
    if (!connector.isLive) continue;

    const credentialPresent = hasCredential(connector.credentialEnvVar);
    const shouldEnable = credentialPresent && !OFF_BY_DEFAULT.has(connector.key);
    if (!credentialPresent) result.disabledMissingCredential.push(connector.key);

    const existing = await prisma.dataSource.findUnique({
      where: { orgId_key: { orgId, key: connector.key } },
    });

    const shared = {
      name: SOURCE_NAMES[connector.key] ?? connector.key,
      sourceType: connector.sourceType,
      connector: connector.key,
      accessBasis: connector.accessBasis,
      isLive: true,
      termsUrl: connector.termsUrl ?? null,
      credentialEnvVar: connector.credentialEnvVar ?? null,
    } satisfies Partial<Prisma.DataSourceUncheckedCreateInput>;

    const rateLimitPerMin = RATE_LIMITS[connector.key] ?? 20;

    if (existing) {
      // The operator's enable/disable choice is theirs; only the descriptive
      // fields and the rate limit are refreshed from code.
      await prisma.dataSource.update({ where: { id: existing.id }, data: { ...shared, rateLimitPerMin } });
      result.updated.push(connector.key);
    } else {
      await prisma.dataSource.create({
        data: { orgId, key: connector.key, isEnabled: shouldEnable, rateLimitPerMin, ...shared },
      });
      result.created.push(connector.key);
    }
  }

  return result;
}

/**
 * Installs the nationwide market plus the metro presets.
 *
 * Nationwide is the default and is what makes the sources' national reach
 * actually reachable. The metros exist alongside it so leads can be routed to
 * whoever works that area, not because coverage depends on them.
 */
export async function ensureStarterMarket(orgId: string): Promise<{ created: boolean; id: string }> {
  const result = await ensureMarkets(orgId);
  const national = await prisma.market.findFirstOrThrow({
    where: { orgId, scope: 'NATIONAL' },
  });
  return { created: result.created.length > 0, id: national.id };
}
