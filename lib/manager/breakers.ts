import type { CircuitBreaker, WorkCapability } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getOrgConfig, type OrgConfig } from '@/lib/config';
import { audit } from '@/lib/audit';
import { CAPABILITY_LABELS, evidenceRef, PRODUCED_BY, RULE_VERSION, type EvidenceRef } from './rules';

/**
 * Stopping a capability that is failing, before it fails on somebody.
 *
 * A breaker belongs to the system and to nobody else. That separation is the
 * whole reason it is a different table from an intervention: when the dialer is
 * down, the correct response is to stop handing people work that cannot
 * succeed and to say so loudly — not to notice, three days later, that a caller
 * "attempted" forty opportunities and completed none.
 *
 * A tripped breaker also feeds attribution. Every consistency finding checks
 * whether the capability it needed was stopped at the time, so an outage cannot
 * later be read as somebody's poor week.
 */

export type BreakerReading = {
  capability: WorkCapability;
  observed: number;
  failed: number;
  rate: number | null;
  /** Why this reading is or is not enough to act on. */
  verdict: string;
  shouldOpen: boolean;
  evidence: EvidenceRef[];
};

export type BreakerStatus = {
  capability: WorkCapability;
  open: boolean;
  /** True when the cooldown has passed and one attempt may go through. */
  probeAllowed: boolean;
  because: string | null;
  since: Date | null;
  id: string | null;
};

/**
 * Read the health of every capability we can measure.
 *
 * Capabilities with no measurable failure signal are absent rather than
 * reported healthy. "We are not watching this" and "this is fine" are different
 * statements and only one of them is true.
 */
export async function readHealth(params: {
  orgId: string;
  now?: Date;
  config?: OrgConfig;
}): Promise<BreakerReading[]> {
  const now = params.now ?? new Date();
  const config = params.config ?? await getOrgConfig(params.orgId);
  const rules = config.managerRules;
  const since = new Date(now.getTime() - rules.breakerWindowMinutes * 60_000);

  const [attempts, saveFailures, integrationFailures, sessions, recordingFailures, messages, messageFailures] =
    await Promise.all([
      prisma.outreachAttempt.count({ where: { orgId: params.orgId, occurredAt: { gte: since } } }),
      prisma.workIncident.count({
        where: { orgId: params.orgId, kind: 'SAVE_FAILURE', createdAt: { gte: since } },
      }),
      prisma.workIncident.count({
        where: { orgId: params.orgId, kind: 'INTEGRATION_FAILURE', createdAt: { gte: since } },
      }),
      prisma.callSession.count({
        where: { orgId: params.orgId, startedAt: { gte: since }, captureMode: { not: 'NONE' } },
      }),
      prisma.callSession.count({
        where: {
          orgId: params.orgId, startedAt: { gte: since }, captureMode: { not: 'NONE' },
          recordingState: 'FAILED',
        },
      }),
      prisma.message.count({
        where: { orgId: params.orgId, direction: 'outbound', createdAt: { gte: since }, status: { in: ['SENT', 'FAILED'] } },
      }),
      prisma.message.count({
        where: { orgId: params.orgId, direction: 'outbound', createdAt: { gte: since }, status: 'FAILED' },
      }),
    ]);

  return [
    reading('CALL_PLACING', attempts + saveFailures, saveFailures, rules, [
      evidenceRef('attempts in the window', `OutreachAttempt:count=${attempts}`, now),
      evidenceRef('save failures in the window', `WorkIncident:SAVE_FAILURE=${saveFailures}`, now),
    ]),
    reading('CALL_RECORDING', sessions, recordingFailures + integrationFailures, rules, [
      evidenceRef('capture attempts in the window', `CallSession:count=${sessions}`, now),
      evidenceRef('captures that produced nothing', `CallSession:FAILED=${recordingFailures}`, now),
      evidenceRef('integration failures in the window', `WorkIncident:INTEGRATION_FAILURE=${integrationFailures}`, now),
    ]),
    reading('DEAL_ROOM_SENDING', messages, messageFailures, rules, [
      evidenceRef('outbound messages in the window', `Message:count=${messages}`, now),
      evidenceRef('sends that failed', `Message:FAILED=${messageFailures}`, now),
    ]),
  ];
}

function reading(
  capability: WorkCapability,
  observed: number,
  failed: number,
  rules: OrgConfig['managerRules'],
  evidence: EvidenceRef[],
): BreakerReading {
  // The count can exceed the denominator when failures are counted from a
  // different table than the successes. Clamped, because a rate above one is
  // meaningless and the constraint on the table refuses it anyway.
  const failures = Math.min(failed, observed);
  const rate = observed > 0 ? failures / observed : null;

  if (observed < rules.breakerMinimumObservations) {
    return {
      capability, observed, failed: failures, rate,
      verdict: `${observed} observation(s) in the window, below the floor of ${rules.breakerMinimumObservations}. Two failures out of three is not an outage, it is a Tuesday.`,
      shouldOpen: false,
      evidence,
    };
  }

  if (rate !== null && rate >= rules.breakerFailureRate) {
    return {
      capability, observed, failed: failures, rate,
      verdict: `${failures} of ${observed} failed (${Math.round(rate * 100)}%), at or above the ${Math.round(rules.breakerFailureRate * 100)}% threshold. ${CAPABILITY_LABELS[capability]} is not working.`,
      shouldOpen: true,
      evidence,
    };
  }

  return {
    capability, observed, failed: failures, rate,
    verdict: `${failures} of ${observed} failed (${rate === null ? 'no rate' : `${Math.round(rate * 100)}%`}). Working.`,
    shouldOpen: false,
    evidence,
  };
}

/**
 * Trip and reset breakers from the current readings.
 *
 * Tripping is automatic; closing is not. A breaker that closed itself the
 * moment the rate dipped would flap, and each flap hands somebody work that
 * fails again. It closes when the readings are healthy *and* the retry window
 * has passed, which is the cheapest form of hysteresis that is still honest.
 */
export async function evaluateBreakers(params: {
  orgId: string;
  now?: Date;
}): Promise<{ opened: WorkCapability[]; closed: WorkCapability[]; readings: BreakerReading[] }> {
  const now = params.now ?? new Date();
  const config = await getOrgConfig(params.orgId);
  const readings = await readHealth({ orgId: params.orgId, now, config });

  const opened: WorkCapability[] = [];
  const closed: WorkCapability[] = [];

  for (const reading of readings) {
    const live = await prisma.circuitBreaker.findFirst({
      where: { orgId: params.orgId, capability: reading.capability, state: 'OPEN' },
    });

    if (reading.shouldOpen && !live) {
      const breaker = await prisma.circuitBreaker.create({
        data: {
          orgId: params.orgId,
          capability: reading.capability,
          state: 'OPEN',
          openedAt: now,
          openedBecause: reading.verdict,
          evidence: reading.evidence as object,
          failureCount: reading.failed,
          observedCount: reading.observed,
          windowMinutes: config.managerRules.breakerWindowMinutes,
          retryAt: new Date(now.getTime() + config.managerRules.breakerRetryMinutes * 60_000),
          producedBy: PRODUCED_BY,
          ruleVersion: RULE_VERSION,
        },
      });

      // One home for the outage, in the place people already look for them.
      const incident = await prisma.workIncident.create({
        data: {
          orgId: params.orgId,
          kind: 'INTEGRATION_FAILURE',
          detail: `${CAPABILITY_LABELS[reading.capability]} stopped automatically. ${reading.verdict}`,
          preserved: { capability: reading.capability, breakerId: breaker.id } as object,
        },
        select: { id: true },
      });
      await prisma.circuitBreaker.update({
        where: { id: breaker.id }, data: { incidentId: incident.id },
      });

      opened.push(reading.capability);
      continue;
    }

    if (!reading.shouldOpen && live) {
      const cooled = !live.retryAt || live.retryAt <= now;
      if (cooled) {
        await prisma.circuitBreaker.update({
          where: { id: live.id },
          data: {
            state: 'CLOSED',
            closedAt: now,
            closedBecause: `Recovered on its own: ${reading.verdict}`,
            failureCount: reading.failed,
            observedCount: reading.observed,
          },
        });
        if (live.incidentId) {
          await prisma.workIncident.updateMany({
            where: { id: live.incidentId, status: 'OPEN' },
            data: {
              status: 'RESOLVED',
              resolvedAt: now,
              resolution: `The capability recovered and the breaker closed. ${reading.verdict}`,
            },
          });
        }
        closed.push(reading.capability);
      }
    }
  }

  return { opened, closed, readings };
}

/** Whether a capability is currently stopped, and whether a probe may go. */
export async function breakerStatus(params: {
  orgId: string;
  capability: WorkCapability;
  now?: Date;
}): Promise<BreakerStatus> {
  const now = params.now ?? new Date();
  const live = await prisma.circuitBreaker.findFirst({
    where: { orgId: params.orgId, capability: params.capability, state: 'OPEN' },
  });

  if (!live) {
    return { capability: params.capability, open: false, probeAllowed: true, because: null, since: null, id: null };
  }

  return {
    capability: params.capability,
    open: true,
    probeAllowed: Boolean(live.retryAt && live.retryAt <= now),
    because: live.openedBecause,
    since: live.openedAt,
    id: live.id,
  };
}

/** A person closing one by hand, having fixed whatever it was. */
export async function closeBreaker(params: {
  orgId: string;
  breakerId: string;
  actorId: string;
  because: string;
  now?: Date;
}): Promise<{ ok: boolean; message: string }> {
  const now = params.now ?? new Date();
  const row = await prisma.circuitBreaker.findFirst({
    where: { id: params.breakerId, orgId: params.orgId },
  });
  if (!row) return { ok: false, message: 'That breaker is not on this account.' };
  if (row.state !== 'OPEN') return { ok: false, message: 'That breaker is already closed.' };
  if (!params.because.trim()) return { ok: false, message: 'Say what was fixed. Closing a breaker without saying why is how the same outage happens twice.' };

  await prisma.circuitBreaker.update({
    where: { id: row.id },
    data: {
      state: 'CLOSED', closedAt: now, closedById: params.actorId,
      closedBecause: params.because.slice(0, 2000),
    },
  });

  if (row.incidentId) {
    await prisma.workIncident.updateMany({
      where: { id: row.incidentId, status: 'OPEN' },
      data: {
        status: 'RESOLVED', resolvedAt: now, resolvedBy: params.actorId,
        resolution: params.because.slice(0, 2000),
      },
    });
  }

  await audit({
    orgId: params.orgId, userId: params.actorId, action: 'manager.breaker_closed',
    entityType: 'CircuitBreaker', entityId: row.id, metadata: { capability: row.capability },
  });

  return { ok: true, message: `${CAPABILITY_LABELS[row.capability]} is available again.` };
}

/** Every open breaker, for the manager screen. */
export async function openBreakers(orgId: string): Promise<CircuitBreaker[]> {
  return prisma.circuitBreaker.findMany({
    where: { orgId, state: 'OPEN' },
    orderBy: { openedAt: 'desc' },
  });
}
