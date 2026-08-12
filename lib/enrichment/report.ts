import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { CONTACT_SOURCES, unavailableSources } from './sources';

/**
 * What the enrichment workflow is actually doing.
 *
 * Written so that the answer to "why is Research needed still full" never
 * requires opening a job table. The six terminal states are counted separately
 * because they mean six different things, and the two that get conflated
 * everywhere else — "we searched and found nothing" and "we could not search" —
 * are the two an operator most needs to tell apart.
 */

export type EnrichmentOverview = {
  waiting: number;
  inProgress: number;
  resolved: number;
  ambiguous: number;
  unresolved: number;
  failed: number;
  /** Resolved contacts that have aged past their source's horizon. */
  stale: number;
  /** Accounts with live demand that are not in the workflow at all. */
  untracked: number;

  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  /** Every source consulted across the workspace, most used first. */
  sourcesAttempted: Array<{ source: string; label: string; accounts: number }>;
  /** Routes that entered Call now because of enrichment in the last day. */
  newlyCallable: number;
  /** Accounts released in the last day, newest first. */
  recentlyReleased: Array<{ organisation: string; resolvedAt: string; routes: number; confidence: string | null }>;
  /** Configuration that is stopping automatic enrichment right now. */
  configurationProblems: Array<{ source: string; reason: string; fix: string; accounts: number }>;
  /** The blockers holding the largest number of accounts. */
  topBlockers: Array<{ blocker: string; accounts: number; status: string }>;
};

export async function enrichmentOverview(orgId: string): Promise<EnrichmentOverview> {
  const [counts] = await prisma.$queryRaw<Array<Record<string, bigint | Date | null>>>`
    SELECT
      COUNT(*) FILTER (WHERE cr."status" = 'QUEUED')      AS waiting,
      COUNT(*) FILTER (WHERE cr."status" = 'IN_PROGRESS') AS in_progress,
      COUNT(*) FILTER (WHERE cr."status" = 'RESOLVED')    AS resolved,
      COUNT(*) FILTER (WHERE cr."status" = 'AMBIGUOUS')   AS ambiguous,
      COUNT(*) FILTER (WHERE cr."status" = 'UNRESOLVED')  AS unresolved,
      COUNT(*) FILTER (WHERE cr."status" = 'FAILED')      AS failed,
      COUNT(*) FILTER (
        WHERE cr."status" = 'RESOLVED' AND cr."nextAttemptAt" IS NOT NULL AND cr."nextAttemptAt" <= NOW()
      ) AS stale,
      MAX(cr."lastAttemptAt") AS last_attempt,
      MIN(cr."nextAttemptAt") FILTER (WHERE cr."nextAttemptAt" > NOW()) AS next_retry
    FROM "ContactResolution" cr
    WHERE cr."orgId" = ${orgId}
  `;

  // Accounts with live demand and no resolution row. Should be zero once the
  // worker has run; a number here means scheduling is not reaching them.
  const [{ count: untracked }] = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(DISTINCT r."companyId")::bigint AS count
    FROM "RouteHypothesis" r
    LEFT JOIN "ContactResolution" cr ON cr."companyId" = r."companyId"
    WHERE r."orgId" = ${orgId} AND r."status" NOT IN ('EXPIRED', 'REJECTED') AND cr."id" IS NULL
  `;

  const sourceRows = await prisma.$queryRaw<Array<{ source: string; accounts: bigint }>>`
    SELECT source, COUNT(*)::bigint AS accounts
    FROM "ContactResolution" cr, UNNEST(cr."sourcesAttempted") AS source
    WHERE cr."orgId" = ${orgId}
    GROUP BY source
    ORDER BY accounts DESC
  `;

  // What enrichment actually released, measured against the queue's own
  // definition of callable rather than against having a phone number — a
  // do-not-contact account with a freshly found number is not a win.
  const released = await prisma.$queryRaw<
    Array<{ organisation: string; resolvedAt: Date; routes: bigint; confidence: string | null }>
  >`
    SELECT c."legalName" AS organisation, cr."resolvedAt" AS "resolvedAt",
           COUNT(r."id")::bigint AS routes, cr."confidence"::text AS confidence
    FROM "ContactResolution" cr
    JOIN "Company" c ON c."id" = cr."companyId"
    JOIN "RouteHypothesis" r ON r."companyId" = cr."companyId"
      AND r."status" NOT IN ('EXPIRED', 'REJECTED', 'COLD')
      AND r."tier" IN ('ACTIVE_DEMAND', 'STRONG_TRIGGER')
    LEFT JOIN "OutreachState" os ON os."routeId" = r."id"
    WHERE cr."orgId" = ${orgId}
      AND cr."status" = 'RESOLVED'
      AND cr."resolvedAt" >= NOW() - INTERVAL '1 day'
      AND COALESCE(os."status", 'NEW') NOT IN ('DO_NOT_CONTACT','CLOSED_HANDLED','CLOSED_NOT_INTERESTED','CLOSED_BAD_FIT','QUALIFIED')
      AND (os."snoozeUntil" IS NULL OR os."snoozeUntil" <= NOW())
      AND COALESCE(os."correctedPhone", c."phone") IS NOT NULL
    GROUP BY c."legalName", cr."resolvedAt", cr."confidence"
    ORDER BY cr."resolvedAt" DESC
    LIMIT 20
  `;

  const blockers = await prisma.$queryRaw<Array<{ blocker: string; status: string; accounts: bigint }>>`
    SELECT cr."blocker" AS blocker, cr."status"::text AS status, COUNT(*)::bigint AS accounts
    FROM "ContactResolution" cr
    WHERE cr."orgId" = ${orgId} AND cr."blocker" IS NOT NULL AND cr."status" <> 'RESOLVED'
    GROUP BY cr."blocker", cr."status"
    ORDER BY accounts DESC
    LIMIT 8
  `;

  const [{ count: failedAccounts }] = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count FROM "ContactResolution"
    WHERE "orgId" = ${orgId} AND "failureKind" IN ('configuration', 'partial_configuration')
  `;

  const num = (key: string) => Number((counts?.[key] as bigint | undefined) ?? 0);
  const labels = new Map(CONTACT_SOURCES.map((s) => [s.key, s.label]));

  return {
    waiting: num('waiting'),
    inProgress: num('in_progress'),
    resolved: num('resolved'),
    ambiguous: num('ambiguous'),
    unresolved: num('unresolved'),
    failed: num('failed'),
    stale: num('stale'),
    untracked: Number(untracked),
    lastAttemptAt: (counts?.last_attempt as Date | null)?.toISOString() ?? null,
    nextRetryAt: (counts?.next_retry as Date | null)?.toISOString() ?? null,
    sourcesAttempted: sourceRows.map((r) => ({
      source: r.source,
      label: labels.get(r.source) ?? r.source,
      accounts: Number(r.accounts),
    })),
    newlyCallable: released.reduce((sum, r) => sum + Number(r.routes), 0),
    recentlyReleased: released.map((r) => ({
      organisation: r.organisation,
      resolvedAt: r.resolvedAt.toISOString(),
      routes: Number(r.routes),
      confidence: r.confidence,
    })),
    configurationProblems: unavailableSources().map((s) => ({
      source: s.label,
      reason: s.reason,
      fix: s.fix,
      accounts: Number(failedAccounts),
    })),
    topBlockers: blockers.map((b) => ({
      blocker: b.blocker,
      accounts: Number(b.accounts),
      status: b.status,
    })),
  };
}

/**
 * Everything known about one account's contact, for the caller card.
 *
 * The provenance is the point. A caller who can see that the number came from a
 * directory listing matched on name and street address, retrieved on a stated
 * date, opens the call differently from one who has been told it is verified.
 */
export type ContactProvenanceView = {
  status: string;
  confidence: string | null;
  blocker: string | null;
  ambiguityReason: string | null;
  candidates: Array<{ name: string; phone: string | null; location: string | null; source: string }>;
  sourcesAttempted: string[];
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  attempts: number;
  fields: Array<{
    field: string;
    value: string;
    source: string;
    sourceUrl: string | null;
    retrievedAt: string;
    confidence: string;
    scope: string;
    verified: boolean;
    enteredByOperator: boolean;
    matchMethod: string | null;
    superseded: boolean;
    supersededReason: string | null;
  }>;
};

export async function contactProvenanceFor(orgId: string, companyId: string): Promise<ContactProvenanceView | null> {
  const [resolution, provenance] = await Promise.all([
    prisma.contactResolution.findFirst({ where: { orgId, companyId } }),
    prisma.contactProvenance.findMany({
      where: { orgId, companyId },
      orderBy: [{ supersededAt: 'asc' }, { retrievedAt: 'desc' }],
      take: 40,
    }),
  ]);

  if (!resolution && provenance.length === 0) return null;

  return {
    status: resolution?.status ?? 'NOT_SCHEDULED',
    confidence: resolution?.confidence ?? null,
    blocker: resolution?.blocker ?? null,
    ambiguityReason: resolution?.ambiguityReason ?? null,
    candidates: ((resolution?.candidates ?? []) as ContactProvenanceView['candidates']) ?? [],
    sourcesAttempted: resolution?.sourcesAttempted ?? [],
    lastAttemptAt: resolution?.lastAttemptAt?.toISOString() ?? null,
    nextAttemptAt: resolution?.nextAttemptAt?.toISOString() ?? null,
    attempts: resolution?.attempts ?? 0,
    fields: provenance.map((row) => ({
      field: row.field,
      value: row.value,
      source: row.source,
      sourceUrl: row.sourceUrl,
      retrievedAt: row.retrievedAt.toISOString(),
      confidence: row.confidence,
      scope: row.scope,
      verified: row.verified,
      enteredByOperator: row.enteredByOperator,
      matchMethod: row.matchMethod,
      superseded: row.supersededAt !== null,
      supersededReason: row.supersededReason,
    })),
  };
}

/** Filter helper for the board: the states that are not "ready to call". */
export const BLOCKED_STATES = Prisma.sql`('AMBIGUOUS','NONE_FOUND','FAILED','WAITING','RETRY_SCHEDULED','ENRICHING')`;
