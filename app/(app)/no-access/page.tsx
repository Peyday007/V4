import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export default async function NoAccessPage({ searchParams }: { searchParams: { permission?: string } }) {
  const user = await requireUser();

  return (
    <div className="card" style={{ maxWidth: 620, marginTop: '3rem' }}>
      <h1>Access denied</h1>
      <p className="muted">
        Your role, <strong>{user.roleName}</strong>, does not include the permission required for that page
        {searchParams.permission ? <> (<span className="mono">{searchParams.permission}</span>)</> : null}.
      </p>
      <p className="small muted">
        This is enforced on the server, not by hiding links. If you need this access, ask an owner or administrator to
        adjust your role.
      </p>
      <div className="row mt">
        <Link href={user.roleKey === 'CALLER' ? '/calls' : '/dashboard'} className="btn primary">
          Back to your work
        </Link>
      </div>
    </div>
  );
}
