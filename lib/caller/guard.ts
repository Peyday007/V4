import { redirect } from 'next/navigation';
import { AuthError, requireUser, type SessionUser } from '@/lib/auth/session';
import { roleHasPermission } from '@/lib/auth/rbac';

/**
 * The permission boundary around the caller workspace.
 *
 * A real boundary, not a hidden navigation link. Everything under `/work` and
 * `/api/work` goes through here, and the guarantee is about what a caller can
 * *ask for* rather than what they can see: the queries beneath these routes are
 * all scoped to `callerId`, so a caller who hand-writes a request for another
 * caller's assignment gets the same answer as one who asks for an assignment
 * that does not exist.
 *
 * Owners and deal managers may open the workspace too. That is deliberate —
 * somebody has to be able to see what a caller sees in order to help them — and
 * it does not widen what the caller-scoped queries return, because the scope
 * comes from the signed-in identity rather than from a parameter.
 */

/** Permissions that reach the caller workspace. */
const WORKSPACE_ROLES = ['call.assignment.read.own', 'call.assignment.read.all'] as const;

export function isCaller(user: SessionUser): boolean {
  return roleHasPermission(user.roleKey, 'call.assignment.read.own');
}

/** Owners and managers, who may look but whose own queue is still their own. */
export function isSupervisor(user: SessionUser): boolean {
  return roleHasPermission(user.roleKey, 'call.assignment.read.all');
}

/** For API routes: throws a 403 that the error handler turns into JSON. */
export async function requireWorkspace(): Promise<SessionUser> {
  const user = await requireUser();
  if (!WORKSPACE_ROLES.some((permission) => roleHasPermission(user.roleKey, permission))) {
    throw new AuthError('This is the caller workspace. Your account does not work assignments.', 403);
  }
  return user;
}

/** For pages: redirects rather than throwing a blank error screen. */
export async function requireWorkspacePage(): Promise<SessionUser> {
  const user = await requireUser();
  if (!WORKSPACE_ROLES.some((permission) => roleHasPermission(user.roleKey, permission))) {
    redirect('/no-access?permission=call.assignment.read.own');
  }
  return user;
}

/**
 * Who this request may read work for.
 *
 * Always the signed-in user, and never a parameter. A supervisor wanting to see
 * somebody else's queue uses the owner-side views, which are separately
 * permissioned — letting a `callerId` parameter through here would turn one
 * authorisation check into one per call site, and the one that gets forgotten
 * is the leak.
 */
export function scopeFor(user: SessionUser): { orgId: string; callerId: string } {
  return { orgId: user.orgId, callerId: user.id };
}
