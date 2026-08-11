import Link from 'next/link';
import { requirePagePermission } from '@/lib/auth/page';
import { nextCallable } from '@/lib/demand/queue';
import { loadCallCard } from '@/lib/demand/callCard';
import { CallerWorkspace } from '@/components/CallerWorkspace';

export const dynamic = 'force-dynamic';

/**
 * The caller workspace.
 *
 * One opportunity at a time. The first card is chosen on the server using the
 * same eligibility clause as the Call now view, so opening this page and
 * looking at the top of the board can never disagree.
 *
 * A `route` parameter opens a specific opportunity — the "Work" button on a
 * row. It still goes through the same loader, so a do-not-contact record
 * reached by a hand-made URL arrives with a banner rather than a dial pad.
 */
export default async function CallPage({ searchParams }: { searchParams: { route?: string } }) {
  const user = await requirePagePermission('discovery.run');

  const routeId = searchParams.route ?? (await nextCallable({ orgId: user.orgId }))?.routeId ?? null;
  const card = routeId ? await loadCallCard({ orgId: user.orgId, routeId }) : null;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Calling</h1>
          <p>One opportunity at a time. Save what happened and it moves you straight to the next one.</p>
        </div>
        <Link href="/demand" className="btn secondary">Back to board</Link>
      </div>

      <CallerWorkspace
        initial={card}
        message={card ? null : 'Nothing in the calling queue. Check Follow-ups, or Research for records with no number.'}
      />
    </>
  );
}
