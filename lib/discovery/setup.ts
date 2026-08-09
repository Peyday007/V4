import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { listConnectors } from './connector';
import { ensureConnectorsRegistered } from './connectors';
import { hasCredential } from './http';

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

    if (existing) {
      // The operator's enable/disable choice is theirs; only the descriptive
      // fields are refreshed from code.
      await prisma.dataSource.update({ where: { id: existing.id }, data: shared });
      result.updated.push(connector.key);
    } else {
      await prisma.dataSource.create({
        data: { orgId, key: connector.key, isEnabled: shouldEnable, rateLimitPerMin: 20, ...shared },
      });
      result.created.push(connector.key);
    }
  }

  return result;
}

/**
 * Dallas–Fort Worth, as a first market rather than a built-in assumption.
 *
 * The Socrata dataset identifiers below are the pieces most likely to need
 * correcting: portals rename and retire datasets, and a stale identifier
 * produces a 404 rather than wrong data. `npm run discovery:probe` checks them
 * against the live portal, and Markets in the interface is where they get
 * fixed — no deployment involved.
 */
export const STARTER_MARKET = {
  name: 'Dallas–Fort Worth',
  slug: 'dfw',
  kind: 'metro',
  state: 'TX',
  centerLat: 32.7767,
  centerLng: -96.797,
  radiusMeters: 45_000,
  cities: ['Dallas', 'Fort Worth', 'Plano', 'Irving', 'Arlington', 'Garland', 'Frisco'],
  counties: ['Dallas County', 'Tarrant County', 'Collin County', 'Denton County'],
  sourceConfig: {
    socrata: [
      {
        domain: 'www.dallasopendata.com',
        datasetId: 'e7gq-4sah',
        label: 'Dallas building permit',
        dateColumn: 'issued_date',
        columns: {
          description: 'work_description',
          address: 'address',
          city: 'city',
          value: 'estimated_cost',
          workType: 'permit_type',
          permitNumber: 'permit_number',
          owner: 'owner_name',
          status: 'status',
        },
      },
    ],
    samState: 'TX',
  },
} as const;

export async function ensureStarterMarket(orgId: string): Promise<{ created: boolean; id: string }> {
  const existing = await prisma.market.findFirst({ where: { orgId } });
  if (existing) return { created: false, id: existing.id };

  const market = await prisma.market.create({
    data: {
      orgId,
      name: STARTER_MARKET.name,
      slug: STARTER_MARKET.slug,
      kind: STARTER_MARKET.kind,
      state: STARTER_MARKET.state,
      centerLat: STARTER_MARKET.centerLat,
      centerLng: STARTER_MARKET.centerLng,
      radiusMeters: STARTER_MARKET.radiusMeters,
      cities: [...STARTER_MARKET.cities],
      counties: [...STARTER_MARKET.counties],
      sourceConfig: STARTER_MARKET.sourceConfig as object,
      isDefault: true,
      isEnabled: true,
    },
  });

  return { created: true, id: market.id };
}
