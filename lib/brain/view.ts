import type { BrainLink } from '@prisma/client';
import { prisma } from '@/lib/db';
import { describeBrain, isConnected } from './config';
import { applyProjection } from './sync';
import { describeFailure, readProjection, type BrainProjection } from './client';

/**
 * What the site shows about one record, and how fresh it is.
 *
 * The freshness vocabulary is the one `dealDispatch.ts` established on the
 * Brain side, for the same reason: a panel that renders a stored opinion as a
 * live one is worse than one that renders nothing, because the reader cannot
 * tell which they are looking at.
 *
 *   `CURRENT`      read from Brain just now
 *   `STALE`        the last thing we heard, and how old it is
 *   `UNAVAILABLE`  Brain did not answer and we have never heard anything
 *   `NOT_CONNECTED` this site has no Brain
 *
 * A `STALE` view keeps its content — it is still the best answer available and
 * hiding it would be its own dishonesty — and it is labelled, in the type, so
 * a component cannot render it as current by forgetting to check.
 */
export type Freshness = 'CURRENT' | 'STALE' | 'UNAVAILABLE' | 'NOT_CONNECTED';

export interface BrainView {
  freshness: Freshness;
  /** When this was read from Brain. Present on CURRENT and STALE. */
  observedAt: Date | null;
  /** Safe to show. Names what went wrong; never a credential or a URL. */
  reason: string | null;
  /** Which Brain, by host and project. Never the credential. */
  brain: string | null;
  brainId: string | null;
  state: BrainProjection['state'] | null;
  stateReason: string | null;
  priority: string | null;
  priorityRank: number | null;
  brainReason: string | null;
  confidence: number | null;
  research: {
    missionId: string;
    documentId: string | null;
    conclusion: string | null;
    filedUnder: string | null;
  } | null;
  nextAction: string | null;
  commandedByName: string | null;
  commandedAt: Date | null;
}

function fromLink(link: BrainLink, freshness: Freshness, reason: string | null): BrainView {
  return {
    freshness,
    observedAt: link.observedAt,
    reason,
    brain: describeBrain(),
    brainId: link.brainId.startsWith('pending:') ? null : link.brainId,
    state: (link.state as BrainProjection['state'] | null) ?? null,
    stateReason: link.stateReason,
    priority: link.priority,
    priorityRank: link.priorityRank,
    brainReason: link.reason,
    confidence: link.confidence,
    research: link.missionId
      ? {
          missionId: link.missionId,
          documentId: link.documentId,
          conclusion: link.conclusion,
          filedUnder: link.filedUnder,
        }
      : null,
    nextAction: link.nextAction,
    commandedByName: link.commandedByName,
    commandedAt: link.commandedAt,
  };
}

function blank(freshness: Freshness, reason: string | null): BrainView {
  return {
    freshness,
    observedAt: null,
    reason,
    brain: describeBrain(),
    brainId: null,
    state: null,
    stateReason: null,
    priority: null,
    priorityRank: null,
    brainReason: null,
    confidence: null,
    research: null,
    nextAction: null,
    commandedByName: null,
    commandedAt: null,
  };
}

/**
 * Read Brain's view of one record, live, falling back to what we last heard.
 *
 * Live rather than polled, because this is the page a person is looking at
 * right now and one bounded request answers it in one round trip — a poll fast
 * enough to feel live on a detail page would be a poll nobody wanted on every
 * other page. The board reads the cached rows instead, refreshed by the
 * connector's own bounded pull.
 *
 * A successful read is written through to the cache, so the board benefits from
 * somebody opening a record and a later failure has something honest to fall
 * back to.
 */
export async function brainViewOf(input: {
  orgId: string;
  opportunityId: string;
}): Promise<BrainView> {
  if (!isConnected()) return blank('NOT_CONNECTED', null);

  const link = await prisma.brainLink.findFirst({
    where: { opportunityId: input.opportunityId, orgId: input.orgId },
  });

  const result = await readProjection(input.opportunityId);
  if (result.ok) {
    await applyProjection(input.orgId, result.value);
    const fresh = await prisma.brainLink.findFirst({
      where: { opportunityId: input.opportunityId, orgId: input.orgId },
    });
    if (fresh) return fromLink(fresh, 'CURRENT', null);
    return blank('UNAVAILABLE', 'Brain answered about a record this site does not own.');
  }

  /*
   * Brain does not hold it yet.
   *
   * Not an error and not a failure of the connector: an opportunity created a
   * moment ago has not been through a push. It is reported as itself so the
   * panel can say "not sent to Brain yet" rather than "Brain is down".
   */
  if (result.failure.kind === 'NOT_FOUND') {
    if (!link) return blank('CURRENT', 'This record has not reached Brain yet.');
    return fromLink(link, 'STALE', 'Brain no longer holds this record.');
  }

  const reason = describeFailure(result.failure);
  if (link && link.observedAt) return fromLink(link, 'STALE', reason);
  return blank('UNAVAILABLE', reason);
}

/** How old a reading is, in whole minutes, for a label. */
export function ageMinutes(observedAt: Date | null, now = new Date()): number | null {
  if (!observedAt) return null;
  return Math.max(0, Math.floor((now.getTime() - observedAt.getTime()) / 60_000));
}
