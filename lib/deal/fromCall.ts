import type { CallDisposition, SignalCategory } from '@prisma/client';
import { prisma } from '@/lib/db';
import { captureRequirement, requirementFromDiscovery, withdrawRequirement } from './requirement';
import { syncCandidatesFromMatching, supplyPosture } from './provider';

/**
 * What a saved call does to the deal underneath it.
 *
 * Runs automatically after every attempt. There is no "convert to opportunity"
 * button, because a stage that should run automatically and instead waits for a
 * click is a stage that does not happen — and because the caller has already
 * typed everything this needs. Asking them to type it again into a second form
 * is how two records of the same conversation start to disagree.
 *
 * Nothing here can fail the caller's save. The attempt is already written and
 * is the record of the call; this is downstream work on top of it. When it
 * breaks, an incident is raised so somebody sees it, and the caller carries on.
 */

/** Outcomes where the buyer told us something about what they need. */
const LEARNED_SOMETHING: CallDisposition[] = [
  'NEED_CONFIRMED',
  'QUOTE_REQUESTED',
  'QUALIFIED_OPPORTUNITY',
  'REACHED_DECISION_MAKER',
  'DECISION_MAKER_IDENTIFIED',
  'INTERESTED',
  'NEEDS_INFORMATION',
  'FOLLOW_UP',
  'REACHED_RELEVANT_PERSON',
];

/** Outcomes where they told us there is no requirement. */
const TOLD_US_NO: CallDisposition[] = ['NEED_UNCONFIRMED', 'NOT_INTERESTED', 'BAD_FIT', 'ALREADY_HANDLED'];

export type ProgressResult = {
  requirement: 'created' | 'versioned' | 'merged' | 'unchanged' | 'withdrawn' | 'none';
  declinedOverwrites: string[];
  providerCandidatesAdded: number;
  /** Set when the route now needs a price and does not have a live one. */
  pricingTaskId: string | null;
  /** Set when nobody can fulfil this and a sourcing task was raised. */
  sourcingTaskId: string | null;
  /** Populated when this ran into trouble; never thrown at the caller. */
  incidentId: string | null;
};

export async function progressFromCall(params: {
  orgId: string;
  routeId: string;
  route: SignalCategory | string;
  disposition: CallDisposition;
  discovery: Record<string, unknown>;
  attemptId: string;
  actorId?: string | null;
  now?: Date;
}): Promise<ProgressResult> {
  const result: ProgressResult = {
    requirement: 'none',
    declinedOverwrites: [],
    providerCandidatesAdded: 0,
    pricingTaskId: null,
    sourcingTaskId: null,
    incidentId: null,
  };

  try {
    // --- the buyer side --------------------------------------------------
    if (TOLD_US_NO.includes(params.disposition)) {
      const reason = typeof params.discovery.disqualifyReason === 'string' && params.discovery.disqualifyReason.trim()
        ? params.discovery.disqualifyReason.trim()
        : `Buyer outcome: ${params.disposition.toLowerCase().replace(/_/g, ' ')}.`;
      const withdrawn = await withdrawRequirement({
        orgId: params.orgId,
        routeId: params.routeId,
        reason,
        actorId: params.actorId,
      });
      if (withdrawn) result.requirement = 'withdrawn';
      return result;
    }

    if (LEARNED_SOMETHING.includes(params.disposition)) {
      const input = requirementFromDiscovery(params.route, params.discovery);
      if (input) {
        // Asking for a price is itself a fact about how they buy, and it is
        // the point at which the economics stop being ours to imagine.
        if (params.disposition === 'QUOTE_REQUESTED') {
          input.budgetMechanism = 'QUOTE_REQUESTED';
          input.confirmed = Array.from(new Set([...input.confirmed, 'budgetMechanism']));
        }

        const captured = await captureRequirement({
          orgId: params.orgId,
          routeId: params.routeId,
          input,
          actorId: params.actorId,
          capturedBy: 'caller',
          sourceAttemptId: params.attemptId,
          evidence: `Call outcome ${params.disposition}.`,
        });
        result.requirement = captured.action;
        result.declinedOverwrites = captured.declinedOverwrites;
      }
    }

    // --- the supply side -------------------------------------------------
    //
    // Run whatever the outcome, as long as the route is still live: knowing
    // whether we could deliver is useful before the buyer confirms, not after.
    const sync = await syncCandidatesFromMatching({ orgId: params.orgId, routeId: params.routeId });
    result.providerCandidatesAdded = sync.added;

    const candidates = await prisma.providerCandidate.findMany({ where: { routeId: params.routeId } });
    const posture = supplyPosture(candidates, params.now);

    if (posture.liveCount === 0) {
      result.sourcingTaskId = await ensureTask({
        orgId: params.orgId,
        routeId: params.routeId,
        kind: 'provider_sourcing',
        title: 'Find a provider for a confirmed requirement',
        description:
          'A caller has confirmed real demand on this route and there is no live provider candidate for it. '
          + 'The demand stays open — this is a supply gap, not a bad lead. Automatic matching has already searched '
          + 'the provider catalogue and found nobody, so this needs a person to recruit one.',
        priority: 'HIGH',
      });
    }

    // --- pricing ----------------------------------------------------------
    if (params.disposition === 'QUOTE_REQUESTED') {
      const liveQuote = await prisma.routeQuote.findFirst({
        where: { routeId: params.routeId, state: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT'] } },
        select: { id: true },
      });
      if (!liveQuote) {
        result.pricingTaskId = await ensureTask({
          orgId: params.orgId,
          routeId: params.routeId,
          kind: 'pricing',
          title: 'Price a requested quote',
          description:
            'The buyer asked for a price. The requirement they described is on the route record. A price cannot '
            + 'be sent until a provider cost backs it, so this may need the provider workstream moved along first.',
          priority: 'HIGH',
        });
      }
    }

    return result;
  } catch (error) {
    // Visible, not swallowed. The call itself is already safely recorded.
    const incident = await prisma.workIncident.create({
      data: {
        orgId: params.orgId,
        callerId: params.actorId ?? null,
        routeId: params.routeId,
        kind: 'INTEGRATION_FAILURE',
        detail: `Deal progression after a saved call failed: ${String(error).slice(0, 1500)}`,
        preserved: { attemptId: params.attemptId, disposition: params.disposition },
      },
      select: { id: true },
    });
    result.incidentId = incident.id;
    return result;
  }
}

/**
 * One open task per route and kind.
 *
 * Re-raising it on every call would bury the owner's list under the same job
 * written forty times, which is the same as having no list.
 */
async function ensureTask(input: {
  orgId: string;
  routeId: string;
  kind: string;
  title: string;
  description: string;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}): Promise<string> {
  const existing = await prisma.task.findFirst({
    where: { orgId: input.orgId, routeId: input.routeId, kind: input.kind, status: { in: ['OPEN', 'IN_PROGRESS'] } },
    select: { id: true },
  });
  if (existing) return existing.id;

  const created = await prisma.task.create({
    data: {
      orgId: input.orgId,
      routeId: input.routeId,
      kind: input.kind,
      title: input.title,
      description: input.description,
      priority: input.priority,
      createdByProcess: 'deal_progression',
    },
    select: { id: true },
  });
  return created.id;
}
