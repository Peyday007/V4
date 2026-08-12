import type { FaultAttribution, IncidentKind, WorkCapability } from '@prisma/client';
import { CAPABILITY_LABELS, evidenceRef, type EvidenceRef } from './rules';

/**
 * Whose problem was it.
 *
 * This runs before anything else the manager does, and it is the reason the
 * rest of the layer can be trusted at all. "Evaluate application/integration
 * health before operator compliance" is easy to agree with and easy to skip,
 * because the operator's record is the one that is always to hand and the
 * outage log is the one you have to go and look for. So the lookup happens
 * first, mechanically, on every finding.
 *
 * There is one rule here that is deliberately absent: nothing in this file can
 * return OPERATOR. A machine may establish that the system broke, because that
 * is a fact about our own logs. It may establish that it does not know. It may
 * not decide that a person is at fault — that requires somebody who can ask
 * them, and every path to OPERATOR in this codebase runs through a human
 * pressing a button on a case they have read.
 */

/** An incident kind that is, on its face, ours. */
const SYSTEM_INCIDENT_KINDS: readonly IncidentKind[] = [
  'SAVE_FAILURE',
  'INTEGRATION_FAILURE',
  'ASSIGNMENT_CONFLICT',
  'STALE_ASSIGNMENT',
];

/**
 * How far either side of an observation an incident still explains it.
 *
 * Generous on purpose. An hour of slack costs us a case we might have raised;
 * ten minutes of slack costs somebody a mark against their name for an outage
 * that started while they were mid-call.
 */
const INCIDENT_WINDOW_MS = 60 * 60_000;

export type IncidentSignal = {
  id: string;
  kind: IncidentKind;
  createdAt: Date;
  resolvedAt?: Date | null;
  callerId?: string | null;
  routeId?: string | null;
  detail: string;
};

export type BreakerSignal = {
  id: string;
  capability: WorkCapability;
  openedAt: Date | null;
  closedAt?: Date | null;
  openedBecause: string | null;
};

/**
 * Something about the observation itself that says the machinery failed,
 * independent of any incident row.
 *
 * These are the cases where the evidence we would have judged somebody on is
 * evidence we failed to collect. A transcript that never arrived does not mean
 * the call did not happen.
 */
export type IntrinsicSystemFault =
  | 'TRANSCRIPTION_FAILED'
  | 'RECORDING_FAILED'
  | 'NO_AUDIO_CAPTURED'
  | 'SAVE_FAILED'
  | 'ASSIGNMENT_CORRUPTED'
  | 'SYNC_STALE';

const INTRINSIC_WORDS: Record<IntrinsicSystemFault, string> = {
  TRANSCRIPTION_FAILED: 'the transcription failed, so the words this would have been judged against were never produced',
  RECORDING_FAILED: 'the recording failed, so there is no audio to check this against',
  NO_AUDIO_CAPTURED: 'no audio was captured on this call, which is the ordinary case and not a caller\'s doing',
  SAVE_FAILED: 'the save failed on our side',
  ASSIGNMENT_CORRUPTED: 'the assignment was in an inconsistent state',
  SYNC_STALE: 'the data behind this was stale when it was read',
};

export type AttributionInput = {
  /** When the thing being explained happened. */
  at: Date;
  /** Who was doing the work, when there is somebody. */
  callerId?: string | null;
  routeId?: string | null;
  /** What the work needed, so the right breaker is consulted. */
  capability?: WorkCapability | null;
  incidents?: IncidentSignal[];
  breakers?: BreakerSignal[];
  intrinsic?: IntrinsicSystemFault | null;
};

export type Attribution = {
  attribution: FaultAttribution;
  /** Said in full, because this sentence is what a person reads first. */
  because: string;
  evidence: EvidenceRef[];
  /** True when the system's own health has been checked and found sound. */
  healthChecked: boolean;
};

export function attribute(input: AttributionInput): Attribution {
  const evidence: EvidenceRef[] = [];

  if (input.intrinsic) {
    return {
      attribution: 'SYSTEM_FAULT',
      because: `Ours: ${INTRINSIC_WORDS[input.intrinsic]}. This is not counted against anybody.`,
      evidence: [evidenceRef('what failed', `intrinsic:${input.intrinsic}`, input.at)],
      healthChecked: true,
    };
  }

  const overlapping = (input.incidents ?? []).filter((incident) => {
    if (!SYSTEM_INCIDENT_KINDS.includes(incident.kind)) return false;
    if (incident.callerId && input.callerId && incident.callerId !== input.callerId) return false;
    if (incident.routeId && input.routeId && incident.routeId !== input.routeId) return false;
    const from = incident.createdAt.getTime() - INCIDENT_WINDOW_MS;
    // An unresolved incident is still running: it has no end to compare
    // against, and treating "not resolved yet" as "over" is exactly backwards.
    const to = (incident.resolvedAt?.getTime() ?? Number.POSITIVE_INFINITY) + INCIDENT_WINDOW_MS;
    const when = input.at.getTime();
    return when >= from && when <= to;
  });

  if (overlapping.length > 0) {
    for (const incident of overlapping) {
      evidence.push(evidenceRef(
        `${incident.kind.toLowerCase().replace(/_/g, ' ')} incident`,
        `WorkIncident:${incident.id}`,
        incident.createdAt,
      ));
    }
    return {
      attribution: 'SYSTEM_FAULT',
      because: `Ours: ${overlapping.length === 1 ? 'an incident was' : `${overlapping.length} incidents were`} open on this work when it happened — ${overlapping[0].detail.slice(0, 180)}. This is not counted against anybody.`,
      evidence,
      healthChecked: true,
    };
  }

  const capability = input.capability ?? null;
  const openThen = capability
    ? (input.breakers ?? []).filter((breaker) => {
        if (breaker.capability !== capability) return false;
        if (!breaker.openedAt) return false;
        const from = breaker.openedAt.getTime();
        const to = breaker.closedAt?.getTime() ?? Number.POSITIVE_INFINITY;
        return input.at.getTime() >= from && input.at.getTime() <= to;
      })
    : [];

  if (openThen.length > 0) {
    for (const breaker of openThen) {
      evidence.push(evidenceRef(
        `${CAPABILITY_LABELS[breaker.capability]} was stopped`,
        `CircuitBreaker:${breaker.id}`,
        breaker.openedAt,
      ));
    }
    return {
      attribution: 'SYSTEM_FAULT',
      because: `Ours: ${CAPABILITY_LABELS[capability!]} was stopped by a circuit breaker at the time — ${openThen[0].openedBecause ?? 'the capability was failing'}. This is not counted against anybody.`,
      evidence,
      healthChecked: true,
    };
  }

  // Nothing on our side explains it. That is as far as a rule can go: the
  // remaining possibilities include several that are nobody's fault and one
  // that is, and telling them apart means asking.
  return {
    attribution: 'UNDETERMINED',
    because: 'No incident or outage on our side covers this. That does not make it anybody\'s fault — it means the question is open and worth asking.',
    evidence: [],
    healthChecked: true,
  };
}

/**
 * Whether this attribution permits an intervention that names a person.
 *
 * The database refuses the combination outright; this is the same rule stated
 * where the code can read it, so a caller of the ladder gets a sentence rather
 * than a constraint violation.
 */
export function mayNameAPerson(attribution: FaultAttribution): boolean {
  return attribution !== 'SYSTEM_FAULT';
}
