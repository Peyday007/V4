import { prisma } from '@/lib/db';
import { assessFulfilment, loadProviders } from '@/lib/demand/fulfilment';

/**
 * Automatic supply resolution.
 *
 * The counterpart to contact resolution on the other side of the deal. Demand
 * that cannot be delivered is not rejected — that would mean the provider
 * network could never grow toward the work that exists — but a caller must
 * know, before they open their mouth, whether they are talking to somebody we
 * can serve, somebody we have a candidate for, or somebody we have nobody for.
 *
 * The matching itself is not reimplemented. `assessFulfilment` already runs the
 * six checks and already distinguishes a verified provider from a candidate;
 * what this adds is running it again when the catalogue changes, rather than
 * only when an event does, and raising a research task exactly once when
 * automatic matching genuinely finds nobody.
 *
 * Deliberately not in scope, and deliberately not started: provider outreach,
 * contracting and pricing. This looks things up. It does not recruit anyone.
 */

export type SupplyOutcome = {
  routesConsidered: number;
  /** Routes whose fulfilment status changed this pass. */
  changed: number;
  /** Routes that stopped being blocked because the catalogue improved. */
  unblocked: number;
  /** Routes that became blocked because it got worse. */
  blocked: number;
  withVerifiedProvider: number;
  withCandidateOnly: number;
  withNobody: number;
  /** Research tasks raised, only where automatic matching found nothing. */
  tasksCreated: number;
};

export async function resolveSupply(params: { orgId: string; now?: Date }): Promise<SupplyOutcome> {
  const now = params.now ?? new Date();
  const outcome: SupplyOutcome = {
    routesConsidered: 0,
    changed: 0,
    unblocked: 0,
    blocked: 0,
    withVerifiedProvider: 0,
    withCandidateOnly: 0,
    withNobody: 0,
    tasksCreated: 0,
  };

  // Loaded once. A catalogue lookup per route would be hundreds of round trips
  // against a set that does not change during the pass.
  const providers = await loadProviders(params.orgId);

  const routes = await prisma.routeHypothesis.findMany({
    where: {
      orgId: params.orgId,
      status: { notIn: ['EXPIRED', 'REJECTED'] },
      tier: { in: ['ACTIVE_DEMAND', 'STRONG_TRIGGER'] },
    },
    select: {
      id: true,
      status: true,
      fulfilmentStatus: true,
      requiredCapability: true,
      windowClosesAt: true,
      matchedProviderIds: true,
      event: { select: { stateCode: true, cityName: true, deadlineAt: true } },
    },
  });

  const sourcingNeeded = new Map<string, { capability: string; stateCode: string | null; routes: number }>();

  for (const route of routes) {
    if (!route.requiredCapability) continue;
    outcome.routesConsidered += 1;

    const assessment = assessFulfilment({
      requiredCapability: route.requiredCapability,
      stateCode: route.event.stateCode,
      cityName: route.event.cityName,
      neededBy: route.windowClosesAt ?? route.event.deadlineAt ?? null,
      providers,
      now,
    });

    if (assessment.verified.length > 0) outcome.withVerifiedProvider += 1;
    else if (assessment.matched.length > 0) outcome.withCandidateOnly += 1;
    else outcome.withNobody += 1;

    const wasBlocked = route.status === 'BLOCKED_ON_SUPPLY';
    const nowBlocked = assessment.blocksPursuit;

    // Only the supply-driven part of the status is touched. A route sitting in
    // RESEARCH because friction is unknown is not promoted by supply news, and
    // a route in PURSUE is not demoted unless supply actually went away.
    const status = nowBlocked
      ? 'BLOCKED_ON_SUPPLY'
      : wasBlocked
        ? 'RESEARCH'
        : route.status;

    const statusChange =
      status !== route.status
        ? {
            status,
            statusReason: nowBlocked
              ? `${assessment.reason} Held out of serious pursuit until a provider exists, and kept until the window closes.`
              : 'Supply is no longer the blocker — the provider catalogue now covers this work.',
          }
        : {};

    if (assessment.status !== route.fulfilmentStatus || status !== route.status) {
      outcome.changed += 1;
      if (wasBlocked && !nowBlocked) outcome.unblocked += 1;
      if (!wasBlocked && nowBlocked) outcome.blocked += 1;

      await prisma.routeHypothesis.update({
        where: { id: route.id },
        data: {
          fulfilmentStatus: assessment.status,
          fulfilmentReason: assessment.reason,
          // Defensible candidates are attached whether or not they are
          // verified. A caller can see who exists; the status says what may
          // be promised about them.
          matchedProviderIds: assessment.matched.slice(0, 5).map((m) => m.id),
          providerCount: assessment.matched.length,
          ...statusChange,
        },
      });
    }

    // A research task only where automatic matching found nobody at all. A
    // candidate that merely needs verifying is a phone call, not a recruitment
    // drive, and raising a task for it would bury the real gaps.
    if (assessment.matched.length === 0) {
      const key = `${route.requiredCapability}|${route.event.stateCode ?? '—'}`;
      const held = sourcingNeeded.get(key);
      if (held) held.routes += 1;
      else
        sourcingNeeded.set(key, {
          capability: route.requiredCapability,
          stateCode: route.event.stateCode,
          routes: 1,
        });
    }
  }

  outcome.tasksCreated = await raiseSourcingTasks(params.orgId, [...sourcingNeeded.values()]);
  return outcome;
}

/**
 * One task per capability and state, not one per route.
 *
 * Forty routes needing post-construction cleaning in Illinois is one recruiting
 * job. Forty tasks would be a to-do list nobody reads, which is the same as no
 * task at all.
 */
async function raiseSourcingTasks(
  orgId: string,
  gaps: Array<{ capability: string; stateCode: string | null; routes: number }>,
): Promise<number> {
  let created = 0;

  for (const gap of gaps) {
    const title = `Find a provider: ${gap.capability}${gap.stateCode ? ` in ${gap.stateCode}` : ''}`;
    const existing = await prisma.task.findFirst({
      where: { orgId, title, status: { in: ['OPEN', 'IN_PROGRESS'] } },
      select: { id: true, description: true },
    });

    const description =
      `${gap.routes} live opportunit${gap.routes === 1 ? 'y' : 'ies'} need ${gap.capability.toLowerCase()}` +
      `${gap.stateCode ? ` in ${gap.stateCode}` : ''} and nobody on file can do it. The demand is real and is being ` +
      'kept until its window closes — this is a supply gap, not a bad lead. Recruiting is a human job; automatic ' +
      'matching has already searched the provider catalogue and found nobody.';

    if (existing) {
      // Refreshed rather than duplicated, so the count stays current.
      if (existing.description !== description) {
        await prisma.task.update({ where: { id: existing.id }, data: { description } });
      }
      continue;
    }

    await prisma.task.create({
      data: {
        orgId,
        title,
        description,
        kind: 'provider_research',
        priority: gap.routes >= 5 ? 'HIGH' : 'MEDIUM',
        createdByProcess: 'supply_resolution',
      },
    });
    created += 1;
  }

  return created;
}

/**
 * A fingerprint of the provider catalogue.
 *
 * Cheap enough to compute every tick, and it changes exactly when re-running
 * the match could produce a different answer: a provider added, a capability
 * attached, a territory widened, an insurance certificate recorded.
 */
export async function providerCatalogueFingerprint(orgId: string): Promise<string> {
  const [row] = await prisma.$queryRaw<Array<{ providers: bigint; capabilities: bigint; touched: Date | null }>>`
    SELECT
      COUNT(DISTINCT c."id")::bigint  AS providers,
      COUNT(cc."id")::bigint          AS capabilities,
      MAX(c."updatedAt")              AS touched
    FROM "Company" c
    LEFT JOIN "CompanyCapability" cc ON cc."companyId" = c."id"
    WHERE c."orgId" = ${orgId}
      AND c."companyRole" IN ('SUBCONTRACTOR', 'SUPPLIER', 'DISTRIBUTOR', 'MANUFACTURER', 'CARRIER')
  `;
  return [row?.providers ?? 0, row?.capabilities ?? 0, row?.touched?.toISOString() ?? ''].join('|');
}
