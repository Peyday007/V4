import type { CampaignState } from '@prisma/client';
import { prisma } from '@/lib/db';
import { audit } from '@/lib/audit';
import { campaignReadiness, canTransition, needsBudget, type CampaignDraft } from './model';
import { campaignOutcome, conditionFires } from './outcomes';
import { configuredCoverage } from '@/lib/portfolio/concentration';

/**
 * The operations a campaign actually goes through, with the refusals attached.
 *
 * Kept apart from the model so the rules stay pure and testable, and apart from
 * the route handlers so the same operation is available to the scheduler
 * without going through HTTP. The route handlers do authentication and shape;
 * everything that decides whether something may happen is here.
 */

export type CampaignSummary = Awaited<ReturnType<typeof loadCampaign>>;

export async function loadCampaign(params: { orgId: string; campaignId: string }) {
  const campaign = await prisma.campaign.findFirstOrThrow({
    where: { id: params.campaignId, orgId: params.orgId },
    include: {
      evidence: { orderBy: { createdAt: 'asc' } },
      channels: true,
      conditions: { orderBy: { kind: 'asc' } },
      authorityBy: { select: { name: true } },
    },
  });

  const outcome = await campaignOutcome({ orgId: params.orgId, campaignId: campaign.id });
  const readiness = campaignReadiness({
    draft: toDraft(campaign),
    reachableStates: configuredCoverage().reachable,
  });

  // Conditions are evaluated on read as well as on the schedule, so a page
  // never shows a stale "not met" beside an outcome that plainly meets it.
  const conditions = campaign.conditions.map((c) => ({
    ...c,
    evaluation: conditionFires({ condition: c, outcome }),
  }));

  return { campaign, outcome, readiness, conditions };
}

function toDraft(campaign: {
  name: string; thesis: string; whyNow: string; route: CampaignDraft['route'];
  targetStates: string[]; buyerProfile: string; providerProfile: string;
  requiredCapability: string; testingHours: number; testingCostCents: number;
  testingCostBasis: string; budgetCents: number | null; authorityGrantedById: string | null;
  evidence: Array<{ kind: string; claim: string; evidenceClass: CampaignDraft['evidence'][number]['evidenceClass']; sourceUrl: string | null }>;
  channels: Array<{ kind: CampaignDraft['channels'][number]['kind']; enabled: boolean; budgetCents: number | null; authorisedById: string | null; outcomeMetric: CampaignDraft['channels'][number]['outcomeMetric'] }>;
  conditions: Array<{ kind: CampaignDraft['conditions'][number]['kind']; metric: CampaignDraft['conditions'][number]['metric']; comparator: CampaignDraft['conditions'][number]['comparator']; threshold: number; afterDays: number; statement: string }>;
}): CampaignDraft {
  return {
    name: campaign.name,
    thesis: campaign.thesis,
    whyNow: campaign.whyNow,
    route: campaign.route,
    targetStates: campaign.targetStates,
    buyerProfile: campaign.buyerProfile,
    providerProfile: campaign.providerProfile,
    requiredCapability: campaign.requiredCapability,
    testingHours: campaign.testingHours,
    testingCostCents: campaign.testingCostCents,
    testingCostBasis: campaign.testingCostBasis,
    budgetCents: campaign.budgetCents,
    authorityGrantedById: campaign.authorityGrantedById,
    evidence: campaign.evidence.map((e) => ({
      kind: e.kind as 'SUPPORTING' | 'CONTRARY',
      claim: e.claim,
      evidenceClass: e.evidenceClass,
      sourceUrl: e.sourceUrl,
    })),
    channels: campaign.channels.map((c) => ({
      kind: c.kind,
      enabled: c.enabled,
      budgetCents: c.budgetCents,
      authorisedById: c.authorisedById,
      outcomeMetric: c.outcomeMetric,
    })),
    conditions: campaign.conditions.map((c) => ({
      kind: c.kind,
      metric: c.metric,
      comparator: c.comparator,
      threshold: c.threshold,
      afterDays: c.afterDays,
      statement: c.statement,
    })),
  };
}

export type TransitionResult =
  | { ok: true; state: CampaignState }
  | { ok: false; error: string; blockers?: Array<{ field: string; because: string }> };

/**
 * Moves a campaign between states, refusing when it should not move.
 *
 * The two refusals that matter: nothing starts running until it is complete
 * enough to be judged, and nothing spends until somebody with the authority
 * permission said so by name. A campaign whose channels are authorised for
 * more than the campaign itself is refused, because the parts cannot exceed
 * the whole and discovering that after the money is gone is not a control.
 */
export async function transitionCampaign(params: {
  orgId: string;
  campaignId: string;
  actorId: string;
  /** True when the actor holds `campaign.authorise`. */
  actorMayAuthorise: boolean;
  to: CampaignState;
  reason?: string;
}): Promise<TransitionResult> {
  const { campaign, readiness } = await loadCampaign({ orgId: params.orgId, campaignId: params.campaignId });

  const allowed = canTransition(campaign.state, params.to);
  if (!allowed.ok) return { ok: false, error: allowed.because };

  if (params.to === 'RUNNING') {
    if (!params.actorMayAuthorise) {
      return {
        ok: false,
        error:
          'Starting a campaign commits time and, where a paid channel is enabled, money. That needs somebody '
          + 'with authority to grant it, not whoever happened to open the page.',
      };
    }
    if (!readiness.ready) {
      return {
        ok: false,
        error: `This campaign is not complete enough to run: ${readiness.blockers.length} thing(s) are missing.`,
        blockers: readiness.blockers,
      };
    }
  }

  if ((params.to === 'KILLED' || params.to === 'CONCLUDED') && !params.reason?.trim()) {
    return {
      ok: false,
      error:
        'Ending a campaign without a reason throws away the only thing it produced for certain, which is what '
        + 'was learned. Say why.',
    };
  }

  const updated = await prisma.campaign.update({
    where: { id: campaign.id },
    data: {
      state: params.to,
      startedAt: params.to === 'RUNNING' && !campaign.startedAt ? new Date() : campaign.startedAt,
      endedAt: params.to === 'KILLED' || params.to === 'CONCLUDED' ? new Date() : campaign.endedAt,
      endedReason: params.to === 'KILLED' || params.to === 'CONCLUDED' ? params.reason : campaign.endedReason,
      ...(params.to === 'RUNNING'
        ? { authorityGrantedById: params.actorId, authorityGrantedAt: new Date() }
        : {}),
    },
    select: { state: true },
  });

  await audit({
    orgId: params.orgId,
    userId: params.actorId,
    action: `campaign.${params.to.toLowerCase()}`,
    entityType: 'Campaign',
    entityId: campaign.id,
    metadata: { from: campaign.state, to: params.to, reason: params.reason ?? null },
  });

  return { ok: true, state: updated.state };
}

/**
 * Evaluates every running campaign's conditions and acts on the ones that fire.
 *
 * The point of writing a kill condition down is that it fires without anybody
 * remembering to look. A condition that needed a person to notice it would be
 * a note, not a control.
 */
export async function evaluateCampaignConditions(params: {
  orgId: string;
  actorId: string;
  now?: Date;
}): Promise<Array<{ campaignId: string; name: string; fired: string[]; newState: CampaignState | null }>> {
  const running = await prisma.campaign.findMany({
    where: { orgId: params.orgId, state: { in: ['RUNNING', 'EXPANDED'] } },
    select: { id: true, name: true, state: true },
  });

  const results: Array<{ campaignId: string; name: string; fired: string[]; newState: CampaignState | null }> = [];

  for (const campaign of running) {
    const outcome = await campaignOutcome({ orgId: params.orgId, campaignId: campaign.id, now: params.now });
    const conditions = await prisma.campaign
      .findUniqueOrThrow({ where: { id: campaign.id }, select: { conditions: true } })
      .then((c) => c.conditions);

    const fired: string[] = [];
    let newState: CampaignState | null = null;

    for (const condition of conditions) {
      const evaluation = conditionFires({ condition, outcome });

      await prisma.campaignCondition.update({
        where: { id: condition.id },
        data: {
          lastValue: evaluation.value,
          evaluatedAt: new Date(),
          // Once met, it stays met. A condition that un-fires because a number
          // moved back would let a campaign that should have stopped carry on
          // quietly, which is the failure this exists to prevent.
          met: condition.met || evaluation.fires,
          metAt: condition.met ? condition.metAt : evaluation.fires ? new Date() : null,
        },
      });

      if (evaluation.fires && !condition.met) {
        fired.push(`${condition.kind}: ${condition.statement} (${evaluation.because})`);
        // A kill beats an expansion. Both firing at once means the campaign is
        // producing something and losing money doing it, and the safe reading
        // is to stop and let a person look.
        if (condition.kind === 'KILL') newState = 'KILLED';
        else if (newState !== 'KILLED') newState = 'EXPANDED';
      }
    }

    if (newState) {
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: {
          state: newState,
          endedAt: newState === 'KILLED' ? new Date() : null,
          endedReason: newState === 'KILLED' ? fired.join(' ') : null,
        },
      });
      await audit({
        orgId: params.orgId,
        userId: params.actorId,
        actorType: 'system',
        action: `campaign.${newState.toLowerCase()}`,
        entityType: 'Campaign',
        entityId: campaign.id,
        metadata: { fired, automatic: true },
      });
    }

    results.push({ campaignId: campaign.id, name: campaign.name, fired, newState });
  }

  return results;
}

/**
 * Records spend against a channel, refusing to exceed what was authorised.
 *
 * The budget is a limit rather than a note. A channel that could quietly spend
 * past its authority would make the authority decorative, and the moment it
 * matters is exactly the moment nobody is watching.
 */
export async function recordChannelSpend(params: {
  orgId: string;
  campaignId: string;
  kind: string;
  amountCents: number;
  actorId: string;
}): Promise<{ ok: true; spentCents: number } | { ok: false; error: string }> {
  const channel = await prisma.campaignChannel.findFirst({
    where: { orgId: params.orgId, campaignId: params.campaignId, kind: params.kind as never },
  });
  if (!channel) return { ok: false, error: 'That channel is not on this campaign.' };

  if (needsBudget(channel.kind)) {
    if (!channel.budgetCents || !channel.authorisedById) {
      return {
        ok: false,
        error: `${channel.kind} has no authorised budget, so nothing may be spent on it.`,
      };
    }
    if (channel.spentCents + params.amountCents > channel.budgetCents) {
      return {
        ok: false,
        error:
          `That would take ${channel.kind} to ${money(channel.spentCents + params.amountCents)} against an `
          + `authority of ${money(channel.budgetCents)}. Refused — a budget that can be exceeded is not a budget.`,
      };
    }
  }

  const updated = await prisma.campaignChannel.update({
    where: { id: channel.id },
    data: { spentCents: { increment: params.amountCents } },
    select: { spentCents: true },
  });

  await audit({
    orgId: params.orgId,
    userId: params.actorId,
    action: 'campaign.spend_recorded',
    entityType: 'Campaign',
    entityId: params.campaignId,
    metadata: { channel: channel.kind, amountCents: params.amountCents, spentCents: updated.spentCents },
  });

  return { ok: true, spentCents: updated.spentCents };
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
