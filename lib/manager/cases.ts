import type { CaseState, ConsistencyCase, FaultAttribution } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getOrgConfig } from '@/lib/config';
import { audit } from '@/lib/audit';
import { attribute, type BreakerSignal, type IncidentSignal } from './attribution';
import {
  attemptOutsideCallingHours,
  attemptWithoutEvidence,
  dispositionContradictsTranscript,
  duplicateAttempt,
  factsRecordedWithoutContact,
  followUpPromiseMissed,
  promiseNotScheduled,
  qualifiedWithoutFacts,
  type AttemptRecord,
  type Finding,
} from './consistency';
import { PRODUCED_BY, RULE_VERSION } from './rules';

/**
 * The sweep: find mismatches, ask whose they are, write the ones worth asking
 * about.
 *
 * The order inside `openCase` is the important part. Attribution runs first,
 * always, on every finding — before the case is written, not after somebody
 * has read it. A case that turns out to be an outage is still written, because
 * a silent one teaches nobody anything, but it is written against the system
 * with the caller's id absent and the state already SYSTEM_FAULT. Nobody is
 * ever asked to explain our downtime.
 */

/** How far back a sweep looks by default. */
const LOOKBACK_DAYS = 7;

export type SweepResult = {
  examined: number;
  opened: number;
  /** Cases the sweep wrote against the system rather than against anybody. */
  attributedToSystem: number;
  /** Findings that already had a case. */
  alreadyOpen: number;
  byKind: Record<string, number>;
};

export async function sweepConsistency(params: {
  orgId: string;
  now?: Date;
  lookbackDays?: number;
}): Promise<SweepResult> {
  const now = params.now ?? new Date();
  const since = new Date(now.getTime() - (params.lookbackDays ?? LOOKBACK_DAYS) * 86_400_000);
  const config = await getOrgConfig(params.orgId);

  const [attempts, states, incidents, breakers] = await Promise.all([
    prisma.outreachAttempt.findMany({
      where: { orgId: params.orgId, occurredAt: { gte: since } },
      orderBy: { occurredAt: 'asc' },
      select: {
        id: true, routeId: true, userId: true, disposition: true, notes: true,
        discovery: true, occurredAt: true,
        callSession: {
          select: {
            id: true,
            transcript: { select: { speakerSeparated: true, state: true } },
            insights: {
              where: { kind: 'DISPOSITION_SUGGESTION' },
              select: { value: true },
              take: 1,
            },
          },
        },
        route: {
          select: {
            company: {
              select: {
                legalName: true,
                operatingName: true,
                // The calling-hours rule is about the buyer's clock, not ours.
                contacts: { select: { timezone: true }, take: 1, orderBy: { createdAt: 'asc' } },
              },
            },
          },
        },
      },
    }),
    prisma.outreachState.findMany({
      where: { orgId: params.orgId, updatedAt: { gte: since } },
      select: {
        routeId: true, status: true, snoozeUntil: true, lastAttemptAt: true, updatedAt: true,
        confirmedNeed: true, confirmedTiming: true, budgetNote: true,
        route: {
          select: {
            company: { select: { legalName: true, operatingName: true } },
            requirements: { where: { state: 'CURRENT' }, select: { id: true }, take: 1 },
          },
        },
      },
    }),
    prisma.workIncident.findMany({
      where: { orgId: params.orgId, createdAt: { gte: new Date(since.getTime() - 86_400_000) } },
      select: { id: true, kind: true, createdAt: true, resolvedAt: true, callerId: true, routeId: true, detail: true },
    }),
    prisma.circuitBreaker.findMany({
      where: { orgId: params.orgId, openedAt: { not: null } },
      select: { id: true, capability: true, openedAt: true, closedAt: true, openedBecause: true },
    }),
  ]);

  const findings: Finding[] = [];
  const previousOnRoute = new Map<string, { id: string; occurredAt: Date; disposition: AttemptRecord['disposition'] }>();
  const stateByRoute = new Map(states.map((s) => [s.routeId, s]));
  /** Who last worked each route, for the findings that are about a route. */
  const lastCallerOnRoute = new Map<string, string>();

  for (const row of attempts) {
    const record: AttemptRecord = {
      id: row.id,
      routeId: row.routeId,
      userId: row.userId,
      disposition: row.disposition,
      notes: row.notes,
      discovery: (row.discovery ?? {}) as Record<string, unknown>,
      occurredAt: row.occurredAt,
      sessionId: row.callSession?.id ?? null,
      transcript: row.callSession && row.callSession.transcript?.state === 'READY'
        ? {
            sessionId: row.callSession.id,
            suggestedDisposition: row.callSession.insights[0]?.value ?? null,
            speakerSeparated: row.callSession.transcript.speakerSeparated,
          }
        : null,
      timezone: row.route.company.contacts[0]?.timezone,
      companyName: row.route.company.operatingName ?? row.route.company.legalName,
    };

    const state = stateByRoute.get(row.routeId);
    for (const finding of [
      attemptWithoutEvidence(record),
      promiseNotScheduled(record, state ? { snoozeUntil: state.snoozeUntil } : null),
      dispositionContradictsTranscript(record),
      duplicateAttempt(record, previousOnRoute.get(row.routeId) ?? null),
      attemptOutsideCallingHours(record, config),
      factsRecordedWithoutContact(record),
    ]) {
      if (finding) findings.push(finding);
    }

    previousOnRoute.set(row.routeId, {
      id: row.id, occurredAt: row.occurredAt, disposition: row.disposition,
    });
    if (row.userId) lastCallerOnRoute.set(row.routeId, row.userId);
  }

  for (const state of states) {
    // Whoever last worked the route is who the question is for. Null when
    // nobody in the window did, which is itself the answer: a route that
    // qualified itself is ours to explain, not anybody's to account for.
    const lastWorkedBy = lastCallerOnRoute.get(state.routeId) ?? null;

    const qualified = qualifiedWithoutFacts({
      routeId: state.routeId,
      callerId: lastWorkedBy,
      status: state.status,
      confirmedNeed: state.confirmedNeed,
      confirmedTiming: state.confirmedTiming,
      budgetNote: state.budgetNote,
      hasRequirement: state.route.requirements.length > 0,
      at: state.updatedAt,
      companyName: state.route.company.operatingName ?? state.route.company.legalName,
    });
    if (qualified) findings.push(qualified);

    if (state.snoozeUntil && state.snoozeUntil <= now) {
      const missed = followUpPromiseMissed({
        routeId: state.routeId,
        callerId: lastWorkedBy,
        dueAt: state.snoozeUntil,
        now,
        lastAttemptAt: state.lastAttemptAt,
        companyName: state.route.company.operatingName ?? state.route.company.legalName,
      });
      if (missed) findings.push(missed);
    }
  }

  const result: SweepResult = {
    examined: attempts.length + states.length,
    opened: 0,
    attributedToSystem: 0,
    alreadyOpen: 0,
    byKind: {},
  };

  for (const finding of findings) {
    const outcome = await openCase({
      orgId: params.orgId,
      finding,
      incidents: incidents as IncidentSignal[],
      breakers: breakers as BreakerSignal[],
    });
    if (outcome.created) {
      result.opened += 1;
      result.byKind[finding.kind] = (result.byKind[finding.kind] ?? 0) + 1;
      if (outcome.attribution === 'SYSTEM_FAULT') result.attributedToSystem += 1;
    } else {
      result.alreadyOpen += 1;
    }
  }

  return result;
}

/**
 * Write one case, having first established whether it is ours.
 *
 * Idempotent on `(orgId, kind, dedupeKey)`. A sweep that runs twice — because
 * the cron retried, or somebody pressed the button — must not put the same
 * question to somebody twice.
 */
export async function openCase(params: {
  orgId: string;
  finding: Finding;
  incidents?: IncidentSignal[];
  breakers?: BreakerSignal[];
}): Promise<{ created: boolean; case: ConsistencyCase; attribution: FaultAttribution }> {
  const { finding } = params;

  const existing = await prisma.consistencyCase.findUnique({
    where: {
      orgId_kind_dedupeKey: {
        orgId: params.orgId, kind: finding.kind, dedupeKey: finding.dedupeKey,
      },
    },
  });
  if (existing) return { created: false, case: existing, attribution: existing.attribution };

  // Before anything about the person. Always.
  const verdict = attribute({
    at: finding.at,
    callerId: finding.callerId,
    routeId: finding.routeId,
    capability: finding.capability,
    incidents: params.incidents,
    breakers: params.breakers,
  });

  const isOurs = verdict.attribution === 'SYSTEM_FAULT';

  const created = await prisma.consistencyCase.create({
    data: {
      orgId: params.orgId,
      // The one line that matters: when it was our failure, the case does not
      // carry a person's name. It is not "attributed elsewhere" — it is not
      // about them, so their id is not on it.
      callerId: isOurs ? null : finding.callerId,
      routeId: finding.routeId,
      attemptId: finding.attemptId,
      sessionId: finding.sessionId,
      kind: finding.kind,
      dedupeKey: finding.dedupeKey,
      // Resolved at birth when it is ours. Nobody is asked to explain it, and
      // it does not sit in a queue looking like an open question about them.
      state: isOurs ? 'SYSTEM_FAULT' : 'OPEN',
      observed: finding.observed,
      expected: finding.expected,
      evidence: [...finding.evidence, ...verdict.evidence] as object,
      benignAlternatives: finding.benignAlternatives as object,
      attribution: verdict.attribution,
      producedBy: PRODUCED_BY,
      ruleVersion: RULE_VERSION,
      confidence: finding.confidence,
      question: isOurs ? null : finding.question,
      ...(isOurs
        ? { resolvedAt: new Date(), resolution: verdict.because }
        : {}),
    },
  });

  return { created: true, case: created, attribution: verdict.attribution };
}

/** The question actually being put to somebody. */
export async function askCase(params: {
  orgId: string;
  caseId: string;
  now?: Date;
}): Promise<{ ok: boolean; message?: string }> {
  const row = await prisma.consistencyCase.findFirst({
    where: { id: params.caseId, orgId: params.orgId },
  });
  if (!row) return { ok: false, message: 'That case is not on this account.' };
  if (row.state !== 'OPEN') return { ok: false, message: 'That case is closed.' };
  if (!row.question) return { ok: false, message: 'There is no question on that case to ask.' };
  if (!row.callerId) return { ok: false, message: 'That case is not about a person, so there is nobody to ask.' };

  await prisma.consistencyCase.update({
    where: { id: row.id },
    data: { askedAt: params.now ?? new Date() },
  });
  return { ok: true };
}

/** The caller's own answer, in their words, recorded before anybody judges it. */
export async function answerCase(params: {
  orgId: string;
  caseId: string;
  callerId: string;
  answer: string;
  now?: Date;
}): Promise<{ ok: boolean; message?: string }> {
  const now = params.now ?? new Date();
  const row = await prisma.consistencyCase.findFirst({
    where: { id: params.caseId, orgId: params.orgId, callerId: params.callerId },
  });
  if (!row) return { ok: false, message: 'That case is not one of yours.' };
  if (row.state !== 'OPEN') return { ok: false, message: 'That case is closed.' };

  // The constraint requires a question and a time; a case answered before it
  // was formally asked is normal (the caller saw it on their screen), so the
  // ask is backfilled rather than refused.
  await prisma.consistencyCase.update({
    where: { id: row.id },
    data: {
      question: row.question ?? 'Asked on the caller\'s own screen.',
      askedAt: row.askedAt ?? now,
      answer: params.answer.slice(0, 4000),
      answeredAt: now,
    },
  });
  return { ok: true };
}

/**
 * A person closing a case.
 *
 * `OPERATOR` can only arrive here — through somebody who has read the evidence,
 * the benign alternatives and, where there is one, the caller's own answer. No
 * rule in this codebase can reach that value on its own.
 */
export async function resolveCase(params: {
  orgId: string;
  caseId: string;
  resolvedById: string;
  state: Exclude<CaseState, 'OPEN'>;
  resolution: string;
  attribution?: FaultAttribution;
}): Promise<{ ok: boolean; message?: string }> {
  const row = await prisma.consistencyCase.findFirst({
    where: { id: params.caseId, orgId: params.orgId },
  });
  if (!row) return { ok: false, message: 'That case is not on this account.' };
  if (row.state !== 'OPEN') return { ok: false, message: 'That case is already closed.' };
  if (!params.resolution.trim()) return { ok: false, message: 'Say what you concluded, in a sentence.' };

  const attribution: FaultAttribution = params.attribution
    ?? (params.state === 'CONFIRMED' ? 'OPERATOR'
      : params.state === 'SYSTEM_FAULT' ? 'SYSTEM_FAULT'
        : 'UNDETERMINED');

  await prisma.consistencyCase.update({
    where: { id: row.id },
    data: {
      state: params.state,
      attribution,
      // Ours, so it stops being about them the moment somebody says so.
      callerId: attribution === 'SYSTEM_FAULT' ? null : row.callerId,
      resolvedById: params.resolvedById,
      resolvedAt: new Date(),
      resolution: params.resolution.slice(0, 2000),
    },
  });

  await audit({
    orgId: params.orgId,
    userId: params.resolvedById,
    action: 'manager.case_resolved',
    entityType: 'ConsistencyCase',
    entityId: row.id,
    metadata: { state: params.state, attribution },
  });

  return { ok: true };
}

/** Cases about one person that a human has confirmed. The only ones that count. */
export async function confirmedCasesFor(params: {
  orgId: string;
  callerId: string;
  since?: Date;
}): Promise<number> {
  return prisma.consistencyCase.count({
    where: {
      orgId: params.orgId,
      callerId: params.callerId,
      state: 'CONFIRMED',
      attribution: 'OPERATOR',
      ...(params.since ? { resolvedAt: { gte: params.since } } : {}),
    },
  });
}
