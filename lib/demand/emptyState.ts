import { prisma } from '@/lib/db';
import { demandSourceHealth } from './run';

/**
 * Why the board is empty.
 *
 * The board used to say "Nothing in this view. That is a result, not an error —
 * the other tabs may have work." That sentence is right about a filter with
 * nothing behind it and badly wrong about the state this product was actually
 * in: four of eight configured datasets had moved, been withdrawn, or lost the
 * columns the parser needed, a fifth was answering with a filtering appliance's
 * block page, and the board's response was to reassure the operator that this
 * was not an error.
 *
 * An empty screen has to distinguish three quite different situations, because
 * they have three different next actions and only one of them is "look at
 * another tab":
 *
 *   this filter is empty, other filters have work   → change the filter
 *   nothing has been collected, the sources are broken  → fix the source
 *   nothing has been collected, the sources are fine    → wait, genuinely
 *
 * The third is the only one that is "not an error", and it is the one this
 * deployment is not currently in.
 */

export type BoardEmptiness = {
  /** True when the whole production world is empty, not just this view. */
  nothingCollected: boolean;
  /** Live routes across every filter. */
  totalRoutes: number;
  /** Events collected, which can be non-zero while routes are zero. */
  totalEvents: number;
  /** One sentence for the top of the empty card. */
  headline: string;
  /**
   * The stage in the collection chain that is broken, and what would fix it.
   * Null when nothing is broken and the emptiness is honest.
   */
  brokenStage: { stage: string; detail: string; fix: string } | null;
  /** Per-source lines, so the claim above is checkable rather than asserted. */
  sources: Array<{
    connector: string;
    name: string;
    state: 'working' | 'failing' | 'not configured' | 'produced nothing' | 'never run';
    reason: string;
  }>;
};

export async function boardEmptiness(orgId: string): Promise<BoardEmptiness> {
  const [totalRoutes, totalEvents, health] = await Promise.all([
    prisma.routeHypothesis.count({
      where: { orgId, dataMode: 'PRODUCTION', status: { notIn: ['EXPIRED', 'REJECTED'] } },
    }),
    prisma.demandEvent.count({ where: { orgId, dataMode: 'PRODUCTION' } }),
    demandSourceHealth(orgId),
  ]);

  const sources = health.map((h) => ({
    connector: h.connector,
    name: h.name,
    state: !h.configured
      ? ('not configured' as const)
      : h.lastAttemptAt === null
        ? ('never run' as const)
        : h.lastStatus === 'FAILED'
          ? ('failing' as const)
          : h.eventsCreated > 0 || h.eventsUpdated > 0
            ? ('working' as const)
            : ('produced nothing' as const),
    reason: h.outcomeReason ?? h.error ?? 'No run has been recorded.',
  }));

  const failing = sources.filter((s) => s.state === 'failing');
  const barren = sources.filter((s) => s.state === 'produced nothing');
  const working = sources.filter((s) => s.state === 'working');
  const neverRun = sources.filter((s) => s.state === 'never run');

  if (totalRoutes > 0) {
    return {
      nothingCollected: false,
      totalRoutes,
      totalEvents,
      headline:
        `Nothing in this view. ${totalRoutes} route(s) are live under other filters, so this is a filter `
        + 'with nothing behind it rather than an empty engine.',
      brokenStage: null,
      sources,
    };
  }

  // From here the whole board is empty, and the only useful thing to say is
  // which stage of the chain from source to callable route stopped.
  const brokenStage = firstBrokenStage({ totalEvents, failing, barren, working, neverRun });

  return {
    nothingCollected: true,
    totalRoutes,
    totalEvents,
    headline:
      totalEvents === 0
        ? 'No demand has been collected at all. Nothing here is filtered out; there is nothing to filter.'
        : `${totalEvents} event(s) have been collected and none has become a callable route.`,
    brokenStage,
    sources,
  };
}

/**
 * Exported so the decision can be tested without a database. The queries above
 * are three counts; the judgement below is the part that can be wrong.
 */
export function firstBrokenStage(input: {
  totalEvents: number;
  failing: BoardEmptiness['sources'];
  barren: BoardEmptiness['sources'];
  working: BoardEmptiness['sources'];
  neverRun: BoardEmptiness['sources'];
}): BoardEmptiness['brokenStage'] {
  const { totalEvents, failing, barren, working, neverRun } = input;

  if (failing.length > 0 && working.length === 0) {
    return {
      stage: 'Collection',
      detail:
        `Every source that has run is failing (${failing.length}). `
        + failing.map((f) => `${f.name}: ${f.reason}`).join(' '),
      fix: 'Fix or replace the sources on Source health. Until one of them returns records there is nothing downstream to work.',
    };
  }

  if (failing.length > 0) {
    return {
      stage: 'Collection',
      detail:
        `${failing.length} of ${failing.length + working.length + barren.length} source(s) are failing. `
        + failing.map((f) => `${f.name}: ${f.reason}`).join(' '),
      fix: 'Fix the failing sources; the working ones are not covering the gap.',
    };
  }

  if (working.length === 0 && barren.length > 0) {
    return {
      stage: 'Collection',
      detail:
        `Every source ran without error and produced nothing. `
        + barren.map((b) => `${b.name}: ${b.reason}`).join(' '),
      fix:
        'Read the per-dataset breakdown on Source health. A source that fetches records and creates no '
        + 'events is a filter or a mapping, not a quiet week.',
    };
  }

  if (working.length === 0 && neverRun.length > 0) {
    return {
      stage: 'Scheduling',
      detail: `${neverRun.length} source(s) have never been attempted.`,
      fix: 'Run the demand sources by hand from Source health, or check the recurring worker is firing.',
    };
  }

  if (totalEvents > 0) {
    return {
      stage: 'Routing',
      detail:
        `${totalEvents} event(s) were collected and none produced a route. The events exist; nothing turned `
        + 'them into work.',
      fix:
        'Check verification and the playbooks: an event that cannot be matched to a company, or whose window '
        + 'has closed, is collected and then correctly discarded.',
    };
  }

  return null;
}
