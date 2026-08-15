import { Prisma } from '@prisma/client';
import type { Claim, ClaimAbout, ClaimSourceKind, ClaimStanding, EvidenceClass } from '@prisma/client';

export type { ClaimAbout, ClaimSourceKind, ClaimStanding };
import { prisma } from '@/lib/db';
import type { Evidenced } from './class';

/**
 * The claim ledger: one place that answers "how do we know that".
 *
 * The product graded evidence well and stored none of it. A route's columns
 * held the current reading — a square footage, a buying window, a fulfilment
 * status — and the grading was reconstructed at render time from side channels:
 * whether a `confirmedFields` array happened to name the key, whether a
 * `capabilityVerifiedAt` was set, whether a source URL existed. Each heuristic
 * was defensible. Together they meant the same fact was graded differently on
 * three screens, and nothing anywhere could say when a fact had been
 * established, by whom, or that a later call disagreed with it.
 *
 * This is that missing row. Every claim carries what is claimed, what standing
 * it has, where it came from, when the source said it, and what would settle
 * it. Nothing is overwritten: a newer reading supersedes an older one and both
 * stay, so the record can answer what we believed in March and what changed it.
 *
 * The part that did not exist before is disagreement. When a caller is told
 * twelve thousand square feet and the permit said forty, that is not a
 * correction — it is two sources disagreeing, and which one is right is worth a
 * phone call. Both claims are marked CONTRADICTED, each names the other,
 * neither is superseded, and the deal is blocked until somebody settles it.
 * Silently keeping the newer number would throw away the most valuable thing a
 * call ever produces.
 */

export type ClaimInput = {
  routeId: string;
  about: ClaimAbout;
  /** Stable dotted key. Rows sharing one are the same claim over time. */
  key: string;
  /** The claim in a sentence, as it will be shown. */
  statement: string;
  value?: Prisma.InputJsonValue | null;
  standing: ClaimStanding;
  sourceKind: ClaimSourceKind;
  /** Where it came from, in a phrase somebody can act on. */
  sourceLabel: string;
  /** Something reopenable: a URL, an attempt id, a person and a date. */
  sourceRef?: string | null;
  /** When the source said it, not when we wrote it down. */
  observedAt?: Date | null;
  /** Only for INFERRED. Refused elsewhere. */
  confidence?: number | null;
  /** Required for anything not CONFIRMED. */
  correctiveAction?: string | null;
  companyId?: string | null;
  contactId?: string | null;
};

/**
 * The rules a claim has to satisfy before it is written.
 *
 * Checked here as well as by the database, because a constraint violation
 * surfaces as a five-hundred and a message naming a column, and the writer
 * deserves to be told which of its arguments was wrong.
 */
export function validateClaim(input: ClaimInput): string | null {
  if (!input.key.trim()) return 'A claim needs a key.';
  if (!input.statement.trim()) return 'A claim needs a statement somebody can read.';
  if (!input.sourceLabel.trim()) return 'A claim needs to say where it came from.';

  if (input.standing !== 'CONFIRMED' && !input.correctiveAction?.trim()) {
    return `A ${input.standing.toLowerCase()} claim has to say what would settle it.`;
  }
  if (input.standing !== 'INFERRED' && input.confidence !== null && input.confidence !== undefined) {
    return 'Confidence is only meaningful on an inference.';
  }
  if (
    input.confidence !== null
    && input.confidence !== undefined
    && (input.confidence < 0 || input.confidence > 1)
  ) {
    return 'Confidence is a fraction between nought and one.';
  }
  // An unknown with a value is a guess wearing a gap's clothes.
  if (input.standing === 'UNKNOWN' && input.value !== null && input.value !== undefined) {
    return 'An unknown claim carries no value. If there is a value, it is an inference.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Record a claim, superseding the previous reading of the same key.
 *
 * Supersession rather than update: the old row stays, marked with when it
 * stopped being current and by what. A ledger that overwrites is a ledger that
 * cannot be audited, and this one exists to be audited.
 *
 * The one case that does not supersede is disagreement — see `contradict`.
 */
export async function recordClaim(params: {
  orgId: string;
  claim: ClaimInput;
  now?: Date;
}): Promise<Claim> {
  const problem = validateClaim(params.claim);
  if (problem) throw new Error(`Refusing to record a claim: ${problem}`);

  const now = params.now ?? new Date();
  const { claim } = params;

  return prisma.$transaction(async (tx) => {
    const created = await tx.claim.create({
      data: {
        orgId: params.orgId,
        routeId: claim.routeId,
        about: claim.about,
        key: claim.key,
        statement: claim.statement,
        value: claim.value ?? Prisma.JsonNull,
        standing: claim.standing,
        sourceKind: claim.sourceKind,
        sourceLabel: claim.sourceLabel,
        sourceRef: claim.sourceRef ?? null,
        observedAt: claim.observedAt ?? null,
        recordedAt: now,
        confidence: claim.confidence ?? null,
        correctiveAction: claim.correctiveAction ?? null,
        companyId: claim.companyId ?? null,
        contactId: claim.contactId ?? null,
      },
    });

    // Everything previously current on this key steps aside. Contradicted
    // claims are left alone: a disagreement is not resolved by writing a third
    // opinion over it, and quietly superseding one would hide exactly what the
    // ledger exists to surface.
    await tx.claim.updateMany({
      where: {
        routeId: claim.routeId,
        key: claim.key,
        supersededAt: null,
        standing: { not: 'CONTRADICTED' },
        id: { not: created.id },
      },
      data: { supersededAt: now, supersededById: created.id },
    });

    return created;
  });
}

/**
 * Record that a new reading disagrees with what is on the record.
 *
 * Both sides end CONTRADICTED and each names the other. Neither is superseded,
 * because superseding one would be a decision about which is right, and nothing
 * here knows that. What settles it is a person, and the corrective action says
 * so.
 *
 * Returns null when there was nothing to disagree with — in which case the
 * caller wanted `recordClaim`, and this says so rather than inventing a
 * contradiction to justify itself.
 */
export async function contradict(params: {
  orgId: string;
  /** The new reading. Its standing is forced to CONTRADICTED. */
  claim: ClaimInput;
  /** How the disagreement gets settled. */
  settleBy: string;
  now?: Date;
}): Promise<{ incoming: Claim; existing: Claim } | null> {
  const now = params.now ?? new Date();

  const existing = await prisma.claim.findFirst({
    where: {
      orgId: params.orgId,
      routeId: params.claim.routeId,
      key: params.claim.key,
      supersededAt: null,
    },
    orderBy: { recordedAt: 'desc' },
  });
  // Nothing on the record, or only a recorded gap. Disagreeing with an absence
  // is not a contradiction, it is an answer.
  if (!existing || existing.standing === 'UNKNOWN') return null;

  const problem = validateClaim({ ...params.claim, standing: 'CONTRADICTED', correctiveAction: params.settleBy });
  if (problem) throw new Error(`Refusing to record a contradiction: ${problem}`);

  return prisma.$transaction(async (tx) => {
    const incoming = await tx.claim.create({
      data: {
        orgId: params.orgId,
        routeId: params.claim.routeId,
        about: params.claim.about,
        key: params.claim.key,
        statement: params.claim.statement,
        value: params.claim.value ?? Prisma.JsonNull,
        standing: 'CONTRADICTED',
        sourceKind: params.claim.sourceKind,
        sourceLabel: params.claim.sourceLabel,
        sourceRef: params.claim.sourceRef ?? null,
        observedAt: params.claim.observedAt ?? null,
        recordedAt: now,
        confidence: null,
        correctiveAction: params.settleBy,
        companyId: params.claim.companyId ?? null,
        contactId: params.claim.contactId ?? null,
        contradictsId: existing.id,
      },
    });

    const updated = await tx.claim.update({
      where: { id: existing.id },
      data: {
        standing: 'CONTRADICTED',
        contradictsId: incoming.id,
        correctiveAction: params.settleBy,
        // Confidence is refused on a contradicted claim by constraint, and it
        // would be wrong anyway: whatever it was, it is not that now.
        confidence: null,
      },
    });

    return { incoming, existing: updated };
  });
}

/**
 * Record a claim, or a disagreement, depending on what is already there.
 *
 * The one function almost every caller wants. A new reading that matches the
 * record is a confirmation; one that differs materially is a disagreement; one
 * about something nobody has claimed is simply new.
 *
 * `sameAs` decides "materially different", and it is the writer's judgement
 * rather than a generic equality: forty thousand square feet against
 * thirty-nine thousand is agreement, and against twelve thousand is not.
 */
export async function reconcileClaim(params: {
  orgId: string;
  claim: ClaimInput;
  /** True when the incoming value agrees with the existing one. */
  sameAs?: (existing: Claim) => boolean;
  /** How a disagreement would be settled. Required to be able to record one. */
  settleBy?: string;
  now?: Date;
}): Promise<{ outcome: 'recorded' | 'contradicted'; claim: Claim }> {
  const existing = await prisma.claim.findFirst({
    where: {
      orgId: params.orgId,
      routeId: params.claim.routeId,
      key: params.claim.key,
      supersededAt: null,
    },
    orderBy: { recordedAt: 'desc' },
  });

  const disagrees =
    existing !== null
    && existing.standing !== 'UNKNOWN'
    && params.claim.standing !== 'UNKNOWN'
    && params.sameAs !== undefined
    && !params.sameAs(existing)
    && params.settleBy !== undefined;

  if (disagrees) {
    const result = await contradict({
      orgId: params.orgId,
      claim: params.claim,
      settleBy: params.settleBy as string,
      now: params.now,
    });
    if (result) return { outcome: 'contradicted', claim: result.incoming };
  }

  return { outcome: 'recorded', claim: await recordClaim({ orgId: params.orgId, claim: params.claim, now: params.now }) };
}

/**
 * Record several claims about one route in one go.
 *
 * Discovery makes half a dozen claims at once and none of them should half
 * land. Failures are returned rather than thrown, because one malformed claim
 * out of six must not lose the other five — the pipeline processes hundreds of
 * events and a throw here would end a run.
 */
export async function recordClaims(params: {
  orgId: string;
  claims: ClaimInput[];
  now?: Date;
}): Promise<{ recorded: number; refused: Array<{ key: string; because: string }> }> {
  let recorded = 0;
  const refused: Array<{ key: string; because: string }> = [];

  for (const claim of params.claims) {
    try {
      await recordClaim({ orgId: params.orgId, claim, now: params.now });
      recorded += 1;
    } catch (caught) {
      refused.push({ key: claim.key, because: caught instanceof Error ? caught.message : String(caught) });
    }
  }
  return { recorded, refused };
}

/**
 * Claims the engine makes, written without trampling what a person established.
 *
 * This is the rule that makes the ledger safe to rebuild against. The pipeline
 * runs nightly and re-derives every route from scratch; without this, a
 * caller's confirmed square footage would be overwritten by a category
 * inference every night, silently, and the product would spend a year
 * forgetting everything it learned.
 *
 * So an engine claim yields to a person on the same key. It does not contradict
 * them either — a model disagreeing with a facilities manager is not a dispute
 * worth a phone call, it is the model being out of date, and the honest record
 * is the person's. The skip is counted and reported so the run log shows how
 * much of the route is now held by people rather than by priors, which is the
 * number that says whether the product is working.
 */
export async function recordEngineClaims(params: {
  orgId: string;
  routeId: string;
  claims: ClaimInput[];
  now?: Date;
}): Promise<{ recorded: number; deferredToPeople: number; refused: Array<{ key: string; because: string }> }> {
  const held = await prisma.claim.findMany({
    where: {
      routeId: params.routeId,
      supersededAt: null,
      OR: [
        { standing: 'CONFIRMED' },
        { standing: 'CONTRADICTED' },
        // An operator's own inference outranks the engine's too. They typed it
        // knowing this record; the playbook did not.
        { sourceKind: { in: ['PERSON', 'OPERATOR'] } },
      ],
    },
    select: { key: true },
  });
  const heldKeys = new Set(held.map((c) => c.key));

  const writable = params.claims.filter((c) => !heldKeys.has(c.key));
  const result = await recordClaims({ orgId: params.orgId, claims: writable, now: params.now });

  return {
    recorded: result.recorded,
    deferredToPeople: params.claims.length - writable.length,
    refused: result.refused,
  };
}

/**
 * Claims a person establishes, with disagreement detected rather than lost.
 *
 * A person's answer supersedes an inference silently — the engine was reading a
 * permit and the person works there. A person's answer that differs from
 * *another established fact* is a disagreement: both stay, both are flagged,
 * and the deal is blocked until one call settles it.
 *
 * The asymmetry is the point. Without it, every first call would raise a
 * contradiction against the playbook's prior and the flag would mean nothing
 * within a week.
 */
export async function recordPersonClaims(params: {
  orgId: string;
  routeId: string;
  claims: ClaimInput[];
  /** True when the incoming value agrees with the established one. */
  agree: (incoming: unknown, existing: unknown) => boolean;
  now?: Date;
}): Promise<{
  recorded: number;
  contradicted: Array<{ key: string; wasSaid: string; nowSaid: string }>;
  refused: Array<{ key: string; because: string }>;
}> {
  const existing = await prisma.claim.findMany({
    where: { routeId: params.routeId, supersededAt: null },
    orderBy: { recordedAt: 'desc' },
  });
  const byKey = new Map<string, Claim>();
  for (const claim of existing) if (!byKey.has(claim.key)) byKey.set(claim.key, claim);

  let recorded = 0;
  const contradicted: Array<{ key: string; wasSaid: string; nowSaid: string }> = [];
  const refused: Array<{ key: string; because: string }> = [];

  for (const claim of params.claims) {
    const held = byKey.get(claim.key);
    // Established means a person said it or a published record states it.
    // Anything else yields quietly.
    const established =
      held !== undefined
      && held.standing === 'CONFIRMED'
      && (held.sourceKind === 'PERSON' || held.sourceKind === 'PUBLISHED_RECORD' || held.sourceKind === 'OPERATOR');

    try {
      if (established && !params.agree(claim.value ?? null, held.value)) {
        const result = await contradict({
          orgId: params.orgId,
          claim,
          settleBy:
            'Two people have given different answers to this. Ring back and establish which holds, then record '
            + 'it — nothing resting on this is safe to quote until somebody does.',
          now: params.now,
        });
        if (result) {
          contradicted.push({ key: claim.key, wasSaid: held.statement, nowSaid: claim.statement });
          continue;
        }
      }
      await recordClaim({ orgId: params.orgId, claim, now: params.now });
      recorded += 1;
    } catch (caught) {
      refused.push({ key: claim.key, because: caught instanceof Error ? caught.message : String(caught) });
    }
  }

  return { recorded, contradicted, refused };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** What is currently claimed about a route, newest first. */
export async function currentClaims(routeId: string): Promise<Claim[]> {
  return prisma.claim.findMany({
    where: { routeId, supersededAt: null },
    orderBy: [{ about: 'asc' }, { recordedAt: 'desc' }],
  });
}

/** Every reading of one key, newest first, including the ones stepped aside. */
export async function claimHistory(routeId: string, key: string): Promise<Claim[]> {
  return prisma.claim.findMany({ where: { routeId, key }, orderBy: { recordedAt: 'desc' } });
}

/** Unresolved disagreements on a route. Non-empty blocks the deal. */
export async function openContradictions(routeId: string): Promise<Claim[]> {
  return prisma.claim.findMany({
    where: { routeId, standing: 'CONTRADICTED', supersededAt: null },
    orderBy: { recordedAt: 'desc' },
  });
}

/**
 * Settle a disagreement by recording which reading holds.
 *
 * Both contradicted rows are superseded by the settling claim, so the
 * disagreement leaves the open list and stays in the history. The settling
 * claim must be CONFIRMED — an inference does not settle a disagreement
 * between two sources, it joins it.
 */
export async function settleContradiction(params: {
  orgId: string;
  routeId: string;
  key: string;
  claim: Omit<ClaimInput, 'routeId' | 'key' | 'standing'> & { standing: 'CONFIRMED' };
  now?: Date;
}): Promise<Claim> {
  const now = params.now ?? new Date();
  const input: ClaimInput = { ...params.claim, routeId: params.routeId, key: params.key, standing: 'CONFIRMED' };
  const problem = validateClaim(input);
  if (problem) throw new Error(`Refusing to settle: ${problem}`);

  return prisma.$transaction(async (tx) => {
    const settling = await tx.claim.create({
      data: {
        orgId: params.orgId,
        routeId: params.routeId,
        about: input.about,
        key: params.key,
        statement: input.statement,
        value: input.value ?? Prisma.JsonNull,
        standing: 'CONFIRMED',
        sourceKind: input.sourceKind,
        sourceLabel: input.sourceLabel,
        sourceRef: input.sourceRef ?? null,
        observedAt: input.observedAt ?? null,
        recordedAt: now,
        correctiveAction: null,
        companyId: input.companyId ?? null,
        contactId: input.contactId ?? null,
      },
    });

    await tx.claim.updateMany({
      where: { routeId: params.routeId, key: params.key, supersededAt: null, id: { not: settling.id } },
      data: { supersededAt: now, supersededById: settling.id },
    });

    return settling;
  });
}

// ---------------------------------------------------------------------------
// The bridge to presentation
// ---------------------------------------------------------------------------

/**
 * A claim, in the shape every screen in this product already grades.
 *
 * The existing `Evidenced<T>` machinery — the composition rule, the
 * suppression rule, the badges — stays exactly as it is. This maps the stored
 * claim onto it so a ledger row and an on-the-fly grading render identically,
 * which is the whole reason the ledger is worth having: one grader, one look,
 * whatever the source.
 *
 * A contradicted claim is deliberately mapped to UNKNOWN rather than to a
 * weaker class. Two sources disagreeing about a square footage does not mean we
 * roughly know it — it means we do not know it, and showing an average of the
 * two would be the worst answer available.
 */
export function claimToEvidenced<T = unknown>(claim: Claim): Evidenced<T> {
  const evidence: EvidenceClass =
    claim.standing === 'CONTRADICTED' || claim.standing === 'UNKNOWN'
      ? 'UNKNOWN'
      : claim.standing === 'INFERRED'
        ? 'INFERRED'
        : claim.sourceKind === 'PERSON' || claim.sourceKind === 'OPERATOR'
          ? 'CONFIRMED_BY_PERSON'
          : claim.sourceKind === 'CALCULATION'
            ? 'CALCULATED_FROM_CONFIRMED_INPUTS'
            : 'EXTERNALLY_OBSERVED';

  const age = claim.observedAt ? ` Observed ${claim.observedAt.toISOString().slice(0, 10)}.` : '';

  return {
    value: claim.standing === 'CONTRADICTED' || claim.standing === 'UNKNOWN' ? null : (claim.value as T | null),
    evidence,
    source:
      claim.standing === 'CONTRADICTED'
        ? `Two sources disagree about this. ${claim.sourceLabel}${age}`
        : `${claim.sourceLabel}${age}`,
    toConfirm: claim.correctiveAction,
  };
}

/** How a standing reads on screen. */
export const STANDING_LABEL: Record<ClaimStanding, string> = {
  CONFIRMED: 'confirmed',
  INFERRED: 'our inference',
  UNKNOWN: 'not known',
  CONTRADICTED: 'sources disagree',
};

/** Where a claim came from, in words rather than an enum. */
export const SOURCE_KIND_LABEL: Record<ClaimSourceKind, string> = {
  PERSON: 'a named person said so',
  PUBLISHED_RECORD: 'a published record',
  CALCULATION: 'worked out from other claims',
  ENGINE_INFERENCE: 'concluded by a playbook',
  OPERATOR: 'entered by the owner',
  ABSENCE: 'recorded as missing',
};

/**
 * How much of what a deal needs is actually established.
 *
 * Not a score. A count, with the gaps named, because "sixty-two per cent
 * complete" is the kind of figure this product spent a fortnight removing.
 */
export function ledgerSummary(claims: Claim[]): {
  confirmed: number;
  inferred: number;
  unknown: number;
  contradicted: number;
  /** The claims a person has to act on, strongest problem first. */
  needsAction: Claim[];
  sentence: string;
} {
  const current = claims.filter((c) => c.supersededAt === null);
  const by = (s: ClaimStanding) => current.filter((c) => c.standing === s);
  const contradicted = by('CONTRADICTED');
  const unknown = by('UNKNOWN');
  const inferred = by('INFERRED');
  const confirmed = by('CONFIRMED');

  return {
    confirmed: confirmed.length,
    inferred: inferred.length,
    unknown: unknown.length,
    contradicted: contradicted.length,
    // Disagreements first: an unresolved contradiction makes everything
    // downstream of it untrustworthy, and it is settled by one call.
    needsAction: [...contradicted, ...unknown, ...inferred],
    sentence:
      current.length === 0
        ? 'Nothing has been claimed about this deal yet.'
        : contradicted.length > 0
          ? `${contradicted.length} claim(s) about this deal are disputed by two sources, and until that is `
            + 'settled anything resting on them is unsafe to act on.'
          : `${confirmed.length} of ${current.length} claim(s) are established. `
            + `${inferred.length} rest on our inference and ${unknown.length} are open questions.`,
  };
}
