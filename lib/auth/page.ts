import { redirect } from 'next/navigation';
import { requireUser, type SessionUser } from './session';
import { roleHasPermission, type PermissionKey } from './rbac';

/**
 * Page-level permission guards.
 *
 * API routes throw and return 403. A page cannot usefully throw — the visitor
 * gets a blank error screen — so pages redirect to an explanatory page instead.
 * The authorisation decision is identical; only the presentation differs.
 */
export async function requirePagePermission(permission: PermissionKey): Promise<SessionUser> {
  const user = await requireUser();
  if (!roleHasPermission(user.roleKey, permission)) {
    redirect(`/no-access?permission=${encodeURIComponent(permission)}`);
  }
  return user;
}

export async function requirePageAny(...permissions: PermissionKey[]): Promise<SessionUser> {
  const user = await requireUser();
  if (!permissions.some((permission) => roleHasPermission(user.roleKey, permission))) {
    redirect(`/no-access?permission=${encodeURIComponent(permissions.join(' or '))}`);
  }
  return user;
}
