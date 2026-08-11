#!/usr/bin/env node
/**
 * Applies pending migrations during a production build.
 *
 * `prisma migrate deploy` was already in the build command and this wraps it
 * rather than replacing it, for two reasons that only show up on a real
 * deployment.
 *
 * First, the schema declares `directUrl = env("DIRECT_URL")`. If that variable
 * is not set, Prisma does not quietly fall back to `DATABASE_URL` — it fails
 * schema validation with "Environment variable not found: DIRECT_URL", at
 * `prisma generate`, before the migration step is even reached. The build
 * stops with an error that says nothing about deployment configuration. This
 * script fills the variable from `DATABASE_URL` when it is absent, so a
 * single-URL setup works, and says so plainly.
 *
 * Second, migrations cannot run through a transaction pooler. Prisma takes an
 * advisory lock, and PgBouncer in transaction mode does not carry session
 * state, so the lock is lost and the migration hangs or fails partway. Supabase
 * and Neon both hand out a pooled URL by default, and it is the obvious one to
 * paste into `DATABASE_URL`. This checks the URL that migrations will actually
 * use for pooling markers and explains the fix before the failure happens.
 *
 * Nothing here ever prints a connection string, a host, or any part of one.
 * Only derived booleans are logged.
 *
 * A migration failure fails the build, deliberately. Shipping application code
 * that expects tables the database does not have is the outage this whole step
 * exists to prevent.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const log = (message) => process.stdout.write(`[migrate] ${message}\n`);

/**
 * Where the URL comes from decides how much this script can check.
 *
 * On Vercel every environment variable is in `process.env`, so all the
 * pre-flight checks below run. Locally the values usually live in `.env`,
 * which Prisma loads and Node does not — so the checks are skipped and Prisma
 * remains the authority on resolving the connection. Skipping a warning is the
 * right trade: failing a developer's `npm run db:deploy` because this script
 * could not see a variable Prisma can see would be a check that only ever
 * cost time.
 */
const databaseUrl = process.env.DATABASE_URL;
const hasDotenv = existsSync('.env');

if (!databaseUrl && !hasDotenv) {
  log('DATABASE_URL is not set and there is no .env file. Set it in the deployment');
  log('environment and redeploy.');
  process.exit(1);
}

const canPreflight = Boolean(databaseUrl);

// Prisma uses directUrl for migrations when the schema declares one. Filling it
// from DATABASE_URL keeps a single-URL setup working instead of failing schema
// validation with an error about a variable the operator may not know exists.
let usingFallback = false;
if (canPreflight && !process.env.DIRECT_URL) {
  process.env.DIRECT_URL = databaseUrl;
  usingFallback = true;
}

const migrationUrl = process.env.DIRECT_URL ?? '';

/**
 * Markers of a connection that cannot carry an advisory lock across
 * statements. Checked structurally, and never echoed.
 */
function poolingMarkers(url) {
  const markers = [];
  try {
    const parsed = new URL(url);
    if (parsed.port === '6543') markers.push('port 6543 (transaction pooler)');
    if (/pooler\./i.test(parsed.hostname)) markers.push('a pooler hostname');
    if (/-pooler/i.test(parsed.hostname)) markers.push('a pooled endpoint');
    if (parsed.searchParams.get('pgbouncer') === 'true') markers.push('pgbouncer=true');
    if (parsed.searchParams.has('connection_limit')) markers.push('a connection_limit parameter');
  } catch {
    // An unparseable URL is Prisma's problem to report, not this script's.
  }
  return markers;
}

const markers = canPreflight ? poolingMarkers(migrationUrl) : [];

if (!canPreflight) {
  log('Reading connection settings from .env via Prisma; skipping the pooled-connection check.');
}

if (usingFallback) {
  log('DIRECT_URL is not set, so migrations will run over DATABASE_URL.');
}

if (markers.length > 0) {
  log('');
  log('The connection migrations would use looks pooled: ' + markers.join(', ') + '.');
  log('Migrations take a session-level advisory lock, which a transaction pooler cannot hold,');
  log('so this will hang or fail partway through.');
  log('');
  log('Fix: add a DIRECT_URL environment variable in Vercel pointing at the *direct* database');
  log('connection (Supabase: Project Settings → Database → Connection string → URI, port 5432,');
  log('not the 6543 pooler). Leave DATABASE_URL as the pooled URL — the application wants that.');
  log('Then redeploy. Nothing is being printed here; set the value in the dashboard.');
  log('');
  // Attempted anyway rather than refused: the markers are a heuristic, and a
  // provider that changed its hostnames should not block a deploy on a guess.
  log('Attempting the migration regardless, in case these markers are wrong.');
  log('');
}

log('Applying pending migrations…');

const result = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32',
});

if (result.error) {
  log(`Could not run the migration command: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  log('');
  log('Migrations failed. The build is being stopped on purpose: deploying application code');
  log('that expects tables the database does not have is worse than not deploying at all.');
  if (markers.length > 0) {
    log('The pooled-connection warning above is the most likely cause.');
  }
  process.exit(result.status ?? 1);
}

log('Migrations are up to date.');
