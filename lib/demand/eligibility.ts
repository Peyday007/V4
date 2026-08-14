import { Prisma } from '@prisma/client';
import type { DataMode } from '@prisma/client';
import { prisma } from '@/lib/db';
import { CALLING_WINDOW, STATE_TIMEZONES } from '@/lib/caller/localTime';

/**
 * What "callable" means. Once, for everybody.
 *
 * This file exists because two screens disagreed in production. `/callers`
 * reported 152 callable opportunities unassigned while `/demand` reported 17
 * callable and 135 needing research — and both numbers were computed by
 * hand-written SQL that had drifted apart. The callers page counted every live
 * tiered route with no packet item, without checking whether anybody had a
 * phone number, whether the record was snoozed to next month, or whether the
 * buyer had asked never to be rung again. It was not a display bug. It was an
 * owner being told there were 152 calls to make when there were 17.
 *
 * So there is now one expression, and every surface that has an opinion about
 * eligibility reads it: the demand board, the callers page, the assignment
 * preview, and the workspace's own serve loop. Adding a sixth surface means
 * importing this; it does not mean writing a fifth version of the rule.
 *
 * The buckets partition the set. Every live route lands in exactly one, the
 * order of the CASE is the order of precedence, and the precedence is chosen so
 * the most serious reason wins: a suppressed record with no phone number is
 * blocked rather than research, because researching it would be wasted work.
 */

/** Exactly one of these applies to any route, at any moment. */
export type EligibilityBucket =
  /** Ring it now. */
  | 'CALLABLE_NOW'
  /** Everything is ready and it is the wrong time of day where they are. */
  | 'WAITING_FOR_HOURS'
  /** Nobody to ring. A research task, not a lead. */
  | 'RESEARCH_NEEDED'
  /** We said we would come back on a date, and the date has not arrived. */
  | 'FUTURE_FOLLOW_UP'
  /** Out of cold calling and into the pipeline. */
  | 'QUALIFIED'
  /** Live, but below the tiers the floor works. */
  | 'NOT_PRIORITISED'
  /** Suppressed, closed, expired or rejected. Never work. */
  | 'BLOCKED';

export const BUCKETS: readonly EligibilityBucket[] = [
  'CALLABLE_NOW',
  'WAITING_FOR_HOURS',
  'RESEARCH_NEEDED',
  'FUTURE_FOLLOW_UP',
  'QUALIFIED',
  'NOT_PRIORITISED',
  'BLOCKED',
];

export const BUCKET_LABELS: Record<EligibilityBucket, string> = {
  CALLABLE_NOW: 'Callable now',
  WAITING_FOR_HOURS: 'Waiting for local business hours',
  RESEARCH_NEEDED: 'Research needed',
  FUTURE_FOLLOW_UP: 'Future follow-up',
  QUALIFIED: 'Qualified — in the pipeline',
  NOT_PRIORITISED: 'Below the calling tiers',
  BLOCKED: 'Blocked or closed',
};

/** Why a bucket is not callable, in the words the owner page shows. */
export const BUCKET_EXPLANATIONS: Record<EligibilityBucket, string> = {
  CALLABLE_NOW:
    'A live opportunity with a phone number, inside business hours where the buyer is, nobody else working it, and nothing telling us to stay away.',
  WAITING_FOR_HOURS:
    'Ready in every other respect, but it is outside 8am–6pm on a weekday where that business is — or we do not know where they are, and we will not guess.',
  RESEARCH_NEEDED:
    'There is no phone number. This is a research task; assigning it to a caller gives them a record they cannot act on.',
  FUTURE_FOLLOW_UP: 'Somebody promised to come back on a date that has not arrived yet.',
  QUALIFIED: 'Already qualified and out of cold calling. It belongs to the deal pipeline, not the floor.',
  NOT_PRIORITISED: 'Live, but below the tiers the floor works. Not wrong to call, just not the next call.',
  BLOCKED: 'Suppressed, closed, expired or rejected. It must not be dialled.',
};

// ---------------------------------------------------------------------------
// The SQL
// ---------------------------------------------------------------------------

/** Outreach states that end a record permanently. */
export const TERMINAL_OUTREACH = Prisma.sql`('DO_NOT_CONTACT','CLOSED_HANDLED','CLOSED_NOT_INTERESTED','CLOSED_BAD_FIT')`;

/** Engine statuses that are not work, whatever the operator did. */
export const DEAD_ROUTE = Prisma.sql`('EXPIRED','REJECTED','COLD')`;

/** The tiers the calling floor works. */
export const CALLING_TIERS = Prisma.sql`('ACTIVE_DEMAND','STRONG_TRIGGER')`;

/**
 * The number to ring.
 *
 * A phone an operator corrected outranks anything a directory supplied: they
 * spoke to a person and the directory did not.
 */
export const PHONE_SQL = Prisma.sql`COALESCE(os."correctedPhone", c."phone", ct."phone", ct."mobile")`;

/**
 * The prospect's timezone, built from the same map the TypeScript uses.
 *
 * Generated rather than hand-written, because a second copy of a fifty-entry
 * lookup is a second copy that will disagree. The SQL and the in-memory check
 * are the same table by construction.
 */
export const TIMEZONE_SQL: Prisma.Sql = (() => {
  const branches = Object.entries(STATE_TIMEZONES).map(
    ([state, zone]) => Prisma.sql`WHEN ${state} THEN ${zone}`,
  );
  return Prisma.sql`
    COALESCE(
      NULLIF(ct."timezone", ''),
      CASE UPPER(COALESCE(c."stateCode", e."stateCode", ''))
        ${Prisma.join(branches, ' ')}
        ELSE NULL
      END
    )
  `;
})();

/**
 * Whether it is a weekday inside calling hours where the business is.
 *
 * An unknown timezone is false, never true. The alternative is assuming
 * Eastern, which produces confident calls at four in the morning in California
 * — and a record that waits is cheaper than a buyer who is woken up.
 */
export function withinHoursSql(at?: Date): Prisma.Sql {
  // Parameterised on the instant so a test can ask "what would this say at
  // 10am in Chicago" without waiting until 10am in Chicago. Production passes
  // nothing and gets NOW().
  const clock = at ? Prisma.sql`${at}::timestamptz` : Prisma.sql`NOW()`;
  return Prisma.sql`(
    ${TIMEZONE_SQL} IS NOT NULL
    AND EXTRACT(DOW FROM (${clock} AT TIME ZONE ${TIMEZONE_SQL})) BETWEEN 1 AND 5
    AND EXTRACT(HOUR FROM (${clock} AT TIME ZONE ${TIMEZONE_SQL})) >= ${CALLING_WINDOW.startHour}
    AND EXTRACT(HOUR FROM (${clock} AT TIME ZONE ${TIMEZONE_SQL})) < ${CALLING_WINDOW.endHour}
  )`;
}

export const WITHIN_HOURS_SQL = withinHoursSql();

/**
 * A live do-not-contact entry against this record's number.
 *
 * Checked in the eligibility expression rather than only at dial time, because
 * a suppressed record that reaches a caller's screen has already cost somebody
 * the decision not to ring it.
 */
export const SUPPRESSED_SQL = Prisma.sql`EXISTS (
  SELECT 1 FROM "SuppressionEntry" se
  WHERE se."orgId" = r."orgId"
    AND (se."expiresAt" IS NULL OR se."expiresAt" > NOW())
    AND se."scope" IN ('DO_NOT_CALL','DO_NOT_CONTACT')
    AND se."phone" IS NOT NULL
    AND regexp_replace(se."phone", '\\D', '', 'g') =
        regexp_replace(COALESCE(${PHONE_SQL}, ''), '\\D', '', 'g')
    AND regexp_replace(COALESCE(${PHONE_SQL}, ''), '\\D', '', 'g') <> ''
)`;

/** A live packet item — somebody is holding this record right now. */
export const ASSIGNED_SQL = Prisma.sql`EXISTS (
  SELECT 1 FROM "PacketItem" pi
  WHERE pi."routeId" = r."id" AND pi."status" IN ('PENDING','IN_PROGRESS')
)`;

/**
 * The bucket, decided in one place.
 *
 * Order is precedence. Blocked first because it must never be overridden by
 * anything below it; qualified before follow-up because a qualified record
 * with a stale snooze belongs to the pipeline, not the phone.
 */
export function bucketSql(at?: Date): Prisma.Sql {
  const clock = at ? Prisma.sql`${at}::timestamptz` : Prisma.sql`NOW()`;
  return Prisma.sql`
    CASE
      WHEN r."status" IN ${DEAD_ROUTE} THEN 'BLOCKED'
      WHEN COALESCE(os."status"::text, 'NEW') IN ${TERMINAL_OUTREACH} THEN 'BLOCKED'
      WHEN ${SUPPRESSED_SQL} THEN 'BLOCKED'
      WHEN COALESCE(os."status"::text, 'NEW') = 'QUALIFIED' THEN 'QUALIFIED'
      WHEN r."tier"::text NOT IN ${CALLING_TIERS} THEN 'NOT_PRIORITISED'
      WHEN os."snoozeUntil" IS NOT NULL AND os."snoozeUntil" > ${clock} THEN 'FUTURE_FOLLOW_UP'
      WHEN ${PHONE_SQL} IS NULL THEN 'RESEARCH_NEEDED'
      WHEN NOT ${withinHoursSql(at)} THEN 'WAITING_FOR_HOURS'
      ELSE 'CALLABLE_NOW'
    END
  `;
}

export const BUCKET_SQL = bucketSql();

/**
 * The joins the expression above needs.
 *
 * Exported so a surface cannot accidentally evaluate the bucket against a
 * different set of joins and get a different answer — which is precisely how
 * the two counts drifted apart in the first place.
 */
export const ELIGIBILITY_FROM = Prisma.sql`
  FROM "RouteHypothesis" r
  JOIN "DemandEvent" e ON e."id" = r."eventId"
  JOIN "Company" c ON c."id" = r."companyId"
  LEFT JOIN "OutreachState" os ON os."routeId" = r."id"
  LEFT JOIN LATERAL (
    SELECT "phone", "mobile", "email", "timezone"
    FROM "Contact"
    WHERE "companyId" = c."id"
    ORDER BY "isDecisionMaker" DESC, "createdAt" ASC
    LIMIT 1
  ) ct ON TRUE
`;

// ---------------------------------------------------------------------------
// Reading the counts
// ---------------------------------------------------------------------------

export type EligibilityCounts = Record<EligibilityBucket, number> & {
  /** Callable now and nobody holding it. The number an owner can act on. */
  callableUnassigned: number;
  /** Callable now and already in somebody's packet. */
  callableAssigned: number;
  total: number;
};

/**
 * The canonical counts, for one world.
 *
 * `mode` is required rather than defaulted. A count that silently included
 * sandbox opportunities would put invented companies in an owner's "callable
 * now", which is the same class of lie this file was written to end.
 */
export async function eligibilityCounts(params: {
  orgId: string;
  mode: DataMode;
  now?: Date;
}): Promise<EligibilityCounts> {
  const rows = await prisma.$queryRaw<Array<{ bucket: string; assigned: boolean; n: bigint }>>`
    SELECT ${bucketSql(params.now)} AS bucket, ${ASSIGNED_SQL} AS assigned, COUNT(*)::bigint AS n
    ${ELIGIBILITY_FROM}
    WHERE r."orgId" = ${params.orgId} AND r."dataMode" = ${params.mode}::"DataMode"
    GROUP BY 1, 2
  `;

  const counts = Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<EligibilityBucket, number>;
  let callableUnassigned = 0;
  let callableAssigned = 0;
  let total = 0;

  for (const row of rows) {
    const bucket = row.bucket as EligibilityBucket;
    const n = Number(row.n);
    counts[bucket] = (counts[bucket] ?? 0) + n;
    total += n;
    if (bucket === 'CALLABLE_NOW') {
      if (row.assigned) callableAssigned += n;
      else callableUnassigned += n;
    }
  }

  return { ...counts, callableUnassigned, callableAssigned, total };
}

/**
 * The route ids an owner could assign right now, in the queue's own order.
 *
 * Read-only by construction: it selects, and nothing here writes. The
 * assignment preview and the confirm step both call this, so what is previewed
 * is what is assigned.
 */
export async function callableRouteIds(params: {
  orgId: string;
  mode: DataMode;
  limit: number;
  /** Exclude anything already held by somebody. */
  unassignedOnly?: boolean;
  now?: Date;
  /**
   * Allow more than one route per organisation in the same batch.
   *
   * Off by default, and the default is the important part. One demand event
   * fans out into a route per applicable playbook, so a buyer whose licence
   * matched three playbooks produces three rows — and handing a caller all
   * three hands them one phone call three times. The portfolio audit's
   * counting rule says several hypotheses from one event are one opportunity;
   * this is that rule at the point where it costs somebody an afternoon.
   *
   * The other routes are not discarded. They stay callable and come back on
   * the next fill, once this conversation has happened and what it turned up
   * can inform them.
   */
  allowMultiplePerCompany?: boolean;
}): Promise<string[]> {
  // `DISTINCT ON` keeps the first row per company under the ORDER BY below,
  // which is the same ordering the board uses — so the one kept is the one the
  // owner would have picked anyway, not an arbitrary sibling.
  const distinct = params.allowMultiplePerCompany
    ? Prisma.empty
    : Prisma.sql`DISTINCT ON (r."companyId")`;

  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT * FROM (
      SELECT ${distinct}
        r."id" AS id,
        r."companyId" AS company,
        r."tier" AS tier,
        r."windowClosesAt" AS closes,
        r."friction" AS friction,
        (r."fulfilmentStatus" <> 'AVAILABLE') AS unfulfilled
      ${ELIGIBILITY_FROM}
      WHERE r."orgId" = ${params.orgId}
        AND r."dataMode" = ${params.mode}::"DataMode"
        AND (${bucketSql(params.now)}) = 'CALLABLE_NOW'
        ${params.unassignedOnly === false ? Prisma.empty : Prisma.sql`AND NOT ${ASSIGNED_SQL}`}
      -- The queue's own ordering, so the preview offers the same records in the
      -- same order the demand board would. A second opinion about priority here
      -- would mean the owner assigning a different top-25 than the one they read.
      -- companyId leads only because DISTINCT ON requires it to; the rest is
      -- the board's order and decides which route survives per company.
      ORDER BY
        r."companyId" ASC,
        r."tier" ASC,
        r."windowClosesAt" ASC NULLS LAST,
        r."friction" ASC,
        (r."fulfilmentStatus" <> 'AVAILABLE') ASC,
        r."id" ASC
    ) AS picked
    ORDER BY
      picked.tier ASC,
      picked.closes ASC NULLS LAST,
      picked.friction ASC,
      picked.unfulfilled ASC,
      picked.id ASC
    LIMIT ${params.limit}
  `;
  return rows.map((r) => r.id);
}

/** The bucket for specific routes, for explaining an exclusion one row at a time. */
export async function bucketsForRoutes(params: {
  orgId: string;
  routeIds: string[];
  now?: Date;
}): Promise<Map<string, { bucket: EligibilityBucket; assigned: boolean }>> {
  if (params.routeIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<Array<{ id: string; bucket: string; assigned: boolean }>>`
    SELECT r."id" AS id, ${bucketSql(params.now)} AS bucket, ${ASSIGNED_SQL} AS assigned
    ${ELIGIBILITY_FROM}
    WHERE r."orgId" = ${params.orgId} AND r."id" IN (${Prisma.join(params.routeIds)})
  `;
  return new Map(rows.map((r) => [r.id, { bucket: r.bucket as EligibilityBucket, assigned: r.assigned }]));
}
