import { prisma } from '@/lib/db';
import { audit } from '@/lib/audit';
import { buildPacket } from '@/lib/caller/packets';
import { campaignOutcome, type CampaignOutcome } from './outcomes';
import { metricValue } from './outcomes';

/**
 * A campaign reaching a caller's morning.
 *
 * Everything else about campaigns worked: a thesis with evidence against it, a
 * budget with an authority behind it, research the campaign runs on its own,
 * conditions that stop it. And the routes it generated sat on the board like
 * any other, indistinguishable from the demand engine's, so the campaign could
 * be judged on outcomes it had no way of causing.
 *
 * Two things here. First, the campaign's own work becomes a caller's packet,
 * with the thesis and the questions attached, so somebody calling for a
 * campaign is calling *for that campaign* rather than working a queue. Second,
 * a campaign states what it is trying to reach, from its own conditions rather
 * than from a number typed into a box — and progress against that is a count
 * with days remaining beside it, so a campaign going quietly nowhere is visible
 * before its kill date rather than at it.
 */

// ---------------------------------------------------------------------------
// What a campaign is trying to reach
// ---------------------------------------------------------------------------

export type CampaignTarget = {
  metric: string;
  /** The number that would show this is working. */
  target: number;
  /** Where it is now. */
  current: number;
  /** Days until the condition that reads this applies. */
  daysUntilJudged: number | null;
  /** Whether it is a threshold to clear or one to stay above. */
  kind: 'EXPAND' | 'KILL';
  statement: string;
  /** Written for the operator: where this stands, in a sentence. */
  standing: string;
};

/**
 * A campaign's targets, taken from its own kill and expand conditions.
 *
 * Deliberately not a separate field somebody types. A target nobody has
 * attached a consequence to is a wish, and this product already makes the owner
 * state the consequences before a campaign may run — so the thresholds already
 * on the record *are* the targets, and deriving them means the two can never
 * disagree.
 */
export function campaignTargets(input: {
  conditions: Array<{
    kind: string;
    metric: string;
    comparator: string;
    threshold: number;
    afterDays: number;
    statement: string;
  }>;
  outcome: CampaignOutcome;
}): CampaignTarget[] {
  return input.conditions.map((condition) => {
    const current = metricValue(condition.metric as never, input.outcome) ?? 0;
    const daysUntilJudged = Math.max(0, condition.afterDays - input.outcome.daysRunning);
    const kind = condition.kind === 'KILL' ? 'KILL' : 'EXPAND';

    // The sentence is the whole value of this. "3 of 3" tells an operator
    // nothing about whether to worry; "3 of 3, and the kill date is Tuesday"
    // tells them what to do this week.
    const standing =
      kind === 'KILL'
        ? current > condition.threshold
          ? `Clear of this. ${current} against a floor of ${condition.threshold}.`
          : daysUntilJudged > 0
            ? `${current} against a floor of ${condition.threshold}, with ${daysUntilJudged} day(s) before this `
              + 'applies. On today\'s numbers it would stop the campaign.'
            : `${current} against a floor of ${condition.threshold}. This condition applies now.`
        : current >= condition.threshold
          ? `Reached. ${current} against ${condition.threshold}.`
          : `${current} of ${condition.threshold}`
            + (daysUntilJudged > 0 ? `, ${daysUntilJudged} day(s) before this is read.` : '.');

    return {
      metric: condition.metric,
      target: condition.threshold,
      current,
      daysUntilJudged: condition.afterDays > 0 ? daysUntilJudged : null,
      kind,
      statement: condition.statement,
      standing,
    };
  });
}

// ---------------------------------------------------------------------------
// Getting the work to a person
// ---------------------------------------------------------------------------

export type CampaignAssignmentPreview = {
  campaignId: string;
  campaignName: string;
  /** Routes this campaign produced that a caller could work now. */
  assignable: Array<{ routeId: string; organisation: string; headline: string; tier: string }>;
  /** Routes this campaign produced that are not assignable, and why. */
  withheld: Array<{ routeId: string; organisation: string; because: string }>;
  /** What the caller would be told the campaign is trying to establish. */
  objective: string;
  /** Why nothing can be assigned at all, when nothing can. */
  blocker: string | null;
};

/**
 * What would be handed to a caller, without handing it to them.
 *
 * Scoped to this campaign's own routes rather than to the general pool. The
 * distinction is the point: a caller working a campaign is testing a thesis,
 * and the answers they bring back are only attributable if the work came from
 * the campaign in the first place.
 */
export async function previewCampaignAssignment(params: {
  orgId: string;
  campaignId: string;
}): Promise<CampaignAssignmentPreview | { error: string }> {
  const campaign = await prisma.campaign.findFirst({
    where: { id: params.campaignId, orgId: params.orgId },
    select: {
      id: true,
      name: true,
      state: true,
      thesis: true,
      dataMode: true,
      channels: { select: { kind: true, enabled: true } },
    },
  });
  if (!campaign) return { error: 'No such campaign on this account.' };

  const calling = campaign.channels.find((c) => c.kind === 'CALLING');
  const objective =
    `Testing: ${campaign.thesis.slice(0, 400)}${campaign.thesis.length > 400 ? '…' : ''}`;

  // A campaign that is not running must not put work in front of anybody. A
  // draft is a thought and a paused campaign is a decision.
  if (campaign.state !== 'RUNNING' && campaign.state !== 'EXPANDED') {
    return {
      campaignId: campaign.id,
      campaignName: campaign.name,
      assignable: [],
      withheld: [],
      objective,
      blocker:
        `This campaign is ${campaign.state.toLowerCase()}. Only a running campaign may take somebody's morning.`,
    };
  }
  if (!calling?.enabled) {
    return {
      campaignId: campaign.id,
      campaignName: campaign.name,
      assignable: [],
      withheld: [],
      objective,
      blocker: 'Calling is not enabled on this campaign, so there is no channel to assign work through.',
    };
  }

  const routes = await prisma.routeHypothesis.findMany({
    where: { orgId: params.orgId, campaignId: campaign.id },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true,
      headline: true,
      tier: true,
      status: true,
      company: { select: { legalName: true, operatingName: true, phone: true, contacts: { select: { phone: true, mobile: true, email: true }, take: 3 } } },
      packetItems: { where: { status: { in: ['PENDING', 'IN_PROGRESS'] } }, select: { id: true } },
    },
  });

  const assignable: CampaignAssignmentPreview['assignable'] = [];
  const withheld: CampaignAssignmentPreview['withheld'] = [];

  for (const route of routes) {
    const organisation = route.company.operatingName ?? route.company.legalName;

    if (['EXPIRED', 'REJECTED', 'COLD'].includes(route.status)) {
      withheld.push({ routeId: route.id, organisation, because: `The route is ${route.status.toLowerCase()}.` });
      continue;
    }
    if (route.packetItems.length > 0) {
      withheld.push({
        routeId: route.id,
        organisation,
        because: 'Somebody is already working this organisation. One owner per account, always.',
      });
      continue;
    }
    const reachable =
      Boolean(route.company.phone) || route.company.contacts.some((c) => c.phone || c.mobile || c.email);
    if (!reachable) {
      withheld.push({
        routeId: route.id,
        organisation,
        because: 'No published number or address, so there is nothing for a caller to ring.',
      });
      continue;
    }
    assignable.push({ routeId: route.id, organisation, headline: route.headline, tier: route.tier });
  }

  return {
    campaignId: campaign.id,
    campaignName: campaign.name,
    assignable,
    withheld,
    objective,
    blocker:
      assignable.length === 0 && routes.length === 0
        ? 'This campaign has produced no routes yet. There is nothing to hand to anybody.'
        : null,
  };
}

/**
 * Hands a campaign's work to a caller, as a packet that says what it is for.
 *
 * The discovery objective is the campaign's thesis, so the person on the phone
 * knows they are testing a claim rather than working a list. That is not
 * decoration: a caller who knows the thesis asks the question that would
 * disprove it, and a caller who does not asks whether they need anything today.
 */
export async function assignCampaignWork(params: {
  orgId: string;
  campaignId: string;
  callerId: string;
  actorId: string;
  limit?: number;
}): Promise<
  | { ok: true; packetId: string; assigned: number; withheld: number }
  | { ok: false; error: string }
> {
  const preview = await previewCampaignAssignment(params);
  if ('error' in preview) return { ok: false, error: preview.error };
  if (preview.blocker) return { ok: false, error: preview.blocker };
  if (preview.assignable.length === 0) {
    return {
      ok: false,
      error:
        'Every route this campaign produced is either being worked, unreachable or closed. '
        + `${preview.withheld.length} withheld, each with its reason.`,
    };
  }

  const routeIds = preview.assignable.slice(0, params.limit ?? 20).map((r) => r.routeId);

  const packet = await buildPacket({
    orgId: params.orgId,
    callerId: params.callerId,
    name: `${preview.campaignName}`.slice(0, 200),
    routeIds,
    assignedByUserId: params.actorId,
    // The thesis travels with the work. A caller testing a claim asks the
    // question that would disprove it.
    discoveryObjective: preview.objective,
    experimentCohort: `campaign:${params.campaignId}`,
  });

  await audit({
    orgId: params.orgId,
    userId: params.actorId,
    action: 'campaign.work_assigned',
    entityType: 'Campaign',
    entityId: params.campaignId,
    metadata: { callerId: params.callerId, assigned: packet.items, withheld: preview.withheld.length },
  });

  return { ok: true, packetId: packet.packetId, assigned: packet.items, withheld: preview.withheld.length };
}

/** Targets and progress for one campaign, loaded together. */
export async function campaignProgress(params: {
  orgId: string;
  campaignId: string;
}): Promise<{ outcome: CampaignOutcome; targets: CampaignTarget[] } | null> {
  const conditions = await prisma.campaignCondition.findMany({
    where: { orgId: params.orgId, campaignId: params.campaignId },
    select: { kind: true, metric: true, comparator: true, threshold: true, afterDays: true, statement: true },
  });
  const outcome = await campaignOutcome({ orgId: params.orgId, campaignId: params.campaignId });
  if (!outcome) return null;
  return { outcome, targets: campaignTargets({ conditions, outcome }) };
}
