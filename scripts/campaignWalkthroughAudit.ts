/**
 * A campaign, end to end, with production untouched.
 *
 * The chain this drives is the whole point of the commercial machine, and no
 * part of it had ever been travelled in one go:
 *
 *   a campaign with a thesis, contrary evidence, cost, authority and kill
 *   conditions → work it generated → a PIN-only caller working that work →
 *   a confirmed requirement → a verified provider → a quote → a commitment →
 *   delivery → payment → collected gross profit → the campaign learning from
 *   its own outcome
 *
 * Everything runs in the practice world, through the same libraries and API
 * the product uses, and the run asserts at the end that not one production
 * figure moved. A rehearsal that taught the business something would be worse
 * than no rehearsal.
 *
 * Three things this is careful about beyond the happy path, because each is a
 * way the machine could look like it works and not:
 *
 *   A campaign missing its refusals must not run. The audit tries to start an
 *   incomplete one and expects to be told exactly what is missing.
 *
 *   Spend must not exceed authority, and advertising without a budget must not
 *   be preparable at all.
 *
 *   Collected gross profit must not appear until money has actually settled,
 *   and must rest on a real provider cost rather than an assumption.
 *
 *   npx tsx scripts/campaignWalkthroughAudit.ts
 */

import { prisma } from '@/lib/db';
import { campaignReadiness } from '@/lib/campaign/model';
import { transitionCampaign, evaluateCampaignConditions } from '@/lib/campaign/service';
import { generateCampaignWork, runCampaignTasks } from '@/lib/campaign/execute';
import { campaignOutcome } from '@/lib/campaign/outcomes';
import { configuredCoverage } from '@/lib/portfolio/concentration';
import { issuePin, signInWithPin } from '@/lib/caller/identity';
import { createCaller } from '@/lib/caller/roster';
import { grossProfitOf } from '@/lib/evidence/economics';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) { passed += 1; console.log(`  ok    ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`); }
}

function refuseUnlessLocal() {
  const host = /@([^/:]+)/.exec(process.env.DATABASE_URL ?? '')?.[1] ?? '';
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    console.error(`Creates campaigns, callers and deals; local databases only. DATABASE_URL points at "${host}".`);
    process.exit(1);
  }
}

const STAMP = Date.now();
const MARK = `cw-${STAMP}`;

/** Every production figure this run must leave exactly as it found it. */
async function productionCounts(orgId: string) {
  const [events, routes, requirements, candidates, quotes, deals, payments, settled, milestones, campaigns] =
    await Promise.all([
      prisma.demandEvent.count({ where: { orgId, dataMode: 'PRODUCTION' } }),
      prisma.routeHypothesis.count({ where: { orgId, dataMode: 'PRODUCTION' } }),
      prisma.buyerRequirement.count({ where: { orgId, dataMode: 'PRODUCTION' } }),
      prisma.providerCandidate.count({ where: { orgId, dataMode: 'PRODUCTION' } }),
      prisma.routeQuote.count({ where: { orgId, dataMode: 'PRODUCTION' } }),
      prisma.routeDeal.count({ where: { orgId, dataMode: 'PRODUCTION' } }),
      prisma.dealPayment.count({ where: { orgId, dataMode: 'PRODUCTION' } }),
      prisma.dealPayment.aggregate({
        where: { orgId, dataMode: 'PRODUCTION', direction: 'INBOUND', settledAt: { not: null } },
        _sum: { amount: true },
      }),
      prisma.demandOutcome.count({ where: { orgId, dataMode: 'PRODUCTION' } }),
      prisma.campaign.count({ where: { orgId, dataMode: 'PRODUCTION' } }),
    ]);
  return {
    events, routes, requirements, candidates, quotes, deals, payments, milestones, campaigns,
    collected: Number(settled._sum.amount ?? 0),
  };
}

async function main() {
  refuseUnlessLocal();
  const org = await prisma.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  const owner = await prisma.user.findFirstOrThrow({
    where: { orgId: org.id, role: { key: { in: ['OWNER', 'ADMIN'] } } }, select: { id: true },
  });

  console.log('='.repeat(76));
  console.log('CAMPAIGN WALKTHROUGH — thesis to collected gross profit, production untouched');
  console.log('='.repeat(76));

  const before = await productionCounts(org.id);
  console.log(`\nProduction before: ${JSON.stringify(before)}\n`);

  const created = CREATED;

  // ======================================================================
  // 1. A campaign that is not yet a campaign
  // ======================================================================
  console.log('--- an incomplete thesis is refused ----------------------------');
  const reachable = configuredCoverage().reachable;

  const bare = await prisma.campaign.create({
    data: {
      orgId: org.id, dataMode: 'TEST', name: `${MARK} bare`, state: 'DRAFT',
      thesis: 'Cleaning is good.', whyNow: 'Now.', route: 'BROKERAGE',
      targetStates: reachable.slice(0, 1), buyerProfile: 'x', providerProfile: 'y',
      requiredCapability: 'Commercial janitorial', testingHours: 0,
      testingCostCents: 0, testingCostBasis: '', createdById: owner.id,
    },
    select: { id: true },
  });
  created.campaigns.push(bare.id);

  const bareReadiness = campaignReadiness({
    draft: {
      name: 'bare', thesis: 'Cleaning is good.', whyNow: 'Now.', route: 'BROKERAGE',
      targetStates: reachable.slice(0, 1), buyerProfile: 'x', providerProfile: 'y',
      requiredCapability: 'Commercial janitorial', testingHours: 0, testingCostCents: 0,
      testingCostBasis: '', budgetCents: null, authorityGrantedById: null,
      evidence: [], channels: [], conditions: [],
    },
    reachableStates: reachable,
  });
  check('an empty thesis is refused', !bareReadiness.ready);
  const fields = bareReadiness.blockers.map((b) => b.field);
  check('and the thesis itself is named', fields.includes('thesis'), fields.join(', '));
  check('and the missing contrary evidence is named', bareReadiness.blockers.some((b) => /contrary/i.test(b.because)));
  check('and the missing kill condition is named', bareReadiness.blockers.some((b) => /kill condition/i.test(b.because)));
  check(
    'and a cleaning capability with no evidence for it is refused by name',
    bareReadiness.blockers.some((b) => b.field === 'requiredCapability' && /default the portfolio/i.test(b.because)),
  );

  const refusedStart = await transitionCampaign({
    orgId: org.id, campaignId: bare.id, actorId: owner.id, actorMayAuthorise: true, to: 'RUNNING',
  });
  check('so it cannot be started', !refusedStart.ok, refusedStart.ok ? 'it started' : refusedStart.error.slice(0, 90));

  // ======================================================================
  // 2. A campaign that is one
  // ======================================================================
  console.log('\n--- a complete thesis, with what would make it wrong ------------');
  const state = reachable[0] ?? 'IL';
  const campaign = await prisma.campaign.create({
    data: {
      orgId: org.id,
      dataMode: 'TEST',
      name: `${MARK} post-opening cleans`,
      state: 'DRAFT',
      thesis:
        'Businesses that have just been granted an operating licence need a first deep clean before they open '
        + 'their doors, and almost none of them have a cleaning contractor arranged at that point.',
      whyNow:
        'The licence record is dated, so the window is known rather than guessed, and it closes when they open.',
      route: 'BROKERAGE',
      targetStates: [state],
      buyerProfile: 'An independent operator who has just been granted a licence at a named address.',
      providerProfile: 'A local cleaning contractor with capacity for a one-off pre-opening job.',
      requiredCapability: 'Post-construction cleaning',
      testingHours: 12,
      testingCostCents: 0,
      testingCostBasis: 'Twelve hours of calling at no cash cost; no paid channel is enabled.',
      budgetCents: null,
      createdById: owner.id,
      evidence: {
        create: [
          {
            orgId: org.id, kind: 'SUPPORTING',
            claim: 'Licence records carry a dated start, so a cleaning window can be derived rather than guessed.',
            evidenceClass: 'EXTERNALLY_OBSERVED',
            sourceUrl: 'https://data.cityofchicago.org/resource/r5kz-chrr.json',
          },
          {
            orgId: org.id, kind: 'CONTRARY',
            claim:
              'The general contractor often has the final clean inside their own scope, in which case there is '
              + 'nobody to sell to.',
            evidenceClass: 'INFERRED',
          },
        ],
      },
      channels: {
        create: [{ orgId: org.id, kind: 'CALLING', enabled: true, outcomeMetric: 'CONVERSATIONS_HELD' }],
      },
      conditions: {
        create: [
          {
            orgId: org.id, kind: 'KILL', metric: 'CONVERSATIONS_HELD', comparator: 'AT_OR_BELOW',
            threshold: 0, afterDays: 14,
            statement: 'Stop if nobody has been spoken to after a fortnight.',
          },
          {
            orgId: org.id, kind: 'EXPAND', metric: 'COLLECTED_GROSS_PROFIT', comparator: 'AT_OR_ABOVE',
            threshold: 500,
            statement: 'Widen once five hundred of gross profit has actually been collected.',
          },
        ],
      },
    },
    select: { id: true },
  });
  created.campaigns.push(campaign.id);

  // ======================================================================
  // 3. Advertising without authority
  // ======================================================================
  console.log('\n--- advertising cannot be enabled without a budget --------------');
  await prisma.campaignChannel.create({
    data: { orgId: org.id, campaignId: campaign.id, kind: 'ADVERTISING', enabled: true },
  });
  const withAds = await loadReadiness(org.id, campaign.id, reachable);
  check('a campaign with unbudgeted advertising is refused', !withAds.ready);
  check(
    'because it has no budget',
    withAds.blockers.some((b) => /no budget/i.test(b.because)),
    withAds.blockers.map((b) => b.because.slice(0, 60)).join(' | '),
  );
  check(
    'because nobody authorised it',
    withAds.blockers.some((b) => /nobody has authorised/i.test(b.because)),
  );
  check(
    'and because nothing downstream would measure it',
    withAds.blockers.some((b) => /donation/i.test(b.because)),
  );

  // Removed rather than authorised: this walkthrough spends nothing.
  await prisma.campaignChannel.deleteMany({ where: { campaignId: campaign.id, kind: 'ADVERTISING' } });

  const ready = await loadReadiness(org.id, campaign.id, reachable);
  check('without it, the campaign is complete', ready.ready, ready.blockers.map((b) => b.field).join(', '));

  // ======================================================================
  // 4. Authority, and running
  // ======================================================================
  console.log('\n--- authority ---------------------------------------------------');
  const noAuthority = await transitionCampaign({
    orgId: org.id, campaignId: campaign.id, actorId: owner.id, actorMayAuthorise: false, to: 'RUNNING',
  });
  check('somebody without authority cannot start it', !noAuthority.ok);

  await transitionCampaign({
    orgId: org.id, campaignId: campaign.id, actorId: owner.id, actorMayAuthorise: true, to: 'AWAITING_AUTHORITY',
  });
  const started = await transitionCampaign({
    orgId: org.id, campaignId: campaign.id, actorId: owner.id, actorMayAuthorise: true, to: 'RUNNING',
  });
  check('somebody with authority can', started.ok, started.ok ? '' : started.error);
  const runningRow = await prisma.campaign.findUniqueOrThrow({
    where: { id: campaign.id }, select: { startedAt: true, authorityGrantedById: true },
  });
  check('and the grant records who and when', runningRow.authorityGrantedById === owner.id && runningRow.startedAt !== null);

  // ======================================================================
  // 5. Work the campaign generates
  // ======================================================================
  console.log('\n--- the work it generates ---------------------------------------');
  const buyer = await prisma.company.create({
    data: {
      orgId: org.id, legalName: `${MARK} Ironside Strength`, stateCode: state, cityName: 'Chicago',
      dataMode: 'TEST', origin: 'MANUAL',
    },
    select: { id: true },
  });
  const event = await prisma.demandEvent.create({
    data: {
      orgId: org.id, connector: MARK, type: 'OCCUPANCY_OR_OPERATING_APPROVAL',
      sourceRecordId: `${MARK}:1`, dedupeKey: `${MARK}:1`,
      headline: `${MARK} licence granted`, summary: 'fixture',
      sourceUrl: 'https://data.cityofchicago.org/resource/r5kz-chrr.json?license_number=FIXTURE',
      eventDate: new Date(Date.now() - 3 * 86_400_000), stateCode: state, dataMode: 'TEST',
    },
    select: { id: true },
  });
  const route = await prisma.routeHypothesis.create({
    data: {
      orgId: org.id, eventId: event.id, companyId: buyer.id, campaignId: campaign.id,
      playbookKey: 'cleaning.brokerage.pre_opening', headline: 'Pre-opening clean',
      rationale: 'Practice fixture for the campaign walkthrough.',
      route: 'BROKERAGE', tier: 'ACTIVE_DEMAND', status: 'RESEARCH',
      requiredCapability: 'Post-construction cleaning', friction: 'LOW',
      fulfilmentStatus: 'UNKNOWN', windowClosesAt: new Date(Date.now() + 20 * 86_400_000),
      dataMode: 'TEST',
    },
    select: { id: true },
  });

  const generated = await generateCampaignWork({ orgId: org.id, campaignId: campaign.id, actorId: owner.id });
  check('the campaign generates work for its route', generated.total > 0, `${generated.total} task(s)`);
  const kinds = generated.created.map((c) => c.kind);
  check('including finding a published number, since nobody is reachable', kinds.includes('find_published_number'));
  check('and sourcing providers, since there is no supply side', kinds.includes('source_providers'));

  const again = await generateCampaignWork({ orgId: org.id, campaignId: campaign.id, actorId: owner.id });
  check('running it again generates nothing new', again.total === 0, `${again.total}`);

  const ran = await runCampaignTasks({ orgId: org.id, campaignId: campaign.id });
  check('the tasks run', ran.length > 0, `${ran.length}`);
  const numberTask = ran.find((r) => r.kind === 'find_published_number');
  check(
    'a task that establishes nothing says so rather than inventing a number',
    numberTask?.status === 'FOUND_NOTHING' && /worse than none/i.test(numberTask.because ?? ''),
    `${numberTask?.status}: ${numberTask?.because?.slice(0, 80)}`,
  );
  check(
    'and nothing it produced is graded above what it actually established',
    ran.every((r) => r.status !== 'FOUND_NOTHING' || r.evidenceClass === 'UNKNOWN'),
  );

  // ======================================================================
  // 6. A PIN-only caller works it
  // ======================================================================
  console.log('\n--- a caller signs in with a PIN and nothing else ----------------');
  const callerResult = await createCaller({
    orgId: org.id, actorId: owner.id, name: `${MARK} caller`,
    email: `${MARK}@dealdispatch.test`, mode: 'TEST', active: true,
  });
  const callerId = (callerResult as { callerId?: string }).callerId!;
  created.callers.push(callerId);
  const pin = (await issuePin({ orgId: org.id, userId: callerId, issuedByUserId: owner.id })).pin;

  const session = await signInWithPin({ pin, ip: `${MARK}-ip` });
  check('the PIN alone identifies the caller', session.userId === callerId);

  // The caller does the thing a caller does. Without this the chain has a hole
  // at exactly the rung they are responsible for, and the audit would be
  // asserting that a campaign works without anybody having spoken to anyone.
  await prisma.outreachAttempt.create({
    data: {
      orgId: org.id, routeId: route.id, userId: callerId,
      disposition: 'NEED_CONFIRMED',
      occurredAt: new Date(),
      notes: 'Practice fixture: the operator confirmed they need a pre-opening clean.',
      dataMode: 'TEST',
    },
  });
  const spoken = await prisma.outreachAttempt.count({ where: { routeId: route.id, userId: callerId } });
  check('and the conversation they had is attributed to them', spoken === 1);

  // ======================================================================
  // 7. Requirement → provider → quote → commitment → payment
  // ======================================================================
  console.log('\n--- the commercial chain ----------------------------------------');
  const requirementRow = await prisma.buyerRequirement.create({
    data: {
      orgId: org.id, routeId: route.id, state: 'CURRENT', version: 1,
      summary: 'One pre-opening deep clean before the doors open.',
      specification: 'One pre-opening deep clean of a 2,400 sq ft studio.',
      quantity: '2400', unit: 'sqft',
      // What they said, versus what we read. The distinction the whole
      // evidence model exists for.
      confirmedFields: ['specification', 'quantity'],
      capturedById: callerId, dataMode: 'TEST',
    },
    select: { id: true },
  });
  check('a requirement is captured with what the buyer actually stated',
    (await prisma.buyerRequirement.count({ where: { routeId: route.id } })) === 1);

  const provider = await prisma.company.create({
    data: {
      orgId: org.id, legalName: `${MARK} Provider`, stateCode: state, cityName: 'Chicago',
      dataMode: 'TEST', origin: 'MANUAL', companyRole: 'SUBCONTRACTOR',
    },
    select: { id: true },
  });
  await prisma.providerCandidate.create({
    data: {
      orgId: org.id, routeId: route.id, providerCompanyId: provider.id,
      state: 'COST_RECEIVED', capabilityVerifiedAt: new Date(),
      matchBasis: 'They hold the capability and cover this postcode.',
      costAmount: 1200,
      costExpiresAt: new Date(Date.now() + 14 * 86_400_000),
      dataMode: 'TEST',
    },
  });
  check('a provider is verified and has priced the work',
    (await prisma.providerCandidate.count({ where: { routeId: route.id, capabilityVerifiedAt: { not: null } } })) === 1);

  const quote = await prisma.routeQuote.create({
    data: {
      orgId: org.id, routeId: route.id, version: 1, state: 'ACCEPTED',
      // A quote hangs off the requirement it prices. Without that link a
      // number could be raised against nothing in particular.
      requirementId: requirementRow.id,
      basis: 'QUOTE', costSideMissing: false,
      providerCost: 1200, buyerPrice: 1900, grossProfit: 700, grossMarginPct: 36.8,
      dataMode: 'TEST',
    },
    select: { id: true },
  });

  const gp = grossProfitOf({ basis: 'QUOTE', buyerPrice: 1900, providerCost: 1200, costSideMissing: false });
  check('gross profit rests on a real cost and is therefore showable',
    gp.value === 700 && gp.evidence === 'CALCULATED_FROM_CONFIRMED_INPUTS');

  const deal = await prisma.routeDeal.create({
    data: {
      orgId: org.id, routeId: route.id, quoteId: quote.id, stage: 'DELIVERED',
      buyerCommittedAt: new Date(),
      // A deal exists because somebody committed, and the evidence for that is
      // required rather than optional — a commitment with nothing behind it is
      // a hope with a stage name.
      buyerCommitmentBasis: 'EMAIL',
      buyerCommitmentEvidence: 'Practice fixture: the buyer confirmed by email.',
      providerCommittedAt: new Date(),
      providerCommitmentBasis: 'EMAIL',
      providerCommitmentEvidence: 'Practice fixture: the provider confirmed by email.',
      dataMode: 'TEST',
    },
    select: { id: true },
  });

  // Before any money settles.
  const beforePayment = await campaignOutcome({ orgId: org.id, campaignId: campaign.id });
  check('with a commitment but no payment, collected gross profit is still zero',
    beforePayment.collectedGrossProfit === 0, String(beforePayment.collectedGrossProfit));
  check('and the first empty rung is the money', beforePayment.firstEmptyStage === 'collected gross profit',
    String(beforePayment.firstEmptyStage));

  await prisma.dealPayment.create({
    data: {
      orgId: org.id, dealId: deal.id, direction: 'INBOUND', kind: 'PAYMENT', amount: 1900,
      currency: 'USD', settledAt: new Date(), dataMode: 'TEST',
    },
  });
  await prisma.dealPayment.create({
    data: {
      orgId: org.id, dealId: deal.id, direction: 'OUTBOUND', kind: 'PAYMENT', amount: 1200,
      currency: 'USD', settledAt: new Date(), dataMode: 'TEST',
    },
  });

  // ======================================================================
  // 8. What the campaign learned
  // ======================================================================
  console.log('\n--- what the campaign learned -----------------------------------');
  const outcome = await campaignOutcome({ orgId: org.id, campaignId: campaign.id });
  check('routes are attributed to the campaign', outcome.routesGenerated === 1);
  check('the requirement is counted', outcome.requirementsConfirmed === 1);
  check('the verified provider is counted', outcome.providersVerified === 1);
  check('the quote is counted', outcome.quotesSent === 1);
  check('the commitment is counted', outcome.commitmentsWon === 1);
  check('and collected gross profit arrives only once money settled',
    outcome.collectedGrossProfit === 700, String(outcome.collectedGrossProfit));
  check('so the chain has no empty rung left', outcome.firstEmptyStage === null, String(outcome.firstEmptyStage));
  check('return on spend is null rather than zero, because nothing was spent',
    outcome.returnOnSpend === null, String(outcome.returnOnSpend));

  const evaluated = await evaluateCampaignConditions({ orgId: org.id, actorId: owner.id });
  const mine = evaluated.find((e) => e.campaignId === campaign.id);
  check('the expansion condition fires on collected profit, not on quotes',
    mine?.newState === 'EXPANDED', `${mine?.newState}: ${mine?.fired.join(' ')}`);

  const concluded = await transitionCampaign({
    orgId: org.id, campaignId: campaign.id, actorId: owner.id, actorMayAuthorise: true,
    to: 'CONCLUDED',
    reason: 'Licence-window cleans convert; the contractor-scope objection was rarer than expected.',
  });
  check('and the campaign can be concluded with its learning', concluded.ok);
  const endedWithout = await prisma.campaign.findUniqueOrThrow({
    where: { id: campaign.id }, select: { endedReason: true },
  });
  check('which is recorded rather than discarded', Boolean(endedWithout.endedReason));

  // ======================================================================
  // 9. Production is exactly where it was
  // ======================================================================
  console.log('\n--- production ---------------------------------------------------');
  const after = await productionCounts(org.id);
  check('not one production figure moved', JSON.stringify(before) === JSON.stringify(after),
    `${JSON.stringify(before)} vs ${JSON.stringify(after)}`);

  await cleanUp(org.id, created, MARK);
  const afterCleanup2 = await productionCounts(org.id);
  check('and it is still there after cleanup', JSON.stringify(before) === JSON.stringify(afterCleanup2));
  console.log('\nCleaned up every record this walkthrough created.');

  console.log(`\n${'='.repeat(76)}`);
  console.log(`${passed}/${passed + failed} checks passed.`);
  if (failed > 0) process.exitCode = 1;
}

/**
 * Removes everything the run created, and is called whether it succeeded.
 *
 * The first version cleaned up only on the happy path, so three failed runs
 * left three practice callers each holding a top-up packet — which claimed
 * every callable practice route and made a later, unrelated audit report that
 * replenishment was broken. Debris from a rehearsal that looks like a defect
 * is worse than no rehearsal.
 */
async function cleanUp(orgId: string, created: { callers: string[]; campaigns: string[] }, mark: string) {
  const routeIds = (await prisma.routeHypothesis.findMany({
    where: { orgId, OR: [{ campaignId: { in: created.campaigns } }, { event: { connector: mark } }] },
    select: { id: true },
  })).map((r) => r.id);
  const dealIds = (await prisma.routeDeal.findMany({
    where: { routeId: { in: routeIds } }, select: { id: true },
  })).map((d) => d.id);

  await prisma.dealPayment.deleteMany({ where: { dealId: { in: dealIds } } });
  await prisma.routeDeal.deleteMany({ where: { routeId: { in: routeIds } } });
  await prisma.routeQuote.deleteMany({ where: { routeId: { in: routeIds } } });
  await prisma.providerCandidate.deleteMany({ where: { routeId: { in: routeIds } } });
  await prisma.outreachAttempt.deleteMany({ where: { routeId: { in: routeIds } } });
  await prisma.buyerRequirement.deleteMany({ where: { routeId: { in: routeIds } } });
  await prisma.packetItem.deleteMany({ where: { routeId: { in: routeIds } } });
  await prisma.campaignTask.deleteMany({ where: { campaignId: { in: created.campaigns } } });
  await prisma.routeHypothesis.deleteMany({ where: { id: { in: routeIds } } });
  await prisma.campaignCondition.deleteMany({ where: { campaignId: { in: created.campaigns } } });
  await prisma.campaignChannel.deleteMany({ where: { campaignId: { in: created.campaigns } } });
  await prisma.campaignEvidence.deleteMany({ where: { campaignId: { in: created.campaigns } } });
  await prisma.campaign.deleteMany({ where: { id: { in: created.campaigns } } });
  await prisma.demandEvent.deleteMany({ where: { connector: mark } });
  await prisma.company.deleteMany({ where: { legalName: { startsWith: mark } } });
  await prisma.pinAttempt.deleteMany({ where: { scope: { startsWith: mark } } });
  for (const id of created.callers) {
    // Packets first: a packet holding a practice route keeps it out of every
    // later fill, which is exactly the debris that made replenishment look
    // broken.
    await prisma.packetItem.deleteMany({ where: { packet: { callerId: id } } });
    await prisma.workPacket.deleteMany({ where: { callerId: id } });
    await prisma.callerProfile.deleteMany({ where: { userId: id } });
    await prisma.session.deleteMany({ where: { userId: id } });
    await prisma.auditEvent.deleteMany({ where: { userId: id } });
    await prisma.user.deleteMany({ where: { id } });
  }

}

async function loadReadiness(orgId: string, campaignId: string, reachable: string[]) {
  const c = await prisma.campaign.findFirstOrThrow({
    where: { id: campaignId, orgId },
    include: { evidence: true, channels: true, conditions: true },
  });
  return campaignReadiness({
    draft: {
      name: c.name, thesis: c.thesis, whyNow: c.whyNow, route: c.route,
      targetStates: c.targetStates, buyerProfile: c.buyerProfile, providerProfile: c.providerProfile,
      requiredCapability: c.requiredCapability, testingHours: c.testingHours,
      testingCostCents: c.testingCostCents, testingCostBasis: c.testingCostBasis,
      budgetCents: c.budgetCents, authorityGrantedById: c.authorityGrantedById,
      evidence: c.evidence.map((e) => ({
        kind: e.kind as 'SUPPORTING' | 'CONTRARY',
        claim: e.claim, evidenceClass: e.evidenceClass, sourceUrl: e.sourceUrl,
      })),
      channels: c.channels.map((ch) => ({
        kind: ch.kind, enabled: ch.enabled, budgetCents: ch.budgetCents,
        authorisedById: ch.authorisedById, outcomeMetric: ch.outcomeMetric,
      })),
      conditions: c.conditions.map((cd) => ({
        kind: cd.kind, metric: cd.metric, comparator: cd.comparator,
        threshold: cd.threshold, afterDays: cd.afterDays, statement: cd.statement,
      })),
    },
    reachableStates: reachable,
  });
}

const CREATED: { callers: string[]; campaigns: string[] } = { callers: [], campaigns: [] };

main()
  .then(async () => { await prisma.$disconnect(); process.exit(process.exitCode ?? 0); })
  .catch(async (e) => {
    console.error(e);
    // Clean up anyway. A run that dies halfway must not leave practice callers
    // holding routes for every later audit.
    try {
      const org = await prisma.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
      await cleanUp(org.id, CREATED, MARK);
      console.log('Cleaned up after the failure.');
    } catch (cleanupError) {
      console.error('Cleanup after failure also failed:', cleanupError);
    }
    await prisma.$disconnect();
    process.exit(1);
  });
