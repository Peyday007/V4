import { createHash } from 'node:crypto';
import type { Experiment, ExperimentArm, LeadTier, OutcomeStage, SignalCategory } from '@prisma/client';
import { prisma } from '@/lib/db';
import { rate, compareAdjusted, type Stratum } from './stats';
import { STAGE_LABELS, stageRank } from './funnel';

/**
 * Controlled experiments on how work is done.
 *
 * The specific failures this is built against, all of which the previous
 * system produced:
 *
 *   Assignment that moved. Randomising on each request means the same route
 *   gets the control script on Monday and the treatment on Tuesday, and both
 *   arms are contaminated with no way to tell.
 *
 *   Comparing populations rather than treatments. A script tried on active
 *   demand and compared against directory prospects measures the leads.
 *
 *   Choosing the metric afterwards. A funnel with fourteen rungs will always
 *   have one that moved, so the outcome is declared before the experiment runs
 *   and the readout reports that one.
 *
 *   Calling an early lift a win. Answer rate is easy to move and easy to move
 *   by being more aggressive, which shows up four rungs later as complaints
 *   and do-not-contact. A guardrail that moved the wrong way ends it.
 */

/**
 * Which arm a subject belongs to, decided by hashing.
 *
 * Deterministic and stable: the same subject in the same experiment always
 * lands in the same arm, whether this is called during a page render, a retry,
 * or a job three weeks later. The experiment id is in the hash so a subject in
 * two experiments is not correlated across them.
 *
 * Pure, and exported, so the property that matters most about it can be tested
 * without a database.
 */
export function assignArm(
  experimentId: string,
  subjectId: string,
  arms: Array<{ key: string; weight: number }>,
): string | null {
  if (arms.length === 0) return null;

  const total = arms.reduce((sum, arm) => sum + arm.weight, 0);
  if (total <= 0) return null;

  // 32 bits of the digest as a fraction of the whole space. Uniform enough for
  // traffic splitting and stable across processes and restarts, which a
  // language-level hash is not.
  const digest = createHash('sha256').update(`${experimentId}:${subjectId}`).digest();
  const bucket = digest.readUInt32BE(0) / 0x1_0000_0000;

  let cumulative = 0;
  for (const arm of arms) {
    cumulative += arm.weight / total;
    if (bucket < cumulative) return arm.key;
  }
  return arms[arms.length - 1].key;
}

/**
 * The stratum a subject belongs to.
 *
 * Coarse on purpose. Every extra dimension halves the sample in each cell, and
 * a stratified comparison with two observations per cell is worse than an
 * unstratified one — it just hides the problem better. Tier and route are the
 * two that actually change the outcome; market is included only when the
 * experiment declared it.
 */
export function stratumFor(input: {
  tier: LeadTier;
  route: SignalCategory;
  market?: string | null;
  useMarket?: boolean;
}): string {
  const parts: string[] = [input.tier, input.route];
  if (input.useMarket && input.market) parts.push(input.market);
  return parts.join('/');
}

export type EligibilityResult =
  | { eligible: true; stratum: string }
  | { eligible: false; because: string };

/** Whether an experiment applies to this subject at all. */
export function isEligible(
  experiment: Pick<Experiment, 'state' | 'tiers' | 'routes' | 'markets'>,
  subject: { tier: LeadTier; route: SignalCategory; market?: string | null },
): EligibilityResult {
  if (experiment.state !== 'RUNNING') {
    return { eligible: false, because: `The experiment is ${experiment.state.toLowerCase()}, so it assigns nobody.` };
  }
  if (experiment.tiers.length > 0 && !experiment.tiers.includes(subject.tier)) {
    return { eligible: false, because: `Tier ${subject.tier} is outside this experiment's population.` };
  }
  if (experiment.routes.length > 0 && !experiment.routes.includes(subject.route)) {
    return { eligible: false, because: `Route ${subject.route} is outside this experiment's population.` };
  }
  if (experiment.markets.length > 0 && (!subject.market || !experiment.markets.includes(subject.market))) {
    return { eligible: false, because: 'Outside this experiment\'s markets.' };
  }
  return {
    eligible: true,
    stratum: stratumFor({ ...subject, useMarket: experiment.markets.length > 0 }),
  };
}

/**
 * The arm this subject is in, assigning it on first sight.
 *
 * The assignment is stored even though the hash would reproduce it, because
 * the *inputs* are not stable: a route can move tier, and a subject that
 * silently changed stratum mid-experiment would contaminate both arms and
 * leave no trace of having done so. The stored row is the record of what was
 * true when the decision was made.
 */
export async function armFor(params: {
  orgId: string;
  experimentId: string;
  subjectType: 'route' | 'caller';
  subjectId: string;
  subject: { tier: LeadTier; route: SignalCategory; market?: string | null };
}): Promise<{ armKey: string; armId: string; stratum: string; newlyAssigned: boolean } | null> {
  const existing = await prisma.experimentAssignment.findUnique({
    where: {
      experimentId_subjectType_subjectId: {
        experimentId: params.experimentId,
        subjectType: params.subjectType,
        subjectId: params.subjectId,
      },
    },
    include: { arm: { select: { id: true, key: true } } },
  });
  if (existing) {
    return {
      armKey: existing.arm.key,
      armId: existing.arm.id,
      stratum: existing.stratum,
      newlyAssigned: false,
    };
  }

  const experiment = await prisma.experiment.findFirst({
    where: { id: params.experimentId, orgId: params.orgId },
    include: { arms: true },
  });
  if (!experiment) return null;

  const eligibility = isEligible(experiment, params.subject);
  if (!eligibility.eligible) return null;

  const armKey = assignArm(
    experiment.id,
    params.subjectId,
    experiment.arms.map((a) => ({ key: a.key, weight: a.weight })),
  );
  if (!armKey) return null;

  const arm = experiment.arms.find((a) => a.key === armKey);
  if (!arm) return null;

  try {
    await prisma.experimentAssignment.create({
      data: {
        orgId: params.orgId,
        experimentId: experiment.id,
        armId: arm.id,
        subjectType: params.subjectType,
        subjectId: params.subjectId,
        stratum: eligibility.stratum,
      },
    });
  } catch (error) {
    // Two requests assigning the same subject at once. The unique index picks
    // one; both get the same answer, because the hash is deterministic.
    if (!isUniqueViolation(error)) throw error;
  }

  return { armKey: arm.key, armId: arm.id, stratum: eligibility.stratum, newlyAssigned: true };
}

// ---------------------------------------------------------------------------
// Reading it out
// ---------------------------------------------------------------------------

export type ArmReadout = {
  key: string;
  label: string;
  isControl: boolean;
  assigned: number;
  /** Reached the primary outcome. */
  reached: number;
  rate: ReturnType<typeof rate>;
};

export type GuardrailReadout = {
  stage: OutcomeStage;
  label: string;
  verdict: string;
  because: string;
  /** True when the treatment made this worse. */
  regressed: boolean;
};

export type ExperimentReadout = {
  experimentId: string;
  name: string;
  state: string;
  primaryOutcome: OutcomeStage;
  primaryLabel: string;
  arms: ArmReadout[];
  /** The stratified comparison of treatment against control. */
  verdict: 'better' | 'worse' | 'no_difference' | 'insufficient_evidence';
  because: string;
  guardrails: GuardrailReadout[];
  /** What an owner should do, in one line. Never "roll it out" on a weak sample. */
  recommendation: string;
  /** True when a guardrail regressed, whatever the primary says. */
  blocked: boolean;
};

/**
 * What the experiment showed, or that it has not shown anything yet.
 *
 * The order of the checks matters and is not cosmetic. Guardrails are read
 * before the primary outcome, so a treatment that lifted answer rate and
 * doubled do-not-contact can never be reported as a win with a caveat under
 * it — it is reported as blocked, because that is what it is.
 */
export async function readOut(params: { orgId: string; experimentId: string }): Promise<ExperimentReadout | null> {
  const experiment = await prisma.experiment.findFirst({
    where: { id: params.experimentId, orgId: params.orgId },
    include: { arms: { orderBy: { isControl: 'desc' } } },
  });
  if (!experiment) return null;

  const assignments = await prisma.experimentAssignment.findMany({
    where: { experimentId: experiment.id },
    select: { armId: true, subjectId: true, subjectType: true, stratum: true },
  });

  const routeIds = assignments.filter((a) => a.subjectType === 'route').map((a) => a.subjectId);
  const outcomes = routeIds.length > 0
    ? await prisma.demandOutcome.findMany({
        where: { orgId: params.orgId, dataMode: 'PRODUCTION', routeId: { in: routeIds } },
        select: { routeId: true, stage: true },
      })
    : [];

  const stagesByRoute = new Map<string, Set<OutcomeStage>>();
  for (const outcome of outcomes) {
    if (!outcome.routeId) continue;
    const set = stagesByRoute.get(outcome.routeId) ?? new Set();
    set.add(outcome.stage);
    stagesByRoute.set(outcome.routeId, set);
  }

  const reached = (subjectId: string, stage: OutcomeStage): boolean => {
    const stages = stagesByRoute.get(subjectId);
    if (!stages) return false;
    if (stages.has(stage)) return true;
    // A subject that got further than the stage has passed through it. Read
    // from the funnel's own order, never from the enum's, which no longer
    // matches after this phase appended four values.
    const target = stageRank(stage);
    if (target === -1) return false;
    return Array.from(stages).some((s) => stageRank(s) > target);
  };

  const control = experiment.arms.find((a) => a.isControl) ?? experiment.arms[0];
  const treatment = experiment.arms.find((a) => a.id !== control?.id);

  const armReadouts: ArmReadout[] = experiment.arms.map((arm) => {
    const mine = assignments.filter((a) => a.armId === arm.id);
    const hits = mine.filter((a) => reached(a.subjectId, experiment.primaryOutcome)).length;
    return {
      key: arm.key,
      label: arm.label,
      isControl: arm.isControl,
      assigned: mine.length,
      reached: hits,
      rate: rate(hits, mine.length, experiment.minimumSamplePerArm),
    };
  });

  // --- guardrails, first ---------------------------------------------------
  const guardrails: GuardrailReadout[] = [];
  if (control && treatment) {
    for (const stage of experiment.guardrails) {
      const strata = buildStrata(assignments, treatment.id, control.id, (id) => reached(id, stage));
      const result = compareAdjusted(strata, experiment.minimumSamplePerArm);

      // Direction matters and depends on the stage. More of LOST is worse;
      // more of anything on the ladder is better.
      const isBadStage = stage === 'LOST';
      const regressed = isBadStage
        ? result.verdict === 'better'
        : result.verdict === 'worse';

      guardrails.push({
        stage,
        label: STAGE_LABELS[stage],
        verdict: result.verdict,
        because: isBadStage && result.verdict === 'better'
          ? `More of this in the treatment arm, which is the wrong direction. ${result.because}`
          : result.because,
        regressed,
      });
    }
  }

  const blocked = guardrails.some((g) => g.regressed);

  // --- the declared outcome ------------------------------------------------
  let verdict: ExperimentReadout['verdict'] = 'insufficient_evidence';
  let because = 'This experiment has no control and treatment arm to compare.';

  if (control && treatment) {
    const strata = buildStrata(assignments, treatment.id, control.id, (id) => reached(id, experiment.primaryOutcome));
    const result = compareAdjusted(strata, experiment.minimumSamplePerArm);
    verdict = result.verdict;
    because = result.because;
  }

  return {
    experimentId: experiment.id,
    name: experiment.name,
    state: experiment.state,
    primaryOutcome: experiment.primaryOutcome,
    primaryLabel: STAGE_LABELS[experiment.primaryOutcome],
    arms: armReadouts,
    verdict,
    because,
    guardrails,
    recommendation: recommend(verdict, blocked, guardrails),
    blocked,
  };
}

function recommend(
  verdict: ExperimentReadout['verdict'],
  blocked: boolean,
  guardrails: GuardrailReadout[],
): string {
  if (blocked) {
    const names = guardrails.filter((g) => g.regressed).map((g) => g.label).join(', ');
    return `Do not roll this out. It moved a guardrail the wrong way (${names}), and a change that wins early and loses late is a loss. Stop it and keep the arm on record.`;
  }
  switch (verdict) {
    case 'insufficient_evidence':
      return 'Keep it running. There is not enough here yet, which is different from there being no effect.';
    case 'no_difference':
      return 'No measurable difference. Keep whichever is simpler to operate, and record that the question was asked.';
    case 'worse':
      return 'Stop it. The treatment is worse on the outcome that was declared before it ran.';
    case 'better':
      return 'Roll it out, and keep watching the guardrails for a month — the effect that survives a rollout is often smaller than the one in the trial.';
    default:
      return 'No recommendation.';
  }
}

function buildStrata(
  assignments: Array<{ armId: string; subjectId: string; stratum: string }>,
  treatmentArmId: string,
  controlArmId: string,
  hit: (subjectId: string) => boolean,
): Stratum[] {
  const map = new Map<string, Stratum>();
  for (const assignment of assignments) {
    if (assignment.armId !== treatmentArmId && assignment.armId !== controlArmId) continue;
    const stratum = map.get(assignment.stratum) ?? {
      key: assignment.stratum,
      treatment: { successes: 0, trials: 0 },
      control: { successes: 0, trials: 0 },
    };
    const side = assignment.armId === treatmentArmId ? stratum.treatment : stratum.control;
    side.trials += 1;
    if (hit(assignment.subjectId)) side.successes += 1;
    map.set(assignment.stratum, stratum);
  }
  return Array.from(map.values());
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export type StartRefusal = { ok: false; message: string; detail: string[] };

/**
 * Start an experiment, or refuse and say what is missing.
 *
 * The weight check is not pedantry: arms summing to anything other than one
 * mean a share of traffic silently falls through to whichever arm the
 * assignment loop ends on, and the readout would describe an experiment that
 * did not happen.
 */
export async function startExperiment(options: {
  orgId: string;
  experimentId: string;
  actorId?: string | null;
}): Promise<{ ok: true; experiment: Experiment } | StartRefusal> {
  const experiment = await prisma.experiment.findFirst({
    where: { id: options.experimentId, orgId: options.orgId },
    include: { arms: true },
  });
  if (!experiment) return { ok: false, message: 'That experiment is not on this account.', detail: [] };
  if (experiment.state !== 'DRAFT') {
    return { ok: false, message: `This experiment is already ${experiment.state.toLowerCase()}.`, detail: [] };
  }

  const problems: string[] = [];
  if (experiment.arms.length < 2) problems.push('An experiment needs at least a control and one treatment.');
  if (!experiment.arms.some((a) => a.isControl)) problems.push('No arm is marked as the control.');
  if (experiment.arms.filter((a) => a.isControl).length > 1) problems.push('More than one arm is marked as the control.');

  const total = experiment.arms.reduce((sum, a) => sum + a.weight, 0);
  if (Math.abs(total - 1) > 0.001) {
    problems.push(`Arm weights sum to ${total.toFixed(3)} rather than 1, so part of the traffic is unaccounted for.`);
  }
  if (!experiment.hypothesis.trim()) problems.push('No hypothesis was written down.');

  if (problems.length > 0) {
    return { ok: false, message: 'This experiment was not started.', detail: problems };
  }

  const started = await prisma.experiment.update({
    where: { id: experiment.id },
    data: { state: 'RUNNING', startedAt: new Date() },
  });
  return { ok: true, experiment: started };
}

/**
 * Halt or conclude.
 *
 * A halted experiment keeps its assignments. Deleting them would remove the
 * evidence of which work ran under the arm that went wrong, which is exactly
 * the evidence anybody would want afterwards.
 */
export async function concludeExperiment(options: {
  orgId: string;
  experimentId: string;
  conclusion: string;
  winningArmId?: string | null;
  halted?: boolean;
}): Promise<{ ok: boolean; message?: string }> {
  const experiment = await prisma.experiment.findFirst({
    where: { id: options.experimentId, orgId: options.orgId },
  });
  if (!experiment) return { ok: false, message: 'That experiment is not on this account.' };
  if (!options.conclusion.trim()) {
    return { ok: false, message: 'Write down what it showed, including when the answer is "nothing".' };
  }

  // A winner cannot be declared past a guardrail regression, whatever an
  // operator believes. Checked here rather than on the screen, because the
  // screen is not the thing that writes the row.
  if (options.winningArmId) {
    const readout = await readOut({ orgId: options.orgId, experimentId: options.experimentId });
    if (readout?.blocked) {
      return {
        ok: false,
        message: 'A guardrail moved the wrong way, so no arm can be recorded as the winner. Halt it instead.',
      };
    }
    if (readout?.verdict === 'insufficient_evidence') {
      return {
        ok: false,
        message: 'The sample is below the floor declared when this started, so nothing can be called a winner yet.',
      };
    }
  }

  await prisma.experiment.update({
    where: { id: experiment.id },
    data: {
      state: options.halted ? 'HALTED' : 'CONCLUDED',
      concludedAt: new Date(),
      conclusion: options.conclusion,
      winningArmId: options.winningArmId ?? null,
    },
  });
  return { ok: true };
}

/** Experiments currently assigning, for a given subject. */
export async function runningFor(params: {
  orgId: string;
  subject: { tier: LeadTier; route: SignalCategory; market?: string | null };
}): Promise<Array<Experiment & { arms: ExperimentArm[] }>> {
  const running = await prisma.experiment.findMany({
    where: { orgId: params.orgId, state: 'RUNNING' },
    include: { arms: true },
  });
  return running.filter((experiment) => isEligible(experiment, params.subject).eligible);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'P2002';
}
