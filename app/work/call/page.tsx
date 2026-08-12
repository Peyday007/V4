import { requireWorkspacePage } from '@/lib/caller/guard';
import { WorkWorkspace } from '@/components/WorkWorkspace';

export const dynamic = 'force-dynamic';

/**
 * One opportunity at a time.
 *
 * The guard is server-side and the queries beneath it are scoped to the
 * signed-in caller, so there is nothing on this page for a crafted URL to
 * change: what is served comes from their packets, not from the request.
 */
export default async function WorkCallPage() {
  const user = await requireWorkspacePage();
  return <WorkWorkspace callerName={user.name} />;
}
