import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { AuthError } from '@/lib/auth/session';
import { SandboxBlockedError } from '@/lib/safety/outbound';
import { redactForLogs } from '@/lib/audit';

/**
 * Shared error boundary for route handlers. Never leaks internals: clients get
 * a message they can act on, the server log gets the redacted detail.
 */
export function handleRouteError(error: unknown): NextResponse {
  if (error instanceof AuthError) {
    return NextResponse.json({ error: error.message }, { status: error.statusCode });
  }
  // A sandbox refusal is not a malformed request, and saying 400 invites the
  // caller to go and fix their input. It declares its own status; honour it.
  if (error instanceof SandboxBlockedError) {
    return NextResponse.json({ error: error.message }, { status: error.statusCode });
  }
  if (error instanceof ZodError) {
    return NextResponse.json(
      { error: 'Invalid request', details: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
      { status: 400 },
    );
  }
  const message = error instanceof Error ? error.message : 'Unexpected error';
  console.error('[api]', redactForLogs(error instanceof Error ? (error.stack ?? message) : String(error)));
  // Business-rule failures thrown as plain Errors are safe to surface.
  return NextResponse.json({ error: message }, { status: 400 });
}

export function json<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

/** Basic fixed-window rate limiting, keyed per identity + route. */
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() ?? request.headers.get('x-real-ip') ?? 'unknown';
}
