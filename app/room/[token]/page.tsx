import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { openRoom } from '@/lib/room/rooms';
import { DealRoomView } from '@/components/DealRoomView';
import '../room.css';

export const dynamic = 'force-dynamic';

/**
 * The public Deal Room.
 *
 * Unauthenticated by design: the token is the authorisation, and the prospect
 * is not a user of this system and never will be. Three properties matter more
 * than anything on the page:
 *
 *   A wrong token is indistinguishable from one that never existed. Both are a
 *   404 with nothing in it, so the URL cannot be used to test whether we hold a
 *   record for a company.
 *
 *   Nothing here takes an id. There is no route id, company id or quote id in
 *   the URL or the markup, so a token grants exactly one page and no way to
 *   walk to a second.
 *
 *   Search engines are told not to index it, and the page carries a named
 *   company. That is a courtesy to the prospect rather than a security control
 *   — the token is the control — but a Deal Room turning up in search results
 *   for somebody's employer is a real harm regardless of how it happened.
 */
export const metadata = {
  robots: { index: false, follow: false, nocache: true },
};

export default async function PublicRoomPage({ params }: { params: { token: string } }) {
  const userAgent = headers().get('user-agent');
  const view = await openRoom({ token: params.token, userAgent });
  if (!view) notFound();

  return (
    <DealRoomView
      content={view.content}
      mode="public"
      token={params.token}
      closedReason={view.closedReason}
      alreadyRequested={view.proofStepAlreadyRequested}
    />
  );
}
