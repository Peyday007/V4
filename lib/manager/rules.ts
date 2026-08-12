import type { InterventionRung, WorkCapability } from '@prisma/client';

/**
 * The vocabulary the System Manager reasons in.
 *
 * Kept in one file because two of these lists are load-bearing and would rot
 * if each caller kept its own copy: the rung order *is* the intervention
 * ladder, and the set of rungs that stop work is what the database checks
 * before it will accept a row without a restoration rule.
 *
 * The order is not stored in the enum's own declaration order by accident —
 * it is stored here as well, deliberately, for the same reason the funnel is.
 * `ALTER TYPE … ADD VALUE` appends, so a rung added later would sort last in
 * the database whatever it means, and anything reading the ladder from the
 * enum would quietly stop being a ladder.
 */

/** Which rules produced a decision, and which revision of them. */
export const PRODUCED_BY = 'rules:manager';
export const RULE_VERSION = 'manager@1';

/** The eight rungs, weakest first. */
export const RUNG_ORDER: readonly InterventionRung[] = [
  'INLINE_GUIDANCE',
  'REQUIRED_CORRECTION',
  'MICRO_COACHING',
  'WARNING',
  'RESTRICTED_MODE',
  'CAPABILITY_PAUSE',
  'SECURITY_RESTRICTION',
  'OWNER_ESCALATION',
];

export function rungRank(rung: InterventionRung): number {
  const at = RUNG_ORDER.indexOf(rung);
  if (at < 0) throw new Error(`Unranked intervention rung: ${rung}`);
  return at;
}

/**
 * The rungs that take work away from somebody.
 *
 * The database holds the same list. If one changes, the audit that compares
 * them fails, which is the point: a rung silently dropping out of this set
 * would let a restriction be applied with no way back out of it.
 */
export const RESTRICTING_RUNGS: readonly InterventionRung[] = [
  'RESTRICTED_MODE',
  'CAPABILITY_PAUSE',
  'SECURITY_RESTRICTION',
];

export function restrictsWork(rung: InterventionRung): boolean {
  return RESTRICTING_RUNGS.includes(rung);
}

/**
 * Rungs no rule may apply on its own, whatever the configuration says.
 *
 * "Owner-only decisions include termination, pay disputes, final fraud
 * findings, binding pricing/terms, permanent suspension and destructive data
 * actions." A security restriction and an owner escalation are the two rungs
 * on this ladder that touch that territory, so they are proposals here and
 * nothing else — a config flag cannot promote them.
 */
export const OWNER_ONLY_RUNGS: readonly InterventionRung[] = [
  'SECURITY_RESTRICTION',
  'OWNER_ESCALATION',
];

export function needsOwnerAuthority(rung: InterventionRung): boolean {
  return OWNER_ONLY_RUNGS.includes(rung);
}

export const RUNG_LABELS: Record<InterventionRung, string> = {
  INLINE_GUIDANCE: 'A note on the screen',
  REQUIRED_CORRECTION: 'Something to fix before moving on',
  MICRO_COACHING: 'A short piece of coaching',
  WARNING: 'A warning, with the records it refers to',
  RESTRICTED_MODE: 'Restricted mode on one capability',
  CAPABILITY_PAUSE: 'That capability paused',
  SECURITY_RESTRICTION: 'A temporary security restriction',
  OWNER_ESCALATION: 'Escalated to the owner',
};

/**
 * The narrowest thing that can be stopped.
 *
 * Every entry here is one act somebody performs, not one screen they open.
 * "Use the smallest sufficient intervention" is only implementable if the
 * levers are this small: a caller who priced something badly loses quoting and
 * keeps calling, and a caller whose recordings keep failing keeps both.
 */
export const CAPABILITY_LABELS: Record<WorkCapability, string> = {
  CALL_PLACING: 'placing calls',
  CALL_RECORDING: 'recording calls',
  REQUIREMENT_CAPTURE: 'recording what a buyer needs',
  QUOTE_DRAFTING: 'drafting quotes',
  DEAL_ROOM_SENDING: 'sending deal rooms',
  PROVIDER_COMMITMENT: 'committing a provider',
  AUTONOMOUS_SENDING: 'sending anything without a person pressing send',
};

export const ALL_CAPABILITIES = Object.keys(CAPABILITY_LABELS) as WorkCapability[];

/** One record a decision was read from. Never a bare id. */
export type EvidenceRef = {
  /** What it is, in words. */
  label: string;
  /** Where to look: a table and an id, or a URL. */
  ref: string;
  at?: string;
};

export function evidenceRef(label: string, ref: string, at?: Date | null): EvidenceRef {
  return { label, ref, ...(at ? { at: at.toISOString() } : {}) };
}
