import type { Intervention, InterventionRung, WorkCapability } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getOrgConfig } from '@/lib/config';
import { audit } from '@/lib/audit';
import { recommend, RESTORATION, type Recommendation } from './ladder';
import { CAPABILITY_LABELS, evidenceRef, needsOwnerAuthority, PRODUCED_BY, restrictsWork, RULE_VERSION, RUNG_LABELS, type EvidenceRef } from './rules';

/**
 * Applying, enforcing, lifting.
 *
 * The default state of everything written here is SHADOW: decided, recorded,
 * visible on the manager screen, and without effect on anybody's day. That is
 * not timidity — it is the only way to find out whether these rules are right
 * before they cost somebody work. A rule that has never been checked against
 * real calls has no business restricting a real person, and the way to check it
 * is to let it run silently and read what it would have done.
 *
 * Moving out of shadow takes two separate things: the rung has to be enabled in
 * the account's operating rules, and — for the two rungs that touch a person's
 * standing rather than their workflow — an owner has to press the button. The
 * second is not configurable.
 */

export type ApplyResult = {
  applied: boolean;
  intervention: Intervention | null;
  recommendation: Recommendation;
  /** Said plainly, including when the answer is "nothing happens". */
  message: string;
};

/**
 * Decide and record what should follow from a confirmed case.
 *
 * Called after a person has resolved a case as CONFIRMED. Never called by the
 * sweep: a rule may not promote its own observation into a sanction.
 */
export async function applyForCase(params: {
  orgId: string;
  caseId: string;
  /** Set when a person is deliberately overriding the recommended rung. */
  overrideRung?: InterventionRung;
  actorId?: string;
  now?: Date;
}): Promise<ApplyResult> {
  const now = params.now ?? new Date();
  const config = await getOrgConfig(params.orgId);

  const row = await prisma.consistencyCase.findFirst({
    where: { id: params.caseId, orgId: params.orgId },
  });
  if (!row) {
    return {
      applied: false,
      intervention: null,
      recommendation: nothing('That case is not on this account.'),
      message: 'That case is not on this account.',
    };
  }

  if (row.state !== 'CONFIRMED' || row.attribution !== 'OPERATOR' || !row.callerId) {
    return {
      applied: false,
      intervention: null,
      recommendation: nothing('Nothing follows from a case that has not been confirmed against a person.'),
      message: 'Nothing follows from this case. Only a case a person has confirmed produces an intervention, and this one has not been.',
    };
  }

  const since = new Date(now.getTime() - 90 * 86_400_000);
  const [priorConfirmed, priorInterventions, attempts] = await Promise.all([
    prisma.consistencyCase.count({
      where: {
        orgId: params.orgId, callerId: row.callerId, kind: row.kind,
        state: 'CONFIRMED', attribution: 'OPERATOR',
        resolvedAt: { gte: since }, id: { not: row.id },
      },
    }),
    prisma.intervention.findMany({
      where: {
        orgId: params.orgId, callerId: row.callerId,
        createdAt: { gte: since },
        state: { in: ['ACTIVE', 'LIFTED', 'SHADOW', 'PROPOSED'] },
        case: { kind: row.kind },
      },
      select: { rung: true },
    }),
    prisma.outreachAttempt.count({
      where: { orgId: params.orgId, userId: row.callerId, occurredAt: { gte: since } },
    }),
  ]);

  const recommendation = recommend({
    kind: row.kind,
    attribution: row.attribution,
    priorConfirmed,
    priorRungs: priorInterventions.map((i) => i.rung),
    attempts,
    rules: config.managerRules,
  });

  const rung = params.overrideRung ?? recommendation.rung;
  if (!rung) {
    return {
      applied: false,
      intervention: null,
      recommendation,
      message: recommendation.reason,
    };
  }

  const restricting = restrictsWork(rung);
  const capability = recommendation.capability ?? (restricting ? capabilityFallback(row.kind) : null);
  const ownerOnly = needsOwnerAuthority(rung);
  const enforceable = params.overrideRung
    // A person choosing the rung themselves still cannot enforce an owner-only
    // one from here; that takes the owner's own action on the row.
    ? !ownerOnly && config.managerRules.enforceableRungs.includes(rung)
    : recommendation.enforce;

  const evidence: EvidenceRef[] = [
    evidenceRef('the case', `ConsistencyCase:${row.id}`, row.createdAt),
    ...(Array.isArray(row.evidence) ? (row.evidence as EvidenceRef[]) : []),
  ];

  // Restricting rungs never go live on the strength of a rule alone, whatever
  // the flags say. A pause is proposed and waits for a person.
  const state = restricting || ownerOnly ? 'PROPOSED' : enforceable ? 'ACTIVE' : 'SHADOW';
  const shadow = state !== 'ACTIVE';

  const intervention = await prisma.intervention.create({
    data: {
      orgId: params.orgId,
      callerId: row.callerId,
      routeId: row.routeId,
      caseId: row.id,
      rung,
      state,
      capability,
      reason: params.overrideRung
        ? `${RUNG_LABELS[rung]}, chosen by a person rather than by the rules. ${recommendation.reason}`
        : recommendation.reason,
      evidence: evidence as object,
      attribution: 'OPERATOR',
      restorationRule: restricting ? (capability ? RESTORATION[capability] : null) : null,
      producedBy: PRODUCED_BY,
      ruleVersion: RULE_VERSION,
      confidence: row.confidence,
      shadow,
      enforcedAt: state === 'ACTIVE' ? now : null,
    },
  });

  if (params.actorId) {
    await audit({
      orgId: params.orgId,
      userId: params.actorId,
      action: 'manager.intervention_recorded',
      entityType: 'Intervention',
      entityId: intervention.id,
      metadata: { rung, state, shadow, caseId: row.id },
    });
  }

  return {
    applied: true,
    intervention,
    recommendation,
    message: state === 'ACTIVE'
      ? `${RUNG_LABELS[rung]} applied.`
      : state === 'PROPOSED'
        ? `${RUNG_LABELS[rung]} proposed. It does nothing until somebody with the authority applies it.`
        : `${RUNG_LABELS[rung]} recorded in shadow. ${recommendation.enforcementNote}`,
  };
}

/**
 * A person turning a proposal on.
 *
 * `authority` is passed by the route after it has checked a permission, so the
 * library cannot be talked into enforcing an owner-only rung by a caller who
 * found the function.
 */
export async function enforceIntervention(params: {
  orgId: string;
  interventionId: string;
  actorId: string;
  authority: 'owner' | 'manager';
  note?: string;
  now?: Date;
}): Promise<{ ok: boolean; message: string }> {
  const now = params.now ?? new Date();
  const row = await prisma.intervention.findFirst({
    where: { id: params.interventionId, orgId: params.orgId },
  });
  if (!row) return { ok: false, message: 'That intervention is not on this account.' };
  if (row.state === 'ACTIVE') return { ok: false, message: 'That is already in force.' };
  if (row.state !== 'PROPOSED' && row.state !== 'SHADOW') {
    return { ok: false, message: `That intervention is ${row.state.toLowerCase()} and cannot be turned on.` };
  }
  if (needsOwnerAuthority(row.rung) && params.authority !== 'owner') {
    return { ok: false, message: `${RUNG_LABELS[row.rung]} is the owner's decision. A manager cannot apply it.` };
  }
  if (restrictsWork(row.rung) && !row.restorationRule) {
    // Belt and braces: the constraint refuses this too, and the message here is
    // the one a person can act on.
    return { ok: false, message: 'That restriction has no restoration conditions on it, so it cannot be applied.' };
  }

  // One live restriction per capability per person. The partial unique index
  // enforces it; this turns the violation into a sentence.
  if (row.capability && row.callerId) {
    const existing = await prisma.intervention.findFirst({
      where: {
        orgId: params.orgId, callerId: row.callerId, capability: row.capability,
        state: 'ACTIVE', shadow: false, id: { not: row.id },
      },
    });
    if (existing) {
      return {
        ok: false,
        message: `${CAPABILITY_LABELS[row.capability]} is already restricted for this person. Lift the existing one first, or nobody will be able to tell which restriction is the live one.`,
      };
    }
  }

  await prisma.intervention.update({
    where: { id: row.id },
    data: {
      state: 'ACTIVE',
      shadow: false,
      enforcedAt: now,
      reason: params.note?.trim() ? `${row.reason} Applied by a person: ${params.note.trim()}` : row.reason,
    },
  });

  await audit({
    orgId: params.orgId, userId: params.actorId, action: 'manager.intervention_enforced',
    entityType: 'Intervention', entityId: row.id,
    metadata: { rung: row.rung, capability: row.capability },
  });

  return { ok: true, message: `${RUNG_LABELS[row.rung]} is in force.` };
}

/**
 * Lifting, on evidence.
 *
 * Requires a sentence and at least one record. "They seem better" is not a
 * restoration condition and it is not accepted here — partly because a
 * restriction lifted on a feeling can be reapplied on a feeling, and mostly
 * because the person it was on deserves to be able to point at the thing that
 * ended it.
 */
export async function liftIntervention(params: {
  orgId: string;
  interventionId: string;
  actorId: string;
  because: string;
  evidence?: EvidenceRef[];
  now?: Date;
}): Promise<{ ok: boolean; message: string }> {
  const now = params.now ?? new Date();
  const row = await prisma.intervention.findFirst({
    where: { id: params.interventionId, orgId: params.orgId },
  });
  if (!row) return { ok: false, message: 'That intervention is not on this account.' };
  if (row.state !== 'ACTIVE' && row.state !== 'PROPOSED') {
    return { ok: false, message: `That intervention is ${row.state.toLowerCase()} already.` };
  }
  if (!params.because.trim()) {
    return { ok: false, message: 'Say what changed. A restriction that ends without a reason on the record cannot be argued with later, in either direction.' };
  }
  if (restrictsWork(row.rung) && (params.evidence ?? []).length === 0) {
    return {
      ok: false,
      message: `Point at the work that satisfies the restoration conditions: "${row.restorationRule}"`,
    };
  }

  await prisma.intervention.update({
    where: { id: row.id },
    data: {
      state: 'LIFTED',
      liftedAt: now,
      liftedById: params.actorId,
      liftedBecause: params.because.slice(0, 2000),
      restorationEvidence: (params.evidence ?? []) as object,
    },
  });

  await audit({
    orgId: params.orgId, userId: params.actorId, action: 'manager.intervention_lifted',
    entityType: 'Intervention', entityId: row.id,
    metadata: { rung: row.rung, capability: row.capability },
  });

  return { ok: true, message: 'Lifted, with the evidence recorded against it.' };
}

/** A person saying the machine got it wrong. Kept, not deleted. */
export async function overrideIntervention(params: {
  orgId: string;
  interventionId: string;
  actorId: string;
  reason: string;
  /** True when the intervention should never have existed. */
  withdraw?: boolean;
  now?: Date;
}): Promise<{ ok: boolean; message: string }> {
  const row = await prisma.intervention.findFirst({
    where: { id: params.interventionId, orgId: params.orgId },
  });
  if (!row) return { ok: false, message: 'That intervention is not on this account.' };
  if (!params.reason.trim()) return { ok: false, message: 'Say why. The override rate is how anybody finds out whether these rules are worth running.' };

  await prisma.intervention.update({
    where: { id: row.id },
    data: {
      state: params.withdraw ? 'WITHDRAWN' : row.state === 'PROPOSED' ? 'DECLINED' : row.state,
      shadow: params.withdraw ? row.shadow : row.shadow,
      overriddenById: params.actorId,
      overriddenAt: params.now ?? new Date(),
      overrideReason: params.reason.slice(0, 2000),
    },
  });

  await audit({
    orgId: params.orgId, userId: params.actorId, action: 'manager.intervention_overridden',
    entityType: 'Intervention', entityId: row.id,
    metadata: { rung: row.rung, withdrawn: Boolean(params.withdraw) },
  });

  return { ok: true, message: params.withdraw ? 'Withdrawn, and recorded as wrong.' : 'Declined, with your reason on the record.' };
}

/** What happened afterwards, so the ladder itself can be judged. */
export async function recordOutcome(params: {
  orgId: string;
  interventionId: string;
  outcome: string;
}): Promise<void> {
  await prisma.intervention.updateMany({
    where: { id: params.interventionId, orgId: params.orgId },
    data: { outcome: params.outcome.slice(0, 2000) },
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type Restriction = {
  id: string;
  rung: InterventionRung;
  capability: WorkCapability;
  reason: string;
  restorationRule: string;
  since: Date;
};

/** Live restrictions on one person. Shadow rows are not restrictions. */
export async function activeRestrictions(params: {
  orgId: string;
  callerId: string;
}): Promise<Restriction[]> {
  const rows = await prisma.intervention.findMany({
    where: {
      orgId: params.orgId, callerId: params.callerId,
      state: 'ACTIVE', shadow: false, capability: { not: null },
    },
    orderBy: { enforcedAt: 'desc' },
  });

  return rows.map((row) => ({
    id: row.id,
    rung: row.rung,
    capability: row.capability!,
    reason: row.reason,
    restorationRule: row.restorationRule ?? '',
    since: row.enforcedAt ?? row.createdAt,
  }));
}

function capabilityFallback(kind: string): WorkCapability {
  return kind.includes('QUALIFIED') || kind.includes('FACTS') ? 'REQUIREMENT_CAPTURE' : 'CALL_PLACING';
}

function nothing(reason: string): Recommendation {
  return {
    rung: null, capability: null, reason,
    restorationRule: null, enforce: false, enforcementNote: reason, ownerOnly: false,
  };
}
