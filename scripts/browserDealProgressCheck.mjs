/**
 * The deal panels, as an owner actually sees them.
 *
 * `dealProgressionAudit.ts` proves the server keeps facts and hopes apart.
 * This proves the screen does too — which is a separate question, and the one
 * that decides whether somebody skim-reading under time pressure comes away
 * believing a deal is further along than it is.
 *
 * The assertions are all about language rather than layout. A candidate must
 * not read as secured. An estimate must not read as money. An invoice must not
 * appear in a total described as collected. A field we inferred must be
 * labelled as ours on the same line as the value.
 *
 * Needs the app running and a login. Neither is committed:
 *
 *   npm run build && npx next start -p 3111
 *   DEMO_EMAIL=... DEMO_PASSWORD=... node scripts/browserDealProgressCheck.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:3111';
let failures = 0;
let checks = 0;
const check = (label, ok, detail = '') => {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
};

const scratch = mkdtempSync(join('scripts', '.deal-check-'));
function server(body) {
  const file = join(scratch, `step-${Date.now()}.ts`);
  writeFileSync(file, `async function main() {\n${body}\n}\nmain().catch((e) => { console.error(e); process.exit(1); });\n`);
  return execFileSync('npx', ['tsx', file], {
    encoding: 'utf8',
    env: { ...process.env, DIRECT_URL: process.env.DIRECT_URL ?? process.env.DATABASE_URL },
  }).trim();
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log(`  [page error] ${e.message}`));

try {
  // -------------------------------------------------------------------------
  console.log('--- stage a route with a candidate and no commitment -----------');
  //
  // Deliberately the awkward middle: a provider found and verified but not
  // committed, a price with a real cost behind it, and no money moved. This is
  // the state a screen is most likely to overstate.
  const stagedJson = server(`
    const { prisma } = await import('@/lib/db');
    const { captureRequirement } = await import('@/lib/deal/requirement');
    const { addCandidate, advanceCandidate } = await import('@/lib/deal/provider');
    const { draftQuote } = await import('@/lib/deal/quote');

    const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
    const route = await prisma.routeHypothesis.findFirst({
      where: { orgId: org.id }, orderBy: { createdAt: 'asc' },
    });
    const provider = await prisma.company.findFirst({
      where: { orgId: org.id, id: { not: route.companyId } }, orderBy: { createdAt: 'desc' },
    });

    await prisma.dealPayment.deleteMany({ where: { deal: { routeId: route.id } } });
    await prisma.dealMilestone.deleteMany({ where: { deal: { routeId: route.id } } });
    await prisma.routeDeal.deleteMany({ where: { routeId: route.id } });
    await prisma.approval.deleteMany({ where: { routeId: route.id } });
    await prisma.routeQuote.deleteMany({ where: { routeId: route.id } });
    await prisma.providerCandidate.deleteMany({ where: { routeId: route.id } });
    await prisma.buyerRequirement.deleteMany({ where: { routeId: route.id } });
    await prisma.dealEvent.deleteMany({ where: { routeId: route.id } });

    await captureRequirement({
      orgId: org.id, routeId: route.id,
      input: {
        summary: 'Nightly cleaning across three sites',
        specification: 'Nightly janitorial including restrooms',
        locations: '3 sites in Chicago',
        frequency: '5 nights a week',
        timingNote: 'before the contract ends in March',
        decisionMakerRole: 'Facilities Director',
        authorityConfirmed: true,
        // Deliberately NOT confirmed by the buyer, so the screen has to label it.
        incumbent: 'CleanCo',
        confirmed: ['summary', 'specification', 'locations', 'frequency', 'timingNote', 'decisionMakerRole'],
      },
    });

    const candidate = await addCandidate({
      orgId: org.id, routeId: route.id, providerCompanyId: provider.id,
      matchBasis: 'Capability and geography matched by the catalogue.',
    });
    await advanceCandidate({
      orgId: org.id, candidateId: candidate.id, to: 'CAPABILITY_VERIFIED',
      reason: 'Reference checked.',
      fields: {
        capabilityEvidence: 'Three comparable nightly contracts, reference checked.',
        credentialsEvidence: 'COI on file, $2m general liability.',
      },
    });
    await advanceCandidate({
      orgId: org.id, candidateId: candidate.id, to: 'COST_RECEIVED', reason: 'Priced on a call.',
      fields: {
        capacityNotes: 'One crew free from September.',
        costAmount: 6000, costBasis: 'per month, all sites', costTerms: 'Net 15',
        costExpiresAt: new Date(Date.now() + 30 * 86400000),
      },
    });
    await advanceCandidate({
      orgId: org.id, candidateId: candidate.id, to: 'SELECTED', reason: 'Best cover for the price.',
    });
    await draftQuote({
      orgId: org.id, routeId: route.id,
      inputs: {
        providerCandidateId: candidate.id, buyerPrice: 9000, contingency: 300, paymentTerms: 'Net 30',
      },
    });

    console.log(JSON.stringify({ routeId: route.id, org: org.name }));
  `);
  const staged = JSON.parse(stagedJson.split('\n').pop());
  check('the fixture staged a route with a selected, uncommitted provider', Boolean(staged.routeId));

  // -------------------------------------------------------------------------
  console.log('\n--- log in and open the opportunity ----------------------------');
  await page.goto(`${BASE}/login`);
  await page.fill('input[type=email]', process.env.DEMO_EMAIL ?? 'owner@dealdispatch.test');
  await page.fill('input[type=password]', process.env.DEMO_PASSWORD ?? 'demo-password-123');
  await page.click('button[type=submit]');
  await page.waitForURL(/dashboard|demand|board/, { timeout: 20000 });

  await page.goto(`${BASE}/demand/opportunity/${staged.routeId}`);
  // Waiting for the panel itself, not for the URL: the URL is already right
  // before the server has rendered anything, so a URL wait passes instantly and
  // every assertion after it reads a blank page.
  await page.waitForSelector('[data-testid="supply-panel"]', { timeout: 20000 });
  check('the opportunity record renders the deal panels', true);

  // -------------------------------------------------------------------------
  console.log('\n--- the supply panel does not promise anything -----------------');
  const supply = await page.locator('[data-testid="supply-panel"]').innerText();

  check(
    'it says outright that fulfilment is not secured',
    (await page.locator('[data-testid="not-secured"]').count()) === 1,
  );
  check(
    'the provider reads as selected, not as secured',
    supply.includes('Selected') && !supply.toLowerCase().includes('fulfilment is secured'),
  );
  check(
    'the state carries its meaning next to it',
    supply.includes('They have not agreed to it yet'),
  );
  check(
    'the cost shows the date it stops being true',
    /holds until \d{4}-\d{2}-\d{2}/.test(supply),
    supply.match(/holds until [\d-]+/)?.[0] ?? 'no expiry shown',
  );

  // -------------------------------------------------------------------------
  console.log('\n--- the buyer panel separates theirs from ours -----------------');
  const buyer = await page.locator('[data-testid="buyer-panel"]').innerText();

  check('a field the buyer stated is labelled as theirs', buyer.includes('they said this'));
  check(
    'a field we inferred is labelled as ours on the same line',
    buyer.includes('our inference — not confirmed by them'),
  );
  check(
    'the panel counts which fields came from the buyer',
    /came from the buyer/.test(buyer),
    buyer.split('\n').find((l) => l.includes('came from the buyer')) ?? '',
  );

  // -------------------------------------------------------------------------
  console.log('\n--- the price is labelled as an estimate -----------------------');
  const quote = await page.locator('[data-testid="quote-panel"]').innerText();

  check('the basis of the number is shown', quote.includes('Quoted — provider cost received'));
  check('gross profit is marked estimated, not realised', quote.includes('estimated, not realised'));
  check('nothing on the price panel claims money moved', !/collected/i.test(quote));

  // -------------------------------------------------------------------------
  console.log('\n--- with no deal, the money panel says so ----------------------');
  const money = await page.locator('[data-testid="money-panel"]').innerText();
  check(
    'it states plainly that nobody has committed',
    money.includes('Nobody has committed to anything'),
  );
  check('no collected figure is shown before a deal exists',
    (await page.locator('[data-testid="collected-gp"]').count()) === 0);

  // -------------------------------------------------------------------------
  console.log('\n--- commit, deliver and settle, then look again ----------------');
  server(`
    const { prisma } = await import('@/lib/db');
    const { sendQuote } = await import('@/lib/deal/quote');
    const { commitBuyer, commitProvider, advanceDeal, recordPayment, settlePayment } = await import('@/lib/deal/commit');

    const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
    const quote = await prisma.routeQuote.findFirst({
      where: { routeId: '${staged.routeId}', state: { in: ['DRAFT', 'APPROVED'] } },
    });
    await sendQuote({ orgId: org.id, quoteId: quote.id, channel: 'email' });
    const committed = await commitBuyer({
      orgId: org.id, quoteId: quote.id, basis: 'PURCHASE_ORDER',
      evidence: 'PO 44120 received by email.',
    });
    if (!committed.ok) throw new Error('commit refused: ' + committed.message);

    const candidate = await prisma.providerCandidate.findFirst({ where: { routeId: '${staged.routeId}' } });
    await commitProvider({
      orgId: org.id, dealId: committed.deal.id, providerCandidateId: candidate.id,
      basis: 'EMAIL', evidence: 'Confirmed by email, start 1 September.',
    });
    await advanceDeal({ orgId: org.id, dealId: committed.deal.id, to: 'IN_DELIVERY', reason: 'Crew mobilised.' });
    await advanceDeal({
      orgId: org.id, dealId: committed.deal.id, to: 'DELIVERED', reason: 'First month complete.',
      completionEvidence: 'Signed-off service sheet for September.',
    });

    // An invoice raised and NOT settled, plus one settled payment each way.
    await recordPayment({ orgId: org.id, dealId: committed.deal.id, direction: 'INBOUND', kind: 'INVOICE', amount: 9000 });
    const inbound = await recordPayment({ orgId: org.id, dealId: committed.deal.id, direction: 'INBOUND', kind: 'PAYMENT', amount: 9000 });
    await settlePayment({ orgId: org.id, paymentId: inbound.id });
    const outbound = await recordPayment({ orgId: org.id, dealId: committed.deal.id, direction: 'OUTBOUND', kind: 'PAYMENT', amount: 6000 });
    await settlePayment({ orgId: org.id, paymentId: outbound.id });
    console.log('done');
  `);

  await page.reload();
  await page.waitForSelector('[data-testid="money-panel"]', { timeout: 20000 });
  const settled = await page.locator('[data-testid="money-panel"]').innerText();

  check('the invoice is labelled a claim rather than money', settled.includes('a claim, not money'));
  check(
    'collected gross profit is the settled figure, not the quoted one',
    settled.includes('$3,000'),
    settled.split('\n').find((l) => l.includes('3,000')) ?? settled.slice(0, 120),
  );
  check(
    'and says so on the line itself',
    settled.includes('settled money only'),
  );
  check('the provider commitment is dated separately from the buyer\'s', /Provider committed/.test(settled));

  const quoteAfter = await page.locator('[data-testid="quote-panel"]').innerText();
  check(
    'the price panel still shows the estimate, unchanged by the money',
    quoteAfter.includes('estimated, not realised'),
  );

  // -------------------------------------------------------------------------
  console.log('\n--- the trail is on the page ----------------------------------');
  const trail = await page.locator('[data-testid="deal-trail"]').innerText();
  for (const kind of ['requirement.captured', 'quote.sent', 'deal.buyer_committed', 'payment.settled']) {
    check(`the trail shows ${kind}`, trail.includes(kind));
  }

  // -------------------------------------------------------------------------
  console.log('\n--- a caller cannot see any of this ---------------------------');
  const callerPage = await browser.newPage();
  await callerPage.goto(`${BASE}/login`);
  await callerPage.fill('input[type=email]', 'dana@dealdispatch.test');
  await callerPage.fill('input[type=password]', process.env.DEMO_PASSWORD ?? 'demo-password-123');
  await callerPage.click('button[type=submit]');
  await callerPage.waitForURL(/work|calls|dashboard|no-access/, { timeout: 20000 });
  await callerPage.goto(`${BASE}/demand/opportunity/${staged.routeId}`);
  const callerBody = await callerPage.locator('body').innerText();
  check(
    'a caller opening the owner record is refused rather than shown margins',
    !callerBody.includes('Collected gross profit') && !callerBody.includes('Gross profit'),
    callerPage.url(),
  );
  await callerPage.close();

  console.log(`\n${checks - failures}/${checks} checks passed.`);
} finally {
  await browser.close();
  rmSync(scratch, { recursive: true, force: true });
}

process.exitCode = failures > 0 ? 1 : 0;
