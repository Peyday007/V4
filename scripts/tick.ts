/**
 * One-shot operations tick. Intended for a scheduler (cron, Cloud Scheduler)
 * in deployments that do not run a dedicated worker process.
 *
 *   npm run ops:tick            process queued jobs for every org
 *   npm run ops:tick -- --plan  also run discovery and regenerate the daily plan
 */
import { PrismaClient } from '@prisma/client';
import { enqueue } from '../lib/jobs/queue';
import { processJobs } from '../lib/jobs/runner';

const prisma = new PrismaClient();

async function main() {
  const withPlan = process.argv.includes('--plan');
  const orgs = await prisma.organization.findMany({ select: { id: true, name: true } });

  for (const org of orgs) {
    if (withPlan) {
      await enqueue({ orgId: org.id, kind: 'discovery.run_all', priority: 20 });
      await enqueue({ orgId: org.id, kind: 'followup.generate', priority: 40 });
      await enqueue({ orgId: org.id, kind: 'planning.daily', priority: 90 });
      await enqueue({ orgId: org.id, kind: 'analytics.snapshot', priority: 95 });
    }
    let total = 0;
    for (let pass = 0; pass < 20; pass++) {
      const result = await processJobs(25);
      total += result.processed;
      if (result.processed === 0) break;
    }
    console.info(`[tick] ${org.name}: ${total} job(s) processed`);
  }
}

main()
  .catch((error) => {
    console.error('[tick] failed:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
