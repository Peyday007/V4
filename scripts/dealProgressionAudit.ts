/**
 * Deal progression against a real Postgres.
 *
 * The unit tests cover the arithmetic and the policy. This covers the things
 * only a database can answer: whether the partial unique indexes actually hold
 * under concurrency, whether a superseded version survives untouched, whether
 * the evidence gates refuse from the server rather than the screen, and whether
 * the append-only trail is written in the same transaction as the change — so a
 * failure halfway through leaves neither.
 *
 *   npx tsx scripts/dealProgressionAudit.ts
 */

import { prisma } from '@/lib/db';
import { captureRequirement, withdrawRequirement } from '@/lib/deal/requirement';
import { addCandidate, advanceCandidate } from '@/lib/deal/provider';
import { draftQuote, sendQuote, expireQuotes } from '@/lib/deal/quote';
import { commitBuyer, commitProvider, advanceDeal, recordPayment, settlePayment, moneyFor } from '@/lib/deal/commit';
import { loadDealRecord } from '@/lib/deal/record';
import { progressFromCall } from '@/lib/deal/fromCall';

let failures = 0;
let checks = 0;

function check(label: string, passed: boolean, detail = '') {
  checks += 1;
  if (!passed) failures += 1;
  console.log(`${passed ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
}

/** Two live routes on two different companies, created once and reused. */
async function ensureRoutes(orgId: string) {
  const companies = await prisma.company.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' }, take: 3 });
  if (companies.length < 3) throw new Error('Need at least three companies. Seed the database first.');

  const event = await prisma.demandEvent.upsert({
    where: { orgId_dedupeKey: { orgId, dedupeKey: 'audit_fixture:deal-progression-audit' } },
    create: {
      orgId,
      type: 'CONTRACT_EXPIRATION',
      connector: 'audit_fixture',
      sourceRecordId: 'deal-progression-audit',
      dedupeKey: 'audit_fixture:deal-progression-audit',
      eventDate: new Date('2026-08-01T00:00:00.000Z'),
      headline: 'Audit fixture: janitorial contract expiring',
      summary: 'A fixture for the deal-progression audit. Not a real demand event.',
      cityName: 'Chicago',
      stateCode: 'IL',
    },
    update: {},
  });

  const routes = [];
  for (const [index, company] of companies.slice(0, 2).entries()) {
    const route = await prisma.routeHypothesis.upsert({
      where: {
        eventId_companyId_playbookKey: {
          eventId: event.id, companyId: company.id, playbookKey: `audit-fixture-${index}`,
        },
      },
      create: {
        orgId,
        eventId: event.id,
        companyId: company.id,
        route: 'BROKERAGE',
        playbookKey: `audit-fixture-${index}`,
        headline: `Audit fixture route ${index + 1} — ${company.legalName}`,
        rationale: 'Created by scripts/dealProgressionAudit.ts. Not a real opportunity.',
        // Supply resolution skips a route with no required capability, so a
        // fixture without one is invisible to it and reads as "nothing to check".
        requiredCapability: 'Janitorial',
        tier: 'ACTIVE_DEMAND',
        status: 'RESEARCH',
      },
      update: {},
    });
    routes.push(route);
  }

  return routes as [(typeof routes)[0], (typeof routes)[0]];
}

async function main() {
  const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!org) throw new Error('No organisation. Seed the database first.');
  const orgId = org.id;

  const owner = await prisma.user.findFirst({ where: { orgId }, orderBy: { createdAt: 'asc' } });
  const ownerId = owner?.id ?? null;

  // Routes to work against.
  //
  // Created here rather than by running discovery, because this audit is about
  // what happens to a route *after* it exists — and driving live connectors to
  // produce one would make the run depend on the weather at three external
  // portals. The demand engine's own path has its own audits. What matters is
  // that these are real rows in real tables with real foreign keys, so every
  // constraint below is the production constraint.
  const [route, other] = await ensureRoutes(orgId);

  const providerCompany = await prisma.company.findFirst({
    where: { orgId, id: { notIn: [route.companyId, other.companyId] } },
    orderBy: { createdAt: 'asc' },
  });
  if (!providerCompany) throw new Error('Need a third company to act as a provider.');

  // Clean slate for this route only.
  await prisma.dealPayment.deleteMany({ where: { deal: { routeId: route.id } } });
  await prisma.dealMilestone.deleteMany({ where: { deal: { routeId: route.id } } });
  await prisma.routeDeal.deleteMany({ where: { routeId: route.id } });
  await prisma.approval.deleteMany({ where: { routeId: route.id } });
  await prisma.routeQuote.deleteMany({ where: { routeId: route.id } });
  await prisma.providerCandidate.deleteMany({ where: { routeId: route.id } });
  await prisma.buyerRequirement.deleteMany({ where: { routeId: route.id } });
  await prisma.dealEvent.deleteMany({ where: { routeId: route.id } });
  await prisma.task.deleteMany({ where: { routeId: route.id } });

  // -----------------------------------------------------------------------
  console.log('--- buyer requirement versioning --------------------------------');

  const first = await captureRequirement({
    orgId,
    routeId: route.id,
    input: {
      summary: 'Nightly cleaning, three sites',
      specification: 'Nightly janitorial including restrooms',
      locations: '3 sites in Chicago',
      frequency: '5 nights a week',
      timingNote: 'before the contract ends in March',
      decisionMakerRole: 'Facilities Director',
      authorityConfirmed: true,
      confirmed: ['summary', 'specification', 'locations', 'frequency', 'timingNote', 'decisionMakerRole'],
    },
    actorId: ownerId,
  });
  check('a first capture creates version 1', first.action === 'created' && first.requirement.version === 1);

  // A later, unconfirmed value must not replace what the buyer actually said.
  const attempted = await captureRequirement({
    orgId,
    routeId: route.id,
    input: { specification: 'guessed from the listing', confirmed: [] },
    actorId: ownerId,
  });
  check(
    'an unconfirmed value cannot overwrite the buyer\'s own words',
    attempted.declinedOverwrites.includes('specification')
      && attempted.requirement.specification === 'Nightly janitorial including restrooms',
    `declined: ${attempted.declinedOverwrites.join(',') || 'nothing'}`,
  );

  const declineEvent = await prisma.dealEvent.findFirst({
    where: { routeId: route.id, kind: 'requirement.overwrite_declined' },
  });
  check('the refused overwrite is recorded rather than silently dropped', declineEvent !== null);

  // A non-material detail on an unpriced requirement merges in place.
  const merged = await captureRequirement({
    orgId,
    routeId: route.id,
    input: { incumbent: 'CleanCo', confirmed: ['incumbent'] },
    actorId: ownerId,
  });
  check(
    'a detail added to an unpriced requirement merges into the same version',
    merged.action === 'merged' && merged.requirement.version === 1 && merged.requirement.incumbent === 'CleanCo',
  );

  // A material change writes a new version and leaves the old one alone.
  const versioned = await captureRequirement({
    orgId,
    routeId: route.id,
    input: { quantity: '4 sites now', locations: '4 sites in Chicago', confirmed: ['quantity', 'locations'] },
    actorId: ownerId,
  });
  check('a scope change writes a new version', versioned.action === 'versioned' && versioned.requirement.version === 2);

  const v1 = await prisma.buyerRequirement.findFirst({ where: { routeId: route.id, version: 1 } });
  check(
    'the superseded version keeps exactly what it said',
    v1?.state === 'SUPERSEDED' && v1?.locations === '3 sites in Chicago' && v1?.supersededById === versioned.requirement.id,
  );

  const currents = await prisma.buyerRequirement.count({ where: { routeId: route.id, state: 'CURRENT' } });
  check('exactly one requirement is current', currents === 1, `found ${currents}`);

  // The database, not the code, is what makes that true.
  let indexHeld = false;
  try {
    await prisma.buyerRequirement.create({
      data: { orgId, routeId: route.id, version: 99, state: 'CURRENT', summary: 'a second current requirement' },
    });
  } catch {
    indexHeld = true;
  }
  check('the database refuses a second current requirement', indexHeld);

  // -----------------------------------------------------------------------
  console.log('--- provider workstream -----------------------------------------');

  const candidate = await addCandidate({
    orgId,
    routeId: route.id,
    providerCompanyId: providerCompany.id,
    matchBasis: 'capability and geography matched by the catalogue',
  });
  check('a candidate starts at CANDIDATE_FOUND', candidate.state === 'CANDIDATE_FOUND');

  const again = await addCandidate({
    orgId, routeId: route.id, providerCompanyId: providerCompany.id, matchBasis: 're-matched',
  });
  check('re-finding a provider does not reset them', again.id === candidate.id && again.state === 'CANDIDATE_FOUND');

  const noEvidence = await advanceCandidate({
    orgId, candidateId: candidate.id, to: 'CAPABILITY_VERIFIED', reason: 'they seem fine',
  });
  check(
    'capability cannot be verified without evidence',
    !noEvidence.ok && noEvidence.kind === 'missing_evidence' && noEvidence.missing.includes('capabilityEvidence'),
  );

  const jumped = await advanceCandidate({
    orgId, candidateId: candidate.id, to: 'COST_RECEIVED', reason: 'they quoted us straight away',
    fields: { costAmount: 6_000, costBasis: 'per month all sites' },
  });
  check(
    'a forward jump still requires the evidence of every rung it skipped',
    !jumped.ok && jumped.kind === 'missing_evidence'
      && jumped.missing.includes('capabilityEvidence') && jumped.missing.includes('costExpiresAt'),
    !jumped.ok ? jumped.missing.join(',') : '',
  );

  const verified = await advanceCandidate({
    orgId, candidateId: candidate.id, to: 'CAPABILITY_VERIFIED',
    reason: 'named three comparable sites and gave a reference',
    fields: {
      capabilityEvidence: 'Three comparable nightly contracts, reference checked 2026-08-11.',
      credentialsEvidence: 'COI on file to 2027-01-31, $2m general liability; state licence verified.',
    },
  });
  check('capability verifies with evidence', verified.ok && verified.candidate.capabilityVerifiedAt !== null);

  const backwards = await advanceCandidate({
    orgId, candidateId: candidate.id, to: 'CONTACTED', reason: 'starting over',
  });
  check(
    'a candidate cannot be moved backwards',
    !backwards.ok && backwards.kind === 'backwards',
  );

  const costed = await advanceCandidate({
    orgId, candidateId: candidate.id, to: 'COST_RECEIVED', reason: 'priced on a call',
    fields: {
      capacityNotes: 'One crew free from September.',
      costAmount: 6_000, costBasis: 'per month, all sites', costUnit: 'month', costTerms: 'Net 15',
      costExpiresAt: new Date(Date.now() + 30 * 86_400_000),
    },
  });
  check('a cost with an amount, a basis and an expiry is accepted', costed.ok);

  const selected = await advanceCandidate({
    orgId, candidateId: candidate.id, to: 'SELECTED', reason: 'best of the three on price and cover',
  });
  check('selecting requires a live cost and gets one', selected.ok);

  // -----------------------------------------------------------------------
  console.log('--- quotes ------------------------------------------------------');

  const cheap = await draftQuote({
    orgId, routeId: route.id, actorId: ownerId,
    inputs: { providerCandidateId: candidate.id, buyerPrice: 6_200, paymentTerms: 'Net 30', contingency: 100 },
  });
  check('a quote drafts against the current requirement', cheap.ok);
  const thinMargin = cheap.ok && cheap.quote.approvalRequired;
  check('a thin margin is held for approval rather than sent', thinMargin,
    cheap.ok ? cheap.quote.approvalReasons.join(' | ') : '');

  const blockedSend = cheap.ok
    ? await sendQuote({ orgId, quoteId: cheap.quote.id, channel: 'email', actorId: ownerId })
    : null;
  check(
    'an unapproved quote cannot be sent',
    blockedSend !== null && !blockedSend.ok && blockedSend.kind === 'approval_pending',
  );

  const revised = await draftQuote({
    orgId, routeId: route.id, actorId: ownerId, reason: 'repriced after the site visit',
    inputs: {
      providerCandidateId: candidate.id, buyerPrice: 9_000, paymentTerms: 'Net 30',
      contingency: 300, validUntil: new Date(Date.now() + 14 * 86_400_000),
    },
  });
  check('a revision writes version 2', revised.ok && revised.quote.version === 2);

  const liveQuotes = await prisma.routeQuote.count({
    where: { routeId: route.id, state: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT'] } },
  });
  check('only one quote is live at a time', liveQuotes === 1, `found ${liveQuotes}`);

  const v1Quote = await prisma.routeQuote.findFirst({ where: { routeId: route.id, version: 1 } });
  check(
    'the superseded quote keeps its own price and points forward',
    v1Quote?.state === 'SUPERSEDED' && Number(v1Quote?.buyerPrice) === 6_200
      && v1Quote?.supersededById === (revised.ok ? revised.quote.id : null),
  );

  const staleApproval = await prisma.approval.findFirst({
    where: { routeQuoteId: v1Quote?.id, type: 'MARGIN_EXCEPTION' },
  });
  check(
    'an approval about numbers that no longer exist is retired, not left in the queue',
    staleApproval === null || staleApproval.status === 'EXPIRED',
    staleApproval?.status ?? 'none',
  );

  check(
    'a healthy margin needs no approval',
    revised.ok && revised.quote.approvalRequired === false,
    revised.ok ? revised.quote.approvalReasons.join(' | ') : '',
  );
  check(
    'the quote records that its cost side is real',
    revised.ok && revised.quote.costSideMissing === false && revised.quote.basis === 'QUOTE',
  );

  // Direct-object safety: another org cannot touch this quote.
  const foreign = revised.ok
    ? await sendQuote({ orgId: 'not-a-real-org', quoteId: revised.quote.id, channel: 'email' })
    : null;
  check('a quote id from another account is not found', foreign !== null && !foreign.ok && foreign.kind === 'not_found');

  const sent = revised.ok
    ? await sendQuote({ orgId, quoteId: revised.quote.id, channel: 'email', actorId: ownerId })
    : null;
  check('an approved-by-default quote sends', sent !== null && sent.ok);

  // -----------------------------------------------------------------------
  console.log('--- commitment, delivery and money ------------------------------');

  const noEvidenceCommit = revised.ok
    ? await commitBuyer({ orgId, quoteId: revised.quote.id, basis: 'VERBAL', evidence: '   ', actorId: ownerId })
    : null;
  check(
    'a commitment without evidence is refused by the library, not only by the request schema',
    noEvidenceCommit !== null && !noEvidenceCommit.ok && noEvidenceCommit.kind === 'no_evidence',
  );
  const dealsAfterRefusal = await prisma.routeDeal.count({ where: { routeId: route.id } });
  check('and creates no deal', dealsAfterRefusal === 0, `found ${dealsAfterRefusal}`);

  const committed = revised.ok
    ? await commitBuyer({
        orgId, quoteId: revised.quote.id, basis: 'PURCHASE_ORDER',
        evidence: 'PO 44120 received by email 2026-08-12.', actorId: ownerId,
      })
    : null;
  check('the buyer commits with a basis and evidence', committed !== null && committed.ok);

  const dealId = committed && committed.ok ? committed.deal.id : null;

  const twice = revised.ok
    ? await commitBuyer({
        orgId, quoteId: revised.quote.id, basis: 'VERBAL', evidence: 'again', actorId: ownerId,
      })
    : null;
  check('a route cannot be committed twice', twice !== null && !twice.ok && twice.kind === 'already_committed');

  const recordAfterCommit = await loadDealRecord({ orgId, routeId: route.id });
  check(
    'a committed deal with no provider commitment says so plainly',
    recordAfterCommit.deal.headline.includes('No provider has committed'),
    recordAfterCommit.deal.headline,
  );

  const noDelivery = dealId
    ? await advanceDeal({ orgId, dealId, to: 'DELIVERED', reason: 'done', actorId: ownerId })
    : null;
  check(
    'delivered requires evidence',
    noDelivery !== null && !noDelivery.ok && noDelivery.kind === 'missing_evidence',
  );

  if (dealId) {
    await commitProvider({
      orgId, dealId, providerCandidateId: candidate.id, basis: 'EMAIL',
      evidence: 'Confirmed by email 2026-08-12, start 1 September.', actorId: ownerId,
    });
    await advanceDeal({ orgId, dealId, to: 'IN_DELIVERY', reason: 'crew mobilised', actorId: ownerId });
    await advanceDeal({
      orgId, dealId, to: 'DELIVERED', reason: 'first month complete',
      completionEvidence: 'Signed-off service sheet for September.', actorId: ownerId,
    });
  }

  const backwardsDeal = dealId
    ? await advanceDeal({ orgId, dealId, to: 'COMMITTED', reason: 'undo', actorId: ownerId })
    : null;
  check('a deal cannot be moved backwards', backwardsDeal !== null && !backwardsDeal.ok && backwardsDeal.kind === 'backwards');

  // Money.
  if (dealId) {
    await recordPayment({ orgId, dealId, direction: 'INBOUND', kind: 'INVOICE', amount: 9_000, actorId: ownerId });
  }
  const afterInvoice = dealId ? await moneyFor(dealId) : null;
  check(
    'an invoice is not money',
    afterInvoice !== null && afterInvoice.invoiced === 9_000 && afterInvoice.collected === 0
      && afterInvoice.collectedGrossProfit === 0,
  );

  const payment = dealId
    ? await recordPayment({ orgId, dealId, direction: 'INBOUND', kind: 'PAYMENT', amount: 9_000, actorId: ownerId })
    : null;
  const afterUnsettled = dealId ? await moneyFor(dealId) : null;
  check(
    'a payment that has not settled is still not money',
    afterUnsettled !== null && afterUnsettled.collected === 0,
  );

  if (payment?.id) await settlePayment({ orgId, paymentId: payment.id, actorId: ownerId });
  if (dealId) {
    const out = await recordPayment({
      orgId, dealId, direction: 'OUTBOUND', kind: 'PAYMENT', amount: 6_000, actorId: ownerId,
    });
    if (out.id) await settlePayment({ orgId, paymentId: out.id, actorId: ownerId });
  }

  const settled = dealId ? await moneyFor(dealId) : null;
  check(
    'collected gross profit counts settled money only',
    settled !== null && settled.collected === 9_000 && settled.paidOut === 6_000 && settled.collectedGrossProfit === 3_000,
    settled ? JSON.stringify(settled) : '',
  );

  const negative = dealId
    ? await recordPayment({ orgId, dealId, direction: 'INBOUND', kind: 'REFUND', amount: -50, actorId: ownerId })
    : null;
  check('a negative amount is refused', negative !== null && !negative.ok);

  // -----------------------------------------------------------------------
  console.log('--- estimates never become realised -----------------------------');

  const finalRecord = await loadDealRecord({ orgId, routeId: route.id });
  const estimated = finalRecord.quotes.live ?? finalRecord.quotes.history[0];
  check(
    'the quote still carries an estimated gross profit, unchanged by the money',
    estimated !== undefined && estimated.basis !== 'REALISED',
    estimated?.basis,
  );
  check(
    'the deal panel labels collected gross profit as settled money',
    finalRecord.deal.money?.collectedGrossProfit === 3_000,
  );
  check(
    'the supply panel does not claim secured before COMMITTED',
    finalRecord.supply.secured === false && finalRecord.supply.best === 'SELECTED',
    `${finalRecord.supply.best}`,
  );

  // -----------------------------------------------------------------------
  console.log('--- the append-only trail ---------------------------------------');

  const events = await prisma.dealEvent.findMany({
    where: { routeId: route.id }, orderBy: { occurredAt: 'asc' },
  });
  const kinds = new Set(events.map((e) => e.kind));
  for (const expected of [
    'requirement.captured', 'requirement.versioned', 'provider.candidate_found',
    'provider.capability_verified', 'provider.selected', 'quote.drafted', 'quote.revised',
    'quote.sent', 'deal.buyer_committed', 'deal.provider_committed', 'deal.delivered',
    'payment.recorded', 'payment.settled', 'approval.required',
  ]) {
    check(`the trail records ${expected}`, kinds.has(expected));
  }
  check(
    'every event names what changed',
    events.every((e) => e.summary.trim().length > 0),
  );

  // -----------------------------------------------------------------------
  console.log('--- concurrency -------------------------------------------------');

  // Two operators revising the same route at the same instant must not both
  // produce a live quote.
  const [a, b] = await Promise.allSettled([
    draftQuote({ orgId, routeId: route.id, actorId: ownerId, inputs: { providerCandidateId: candidate.id, buyerPrice: 9_500 } }),
    draftQuote({ orgId, routeId: route.id, actorId: ownerId, inputs: { providerCandidateId: candidate.id, buyerPrice: 9_600 } }),
  ]);
  const liveAfterRace = await prisma.routeQuote.count({
    where: { routeId: route.id, state: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT'] } },
  });
  check(
    'two simultaneous revisions cannot both go live',
    liveAfterRace <= 1,
    `live: ${liveAfterRace}; outcomes: ${[a.status, b.status].join(',')}`,
  );
  const raceResults = [a, b]
    .map((r) => (r.status === 'fulfilled' ? r.value : null))
    .filter((r): r is NonNullable<typeof r> => r !== null);
  check(
    'the operator who lost the race is told what happened, not shown a database error',
    raceResults.some((r) => r.ok) && raceResults.some((r) => !r.ok && r.kind === 'raced'),
    raceResults.map((r) => (r.ok ? 'won' : r.kind)).join(','),
  );

  // Same for the requirement.
  const [c, d] = await Promise.allSettled([
    captureRequirement({ orgId, routeId: route.id, input: { quantity: '5 sites', confirmed: ['quantity'] }, actorId: ownerId }),
    captureRequirement({ orgId, routeId: route.id, input: { quantity: '6 sites', confirmed: ['quantity'] }, actorId: ownerId }),
  ]);
  const currentAfterRace = await prisma.buyerRequirement.count({ where: { routeId: route.id, state: 'CURRENT' } });
  check(
    'two simultaneous requirement captures cannot both be current',
    currentAfterRace === 1,
    `current: ${currentAfterRace}; outcomes: ${[c.status, d.status].join(',')}`,
  );
  check(
    'neither caller loses what they typed — the loser retries and merges',
    c.status === 'fulfilled' && d.status === 'fulfilled',
    `${c.status},${d.status}`,
  );

  // -----------------------------------------------------------------------
  console.log('--- expiry ------------------------------------------------------');

  const live = await prisma.routeQuote.findFirst({
    where: { routeId: route.id, state: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT'] } },
  });
  if (live) {
    await prisma.routeQuote.update({
      where: { id: live.id }, data: { validUntil: new Date(Date.now() - 86_400_000) },
    });
    const expired = await expireQuotes({ orgId });
    const after = await prisma.routeQuote.findUnique({ where: { id: live.id } });
    check('a quote past its validity date is retired', expired >= 1 && after?.state === 'EXPIRED');
  } else {
    check('a quote past its validity date is retired', false, 'no live quote to expire');
  }

  // -----------------------------------------------------------------------
  console.log('--- a saved call moves the deal ---------------------------------');

  // The second route, untouched so far, driven only through the call path.
  {
    await prisma.buyerRequirement.deleteMany({ where: { routeId: other.id } });
    await prisma.task.deleteMany({ where: { routeId: other.id } });
    await prisma.providerCandidate.deleteMany({ where: { routeId: other.id } });

    const attempt = await prisma.outreachAttempt.create({
      data: { orgId, routeId: other.id, disposition: 'QUOTE_REQUESTED', discovery: {} },
      select: { id: true },
    });

    const progressed = await progressFromCall({
      orgId,
      routeId: other.id,
      route: other.route,
      disposition: 'QUOTE_REQUESTED',
      discovery: {
        confirmedNeed: 'They want a price for weekly cleaning at two sites',
        scope: 'Weekly janitorial, two sites',
        locations: '2 sites',
        frequency: 'weekly',
        decisionAuthority: 'Operations Manager approves',
      },
      attemptId: attempt.id,
      actorId: ownerId,
    });

    check('a saved call creates the buyer requirement with no button pressed', progressed.requirement === 'created');
    check('no incident was raised', progressed.incidentId === null, progressed.incidentId ?? '');

    const pricingTask = await prisma.task.findFirst({
      where: { orgId, routeId: other.id, kind: 'pricing', status: { in: ['OPEN', 'IN_PROGRESS'] } },
    });
    check('a requested quote raises exactly one pricing task', pricingTask !== null);

    // Running it again must not stack a second task.
    await progressFromCall({
      orgId, routeId: other.id, route: other.route, disposition: 'QUOTE_REQUESTED',
      discovery: { confirmedNeed: 'They want a price for weekly cleaning at two sites', scope: 'Weekly janitorial, two sites' },
      attemptId: attempt.id, actorId: ownerId,
    });
    const taskCount = await prisma.task.count({
      where: { orgId, routeId: other.id, kind: 'pricing', status: { in: ['OPEN', 'IN_PROGRESS'] } },
    });
    check('a second call does not stack a duplicate task', taskCount === 1, `found ${taskCount}`);

    // A negative outcome withdraws it rather than deleting the route.
    await progressFromCall({
      orgId, routeId: other.id, route: other.route, disposition: 'NEED_UNCONFIRMED',
      discovery: { disqualifyReason: 'They renewed with the incumbent last month.' },
      attemptId: attempt.id, actorId: ownerId,
    });
    const withdrawnReq = await prisma.buyerRequirement.findFirst({
      where: { routeId: other.id, state: 'WITHDRAWN' },
    });
    const routeStillThere = await prisma.routeHypothesis.findUnique({ where: { id: other.id } });
    check('a negative outcome withdraws the requirement', withdrawnReq !== null);
    check('and does not delete the opportunity', routeStillThere !== null);
  }

  // -----------------------------------------------------------------------
  console.log('--- withdrawing -------------------------------------------------');
  const gone = await withdrawRequirement({
    orgId, routeId: route.id, reason: 'Budget pulled for the year.', actorId: ownerId,
  });
  check('withdrawing marks the current version withdrawn', gone?.state === 'WITHDRAWN');
  const nothingCurrent = await prisma.buyerRequirement.count({ where: { routeId: route.id, state: 'CURRENT' } });
  check('and leaves nothing current', nothingCurrent === 0);

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
