import { prisma } from '@/lib/db';

export type DecisionInput = {
  orgId: string;
  opportunityId?: string | null;
  process: string;
  decision: string;
  reason: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  confidence?: number;
  rulesApplied?: string[];
  modelName: string;
  promptVersion: string;
  /**
   * True when this process re-derives the same conclusion on every run.
   *
   * Scoring is the clearest case: it runs on a schedule and writes "Composite
   * 0.505, expected value $47,733" whether or not anything about the deal has
   * changed. Three identical rows is not three decisions, it is one decision
   * and two reruns, and reading it as a trail of deliberation is worse than
   * having no trail.
   *
   * The rerun is skipped only when it repeats the *most recent* conclusion for
   * the same process on the same opportunity. A score that moves away and
   * comes back has genuinely changed twice.
   */
  derived?: boolean;
};

/**
 * Every autonomous action writes one row here. This is the traceability
 * backbone: decision, reason, inputs, confidence, rules, model, prompt
 * version — and later, the outcome.
 */
export async function recordDecision(input: DecisionInput): Promise<string> {
  if (input.derived) {
    const last = await prisma.aIDecision.findFirst({
      where: {
        orgId: input.orgId,
        opportunityId: input.opportunityId ?? null,
        process: input.process,
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, decision: true },
    });
    // The existing row's id is returned so a caller that links to its decision
    // still links somewhere true — it points at the decision that stands,
    // which is what it meant all along.
    if (last?.decision === input.decision) return last.id;
  }

  const row = await prisma.aIDecision.create({
    data: {
      orgId: input.orgId,
      opportunityId: input.opportunityId ?? null,
      process: input.process,
      decision: input.decision,
      reason: input.reason,
      inputs: (input.inputs ?? {}) as object,
      outputs: (input.outputs ?? {}) as object,
      confidence: clamp01(input.confidence ?? 0.5),
      rulesApplied: input.rulesApplied ?? [],
      modelName: input.modelName,
      promptVersion: input.promptVersion,
    },
  });
  return row.id;
}

/** Closes the loop on a past decision so the system can learn what worked. */
export async function recordOutcome(decisionId: string, outcome: string): Promise<void> {
  await prisma.aIDecision.update({
    where: { id: decisionId },
    data: { outcome, outcomeAt: new Date() },
  });
}

export async function recordOverride(params: {
  orgId: string;
  decisionId: string;
  userId: string;
  previous: Record<string, unknown>;
  replacement: Record<string, unknown>;
  reason: string;
}): Promise<void> {
  await prisma.aIOverride.create({
    data: {
      orgId: params.orgId,
      decisionId: params.decisionId,
      userId: params.userId,
      previous: params.previous as object,
      replacement: params.replacement as object,
      reason: params.reason,
    },
  });
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
