import { prisma } from '@/lib/db';
import { audit } from '@/lib/audit';

/**
 * A place to practise that cannot touch anything real.
 *
 * An owner needs to see what a caller sees, walk a disposition through, find
 * out what the missing-field gate does — and none of that is worth a single
 * real buyer being rung by somebody testing a form. The old page offered
 * "Assign 25" against live opportunities as the only way to look at the
 * workspace with anything in it, which meant inspecting the product cost you
 * twenty-five real records for the day.
 *
 * The isolation is not a filter in this file. Every record here is written with
 * `dataMode: 'TEST'`, and database triggers refuse to join a test caller to a
 * production route, a production caller to a test route, or an attempt to a
 * route of the other kind. This file could contain a bug and the isolation
 * would still hold.
 *
 * The fixtures are deterministic and keyed, so resetting returns the sandbox to
 * a known state rather than accumulating a pile of half-worked practice
 * records, and so a screenshot from last week matches what you see today.
 */

/** Prefix on every fixture key. Also what `reset` scopes itself to. */
const FIXTURE = 'sandbox';

const TEST_MARK = '[TEST]';

/**
 * Three fixtures, one per business the platform actually serves.
 *
 * Chosen so the sandbox exercises different shapes: a distribution buyer with a
 * quantity, a brokerage lane with a deadline, and a subcontracting scope with a
 * site count. A single fixture would let a script pass that only ever handles
 * one kind of conversation.
 */
const FIXTURES = [
  {
    key: 'distribution',
    company: 'Northwind Restaurant Group',
    stateCode: 'TX',
    cityName: 'Dallas',
    phone: '+1 555 0100',
    contact: { firstName: 'Dana', lastName: 'Whitfield', title: 'Operations Manager' },
    route: 'DISTRIBUTION' as const,
    eventType: 'EXPANSION' as const,
    headline: `${TEST_MARK} Nine new sites need a janitorial supply line`,
    summary: `${TEST_MARK} Practice record. Northwind is opening nine locations and has no supplier for consumables.`,
    rationale: `${TEST_MARK} Sandbox fixture for the distribution conversation: quantity, cadence, delivery.`,
    capability: 'Janitorial consumables distribution',
  },
  {
    key: 'brokerage',
    company: 'Harbor Point Facilities',
    stateCode: 'IL',
    cityName: 'Chicago',
    phone: '+1 555 0101',
    contact: { firstName: 'Marcus', lastName: 'Ellery', title: 'Facilities Director' },
    route: 'BROKERAGE' as const,
    eventType: 'CONTRACT_EXPIRATION' as const,
    headline: `${TEST_MARK} Cleaning contract ends in March across four buildings`,
    summary: `${TEST_MARK} Practice record. The incumbent contract lapses and nothing has been re-tendered.`,
    rationale: `${TEST_MARK} Sandbox fixture for the brokerage conversation: incumbent, timing, decision process.`,
    capability: 'Commercial cleaning brokerage',
  },
  {
    key: 'subcontracting',
    company: 'Ridgeway Construction',
    stateCode: 'CA',
    cityName: 'Sacramento',
    phone: '+1 555 0102',
    contact: { firstName: 'Priya', lastName: 'Nandini', title: 'Project Lead' },
    route: 'SUBCONTRACTING' as const,
    eventType: 'CONTRACT_AWARD' as const,
    headline: `${TEST_MARK} Post-construction clean needed on a won bid`,
    summary: `${TEST_MARK} Practice record. Ridgeway won a fit-out and needs a post-construction clean subcontractor.`,
    rationale: `${TEST_MARK} Sandbox fixture for the subcontracting conversation: scope, sites, start date.`,
    capability: 'Post-construction cleaning',
  },
];

export type SandboxState = {
  companies: number;
  routes: number;
  callers: number;
  /** Live items across every test packet. */
  waiting: number;
};

/**
 * Build the sandbox, or return it unchanged if it is already there.
 *
 * Idempotent on the fixture keys, so pressing the button twice does not produce
 * six practice companies.
 */
export async function ensureSandbox(params: {
  orgId: string;
  actorId: string;
}): Promise<SandboxState> {
  for (const fixture of FIXTURES) {
    const dedupeKey = `${FIXTURE}:${fixture.key}`;

    const existing = await prisma.demandEvent.findFirst({
      where: { orgId: params.orgId, dedupeKey, dataMode: 'TEST' },
      select: { id: true },
    });
    if (existing) continue;

    await prisma.$transaction(async (tx) => {
      const company = await tx.company.create({
        data: {
          orgId: params.orgId,
          dataMode: 'TEST',
          // The marker is in the name itself, so it is visible on every screen
          // that shows a company without each of them having to remember.
          legalName: `${TEST_MARK} ${fixture.company}`,
          operatingName: `${TEST_MARK} ${fixture.company}`,
          stateCode: fixture.stateCode,
          cityName: fixture.cityName,
          phone: fixture.phone,
          origin: 'SEED_DEMO',
        },
        select: { id: true },
      });

      await tx.contact.create({
        data: {
          orgId: params.orgId,
          companyId: company.id,
          firstName: fixture.contact.firstName,
          lastName: fixture.contact.lastName,
          title: fixture.contact.title,
          phone: fixture.phone,
          isDecisionMaker: true,
          // A real timezone, so the business-hours rule behaves exactly as it
          // does in production rather than being special-cased for practice.
          timezone: fixture.stateCode === 'CA' ? 'America/Los_Angeles'
            : fixture.stateCode === 'IL' ? 'America/Chicago' : 'America/Chicago',
        },
      });

      const event = await tx.demandEvent.create({
        data: {
          orgId: params.orgId,
          dataMode: 'TEST',
          type: fixture.eventType,
          connector: 'sandbox',
          sourceRecordId: dedupeKey,
          dedupeKey,
          headline: fixture.headline,
          summary: fixture.summary,
          stateCode: fixture.stateCode,
          cityName: fixture.cityName,
          lifecycle: 'VERIFIED',
          verification: 'HUMAN_VERIFIED',
        },
        select: { id: true },
      });

      const route = await tx.routeHypothesis.create({
        data: {
          orgId: params.orgId,
          dataMode: 'TEST',
          eventId: event.id,
          companyId: company.id,
          route: fixture.route,
          playbookKey: `${FIXTURE}.${fixture.key}`,
          headline: fixture.headline,
          rationale: fixture.rationale,
          requiredCapability: fixture.capability,
          tier: 'ACTIVE_DEMAND',
          friction: 'LOW',
          status: 'ACTIVE',
        },
        select: { id: true },
      });

      await tx.outreachState.create({
        data: { orgId: params.orgId, routeId: route.id, status: 'NEW' },
      });
    });
  }

  await audit({
    orgId: params.orgId, userId: params.actorId, action: 'sandbox.created',
    entityType: 'Organization', entityId: params.orgId,
    metadata: { fixtures: FIXTURES.map((f) => f.key) },
  });

  return sandboxState(params.orgId);
}

/**
 * Put the sandbox back how it started.
 *
 * Scoped to `dataMode: 'TEST'` at every step. That is the whole safety
 * argument: production rows are a different value in the same column, so a
 * reset cannot reach them even if the fixture keys were wrong. Test *callers*
 * survive — resetting the work is not the same as deleting the people, and an
 * owner who loses their test caller every reset stops using the sandbox.
 */
export async function resetSandbox(params: {
  orgId: string;
  actorId: string;
}): Promise<SandboxState> {
  const removed = await prisma.$transaction(async (tx) => {
    const routes = await tx.routeHypothesis.findMany({
      where: { orgId: params.orgId, dataMode: 'TEST' },
      select: { id: true, companyId: true, eventId: true },
    });
    const routeIds = routes.map((r) => r.id);

    if (routeIds.length > 0) {
      // Order matters only because of foreign keys; every one of these is
      // filtered to the test world.
      await tx.callReview.deleteMany({ where: { session: { routeId: { in: routeIds } } } });
      await tx.callInsight.deleteMany({ where: { session: { routeId: { in: routeIds } } } });
      await tx.callTranscript.deleteMany({ where: { session: { routeId: { in: routeIds } } } });
      await tx.callSession.deleteMany({ where: { routeId: { in: routeIds } } });
      await tx.consistencyCase.deleteMany({ where: { routeId: { in: routeIds } } });
      await tx.intervention.deleteMany({ where: { routeId: { in: routeIds } } });
      await tx.workIncident.deleteMany({ where: { routeId: { in: routeIds } } });
      await tx.packetItem.deleteMany({ where: { orgId: params.orgId, dataMode: 'TEST' } });
      await tx.outreachAttempt.deleteMany({ where: { orgId: params.orgId, dataMode: 'TEST' } });
      await tx.outreachState.deleteMany({ where: { routeId: { in: routeIds } } });
      await tx.buyerRequirement.deleteMany({ where: { routeId: { in: routeIds } } });
      await tx.routeHypothesis.deleteMany({ where: { id: { in: routeIds } } });
    }

    await tx.workPacket.deleteMany({ where: { orgId: params.orgId, dataMode: 'TEST' } });
    await tx.demandEvent.deleteMany({ where: { orgId: params.orgId, dataMode: 'TEST' } });
    await tx.contact.deleteMany({ where: { orgId: params.orgId, company: { dataMode: 'TEST' } } });
    await tx.company.deleteMany({ where: { orgId: params.orgId, dataMode: 'TEST' } });

    return routeIds.length;
  });

  await audit({
    orgId: params.orgId, userId: params.actorId, action: 'sandbox.reset',
    entityType: 'Organization', entityId: params.orgId,
    metadata: { routesRemoved: removed },
  });

  return ensureSandbox(params);
}

/** What is in the sandbox right now, for the owner page. */
export async function sandboxState(orgId: string): Promise<SandboxState> {
  const [companies, routes, callers, waiting] = await Promise.all([
    prisma.company.count({ where: { orgId, dataMode: 'TEST' } }),
    prisma.routeHypothesis.count({ where: { orgId, dataMode: 'TEST' } }),
    prisma.user.count({ where: { orgId, callerProfile: { dataMode: 'TEST' } } }),
    prisma.packetItem.count({
      where: { orgId, dataMode: 'TEST', status: { in: ['PENDING', 'IN_PROGRESS'] } },
    }),
  ]);
  return { companies, routes, callers, waiting };
}

/**
 * Whether a record is sandbox data.
 *
 * Used by every outbound path — email, telephony, provider requests, deal
 * rooms — so a practice record cannot cause a real message to leave the
 * building. The check is on the route's own column rather than on a name
 * prefix, because a name is editable and a mode is not.
 */
export async function isSandboxRoute(routeId: string): Promise<boolean> {
  const route = await prisma.routeHypothesis.findUnique({
    where: { id: routeId },
    select: { dataMode: true },
  });
  return route?.dataMode === 'TEST';
}
