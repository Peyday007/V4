/**
 * One practice opportunity, all the way from a requirement to money kept.
 *
 * This is the acceptance test the whole commercial phase exists for: an
 * opportunity has to be able to travel dated demand → confirmed requirement →
 * verified provider → provider cost → quote → commitments → delivery →
 * invoice → payment → collected gross profit, through the endpoints the
 * product actually calls, without touching a real person and without moving a
 * single production number.
 *
 * Everything here goes over HTTP with a real session. Calling the libraries
 * directly would prove the libraries work, which was never in doubt — what was
 * in doubt, and what turned out to be false, is whether anything reachable
 * from a browser could drive them.
 *
 * Four things it is careful about beyond the happy path:
 *
 *   Direct API bypasses have to fail. A caller session must not be able to
 *   price a deal or record a payment.
 *
 *   Quote revisions have to preserve history, not overwrite a number.
 *
 *   Estimated and realised economics must not be confusable: a quote's margin
 *   is an intention, collected gross profit is money, and the second must not
 *   appear until every line has settled.
 *
 *   Production counts must be identical before and after.
 *
 *   BASE_URL=http://localhost:3111 npx tsx scripts/dealLifecycleAudit.ts
 */

import { prisma } from '@/lib/db';
import { ensureSandbox, resetSandbox } from '@/lib/caller/sandbox';
import { moneyPosition as moneyOf } from '@/lib/deal/commit';

const BASE = process.env.BASE_URL ?? 'http://localhost:3111';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'demo-password-123';

let failures = 0;
let checks = 0;
function check(label: string, passed: boolean, detail = '') {
  checks += 1;
  if (!passed) failures += 1;
  console.log(`${passed ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
}

/** How many checks a complete run produces. A short run must not read as clean. */
const EXPECTED_CHECKS = 58;

async function signIn(email: string): Promise<string> {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!response.ok) {
    throw new Error(`Sign-in failed for ${email}: HTTP ${response.status}${
      response.status === 429 ? ' — rate-limited, wait a minute and re-run' : ''}`);
  }
  const cookie = response.headers.get('set-cookie');
  if (!cookie) throw new Error('No session cookie.');
  return cookie.split(';')[0];
}

async function post(path: string, body: unknown, cookie?: string | null) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json().catch(() => ({})) as Record<string, any>,
  };
}

/** The production figures this run must not move. */
async function productionCounts(orgId: string) {
  const [requirements, candidates, quotes, deals, payments, settled] = await Promise.all([
    prisma.buyerRequirement.count({ where: { orgId, dataMode: 'PRODUCTION' } }),
    prisma.providerCandidate.count({ where: { orgId, dataMode: 'PRODUCTION' } }),
    prisma.routeQuote.count({ where: { orgId, dataMode: 'PRODUCTION' } }),
    prisma.routeDeal.count({ where: { orgId, dataMode: 'PRODUCTION' } }),
    prisma.dealPayment.count({ where: { orgId, dataMode: 'PRODUCTION' } }),
    prisma.dealPayment.aggregate({
      where: { orgId, dataMode: 'PRODUCTION', direction: 'INBOUND', settledAt: { not: null } },
      _sum: { amount: true },
    }),
  ]);
  return {
    requirements, candidates, quotes, deals, payments,
    collected: Number(settled._sum.amount ?? 0),
  };
}

async function main() {
  const org = await prisma.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  const owner = await prisma.user.findFirstOrThrow({
    where: { orgId: org.id, email: 'owner@dealdispatch.test' }, select: { id: true },
  });

  await ensureSandbox({ orgId: org.id, actorId: owner.id });

  const before = await productionCounts(org.id);
  const ownerCookie = await signIn('owner@dealdispatch.test');

  const route = await prisma.routeHypothesis.findFirstOrThrow({
    where: { orgId: org.id, dataMode: 'TEST' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, requiredCapability: true },
  });
  const provider = await prisma.company.findFirstOrThrow({
    where: { orgId: org.id, dataMode: 'TEST', companyRole: 'SUBCONTRACTOR' },
    select: { id: true, legalName: true },
  });
  console.log(`Working practice route ${route.id} against ${provider.legalName}.\n`);

  // -----------------------------------------------------------------------
  console.log('--- a requirement they confirmed ---------------------------------');
  const captured = await post('/api/deal/requirement', {
    action: 'capture',
    routeId: route.id,
    summary: 'Nightly janitorial across nine sites, consumables included.',
    specification: 'Five nights a week, standard consumables restock weekly.',
    quantity: '9 sites',
    frequency: 'five nights a week',
    locations: 'Dallas metro',
    timingNote: 'wants it running before the quarter ends',
    decisionMakerRole: 'Operations Manager',
    authorityConfirmed: true,
    budgetMechanism: 'QUOTE_REQUESTED',
    confirmed: ['summary', 'specification', 'quantity', 'frequency', 'locations', 'timingNote', 'budgetMechanism'],
  }, ownerCookie);
  check('a requirement can be captured through the API', captured.status === 200, `HTTP ${captured.status}`);

  const req = await prisma.buyerRequirement.findFirst({
    where: { routeId: route.id, state: 'CURRENT' },
    select: { id: true, version: true, dataMode: true, quantity: true, confirmedFields: true },
  });
  check('and is written as practice data by the database, not by the caller',
    req?.dataMode === 'TEST', `${req?.dataMode}`);
  check('and reads back with the shape that was sent', req?.quantity === '9 sites', `${req?.quantity}`);
  check('and records which fields the buyer actually stated',
    Array.isArray(req?.confirmedFields) && req!.confirmedFields.includes('quantity'),
    `${(req?.confirmedFields ?? []).length} confirmed`);

  // A second capture must version rather than overwrite.
  await post('/api/deal/requirement', {
    action: 'capture', routeId: route.id,
    summary: 'Nightly janitorial across nine sites, consumables included.',
    quantity: '11 sites', confirmed: ['quantity'],
  }, ownerCookie);
  const versions = await prisma.buyerRequirement.findMany({
    where: { routeId: route.id }, orderBy: { version: 'asc' },
    select: { version: true, state: true, quantity: true },
  });
  check('a correction versions the requirement rather than overwriting it',
    versions.length >= 2, `${versions.length} versions`);
  check('and the earlier version is kept with its original value',
    versions[0]?.quantity === '9 sites' && versions[0]?.state !== 'CURRENT',
    `v1 ${versions[0]?.quantity} (${versions[0]?.state})`);

  // -----------------------------------------------------------------------
  console.log('\n--- a provider who would actually do it --------------------------');
  const added = await post('/api/deal/provider', {
    action: 'add', routeId: route.id, providerCompanyId: provider.id,
    matchBasis: 'Holds the capability and covers the state. Sandbox walkthrough.',
  }, ownerCookie);
  check('a provider candidate can be added', added.status === 200, `HTTP ${added.status}`);

  const candidate = await prisma.providerCandidate.findFirstOrThrow({
    where: { routeId: route.id }, select: { id: true, state: true, dataMode: true },
  });
  check('the candidate is practice data', candidate.dataMode === 'TEST', candidate.dataMode);
  check('and starts as a candidate rather than as fulfilment',
    candidate.state === 'CANDIDATE_FOUND', candidate.state);

  const contacted = await post('/api/deal/provider', {
    action: 'advance', candidateId: candidate.id, to: 'CONTACTED',
    reason: 'Spoke to their scheduler during the sandbox walkthrough.',
  }, ownerCookie);
  check('a provider conversation can be logged', contacted.status === 200, `HTTP ${contacted.status}`);

  const verified = await post('/api/deal/provider', {
    action: 'advance', candidateId: candidate.id, to: 'CAPABILITY_VERIFIED',
    reason: 'They confirmed they run nightly janitorial crews in this metro.',
    capabilityEvidence: 'Named three comparable contracts in the same city.',
    credentialsEvidence: 'General liability certificate seen, in date.',
  }, ownerCookie);
  check('and a candidate can be verified with evidence', verified.status === 200, `HTTP ${verified.status}`);

  const afterVerify = await prisma.providerCandidate.findUniqueOrThrow({
    where: { id: candidate.id },
    select: { state: true, capabilityVerifiedAt: true, capabilityEvidence: true },
  });
  check('the verification is persisted with its evidence, not just its state',
    afterVerify.capabilityVerifiedAt !== null && (afterVerify.capabilityEvidence ?? '').length > 10,
    afterVerify.state);

  // -----------------------------------------------------------------------
  console.log('\n--- a cost with an expiry ----------------------------------------');
  const noExpiry = await post('/api/deal/provider', {
    action: 'advance', candidateId: candidate.id, to: 'COST_RECEIVED',
    reason: 'They gave a number over the phone.', costAmount: 4200,
  }, ownerCookie);
  check('a cost with no expiry is refused', noExpiry.status >= 400,
    `HTTP ${noExpiry.status} — ${String(noExpiry.body?.error ?? '').slice(0, 70)}`);

  const costed = await post('/api/deal/provider', {
    action: 'advance', candidateId: candidate.id, to: 'COST_RECEIVED',
    reason: 'Costed from their rate card during the walkthrough.',
    costAmount: 4200, costUnit: 'month', costBasis: 'Nine sites, five nights.',
    costExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  }, ownerCookie);
  check('a cost with an expiry is accepted', costed.status === 200, `HTTP ${costed.status}`);

  const costRow = await prisma.providerCandidate.findUniqueOrThrow({
    where: { id: candidate.id }, select: { costAmount: true, costExpiresAt: true },
  });
  check('and the number reads back', Number(costRow.costAmount) === 4200, `${costRow.costAmount}`);

  // -----------------------------------------------------------------------
  console.log('\n--- a quote, and what it is allowed to claim ---------------------');
  const drafted = await post('/api/deal/quote', {
    action: 'draft', routeId: route.id, providerCandidateId: candidate.id,
    providerCost: 4200, buyerPrice: 6300, currency: 'USD',
    paymentTerms: 'net 30', reason: 'Sandbox walkthrough quote.',
    validUntil: new Date(Date.now() + 21 * 86_400_000).toISOString(),
  }, ownerCookie);
  check('a quote can be drafted', drafted.status === 200, `HTTP ${drafted.status}`);

  const quote = await prisma.routeQuote.findFirstOrThrow({
    where: { routeId: route.id }, orderBy: { version: 'desc' },
    select: { id: true, version: true, state: true, dataMode: true, grossProfit: true, grossMarginPct: true, basis: true },
  });
  check('the quote is practice data', quote.dataMode === 'TEST', quote.dataMode);
  check('its margin is computed rather than typed', Number(quote.grossProfit) === 2100, `${quote.grossProfit}`);
  check('and is labelled by where the numbers came from, and is not money',
    quote.basis === 'QUOTE' && quote.basis !== ('REALISED' as string),
    `${quote.basis} — a provider cost and a buyer price, neither of them collected`);

  // Revising must keep the old one.
  await post('/api/deal/quote', {
    action: 'draft', routeId: route.id, providerCandidateId: candidate.id,
    providerCost: 4200, buyerPrice: 6800, reason: 'They pushed back on scope; re-priced.',
  }, ownerCookie);
  const quoteVersions = await prisma.routeQuote.findMany({
    where: { routeId: route.id }, orderBy: { version: 'asc' },
    select: { version: true, state: true, buyerPrice: true },
  });
  check('a revision creates a new version', quoteVersions.length >= 2, `${quoteVersions.length} versions`);
  check('and the superseded one keeps its own price',
    Number(quoteVersions[0]?.buyerPrice) === 6300 && quoteVersions[0]?.state === 'SUPERSEDED',
    `v1 ${quoteVersions[0]?.buyerPrice} (${quoteVersions[0]?.state})`);

  const live = await prisma.routeQuote.findFirstOrThrow({
    where: { routeId: route.id, state: { notIn: ['SUPERSEDED', 'WITHDRAWN'] } },
    orderBy: { version: 'desc' }, select: { id: true, state: true },
  });

  // Pricing is authority-gated. Sending before the decision must fail, and the
  // refusal has to say so rather than silently doing nothing.
  const premature = await post('/api/deal/quote', {
    action: 'send', quoteId: live.id, channel: 'Should not go anywhere.',
  }, ownerCookie);
  check('a price cannot be sent before it is approved',
    premature.status >= 400 && /approv|owner decision/i.test(String(premature.body?.error ?? '')),
    `HTTP ${premature.status} — ${String(premature.body?.error ?? '').slice(0, 60)}`);

  const pending = await prisma.approval.findFirst({
    where: { orgId: org.id, routeQuoteId: live.id, status: 'PENDING' },
    select: { id: true, type: true, title: true },
  });
  check('and an approval is waiting for somebody with the authority',
    pending !== null, pending ? `${pending.type}` : 'no approval raised');

  const decided = await post(`/api/approvals/${pending!.id}`, {
    decision: 'APPROVED', note: 'Sandbox walkthrough: margin and terms reviewed.',
  }, ownerCookie);
  check('the approval can be granted', decided.status === 200, `HTTP ${decided.status}`);

  const sent = await post('/api/deal/quote', {
    action: 'send', quoteId: live.id, channel: 'Sandbox walkthrough — no message actually left the building.',
  }, ownerCookie);
  check('and then the quote can be sent', sent.status === 200,
    `HTTP ${sent.status} — ${String(sent.body?.error ?? '').slice(0, 60)}`);

  // -----------------------------------------------------------------------
  console.log('\n--- commitments, which are not an accepted quote -----------------');
  const committedBuyer = await post('/api/deal/commit', {
    action: 'commit_buyer', quoteId: live.id, basis: 'EMAIL',
    evidence: 'Practice buyer replied confirming the scope and price. Sandbox walkthrough.',
    contractedValue: 6800,
  }, ownerCookie);
  check('the buyer commitment can be recorded', committedBuyer.status === 200,
    `HTTP ${committedBuyer.status} — ${String(committedBuyer.body?.error ?? '').slice(0, 80)}`);

  const deal = await prisma.routeDeal.findFirst({
    where: { routeId: route.id },
    select: { id: true, stage: true, dataMode: true, buyerCommittedAt: true, providerCommittedAt: true },
  });
  check('a deal exists and is practice data', deal?.dataMode === 'TEST', `${deal?.dataMode}`);
  check('with the buyer committed and the provider not',
    Boolean(deal?.buyerCommittedAt) && !deal?.providerCommittedAt,
    `stage ${deal?.stage}`);

  const committedProvider = await post('/api/deal/commit', {
    action: 'commit_provider', dealId: deal!.id, providerCandidateId: candidate.id,
    basis: 'EMAIL', evidence: 'Practice provider confirmed the crew and start date.',
    contractedCost: 4200,
  }, ownerCookie);
  check('the provider commitment can be recorded', committedProvider.status === 200,
    `HTTP ${committedProvider.status} — ${String(committedProvider.body?.error ?? '').slice(0, 80)}`);

  // -----------------------------------------------------------------------
  console.log('\n--- delivery -----------------------------------------------------');
  const started = await post('/api/deal/commit', {
    action: 'advance', dealId: deal!.id, to: 'IN_DELIVERY',
    reason: 'Crew started on site. Sandbox walkthrough.',
  }, ownerCookie);
  check('delivery can be started', started.status === 200, `HTTP ${started.status}`);

  const finished = await post('/api/deal/commit', {
    action: 'advance', dealId: deal!.id, to: 'DELIVERED',
    reason: 'Practice buyer signed off the first month.',
    completionEvidence: 'Signed-off sheet from the practice buyer, first month.',
  }, ownerCookie);
  check('and completed', finished.status === 200, `HTTP ${finished.status}`);

  const delivered = await prisma.routeDeal.findUniqueOrThrow({
    where: { id: deal!.id }, select: { stage: true, deliveryCompletedAt: true, completionEvidence: true },
  });
  check('completion is persisted with its evidence',
    delivered.deliveryCompletedAt !== null && (delivered.completionEvidence ?? '').length > 5,
    delivered.stage);

  // -----------------------------------------------------------------------
  console.log('\n--- invoiced is not paid, and paid is not profit -----------------');
  const invoice = await post('/api/deal/payment', {
    action: 'record', dealId: deal!.id, direction: 'INBOUND', kind: 'INVOICE',
    amount: 6800, reference: 'SANDBOX-INV-001',
  }, ownerCookie);
  check('an invoice can be raised', invoice.status === 200, `HTTP ${invoice.status}`);

  const afterInvoice = await prisma.dealPayment.findMany({
    where: { dealId: deal!.id }, select: { id: true, kind: true, direction: true, settledAt: true, dataMode: true },
  });
  check('the invoice line is practice data',
    afterInvoice.every((p) => p.dataMode === 'TEST'), `${afterInvoice.length} lines`);
  check('and is unsettled, so it is a claim rather than money',
    afterInvoice.every((p) => p.settledAt === null));

  // Collected gross profit must not exist yet.
  const midway = await post('/api/deal/payment', { action: 'record', dealId: deal!.id, direction: 'INBOUND', kind: 'PAYMENT', amount: 6800, reference: 'SANDBOX-PMT-001' }, ownerCookie);
  check('a payment can be recorded', midway.status === 200, `HTTP ${midway.status}`);

  const paymentRow = await prisma.dealPayment.findFirstOrThrow({
    where: { dealId: deal!.id, kind: 'PAYMENT', direction: 'INBOUND' }, select: { id: true },
  });
  const settledIn = await post('/api/deal/payment', {
    action: 'settle', paymentId: paymentRow.id, reference: 'SANDBOX-PMT-001',
  }, ownerCookie);
  check('and settled', settledIn.status === 200, `HTTP ${settledIn.status}`);

  // The outbound side, so gross profit becomes real rather than assumed.
  const providerBill = await post('/api/deal/payment', {
    action: 'record', dealId: deal!.id, direction: 'OUTBOUND', kind: 'INVOICE',
    amount: 4200, reference: 'SANDBOX-PROV-001',
  }, ownerCookie);
  check('what we owe the provider can be recorded', providerBill.status === 200, `HTTP ${providerBill.status}`);

  // Before the provider is paid, the margin must not read as final. This is the
  // check that catches a deal reporting the whole invoice as profit.
  const provisional = moneyOf(await prisma.dealPayment.findMany({
    where: { dealId: deal!.id },
    select: { direction: true, kind: true, amount: true, settledAt: true },
  }));
  check('with the provider unpaid, the deal is not fully settled',
    provisional.fullySettled === false && provisional.outstandingOutbound === 4200,
    `${provisional.outstandingOutbound} still owed`);

  const providerPaid = await post('/api/deal/payment', {
    action: 'record', dealId: deal!.id, direction: 'OUTBOUND', kind: 'PAYMENT',
    amount: 4200, reference: 'SANDBOX-PROV-PMT-001',
  }, ownerCookie);
  check('the provider can be paid', providerPaid.status === 200, `HTTP ${providerPaid.status}`);

  const outRow = await prisma.dealPayment.findFirstOrThrow({
    where: { dealId: deal!.id, direction: 'OUTBOUND', kind: 'PAYMENT' }, select: { id: true },
  });
  const settledOut = await post('/api/deal/payment', {
    action: 'settle', paymentId: outRow.id, reference: 'SANDBOX-PROV-PMT-001',
  }, ownerCookie);
  check('and that payment settled', settledOut.status === 200, `HTTP ${settledOut.status}`);

  const lines = await prisma.dealPayment.findMany({
    where: { dealId: deal!.id },
    select: { direction: true, kind: true, amount: true, settledAt: true },
  });
  const money = moneyOf(lines);
  check('collected gross profit is collected minus paid out',
    money.collectedGrossProfit === 2600,
    `${money.collected} in, ${money.paidOut} out, ${money.collectedGrossProfit} kept`);
  check('and the estimate and the realised figure are different numbers',
    Number(quote.grossProfit) !== money.collectedGrossProfit,
    `estimated ${quote.grossProfit}, realised ${money.collectedGrossProfit}`);

  // -----------------------------------------------------------------------
  console.log('\n--- the plan agrees the chain is finished ------------------------');
  const { loadDealRecord } = await import('@/lib/deal/record');
  const { loadDealPlan } = await import('@/lib/deal/plan');
  const record = await loadDealRecord({ orgId: org.id, routeId: route.id });
  const plan = await loadDealPlan({ orgId: org.id, routeId: route.id, record });
  const collectedStage = plan?.stages.find((s) => s.key === 'COLLECTED_PROFIT');
  check('the plan reports collected profit as done', collectedStage?.state === 'DONE',
    `${collectedStage?.state} — ${collectedStage?.because.slice(0, 60)}`);

  // -----------------------------------------------------------------------
  console.log('\n--- a caller cannot do any of this -------------------------------');
  const callerCookie = await signIn('dana@dealdispatch.test');
  const forbidden: Array<[string, string, Record<string, unknown>]> = [
    ['capture a requirement', '/api/deal/requirement', { action: 'capture', routeId: route.id, summary: 'x' }],
    ['add a provider', '/api/deal/provider', { action: 'add', routeId: route.id, providerCompanyId: provider.id, matchBasis: 'x' }],
    ['price a deal', '/api/deal/quote', { action: 'draft', routeId: route.id, buyerPrice: 1 }],
    ['commit a buyer', '/api/deal/commit', { action: 'commit_buyer', quoteId: live.id, basis: 'VERBAL', evidence: 'x' }],
    ['record money', '/api/deal/payment', { action: 'record', dealId: deal!.id, direction: 'INBOUND', kind: 'PAYMENT', amount: 1 }],
  ];
  for (const [what, path, body] of forbidden) {
    const result = await post(path, body, callerCookie);
    check(`a caller cannot ${what}`, result.status === 403, `HTTP ${result.status}`);
  }
  const anonymous = await post('/api/deal/payment', {
    action: 'record', dealId: deal!.id, direction: 'INBOUND', kind: 'PAYMENT', amount: 1,
  }, null);
  check('and neither can somebody with no session', anonymous.status === 401, `HTTP ${anonymous.status}`);

  // -----------------------------------------------------------------------
  console.log('\n--- production never moved ---------------------------------------');
  const after = await productionCounts(org.id);
  for (const key of ['requirements', 'candidates', 'quotes', 'deals', 'payments', 'collected'] as const) {
    check(`production ${key} unchanged`, before[key] === after[key], `${before[key]} then ${after[key]}`);
  }

  // -----------------------------------------------------------------------
  console.log('\n--- and the reset takes the whole practice deal with it ----------');
  await resetSandbox({ orgId: org.id, actorId: owner.id });
  const leftovers = await Promise.all([
    prisma.buyerRequirement.count({ where: { orgId: org.id, dataMode: 'TEST' } }),
    prisma.providerCandidate.count({ where: { orgId: org.id, dataMode: 'TEST' } }),
    prisma.routeQuote.count({ where: { orgId: org.id, dataMode: 'TEST' } }),
    prisma.routeDeal.count({ where: { orgId: org.id, dataMode: 'TEST' } }),
    prisma.dealPayment.count({ where: { orgId: org.id, dataMode: 'TEST' } }),
  ]);
  check('no practice requirement, candidate, quote, deal or payment survives',
    leftovers.every((n) => n === 0), leftovers.join('/'));

  const afterReset = await productionCounts(org.id);
  check('and production is still where it started',
    JSON.stringify(before) === JSON.stringify(afterReset));
}

main()
  .then(() => {
    if (checks !== EXPECTED_CHECKS) {
      console.log(` FAIL  the audit ran ${checks} checks, not the ${EXPECTED_CHECKS} a complete run produces.`);
      failures += 1;
    }
    console.log(`\n${checks - failures}/${checks} checks passed.`);
    process.exit(failures > 0 ? 1 : 0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
