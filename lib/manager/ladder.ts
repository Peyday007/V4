import type { ConsistencyKind, FaultAttribution, InterventionRung, WorkCapability } from '@prisma/client';
import type { OrgConfig } from '@/lib/config';
import { needsOwnerAuthority, restrictsWork, rungRank, RUNG_LABELS } from './rules';

/**
 * Which rung, if any.
 *
 * Pure, and deliberately hard to make angry. Four rules shape everything here:
 *
 *   Nothing above nothing until a person has confirmed the case. A rule may
 *   observe a mismatch; it may not conclude one. Every path that reaches a rung
 *   passes through `attribution === 'OPERATOR'`, and the only way a case gets
 *   that value is somebody pressing a button having read it.
 *
 *   The smallest sufficient rung. A missing note is a record to fix, not a
 *   warning. A warning is for the second time, once the fix has been explained.
 *
 *   Acknowledgement is not remediation. Escalation counts repeats of the
 *   behaviour, and nothing in this file gets easier because somebody said sorry.
 *
 *   The restriction is on the capability the mistake was in. Somebody who keeps
 *   forgetting notes does not lose the ability to draft a quote.
 */

export type LadderInput = {
  kind: ConsistencyKind;
  attribution: FaultAttribution;
  /** Confirmed cases of this same kind about this person, in the window. */
  priorConfirmed: number;
  /** Interventions already applied to them for this kind, weakest first. */
  priorRungs: InterventionRung[];
  /** Their attempts in the window. Below the floor, nothing is read as a habit. */
  attempts: number;
  rules: OrgConfig['managerRules'];
};

export type Recommendation = {
  /** Null when nothing should happen, which is most of the time. */
  rung: InterventionRung | null;
  capability: WorkCapability | null;
  /** Said to whoever reads it, including the person it is about. */
  reason: string;
  /** Written now, before anybody is invested in it staying. */
  restorationRule: string | null;
  /** Whether this may take effect, or is recorded and left inert. */
  enforce: boolean;
  enforcementNote: string;
  /** True when only the owner may turn it on. */
  ownerOnly: boolean;
};

/** The capability each kind of mistake actually lives in. */
const CAPABILITY_FOR: Record<ConsistencyKind, WorkCapability> = {
  ATTEMPT_WITHOUT_EVIDENCE: 'CALL_PLACING',
  PROMISE_NOT_SCHEDULED: 'CALL_PLACING',
  DISPOSITION_CONTRADICTS_TRANSCRIPT: 'CALL_PLACING',
  QUALIFIED_WITHOUT_FACTS: 'REQUIREMENT_CAPTURE',
  DUPLICATE_ATTEMPT: 'CALL_PLACING',
  ATTEMPT_OUTSIDE_CALLING_HOURS: 'CALL_PLACING',
  FACTS_RECORDED_WITHOUT_CONTACT: 'REQUIREMENT_CAPTURE',
  FOLLOW_UP_PROMISE_MISSED: 'CALL_PLACING',
};

/**
 * Kinds where the law, not the process, is the thing being broken.
 *
 * These start one rung higher and reach a pause sooner. Calling somebody at
 * half past ten at night is not a coaching matter on the third occurrence; it
 * is a liability, and it belongs to the business rather than to the caller.
 */
const COMPLIANCE_KINDS: readonly ConsistencyKind[] = ['ATTEMPT_OUTSIDE_CALLING_HOURS'];

/**
 * Kinds where there is a record in front of somebody that can simply be fixed.
 *
 * The cheapest possible intervention, and the one most likely to be the right
 * one: a caller who forgot to write the note usually remembers the call.
 */
const FIXABLE_KINDS: readonly ConsistencyKind[] = [
  'ATTEMPT_WITHOUT_EVIDENCE',
  'PROMISE_NOT_SCHEDULED',
  'QUALIFIED_WITHOUT_FACTS',
  'FACTS_RECORDED_WITHOUT_CONTACT',
];

/**
 * What has to be true for a restriction to end, per capability.
 *
 * Written here rather than typed by whoever applies it, because a restoration
 * condition invented in the moment is written by somebody who is annoyed, and
 * because a condition nobody could ever meet is indistinguishable from a
 * permanent suspension that nobody had to authorise.
 */
export const RESTORATION: Record<WorkCapability, string> = {
  CALL_PLACING:
    'Ten consecutive calls logged with a note or a recorded fact, read by a manager, and no new confirmed case of this kind for fourteen days.',
  CALL_RECORDING:
    'Two recorded calls reviewed with the announcement given correctly and consent in the right state.',
  REQUIREMENT_CAPTURE:
    'Three buyer requirements captured with a source for every material field, checked by a manager.',
  QUOTE_DRAFTING:
    'Three quotes drafted under review with no pricing correction needed.',
  DEAL_ROOM_SENDING:
    'Three rooms previewed and approved by a manager before sending, with no factual correction.',
  PROVIDER_COMMITMENT:
    'Two provider commitments evidenced with a written confirmation from the provider.',
  AUTONOMOUS_SENDING:
    'A week of drafts reviewed before sending with no correction, and the owner turning it back on deliberately.',
};

export function recommend(input: LadderInput): Recommendation {
  const capability = CAPABILITY_FOR[input.kind];

  // Ours. Nothing about a person follows from our own outage, and the ladder
  // does not have a rung for it.
  if (input.attribution === 'SYSTEM_FAULT') {
    return inert(
      'This was a system failure. It produces an incident, not an intervention, and it is not counted against anybody.',
    );
  }

  if (input.attribution !== 'OPERATOR') {
    return inert(
      'The case is open and nobody has concluded anything yet. A mismatch is a question, and a question is not a finding.',
    );
  }

  // Two or three calls is not a habit, and treating it as one is how a caller
  // learns that a quiet week gets them coached.
  if (input.attempts < input.rules.minAttemptsForCoaching) {
    return inert(
      `Only ${input.attempts} attempt(s) in the window, below the floor of ${input.rules.minAttemptsForCoaching}. There is not enough work here to call anything a pattern.`,
    );
  }

  const compliance = COMPLIANCE_KINDS.includes(input.kind);
  const highest = input.priorRungs.length > 0
    ? input.priorRungs.reduce((a, b) => (rungRank(a) >= rungRank(b) ? a : b))
    : null;

  const rung = chooseRung({
    kind: input.kind,
    compliance,
    priorConfirmed: input.priorConfirmed,
    highest,
    minCasesBeforeRestriction: input.rules.minCasesBeforeRestriction,
  });

  if (!rung) {
    return inert('Nothing above what has already been done is warranted here.');
  }

  const restricting = restrictsWork(rung);
  const ownerOnly = needsOwnerAuthority(rung);
  const permitted = input.rules.enforceableRungs.includes(rung);

  return {
    rung,
    capability: restricting ? capability : null,
    reason: explain(input, rung, compliance),
    restorationRule: restricting ? RESTORATION[capability] : null,
    // Two independent gates, and the second one cannot be configured away.
    enforce: permitted && !ownerOnly,
    enforcementNote: ownerOnly
      ? `${RUNG_LABELS[rung]} is the owner's to apply. This is recorded as a proposal and does nothing until they act on it.`
      : permitted
        ? 'Enabled for enforcement in this account\'s operating rules.'
        : `Recorded in shadow: ${RUNG_LABELS[rung].toLowerCase()} is not yet enabled for enforcement here. It will be visible on the manager screen and will do nothing.`,
    ownerOnly,
  };
}

function chooseRung(params: {
  kind: ConsistencyKind;
  compliance: boolean;
  priorConfirmed: number;
  highest: InterventionRung | null;
  minCasesBeforeRestriction: number;
}): InterventionRung | null {
  // `priorConfirmed` counts the occurrences *before* this one, so the first
  // time through it is zero.
  const occurrence = params.priorConfirmed + 1;

  let target: InterventionRung;
  if (params.compliance) {
    target = occurrence === 1 ? 'REQUIRED_CORRECTION'
      : occurrence === 2 ? 'WARNING'
        : 'CAPABILITY_PAUSE';
  } else if (FIXABLE_KINDS.includes(params.kind)) {
    target = occurrence === 1 ? 'REQUIRED_CORRECTION'
      : occurrence === 2 ? 'MICRO_COACHING'
        : occurrence === 3 ? 'WARNING'
          : 'RESTRICTED_MODE';
  } else {
    target = occurrence === 1 ? 'MICRO_COACHING'
      : occurrence === 2 ? 'WARNING'
        : 'RESTRICTED_MODE';
  }

  // A restriction needs a body of confirmed cases behind it whatever the
  // sequence says. Three occurrences of the same thing in a week is a
  // conversation; the threshold is what stops one bad afternoon becoming a
  // suspension.
  if (restrictsWork(target) && params.priorConfirmed < params.minCasesBeforeRestriction) {
    target = 'WARNING';
  }

  // Never below what they have already had. Going backwards would mean the
  // second warning arrives as a note on a screen.
  if (params.highest && rungRank(target) <= rungRank(params.highest)) {
    const next = rungRank(params.highest) + 1;
    if (restrictsWork(indexed(next)) && params.priorConfirmed < params.minCasesBeforeRestriction) {
      return null;
    }
    return next < 8 ? indexed(next) : 'OWNER_ESCALATION';
  }

  return target;
}

const ORDER: InterventionRung[] = [
  'INLINE_GUIDANCE', 'REQUIRED_CORRECTION', 'MICRO_COACHING', 'WARNING',
  'RESTRICTED_MODE', 'CAPABILITY_PAUSE', 'SECURITY_RESTRICTION', 'OWNER_ESCALATION',
];

function indexed(at: number): InterventionRung {
  return ORDER[Math.min(Math.max(at, 0), ORDER.length - 1)];
}

function explain(input: LadderInput, rung: InterventionRung, compliance: boolean): string {
  const occurrence = input.priorConfirmed + 1;
  const nth = occurrence === 1 ? 'the first confirmed instance'
    : occurrence === 2 ? 'the second confirmed instance'
      : `confirmed instance ${occurrence}`;
  const subject = input.kind.toLowerCase().replace(/_/g, ' ');
  const law = compliance ? ' This one is a compliance rule rather than a process preference, which is why it starts higher.' : '';
  return `${RUNG_LABELS[rung]}: ${nth} of ${subject}, over ${input.attempts} attempt(s) in the window.${law}`;
}

function inert(reason: string): Recommendation {
  return {
    rung: null,
    capability: null,
    reason,
    restorationRule: null,
    enforce: false,
    enforcementNote: reason,
    ownerOnly: false,
  };
}
