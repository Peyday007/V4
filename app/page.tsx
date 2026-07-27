import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export default async function RootPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  redirect(user.roleKey === 'CALLER' ? '/calls' : '/dashboard');
}
