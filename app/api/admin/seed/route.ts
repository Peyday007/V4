import { timingSafeEqual } from 'node:crypto';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { seedConversations, seedCore, seedDemoContent } from '@/prisma/seed';
import { handleRouteError, json } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * One-time demonstration seed, triggerable from a browser.
 *
 * A fresh deployment has an empty database and therefore no account to sign in
 * with, so this cannot sit behind the normal RBAC gate — there is nobody to
 * authorise yet. It uses CRON_SECRET instead, the same shared secret the
 * scheduler presents.
 *
 * Re-running is safe: the seed drops and rebuilds its organisation, so a run
 * interrupted by a function timeout self-heals on the next attempt. That is
 * also why it refuses to touch an organisation holding real work unless the
 * caller explicitly confirms.
 */
export async function GET(request: Request) {
  return run(request);
}

export async function POST(request: Request) {
  return run(request);
}

async function run(request: Request) {
  try {
    const config = env();
    if (!config.CRON_SECRET) {
      return json({ error: 'CRON_SECRET is not configured, so seeding over HTTP is disabled.' }, 503);
    }
    if (!isAuthorised(request, config.CRON_SECRET)) {
      return json({ error: 'Unauthorised' }, 401);
    }

    const url = new URL(request.url);
    const confirmReset = url.searchParams.get('confirm') === 'reset';
    const step = url.searchParams.get('step') ?? 'core';
    const startedAt = Date.now();

    // Split into two calls because the whole seed runs well past a serverless
    // function's time limit against a remote database. Phase one is all that
    // is needed to sign in.
    const base = new URL(request.url).origin;
    const secretParam = url.searchParams.get('secret');
    const nextUrl = (nextStep: string) =>
      `${base}/api/admin/seed?secret=${secretParam ? encodeURIComponent(secretParam) : 'YOUR_CRON_SECRET'}&step=${nextStep}`;

    if (step === 'demo') {
      await seedDemoContent();
      return json({
        ok: true,
        step: 'demo',
        durationMs: Date.now() - startedAt,
        message: 'Deals discovered. One optional step left: the recorded conversations.',
        nextStep: nextUrl('calls'),
      });
    }

    if (step === 'calls') {
      const result = await seedConversations();
      return json({
        ok: true,
        step: 'calls',
        durationMs: Date.now() - startedAt,
        counts: result.counts,
        message: 'Everything is in. Reload the dashboard.',
      });
    }

    const existingUsers = await prisma.user.count();
    await seedCore({ confirmReset });

    return json({
      ok: true,
      step: 'core',
      replacedExistingData: existingUsers > 0,
      durationMs: Date.now() - startedAt,
      message: 'You can sign in now.',
      signIn: {
        url: `${base}/login`,
        email: 'owner@dealdispatch.test',
        password: 'demo-password-123',
        note: 'Change this password before sharing the URL with anyone.',
      },
      optionalNextStep: {
        description: 'Adds the demonstration deals. Not required — you can also use "Run discovery" inside the app.',
        url: nextUrl('demo'),
      },
    });
  } catch (error) {
    // The guard refusing to overwrite real data is a conflict, not a bug.
    if (error instanceof Error && error.message.startsWith('Refusing to seed')) {
      return json({ error: error.message, hint: 'Append ?confirm=reset to the URL to proceed anyway.' }, 409);
    }
    return handleRouteError(error);
  }
}

function isAuthorised(request: Request, secret: string): boolean {
  const url = new URL(request.url);
  const presented =
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ||
    request.headers.get('x-cron-secret') ||
    // Query parameter so this can be triggered from a browser address bar on a
    // fresh deployment, where no session exists yet.
    url.searchParams.get('secret');
  if (!presented) return false;

  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
