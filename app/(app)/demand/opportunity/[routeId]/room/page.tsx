import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePagePermission } from '@/lib/auth/page';
import { prisma } from '@/lib/db';
import { buildRoomContent } from '@/lib/room/content';
import { openRoom, LIVE_ROOM_STATES } from '@/lib/room/rooms';
import { DealRoomView } from '@/components/DealRoomView';
import '@/app/room/room.css';

export const dynamic = 'force-dynamic';

/**
 * The owner's preview.
 *
 * Renders through `DealRoomView` from the same snapshot the prospect would
 * get, and writes nothing — no open event, no counter, no state change. An
 * owner checking their own work must not appear in the engagement history as
 * the prospect reading it, or the one number this feature produces becomes
 * meaningless.
 *
 * Where no room exists yet, the current content is built and shown live, so
 * the owner can see what would be sent before committing to sending it.
 */
export default async function RoomPreviewPage({ params }: { params: { routeId: string } }) {
  const user = await requirePagePermission('deal.read');

  const room = await prisma.dealRoom.findFirst({
    where: { orgId: user.orgId, routeId: params.routeId, state: { in: LIVE_ROOM_STATES } },
    orderBy: { createdAt: 'desc' },
    select: { token: true, state: true, openCount: true, sentAt: true, expiresAt: true },
  });

  const view = room ? await openRoom({ token: room.token, preview: true }) : null;
  const content = view?.content ?? await buildRoomContent({ orgId: user.orgId, routeId: params.routeId });
  if (!content) notFound();

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Deal room preview</h1>
          <p>
            {room
              ? `Live — ${room.state.toLowerCase()}, opened ${room.openCount} time${room.openCount === 1 ? '' : 's'}, expires ${room.expiresAt.toISOString().slice(0, 10)}.`
              : 'Nothing has been created yet. This is what would be sent.'}
          </p>
        </div>
        <Link href={`/demand/opportunity/${params.routeId}`} className="btn secondary">Back to the record</Link>
      </div>

      {content.tooThinToSend && (
        <div className="alert warning" data-testid="too-thin">
          <strong>There is not enough here to send.</strong>
          <ul>
            {content.thinReasons.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
        </div>
      )}

      <DealRoomView content={content} mode="preview" />
    </>
  );
}
