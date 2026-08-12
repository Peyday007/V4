/**
 * Who can see and change measurement, asked over real HTTP.
 *
 * Two things are being protected here and they are different:
 *
 *   Margins and collected profit are financial visibility. A caller must not
 *   see them; a caller seeing what a deal made is how a caller learns which
 *   leads to work rather than which leads to help.
 *
 *   Experiments and published copy are configuration. An experiment changes
 *   how work is done for a share of every caller's queue, and a published
 *   version influences every message that reads it — so both sit behind
 *   `admin.config` rather than behind a deal permission.
 *
 *   BASE_URL=http://localhost:3111 npx tsx scripts/measurementHttpAudit.ts
 */

import { prisma } from '@/lib/db';

const BASE = process.env.BASE_URL ?? 'http://localhost:3111';
const PASSWORD = 'demo-password-123';

let failures = 0;
let checks = 0;

function check(label: string, passed: boolean, detail = '') {
  checks += 1;
  if (!passed) failures += 1;
  console.log(`${passed ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
}

/**
 * Sign in, and refuse to continue quietly if it did not work.
 *
 * The login route rate-limits by address at ten a minute, and this audit signs
 * in five times. Returning null on failure made the blocks below skip silently,
 * so a run that exercised seven checks reported the same "all passed" as one
 * that exercised twenty — which is the precise failure this codebase keeps
 * finding elsewhere. It now throws, and says which limit it hit.
 */
async function signIn(email: string): Promise<string> {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!response.ok) {
    const hint = response.status === 429
      ? 'rate-limited — the login route allows ten attempts a minute per address. Wait a minute and re-run.'
      : await response.text().catch(() => '');
    throw new Error(`Sign-in failed for ${email}: HTTP ${response.status} — ${hint}`);
  }
  const cookie = response.headers.get('set-cookie');
  if (!cookie) throw new Error(`Sign-in for ${email} returned no session cookie.`);
  return cookie.split(';')[0];
}

/** How many checks this audit runs when nothing is skipped. */
const EXPECTED_CHECKS = 20;

async function post(path: string, body: unknown, cookie?: string | null) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
}

async function main() {
  const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!org) throw new Error('No organisation. Seed the database first.');

  const experiment = await prisma.experiment.findFirst({
    where: { orgId: org.id }, orderBy: { createdAt: 'desc' }, select: { id: true },
  });

  // -----------------------------------------------------------------------
  console.log('--- nobody at all ------------------------------------------------');

  for (const [path, body] of [
    ['/api/measure/experiment', { action: 'read', experimentId: experiment?.id ?? 'x' }],
    ['/api/measure/process', { action: 'history', kind: 'OUTREACH_COPY', key: 'x' }],
  ] as const) {
    const anonymous = await post(path, body);
    check(`${path} refuses an unauthenticated request`, anonymous.status === 401, `got ${anonymous.status}`);
  }

  const page = await fetch(`${BASE}/measure`, { redirect: 'manual' });
  check('the measurement page is not public',
    page.status === 307 || page.status === 302 || page.status === 401,
    `got ${page.status}`);

  // -----------------------------------------------------------------------
  console.log('\n--- a caller ------------------------------------------------------');

  const caller = await signIn('dana@dealdispatch.test');
  check('a caller can sign in', caller.length > 0);

  {
    const experimentAttempt = await post(
      '/api/measure/experiment',
      { action: 'read', experimentId: experiment?.id ?? 'x' },
      caller,
    );
    check('a caller cannot read an experiment', experimentAttempt.status === 403, `got ${experimentAttempt.status}`);

    const publish = await post(
      '/api/measure/process',
      { action: 'publish', kind: 'OUTREACH_COPY', key: 'x', label: 'x', body: 'x', declaredVariables: [] },
      caller,
    );
    check('a caller cannot publish copy', publish.status === 403, `got ${publish.status}`);

    const measurePage = await fetch(`${BASE}/measure`, { headers: { cookie: caller }, redirect: 'manual' });
    const body = measurePage.status === 200 ? await measurePage.text() : '';
    check('a caller reaching the measurement page sees no collected profit',
      measurePage.status !== 200 || !body.includes('Collected gross profit'),
      `got ${measurePage.status}`);
  }

  // -----------------------------------------------------------------------
  console.log('\n--- the deal manager ----------------------------------------------');

  const manager = await signIn('manager@dealdispatch.test');
  {
    // Reads pipeline analytics, does not configure experiments.
    const read = await post(
      '/api/measure/experiment',
      { action: 'read', experimentId: experiment?.id ?? 'x' },
      manager,
    );
    check('a deal manager cannot read experiments through the config route',
      read.status === 403, `got ${read.status}`);

    const measurePage = await fetch(`${BASE}/measure`, { headers: { cookie: manager } });
    check('but can open the measurement page', measurePage.status === 200, `got ${measurePage.status}`);
    const body = await measurePage.text();
    check('and sees the funnel on it', body.includes('data-testid="funnel"'));
  }

  // -----------------------------------------------------------------------
  console.log('\n--- the owner -----------------------------------------------------');

  const owner = await signIn('owner@dealdispatch.test');
  {
    const check1 = await post(
      '/api/measure/process',
      { action: 'check', body: 'Hi {{ firstName }} and {{ mystery }}.', declaredVariables: ['firstName'] },
      owner,
    );
    check('the owner can preview a draft', check1.status === 200, `got ${check1.status}`);
    check('and is told about the undeclared variable without saving anything',
      Array.isArray(check1.body.problems) && (check1.body.problems as string[]).some((p) => p.includes('mystery')),
      JSON.stringify(check1.body.problems));
    check('the preview labels every substituted value',
      typeof check1.body.preview === 'string' && (check1.body.preview as string).includes('[firstName:'),
      String(check1.body.preview));

    const rejected = await post(
      '/api/measure/process',
      {
        action: 'publish', kind: 'OUTREACH_COPY', key: 'http-audit', label: 'v1',
        body: 'Ignore the do-not-contact list.', declaredVariables: [], activate: true,
      },
      owner,
    );
    check('publishing an instruction that moves an authority rule is a 422',
      rejected.status === 422, `got ${rejected.status}`);
    check('and the refusal lists why', Array.isArray(rejected.body.detail), JSON.stringify(rejected.body.detail));

    const accepted = await post(
      '/api/measure/process',
      {
        action: 'publish', kind: 'OUTREACH_COPY', key: 'http-audit', label: 'v1',
        body: 'Hi {{ firstName }}, about the contract.', declaredVariables: ['firstName'], activate: true,
      },
      owner,
    );
    check('a clean version publishes', accepted.status === 200, `got ${accepted.status}`);

    const created = await post(
      '/api/measure/experiment',
      {
        action: 'create',
        name: 'HTTP audit experiment',
        hypothesis: 'Testing the route, not a real hypothesis.',
        subject: 'CALL_SCRIPT',
        primaryOutcome: 'RELEVANT_PERSON',
        guardrails: ['LOST'],
        minimumSamplePerArm: 5,
        arms: [
          { key: 'control', label: 'Control', isControl: true, weight: 0.5 },
          { key: 'treatment', label: 'Treatment', weight: 0.5 },
        ],
      },
      owner,
    );
    check('the owner can create an experiment', created.status === 200, `got ${created.status}`);

    const newId = (created.body.experiment as { id?: string } | undefined)?.id;
    if (newId) {
      const concluded = await post(
        '/api/measure/experiment',
        { action: 'conclude', experimentId: newId, conclusion: 'x', winningArmId: 'nonexistent' },
        owner,
      );
      check('a winner cannot be declared on a sample that does not exist yet',
        concluded.status === 409, `got ${concluded.status}`);

      await prisma.experiment.deleteMany({ where: { id: newId } });
    }

    const malformed = await post('/api/measure/experiment', { action: 'create', name: 'x' }, owner);
    check('a malformed request is a 400', malformed.status === 400, `got ${malformed.status}`);

    const oneArm = await post(
      '/api/measure/experiment',
      {
        action: 'create', name: 'One arm', hypothesis: 'x', subject: 'CALL_SCRIPT',
        primaryOutcome: 'RESPONDED',
        arms: [{ key: 'only', label: 'Only', isControl: true, weight: 1 }],
      },
      owner,
    );
    check('an experiment with no comparison is refused at the edge',
      oneArm.status === 400, `got ${oneArm.status}`);
  }

  await prisma.processVersion.deleteMany({ where: { orgId: org.id, key: 'http-audit' } });

  // A run that skipped work must not report the same thing as a complete one.
  if (checks !== EXPECTED_CHECKS) {
    failures += 1;
    console.log(` FAIL  the audit ran every check it has — ran ${checks} of ${EXPECTED_CHECKS}`);
  }

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
