import type { ProviderCandidate as ProviderCandidateRow, ProviderWorkState, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { recordDealEvent, diffOf, newCorrelationId } from './events';

/**
 * The supply side of one route, one provider at a time.
 *
 * The reason this is a ladder with eight rungs rather than a flag is that the
 * previous system lost real money on the distance between two of them. A
 * provider found in a directory and a provider who has agreed to do the work on
 * a date at a price are separated by six verifications, and a screen that shows
 * both as "matched" invites somebody to promise a buyer something nobody has
 * agreed to deliver.
 *
 * So `CANDIDATE_FOUND` never reads as secured anywhere, only `COMMITTED` does,
 * and the transition into each rung refuses to happen without the evidence that
 * rung is named after.
 */

/** Position on the ladder. Higher is further along. Terminal states sit outside it. */
const RANK: Record<ProviderWorkState, number> = {
  CANDIDATE_FOUND: 1,
  CONTACTED: 2,
  CAPABILITY_VERIFIED: 3,
  AVAILABILITY_VERIFIED: 4,
  COST_RECEIVED: 5,
  SELECTED: 6,
  COMMITTED: 7,
  REJECTED: 0,
  WITHDRAWN: 0,
};

export const TERMINAL_STATES: ProviderWorkState[] = ['REJECTED', 'WITHDRAWN'];

/** The one state that means a buyer can be promised delivery. */
export const SECURED_STATE: ProviderWorkState = 'COMMITTED';

export type CandidateFields = Partial<{
  matchBasis: string;
  capabilityNotes: string | null;
  geographyNotes: string | null;
  capabilityEvidence: string | null;
  credentialsEvidence: string | null;
  availableFrom: Date | null;
  availableUntil: Date | null;
  capacityNotes: string | null;
  costAmount: Prisma.Decimal | number | null;
  costUnit: string | null;
  costBasis: string | null;
  costTerms: string | null;
  costExpiresAt: Date | null;
  promiseText: string | null;
  promiseDueAt: Date | null;
  promiseKeptAt: Date | null;
  rejectedReason: string | null;
}>;

export type AdvanceRefusal = {
  ok: false;
  /** 'not_found' | 'backwards' | 'missing_evidence' | 'terminal' */
  kind: 'not_found' | 'backwards' | 'missing_evidence' | 'terminal';
  /** Written for the operator, naming what to do next rather than what failed. */
  message: string;
  missing: string[];
};

export type AdvanceSuccess = { ok: true; candidate: ProviderCandidateRow };
export type AdvanceResult = AdvanceSuccess | AdvanceRefusal;

// ---------------------------------------------------------------------------
// What each rung requires
// ---------------------------------------------------------------------------

type EvidenceRule = {
  /** Fields that must be non-empty on the row once the transition is applied. */
  requires: Array<keyof ProviderCandidateRow>;
  /** Said to the operator when they are not. */
  because: string;
};

const EVIDENCE: Partial<Record<ProviderWorkState, EvidenceRule>> = {
  CONTACTED: {
    requires: ['stateReason'],
    because: 'Record what happened when you reached them. "Contacted" with no account of the conversation is a date, not a fact.',
  },
  CAPABILITY_VERIFIED: {
    requires: ['capabilityEvidence'],
    because: 'Say what proves they can do this work — a reference, a licence number, a job they described. Assuming it from a category listing is how we promise work nobody can do.',
  },
  AVAILABILITY_VERIFIED: {
    requires: ['capabilityEvidence', 'capacityNotes'],
    because: 'Availability means somebody told us they have capacity, and when. Capacity is the fastest-decaying fact in this business.',
  },
  COST_RECEIVED: {
    requires: ['capabilityEvidence', 'costAmount', 'costBasis', 'costExpiresAt'],
    because: 'A cost needs an amount, what it covers, and the date it stops being true. A cost without an expiry quietly becomes a guess.',
  },
  SELECTED: {
    requires: ['capabilityEvidence', 'costAmount', 'costBasis', 'costExpiresAt'],
    because: 'Selecting a provider without a live cost means pricing the buyer against a number we do not have.',
  },
  COMMITTED: {
    requires: ['capabilityEvidence', 'capacityNotes', 'costAmount', 'costExpiresAt', 'promiseText'],
    because: 'Committed means they agreed to do the work. Record what they agreed to and by when — this is the promise a buyer will be held to.',
  },
};

/** Human labels, used in the UI and in refusal messages so both say the same thing. */
export const STATE_LABELS: Record<ProviderWorkState, string> = {
  CANDIDATE_FOUND: 'Candidate found',
  CONTACTED: 'Contacted',
  CAPABILITY_VERIFIED: 'Capability verified',
  AVAILABILITY_VERIFIED: 'Availability verified',
  COST_RECEIVED: 'Cost received',
  SELECTED: 'Selected',
  COMMITTED: 'Committed',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
};

/**
 * What the operator is told a state means. Deliberately blunt about the gap
 * between a candidate and secured fulfilment.
 */
export const STATE_MEANING: Record<ProviderWorkState, string> = {
  CANDIDATE_FOUND: 'On file as possibly able to do this. Nobody has spoken to them. Not fulfilment.',
  CONTACTED: 'We have reached them. They have not confirmed they can do it.',
  CAPABILITY_VERIFIED: 'They can do this kind of work. Whether they can do it now is a separate question.',
  AVAILABILITY_VERIFIED: 'They have capacity, and we know roughly when.',
  COST_RECEIVED: 'They gave us a price. It has an expiry date and is not a commitment.',
  SELECTED: 'Our choice for this route. They have not agreed to it yet.',
  COMMITTED: 'They have agreed to do the work. This is the only state that means fulfilment is secured.',
  REJECTED: 'Ruled out by us.',
  WITHDRAWN: 'They pulled out.',
};

// ---------------------------------------------------------------------------
// Rollup
// ---------------------------------------------------------------------------

export type SupplyPosture = {
  /** The furthest any candidate has got. Null when there are none. */
  best: ProviderWorkState | null;
  /** Only true at COMMITTED. Nothing else may be described as secured. */
  secured: boolean;
  candidateCount: number;
  liveCount: number;
  /** Candidates whose cost has expired, so the number behind a quote is stale. */
  staleCostIds: string[];
  /** Provider promises now overdue. */
  overduePromiseIds: string[];
  /** One line for a caller about to speak to the buyer. */
  headline: string;
};

export function supplyPosture(
  candidates: ProviderCandidateRow[],
  now: Date = new Date(),
): SupplyPosture {
  const live = candidates.filter((c) => !TERMINAL_STATES.includes(c.state));
  const best = live.reduce<ProviderWorkState | null>(
    (acc, c) => (acc === null || RANK[c.state] > RANK[acc] ? c.state : acc),
    null,
  );

  const staleCostIds = live
    .filter((c) => c.costExpiresAt !== null && c.costExpiresAt.getTime() <= now.getTime())
    .map((c) => c.id);
  const overduePromiseIds = live
    .filter((c) => c.promiseDueAt !== null && c.promiseKeptAt === null && c.promiseDueAt.getTime() <= now.getTime())
    .map((c) => c.id);

  const secured = best === 'COMMITTED';

  let headline: string;
  if (live.length === 0) {
    headline = candidates.length === 0
      ? 'No provider candidate. The demand is still real; the supply gap is ours to close.'
      : 'Every provider candidate has been ruled out or withdrew. This route needs a new one.';
  } else if (secured) {
    headline = 'A provider has committed to this work.';
  } else {
    headline = `${STATE_LABELS[best as ProviderWorkState]} — ${STATE_MEANING[best as ProviderWorkState]}`;
  }

  return { best, secured, candidateCount: candidates.length, liveCount: live.length, staleCostIds, overduePromiseIds, headline };
}

/** Whether a cost is still good. A null expiry means we never asked, which is not "fine". */
export function costIsUsable(candidate: ProviderCandidateRow, now: Date = new Date()): boolean {
  if (candidate.costAmount === null) return false;
  if (candidate.costExpiresAt === null) return false;
  return candidate.costExpiresAt.getTime() > now.getTime();
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export async function addCandidate(options: {
  orgId: string;
  routeId: string;
  providerCompanyId: string;
  matchBasis: string;
  actorId?: string | null;
  actorType?: 'user' | 'system' | 'ai';
}): Promise<ProviderCandidateRow> {
  const conflictNote = await conflictFor(options.orgId, options.routeId, options.providerCompanyId);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.providerCandidate.findUnique({
      where: { routeId_providerCompanyId: { routeId: options.routeId, providerCompanyId: options.providerCompanyId } },
    });
    // Re-finding a provider we already know about must never reset the work
    // already done on them. The row stays exactly where it is.
    if (existing) return existing;

    const created = await tx.providerCandidate.create({
      data: {
        orgId: options.orgId,
        routeId: options.routeId,
        providerCompanyId: options.providerCompanyId,
        state: 'CANDIDATE_FOUND',
        matchBasis: options.matchBasis,
        conflictNote,
      },
    });

    await recordDealEvent(tx, {
      orgId: options.orgId,
      routeId: options.routeId,
      kind: 'provider.candidate_found',
      actorType: options.actorType ?? 'system',
      actorId: options.actorId,
      subjectType: 'ProviderCandidate',
      subjectId: created.id,
      summary: `Provider candidate added: ${options.matchBasis}`,
      after: { state: 'CANDIDATE_FOUND' },
      confidence: 'candidate_only',
      correlationId: newCorrelationId(),
    });

    return created;
  });
}

/**
 * Move one candidate along the ladder, or refuse and say why.
 *
 * Forward jumps are allowed — a provider we have already verified in the
 * catalogue does not need to be walked through three screens — but the evidence
 * for every rung passed is still required, so the jump cannot be used to skip
 * the checks rather than the clicks.
 */
export async function advanceCandidate(options: {
  orgId: string;
  candidateId: string;
  to: ProviderWorkState;
  reason: string;
  fields?: CandidateFields;
  actorId?: string | null;
  actorType?: 'user' | 'system' | 'ai';
  now?: Date;
}): Promise<AdvanceResult> {
  const now = options.now ?? new Date();

  return prisma.$transaction(async (tx) => {
    const candidate = await tx.providerCandidate.findFirst({
      where: { id: options.candidateId, orgId: options.orgId },
    });
    if (!candidate) {
      return { ok: false, kind: 'not_found', message: 'That provider candidate is not on this account.', missing: [] };
    }

    if (TERMINAL_STATES.includes(candidate.state) && !TERMINAL_STATES.includes(options.to)) {
      return {
        ok: false,
        kind: 'terminal',
        message: `${STATE_LABELS[candidate.state]} is where this candidate ended. Add them again as a new candidate if that has changed.`,
        missing: [],
      };
    }

    if (!TERMINAL_STATES.includes(options.to) && RANK[options.to] < RANK[candidate.state]) {
      return {
        ok: false,
        kind: 'backwards',
        message: `This candidate is already at ${STATE_LABELS[candidate.state]}. Moving back to ${STATE_LABELS[options.to]} would erase what we verified — rule them out or record what changed instead.`,
        missing: [],
      };
    }

    // Apply the incoming fields to a copy, then check the evidence against what
    // the row *would* be. Checking the row as it stands would refuse a
    // transition whose evidence arrives in the same request.
    const proposed = { ...candidate, ...stamped(options.to, options.fields ?? {}, now) };
    const missing = missingEvidence(proposed as ProviderCandidateRow, options.to);
    if (missing.length > 0) {
      return {
        ok: false,
        kind: 'missing_evidence',
        message: EVIDENCE[options.to]?.because ?? `More is needed before ${STATE_LABELS[options.to]}.`,
        missing,
      };
    }

    const data: Prisma.ProviderCandidateUpdateInput = {
      ...(stamped(options.to, options.fields ?? {}, now) as Prisma.ProviderCandidateUpdateInput),
      state: options.to,
      stateReason: options.reason,
      stateChangedAt: now,
    };

    const updated = await tx.providerCandidate.update({ where: { id: candidate.id }, data });
    const delta = diffOf(
      candidate as unknown as Record<string, unknown>,
      { ...(data as Record<string, unknown>) },
    );

    await recordDealEvent(tx, {
      orgId: options.orgId,
      routeId: candidate.routeId,
      kind: `provider.${options.to.toLowerCase()}`,
      actorType: options.actorType ?? 'user',
      actorId: options.actorId,
      subjectType: 'ProviderCandidate',
      subjectId: updated.id,
      summary: `${STATE_LABELS[candidate.state]} → ${STATE_LABELS[options.to]}. ${options.reason}`,
      before: delta.before,
      after: delta.after,
      evidence: updated.capabilityEvidence ?? options.reason,
      confidence: options.to === 'COMMITTED' ? 'secured' : 'not_secured',
      correlationId: newCorrelationId(),
    });

    return { ok: true, candidate: updated };
  });
}

/**
 * Bring the explicit workstream up to date with what automatic matching found.
 *
 * Additive only. Matching can add a candidate; it can never move one backwards,
 * remove one, or undo a verification a person carried out. A catalogue refresh
 * that quietly reset three verified providers to "found" would be worse than no
 * refresh at all.
 */
export async function syncCandidatesFromMatching(options: {
  orgId: string;
  routeId: string;
}): Promise<{ added: number; existing: number }> {
  const route = await prisma.routeHypothesis.findFirst({
    where: { id: options.routeId, orgId: options.orgId },
    select: { matchedProviderIds: true, fulfilmentReason: true },
  });
  if (!route) return { added: 0, existing: 0 };

  let added = 0;
  let existing = 0;
  for (const providerId of route.matchedProviderIds) {
    const before = await prisma.providerCandidate.findUnique({
      where: { routeId_providerCompanyId: { routeId: options.routeId, providerCompanyId: providerId } },
      select: { id: true },
    });
    if (before) {
      existing += 1;
      continue;
    }
    await addCandidate({
      orgId: options.orgId,
      routeId: options.routeId,
      providerCompanyId: providerId,
      matchBasis: route.fulfilmentReason ?? 'Matched on capability and geography by automatic supply resolution.',
      actorType: 'system',
    });
    added += 1;
  }

  return { added, existing };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Whether this company is also the buyer here or on another live route.
 *
 * Surfaced, not blocked. It is sometimes exactly right — a facilities company
 * that buys from us in one city and subcontracts for us in another — and it is
 * always something a caller should know before they pick up the phone, because
 * the two conversations contradict each other if they happen blind.
 */
async function conflictFor(orgId: string, routeId: string, providerCompanyId: string): Promise<string | null> {
  const thisRoute = await prisma.routeHypothesis.findFirst({
    where: { id: routeId, orgId },
    select: { companyId: true, company: { select: { legalName: true } } },
  });
  if (thisRoute?.companyId === providerCompanyId) {
    return 'This company is the buyer on this route. Treating them as the provider for their own requirement needs a deliberate decision.';
  }

  const alsoBuyer = await prisma.routeHypothesis.count({
    where: {
      orgId,
      companyId: providerCompanyId,
      status: { notIn: ['EXPIRED', 'REJECTED'] },
    },
  });
  if (alsoBuyer > 0) {
    return `This company is the buyer on ${alsoBuyer} other live route${alsoBuyer === 1 ? '' : 's'}. Check what we are already saying to them before calling them as a provider.`;
  }
  return null;
}

/** Fills in the dated verification stamps that go with each rung. */
function stamped(to: ProviderWorkState, fields: CandidateFields, now: Date): Record<string, unknown> {
  const out: Record<string, unknown> = { ...fields };
  if (to === 'CAPABILITY_VERIFIED' && fields.capabilityEvidence) out.capabilityVerifiedAt = now;
  if (fields.credentialsEvidence) out.credentialsVerifiedAt = now;
  if (to === 'AVAILABILITY_VERIFIED') out.availabilityVerifiedAt = now;
  if (to === 'COST_RECEIVED' && fields.costAmount !== undefined && fields.costAmount !== null) {
    out.costReceivedAt = now;
  }
  return out;
}

function missingEvidence(row: ProviderCandidateRow, to: ProviderWorkState): string[] {
  const rule = EVIDENCE[to];
  if (!rule) return [];
  return rule.requires.filter((field) => {
    const value = row[field];
    if (value === null || value === undefined) return true;
    if (typeof value === 'string') return value.trim().length === 0;
    return false;
  }).map(String);
}
