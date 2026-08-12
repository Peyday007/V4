import { redirect } from 'next/navigation';
import { recordProspectAction, type ProspectAction } from '@/lib/room/rooms';
import { rateLimit, clientIp } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * The prospect's side of the Deal Room.
 *
 * Unauthenticated, because the prospect is not a user of this system and the
 * token is the authorisation. Three things this route does deliberately:
 *
 *   It accepts a form post and answers with a redirect, so the page works with
 *   no JavaScript on whatever device somebody opens their email on.
 *
 *   It never distinguishes an unknown token from an expired one in a way that
 *   could be used to probe, and it returns nothing about the record either way.
 *
 *   It rate-limits by address. This is the one endpoint in the product that
 *   anybody on the internet can reach, and while a token is not guessable, the
 *   cost of somebody trying should be theirs rather than ours.
 */

const ACTIONS: ProspectAction[] = [
  'RESPONDED',
  'INFORMATION_SUPPLIED',
  'NEXT_STEP_REQUESTED',
  'QUOTE_REQUESTED',
  'PROOF_STEP_REQUESTED',
  'DECLINED',
];

export async function POST(request: Request, { params }: { params: { token: string } }) {
  const ip = clientIp(request);
  if (!rateLimit(`room.respond:${ip}`, 30, 60_000)) {
    return new Response('Too many requests.', { status: 429 });
  }

  const form = await request.formData().catch(() => null);
  if (!form) return new Response('Bad request.', { status: 400 });

  const raw = String(form.get('action') ?? '');
  const action = ACTIONS.find((candidate) => candidate === raw);
  if (!action) return new Response('Bad request.', { status: 400 });

  const note = String(form.get('note') ?? '');

  // A duplicate is not an error the prospect should ever hear about: the
  // library treats the second click as the first, and the acknowledgement is
  // identical either way.
  const result = await recordProspectAction({ token: params.token, action, note });

  // Redirected rather than rendered so a refresh does not repost the form.
  // Nothing about the target reveals whether the token was valid.
  redirect(`/room/${params.token}/thanks?ok=${result.ok ? '1' : '0'}`);
}
