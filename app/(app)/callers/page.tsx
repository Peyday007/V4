import { requirePageAny } from '@/lib/auth/page';
import { can } from '@/lib/auth/session';
import { roster } from '@/lib/caller/roster';
import { sandboxState } from '@/lib/caller/sandbox';
import { BUCKETS, BUCKET_EXPLANATIONS, BUCKET_LABELS, eligibilityCounts } from '@/lib/demand/eligibility';
import { CallerFloor } from '@/components/CallerFloor';

export const dynamic = 'force-dynamic';

/**
 * The calling floor.
 *
 * Two things changed here and both were correctness rather than layout.
 *
 * The list is now people with caller profiles. It used to be every active user
 * joined to their role, so the owner, the administrator, the finance reviewer
 * and the researcher all appeared as callers with an "Issue PIN" button beside
 * their names.
 *
 * The callable count now comes from the shared eligibility expression rather
 * than from SQL written on this page. The old query counted any live tiered
 * route with no packet item — no phone number required, no check on snoozes,
 * suppression or business hours — which is why it reported 152 callable while
 * the demand board reported 17 callable and 135 needing research. The two
 * numbers were measuring different things and neither said so.
 */
export default async function CallersPage() {
  const user = await requirePageAny('call.assignment.read.all', 'admin.users');

  const [callers, counts, sandbox] = await Promise.all([
    roster({ orgId: user.orgId, includeInactive: true }),
    eligibilityCounts({ orgId: user.orgId, mode: 'PRODUCTION' }),
    sandboxState(user.orgId),
  ]);

  return (
    <CallerFloor
      callers={callers as never}
      buckets={BUCKETS.map((key) => ({
        key,
        label: BUCKET_LABELS[key],
        because: BUCKET_EXPLANATIONS[key],
        count: counts[key],
      }))}
      callableUnassigned={counts.callableUnassigned}
      sandbox={sandbox}
      canManageUsers={can(user, 'admin.users')}
      canAssign={can(user, 'call.assignment.write')}
    />
  );
}
