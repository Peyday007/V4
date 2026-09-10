import { prisma } from '@/lib/db';
import { brainConfig } from './config';
import { deliveryHash, toDelivery } from './map';
import { describeFailure, pushRecords, readProjectionsSince, type BrainProjection } from './client';

/**
 * Keeping Brain's copy of this site's records current.
 *
 * Two halves that never touch each other's cursor:
 *
 *   **Push** walks opportunities in `updatedAt` order from a stored watermark
 *   and sends the ones that have moved. It is bounded by a page size, so a
 *   backfill of ten thousand records is however many invocations it takes
 *   rather than one that dies at the platform's function timeout. It is not a
 *   full-table scan: the cursor is an indexed range.
 *
 *   **Pull** asks Brain what has changed *there* since a stored watermark and
 *   writes the answers into the local cache the board renders from. Brain's
 *   feed only moves when something actually changed, so an idle tick reads one
 *   empty page.
 *
 * Both are at-least-once and both are safe to repeat: the push is deduplicated
 * by content hash on this side and by content hash and version on Brain's, and
 * the pull is an upsert of a projection that is itself derived.
 *
 * The cursors advance only after the work they describe has been done. A crash
 * re-does a page; it never skips one.
 */

export const PUSH_PAGE = 100;
export const PULL_PAGE = 100;

export interface PushOutcome {
  connected: boolean;
  considered: number;
  sent: number;
  imported: number;
  updated: number;
  unchanged: number;
  stale: number;
  rejected: { sourceRecordId: string | null; reason: string }[];
  more: boolean;
  error: string | null;
}

async function syncState(orgId: string) {
  return await prisma.brainSyncState.upsert({
    where: { orgId },
    create: { orgId },
    update: {},
  });
}

/**
 * Send one bounded page of changed opportunities.
 *
 * `updatedAt` strictly greater than the cursor, ordered, limited. Two records
 * sharing a millisecond are handled by the id tiebreak in the ordering and by
 * the cursor only advancing to the last record actually sent — a record that
 * shares a timestamp with the watermark is re-sent next time and answered
 * `unchanged`, which is the cheap side of the trade.
 */
export async function pushChanges(input: {
  orgId: string;
  limit?: number;
}): Promise<PushOutcome> {
  const empty: PushOutcome = {
    connected: false,
    considered: 0,
    sent: 0,
    imported: 0,
    updated: 0,
    unchanged: 0,
    stale: 0,
    rejected: [],
    more: false,
    error: null,
  };
  if (!brainConfig()) return empty;

  const limit = Math.min(Math.max(input.limit ?? PUSH_PAGE, 1), 200);
  const state = await syncState(input.orgId);

  const opportunities = await prisma.opportunity.findMany({
    where: {
      orgId: input.orgId,
      ...(state.pushCursor ? { updatedAt: { gte: state.pushCursor } } : {}),
    },
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    take: limit,
    include: { lane: { select: { name: true } } },
  });

  if (opportunities.length === 0) return { ...empty, connected: true };

  const links = new Map(
    (
      await prisma.brainLink.findMany({
        where: { opportunityId: { in: opportunities.map((o) => o.id) } },
      })
    ).map((link) => [link.opportunityId, link]),
  );

  const deliveries = [];
  const hashes = new Map<string, string>();
  for (const opportunity of opportunities) {
    const delivery = toDelivery(opportunity);
    const hash = deliveryHash(delivery);
    hashes.set(opportunity.id, hash);
    // Already sent, byte for byte. Not a request.
    if (links.get(opportunity.id)?.lastPushedHash === hash) continue;
    deliveries.push(delivery);
  }

  const outcome: PushOutcome = {
    ...empty,
    connected: true,
    considered: opportunities.length,
    sent: deliveries.length,
    more: opportunities.length === limit,
  };

  if (deliveries.length > 0) {
    const result = await pushRecords(deliveries);
    if (!result.ok) {
      const message = describeFailure(result.failure);
      await prisma.brainSyncState.update({
        where: { orgId: input.orgId },
        data: { lastError: message },
      });
      return { ...outcome, error: message, more: false };
    }
    outcome.imported = result.value.imported;
    outcome.updated = result.value.updated;
    outcome.unchanged = result.value.unchanged;
    outcome.stale = result.value.stale;
    outcome.rejected = result.value.rejected.map((entry) => ({
      sourceRecordId: entry.sourceRecordId,
      reason: entry.reason,
    }));

    /*
     * A record Brain refused is not marked as sent.
     *
     * Its hash is deliberately not written, so the next page reconsiders it —
     * and its rejection is on Brain's ledger with a reason. Silently advancing
     * past it would be the one thing the assignment forbids: an unmappable
     * record dropped without anybody being told.
     */
    const refused = new Set(
      result.value.rejected
        .map((entry) => entry.sourceRecordId)
        .filter((id): id is string => typeof id === 'string'),
    );
    const now = new Date();
    for (const delivery of deliveries) {
      if (refused.has(delivery.sourceRecordId)) continue;
      await markPushed({
        orgId: input.orgId,
        opportunityId: delivery.sourceRecordId,
        version: new Date(delivery.sourceVersion),
        hash: hashes.get(delivery.sourceRecordId)!,
        at: now,
      });
    }
  }

  const last = opportunities[opportunities.length - 1]!;
  await prisma.brainSyncState.update({
    where: { orgId: input.orgId },
    data: { pushCursor: last.updatedAt, pushedAt: new Date(), lastError: null },
  });

  return outcome;
}

/**
 * Send exactly one opportunity, now.
 *
 * The bounded half of `pushChanges`, for the moment somebody opens a record
 * Brain has never been told about. It moves no cursor — the cursor belongs to
 * the sweep and advancing it here would skip everything between it and this
 * record — and it is idempotent on both sides.
 *
 * Returns whether Brain accepted it, so the caller can tell "registered" from
 * "refused" rather than assuming.
 */
export async function pushOne(input: {
  orgId: string;
  opportunityId: string;
}): Promise<boolean> {
  if (!brainConfig()) return false;
  const opportunity = await prisma.opportunity.findFirst({
    where: { id: input.opportunityId, orgId: input.orgId },
    include: { lane: { select: { name: true } } },
  });
  if (!opportunity) return false;

  const delivery = toDelivery(opportunity);
  const result = await pushRecords([delivery]);
  if (!result.ok) return false;
  if (result.value.rejected.some((entry) => entry.sourceRecordId === input.opportunityId)) {
    return false;
  }

  await markPushed({
    orgId: input.orgId,
    opportunityId: input.opportunityId,
    version: new Date(delivery.sourceVersion),
    hash: deliveryHash(delivery),
    at: new Date(),
  });
  return true;
}

/**
 * Record that one opportunity's current content reached Brain.
 *
 * An upsert with no `brainId` yet: the id is Brain's to assign and arrives on
 * the next pull. Writing a placeholder would make the row lie about having an
 * identity it does not have, so the columns stay empty until the projection
 * fills them.
 */
async function markPushed(input: {
  orgId: string;
  opportunityId: string;
  version: Date;
  hash: string;
  at: Date;
}): Promise<void> {
  await prisma.brainLink.upsert({
    where: { opportunityId: input.opportunityId },
    create: {
      orgId: input.orgId,
      opportunityId: input.opportunityId,
      // Provisional until the projection arrives. Distinguishable on sight from
      // a real Brain id, which always begins `ext_`.
      brainId: `pending:${input.opportunityId}`,
      brainProjectId: brainConfig()?.projectId ?? '',
      lastPushedVersion: input.version,
      lastPushedHash: input.hash,
      lastPushedAt: input.at,
    },
    update: {
      lastPushedVersion: input.version,
      lastPushedHash: input.hash,
      lastPushedAt: input.at,
    },
  });
}

export interface PullOutcome {
  connected: boolean;
  received: number;
  applied: number;
  more: boolean;
  error: string | null;
}

/** Bring the local cache of Brain's view up to date, one bounded page. */
export async function pullProjections(input: {
  orgId: string;
  limit?: number;
}): Promise<PullOutcome> {
  if (!brainConfig()) {
    return { connected: false, received: 0, applied: 0, more: false, error: null };
  }
  const state = await syncState(input.orgId);
  const result = await readProjectionsSince(state.pullCursor, input.limit ?? PULL_PAGE);
  if (!result.ok) {
    const message = describeFailure(result.failure);
    await prisma.brainSyncState.update({
      where: { orgId: input.orgId },
      data: { lastError: message },
    });
    return { connected: true, received: 0, applied: 0, more: false, error: message };
  }

  let applied = 0;
  for (const projection of result.value.records) {
    if (await applyProjection(input.orgId, projection)) applied += 1;
  }

  if (result.value.cursor) {
    await prisma.brainSyncState.update({
      where: { orgId: input.orgId },
      data: { pullCursor: result.value.cursor, pulledAt: new Date(), lastError: null },
    });
  }

  return {
    connected: true,
    received: result.value.records.length,
    applied,
    more: result.value.more,
    error: null,
  };
}

/**
 * Write one of Brain's answers into the local cache.
 *
 * Guarded on the projection being at least as new as the one already stored, so
 * a page arriving out of order — a retried pull racing a live read of the same
 * record — cannot put an older view back. That is the same rule Brain applies
 * to deliveries, in the other direction.
 *
 * The opportunity itself is never written to. This row is Brain's opinion and
 * the site's own fields are not Brain's to move.
 */
export async function applyProjection(
  orgId: string,
  projection: BrainProjection,
): Promise<boolean> {
  const opportunity = await prisma.opportunity.findFirst({
    where: { id: projection.sourceRecordId, orgId },
    select: { id: true },
  });
  // A record this org does not own is not written anywhere. Brain scopes its
  // answers to the project the credential reaches; this is the second half of
  // the same rule, applied to the tenant.
  if (!opportunity) return false;

  const existing = await prisma.brainLink.findUnique({
    where: { opportunityId: projection.sourceRecordId },
  });
  const arriving = new Date(projection.lastUpdatedAt);
  if (existing?.brainUpdatedAt && existing.brainUpdatedAt > arriving) return false;

  const view = {
    brainId: projection.brainId,
    brainProjectId: brainConfig()?.projectId ?? existing?.brainProjectId ?? '',
    state: projection.state,
    stateReason: projection.stateReason,
    priority: projection.priority,
    priorityRank: projection.priorityRank,
    reason: projection.reason,
    confidence: projection.confidence,
    missionId: projection.research?.missionId ?? null,
    documentId: projection.research?.documentId ?? null,
    conclusion: projection.research?.conclusion ?? null,
    filedUnder: projection.research?.filedUnder ?? null,
    nextAction: projection.nextAction?.command ?? null,
    brainUpdatedAt: arriving,
    observedAt: new Date(projection.observedAt),
    lastError: null,
  };

  await prisma.brainLink.upsert({
    where: { opportunityId: projection.sourceRecordId },
    create: { orgId, opportunityId: projection.sourceRecordId, ...view },
    update: view,
  });
  return true;
}
