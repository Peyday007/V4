import { prisma } from '@/lib/db';
import { queueSummary } from '@/lib/demand/queue';
import { unavailableSources } from '@/lib/enrichment/sources';

/**
 * The whole chain, in order, naming only the first break.
 *
 * Every screen in this application reports on itself accurately and the answer
 * is on none of them. Source health says the connectors ran. The demand board
 * says there are opportunities. Contact resolution says it attempted them. All
 * true, all useless, when the question is "why has nobody made a call this
 * week" — because the break is one stage upstream of wherever you happen to be
 * looking, and each screen can only see its own stage.
 *
 * So this walks the stages in the order work actually moves through them and
 * points at the *first* one that is not passing work along. Fixing stage six
 * while stage two is dry is how a fortnight goes by.
 *
 * Two rules make it honest:
 *
 *   A stage that is not built says NOT_BUILT rather than OK. An unbuilt stage
 *   passing no work is not a healthy stage, and reporting it green is how a
 *   system claims to be finished while no money has ever moved through it.
 *
 *   Every stage downstream of the first break is marked as such rather than
 *   given a verdict of its own. An empty calling queue below a dry demand
 *   source is not a calling problem, and saying so sends somebody to the wrong
 *   screen.
 */

export type StageStatus =
  /** Work is passing through. */
  | 'OK'
  /** Working, but with a problem worth naming. */
  | 'DEGRADED'
  /** Work is not passing through and this is why. */
  | 'BLOCKED'
  /** Nothing to do here, and nothing wrong. */
  | 'IDLE'
  /** Downstream of the first break; not judged on its own. */
  | 'DOWNSTREAM'
  /** Not implemented yet. Not the same as healthy. */
  | 'NOT_BUILT';

/**
 * Which track a stage belongs to.
 *
 * Demand and supply are not one queue. A route with no provider is a real gap
 * whether or not anybody made a call today, and recruiting happens regardless
 * of calling — so treating supply as "downstream" of an idle phone would hide
 * the one thing a caller must know before they promise delivery.
 */
export type ChainTrack = 'demand' | 'supply' | 'money';

export type ChainStage = {
  key: string;
  track: ChainTrack;
  label: string;
  /** What must be true here for work to reach the next stage. */
  expectation: string;
  status: StageStatus;
  /** What is actually happening, in the operator's words. */
  detail: string;
  /** The numbers the verdict was read from, so it can be checked. */
  measures: Array<{ label: string; value: string }>;
  /** The next action, when there is one. */
  remedy: string | null;
  href: string | null;
};

export type ChainHealth = {
  stages: ChainStage[];
  /** The first break on the demand track — the one worth acting on. */
  firstBreak: ChainStage | null;
  /** The supply track's own verdict, never masked by a demand-side break. */
  supplyBreak: ChainStage | null;
  /** True once every built stage is passing work. */
  flowing: boolean;
  checkedAt: string;
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function ago(date: Date | null | undefined): string {
  if (!date) return 'never';
  const ms = Date.now() - date.getTime();
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / 60_000))}m ago`;
  if (ms < DAY) return `${Math.round(ms / HOUR)}h ago`;
  return `${Math.round(ms / DAY)}d ago`;
}

export async function chainHealth(orgId: string): Promise<ChainHealth> {
  const now = Date.now();

  const [
    lastRun,
    runsLastDay,
    failedRuns,
    eventCounts,
    unresolvedParties,
    routedEvents,
    verifiedNoRoutes,
    resolution,
    unscheduled,
    queue,
    lastAttempt,
    attemptsLastWeek,
    qualified,
    supplyGaps,
  ] = await Promise.all([
    prisma.sourceRun.findFirst({ where: { orgId }, orderBy: { startedAt: 'desc' } }),
    prisma.sourceRun.count({ where: { orgId, startedAt: { gte: new Date(now - DAY) } } }),
    prisma.sourceRun.count({
      where: { orgId, startedAt: { gte: new Date(now - DAY) }, status: { in: ['FAILED', 'NOT_CONFIGURED'] } },
    }),
    prisma.$queryRaw<Array<{ lifecycle: string; n: bigint }>>`
      SELECT "lifecycle"::text AS lifecycle, COUNT(*)::bigint AS n
      FROM "DemandEvent" WHERE "orgId" = ${orgId} GROUP BY "lifecycle"
    `,
    prisma.demandEventParty.count({
      where: { companyId: null, event: { orgId, lifecycle: 'VERIFIED' } },
    }),
    prisma.routeHypothesis.count({ where: { orgId, dataMode: 'PRODUCTION', status: { notIn: ['EXPIRED', 'REJECTED'] } } }),
    prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count FROM "DemandEvent" e
      LEFT JOIN "RouteHypothesis" r ON r."eventId" = e."id"
      WHERE e."orgId" = ${orgId} AND e."lifecycle" = 'VERIFIED' AND r."id" IS NULL
    `,
    prisma.$queryRaw<Array<{ status: string; n: bigint; last: Date | null }>>`
      SELECT "status"::text AS status, COUNT(*)::bigint AS n, MAX("lastAttemptAt") AS last
      FROM "ContactResolution" WHERE "orgId" = ${orgId} GROUP BY "status"
    `,
    prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(DISTINCT r."companyId")::bigint AS count
      FROM "RouteHypothesis" r
      LEFT JOIN "ContactResolution" cr ON cr."companyId" = r."companyId"
      WHERE r."orgId" = ${orgId} AND r."status" NOT IN ('EXPIRED','REJECTED') AND cr."id" IS NULL
    `,
    queueSummary(orgId),
    prisma.outreachAttempt.findFirst({ where: { orgId, dataMode: 'PRODUCTION' }, orderBy: { occurredAt: 'desc' } }),
    prisma.outreachAttempt.count({ where: { orgId, dataMode: 'PRODUCTION', occurredAt: { gte: new Date(now - 7 * DAY) } } }),
    prisma.outreachState.count({ where: { orgId, status: 'QUALIFIED' } }),
    prisma.routeHypothesis.count({
      where: { orgId, status: { notIn: ['EXPIRED', 'REJECTED'] }, fulfilmentStatus: { not: 'AVAILABLE' } },
    }),
  ]);

  const money = await moneyCounts(orgId);

  const events = new Map(eventCounts.map((r) => [r.lifecycle, Number(r.n)]));
  const eventTotal = [...events.values()].reduce((a, b) => a + b, 0);
  const verified = events.get('VERIFIED') ?? 0;
  const resolutionByStatus = new Map(resolution.map((r) => [r.status, Number(r.n)]));
  const resolutionTotal = [...resolutionByStatus.values()].reduce((a, b) => a + b, 0);
  const lastResolutionAttempt = resolution
    .map((r) => r.last)
    .filter((d): d is Date => Boolean(d))
    .sort((a, b) => b.getTime() - a.getTime())[0];
  const missingSources = unavailableSources();

  const stages: ChainStage[] = [];

  // --- 1. demand sources -------------------------------------------------
  stages.push({
    key: 'sources',
    track: 'demand',
    label: 'Demand sources',
    expectation: 'Connectors run on their own schedule and examine records.',
    ...(lastRun === null
      ? {
          status: 'BLOCKED' as const,
          detail: 'No demand source has ever run. Nothing can enter the system.',
          remedy: 'Check the scheduler is calling /api/cron/tick, then open Source health.',
        }
      : now - lastRun.startedAt.getTime() > 2 * DAY
        ? {
            status: 'BLOCKED' as const,
            detail: `The last source run was ${ago(lastRun.startedAt)}. Nothing new is arriving.`,
            remedy: 'The scheduler is not reaching the tick route, or every connector is unconfigured.',
          }
        : failedRuns > 0 && failedRuns === runsLastDay
          ? {
              status: 'BLOCKED' as const,
              detail: `Every one of the last ${runsLastDay} run(s) failed or was unconfigured. ${lastRun.error?.slice(0, 160) ?? ''}`,
              remedy: 'Open Source health — the failing connector names its own remedy.',
            }
          : failedRuns > 0
            ? {
                status: 'DEGRADED' as const,
                detail: `${failedRuns} of ${runsLastDay} run(s) in the last day failed or were unconfigured.`,
                remedy: 'Some sources are down. The rest are still producing.',
              }
            : {
                status: 'OK' as const,
                detail: `${runsLastDay} run(s) in the last day, most recent ${ago(lastRun.startedAt)}.`,
                remedy: null,
              }),
    measures: [
      { label: 'runs, last day', value: String(runsLastDay) },
      { label: 'failed or unconfigured', value: String(failedRuns) },
      { label: 'last run', value: ago(lastRun?.startedAt) },
    ],
    href: '/demand/sources',
  });

  // --- 2. demand events --------------------------------------------------
  stages.push({
    key: 'events',
    track: 'demand',
    label: 'Dated demand events',
    expectation: 'Source records become dated, verified events with evidence.',
    ...(eventTotal === 0
      ? {
          status: 'BLOCKED' as const,
          detail: 'Sources ran but produced no events at all.',
          remedy: 'Check Source health for records examined versus events created.',
        }
      : verified === 0
        ? {
            status: 'BLOCKED' as const,
            detail: `${eventTotal} event(s) exist but none is verified, so none can produce a route.`,
            remedy: 'Events are quarantined or expired. Source health lists the rejection reasons.',
          }
        : {
            status: 'OK' as const,
            detail: `${verified} verified event(s) of ${eventTotal}.`,
            remedy: null,
          }),
    measures: [
      { label: 'verified', value: String(verified) },
      { label: 'quarantined', value: String(events.get('QUARANTINED') ?? 0) },
      { label: 'expired', value: String(events.get('EXPIRED') ?? 0) },
    ],
    href: '/demand/sources',
  });

  // --- 3. organisation resolution ---------------------------------------
  stages.push({
    key: 'accounts',
    track: 'demand',
    label: 'Organisation and location',
    expectation: 'Each named party resolves to one canonical organisation at one site.',
    ...(verified > 0 && unresolvedParties > 0 && routedEvents === 0
      ? {
          status: 'BLOCKED' as const,
          detail: `${unresolvedParties} named organisation(s) on verified events resolve to nothing.`,
          remedy: 'The names are too thin to match or create an account. Check event quarantine reasons.',
        }
      : unresolvedParties > 0
        ? {
            status: 'DEGRADED' as const,
            detail: `${unresolvedParties} named organisation(s) are still unresolved; the rest routed.`,
            remedy: 'Unresolved names are held for review rather than guessed at.',
          }
        : {
            status: 'OK' as const,
            detail: 'Every named party on a verified event resolves to an organisation.',
            remedy: null,
          }),
    measures: [{ label: 'unresolved parties', value: String(unresolvedParties) }],
    href: '/demand',
  });

  // --- 4. routes ---------------------------------------------------------
  const unrouted = Number(verifiedNoRoutes[0]?.count ?? 0);
  stages.push({
    key: 'routes',
    track: 'demand',
    label: 'Commercial routes',
    expectation: 'Verified events produce route hypotheses a playbook can act on.',
    ...(routedEvents === 0
      ? {
          status: 'BLOCKED' as const,
          detail: 'No live routes exist. Verified demand is not becoming commercial opportunities.',
          remedy: 'No playbook matched, or no resolved buyer filled the role a playbook needs.',
        }
      : unrouted > 0
        ? {
            status: 'DEGRADED' as const,
            detail: `${routedEvents} live route(s). ${unrouted} verified event(s) produced none.`,
            remedy: 'Events with no route are recorded with the reason no playbook fired.',
          }
        : { status: 'OK' as const, detail: `${routedEvents} live route(s).`, remedy: null }),
    measures: [
      { label: 'live routes', value: String(routedEvents) },
      { label: 'verified events with no route', value: String(unrouted) },
    ],
    href: '/demand',
  });

  // --- 5. contact resolution --------------------------------------------
  const notScheduled = Number(unscheduled[0]?.count ?? 0);
  const resolved = resolutionByStatus.get('RESOLVED') ?? 0;
  stages.push({
    key: 'contact',
    track: 'demand',
    label: 'Contact resolution',
    expectation: 'Every organisation with live demand is scheduled, attempted and given a verdict.',
    ...(routedEvents > 0 && resolutionTotal === 0
      ? {
          status: 'BLOCKED' as const,
          detail: 'Live routes exist and not one organisation has been scheduled for contact resolution.',
          remedy: 'The recurring tick is not running. Check the scheduler before anything else.',
        }
      : notScheduled > 0
        ? {
            status: 'DEGRADED' as const,
            detail: `${notScheduled} organisation(s) with live demand have no contact-resolution state yet.`,
            remedy: 'The next tick brings in the next batch. If this number does not fall, the tick is not running.',
          }
        : missingSources.length > 0 && resolved === 0
          ? {
              status: 'BLOCKED' as const,
              detail: `Every organisation was attempted and none resolved. ${missingSources.map((s) => s.reason).join(' ')}`,
              remedy: missingSources[0].fix,
            }
          : missingSources.length > 0
            ? {
                status: 'DEGRADED' as const,
                detail: `${resolved} resolved, but the search is narrower than it could be. ${missingSources.map((s) => s.reason).join(' ')}`,
                remedy: missingSources[0].fix,
              }
            : resolved === 0
              ? {
                  status: 'BLOCKED' as const,
                  detail: 'Every organisation was searched and none produced a usable contact.',
                  remedy: 'Open Contact resolution — each record names its own blocker.',
                }
              : {
                  status: 'OK' as const,
                  detail: `${resolved} organisation(s) resolved, last attempt ${ago(lastResolutionAttempt)}.`,
                  remedy: null,
                }),
    measures: [
      { label: 'resolved', value: String(resolved) },
      { label: 'ambiguous', value: String(resolutionByStatus.get('AMBIGUOUS') ?? 0) },
      { label: 'nothing published', value: String(resolutionByStatus.get('UNRESOLVED') ?? 0) },
      { label: 'failed', value: String(resolutionByStatus.get('FAILED') ?? 0) },
      { label: 'not scheduled', value: String(notScheduled) },
      { label: 'last attempt', value: ago(lastResolutionAttempt) },
    ],
    href: '/demand/sources',
  });

  // --- 6. callable work --------------------------------------------------
  stages.push({
    key: 'queue',
    track: 'demand',
    label: 'Work ready to call',
    expectation: 'Resolved contacts become opportunities a caller can be handed.',
    ...(queue.call_now === 0 && queue.research > 0
      ? {
          status: 'BLOCKED' as const,
          detail: `Nothing is callable. ${queue.research} opportunit(y/ies) are waiting on a contact route.`,
          remedy: 'This is a contact-resolution outcome, not a queue fault. See the stage above.',
        }
      : queue.call_now === 0
        ? {
            status: 'IDLE' as const,
            detail: 'Nothing callable and nothing waiting. There is no demand in the system to work.',
            remedy: null,
          }
        : {
            status: 'OK' as const,
            detail: `${queue.call_now} opportunit(y/ies) ready to call now.`,
            remedy: null,
          }),
    measures: [
      { label: 'call now', value: String(queue.call_now) },
      { label: 'research needed', value: String(queue.research) },
      { label: 'follow-ups due', value: String(queue.follow_up) },
    ],
    href: '/demand',
  });

  // --- 7. calling --------------------------------------------------------
  stages.push({
    key: 'outreach',
    track: 'demand',
    label: 'Calls being made',
    expectation: 'Somebody works the queue and records what happened.',
    ...(queue.call_now === 0
      ? {
          status: 'IDLE' as const,
          detail: 'No callable work to attempt.',
          remedy: null,
        }
      : attemptsLastWeek === 0
        ? {
            status: 'BLOCKED' as const,
            detail: `${queue.call_now} opportunit(y/ies) are callable and no attempt has been recorded in a week. Last attempt ${ago(lastAttempt?.occurredAt)}.`,
            remedy: 'The work is ready and nobody is working it. This is a staffing question, not a system fault.',
          }
        : {
            status: 'OK' as const,
            detail: `${attemptsLastWeek} attempt(s) in the last week, most recent ${ago(lastAttempt?.occurredAt)}.`,
            remedy: null,
          }),
    measures: [
      { label: 'attempts, last 7 days', value: String(attemptsLastWeek) },
      { label: 'last attempt', value: ago(lastAttempt?.occurredAt) },
      { label: 'qualified', value: String(qualified) },
    ],
    href: '/demand/call',
  });

  // --- 8. supply ---------------------------------------------------------
  stages.push({
    key: 'supply',
    track: 'supply',
    label: 'Supply able to deliver',
    expectation: 'A verified provider exists for the work being sold.',
    ...(supplyGaps > 0 && supplyGaps === routedEvents
      ? {
          status: 'BLOCKED' as const,
          detail: `No live route has a verified provider. ${supplyGaps} route(s) have a candidate at best.`,
          remedy: 'Recruiting is a human job. The provider-research tasks name each capability and state.',
        }
      : supplyGaps > 0
        ? {
            status: 'DEGRADED' as const,
            detail: `${supplyGaps} of ${routedEvents} live route(s) have no verified provider.`,
            remedy: 'A candidate is a lead on the supply side, not capacity that can be committed.',
          }
        : { status: 'OK' as const, detail: 'Every live route has a verified provider.', remedy: null }),
    measures: [
      { label: 'routes without a verified provider', value: String(supplyGaps) },
      { label: 'live routes', value: String(routedEvents) },
    ],
    href: '/demand?view=supply_needed',
  });

  // --- 9 onward: the money track ----------------------------------------
  //
  // These four stages read the deal-progression tables directly. Until they
  // existed there was nowhere in the system where money was recorded, so
  // nothing could ever be attributed to a source, a route or a caller — which
  // is why they were reported as NOT_BUILT rather than quietly omitted.
  //
  // They are still capable of saying IDLE, and IDLE here is the honest answer
  // for this business today: the tables exist, and nothing has been through
  // them. What must not happen is a money stage reading OK because a fixture
  // walked a row through it.
  for (const stage of moneyStages({ qualified, money })) stages.push(stage);

  // The first demand stage not passing work. Everything after it *on the same
  // track* is a consequence rather than a diagnosis, and is marked so nobody
  // chases it. Supply keeps its own verdict: it is a parallel track, and a
  // provider gap is real whether or not the phone rang today.
  const demandStages = stages.filter((s) => s.track === 'demand');
  const broken = demandStages.find((s) => s.status === 'BLOCKED') ?? null;
  if (broken) {
    const from = demandStages.indexOf(broken);
    for (const stage of demandStages.slice(from + 1)) {
      const at = stages.indexOf(stage);
      stages[at] = {
        ...stage,
        status: 'DOWNSTREAM',
        detail: `${stage.detail} Downstream of ${broken.label.toLowerCase()}, so this is a consequence rather than a fault of its own.`,
        remedy: null,
      };
    }
  }

  const supplyBreak = stages.find((s) => s.track === 'supply' && s.status === 'BLOCKED') ?? null;

  return {
    stages,
    firstBreak: broken,
    supplyBreak,
    // Never true until money has actually arrived. A chain that stops before
    // anybody is paid is not a chain that flows, and saying otherwise is how a
    // system reports itself finished having moved nothing. `collected > 0` is a
    // deliberately blunt condition: it is the only one that cannot be satisfied
    // by a well-formed record.
    flowing:
      broken === null &&
      supplyBreak === null &&
      stages.every((s) => s.status !== 'NOT_BUILT') &&
      money.collected > 0,
    checkedAt: new Date().toISOString(),
  };
}

type MoneyCounts = {
  requirements: number;
  priceable: number;
  quotes: number;
  quotesWithCost: number;
  sent: number;
  accepted: number;
  deals: number;
  providerCommitted: number;
  delivered: number;
  invoiced: number;
  settledIn: number;
  collected: number;
  paidOut: number;
};

async function moneyCounts(orgId: string): Promise<MoneyCounts> {
  const [
    requirements, priceable, quotes, quotesWithCost, sent, accepted,
    deals, providerCommitted, delivered, invoiced, inbound, outbound,
  ] = await Promise.all([
    prisma.buyerRequirement.count({ where: { orgId, state: 'CURRENT' } }),
    prisma.buyerRequirement.count({
      where: { orgId, state: 'CURRENT', specification: { not: null }, quantity: { not: null } },
    }),
    prisma.routeQuote.count({ where: { orgId } }),
    prisma.routeQuote.count({ where: { orgId, providerCost: { not: null } } }),
    prisma.routeQuote.count({ where: { orgId, state: { in: ['SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED'] } } }),
    prisma.routeQuote.count({ where: { orgId, state: 'ACCEPTED' } }),
    prisma.routeDeal.count({ where: { orgId } }),
    prisma.routeDeal.count({ where: { orgId, providerCommittedAt: { not: null } } }),
    prisma.routeDeal.count({ where: { orgId, deliveryCompletedAt: { not: null } } }),
    prisma.dealPayment.count({ where: { orgId, direction: 'INBOUND' } }),
    prisma.dealPayment.aggregate({
      where: { orgId, direction: 'INBOUND', settledAt: { not: null } },
      _sum: { amount: true }, _count: true,
    }),
    prisma.dealPayment.aggregate({
      where: { orgId, direction: 'OUTBOUND', settledAt: { not: null } },
      _sum: { amount: true },
    }),
  ]);

  const collectedIn = Number(inbound._sum.amount ?? 0);
  const paidOut = Number(outbound._sum.amount ?? 0);

  return {
    requirements, priceable, quotes, quotesWithCost, sent, accepted,
    deals, providerCommitted, delivered, invoiced,
    settledIn: inbound._count,
    // Collected gross profit: money that arrived, less money that left. An
    // invoice is not money and is never counted here.
    collected: collectedIn > 0 ? collectedIn - paidOut : 0,
    paidOut,
  };
}

function moneyStages(input: { qualified: number; money: MoneyCounts }): ChainStage[] {
  const { money } = input;
  const stages: ChainStage[] = [];

  stages.push({
    key: 'requirements',
    track: 'money',
    label: 'Buyer requirement captured',
    expectation: 'The buyer\'s scope, quantity, timing and authority are recorded as structured facts.',
    ...(input.qualified > 0 && money.requirements === 0
      ? {
          status: 'BLOCKED' as const,
          detail: `${input.qualified} qualified opportunit(y/ies) and not one recorded requirement. Nothing can be priced.`,
          remedy: 'A call that qualified something did not capture what they actually need. Open the opportunity and record it.',
        }
      : money.requirements === 0
        ? {
            status: 'IDLE' as const,
            detail: 'No buyer has told us what they need yet.',
            remedy: null,
          }
        : money.priceable === 0
          ? {
              status: 'DEGRADED' as const,
              detail: `${money.requirements} requirement(s), none of them with both a scope and a quantity. A price cannot follow from these.`,
              remedy: 'The missing fields are named on each opportunity. They come from the buyer, not from us.',
            }
          : {
              status: 'OK' as const,
              detail: `${money.priceable} of ${money.requirements} requirement(s) carry enough to price.`,
              remedy: null,
            }),
    measures: [
      { label: 'current requirements', value: String(money.requirements) },
      { label: 'priceable', value: String(money.priceable) },
    ],
    href: '/demand',
  });

  stages.push({
    key: 'quote',
    track: 'money',
    label: 'Quote and economics',
    expectation: 'A provider cost and a buyer price exist, with the gross profit that follows from them.',
    ...(money.priceable > 0 && money.quotes === 0
      ? {
          status: 'BLOCKED' as const,
          detail: `${money.priceable} priceable requirement(s) and no quote drafted.`,
          remedy: 'Open the opportunity and draft one. A requirement nobody prices is a conversation nobody finished.',
        }
      : money.quotes === 0
        ? { status: 'IDLE' as const, detail: 'Nothing has been quoted.', remedy: null }
        : money.quotesWithCost === 0
          ? {
              status: 'DEGRADED' as const,
              detail: `${money.quotes} quote(s) and not one with a provider cost. Every margin on these is a guess.`,
              remedy: 'A quote with no cost needs owner approval before it goes out, and it says so on the quote.',
            }
          : money.sent === 0
            ? {
                status: 'DEGRADED' as const,
                detail: `${money.quotes} quote(s) drafted and none sent.`,
                remedy: 'A drafted quote sitting in the system is worth what an unsent email is worth.',
              }
            : {
                status: 'OK' as const,
                detail: `${money.sent} quote(s) sent, ${money.accepted} accepted.`,
                remedy: null,
              }),
    measures: [
      { label: 'quotes', value: String(money.quotes) },
      { label: 'with a provider cost', value: String(money.quotesWithCost) },
      { label: 'sent', value: String(money.sent) },
      { label: 'accepted', value: String(money.accepted) },
    ],
    href: '/demand',
  });

  stages.push({
    key: 'commitment',
    track: 'money',
    label: 'Commitment and delivery',
    expectation: 'The buyer and provider commit, the work is delivered, and completion is evidenced.',
    ...(money.accepted > 0 && money.deals === 0
      ? {
          status: 'BLOCKED' as const,
          detail: `${money.accepted} accepted quote(s) and no deal recorded against any of them.`,
          remedy: 'An accepted quote with no commitment record means nobody has established what was actually agreed.',
        }
      : money.deals === 0
        ? { status: 'IDLE' as const, detail: 'Nobody has committed to anything yet.', remedy: null }
        : money.providerCommitted === 0
          ? {
              status: 'BLOCKED' as const,
              detail: `${money.deals} buyer commitment(s) and no provider committed to any of them. We have sold work nobody has agreed to do.`,
              remedy: 'This is the exposure that matters. Secure the provider or tell the buyer.',
            }
          : money.delivered === 0
            ? {
                status: 'DEGRADED' as const,
                detail: `${money.providerCommitted} of ${money.deals} deal(s) have a committed provider. None is delivered yet.`,
                remedy: 'Delivery is evidenced on the deal record when it completes.',
              }
            : {
                status: 'OK' as const,
                detail: `${money.delivered} of ${money.deals} deal(s) delivered.`,
                remedy: null,
              }),
    measures: [
      { label: 'deals', value: String(money.deals) },
      { label: 'provider committed', value: String(money.providerCommitted) },
      { label: 'delivered', value: String(money.delivered) },
    ],
    href: '/demand',
  });

  stages.push({
    key: 'payment',
    track: 'money',
    label: 'Payment and collected profit',
    expectation: 'An invoice is raised, paid, and the gross profit is realised rather than estimated.',
    ...(money.delivered > 0 && money.invoiced === 0
      ? {
          status: 'BLOCKED' as const,
          detail: `${money.delivered} delivered deal(s) and nothing invoiced. The work is done and nobody has asked to be paid for it.`,
          remedy: 'Raise the invoice on the deal record.',
        }
      : money.invoiced === 0
        ? { status: 'IDLE' as const, detail: 'Nothing has been invoiced.', remedy: null }
        : money.settledIn === 0
          ? {
              status: 'BLOCKED' as const,
              detail: `${money.invoiced} invoice(s) raised and not one settled. An invoice is not money.`,
              remedy: 'Chase them, or record the payment if it has arrived and was not entered.',
            }
          : {
              status: 'OK' as const,
              detail: `${money.settledIn} payment(s) received. Collected gross profit ${currency(money.collected)} after ${currency(money.paidOut)} paid out.`,
              remedy: null,
            }),
    measures: [
      { label: 'invoices raised', value: String(money.invoiced) },
      { label: 'payments settled', value: String(money.settledIn) },
      { label: 'collected gross profit', value: currency(money.collected) },
    ],
    href: '/demand',
  });

  return stages;
}

function currency(amount: number): string {
  return `$${amount.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}
