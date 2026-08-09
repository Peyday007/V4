/**
 * Installs business paths, a first market and the live data sources.
 *
 * Safe to re-run: everything here is idempotent, and it never enables a source
 * whose credential is missing or overrides an enable/disable choice already
 * made in the interface.
 */

import { prisma } from '@/lib/db';
import { ensureDefaultPaths } from '@/lib/paths';
import { ensureStarterMarket, installLiveSources } from '@/lib/discovery/setup';

async function main() {
  const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!org) {
    console.error('No organisation found. Run the seed first.');
    process.exit(1);
  }

  const paths = await ensureDefaultPaths(org.id);
  const market = await ensureStarterMarket(org.id);
  const sources = await installLiveSources(org.id);

  console.log(`Organisation:  ${org.name}`);
  console.log(`Business paths: ${paths} added (${await prisma.businessPath.count({ where: { orgId: org.id } })} total)`);
  console.log(`Market:         ${market.created ? 'created starter market' : 'already configured'}`);
  console.log(`Live sources:   ${sources.created.length} created, ${sources.updated.length} updated`);

  if (sources.disabledMissingCredential.length > 0) {
    console.log('');
    console.log('Installed but left disabled — no credential set:');
    for (const key of sources.disabledMissingCredential) console.log(`  • ${key}`);
    console.log('Set the key in the environment, then enable the source under Administration.');
  }

  console.log('');
  console.log('Next: npm run discovery:probe   (checks each source actually responds)');

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
