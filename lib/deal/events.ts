import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

/**
 * The append-only trail behind every deal transition.
 *
 * Written with the transaction client, inside the same transaction as the
 * change it describes, which is the whole reason this exists separately from
 * `audit()`. The audit log is deliberately best-effort: it swallows its own
 * errors so a logging failure can never fail an operator's request. That is
 * right for a security log and wrong here. A quote that moved to SENT with no
 * record of who sent it or what it said is a number nobody can defend three
 * months later, and "the log write failed" is not an acceptable answer when the
 * question is why we owe somebody money.
 *
 * So: if the event cannot be written, the change does not happen either.
 */

export type DealEventInput = {
  orgId: string;
  routeId: string;
  /** Dotted, past tense: `requirement.captured`, `quote.sent`, `payment.settled`. */
  kind: string;
  actorType?: 'user' | 'system' | 'ai';
  actorId?: string | null;
  subjectType: 'BuyerRequirement' | 'ProviderCandidate' | 'RouteQuote' | 'RouteDeal' | 'DealPayment' | 'DealMilestone' | 'Approval' | 'Task';
  subjectId?: string | null;
  summary: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  evidence?: string | null;
  confidence?: string | null;
  correlationId?: string | null;
};

/** Groups every event produced by one operator action. */
export function newCorrelationId(): string {
  return randomUUID();
}

export async function recordDealEvent(
  tx: Prisma.TransactionClient,
  input: DealEventInput,
): Promise<void> {
  await tx.dealEvent.create({
    data: {
      orgId: input.orgId,
      routeId: input.routeId,
      kind: input.kind,
      actorType: input.actorType ?? 'user',
      actorId: input.actorId ?? null,
      subjectType: input.subjectType,
      subjectId: input.subjectId ?? null,
      summary: input.summary,
      before: (input.before ?? {}) as Prisma.InputJsonValue,
      after: (input.after ?? {}) as Prisma.InputJsonValue,
      evidence: input.evidence ?? null,
      confidence: input.confidence ?? null,
      correlationId: input.correlationId ?? null,
    },
  });
}

/**
 * The subset of a record worth keeping in `before`/`after`.
 *
 * Storing the whole row would make every event enormous and most of it noise;
 * storing nothing would make "what changed" unanswerable. This keeps the fields
 * that were actually written, which is what a reader wants.
 */
export function diffOf<T extends Record<string, unknown>>(
  before: T | null | undefined,
  after: Partial<T>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};

  for (const key of Object.keys(after)) {
    const previous = before ? (before as Record<string, unknown>)[key] : undefined;
    const next = (after as Record<string, unknown>)[key];
    if (serialise(previous) === serialise(next)) continue;
    changedBefore[key] = serialise(previous);
    changedAfter[key] = serialise(next);
  }

  return { before: changedBefore, after: changedAfter };
}

/** Decimals and dates do not survive JSON honestly on their own. */
function serialise(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && value !== null && 'toFixed' in value && typeof (value as { toFixed: unknown }).toFixed === 'function') {
    return String(value);
  }
  return value;
}
