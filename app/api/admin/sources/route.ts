import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { audit } from '@/lib/audit';
import { handleRouteError, json } from '@/lib/api';
import { ensureConnectorsRegistered } from '@/lib/discovery/connectors';
import { getConnector } from '@/lib/discovery/connector';
import { hasCredential } from '@/lib/discovery/http';
import { installLiveSources } from '@/lib/discovery/setup';
import { runDiscoveryForSource } from '@/lib/discovery/run';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Turning a source on, and proving it works.
 *
 * Live sources install disabled when their credential is missing, which is
 * right — a source that fails every scheduled run is noise. But it left no way
 * to enable one after adding the key, so setting `GOOGLE_PLACES_API_KEY` did
 * nothing observable. This is that missing step, plus a test run so the answer
 * to "is it working" is a record count rather than an assumption.
 */

const schema = z.object({
  sourceId: z.string().min(1),
  action: z.enum(['enable', 'disable', 'test']),
  /** Which market to test against. Defaults to the source's own, then the org default. */
  marketId: z.string().optional(),
});

export async function POST(request: Request) {
  try {
    const user = await requirePermission('admin.integrations');
    const { sourceId, action, marketId } = schema.parse(await request.json());
    ensureConnectorsRegistered();

    const source = await prisma.dataSource.findFirst({ where: { id: sourceId, orgId: user.orgId } });
    if (!source) return json({ error: 'Data source not found' }, 404);

    const connector = getConnector(source.connector);
    if (!connector) return json({ error: `No connector registered for "${source.connector}"` }, 400);

    if (action === 'disable') {
      await prisma.dataSource.update({ where: { id: source.id }, data: { isEnabled: false } });
      await audit({ orgId: user.orgId, userId: user.id, action: 'source.disabled', entityType: 'DataSource', entityId: source.id });
      return json({ isEnabled: false });
    }

    // Enabling a source whose key is absent would queue a guaranteed failure on
    // every scheduled run. Refusing names the variable that is missing.
    if (!hasCredential(connector.credentialEnvVar)) {
      return json(
        {
          error:
            `${source.name} needs ${connector.credentialEnvVar}, which is not set in this environment. ` +
            `Add it, redeploy, then enable the source.`,
        },
        400,
      );
    }

    if (action === 'enable') {
      await prisma.dataSource.update({ where: { id: source.id }, data: { isEnabled: true, consecutiveFailures: 0 } });
      await audit({ orgId: user.orgId, userId: user.id, action: 'source.enabled', entityType: 'DataSource', entityId: source.id });
      return json({ isEnabled: true });
    }

    // test: a small real run against the live API, writing whatever it finds.
    // Deliberately not a dry run — "the credential works" and "the pipeline
    // produces leads" are different claims, and only the second one matters.
    const result = await runDiscoveryForSource({
      orgId: user.orgId,
      dataSourceId: source.id,
      maxRecords: 10,
      marketId,
    });

    await audit({
      orgId: user.orgId,
      userId: user.id,
      action: 'source.tested',
      entityType: 'DataSource',
      entityId: source.id,
      metadata: { fetched: result.recordsFetched, signals: result.signalsCreated, errors: result.errors.length },
    });

    return json({
      tested: true,
      market: result.marketName,
      fetched: result.recordsFetched,
      signalsCreated: result.signalsCreated,
      signalsDuplicate: result.signalsDuplicate,
      companiesCreated: result.companiesCreated,
      errors: result.errors.slice(0, 3),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * Re-runs source installation.
 *
 * Needed after adding a credential: it refreshes names, terms links and rate
 * limits from code, and reports which sources are still missing keys. It never
 * flips an enable/disable choice already made.
 */
export async function PUT() {
  try {
    const user = await requirePermission('admin.integrations');
    const result = await installLiveSources(user.orgId);
    return json(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
