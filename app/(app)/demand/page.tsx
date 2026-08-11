import Link from 'next/link';
import { requirePagePermission } from '@/lib/auth/page';
import { filterOptions } from '@/lib/demand/queue';
import { DemandQueue } from '@/components/DemandQueue';

export const dynamic = 'force-dynamic';

/**
 * The demand board.
 *
 * A work queue, not a report. The engine's evidence and reasoning are all still
 * here — one click behind each row rather than rendered 152 times into a page
 * nobody could read.
 *
 * Source health lives on its own page now. A connector warning is worth seeing
 * and is not worth putting between an operator and their first call.
 */
export default async function DemandPage() {
  const user = await requirePagePermission('discovery.read');
  const options = await filterOptions(user.orgId);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Demand</h1>
          <p>
            Dated commercial events, ranked by what can actually be worked. Contactable opportunities sort above
            uncontactable ones of the same tier, because a score you cannot ring is not the best use of the next ten
            minutes.
          </p>
        </div>
        <Link href="/demand/sources" className="btn secondary">Source health</Link>
      </div>

      <DemandQueue options={options} />
    </>
  );
}
