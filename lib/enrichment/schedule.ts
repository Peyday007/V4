import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { newWorkerId } from '@/lib/jobs/queue';
import { resolveCompanyContact, strongestProvenance, type ResolutionResult } from './resolve';

/**
 * Getting contact resolution to happen, on its own.
 *
 * Two entry points, one implementation. A demand source run schedules the
 * organisations its events named; a recurring worker sweeps up everything else
 * — records nothing scheduled, attempts that failed transiently, organisations
 * whose source data has since improved, and contacts that have gone stale. Both
 * call `sweepContactResolution`, which calls `resolveCompanyContact`, which is
 * the only thing that ever writes a contact.
 *
 * Nothing here is a queue of its own. `ContactResolution` is the queue: one row
 * per organisation, claimed by conditional update, so deploying twice or
 * running two workers produces one attempt rather than two, and a worker killed
 * mid-flight releases its claim rather than stranding the record.
 */

/** How many organisations one worker pass will attempt. */
export const DEFAULT_BATCH = 25;
/** How many organisations one pass will bring into the workflow. */
export const SCHEDULE_BATCH = 500;
/** A claim older than this belonged to a worker that is not coming back. */
const STALE_CLAIM_MS = 10 * 60_000;

function batchSize(requested?: number): number {
  const configured = Number(process.env.ENRICHMENT_BATCH_SIZE ?? '');
  const fallback = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_BATCH;
  return Math.min(Math.max(requested ?? fallback, 1), 200);
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

export type ScheduleOutcome = {
  /** Organisations that had no resolution row and now have one. */
  scheduled: number;
  /**
   * Organisations with live demand still carrying no resolution state.
   *
   * The number that matters operationally: while it is above zero the board
   * still has rows reading "Not scheduled", and the next invocation has work
   * to do. Reported rather than inferred, because inferring it from a total
   * was how a backlog that was never reached could look like one that was.
   */
  unscheduledRemaining: number;
};

/**
 * Puts every demand-linked organisation into the workflow.
 *
 * Called immediately after a source run's events are routed, and again by the
 * recurring worker. Idempotent in the way that matters: an organisation already
 * resolved, already ambiguous, or already waiting for its next attempt is left
 * exactly as it is, so redeploying does not re-do work or re-ask a provider a
 * question it has already answered.
 *
 * Scoped to accounts a route actually points at. Enriching every company row in
 * the workspace would spend the budget on directory entries nobody is going to
 * ring.
 */
export async function scheduleContactResolution(params: {
  orgId: string;
  /** Restrict to these accounts. Omitted means every account with live demand. */
  companyIds?: string[];
  /**
   * How many organisations this pass may bring into the workflow.
   *
   * Bounded so one invocation cannot be the whole backlog. A workspace with
   * fifty thousand accounts must not depend on a single serverless function
   * living long enough to insert fifty thousand rows — it takes a slice, the
   * next invocation takes the next, and the ordering below means the slices
   * arrive in the order they are worth doing.
   */
  limit?: number;
}): Promise<ScheduleOutcome> {
  const { orgId } = params;
  const limit = Math.min(Math.max(params.limit ?? SCHEDULE_BATCH, 1), 2000);

  const restriction = params.companyIds?.length
    ? Prisma.sql`AND r."companyId" IN (${Prisma.join(params.companyIds)})`
    : Prisma.empty;

  // One statement, so two workers arriving together produce one row per
  // organisation rather than a unique-constraint failure each.
  //
  // The anti-join against `ContactResolution` is what makes this a backlog
  // query rather than a re-scan: it selects organisations that have live demand
  // and no contact-resolution state at all, which is exactly the population
  // that predates the workflow and would otherwise never be picked up, because
  // nothing re-routes an event that was routed last week.
  const inserted = await prisma.$executeRaw`
    INSERT INTO "ContactResolution" ("id", "orgId", "companyId", "status", "nextAttemptAt", "createdAt", "updatedAt")
    SELECT gen_random_uuid()::text, ${orgId}, backlog."companyId", 'QUEUED', NOW(), NOW(), NOW()
    FROM (
      SELECT r."companyId" AS "companyId"
      FROM "RouteHypothesis" r
      LEFT JOIN "ContactResolution" cr ON cr."companyId" = r."companyId"
      WHERE r."orgId" = ${orgId}
        AND r."status" NOT IN ('EXPIRED', 'REJECTED')
        AND cr."id" IS NULL
        ${restriction}
      GROUP BY r."companyId"
      -- Tier A first, then by the nearest buying window, then Tier B the same
      -- way. Postgres orders enums by declaration and LeadTier declares
      -- ACTIVE_DEMAND first, so ascending is the operator's order.
      ORDER BY MIN(r."tier") ASC, MIN(r."windowClosesAt") ASC NULLS LAST, r."companyId" ASC
      LIMIT ${limit}
    ) backlog
    ON CONFLICT ("companyId") DO NOTHING
  `;

  const [{ count }] = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(DISTINCT r."companyId")::bigint AS count
    FROM "RouteHypothesis" r
    LEFT JOIN "ContactResolution" cr ON cr."companyId" = r."companyId"
    WHERE r."orgId" = ${orgId}
      AND r."status" NOT IN ('EXPIRED', 'REJECTED')
      AND cr."id" IS NULL
      ${restriction}
  `;

  return { scheduled: inserted, unscheduledRemaining: Number(count) };
}

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

/**
 * Takes the next few organisations, in the order they are worth doing.
 *
 * Priority is the operator's: live demand first, then the closest buying
 * window, then the account with the most routes riding on one phone number.
 * A record with an imminent window and no way to ring it is the most expensive
 * thing in the system, so it goes first.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes this safe to run from several workers
 * at once — a second worker steps over rows the first is claiming rather than
 * blocking behind them or duplicating them.
 *
 * The priority keys come back with the rows and are sorted again in the caller.
 * `UPDATE ... WHERE id IN (SELECT ... ORDER BY ...) RETURNING` orders which
 * rows are *chosen*, but `RETURNING` emits them in whatever order the update
 * touched them — so without the second sort the batch is selected by priority
 * and then worked in an arbitrary one. On a backlog larger than a batch that is
 * invisible; within a batch it means Tier B can be rung up before Tier A.
 */
export type ClaimedResolution = {
  id: string;
  companyId: string;
  tier: string | null;
  closes: Date | null;
  routes: number | null;
};

export async function claimResolutions(params: {
  orgId: string;
  limit: number;
  workerId: string;
  now?: Date;
}): Promise<ClaimedResolution[]> {
  const now = params.now ?? new Date();
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);

  const claimed = await prisma.$queryRaw<ClaimedResolution[]>`
    UPDATE "ContactResolution" AS target
    SET "status" = 'IN_PROGRESS', "lockedAt" = ${now}, "lockedBy" = ${params.workerId}
    WHERE target."id" IN (
      SELECT cr."id"
      FROM "ContactResolution" cr
      JOIN "Company" co ON co."id" = cr."companyId"
      LEFT JOIN LATERAL (
        SELECT MIN(r."tier") AS tier, MIN(r."windowClosesAt") AS closes, COUNT(*)::int AS routes
        FROM "RouteHypothesis" r
        WHERE r."companyId" = cr."companyId" AND r."status" NOT IN ('EXPIRED', 'REJECTED')
      ) p ON TRUE
      WHERE cr."orgId" = ${params.orgId}
        AND (
          -- due, or never attempted
          (cr."status" = 'QUEUED' AND (cr."nextAttemptAt" IS NULL OR cr."nextAttemptAt" <= ${now}))
          -- a schedule that has come round again
          OR (cr."status" IN ('RESOLVED', 'UNRESOLVED', 'FAILED') AND cr."nextAttemptAt" IS NOT NULL AND cr."nextAttemptAt" <= ${now})
          -- the account gained information since we last looked, whatever the schedule said
          OR (cr."lastAttemptAt" IS NOT NULL AND co."updatedAt" > cr."lastAttemptAt" AND cr."status" <> 'AMBIGUOUS')
          -- a worker that never came back
          OR (cr."status" = 'IN_PROGRESS' AND (cr."lockedAt" IS NULL OR cr."lockedAt" < ${staleBefore}))
        )
      ORDER BY p.tier ASC NULLS LAST, p.closes ASC NULLS LAST, p.routes DESC NULLS LAST, cr."createdAt" ASC
      LIMIT ${params.limit}
      FOR UPDATE OF cr SKIP LOCKED
    )
    RETURNING
      target."id",
      target."companyId",
      (SELECT MIN(r."tier")::text FROM "RouteHypothesis" r
        WHERE r."companyId" = target."companyId" AND r."status" NOT IN ('EXPIRED','REJECTED')) AS tier,
      (SELECT MIN(r."windowClosesAt") FROM "RouteHypothesis" r
        WHERE r."companyId" = target."companyId" AND r."status" NOT IN ('EXPIRED','REJECTED')) AS closes,
      (SELECT COUNT(*)::int FROM "RouteHypothesis" r
        WHERE r."companyId" = target."companyId" AND r."status" NOT IN ('EXPIRED','REJECTED')) AS routes
  `;

  return sortByPriority(claimed);
}

/** Tier A by nearest window, then Tier B the same way. */
export function sortByPriority<T extends { tier: string | null; closes: Date | null; routes: number | null }>(
  rows: T[],
): T[] {
  const tierRank = (tier: string | null) =>
    tier === 'ACTIVE_DEMAND' ? 0 : tier === 'STRONG_TRIGGER' ? 1 : 2;
  return [...rows].sort((a, b) => {
    const tier = tierRank(a.tier) - tierRank(b.tier);
    if (tier !== 0) return tier;
    // A window that closes sooner is worth more than one that closes later,
    // and an account with no window at all sorts last rather than first.
    const aCloses = a.closes ? a.closes.getTime() : Number.POSITIVE_INFINITY;
    const bCloses = b.closes ? b.closes.getTime() : Number.POSITIVE_INFINITY;
    if (aCloses !== bCloses) return aCloses - bCloses;
    return (b.routes ?? 0) - (a.routes ?? 0);
  });
}

// ---------------------------------------------------------------------------
// Working
// ---------------------------------------------------------------------------

export type SweepOutcome = {
  scheduled: number;
  attempted: number;
  resolved: number;
  ambiguous: number;
  unresolved: number;
  failed: number;
  /** Routes that became callable because of this pass. */
  released: number;
  /** Accounts released, for the report. */
  releasedAccounts: string[];
  /** Organisations still waiting, so a caller can see there is more to come. */
  remaining: number;
  /** Live-demand organisations still carrying no resolution state at all. */
  unscheduledRemaining: number;
  durationMs: number;
};

/**
 * One pass of the worker: schedule what is missing, then work what is due.
 *
 * The whole backfill is this function called until `remaining` reaches zero.
 * There is no separate backfill code path, because a backfill that behaved
 * differently from the steady state would be a second implementation with its
 * own bugs — and the first one to appear would be enriching the same
 * organisation twice.
 */
export async function sweepContactResolution(params: {
  orgId: string;
  limit?: number;
  workerId?: string;
  now?: Date;
}): Promise<SweepOutcome> {
  const startedAt = Date.now();
  const workerId = params.workerId ?? newWorkerId();
  const limit = batchSize(params.limit);

  const schedule = await scheduleContactResolution({ orgId: params.orgId });
  const claimed = await claimResolutions({ orgId: params.orgId, limit, workerId, now: params.now });

  const outcome: SweepOutcome = {
    scheduled: schedule.scheduled,
    attempted: 0,
    resolved: 0,
    ambiguous: 0,
    unresolved: 0,
    failed: 0,
    released: 0,
    releasedAccounts: [],
    remaining: 0,
    unscheduledRemaining: schedule.unscheduledRemaining,
    durationMs: 0,
  };

  for (const row of claimed) {
    outcome.attempted += 1;
    let result: ResolutionResult;
    try {
      result = await resolveCompanyContact({
        orgId: params.orgId,
        companyId: row.companyId,
        workerId,
        now: params.now,
      });
    } catch (error) {
      // The resolver writes its own result for anything it can anticipate.
      // Reaching here means something outside it broke — and the record must
      // still not be left claimed forever with no explanation.
      await prisma.contactResolution.update({
        where: { id: row.id },
        data: {
          status: 'FAILED',
          confidence: 'FAILED',
          blocker: 'Contact resolution crashed before it could reach a verdict.',
          failureKind: 'worker_error',
          failureDetail: String(error).slice(0, 2000),
          transientFailures: { increment: 1 },
          lastAttemptAt: new Date(),
          nextAttemptAt: new Date(Date.now() + 15 * 60_000),
          lockedAt: null,
          lockedBy: null,
        },
      });
      outcome.failed += 1;
      continue;
    }

    if (result.status === 'RESOLVED') outcome.resolved += 1;
    else if (result.status === 'AMBIGUOUS') outcome.ambiguous += 1;
    else if (result.status === 'UNRESOLVED') outcome.unresolved += 1;
    else if (result.status === 'FAILED') outcome.failed += 1;

    if (result.released) {
      outcome.released += result.callableRoutes;
      outcome.releasedAccounts.push(result.organisation);
    }
  }

  const [{ count }] = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count FROM "ContactResolution"
    WHERE "orgId" = ${params.orgId}
      AND "status" IN ('QUEUED', 'IN_PROGRESS')
  `;
  outcome.remaining = Number(count);
  outcome.durationMs = Date.now() - startedAt;
  return outcome;
}

/**
 * Runs the sweep until the backlog is clear or the budget runs out.
 *
 * Resumable by construction: state lives in the table, so a run that stops
 * halfway leaves the rest exactly where the next run will find it.
 */
export async function drainContactResolution(params: {
  orgId: string;
  budgetMs?: number;
  limit?: number;
  onBatch?: (outcome: SweepOutcome) => void;
}): Promise<SweepOutcome> {
  const budget = params.budgetMs ?? 45_000;
  const startedAt = Date.now();
  const total: SweepOutcome = {
    scheduled: 0, attempted: 0, resolved: 0, ambiguous: 0, unresolved: 0,
    failed: 0, released: 0, releasedAccounts: [], remaining: 0,
    unscheduledRemaining: 0, durationMs: 0,
  };

  while (Date.now() - startedAt < budget) {
    const pass = await sweepContactResolution({ orgId: params.orgId, limit: params.limit });
    total.scheduled += pass.scheduled;
    total.attempted += pass.attempted;
    total.resolved += pass.resolved;
    total.ambiguous += pass.ambiguous;
    total.unresolved += pass.unresolved;
    total.failed += pass.failed;
    total.released += pass.released;
    total.releasedAccounts.push(...pass.releasedAccounts);
    total.remaining = pass.remaining;
    total.unscheduledRemaining = pass.unscheduledRemaining;
    params.onBatch?.(pass);
    // Nothing attempted and nothing left to bring in means the backlog is
    // genuinely clear, rather than merely quiet this second.
    if (pass.attempted === 0 && pass.scheduled === 0) break;
  }

  total.durationMs = Date.now() - startedAt;
  return total;
}

// ---------------------------------------------------------------------------
// Recovery tools
// ---------------------------------------------------------------------------

/**
 * Try these again now.
 *
 * A recovery tool, not the workflow. Nothing here is required for a record to
 * be enriched — it exists for the case where an operator has fixed a
 * configuration problem and does not want to wait six hours to see whether it
 * worked.
 */
export async function retryContactResolution(params: {
  orgId: string;
  companyIds?: string[];
  /** Every record that is not currently resolved. The bulk button. */
  allBlocked?: boolean;
  limit?: number;
}): Promise<{ requeued: number; worked: SweepOutcome }> {
  const where: Prisma.ContactResolutionWhereInput = params.companyIds?.length
    ? { orgId: params.orgId, companyId: { in: params.companyIds } }
    : { orgId: params.orgId, status: { in: ['AMBIGUOUS', 'UNRESOLVED', 'FAILED'] } };

  if (!params.companyIds?.length && !params.allBlocked) {
    return {
      requeued: 0,
      worked: {
        scheduled: 0, attempted: 0, resolved: 0, ambiguous: 0, unresolved: 0,
        failed: 0, released: 0, releasedAccounts: [], remaining: 0,
        unscheduledRemaining: 0, durationMs: 0,
      },
    };
  }

  const requeued = await prisma.contactResolution.updateMany({
    where,
    data: {
      status: 'QUEUED',
      nextAttemptAt: new Date(),
      // A retry the operator asked for starts the backoff again. They have
      // usually just changed something.
      transientFailures: 0,
      lockedAt: null,
      lockedBy: null,
    },
  });

  const worked = await sweepContactResolution({ orgId: params.orgId, limit: params.limit });
  return { requeued: requeued.count, worked };
}

/**
 * A caller reached the number and it was wrong.
 *
 * The value is recorded as rejected rather than deleted, so the next attempt
 * cannot propose it again and the history of what was tried survives. The
 * account's phone is cleared only if it is the number that was wrong — which
 * takes the route out of Call now immediately, because the queue reads the same
 * column, and puts it back in front of the resolver.
 */
export async function rejectContactValue(params: {
  orgId: string;
  companyId: string;
  value: string;
  reason?: string;
}): Promise<{ cleared: boolean }> {
  const { orgId, companyId, value } = params;

  // Stamped whether or not the row was already retired. A number an automatic
  // pass had set aside and a caller then proved wrong is a stronger fact than
  // either alone, and the reason on the row should say the stronger one.
  await prisma.contactProvenance.updateMany({
    where: { companyId, field: 'phone', value },
    data: {
      supersededAt: new Date(),
      supersededReason: params.reason ?? 'a caller reached this number and it was not the business',
    },
  });

  const cleared = await prisma.company.updateMany({
    where: { id: companyId, orgId, phone: value },
    data: { phone: null },
  });
  await prisma.contact.updateMany({
    where: { orgId, companyId, phone: value },
    data: { phone: null, verificationStatus: 'INVALID' },
  });

  const existing = await prisma.contactResolution.findUnique({ where: { companyId } });
  const rejected = [...new Set([...(existing?.rejectedValues ?? []), value])];

  await prisma.contactResolution.upsert({
    where: { companyId },
    create: {
      orgId,
      companyId,
      status: 'QUEUED',
      blocker: 'The number we held was reported wrong. Looking for another route.',
      rejectedValues: rejected,
      nextAttemptAt: new Date(),
    },
    update: {
      status: 'QUEUED',
      confidence: null,
      blocker: 'The number we held was reported wrong. Looking for another route.',
      rejectedValues: rejected,
      nextAttemptAt: new Date(),
      transientFailures: 0,
      lockedAt: null,
      lockedBy: null,
    },
  });

  return { cleared: cleared.count > 0 };
}

/** What an operator typed, which outranks anything a machine found. */
export async function recordOperatorContact(params: {
  orgId: string;
  companyId: string;
  field: 'phone' | 'email' | 'contactName' | 'contactRole';
  value: string;
}): Promise<void> {
  const { writeProvenance } = await import('./resolve');
  await writeProvenance({
    orgId: params.orgId,
    companyId: params.companyId,
    field: params.field,
    value: params.value,
    source: 'operator',
    sourceUrl: null,
    externalId: null,
    retrievedAt: new Date(),
    confidence: 'VERIFIED',
    scope: 'LOCATION',
    verified: true,
    enteredByOperator: true,
    matchMethod: 'entered by the caller who spoke to the business',
  });

  if (params.field === 'phone') {
    await prisma.contactResolution.updateMany({
      where: { orgId: params.orgId, companyId: params.companyId },
      data: { status: 'RESOLVED', confidence: 'VERIFIED', blocker: null, resolvedAt: new Date(), nextAttemptAt: null },
    });
  }
}

export { strongestProvenance };
