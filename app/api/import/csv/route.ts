import { z } from 'zod';
import { requirePermission } from '@/lib/auth/session';
import { handleRouteError, json, rateLimit } from '@/lib/api';
import { clearBusinessData, importCsv, previewCsv } from '@/lib/import';
import { processJobs } from '@/lib/jobs/runner';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * First-party data in and demonstration data out.
 *
 * These are the two things a new deployment needs and neither existed: the CSV
 * connector was reachable only from code, and there was no way to remove the
 * seeded companies. Without both, the only way to start on real data was to
 * drop the database.
 */

const importSchema = z.object({
  csv: z.string().min(1, 'Paste or upload a CSV first.').max(2_000_000, 'File is too large — split it into batches of a few thousand rows.'),
  side: z.enum(['BUYER', 'PROVIDER']),
  /** Parse and report without writing. */
  dryRun: z.boolean().default(false),
});

export async function POST(request: Request) {
  try {
    const user = await requirePermission('company.write');
    const { csv, side, dryRun } = importSchema.parse(await request.json());

    if (dryRun) {
      return json({ dryRun: true, preview: previewCsv(csv) });
    }

    if (!rateLimit(`import:${user.orgId}`, 10, 60_000)) {
      return json({ error: 'Too many imports in a row. Wait a minute and try again.' }, 429);
    }

    const result = await importCsv({ orgId: user.orgId, csv, side, userId: user.id });

    // Imported companies are only useful once they have been scored and
    // matched, so drain whatever the write enqueued rather than leaving the
    // operator looking at a board that has not caught up yet.
    const drained = await processJobs(25);

    return json({ ...result, jobsProcessed: drained.processed });
  } catch (error) {
    return handleRouteError(error);
  }
}

const clearSchema = z.object({
  /** Typed by hand in the UI. Nothing about this should be a single click. */
  confirm: z.literal('DELETE DEMO DATA', {
    errorMap: () => ({ message: 'Type DELETE DEMO DATA exactly to confirm.' }),
  }),
});

export async function DELETE(request: Request) {
  try {
    // Deliberately the administration permission, not company.write. Removing
    // every company is a different kind of act from editing one.
    const user = await requirePermission('admin.config');
    clearSchema.parse(await request.json().catch(() => ({})));

    const counts = await clearBusinessData(user.orgId, user.id);
    return json({ cleared: counts });
  } catch (error) {
    return handleRouteError(error);
  }
}
