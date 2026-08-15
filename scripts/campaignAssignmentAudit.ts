/**
 * A campaign reaching somebody's morning, against Postgres.
 *
 * The gap this proves closed is the reason campaigns could not be judged: the
 * routes a campaign produced went onto the board like any other, a caller
 * worked whatever the queue served, and the campaign was then measured on
 * outcomes it had no way of causing.
 *
 * So this checks the things a unit test cannot: that only a running campaign
 * can take somebody's morning, that the packet carries the thesis so the caller
 * knows what is being tested, that one caller cannot be handed an organisation
 * another is already working, and that everything withheld says why.
 *
 * Everything it creates is TEST-mode and removed afterwards, including on
 * failure.
 *
 *   npx tsx scripts/campaignAssignmentAudit.ts
 */

import { prisma } from '@/lib/db';
import { hashSecret } from '@/lib/auth/password';
import { assignCampaignWork, campaignProgress, previewCampaignAssignment } from '@/lib/campaign/assign';

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
    console.error(`Writes campaigns, routes and packets; local databases only. DATABASE_URL points at "${host}".`);
    process.exit(1);
  }
}

const MARK = 'CAMPAIGN-ASSIGN-AUDIT';
const created = {
  campaigns: [] as string[],
  events: [] as string[],
  companies: [] as string[],
  users: [] as string[],
};

const THESIS =
  'Distribution centres in Cook County that opened in the last quarter run short of pallet space before '
  + 'their first peak, and will pay for overflow storage by the month rather than sign a lease.';

async function main() {
  refuseUnlessLocal();

  const org = await prisma.organization.findFirstOrThrow({ select: { id: true } });
  const owner = await prisma.user.findFirstOrThrow({ where: { orgId: org.id, role: { key: 'OWNER' } } });

  console.log('='.repeat(74));
  console.log('CAMPAIGN ASSIGNMENT — a thesis reaching somebody\'s morning');
  console.log('='.repeat(74));

  // --- a campaign with routes of its own -----------------------------------
  const campaign = await prisma.campaign.create({
    data: {
      orgId: org.id,
      dataMode: 'TEST',
      name: `${MARK} overflow storage`,
      state: 'DRAFT',
      thesis: THESIS,
      whyNow: 'Three occupancy approvals in the last month, all before the autumn peak.',
      route: 'BROKERAGE',
      targetStates: ['IL'],
      buyerProfile: 'Distribution centres that opened in the last quarter.',
      providerProfile: 'Warehouses with unlet bays.',
      requiredCapability: 'Warehousing',
      testingHours: 8,
      testingCostCents: 0,
      testingCostBasis: 'Eight hours of calling.',
      createdById: owner.id,
      channels: { create: [{ orgId: org.id, kind: 'CALLING', enabled: true, outcomeMetric: 'REQUIREMENTS_CONFIRMED' }] },
      conditions: {
        create: [
          {
            orgId: org.id, kind: 'KILL', metric: 'REQUIREMENTS_CONFIRMED', comparator: 'AT_OR_BELOW',
            threshold: 0, afterDays: 21, statement: 'Three weeks with nobody confirming means the demand is not there.',
          },
          {
            orgId: org.id, kind: 'EXPAND', metric: 'REQUIREMENTS_CONFIRMED', comparator: 'AT_OR_ABOVE',
            threshold: 3, afterDays: 21, statement: 'Three buyers stating the same requirement is a market.',
          },
        ],
      },
    },
    select: { id: true },
  });
  created.campaigns.push(campaign.id);

  const event = await prisma.demandEvent.create({
    data: {
      orgId: org.id,
      dataMode: 'TEST',
      type: 'OCCUPANCY_OR_OPERATING_APPROVAL',
      connector: 'audit',
      sourceRecordId: `${MARK}-1`,
      dedupeKey: `${MARK}-1`,
      headline: `${MARK} occupancy approved`,
      summary: 'Seeded by the campaign assignment audit.',
      eventDate: new Date(),
    },
    select: { id: true },
  });
  created.events.push(event.id);

  const makeRoute = async (name: string, reachable: boolean) => {
    const company = await prisma.company.create({
      data: {
        orgId: org.id,
        dataMode: 'TEST',
        legalName: `${MARK} ${name}`,
        companyRole: 'BUYER',
        phone: reachable ? '+13125550101' : null,
        cityName: 'Chicago',
        stateCode: 'IL',
      },
      select: { id: true },
    });
    created.companies.push(company.id);
    const route = await prisma.routeHypothesis.create({
      data: {
        orgId: org.id,
        dataMode: 'TEST',
        eventId: event.id,
        companyId: company.id,
        campaignId: campaign.id,
        route: 'BROKERAGE',
        playbookKey: `audit.${name}`,
        headline: `${MARK} ${name} — overflow storage`,
        rationale: 'Seeded by the campaign assignment audit.',
        tier: 'ACTIVE_DEMAND',
        status: 'RESEARCH',
        requiredCapability: 'Warehousing',
      },
      select: { id: true },
    });
    return route.id;
  };

  const reachableRoute = await makeRoute('reachable', true);
  const unreachableRoute = await makeRoute('unreachable', false);

  // --- a draft may not take anybody's morning ------------------------------
  console.log('\n--- only a running campaign may take somebody\'s morning ---------');
  const draftPreview = await previewCampaignAssignment({ orgId: org.id, campaignId: campaign.id });
  check('a draft campaign is blocked from assigning', 'blocker' in draftPreview && Boolean(draftPreview.blocker));
  if ('blocker' in draftPreview) {
    check('and says so in terms of its state', /draft/i.test(draftPreview.blocker ?? ''), draftPreview.blocker ?? '');
  }

  await prisma.campaign.update({ where: { id: campaign.id }, data: { state: 'RUNNING', startedAt: new Date() } });

  // --- what would be assigned ----------------------------------------------
  console.log('\n--- what would be handed over, and what would not ---------------');
  const preview = await previewCampaignAssignment({ orgId: org.id, campaignId: campaign.id });
  if ('error' in preview) {
    check('the preview loads', false, preview.error);
    return;
  }
  check('the preview loads', true);
  check('the reachable route is assignable', preview.assignable.some((a) => a.routeId === reachableRoute));
  check(
    'the unreachable one is withheld with a reason',
    preview.withheld.some((w) => w.routeId === unreachableRoute && /nothing for a caller to ring/i.test(w.because)),
    preview.withheld.map((w) => w.because).join(' | '),
  );
  check(
    'the caller would be told what is being tested',
    preview.objective.includes('pallet space'),
    preview.objective.slice(0, 120),
  );
  check(
    'and it is the campaign\'s own routes, not the general queue',
    preview.assignable.every((a) => a.organisation.startsWith(MARK)),
  );

  // --- assigning it --------------------------------------------------------
  console.log('\n--- assigning it -----------------------------------------------');
  const callerRole = await prisma.role.findFirstOrThrow({ where: { orgId: org.id, key: 'CALLER' } });
  const makeCaller = async (email: string, name: string) => {
    const user = await prisma.user.upsert({
      where: { orgId_email: { orgId: org.id, email } },
      create: {
        orgId: org.id, email, name,
        passwordHash: await hashSecret('not-used-for-pin-login', 10),
        roleId: callerRole.id,
      },
      update: { isActive: true, name, roleId: callerRole.id },
      select: { id: true },
    });
    created.users.push(user.id);
    await prisma.callerProfile.upsert({
      where: { userId: user.id },
      create: { userId: user.id, dataMode: 'TEST' },
      update: { dataMode: 'TEST' },
    });
    return user.id;
  };

  const first = await makeCaller(`${MARK.toLowerCase()}.a@dealdispatch.test`, 'Audit Caller A');
  const second = await makeCaller(`${MARK.toLowerCase()}.b@dealdispatch.test`, 'Audit Caller B');

  const assigned = await assignCampaignWork({
    orgId: org.id, campaignId: campaign.id, callerId: first, actorId: owner.id,
  });
  check('the work is assigned', assigned.ok, assigned.ok ? '' : assigned.error);
  if (!assigned.ok) return;

  const packet = await prisma.workPacket.findUniqueOrThrow({
    where: { id: assigned.packetId },
    select: { discoveryObjective: true, experimentCohort: true, dataMode: true, items: { select: { routeId: true } } },
  });
  check(
    'the packet carries the thesis, so the caller knows what is being tested',
    (packet.discoveryObjective ?? '').includes('pallet space'),
    (packet.discoveryObjective ?? '').slice(0, 100),
  );
  check(
    'and is tagged to the campaign, so the answers are attributable to it',
    packet.experimentCohort === `campaign:${campaign.id}`,
    packet.experimentCohort ?? 'none',
  );
  check('in the caller\'s own world', packet.dataMode === 'TEST', packet.dataMode);
  check('with only the reachable route on it', packet.items.length === 1 && packet.items[0].routeId === reachableRoute);

  // --- one owner per organisation ------------------------------------------
  console.log('\n--- one owner per organisation, still -----------------------------');
  const second_attempt = await assignCampaignWork({
    orgId: org.id, campaignId: campaign.id, callerId: second, actorId: owner.id,
  });
  check('a second caller cannot be handed the same organisation', second_attempt.ok === false);
  if (!second_attempt.ok) {
    check(
      'and is told why rather than getting an empty packet',
      /being worked|unreachable|closed/i.test(second_attempt.error),
      second_attempt.error.slice(0, 140),
    );
  }

  const afterPreview = await previewCampaignAssignment({ orgId: org.id, campaignId: campaign.id });
  if (!('error' in afterPreview)) {
    check(
      'and the preview now withholds it, naming the reason',
      afterPreview.withheld.some((w) => /already working this organisation/i.test(w.because)),
      afterPreview.withheld.map((w) => w.because).join(' | ').slice(0, 140),
    );
  }

  // --- targets --------------------------------------------------------------
  console.log('\n--- where it stands against its own thresholds -------------------');
  const progress = await campaignProgress({ orgId: org.id, campaignId: campaign.id });
  check('the campaign reports targets', (progress?.targets.length ?? 0) === 2, `${progress?.targets.length}`);
  const killTarget = progress?.targets.find((t) => t.kind === 'KILL');
  check('including the floor that would stop it', Boolean(killTarget));
  check(
    'with a sentence saying what to do about it, not a bare count',
    (killTarget?.standing.length ?? 0) > 30 && !/^\d+ of \d+$/.test(killTarget?.standing ?? ''),
    killTarget?.standing ?? '',
  );
  check(
    'and no percentage anywhere in it',
    !progress?.targets.some((t) => /%/.test(t.standing)),
  );
}

async function cleanup() {
  const routes = await prisma.routeHypothesis.findMany({
    where: { eventId: { in: created.events } },
    select: { id: true },
  });
  const routeIds = routes.map((r) => r.id);
  await prisma.packetItem.deleteMany({ where: { routeId: { in: routeIds } } });
  await prisma.workPacket.deleteMany({ where: { callerId: { in: created.users } } });
  await prisma.routeHypothesis.deleteMany({ where: { id: { in: routeIds } } });
  await prisma.demandEvent.deleteMany({ where: { id: { in: created.events } } });
  await prisma.company.deleteMany({ where: { id: { in: created.companies } } });
  await prisma.campaignTask.deleteMany({ where: { campaignId: { in: created.campaigns } } });
  await prisma.campaign.deleteMany({ where: { id: { in: created.campaigns } } });
  await prisma.callerProfile.deleteMany({ where: { userId: { in: created.users } } });
  await prisma.user.deleteMany({ where: { id: { in: created.users } } });
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
