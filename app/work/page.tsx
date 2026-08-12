import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth/session';
import { isCaller, isSupervisor } from '@/lib/caller/guard';
import { callerReadiness } from '@/lib/caller/identity';
import { afterCallGate, packetProgress } from '@/lib/caller/packets';
import { WorkSignIn } from '@/components/WorkSignIn';
import { WorkReadiness } from '@/components/WorkReadiness';

export const dynamic = 'force-dynamic';

/**
 * The door to the caller workspace.
 *
 * Signed out, it is a PIN form and nothing else. Signed in, it is the pre-shift
 * check — what is waiting, what is holding them up, and whose problem that is.
 */
export default async function WorkPage() {
  const user = await getSessionUser();
  if (!user) return <WorkSignIn />;
  if (!isCaller(user) && !isSupervisor(user)) {
    redirect('/no-access?permission=call.assignment.read.own');
  }

  const [readiness, gate, packets] = await Promise.all([
    callerReadiness({ orgId: user.orgId, userId: user.id }),
    afterCallGate({ orgId: user.orgId, callerId: user.id }),
    packetProgress(user.orgId, user.id),
  ]);

  return <WorkReadiness callerName={user.name} readiness={readiness} gate={gate} packets={packets} />;
}
