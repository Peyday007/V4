import type { DemandEventType } from '@prisma/client';
import { prisma } from '@/lib/db';
import { DEFAULT_JURISDICTIONS } from '@/lib/demand/connectors/municipalOpenData';
import { DEFAULT_SOLICITATION_DATASETS } from '@/lib/demand/connectors/municipalSolicitations';
import { playbookByKey, type Playbook } from '@/lib/demand/playbooks';
import { MINI_PATHS, type MiniPath, type MiniPathKey } from './registry';

/**
 * Whether a path actually works, decided by evidence rather than by a label.
 *
 * The temptation with a registry this size is to hand-write a status field, and
 * that field would be wrong within a week and wrong invisibly. Two of the eight
 * failure patterns this product keeps hitting are exactly that: logic that
 * exists but nothing calls, and an "operational" label unsupported by
 * production evidence.
 *
 * So nothing here is asserted. Each path is put through five questions that can
 * only be answered from the shipped configuration and the database, and the
 * answer decides the state:
 *
 *   Does it have a playbook? Without one there are no qualification rules, no
 *   evidence threshold, no call script and no disqualifiers — it is a name.
 *
 *   Can anything currently reach it? A playbook whose qualifying events no
 *   working source produces cannot fire, however well written it is.
 *
 *   Does it have both commercial sides? A path that knows who buys but not who
 *   delivers is half a deal and cannot be quoted.
 *
 *   Is there an operator action? Somebody has to be able to do the first thing.
 *
 *   Has it ever produced a real production record? The difference between
 *   "should work" and "works".
 *
 * The intended result is that most paths honestly report that they are
 * declarations. That is the point.
 */

export type OperationalState =
  | 'OPERATIONAL'
  | 'PARTIAL'
  | 'NEEDS_CONFIGURATION'
  | 'TAXONOMY_ONLY'
  | 'DISABLED';

export type Requirement = {
  key: string;
  question: string;
  met: boolean;
  /** What is true right now. Shown whether met or not, so it can be checked. */
  finding: string;
};

export type MiniPathAssessment = {
  path: MiniPath;
  state: OperationalState;
  requirements: Requirement[];
  /** What this path can currently discover, in the operator's language. */
  canDiscover: string;
  /** What runs without a person. */
  automatic: string;
  /** What a person must do. */
  human: string;
  /** The exact reason it is not operational, or null when it is. */
  because: string | null;
  /** The exact next action that would move it forward, or null. */
  toActivate: string | null;
  /** Real records, never estimates. */
  observed: PathObservation;
};

export type PathObservation = {
  routes: number;
  qualifiedOpportunities: number;
  quotes: number;
  wins: number;
  completions: number;
  collectedGrossProfit: number;
  lastRecordAt: Date | null;
};

const EMPTY_OBSERVATION: PathObservation = {
  routes: 0,
  qualifiedOpportunities: 0,
  quotes: 0,
  wins: 0,
  completions: 0,
  collectedGrossProfit: 0,
  lastRecordAt: null,
};

// ---------------------------------------------------------------------------
// What the collection layer can currently reach
// ---------------------------------------------------------------------------

export type SourceReachability = {
  /** Event types a currently-working configured source produces. */
  reachable: Set<DemandEventType>;
  /**
   * Event types a source is configured for but cannot currently deliver, with
   * why. This is the difference between "we do not collect that" and "we tried
   * and something is in the way", and it decides NEEDS_CONFIGURATION.
   */
  blocked: Map<DemandEventType, string>;
};

/**
 * Read from the shipped connector configuration, not from what has been
 * collected, so the answer is honest on an empty database — which is exactly
 * when somebody needs it.
 */
export function sourceReachability(): SourceReachability {
  const reachable = new Set<DemandEventType>();
  const blocked = new Map<DemandEventType, string>();

  for (const jurisdiction of DEFAULT_JURISDICTIONS) {
    if (jurisdiction.unusableReason) {
      if (!blocked.has(jurisdiction.eventType)) blocked.set(jurisdiction.eventType, jurisdiction.unusableReason);
    } else {
      reachable.add(jurisdiction.eventType);
    }
  }

  for (const dataset of DEFAULT_SOLICITATION_DATASETS) {
    // An award register and a notice board are different events even though
    // they arrive through the same connector, so the reachability answer has to
    // follow `publishes` rather than the connector's name.
    const type: DemandEventType =
      dataset.publishes === 'AWARDED_CONTRACT' ? 'CONTRACT_AWARD' : 'PROCUREMENT_NOTICE';
    if (dataset.unusableReason) {
      if (!blocked.has(type)) blocked.set(type, dataset.unusableReason);
    } else {
      reachable.add(type);
    }
  }

  // First-party. There is no upstream to break, so it is always reachable —
  // an empty queue is an empty queue, not a fault.
  reachable.add('INBOUND_REQUEST');

  // Federal award records. Configured, and answered by a network filter rather
  // than by the API, which is a configuration problem rather than a quiet week.
  if (!reachable.has('CONTRACT_AWARD')) {
    blocked.set(
      'CONTRACT_AWARD',
      'A network filter in front of USAspending answers instead of the API, so federal award records cannot '
      + 'be collected from this deployment.',
    );
  }

  // Anything the reachable set covers is not blocked, whatever else failed.
  for (const type of reachable) blocked.delete(type);

  return { reachable, blocked };
}

// ---------------------------------------------------------------------------
// The assessment
// ---------------------------------------------------------------------------

export function assessMiniPath(input: {
  path: MiniPath;
  playbook: Playbook | undefined;
  reach: SourceReachability;
  observed: PathObservation;
  disabled?: boolean;
}): MiniPathAssessment {
  const { path, playbook, reach, observed } = input;

  const qualifying = playbook?.qualifyingEvents ?? [];
  const reachableEvents = qualifying.filter((e) => reach.reachable.has(e));
  const blockedEvents = qualifying.filter((e) => reach.blocked.has(e));

  const requirements: Requirement[] = [
    {
      key: 'playbook',
      question: 'Does it have a playbook — qualification rules, questions and disqualifiers?',
      met: Boolean(playbook),
      finding: playbook
        ? `Playbook ${playbook.key}, with ${playbook.verificationQuestions.length} verification question(s) and `
          + `${playbook.rejectionConditions.length} disqualifier(s).`
        : 'No playbook. This is a declared path with no rules behind it, so nothing can qualify through it.',
    },
    {
      key: 'acquisition',
      question: 'Can a working source currently produce the events it needs?',
      met: reachableEvents.length > 0,
      finding: !playbook
        ? 'Cannot be assessed without a playbook to say which events it needs.'
        : reachableEvents.length > 0
          ? `Reachable now through ${reachableEvents.map(humanEvent).join(', ')}.`
          : blockedEvents.length > 0
            ? `Configured for ${blockedEvents.map(humanEvent).join(', ')}, and every source for those is blocked.`
            : `Needs ${qualifying.map(humanEvent).join(', ')}, and no configured source produces any of them.`,
    },
    {
      key: 'both_sides',
      question: 'Does it know who buys and who delivers?',
      met: Boolean(playbook && playbook.requiredCapability && playbook.likelyBuyerRoles.length > 0),
      finding: playbook
        ? `Buying roles: ${playbook.likelyBuyerRoles.join(', ') || 'none stated'}. `
          + `Supply capability: ${playbook.requiredCapability || 'none stated'}.`
        : 'Not stated.',
    },
    {
      key: 'operator_action',
      question: 'Is there a first action a person can actually take?',
      met: Boolean(playbook?.firstAction),
      finding: playbook?.firstAction ?? 'No first action defined.',
    },
    {
      key: 'production_record',
      question: 'Has it produced a real production record?',
      met: observed.routes > 0,
      finding: observed.routes > 0
        ? `${observed.routes} route(s), ${observed.qualifiedOpportunities} qualified, ${observed.quotes} quote(s), `
          + `${observed.wins} win(s). Last record ${observed.lastRecordAt?.toISOString().slice(0, 10) ?? 'unknown'}.`
        : 'Nothing has ever come through this path in production.',
    },
  ];

  const state = decideState({ requirements, disabled: input.disabled, blocked: blockedEvents.length > 0 });
  const failing = requirements.filter((r) => !r.met);

  return {
    path,
    state,
    requirements,
    canDiscover: playbook
      ? reachableEvents.length > 0
        ? `${reachableEvents.map(humanEvent).join(', ')} — in ${describeGeography(reachableEvents)}.`
        : 'Nothing, because no working source produces the events it depends on.'
      : 'Nothing. It has no playbook, so no event can be matched to it.',
    automatic: playbook
      ? 'Collection, deduplication, organisation resolution, route creation, contact resolution where a number '
        + 'is published, and the follow-up schedule.'
      : 'Nothing.',
    human: playbook
      ? `${playbook.firstAction} Then the ${playbook.verificationQuestions.length} verification question(s) on a call.`
      : 'Everything, because nothing is defined.',
    because: state === 'OPERATIONAL' ? null : reasonFor(state, failing, blockedEvents, reach),
    toActivate: state === 'OPERATIONAL' ? null : actionFor(state, failing, blockedEvents, reach, path),
    observed,
  };
}

function decideState(input: {
  requirements: Requirement[];
  disabled?: boolean;
  blocked: boolean;
}): OperationalState {
  if (input.disabled) return 'DISABLED';

  const met = (key: string) => input.requirements.find((r) => r.key === key)?.met ?? false;

  // No playbook is the floor. Everything else is irrelevant until there is one.
  if (!met('playbook')) return 'TAXONOMY_ONLY';

  // A path whose sources are configured and blocked is a different problem from
  // one nobody has built a source for: the first needs an owner action, the
  // second needs engineering. Saying so is the whole value of this state.
  if (!met('acquisition')) return input.blocked ? 'NEEDS_CONFIGURATION' : 'PARTIAL';

  if (!met('both_sides') || !met('operator_action')) return 'PARTIAL';

  // Everything is wired and reachable but nothing has come through. That is
  // "ready" rather than "working", and the distinction is the one this product
  // keeps getting wrong.
  if (!met('production_record')) return 'PARTIAL';

  return 'OPERATIONAL';
}

function reasonFor(
  state: OperationalState,
  failing: Requirement[],
  blockedEvents: DemandEventType[],
  reach: SourceReachability,
): string {
  if (state === 'DISABLED') return 'Turned off deliberately.';
  if (state === 'TAXONOMY_ONLY') {
    return 'It is a declared commercial path with no playbook behind it: no qualification rules, no evidence '
      + 'threshold, no call questions and no disqualifiers. It exists here so the universe is honest about what '
      + 'this business could do, not to suggest it currently does it.';
  }
  if (state === 'NEEDS_CONFIGURATION') {
    const why = blockedEvents.map((e) => reach.blocked.get(e)).filter(Boolean);
    return `Its playbook is complete, but every source that could feed it is blocked. ${why[0] ?? ''}`.trim();
  }
  return failing.map((f) => f.finding).join(' ');
}

function actionFor(
  state: OperationalState,
  failing: Requirement[],
  blockedEvents: DemandEventType[],
  reach: SourceReachability,
  path: MiniPath,
): string {
  if (state === 'DISABLED') return 'Re-enable it if this business should be doing this.';
  if (state === 'TAXONOMY_ONLY') {
    return `Write a job-generation playbook for ${path.label}: what evidence proves demand, which sources carry `
      + 'it, who buys, who delivers, the qualification questions and the disqualifiers.';
  }
  if (state === 'NEEDS_CONFIGURATION') {
    const first = blockedEvents.map((e) => reach.blocked.get(e)).find(Boolean);
    return `Unblock the source. ${first ?? ''}`.trim();
  }
  const stillFailing = failing.find((f) => f.key === 'production_record');
  if (stillFailing && failing.length === 1) {
    return 'Everything is wired. It needs a real record to come through the production path before it can be '
      + 'called working.';
  }
  return failing.map((f) => f.finding).join(' ');
}

function humanEvent(type: DemandEventType): string {
  return type.toLowerCase().replace(/_/g, ' ');
}

function describeGeography(events: DemandEventType[]): string {
  const states = new Set<string>();
  for (const j of DEFAULT_JURISDICTIONS) {
    if (!j.unusableReason && events.includes(j.eventType)) states.add(j.state);
  }
  for (const d of DEFAULT_SOLICITATION_DATASETS) {
    const type: DemandEventType = d.publishes === 'AWARDED_CONTRACT' ? 'CONTRACT_AWARD' : 'PROCUREMENT_NOTICE';
    if (!d.unusableReason && events.includes(type)) states.add(d.state);
  }
  if (events.includes('INBOUND_REQUEST')) states.add('anywhere (inbound)');
  return states.size > 0 ? [...states].sort().join(', ') : 'nowhere currently';
}

// ---------------------------------------------------------------------------
// The whole universe, against real records
// ---------------------------------------------------------------------------

export type UniverseReport = {
  assessments: MiniPathAssessment[];
  totals: Record<OperationalState, number>;
  /** The three the owner named, so the page cannot quietly lose them. */
  provenTargets: MiniPathAssessment[];
  reach: SourceReachability;
};

export async function universeReport(params: {
  orgId: string;
  dataMode?: 'PRODUCTION' | 'TEST';
}): Promise<UniverseReport> {
  const dataMode = params.dataMode ?? 'PRODUCTION';
  const reach = sourceReachability();

  // One grouped query rather than one per path. Routes carry the playbook key,
  // which is how observation is attributed back to a declaration.
  const [routeRows, latest] = await Promise.all([
    prisma.routeHypothesis.groupBy({
      by: ['playbookKey', 'status'],
      where: { orgId: params.orgId, dataMode },
      _count: { _all: true },
    }),
    prisma.routeHypothesis.groupBy({
      by: ['playbookKey'],
      where: { orgId: params.orgId, dataMode },
      _max: { createdAt: true },
    }),
  ]);

  const byPlaybook = new Map<string, PathObservation>();
  for (const row of routeRows) {
    const current = byPlaybook.get(row.playbookKey) ?? { ...EMPTY_OBSERVATION };
    current.routes += row._count._all;
    if (row.status === 'PURSUE') current.qualifiedOpportunities += row._count._all;
    byPlaybook.set(row.playbookKey, current);
  }
  for (const row of latest) {
    const current = byPlaybook.get(row.playbookKey);
    if (current) current.lastRecordAt = row._max.createdAt;
  }

  // Money, attributed through the route that earned it. Only quotes with a real
  // cost side count, on the same evidence rule as everywhere else.
  const quoteRows = await prisma.routeQuote.findMany({
    where: { orgId: params.orgId, dataMode },
    select: {
      state: true,
      costSideMissing: true,
      buyerPrice: true,
      providerCost: true,
      route: { select: { playbookKey: true } },
    },
  });
  for (const quote of quoteRows) {
    const key = quote.route?.playbookKey;
    if (!key) continue;
    const current = byPlaybook.get(key) ?? { ...EMPTY_OBSERVATION };
    current.quotes += 1;
    if (quote.state === 'ACCEPTED') {
      current.wins += 1;
      if (!quote.costSideMissing && quote.buyerPrice !== null && quote.providerCost !== null) {
        current.collectedGrossProfit += Number(quote.buyerPrice) - Number(quote.providerCost);
      }
    }
    byPlaybook.set(key, current);
  }

  const assessments = MINI_PATHS.map((path) =>
    assessMiniPath({
      path,
      playbook: path.playbookKey ? playbookByKey(path.playbookKey) : undefined,
      reach,
      observed: (path.playbookKey ? byPlaybook.get(path.playbookKey) : undefined) ?? { ...EMPTY_OBSERVATION },
    }),
  );

  const totals: Record<OperationalState, number> = {
    OPERATIONAL: 0, PARTIAL: 0, NEEDS_CONFIGURATION: 0, TAXONOMY_ONLY: 0, DISABLED: 0,
  };
  for (const a of assessments) totals[a.state] += 1;

  return {
    assessments,
    totals,
    provenTargets: assessments.filter((a) =>
      ['brokerage.warehousing.overflow', 'distribution.materials.steel', 'subcontracting.facility.commercial']
        .includes(a.path.key),
    ),
    reach,
  };
}

/** The assessment for one path, for a detail view or a guard. */
export function assessmentFor(key: MiniPathKey, report: UniverseReport): MiniPathAssessment | undefined {
  return report.assessments.find((a) => a.path.key === key);
}
