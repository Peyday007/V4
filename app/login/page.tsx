import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth/session';
import { LoginForm } from '@/components/LoginForm';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const user = await getSessionUser();
  if (user) redirect('/');

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="brand" style={{ textAlign: 'center', fontSize: '1.2rem' }}>
          Deal<span>Dispatch</span>
        </div>
        <p className="muted small" style={{ textAlign: 'center', marginBottom: '1.25rem' }}>
          AI-operated deal discovery and execution for subcontracting, brokerage and distribution.
        </p>
        <div className="card">
          <LoginForm />
        </div>
      </div>
    </div>
  );
}
