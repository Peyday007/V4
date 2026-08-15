import { prisma } from '@/lib/db';

/**
 * What the calls actually established, rather than how many were made.
 *
 * Call counts measure effort. This measures what came back: which facts about
 * real businesses exist on the record because somebody rang and asked, which
 * hypotheses were killed and why, and where two people were told different
 * things.
 *
 * The last of those is the most valuable and the easiest to lose. A caller who
 * disproves a thesis has done better work than one who confirms a requirement
 * nobody will buy, and until the ledger existed there was no way to see it —
 * the disproof was a disposition and a free-text box, and it disappeared into
 * an attempt row nothing read.
 *
 * Nothing here is scored. A caller who establishes four facts on twelve calls
 * may have had a bad list or a good week, and a number that pretends to know
 * which is a number that will be used in a performance conversation it cannot
 * support.
 */

export type CallerLearning = {
  /** Facts on the record because this person asked. */
  established: number;
  /** Hypotheses this person closed, with the reason each time. */
  disproved: Array<{ organisation: string; because: string; on: string }>;
  /** Answers that disagree with what somebody else was told. */
  disputes: Array<{ organisation: string; statement: string; on: string }>;
  /** The kinds of thing they establish most, so a brief can lean on it. */
  strongest: Array<{ what: string; count: number }>;
  /** Written for the owner, in one sentence. */
  sentence: string;
};

/** Turn a dotted claim key into something a person would say. */
function humanKey(key: string): string {
  const parts = key.split('.');
  const last = parts[parts.length - 1];
  return last.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim();
}

/**
 * What one caller has established, from the ledger.
 *
 * Scoped by the attempts they made rather than by the name on the claim: a name
 * is what the record shows a reader, and an attempt id is what actually ties a
 * claim to a person.
 */
export async function callerLearning(params: {
  orgId: string;
  callerId: string;
  dataMode?: 'PRODUCTION' | 'TEST';
  since?: Date;
}): Promise<CallerLearning> {
  const attempts = await prisma.outreachAttempt.findMany({
    where: {
      orgId: params.orgId,
      userId: params.callerId,
      ...(params.dataMode ? { dataMode: params.dataMode } : {}),
      ...(params.since ? { occurredAt: { gte: params.since } } : {}),
    },
    select: { id: true },
    take: 2000,
  });

  if (attempts.length === 0) {
    return {
      established: 0,
      disproved: [],
      disputes: [],
      strongest: [],
      sentence: 'No calls have been recorded for this person yet, so nothing has been established.',
    };
  }

  const refs = attempts.map((a) => `attempt:${a.id}`);
  const claims = await prisma.claim.findMany({
    where: { orgId: params.orgId, sourceRef: { in: refs } },
    orderBy: { recordedAt: 'desc' },
    select: {
      key: true,
      statement: true,
      standing: true,
      recordedAt: true,
      supersededAt: true,
      value: true,
      route: { select: { company: { select: { legalName: true, operatingName: true } } } },
    },
  });

  const name = (c: (typeof claims)[number]) =>
    c.route.company.operatingName ?? c.route.company.legalName;

  // A hypothesis closed is a confirmed negative on the need, which is the one
  // thing a call can establish that saves everybody else the work.
  const disproved = claims
    .filter(
      (c) =>
        c.key === 'buyer.need'
        && c.standing === 'CONFIRMED'
        && typeof c.value === 'object'
        && c.value !== null
        && (c.value as Record<string, unknown>).confirmed === false,
    )
    .map((c) => ({
      organisation: name(c),
      because: c.statement,
      on: c.recordedAt.toISOString().slice(0, 10),
    }));

  const disputes = claims
    .filter((c) => c.standing === 'CONTRADICTED' && c.supersededAt === null)
    .map((c) => ({
      organisation: name(c),
      statement: c.statement,
      on: c.recordedAt.toISOString().slice(0, 10),
    }));

  const current = claims.filter((c) => c.supersededAt === null && c.standing === 'CONFIRMED');

  const byKey = new Map<string, number>();
  for (const claim of current) byKey.set(claim.key, (byKey.get(claim.key) ?? 0) + 1);
  const strongest = [...byKey.entries()]
    .map(([key, count]) => ({ what: humanKey(key), count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    established: current.length,
    disproved,
    disputes,
    strongest,
    // Counts and a plain reading. No rate, because the denominator an operator
    // would divide by — calls where somebody answered — measures the list as
    // much as the caller.
    sentence:
      `${current.length} fact(s) are on the record because this person asked, across ${attempts.length} `
      + `recorded call(s). ${disproved.length} hypothesis(es) were closed`
      + `${disputes.length > 0 ? `, and ${disputes.length} answer(s) disagree with what somebody else was told` : ''}.`,
  };
}

// ---------------------------------------------------------------------------
// Across everybody
// ---------------------------------------------------------------------------

export type BoardLearning = {
  established: number;
  disproved: number;
  openDisputes: number;
  /** Why hypotheses fail, grouped. The most useful thing calling produces. */
  whyTheyFail: Array<{ reason: string; count: number; examples: string[] }>;
  sentence: string;
};

/**
 * What the calling has taught the engine, across everybody.
 *
 * The grouping of failure reasons is the point. A playbook that keeps producing
 * routes disqualified for the same stated reason is a playbook to change, and
 * that pattern is invisible in a disposition count — "not interested" tells
 * nobody anything, and "the general contractor has the final clean in their own
 * scope" tells you to stop generating that route.
 */
export async function boardLearning(params: {
  orgId: string;
  dataMode?: 'PRODUCTION' | 'TEST';
  since?: Date;
}): Promise<BoardLearning> {
  const claims = await prisma.claim.findMany({
    where: {
      orgId: params.orgId,
      dataMode: params.dataMode ?? 'PRODUCTION',
      sourceKind: 'PERSON',
      ...(params.since ? { recordedAt: { gte: params.since } } : {}),
    },
    orderBy: { recordedAt: 'desc' },
    take: 5000,
    select: { key: true, statement: true, standing: true, supersededAt: true, value: true },
  });

  const current = claims.filter((c) => c.supersededAt === null);
  const established = current.filter((c) => c.standing === 'CONFIRMED').length;
  const openDisputes = current.filter((c) => c.standing === 'CONTRADICTED').length;

  const failures = claims.filter(
    (c) =>
      c.key === 'buyer.need'
      && typeof c.value === 'object'
      && c.value !== null
      && (c.value as Record<string, unknown>).confirmed === false,
  );

  // Grouped by the disposition that produced them rather than by the free text,
  // because two callers describing the same reason in their own words would
  // otherwise never group at all.
  const byDisposition = new Map<string, { count: number; examples: string[] }>();
  for (const failure of failures) {
    const disposition = String((failure.value as Record<string, unknown>).disposition ?? 'UNSTATED');
    const entry = byDisposition.get(disposition) ?? { count: 0, examples: [] };
    entry.count += 1;
    if (entry.examples.length < 3) entry.examples.push(failure.statement.slice(0, 200));
    byDisposition.set(disposition, entry);
  }

  const whyTheyFail = [...byDisposition.entries()]
    .map(([reason, { count, examples }]) => ({
      reason: reason.toLowerCase().replace(/_/g, ' '),
      count,
      examples,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    established,
    disproved: failures.length,
    openDisputes,
    whyTheyFail,
    sentence:
      established === 0 && failures.length === 0
        ? 'Nothing has been established by a call yet. Everything on the board is still the engine\'s reading '
          + 'of a public record.'
        : `${established} fact(s) about real businesses exist because somebody rang and asked. `
          + `${failures.length} hypothesis(es) have been closed by an answer`
          + `${openDisputes > 0 ? `, and ${openDisputes} claim(s) are disputed` : ''}.`,
  };
}
