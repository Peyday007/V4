import { openRoom } from '@/lib/room/rooms';
import '../../room.css';

export const dynamic = 'force-dynamic';
export const metadata = { robots: { index: false, follow: false, nocache: true } };

/**
 * The page after the prospect acts.
 *
 * A separate URL so a refresh cannot repost the form. It reads the room in
 * preview mode — the prospect has already been counted as opening it, and
 * counting them again for landing on the acknowledgement would inflate the one
 * number this feature produces.
 */
export default async function RoomThanksPage({
  params,
  searchParams,
}: {
  params: { token: string };
  searchParams: { ok?: string };
}) {
  const view = await openRoom({ token: params.token, preview: true });
  const organisation = view?.content.organisation ?? null;
  const failed = searchParams.ok === '0';

  return (
    <main className="room" data-testid="room-thanks">
      <h1>{failed ? 'That link is no longer live' : 'Thank you'}</h1>
      <p className="room-lede">
        {failed
          ? 'It has either expired or been closed. If you still want the information, replying to the message it came in reaches a person.'
          : 'We have this, and somebody will come back to you. Nothing further is needed from you now.'}
      </p>
      {organisation && !failed && (
        <p className="room-source">Regarding {organisation}.</p>
      )}
    </main>
  );
}
