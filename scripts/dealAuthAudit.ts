/**
 * Who can do what to a deal, asked over real HTTP with real cookies.
 *
 * The library audit proves the rules; this proves they are actually reachable
 * only by the people who should reach them. Every request below goes through
 * the deployed route with a session cookie obtained from the real login — no
 * function is called directly, and no permission is stubbed, because a
 * permission check that only exists in a unit test is a check that ships
 * disabled.
 *
 * The specific failures it is looking for:
 *   a caller reaching pricing at all;
 *   a role that can read margins being able to change them;
 *   a route id from another account being distinguishable from one that does
 *     not exist;
 *   an unauthenticated request getting anything other than a 401.
 *
 *   BASE_URL=http://localhost:3111 npx tsx scripts/dealAuthAudit.ts
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

async function signIn(email: string): Promise<string | null> {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!response.ok) {
    // Loudly. This used to return null, and the blocks below then skipped in
    // silence — so a run rate-limited halfway through reported the same "all
    // passed" as a complete one. The count guard at the end is the backstop;
    // this is the message that says why.
    const hint = response.status === 429
      ? 'rate-limited — the login route allows ten attempts a minute per address. Wait a minute and re-run.'
      : await response.text().catch(() => '');
    throw new Error(`Sign-in failed for ${email}: HTTP ${response.status} — ${hint}`);
  }
  const cookie = response.headers.get('set-cookie');
  return cookie ? cookie.split(';')[0] : null;
}

/** How many checks this audit runs when nothing is skipped. */
const EXPECTED_CHECKS = 25;

async function post(path: string, body: unknown, cookie?: string | null) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
}

async function main() {
  const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!org) throw new Error('No organisation. Seed the database first.');

  const route = await prisma.routeHypothesis.findFirst({
    where: { orgId: org.id },
    orderBy: { createdAt: 'asc' },
  });
  if (!route) throw new Error('No route. Run scripts/dealProgressionAudit.ts first.');

  // -----------------------------------------------------------------------
  console.log('--- nobody at all ------------------------------------------------');

  for (const path of ['/api/deal/requirement', '/api/deal/provider', '/api/deal/quote', '/api/deal/commit', '/api/deal/payment']) {
    const anonymous = await post(path, { action: 'sync', routeId: route.id });
    check(`${path} refuses an unauthenticated request`, anonymous.status === 401, `got ${anonymous.status}`);
  }

  // -----------------------------------------------------------------------
  console.log('--- a caller -----------------------------------------------------');

  const callerCookie = await signIn('dana@dealdispatch.test');
  check('a caller can sign in', callerCookie !== null);

  if (callerCookie) {
    const attempts: Array<[string, unknown]> = [
      ['/api/deal/requirement', { action: 'capture', routeId: route.id, summary: 'anything', confirmed: [] }],
      ['/api/deal/provider', { action: 'sync', routeId: route.id }],
      ['/api/deal/quote', { action: 'draft', routeId: route.id, buyerPrice: 1 }],
      ['/api/deal/commit', { action: 'advance', dealId: 'x', to: 'DELIVERED', reason: 'x' }],
      ['/api/deal/payment', { action: 'record', dealId: 'x', direction: 'INBOUND', kind: 'PAYMENT', amount: 1 }],
    ];
    for (const [path, body] of attempts) {
      const result = await post(path, body, callerCookie);
      check(`a caller cannot reach ${path}`, result.status === 403, `got ${result.status}`);
    }
  }

  // -----------------------------------------------------------------------
  console.log('--- finance: reads margins, does not set them --------------------');

  const financeCookie = await signIn('finance@dealdispatch.test');
  check('finance can sign in', financeCookie !== null);

  if (financeCookie) {
    const draft = await post('/api/deal/quote', { action: 'draft', routeId: route.id, buyerPrice: 5_000 }, financeCookie);
    check('finance cannot draft a price', draft.status === 403, `got ${draft.status}`);

    const commit = await post(
      '/api/deal/commit',
      { action: 'commit_buyer', quoteId: 'x', basis: 'VERBAL', evidence: 'they said yes' },
      financeCookie,
    );
    check('finance cannot commit a deal', commit.status === 403, `got ${commit.status}`);
  }

  // -----------------------------------------------------------------------
  console.log('--- the deal manager ---------------------------------------------');

  const managerCookie = await signIn('manager@dealdispatch.test');
  check('the deal manager can sign in', managerCookie !== null);

  if (managerCookie) {
    const capture = await post(
      '/api/deal/requirement',
      {
        action: 'capture',
        routeId: route.id,
        summary: 'Authorization audit requirement',
        specification: 'Weekly janitorial',
        frequency: 'weekly',
        timingNote: 'this quarter',
        decisionMakerRole: 'Facilities',
        authorityConfirmed: true,
        confirmed: ['summary', 'specification', 'frequency', 'timingNote', 'decisionMakerRole'],
      },
      managerCookie,
    );
    check('the deal manager can record a requirement', capture.status === 200, `got ${capture.status}`);

    // Direct-object safety. A well-formed id belonging to nothing on this
    // account has to be indistinguishable from one that does not exist.
    const foreignRoute = await prisma.routeHypothesis.findFirst({
      where: { orgId: { not: org.id } },
      select: { id: true },
    });
    const madeUp = await post(
      '/api/deal/quote',
      { action: 'draft', routeId: foreignRoute?.id ?? 'clx0000000000000000000000', buyerPrice: 1_000 },
      managerCookie,
    );
    check(
      'a route id from outside the account is not found, not forbidden',
      madeUp.status === 404,
      `got ${madeUp.status}`,
    );

    // A malformed body is a 400, and must not leak which field mattered to the
    // permission decision.
    const malformed = await post('/api/deal/quote', { action: 'draft' }, managerCookie);
    check('a malformed request is rejected before anything is written', malformed.status === 400, `got ${malformed.status}`);

    // Sending is a different permission from drafting.
    const drafted = await post(
      '/api/deal/quote',
      { action: 'draft', routeId: route.id, buyerPrice: 5_000, providerCost: 3_000, paymentTerms: 'Net 30', contingency: 100 },
      managerCookie,
    );
    check('the deal manager can draft a price', drafted.status === 200, `got ${drafted.status}`);

    const quoteId = (drafted.body.quote as { id?: string } | undefined)?.id;
    if (quoteId) {
      const research = await signIn('research@dealdispatch.test');
      if (research) {
        const send = await post('/api/deal/quote', { action: 'send', quoteId, channel: 'email' }, research);
        check('a research reviewer cannot send a price to a buyer', send.status === 403, `got ${send.status}`);
      }
    }
  }

  // -----------------------------------------------------------------------
  console.log('--- approvals are decided by the owner ---------------------------');

  const pending = await prisma.approval.findFirst({
    where: { orgId: org.id, routeId: { not: null }, status: 'PENDING' },
    select: { id: true },
  });

  if (pending) {
    const asCaller = callerCookie
      ? await post(`/api/approvals/${pending.id}`, { decision: 'APPROVED' }, callerCookie)
      : null;
    check('a caller cannot approve a deal', asCaller !== null && asCaller.status === 403, `got ${asCaller?.status}`);

    const asResearch = await signIn('research@dealdispatch.test');
    if (asResearch) {
      const attempt = await post(`/api/approvals/${pending.id}`, { decision: 'APPROVED' }, asResearch);
      check('a research reviewer cannot approve a deal', attempt.status === 403, `got ${attempt.status}`);
    }

    const ownerCookie = await signIn('owner@dealdispatch.test');
    if (ownerCookie) {
      const decided = await post(`/api/approvals/${pending.id}`, { decision: 'APPROVED', note: 'audit' }, ownerCookie);
      check('the owner can approve', decided.status === 200, `got ${decided.status}`);

      const twice = await post(`/api/approvals/${pending.id}`, { decision: 'REJECTED' }, ownerCookie);
      check('a decided approval cannot be decided again', twice.status === 409, `got ${twice.status}`);

      const trail = await prisma.dealEvent.findFirst({
        where: { subjectType: 'Approval', subjectId: pending.id, kind: 'approval.approved' },
      });
      check('the decision is written to the deal trail', trail !== null);
    }
  } else {
    check('an approval existed to test the decision path', false, 'none pending — run dealProgressionAudit first');
  }

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
