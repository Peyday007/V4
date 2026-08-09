/**
 * Live connector probe.
 *
 * Contract tests prove the connectors parse the documented response shape. They
 * cannot prove the remote endpoint still returns it — a retired Socrata dataset
 * or a renamed field breaks discovery in a way no fixture will ever catch. This
 * script is the check that does, and it must be run somewhere with outbound
 * network access and the relevant credentials.
 *
 *   npx tsx scripts/probe.ts               # every live source, default market
 *   npx tsx scripts/probe.ts socrata       # one source
 *
 * It writes nothing to the database. Failures here are configuration problems,
 * not code problems, and the output says which.
 */

import { prisma } from '@/lib/db';
import { ensureConnectorsRegistered } from '@/lib/discovery/connectors';
import { listConnectors, type MarketContext } from '@/lib/discovery/connector';
import { hasCredential } from '@/lib/discovery/http';
import { resolveMarket } from '@/lib/discovery/run';

const filter = process.argv[2]?.toLowerCase();

async function main() {
  ensureConnectorsRegistered();

  const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!org) {
    console.error('No organisation found. Run the seed first.');
    process.exit(1);
  }

  const market = await resolveMarket({ orgId: org.id });
  console.log(`Organisation: ${org.name}`);
  console.log(market ? `Market: ${market.name} (${market.slug})` : 'Market: none configured');
  console.log('');

  const connectors = listConnectors().filter((c) => c.isLive && (!filter || c.key.includes(filter)));
  if (connectors.length === 0) {
    console.error(filter ? `No live connector matching "${filter}".` : 'No live connectors registered.');
    process.exit(1);
  }

  let failures = 0;

  for (const connector of connectors) {
    process.stdout.write(`${connector.key} … `);

    if (connector.credentialEnvVar && !hasCredential(connector.credentialEnvVar)) {
      console.log(`SKIPPED — ${connector.credentialEnvVar} is not set`);
      continue;
    }
    if (connector.requiresMarket && !market) {
      console.log('SKIPPED — needs a market, none configured');
      continue;
    }

    const started = Date.now();
    try {
      const records = await connector.fetch({
        orgId: org.id,
        dataSourceId: 'probe',
        config: {},
        maxRecords: 5,
        market: market as MarketContext | null,
        credentialEnvVar: connector.credentialEnvVar ?? null,
        rateLimitPerMin: 20,
      });

      const elapsed = Date.now() - started;
      if (records.length === 0) {
        // Zero results is not automatically a failure — a narrow market on a
        // quiet week genuinely returns nothing — but it is worth flagging,
        // because it looks identical to a broken query.
        console.log(`OK but EMPTY in ${elapsed}ms. Query reached the source and returned no rows; widen the market or check the dataset configuration.`);
        continue;
      }

      console.log(`OK — ${records.length} record(s) in ${elapsed}ms`);
      for (const record of records.slice(0, 3)) {
        console.log(`    • [${record.leadRole ?? 'UNKNOWN'}/${record.segment ?? 'MIXED'}] ${record.title.slice(0, 90)}`);
        console.log(`      ${record.sourceUrl ?? 'no source url'}`);
        if (record.contact?.phone || record.contact?.email) {
          console.log(`      contact: ${[record.contact.phone, record.contact.email].filter(Boolean).join(' / ')}`);
        }
      }
    } catch (error) {
      failures += 1;
      console.log(`FAILED — ${String(error).slice(0, 300)}`);
    }
  }

  console.log('');
  console.log(failures === 0 ? 'All probed sources reachable.' : `${failures} source(s) failed.`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
