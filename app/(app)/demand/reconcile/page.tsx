import Link from 'next/link';
import { requirePagePermission } from '@/lib/auth/page';
import { can } from '@/lib/auth/session';
import { reconciliationPreview } from '@/lib/demand/reconcile';
import { Reconciliation } from '@/components/Reconciliation';

export const dynamic = 'force-dynamic';

/**
 * The board as it would be built today.
 *
 * The competition — one event, one primary thesis — arrived after two hundred
 * routes already existed. Everything before it was built under the old rule,
 * where every playbook that could plausibly read an event produced a route, and
 * the result is still on the board: one licence record wearing four hypotheses,
 * each of which looks like an opportunity to whoever opens it.
 *
 * This page changes nothing. It re-runs the competition over what exists and
 * reports what would happen, and the closing is a separate act with a separate
 * permission and an explicit list. The reason that matters is not caution for
 * its own sake — some of those routes have been called, and closing a record
 * somebody spoke to a person about destroys the only evidence of the
 * conversation.
 */
export default async function ReconcilePage({ searchParams }: { searchParams: { dataMode?: string } }) {
  const user = await requirePagePermission('discovery.read');
  const dataMode = searchParams.dataMode === 'TEST' ? 'TEST' : 'PRODUCTION';
  const preview = await reconciliationPreview({ orgId: user.orgId, dataMode });

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Reconcile the board</h1>
          <p>
            What the board would look like if it had been built under today&rsquo;s rule, held against what it
            is. Nothing on this page has been changed.
          </p>
        </div>
        <Link href="/demand" className="btn secondary">Back to the board</Link>
      </div>

      <div className="alert small">
        <strong>{preview.totalRoutes} open opportunit{preview.totalRoutes === 1 ? 'y' : 'ies'}</strong> on the{' '}
        {dataMode.toLowerCase()} board.{' '}
        {preview.eventsWithMultipleRoutes} event(s) support more than one each — those are the only ones
        examined, because a single route is not refraction whatever it scores.
      </div>

      <Reconciliation preview={preview} canApply={can(user, 'campaign.authorise') && can(user, 'deal.write')} />
    </>
  );
}
