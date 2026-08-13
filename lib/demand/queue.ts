import { Prisma } from '@prisma/client';
import type { CallDisposition, FrictionLevel, LeadTier, OutreachStatus, SignalCategory } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * The work queue.
 *
 * The board this replaces rendered every route as a full dossier, which is the
 * right amount of information for auditing the engine and the wrong amount for
 * making a phone call. Nothing about the engine changes here — the same routes,
 * the same tiers, the same scores. What changes is that the page answers "who
 * do I ring next" before it answers "how did you conclude that".
 *
 * Filtering, ordering and paging all happen in SQL. Two reasons, and the second
 * is the important one:
 *
 *   Ordering depends on contactability, which is not a column on the route —
 *   it lives on the company and its contacts. Sorting a fetched page in
 *   JavaScript would put the right rows in the wrong order across page
 *   boundaries, which is worse than no ordering at all.
 *
 *   Eligibility must be enforced by the server. A do-not-contact record kept
 *   out of the queue by a browser filter is one crafted request away from being
 *   dialled, and that is not a mistake worth being able to make.
 */

export type QueueView =
  | 'call_now'
  | 'follow_up'
  | 'research'
  | 'supply_needed'
  | 'qualified'
  | 'all'
  | 'closed'
  | 'expired';

export type QueueFilters = {
  view: QueueView;
  tier?: LeadTier[];
  route?: SignalCategory[];
  eventType?: string[];
  friction?: FrictionLevel[];
  fulfilment?: string[];
  outreach?: OutreachStatus[];
  /** Two-letter state codes. */
  state?: string[];
  connector?: string[];
  /** 'overdue' | 'today' | 'week' | 'month' */
  urgency?: string;
  contactable?: 'yes' | 'no';
  /** Where automatic contact resolution has got to. */
  enrichment?: EnrichmentState[];
  search?: string;
  cursor?: number;
  limit?: number;
};

export type QueueRow = {
  routeId: string;
  companyId: string;
  organisation: string;
  cityName: string | null;
  stateCode: string | null;
  tier: LeadTier;
  route: SignalCategory;
  playbookKey: string;
  headline: string;
  requiredCapability: string | null;
  needIsConfirmed: boolean;
  friction: FrictionLevel;
  fulfilmentStatus: string;
  status: string;
  statusReason: string | null;
  nextAction: string | null;
  /**
   * Expected gross profit per hour of human time, from the two figures the
   * engine already stored. Not a new score — arithmetic on `estimatedGrossProfit`
   * and `estimatedHumanMinutes`, shown with its unit so it cannot be mistaken
   * for one. Null when the engine could not estimate profit.
   */
  profitPerHour: number | null;
  expectedGrossProfit: number | null;
  eventId: string;
  eventType: string;
  eventDate: Date | null;
  deadlineAt: Date | null;
  connector: string;
  buyingWindow: string | null;
  windowClosesAt: Date | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  outreachStatus: OutreachStatus;
  snoozeUntil: Date | null;
  attempts: number;
  lastAttemptAt: Date | null;
  lastDisposition: CallDisposition | null;
  contactName: string | null;
  /** How many routes this account has in total, so one event reads as one. */
  routesForAccount: number;
  /** Rows sharing this event, so multiple routes from one event are visible. */
  routesForEvent: number;

  /**
   * Where automatic contact resolution has got to for this account.
   *
   * On the row rather than behind a click, because the difference between "we
   * are still looking", "we looked and found nothing" and "the provider was
   * down" is what decides whether an operator should do anything about it.
   */
  enrichmentState: EnrichmentState;
  /** The remaining blocker, in the operator's words. Null when resolved. */
  enrichmentBlocker: string | null;
  /** Sources already consulted, so nobody repeats work the system has done. */
  enrichmentSources: string[];
  enrichmentLastAttemptAt: Date | null;
  enrichmentNextAttemptAt: Date | null;
  enrichmentAttempts: number;
  /** How to fix a configuration failure. Null unless there is one. */
  enrichmentFix: string | null;
};

/**
 * The seven states the operator asked to see on the board.
 *
 * Each is a different situation with a different remedy, which is the whole
 * reason they are not one "no contact" flag: `FAILED` means our system did not
 * manage to look, and presenting that as though the business has no phone
 * number is the specific mistake this replaces.
 */
export type EnrichmentState =
  | 'READY'
  | 'ENRICHING'
  | 'RETRY_SCHEDULED'
  | 'AMBIGUOUS'
  | 'NONE_FOUND'
  | 'FAILED'
  | 'STALE'
  | 'WAITING'
  | 'NOT_SCHEDULED';

/** Rows per page. Small enough that the page renders instantly at 5,000 rows. */
export const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * A usable contact route.
 *
 * The corrected phone an operator typed wins over whatever the source had:
 * they spoke to a person, the directory did not.
 */
const PHONE_EXPR = Prisma.sql`COALESCE(os."correctedPhone", c."phone", ct."phone", ct."mobile")`;
const EMAIL_EXPR = Prisma.sql`COALESCE(os."correctedEmail", ct."email")`;

/**
 * Statuses that take a record out of every calling queue permanently.
 *
 * Enforced here rather than in the caller, so no endpoint can return one by
 * accident.
 */
/**
 * Profit per hour of attention, from stored values only.
 *
 * The ranking tie-breaker. Gross profit alone would put a slow high-friction
 * deal above three quick ones worth more together, which is the wrong order
 * for a day of calling.
 */
const PROFIT_PER_HOUR = Prisma.sql`
  CASE
    WHEN r."estimatedGrossProfit" IS NULL OR COALESCE(r."estimatedHumanMinutes", 0) = 0 THEN NULL
    ELSE ROUND(r."estimatedGrossProfit" / r."estimatedHumanMinutes" * 60)::int
  END
`;

const TERMINAL_STATUSES = Prisma.sql`('DO_NOT_CONTACT','CLOSED_HANDLED','CLOSED_NOT_INTERESTED','CLOSED_BAD_FIT')`;

/** Engine statuses that are not work regardless of what the operator did. */
const DEAD_ROUTE_STATUSES = Prisma.sql`('EXPIRED','REJECTED','COLD')`;


/**
 * The demand board is production only.
 *
 * Sandbox opportunities are invented companies. One of them in "call now" is a
 * caller ringing a number that does not exist, and one of them in a conversion
 * rate is a measurement nobody can trust.
 */
const PRODUCTION_ONLY = Prisma.sql`r."dataMode" = 'PRODUCTION'`;

function viewClause(view: QueueView): Prisma.Sql {
  switch (view) {
    case 'call_now':
      // Everything needed to pick up the phone right now: a live route, a
      // number, nothing scheduled for later, and nobody who has said no.
      return Prisma.sql`
        r."status" NOT IN ${DEAD_ROUTE_STATUSES}
        AND r."tier" IN ('ACTIVE_DEMAND','STRONG_TRIGGER')
        AND COALESCE(os."status", 'NEW') NOT IN ${TERMINAL_STATUSES}
        AND COALESCE(os."status", 'NEW') <> 'QUALIFIED'
        AND (os."snoozeUntil" IS NULL OR os."snoozeUntil" <= NOW())
        AND ${PHONE_EXPR} IS NOT NULL
      `;
    case 'follow_up':
      // Scheduled work, including anything already due. Overdue sorts first.
      return Prisma.sql`
        os."status" = 'FOLLOW_UP'
        AND r."status" NOT IN ('EXPIRED','REJECTED')
      `;
    case 'research':
      // Cannot be called because there is nobody to call. A task, not a lead.
      return Prisma.sql`
        r."status" NOT IN ${DEAD_ROUTE_STATUSES}
        AND r."tier" IN ('ACTIVE_DEMAND','STRONG_TRIGGER')
        AND COALESCE(os."status", 'NEW') NOT IN ${TERMINAL_STATUSES}
        AND ${PHONE_EXPR} IS NULL
      `;
    case 'supply_needed':
      return Prisma.sql`
        r."status" NOT IN ('EXPIRED','REJECTED')
        AND r."fulfilmentStatus" <> 'AVAILABLE'
        AND r."tier" IN ('ACTIVE_DEMAND','STRONG_TRIGGER')
      `;
    case 'qualified':
      return Prisma.sql`os."status" = 'QUALIFIED'`;
    case 'closed':
      return Prisma.sql`os."status" IN ${TERMINAL_STATUSES}`;
    case 'expired':
      return Prisma.sql`r."status" IN ('EXPIRED','REJECTED')`;
    case 'all':
    default:
      // Everything except the records the engine already discarded.
      return Prisma.sql`r."status" NOT IN ('EXPIRED','REJECTED')`;
  }
}

function filterClauses(filters: QueueFilters): Prisma.Sql[] {
  const clauses: Prisma.Sql[] = [];

  if (filters.tier?.length) {
    clauses.push(Prisma.sql`r."tier"::text IN (${Prisma.join(filters.tier)})`);
  }
  if (filters.route?.length) {
    clauses.push(Prisma.sql`r."route"::text IN (${Prisma.join(filters.route)})`);
  }
  if (filters.eventType?.length) {
    clauses.push(Prisma.sql`e."type"::text IN (${Prisma.join(filters.eventType)})`);
  }
  if (filters.friction?.length) {
    clauses.push(Prisma.sql`r."friction"::text IN (${Prisma.join(filters.friction)})`);
  }
  if (filters.fulfilment?.length) {
    clauses.push(Prisma.sql`r."fulfilmentStatus" IN (${Prisma.join(filters.fulfilment)})`);
  }
  if (filters.outreach?.length) {
    clauses.push(Prisma.sql`COALESCE(os."status", 'NEW')::text IN (${Prisma.join(filters.outreach)})`);
  }
  if (filters.state?.length) {
    clauses.push(Prisma.sql`COALESCE(c."stateCode", e."stateCode") IN (${Prisma.join(filters.state)})`);
  }
  if (filters.connector?.length) {
    clauses.push(Prisma.sql`e."connector" IN (${Prisma.join(filters.connector)})`);
  }
  if (filters.contactable === 'yes') clauses.push(Prisma.sql`${PHONE_EXPR} IS NOT NULL`);
  if (filters.contactable === 'no') clauses.push(Prisma.sql`${PHONE_EXPR} IS NULL`);
  if (filters.enrichment?.length) {
    clauses.push(Prisma.sql`(${ENRICHMENT_STATE}) IN (${Prisma.join(filters.enrichment)})`);
  }

  if (filters.urgency) {
    // Measured against the route's own window close, which comes from the
    // event's date. Never from when we discovered it.
    const horizons: Record<string, Prisma.Sql> = {
      overdue: Prisma.sql`r."windowClosesAt" < NOW()`,
      today: Prisma.sql`r."windowClosesAt" BETWEEN NOW() AND NOW() + INTERVAL '1 day'`,
      week: Prisma.sql`r."windowClosesAt" BETWEEN NOW() AND NOW() + INTERVAL '7 days'`,
      month: Prisma.sql`r."windowClosesAt" BETWEEN NOW() AND NOW() + INTERVAL '30 days'`,
    };
    const clause = horizons[filters.urgency];
    if (clause) clauses.push(clause);
  }

  if (filters.search?.trim()) {
    const term = `%${filters.search.trim().toLowerCase()}%`;
    clauses.push(Prisma.sql`(
      LOWER(c."legalName") LIKE ${term}
      OR LOWER(COALESCE(c."cityName", e."cityName", '')) LIKE ${term}
      OR LOWER(COALESCE(c."stateCode", e."stateCode", '')) LIKE ${term}
      OR LOWER(COALESCE(r."requiredCapability", '')) LIKE ${term}
      OR LOWER(r."headline") LIKE ${term}
      OR LOWER(e."headline") LIKE ${term}
      OR LOWER(e."summary") LIKE ${term}
    )`);
  }

  return clauses;
}

/**
 * The ordering the operator asked for, in the order they asked for it.
 *
 * Contactability sits above priority deliberately. A high score on a record
 * nobody can ring is not a better use of the next ten minutes than a lower
 * score on one with a phone number, and sorting by score alone puts the
 * unreachable at the top of the day.
 *
 * Postgres orders enums by declaration order, which is why tier and friction
 * sort correctly without a CASE: LeadTier declares ACTIVE_DEMAND first and
 * FrictionLevel declares LOW first.
 */
const ORDER_BY = Prisma.sql`
  ORDER BY
    r."tier" ASC,
    (${PHONE_EXPR} IS NULL) ASC,
    r."windowClosesAt" ASC NULLS LAST,
    r."friction" ASC,
    (r."fulfilmentStatus" <> 'AVAILABLE') ASC,
    ${PROFIT_PER_HOUR} DESC NULLS LAST,
    r."id" ASC
`;

const BASE_FROM = Prisma.sql`
  FROM "RouteHypothesis" r
  JOIN "DemandEvent" e ON e."id" = r."eventId"
  JOIN "Company" c ON c."id" = r."companyId"
  LEFT JOIN "OutreachState" os ON os."routeId" = r."id"
  LEFT JOIN LATERAL (
    SELECT "phone", "mobile", "email"
    FROM "Contact"
    WHERE "companyId" = c."id"
    ORDER BY "isDecisionMaker" DESC, "createdAt" ASC
    LIMIT 1
  ) ct ON TRUE
  -- Contact resolution is per organisation, not per route: four routes off one
  -- gym opening share one phone number and one attempt to find it.
  LEFT JOIN "ContactResolution" cr ON cr."companyId" = c."id"
`;

/**
 * Which of the seven states this row is in, decided in SQL.
 *
 * Here rather than in the component because the board pages through the
 * database — a state computed after the page was chosen would be wrong for
 * every row the page did not fetch, and could not be filtered on.
 *
 * A resolved contact past its next-attempt time is stale rather than ready: for
 * a licensed directory that horizon is also when its terms stop letting us rely
 * on the cached value, so the two reasons coincide.
 */
const ENRICHMENT_STATE = Prisma.sql`
  CASE
    WHEN ${PHONE_EXPR} IS NOT NULL
      AND cr."status" = 'RESOLVED'
      AND cr."nextAttemptAt" IS NOT NULL
      AND cr."nextAttemptAt" <= NOW()               THEN 'STALE'
    WHEN ${PHONE_EXPR} IS NOT NULL                   THEN 'READY'
    WHEN cr."status" = 'IN_PROGRESS'                 THEN 'ENRICHING'
    WHEN cr."status" = 'AMBIGUOUS'                   THEN 'AMBIGUOUS'
    WHEN cr."status" = 'FAILED'                      THEN 'FAILED'
    WHEN cr."status" = 'UNRESOLVED'                  THEN 'NONE_FOUND'
    WHEN cr."status" = 'QUEUED' AND cr."attempts" > 0 THEN 'RETRY_SCHEDULED'
    WHEN cr."status" = 'QUEUED'                      THEN 'WAITING'
    ELSE 'NOT_SCHEDULED'
  END
`;

/** The enrichment columns, written once and used by both row queries. */
const ENRICHMENT_COLUMNS = Prisma.sql`
  ${ENRICHMENT_STATE}                       AS "enrichmentState",
  cr."blocker"                              AS "enrichmentBlocker",
  COALESCE(cr."sourcesAttempted", '{}')     AS "enrichmentSources",
  cr."lastAttemptAt"                        AS "enrichmentLastAttemptAt",
  cr."nextAttemptAt"                        AS "enrichmentNextAttemptAt",
  COALESCE(cr."attempts", 0)                AS "enrichmentAttempts",
  cr."fixInstruction"                       AS "enrichmentFix"
`;

export async function queryQueue(params: {
  orgId: string;
  filters: QueueFilters;
}): Promise<{ rows: QueueRow[]; total: number; nextCursor: number | null }> {
  const { orgId, filters } = params;
  const limit = Math.min(Math.max(filters.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const offset = Math.max(filters.cursor ?? 0, 0);

  const where = Prisma.sql`
    WHERE r."orgId" = ${orgId} AND ${PRODUCTION_ONLY}
      AND (${viewClause(filters.view)})
      ${filterClauses(filters).length > 0 ? Prisma.sql`AND ${Prisma.join(filterClauses(filters), ' AND ')}` : Prisma.empty}
  `;

  const rows = await prisma.$queryRaw<QueueRow[]>`
    SELECT
      r."id"                  AS "routeId",
      r."companyId"           AS "companyId",
      c."legalName"           AS "organisation",
      COALESCE(c."cityName", e."cityName")   AS "cityName",
      COALESCE(c."stateCode", e."stateCode") AS "stateCode",
      r."tier"                AS "tier",
      r."route"               AS "route",
      r."playbookKey"         AS "playbookKey",
      r."headline"            AS "headline",
      r."requiredCapability"  AS "requiredCapability",
      r."needIsConfirmed"     AS "needIsConfirmed",
      r."friction"            AS "friction",
      r."fulfilmentStatus"    AS "fulfilmentStatus",
      r."status"              AS "status",
      r."statusReason"        AS "statusReason",
      r."nextAction"          AS "nextAction",
      ${PROFIT_PER_HOUR}      AS "profitPerHour",
      ROUND(r."estimatedGrossProfit")::int AS "expectedGrossProfit",
      r."eventId"             AS "eventId",
      e."type"                AS "eventType",
      e."eventDate"           AS "eventDate",
      e."deadlineAt"          AS "deadlineAt",
      e."connector"           AS "connector",
      r."buyingWindow"        AS "buyingWindow",
      r."windowClosesAt"      AS "windowClosesAt",
      ${PHONE_EXPR}           AS "phone",
      ${EMAIL_EXPR}           AS "email",
      c."website"             AS "website",
      COALESCE(os."status", 'NEW')  AS "outreachStatus",
      os."snoozeUntil"        AS "snoozeUntil",
      COALESCE(os."attempts", 0)    AS "attempts",
      os."lastAttemptAt"      AS "lastAttemptAt",
      os."lastDisposition"    AS "lastDisposition",
      os."contactName"        AS "contactName",
      0 AS "routesForAccount",
      0 AS "routesForEvent",
      ${ENRICHMENT_COLUMNS}
    ${BASE_FROM}
    ${where}
    ${ORDER_BY}
    LIMIT ${limit} OFFSET ${offset}
  `;

  // Sibling counts are attached after the page is chosen, not computed inside
  // it. As correlated subqueries they ran once per *scanned* row, which is
  // every row up to the offset — measured at 2 seconds on page 50 of 5,000
  // and 70ms once moved here.
  await attachSiblingCounts(rows);

  const [{ count }] = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count ${BASE_FROM} ${where}
  `;

  const total = Number(count);
  return {
    rows,
    total,
    // Offset paging over a stable ORDER BY that ends in a unique id, so a page
    // boundary cannot duplicate or skip a row the way an unstable sort would.
    nextCursor: offset + rows.length < total ? offset + rows.length : null,
  };
}

/**
 * Fills in how many routes share each row's account and event.
 *
 * Two grouped queries over the page's ids. The numbers matter — they are what
 * stops one business with four routes reading as four businesses — but they
 * are display detail, and paying for them across the whole scan was the single
 * slowest thing in the query.
 */
async function attachSiblingCounts(rows: QueueRow[]): Promise<void> {
  if (rows.length === 0) return;

  const companyIds = [...new Set(rows.map((r) => r.companyId))];
  const eventIds = [...new Set(rows.map((r) => r.eventId))];

  const [byCompany, byEvent] = await Promise.all([
    prisma.$queryRaw<Array<{ companyId: string; n: number }>>`
      SELECT "companyId", COUNT(*)::int AS n FROM "RouteHypothesis"
      WHERE "companyId" IN (${Prisma.join(companyIds)}) GROUP BY "companyId"
    `,
    prisma.$queryRaw<Array<{ eventId: string; n: number }>>`
      SELECT "eventId", COUNT(*)::int AS n FROM "RouteHypothesis"
      WHERE "eventId" IN (${Prisma.join(eventIds)}) GROUP BY "eventId"
    `,
  ]);

  const companyCounts = new Map(byCompany.map((r) => [r.companyId, r.n]));
  const eventCounts = new Map(byEvent.map((r) => [r.eventId, r.n]));
  for (const row of rows) {
    row.routesForAccount = companyCounts.get(row.companyId) ?? 1;
    row.routesForEvent = eventCounts.get(row.eventId) ?? 1;
  }
}

export type QueueSummary = Record<QueueView | 'expiring_soon' | 'active_demand' | 'strong_trigger', number>;

/**
 * The counts on the summary strip.
 *
 * Each one runs the same clause as the view it links to, so a count and the
 * rows behind it cannot disagree. Written as one query rather than eight
 * round trips.
 */
export async function queueSummary(orgId: string): Promise<QueueSummary> {
  const [row] = await prisma.$queryRaw<Array<Record<string, bigint>>>`
    SELECT
      COUNT(*) FILTER (WHERE ${viewClause('call_now')})      AS call_now,
      COUNT(*) FILTER (WHERE ${viewClause('follow_up')})     AS follow_up,
      COUNT(*) FILTER (WHERE ${viewClause('research')})      AS research,
      COUNT(*) FILTER (WHERE ${viewClause('supply_needed')}) AS supply_needed,
      COUNT(*) FILTER (WHERE ${viewClause('qualified')})     AS qualified,
      COUNT(*) FILTER (WHERE ${viewClause('closed')})        AS closed,
      COUNT(*) FILTER (WHERE ${viewClause('expired')})       AS expired,
      COUNT(*) FILTER (WHERE ${viewClause('all')})           AS all,
      COUNT(*) FILTER (WHERE r."tier" = 'ACTIVE_DEMAND' AND r."status" NOT IN ('EXPIRED','REJECTED'))  AS active_demand,
      COUNT(*) FILTER (WHERE r."tier" = 'STRONG_TRIGGER' AND r."status" NOT IN ('EXPIRED','REJECTED')) AS strong_trigger,
      COUNT(*) FILTER (
        WHERE r."windowClosesAt" IS NOT NULL
          AND r."windowClosesAt" BETWEEN NOW() AND NOW() + INTERVAL '7 days'
          AND r."status" NOT IN ('EXPIRED','REJECTED')
      ) AS expiring_soon
    ${BASE_FROM}
    WHERE r."orgId" = ${orgId} AND ${PRODUCTION_ONLY}
  `;

  const num = (key: string) => Number(row?.[key] ?? 0);
  return {
    call_now: num('call_now'),
    follow_up: num('follow_up'),
    research: num('research'),
    supply_needed: num('supply_needed'),
    qualified: num('qualified'),
    closed: num('closed'),
    expired: num('expired'),
    all: num('all'),
    active_demand: num('active_demand'),
    strong_trigger: num('strong_trigger'),
    expiring_soon: num('expiring_soon'),
  };
}

/**
 * The next opportunity to work.
 *
 * The same clause and the same ordering as the Call now view, so "Work next"
 * and the top of the list are always the same record. `excludeRouteIds` lets
 * the caller skip a record it has just saved without waiting for the write to
 * be visible to a following read.
 */
export async function nextCallable(params: {
  orgId: string;
  excludeRouteIds?: string[];
}): Promise<QueueRow | null> {
  const exclude = params.excludeRouteIds?.length
    ? Prisma.sql`AND r."id" NOT IN (${Prisma.join(params.excludeRouteIds)})`
    : Prisma.empty;

  const rows = await prisma.$queryRaw<QueueRow[]>`
    SELECT
      r."id" AS "routeId", r."companyId" AS "companyId", c."legalName" AS "organisation",
      COALESCE(c."cityName", e."cityName") AS "cityName",
      COALESCE(c."stateCode", e."stateCode") AS "stateCode",
      r."tier" AS "tier", r."route" AS "route", r."playbookKey" AS "playbookKey",
      r."headline" AS "headline", r."requiredCapability" AS "requiredCapability",
      r."needIsConfirmed" AS "needIsConfirmed", r."friction" AS "friction",
      r."fulfilmentStatus" AS "fulfilmentStatus", r."status" AS "status",
      r."statusReason" AS "statusReason", r."nextAction" AS "nextAction",
      ${PROFIT_PER_HOUR} AS "profitPerHour", ROUND(r."estimatedGrossProfit")::int AS "expectedGrossProfit",
      r."eventId" AS "eventId", e."type" AS "eventType", e."eventDate" AS "eventDate",
      e."deadlineAt" AS "deadlineAt", e."connector" AS "connector",
      r."buyingWindow" AS "buyingWindow", r."windowClosesAt" AS "windowClosesAt",
      ${PHONE_EXPR} AS "phone", ${EMAIL_EXPR} AS "email", c."website" AS "website",
      COALESCE(os."status", 'NEW') AS "outreachStatus", os."snoozeUntil" AS "snoozeUntil",
      COALESCE(os."attempts", 0) AS "attempts", os."lastAttemptAt" AS "lastAttemptAt",
      os."lastDisposition" AS "lastDisposition", os."contactName" AS "contactName",
      0 AS "routesForAccount", 0 AS "routesForEvent",
      ${ENRICHMENT_COLUMNS}
    ${BASE_FROM}
    WHERE r."orgId" = ${params.orgId} AND ${PRODUCTION_ONLY}
      AND (${viewClause('call_now')})
      ${exclude}
    ${ORDER_BY}
    LIMIT 1
  `;
  await attachSiblingCounts(rows);
  return rows[0] ?? null;
}

/**
 * Whether one route may be dialled, asked of the database rather than the page.
 *
 * The caller view checks this before showing a record, so a stale tab or a
 * hand-made URL cannot open a do-not-contact record that somebody else closed
 * five minutes ago.
 */
export async function isCallable(orgId: string, routeId: string): Promise<{ callable: boolean; reason: string | null }> {
  const rows = await prisma.$queryRaw<Array<{ callable: boolean; routeStatus: string; outreachStatus: string; snoozeUntil: Date | null; phone: string | null }>>`
    SELECT
      (${viewClause('call_now')}) AS "callable",
      r."status" AS "routeStatus",
      COALESCE(os."status", 'NEW') AS "outreachStatus",
      os."snoozeUntil" AS "snoozeUntil",
      ${PHONE_EXPR} AS "phone"
    ${BASE_FROM}
    WHERE r."orgId" = ${orgId} AND ${PRODUCTION_ONLY} AND r."id" = ${routeId}
  `;

  const row = rows[0];
  if (!row) return { callable: false, reason: 'This opportunity does not exist in your organisation.' };
  if (row.callable) return { callable: true, reason: null };

  // A specific reason, because "not callable" tells the operator nothing about
  // whether to fix it, wait for it, or forget it.
  if (row.outreachStatus === 'DO_NOT_CONTACT') return { callable: false, reason: 'This account asked not to be contacted.' };
  if (row.outreachStatus.startsWith('CLOSED')) return { callable: false, reason: 'This opportunity is closed.' };
  if (row.outreachStatus === 'QUALIFIED') return { callable: false, reason: 'Already qualified — it is in the pipeline, not the calling queue.' };
  if (row.snoozeUntil && row.snoozeUntil > new Date()) {
    return { callable: false, reason: `Scheduled for follow-up on ${row.snoozeUntil.toISOString().slice(0, 10)}.` };
  }
  if (!row.phone) return { callable: false, reason: 'No phone number. This is a research task, not a call.' };
  if (['EXPIRED', 'REJECTED', 'COLD'].includes(row.routeStatus)) {
    return { callable: false, reason: `The opportunity itself is ${row.routeStatus.toLowerCase()}.` };
  }
  return { callable: false, reason: 'Not currently in the calling queue.' };
}

/**
 * How many of one account's routes are callable right now.
 *
 * The same clause as the Call now view, asked of one company. Contact
 * resolution uses it to report what it actually released rather than what it
 * hoped to: eligibility is more than having a phone number — a do-not-contact
 * record, a closed route or a follow-up scheduled for Thursday all still fail
 * it, and only the queue's own definition knows that.
 */
export async function callableRouteCount(orgId: string, companyId: string): Promise<number> {
  const [row] = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    ${BASE_FROM}
    WHERE r."orgId" = ${orgId} AND ${PRODUCTION_ONLY} AND r."companyId" = ${companyId} AND (${viewClause('call_now')})
  `;
  return Number(row?.count ?? 0);
}

/** Distinct values for the filter controls, so they only offer what exists. */
export async function filterOptions(orgId: string): Promise<{
  eventTypes: string[];
  connectors: string[];
  states: string[];
}> {
  const rows = await prisma.$queryRaw<Array<{ eventType: string; connector: string; stateCode: string | null }>>`
    SELECT DISTINCT e."type"::text AS "eventType", e."connector" AS "connector",
           COALESCE(c."stateCode", e."stateCode") AS "stateCode"
    FROM "RouteHypothesis" r
    JOIN "DemandEvent" e ON e."id" = r."eventId"
    JOIN "Company" c ON c."id" = r."companyId"
    WHERE r."orgId" = ${orgId} AND ${PRODUCTION_ONLY}
  `;
  return {
    eventTypes: [...new Set(rows.map((r) => r.eventType))].sort(),
    connectors: [...new Set(rows.map((r) => r.connector))].sort(),
    states: [...new Set(rows.map((r) => r.stateCode).filter((s): s is string => Boolean(s)))].sort(),
  };
}
