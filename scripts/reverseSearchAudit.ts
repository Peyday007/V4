/**
 * Reverse search against Postgres, through the HTTP route an owner uses.
 *
 * The unit tests prove what a brief may say. They cannot prove the thing that
 * matters most about this feature, which is that it refuses: that a provider
 * whose capability is a directory's say-so produces no work at all, and that
 * committing a brief re-reads the database rather than trusting whatever the
 * page was holding.
 *
 * They also cannot prove the output is a campaign an operator can actually run
 * — with the calls attached, a kill condition already set, and a state that
 * cannot be started until somebody supplies the evidence the engine does not
 * have.
 *
 * Everything it creates is TEST-mode and removed afterwards, including on
 * failure.
 *
 *   BASE_URL=http://127.0.0.1:3000 npx tsx scripts/reverseSearchAudit.ts
 */

import { prisma } from '@/lib/db';
import { reverseSearch } from '@/lib/supply/reverse';
import { campaignFromBrief } from '@/lib/supply/develop';
import { campaignReadiness } from '@/lib/campaign/model';
import { configuredCoverage } from '@/lib/portfolio/concentration';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`);
  }
}

function refuseUnlessLocal() {
  const host = /@([^/:]+)/.exec(process.env.DATABASE_URL ?? '')?.[1] ?? '';
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    console.error(`Writes companies and campaigns; local databases only. DATABASE_URL points at "${host}".`);
    process.exit(1);
  }
}

const MARK = 'REVERSE-SEARCH-AUDIT';
const created = { companies: [] as string[], campaigns: [] as string[], capabilities: [] as string[] };

async function main() {
  refuseUnlessLocal();

  const org = await prisma.organization.findFirstOrThrow({ select: { id: true } });
  const owner = await prisma.user.findFirstOrThrow({ where: { orgId: org.id, role: { key: 'OWNER' } } });

  console.log('='.repeat(74));
  console.log('REVERSE SEARCH — from verified capacity to questions');
  console.log('='.repeat(74));

  const capability = await prisma.capability.upsert({
    where: { orgId_key: { orgId: org.id, key: `${MARK}-warehousing` } },
    create: { orgId: org.id, key: `${MARK}-warehousing`, name: 'Warehousing', category: 'Logistics' },
    update: {},
    select: { id: true },
  });
  created.capabilities.push(capability.id);

  const makeProvider = async (name: string) => {
    const company = await prisma.company.create({
      data: {
        orgId: org.id,
        dataMode: 'TEST',
        legalName: `${MARK} ${name}`,
        companyRole: 'SUPPLIER',
        cityName: 'Chicago',
        stateCode: 'IL',
      },
      select: { id: true },
    });
    created.companies.push(company.id);
    return company.id;
  };

  // --- an unverified provider ---------------------------------------------
  console.log('\n--- a claim nobody has checked produces no work ------------------');
  const unchecked = await makeProvider('Listed Storage');
  await prisma.companyCapability.create({
    data: { companyId: unchecked, capabilityId: capability.id, status: 'CLAIMED', confidence: 0.5 },
  });

  const refused = await reverseSearch({ orgId: org.id, companyId: unchecked });
  check('an unverified provider produces nothing', refused.usable === false);
  if (!refused.usable) {
    check(
      'and says why in terms of the evidence, not the code',
      /directory entry|describing itself|claims/i.test(refused.because),
      refused.because,
    );
    check(
      'and names the one thing that would change it',
      /Ring .*establish/i.test(refused.toUnblock),
      refused.toUnblock,
    );
  }

  // --- a verified provider -------------------------------------------------
  console.log('\n--- verified capacity produces questions ------------------------');
  const verified = await makeProvider('Halsted Storage');
  await prisma.companyCapability.create({
    data: {
      companyId: verified,
      capabilityId: capability.id,
      status: 'CONFIRMED',
      confidence: 0.9,
      verifiedAt: new Date(),
      notes: 'Confirmed on a call with the operator',
    },
  });
  await prisma.supplierAvailability.create({
    data: {
      orgId: org.id,
      companyId: verified,
      description: 'Four unlet bays through the autumn',
      quantity: 4,
      unit: 'bays',
      location: 'Chicago',
      status: 'CONFIRMED',
      verifiedAt: new Date(),
    },
  });

  const result = await reverseSearch({ orgId: org.id, companyId: verified });
  check('a verified provider produces briefs', result.usable === true);
  if (!result.usable) {
    console.error(result.because);
    return;
  }

  check('the position reads the verification from the record', result.position.verifiedCapabilities.length === 1);
  check('and the checked capacity beside it', result.position.capacity.some((c) => c.verifiedAt !== null));
  check(
    'the standing says these are not opportunities',
    /questions, not opportunities/i.test(result.standing),
    result.standing.slice(0, 90),
  );
  check('every brief carries a falsifier', result.briefs.every((b) => b.wouldFalsifyIt.length > 40));
  check('and questions to ask a person', result.briefs.every((b) => b.toEstablish.length >= 3));

  // --- committing one ------------------------------------------------------
  console.log('\n--- committing a brief makes it work ----------------------------');
  const brief = result.briefs[0];
  const draft = await campaignFromBrief({
    orgId: org.id,
    userId: owner.id,
    position: result.position,
    brief,
    dataMode: 'TEST',
  });
  created.campaigns.push(draft.campaignId);

  const campaign = await prisma.campaign.findUniqueOrThrow({
    where: { id: draft.campaignId },
    include: { evidence: true, channels: true, conditions: true, tasks: true },
  });

  check('a campaign is drafted', campaign.state === 'DRAFT', campaign.state);
  check('in the provider\'s world, not production', campaign.dataMode === 'TEST', campaign.dataMode);
  check('with the calls attached', campaign.tasks.length >= 4, `${campaign.tasks.length} task(s)`);
  check(
    'including one to re-check the provider before spending buyer calls',
    campaign.tasks.some((t) => t.kind === 'SUPPLY_CONFIRMATION' && t.companyId === verified),
  );
  check(
    'a kill condition is already set, with arithmetic rather than a paragraph',
    campaign.conditions.some((c) => c.kind === 'KILL' && c.afterDays > 0),
  );
  check(
    'and an expand condition, so a working thesis is not throttled by silence',
    campaign.conditions.some((c) => c.kind === 'EXPAND'),
  );

  check(
    'calling is the only channel enabled',
    campaign.channels.filter((c) => c.enabled).every((c) => c.kind === 'CALLING'),
  );
  check('no budget is committed', campaign.budgetCents === null);
  check('and no testing cost is invented', campaign.testingHours === 0 && campaign.testingCostCents === 0);

  const contrary = campaign.evidence.filter((e) => e.kind === 'CONTRARY');
  check('the absence of demand is recorded as contrary evidence', contrary.length >= 2, `${contrary.length}`);
  check(
    'and says outright that no buyer has asked for this',
    contrary.some((e) => /No buyer has said they need this/i.test(e.claim)),
  );

  const supporting = campaign.evidence.filter((e) => e.kind === 'SUPPORTING');
  check('the only supporting claim is the verification itself', supporting.length === 1);
  check(
    'and it is graded as confirmed by a person, because it was',
    supporting[0]?.evidenceClass === 'CONFIRMED_BY_PERSON',
    supporting[0]?.evidenceClass,
  );

  // --- and it cannot be started -------------------------------------------
  console.log('\n--- and it cannot be started until a person adds something -------');
  const readiness = campaignReadiness({
    draft: {
      name: campaign.name, thesis: campaign.thesis, whyNow: campaign.whyNow, route: campaign.route,
      targetStates: campaign.targetStates, buyerProfile: campaign.buyerProfile,
      providerProfile: campaign.providerProfile, requiredCapability: campaign.requiredCapability,
      testingHours: campaign.testingHours, testingCostCents: campaign.testingCostCents,
      testingCostBasis: campaign.testingCostBasis, budgetCents: campaign.budgetCents,
      authorityGrantedById: campaign.authorityGrantedById,
      evidence: campaign.evidence.map((e) => ({
        kind: e.kind as 'SUPPORTING' | 'CONTRARY',
        claim: e.claim, evidenceClass: e.evidenceClass, sourceUrl: e.sourceUrl,
      })),
      channels: campaign.channels.map((ch) => ({
        kind: ch.kind, enabled: ch.enabled, budgetCents: ch.budgetCents,
        authorisedById: ch.authorisedById, outcomeMetric: ch.outcomeMetric,
      })),
      conditions: campaign.conditions.map((cd) => ({
        kind: cd.kind, metric: cd.metric, comparator: cd.comparator,
        threshold: cd.threshold, afterDays: cd.afterDays, statement: cd.statement,
      })),
    },
    reachableStates: configuredCoverage().reachable,
  });
  check('the draft is not ready to run', readiness.blockers.length > 0, `${readiness.blockers.length} blocker(s)`);
  check(
    'and the engine says what it cannot supply',
    draft.youMustAdd.some((item) => /supports the demand side/i.test(item)),
    draft.youMustAdd.join(' | ').slice(0, 140),
  );

  // --- the guard against a stale page --------------------------------------
  console.log('\n--- a brief is re-read rather than trusted ----------------------');
  await prisma.companyCapability.updateMany({
    where: { companyId: verified },
    data: { status: 'CLAIMED', verifiedAt: null },
  });
  const afterLapse = await reverseSearch({ orgId: org.id, companyId: verified });
  check(
    'capacity that has lapsed since the page loaded stops the commit',
    afterLapse.usable === false,
    afterLapse.usable ? 'still usable' : afterLapse.because.slice(0, 90),
  );
}

async function cleanup() {
  await prisma.campaignTask.deleteMany({ where: { campaignId: { in: created.campaigns } } });
  await prisma.campaign.deleteMany({ where: { id: { in: created.campaigns } } });
  await prisma.supplierAvailability.deleteMany({ where: { companyId: { in: created.companies } } });
  await prisma.companyCapability.deleteMany({ where: { companyId: { in: created.companies } } });
  await prisma.company.deleteMany({ where: { id: { in: created.companies } } });
  await prisma.capability.deleteMany({ where: { id: { in: created.capabilities } } });
}

main()
  .catch((error) => {
    console.error(error);
    failed += 1;
  })
  .finally(async () => {
    await cleanup().catch((e) => console.error('cleanup:', e));
    await prisma.$disconnect();
    console.log(`\n${'='.repeat(74)}`);
    console.log(`${passed}/${passed + failed} checks passed.`);
    process.exit(failed > 0 ? 1 : 0);
  });
