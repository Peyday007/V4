import { prisma } from '@/lib/db';
import { audit } from '@/lib/audit';
import { compete, CREDIBILITY_GATE } from './competition';
import { playbookByKey } from './playbooks';

/**
 * The board as it would be built today, held against the board as it is.
 *
 * The competition — one event, one primary reading — was added after two
 * hundred routes already existed. Everything created before it was built under
 * the old rule, where every playbook that could plausibly read an event
 * produced a route, and the result is a board where a single licence record can
 * appear four times wearing four different hypotheses. That is the refraction
 * this product exists to stop, and it is still sitting on the board.
 *
 * Deleting it in a migration would have been quick and wrong. Some of those
 * routes have been called. Some have a quote against them. A tidy-up that
 * closes a record somebody spoke to a human being about destroys the only
 * evidence of that conversation, and the operator finds out when they ring back
 * and have nothing.
 *
 * So this writes nothing. It re-runs the competition over what already exists
 * and reports what would happen, in four buckets an owner can act on
 * separately. The mutation is a different function behind a different approval,
 * and it only ever touches ids the owner named.
 */

export type RouteVerdict =
  /** Would be built today, or is the only reading of its event. */
  | 'RETAINED'
  /** A weaker reading of an event that has a stronger one. Proposed for closure. */
  | 'SUPERSEDED'
  /** Somebody has worked it. Never proposed for closure, whatever it scores. */
  | 'WORKED'
  /** Its event supports no credible reading today, including this one. */
  | 'NO_CREDIBLE_READING';

export type ReconciliationRow = {
  routeId: string;
  organisation: string;
  headline: string;
  playbookKey: string;
  verdict: RouteVerdict;
  /** Why, in the words the preview shows. */
  because: string;
  /** What would be done to it, or that nothing would. */
  proposedAction: string;
  /** Evidence of work against it. Non-empty forces WORKED. */
  work: { attempts: number; quotes: number; hasDeal: boolean; claims: number };
};

export type ReconciliationGroup = {
  eventId: string;
  eventHeadline: string;
  /** How many routes this one event currently supports. */
  routeCount: number;
  /** The reading that would win today, where one would. */
  winner: { routeId: string; playbookKey: string; score: number } | null;
  rows: ReconciliationRow[];
};

export type ReconciliationPreview = {
  totalRoutes: number;
  eventsWithMultipleRoutes: number;
  counts: Record<RouteVerdict, number>;
  groups: ReconciliationGroup[];
  /** What this would do, in one paragraph, before anybody presses anything. */
  standing: string;
};

/**
 * What would change, without changing anything.
 *
 * Only events carrying more than one route are examined. A single route is not
 * refraction whatever it scores — the competition exists to stop one event
 * becoming several jobs, not to re-adjudicate every hypothesis this engine has
 * ever formed, and a preview that proposed closing a thousand singletons would
 * be a different and much worse product.
 */
export async function reconciliationPreview(params: {
  orgId: string;
  dataMode?: 'PRODUCTION' | 'TEST';
  limit?: number;
}): Promise<ReconciliationPreview> {
  const dataMode = params.dataMode ?? 'PRODUCTION';

  const routes = await prisma.routeHypothesis.findMany({
    where: {
      orgId: params.orgId,
      dataMode,
      // A route already closed is not refraction anybody is looking at.
      status: { notIn: ['EXPIRED', 'REJECTED'] },
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      eventId: true,
      playbookKey: true,
      headline: true,
      createdAt: true,
      company: { select: { legalName: true, operatingName: true } },
      event: {
        select: {
          id: true,
          type: true,
          headline: true,
          summary: true,
          confirmedFacts: true,
        },
      },
      _count: { select: { outreachAttempts: true, quotes: true, claims: true } },
      deal: { select: { id: true } },
    },
  });

  const byEvent = new Map<string, typeof routes>();
  for (const route of routes) {
    byEvent.set(route.eventId, [...(byEvent.get(route.eventId) ?? []), route]);
  }

  const multi = [...byEvent.entries()].filter(([, list]) => list.length > 1);
  const groups: ReconciliationGroup[] = [];
  const counts: Record<RouteVerdict, number> = {
    RETAINED: 0,
    SUPERSEDED: 0,
    WORKED: 0,
    NO_CREDIBLE_READING: 0,
  };

  for (const [eventId, list] of multi.slice(0, params.limit ?? 200)) {
    const event = list[0].event;

    // The same competition the pipeline runs, over the readings that already
    // exist rather than over every playbook — this is asking which of *these*
    // would survive, not rebuilding the event from scratch.
    const candidates = list
      .map((route) => {
        const playbook = playbookByKey(route.playbookKey);
        if (!playbook) return null;
        return {
          playbook,
          headline: event.headline,
          scopeText: event.summary,
          confirmedFacts: factStrings(event.confirmedFacts),
          // Our own conclusions are excluded by construction: a hypothesis
          // cannot be evidence for itself, and that holds when re-scoring an
          // old route as much as when building a new one.
          inferredFacts: [],
          providerCount: 0,
          // Both true for every candidate, so neither dimension separates them.
          // The point of this pass is which *reading* of the event is strongest,
          // not whether the supply or the timing has moved since — those change
          // with the world and would make a reconciliation a re-adjudication of
          // everything.
          buyerIdentified: true,
          insideWindow: true,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    const result = candidates.length > 0
      ? compete({ eventType: event.type, candidates })
      : null;

    const winnerKey = result?.primary?.playbookKey ?? null;
    const winnerRoute = winnerKey ? list.find((r) => r.playbookKey === winnerKey) ?? null : null;

    const rows: ReconciliationRow[] = list.map((route) => {
      const work = {
        attempts: route._count.outreachAttempts,
        quotes: route._count.quotes,
        hasDeal: route.deal !== null,
        claims: route._count.claims,
      };
      const worked = work.attempts > 0 || work.quotes > 0 || work.hasDeal;

      // The rule that makes this safe to offer at all. A record somebody rang
      // is a record of a conversation, and no scoring result outranks that.
      if (worked) {
        counts.WORKED += 1;
        return {
          routeId: route.id,
          organisation: route.company.operatingName ?? route.company.legalName,
          headline: route.headline,
          playbookKey: route.playbookKey,
          verdict: 'WORKED',
          because:
            `Somebody has worked this: ${[
              work.attempts > 0 ? `${work.attempts} call attempt(s)` : null,
              work.quotes > 0 ? `${work.quotes} quote(s)` : null,
              work.hasDeal ? 'a deal' : null,
            ].filter(Boolean).join(', ')}.`,
          proposedAction:
            'Nothing. A record of a conversation is not tidied away because a scoring rule written afterwards '
            + 'disagrees with it.',
          work,
        };
      }

      if (!winnerRoute) {
        counts.NO_CREDIBLE_READING += 1;
        return {
          routeId: route.id,
          organisation: route.company.operatingName ?? route.company.legalName,
          headline: route.headline,
          playbookKey: route.playbookKey,
          verdict: 'NO_CREDIBLE_READING',
          because:
            result
              ? `No reading of this event scores against the gate of ${CREDIBILITY_GATE}. ${result.verdict}`
              : 'None of these routes names a playbook this system still has, so nothing can be scored.',
          proposedAction:
            'Close the whole group with the reason recorded. The event stays, so a better source or a new '
            + 'playbook can produce a route from it later.',
          work,
        };
      }

      if (route.id === winnerRoute.id) {
        counts.RETAINED += 1;
        const scored = result?.primary;
        return {
          routeId: route.id,
          organisation: route.company.operatingName ?? route.company.legalName,
          headline: route.headline,
          playbookKey: route.playbookKey,
          verdict: 'RETAINED',
          because: `The strongest reading of this event today, scoring ${scored?.total ?? 0}.`,
          proposedAction: 'Nothing. This is the route the engine would build now.',
          work,
        };
      }

      counts.SUPERSEDED += 1;
      const alternative = result?.alternatives.find((a) => a.playbookKey === route.playbookKey);
      return {
        routeId: route.id,
        organisation: route.company.operatingName ?? route.company.legalName,
        headline: route.headline,
        playbookKey: route.playbookKey,
        verdict: 'SUPERSEDED',
        because:
          `A weaker reading of the same event. ${alternative?.lostBecause ?? 'It lost to the primary reading.'} `
          + 'Built before one event was limited to one primary thesis.',
        proposedAction:
          'Close it, keeping the event and the reasoning. The stronger reading of the same event stays open, '
          + 'so nothing about this organisation is lost.',
        work,
      };
    });

    groups.push({
      eventId,
      eventHeadline: event.headline,
      routeCount: list.length,
      winner: winnerRoute
        ? {
            routeId: winnerRoute.id,
            playbookKey: winnerRoute.playbookKey,
            score: result?.primary?.total ?? 0,
          }
        : null,
      rows,
    });
  }

  const closable = counts.SUPERSEDED + counts.NO_CREDIBLE_READING;

  return {
    totalRoutes: routes.length,
    eventsWithMultipleRoutes: multi.length,
    counts,
    // Sorted so the worst refraction is the first thing an owner reads.
    groups: groups.sort((a, b) => b.routeCount - a.routeCount),
    standing:
      multi.length === 0
        ? 'No event on this board supports more than one route. There is no refraction to reconcile.'
        : `${multi.length} event(s) currently support more than one route each. Re-running the competition over `
          + `them proposes closing ${closable}, keeping ${counts.RETAINED} as the strongest reading, and leaving `
          + `${counts.WORKED} alone because somebody has already worked them. Nothing here has been changed — `
          + 'this is what would happen.',
  };
}

/**
 * Applies a reconciliation, and only to the routes an owner named.
 *
 * Deliberately takes explicit ids rather than a filter. "Close everything the
 * preview called superseded" is a sentence, not an instruction, and the gap
 * between the preview an owner read and the state of the board when they
 * pressed the button is exactly where a tidy-up destroys something.
 *
 * Every closure is re-checked against the same safety rule the preview applied:
 * a route somebody has worked is refused here even if the owner asked for it,
 * because the preview they read may be an hour old and a call may have happened
 * since.
 */
export async function applyReconciliation(params: {
  orgId: string;
  actorId: string;
  routeIds: string[];
  /** The owner's own words for why. Recorded on every route closed. */
  reason: string;
}): Promise<{ closed: number; refused: Array<{ routeId: string; because: string }> }> {
  const refused: Array<{ routeId: string; because: string }> = [];
  let closed = 0;

  const routes = await prisma.routeHypothesis.findMany({
    where: { id: { in: params.routeIds }, orgId: params.orgId },
    select: {
      id: true,
      status: true,
      _count: { select: { outreachAttempts: true, quotes: true } },
      deal: { select: { id: true } },
    },
  });
  const found = new Map(routes.map((r) => [r.id, r]));

  for (const routeId of params.routeIds) {
    const route = found.get(routeId);
    if (!route) {
      refused.push({ routeId, because: 'Not an opportunity on this account.' });
      continue;
    }
    if (['EXPIRED', 'REJECTED'].includes(route.status)) {
      refused.push({ routeId, because: 'Already closed.' });
      continue;
    }
    // Re-checked rather than trusted. The preview may be an hour old.
    if (route._count.outreachAttempts > 0 || route._count.quotes > 0 || route.deal !== null) {
      refused.push({
        routeId,
        because:
          'Somebody has worked this since the preview was read. Refused — a record of a conversation is not '
          + 'tidied away.',
      });
      continue;
    }

    await prisma.routeHypothesis.update({
      where: { id: routeId },
      data: {
        status: 'REJECTED',
        statusReason:
          `Closed in a reconciliation on ${new Date().toISOString().slice(0, 10)}. ${params.reason}`.slice(0, 2000),
      },
    });
    closed += 1;
  }

  await audit({
    orgId: params.orgId,
    userId: params.actorId,
    action: 'demand.reconciled',
    entityType: 'RouteHypothesis',
    entityId: params.routeIds[0] ?? 'none',
    metadata: { requested: params.routeIds.length, closed, refused: refused.length, reason: params.reason },
  });

  return { closed, refused };
}

/** Stated facts on an event, flattened for evidence matching. */
function factStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>;
        const text = record.fact ?? record.statement ?? record.text ?? record.value;
        return typeof text === 'string' ? text : null;
      }
      return null;
    })
    .filter((s): s is string => typeof s === 'string');
}
