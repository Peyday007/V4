import type { DataMode } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
  BUCKET_EXPLANATIONS, BUCKET_LABELS, bucketsForRoutes, callableRouteIds,
  eligibilityCounts, type EligibilityBucket,
} from '@/lib/demand/eligibility';
import { resolveVersion } from '@/lib/measure/versions';
import { buildPacket, type PacketPlan } from './packets';
import { requireCaller } from './roster';

/**
 * Look before you assign.
 *
 * The button this replaces said "Assign 25" and did it — no list, no
 * exclusions, no indication of what the caller was about to be handed. An owner
 * pressing it learned what had happened by reloading the page, and if it had
 * taken twenty-five research tasks with no phone numbers, they learned that
 * from the caller an hour later.
 *
 * Preview is a pure read. It runs the same selection the confirm step runs, on
 * the same canonical eligibility expression, and returns the exact route ids so
 * that confirming assigns what was shown rather than re-querying and getting a
 * different answer a minute later. Nothing in this file writes until
 * `confirmAssignment`, and previewing the same set twice changes nothing.
 */

export type ExclusionReason = {
  bucket: EligibilityBucket | 'ALREADY_ASSIGNED' | 'WRONG_MODE';
  label: string;
  because: string;
  count: number;
};

export type AssignmentPreview = {
  callerId: string;
  callerName: string;
  mode: DataMode;
  requested: number;
  /** What would actually be assigned, in order. */
  routeIds: string[];
  rows: Array<{
    routeId: string;
    organisation: string;
    headline: string;
    tier: string;
    route: string;
    stateCode: string | null;
    capability: string | null;
  }>;
  /** Everything considered and left out, with the reason and the count. */
  excluded: ExclusionReason[];
  /** The mix, so an owner can see they are not handing over twenty of one thing. */
  mix: { tier: Record<string, number>; route: Record<string, number>; state: Record<string, number> };
  /** The whole pool, by bucket, so the shortfall has an explanation. */
  pool: Awaited<ReturnType<typeof eligibilityCounts>>;
  versions: { script: string | null; process: string | null; offer: string | null };
  /** Said plainly when fewer are available than were asked for. */
  shortfall: string | null;
};

/**
 * What would happen, without anything happening.
 *
 * `now` is threaded through to the eligibility expression so a preview and its
 * confirmation agree even across a minute boundary, and so tests can ask about
 * a specific hour in a specific timezone.
 */
export async function previewAssignment(params: {
  orgId: string;
  callerId: string;
  requested: number;
  now?: Date;
}): Promise<AssignmentPreview | { error: string }> {
  const caller = await requireCaller(params.orgId, params.callerId);
  if ('message' in caller) return { error: caller.message };

  const mode = caller.mode;

  // The pool in the caller's own world. A test caller previews test work and a
  // production caller previews real work; there is no parameter that lets the
  // page ask for the other one.
  const pool = await eligibilityCounts({ orgId: params.orgId, mode, now: params.now });

  const routeIds = await callableRouteIds({
    orgId: params.orgId,
    mode,
    limit: params.requested,
    unassignedOnly: true,
    now: params.now,
  });

  const rows = routeIds.length === 0 ? [] : await prisma.routeHypothesis.findMany({
    where: { id: { in: routeIds } },
    select: {
      id: true, headline: true, tier: true, route: true, requiredCapability: true,
      company: { select: { legalName: true, operatingName: true, stateCode: true } },
      event: { select: { stateCode: true } },
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));

  const ordered = routeIds
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => Boolean(r))
    .map((r) => ({
      routeId: r.id,
      organisation: r.company.operatingName ?? r.company.legalName,
      headline: r.headline,
      tier: r.tier,
      route: r.route,
      stateCode: r.company.stateCode ?? r.event.stateCode ?? null,
      capability: r.requiredCapability,
    }));

  // Exclusions read straight off the pool: every bucket that is not callable is
  // a reason some record did not make it, with the count and the sentence.
  const excluded: ExclusionReason[] = [];
  for (const bucket of ['WAITING_FOR_HOURS', 'RESEARCH_NEEDED', 'FUTURE_FOLLOW_UP', 'QUALIFIED', 'NOT_PRIORITISED', 'BLOCKED'] as const) {
    const count = pool[bucket];
    if (count > 0) {
      excluded.push({
        bucket, count,
        label: BUCKET_LABELS[bucket],
        because: BUCKET_EXPLANATIONS[bucket],
      });
    }
  }
  if (pool.callableAssigned > 0) {
    excluded.push({
      bucket: 'ALREADY_ASSIGNED',
      count: pool.callableAssigned,
      label: 'Already being worked',
      because: 'Somebody else is holding these right now. Two callers ringing one company is the failure the packet lock exists to prevent.',
    });
  }

  const mix = { tier: {} as Record<string, number>, route: {} as Record<string, number>, state: {} as Record<string, number> };
  for (const row of ordered) {
    mix.tier[row.tier] = (mix.tier[row.tier] ?? 0) + 1;
    mix.route[row.route] = (mix.route[row.route] ?? 0) + 1;
    const key = row.stateCode ?? 'unknown';
    mix.state[key] = (mix.state[key] ?? 0) + 1;
  }

  // Recorded on the packet so a result is interpretable against the script and
  // copy that were in force when the work was done, rather than against
  // whatever is live when somebody reads the numbers months later.
  const [script, outreach] = await Promise.all([
    resolveVersion({ orgId: params.orgId, kind: 'CALL_SCRIPT', key: 'default', codeDefault: '' })
      .catch(() => null),
    resolveVersion({ orgId: params.orgId, kind: 'OUTREACH_COPY', key: 'default', codeDefault: '' })
      .catch(() => null),
  ]);

  return {
    callerId: caller.id,
    callerName: caller.name,
    mode,
    requested: params.requested,
    routeIds: ordered.map((r) => r.routeId),
    rows: ordered,
    excluded,
    mix,
    pool,
    versions: {
      script: script?.version ? `v${script.version.version}` : null,
      process: script?.source ?? null,
      offer: outreach?.version ? `v${outreach.version.version}` : null,
    },
    shortfall: ordered.length < params.requested
      ? `Asked for ${params.requested}, found ${ordered.length}. The rest of the pool is listed below with the reason each part of it is not callable right now — the commonest is that it is outside business hours where those buyers are.`
      : null,
  };
}

/**
 * Assign exactly what was previewed.
 *
 * The route ids come from the preview rather than being re-selected, so what
 * the owner agreed to is what the caller gets. Each one is re-checked against
 * the canonical expression immediately before the write, because a preview held
 * open for ten minutes can go stale — a record can be snoozed, suppressed or
 * claimed by another caller in between, and assigning it then would be assigning
 * something the owner was never shown.
 */
export async function confirmAssignment(params: {
  orgId: string;
  actorId: string;
  callerId: string;
  routeIds: string[];
  name?: string;
  now?: Date;
}): Promise<{ ok: true; plan: PacketPlan; dropped: ExclusionReason[] } | { ok: false; error: string }> {
  const caller = await requireCaller(params.orgId, params.callerId);
  if ('message' in caller) return { ok: false, error: caller.message };
  if (params.routeIds.length === 0) return { ok: false, error: 'Nothing was selected to assign.' };

  const buckets = await bucketsForRoutes({
    orgId: params.orgId, routeIds: params.routeIds, now: params.now,
  });

  // The mode check is belt to the trigger's braces: the database refuses a
  // crossing outright, and this turns that refusal into a sentence.
  const modes = await prisma.routeHypothesis.findMany({
    where: { id: { in: params.routeIds }, orgId: params.orgId },
    select: { id: true, dataMode: true },
  });
  const modeById = new Map(modes.map((m) => [m.id, m.dataMode]));

  const keep: string[] = [];
  const droppedBy = new Map<string, number>();
  const note = (key: string) => droppedBy.set(key, (droppedBy.get(key) ?? 0) + 1);

  for (const routeId of params.routeIds) {
    const state = buckets.get(routeId);
    if (!state) { note('MISSING'); continue; }
    if (modeById.get(routeId) !== caller.mode) { note('WRONG_MODE'); continue; }
    if (state.assigned) { note('ALREADY_ASSIGNED'); continue; }
    if (state.bucket !== 'CALLABLE_NOW') { note(state.bucket); continue; }
    keep.push(routeId);
  }

  if (keep.length === 0) {
    return {
      ok: false,
      error: 'Nothing in that selection is still callable. It has changed since the preview — reload and look again rather than assigning blind.',
    };
  }

  const plan = await buildPacket({
    orgId: params.orgId,
    callerId: params.callerId,
    name: params.name?.trim() || `${caller.name.split(' ')[0]} — ${new Date().toISOString().slice(0, 10)}`,
    routeIds: keep,
    dataMode: caller.mode,
    assignedByUserId: params.actorId,
  });

  const dropped: ExclusionReason[] = [...droppedBy.entries()].map(([key, count]) => ({
    bucket: key as ExclusionReason['bucket'],
    count,
    label: key === 'ALREADY_ASSIGNED' ? 'Claimed by somebody else since the preview'
      : key === 'WRONG_MODE' ? 'The wrong world'
        : key === 'MISSING' ? 'No longer on this account'
          : BUCKET_LABELS[key as EligibilityBucket] ?? key,
    because: key === 'ALREADY_ASSIGNED'
      ? 'Another caller took it between the preview and the confirmation.'
      : key === 'WRONG_MODE'
        ? 'A test caller cannot be handed real opportunities, and a production caller cannot be handed sandbox ones.'
        : BUCKET_EXPLANATIONS[key as EligibilityBucket] ?? 'Not callable at the moment of assignment.',
  }));

  return { ok: true, plan, dropped };
}
