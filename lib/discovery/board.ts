import { assessIdentity, buildIdentity } from './identity';
import { diagnose, type RunDiagnostics } from './diagnostics';
import { eventRecency, type EventRecency } from './eventTime';
import { needLabel, type NeedLabel } from './qualification';
import type { LeadRole, LeadStage, LeadTier } from '@prisma/client';
import { TIER_LABEL, TIER_ORDER, TIER_OUTREACH } from './tiers';

/**
 * The lead board, assembled once and judged before it is shown.
 *
 * The board previously rendered one card per `DiscoverySignal` and, when a
 * signal had no hypothesis attached, fell back to a second scorer that ranked
 * on ingestion freshness. That fallback is why 49 cards represented 35
 * businesses and why 47 of them scored exactly 88 while the qualification
 * model said nothing above 35 was reachable without intent. Two scorers
 * existed; the page reached the wrong one whenever assessment had not run.
 *
 * This module is the only thing that builds the board, and it has one score
 * source. An account with no assessment has no score — not a fallback score.
 * The unit of display is the account, and its path candidacies hang beneath
 * it, so one business is one card however many sources found it.
 */

export type BoardHypothesis = {
  id: string;
  pathId: string;
  pathName: string;
  leadRole: LeadRole;
  stage: LeadStage;
  /** 0–1. */
  accountFit: number;
  intent: number;
  contactability: number;
  fulfilment: number;
  /** 0–100, already capped by `scorePriority`. */
  priority: number;
  /** Evidence tier. Read before the priority score, never after it. */
  tier: LeadTier;
  tierReason: string;
  rejectionFlags: string[];
  buyingWindow: string | null;
  scoreExplanation: Record<string, string>;
  requiredService: string | null;
  missing: string[];
  /** Distinct sources that produced this candidacy. */
  sourceNames: string[];
  sourceUrl: string | null;
  /** Stated by the source. Null is common and is not a defect. */
  sourcePublishedAt: Date | null;
  firstDiscoveredAt: Date;
  lastSeenAt: Date;
  lastIntentSignalAt: Date | null;
  /** How many raw records collapsed into this one candidacy. */
  signalCount: number;
  evidence: string[];
  marketName: string | null;
  isLiveSource: boolean;
};

export type BoardAccount = {
  companyId: string;
  name: string;
  cityName: string | null;
  stateCode: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  origin: string;
  externalPlaceId: string | null;
  normalizedPhone: string | null;
  normalizedAddress: string | null;
  hypotheses: BoardHypothesis[];
};

export type RenderedHypothesis = BoardHypothesis & {
  recency: EventRecency;
  need: NeedLabel;
  tierLabel: string;
  /** Channels this tier's evidence justifies. Calls are not free. */
  outreach: { channels: string[]; note: string };
};

export type RenderedAccount = Omit<BoardAccount, 'hypotheses'> & {
  hypotheses: RenderedHypothesis[];
  /** Highest priority across this account's candidacies. Null when unassessed. */
  topPriority: number | null;
  quarantined: boolean;
  quarantineReason: string | null;
  /** Raw records that collapsed into this account beyond the first per path. */
  collapsedSignals: number;
};

/**
 * The funnel, stated in the only terms that cannot flatter it.
 *
 * "Pipeline" is the word that hides the problem: ten thousand scraped
 * companies and one real solicitation both increase it. These counts are kept
 * separate and named for what they are, so a board of directory prospects
 * reads as a board of directory prospects.
 */
export type PipelineTruth = {
  rawRecords: number;
  accounts: number;
  hypotheses: number;
  byTier: Array<{ tier: LeadTier; label: string; count: number }>;
  /** Tier A and B only. The records with an actual reason to make contact. */
  actionable: number;
  qualified: number;
};

export type BoardCounts = {
  accounts: number;
  hypotheses: number;
  signals: number;
  /** Raw records that did not become their own card. */
  duplicateSignals: number;
  quarantined: number;
  /** Records ingested but never assessed. These carry no score at all. */
  unassessedSignals: number;
};

export type Board = {
  accounts: RenderedAccount[];
  diagnostics: RunDiagnostics;
  counts: BoardCounts;
  /**
   * False when the diagnostics say the scores carry no information. The board
   * then refuses to imply an order rather than presenting an arbitrary one as
   * a work queue.
   */
  ranked: boolean;
  rankingRefusedBecause: string | null;
  pipeline: PipelineTruth;
  /**
   * Set when the whole board is Tier D. Not a warning about a score — a
   * statement that discovery has found organisations and no demand, which is
   * a sourcing problem and cannot be fixed by ranking harder.
   */
  noDemandFound: string | null;
};

/**
 * Which of the five qualification gates are still open, read from what was
 * persisted rather than recomputed from a score.
 *
 * A stage is only meaningful next to the list of what it is still missing;
 * "opportunity hypothesis" alone reads like a pipeline stage someone chose,
 * not like a statement that four of five requirements are unmet.
 */
export function missingEvidence(h: {
  needEvidence: unknown;
  decisionMakerId: string | null;
  timingEvidence: unknown;
  accountFit: number;
  nextStep: string | null;
}): string[] {
  const missing: string[] = [];
  if (!h.needEvidence) missing.push('a stated need');
  if (!h.decisionMakerId) missing.push('a named decision-maker');
  if (!h.timingEvidence) missing.push('any timing');
  if (h.accountFit < 0.75) missing.push('sufficient account fit');
  if (!h.nextStep) missing.push('an agreed next step');
  return missing;
}

export function buildBoard(input: {
  accounts: BoardAccount[];
  unassessedSignals: number;
  now?: Date;
}): Board {
  const now = input.now ?? new Date();

  const rendered: RenderedAccount[] = input.accounts.map((account) => {
    const quarantine = assessIdentity(
      buildIdentity({
        name: account.name,
        externalPlaceId: account.externalPlaceId,
        phone: account.normalizedPhone ?? account.phone,
        address: account.normalizedAddress,
        city: account.cityName,
        state: account.stateCode,
      }),
    );

    const hypotheses: RenderedHypothesis[] = account.hypotheses.map((h) => ({
      ...h,
      // Recency is derived from the source's own date and from nothing else.
      // There is no branch here that can reach a discovery timestamp.
      recency: eventRecency(h.sourcePublishedAt, now),
      need: needLabel(h.leadRole, h.intent),
      tierLabel: TIER_LABEL[h.tier],
      outreach: TIER_OUTREACH[h.tier],
    }));

    const priorities = hypotheses.map((h) => h.priority);

    return {
      ...account,
      hypotheses,
      topPriority: priorities.length > 0 ? Math.max(...priorities) : null,
      quarantined: quarantine.quarantined,
      quarantineReason: quarantine.reason,
      collapsedSignals: hypotheses.reduce((sum, h) => sum + Math.max(0, h.signalCount - 1), 0),
    };
  });

  // Quarantined accounts are held out of the credibility assessment for the
  // same reason they are held out of ranking: they describe a population
  // nobody is being asked to work, and including them would mask or invent a
  // problem in the population that is.
  const assessable = rendered.filter((a) => !a.quarantined).flatMap((a) => a.hypotheses);

  const diagnostics = diagnose({
    fit: assessable.map((h) => Math.round(h.accountFit * 100)),
    intent: assessable.map((h) => Math.round(h.intent * 100)),
    contactability: assessable.map((h) => Math.round(h.contactability * 100)),
    fulfilment: assessable.map((h) => Math.round(h.fulfilment * 100)),
    priority: assessable.map((h) => h.priority),
    records: rendered.flatMap((a) =>
      a.hypotheses.map((h) => ({
        company: a.name,
        cityState: [a.cityName, a.stateCode].filter(Boolean).join(', ') || 'unknown',
        quarantined: a.quarantined,
        quarantineReason: a.quarantineReason,
        contactability: Math.round(h.contactability * 100),
        intent: Math.round(h.intent * 100),
      })),
    ),
  });

  const ranked = diagnostics.verdict !== 'NOT_CREDIBLE';

  // Quarantined accounts sink regardless of verdict: an identity nobody can
  // verify should not head a work queue even when the scores are sound.
  const order = ranked
    ? (a: RenderedAccount, b: RenderedAccount) =>
        Number(a.quarantined) - Number(b.quarantined) || (b.topPriority ?? -1) - (a.topPriority ?? -1)
    : (a: RenderedAccount, b: RenderedAccount) =>
        Number(a.quarantined) - Number(b.quarantined) || a.name.localeCompare(b.name);

  const signals = rendered.reduce(
    (sum, a) => sum + a.hypotheses.reduce((n, h) => n + h.signalCount, 0),
    0,
  );
  const hypotheses = rendered.reduce((sum, a) => sum + a.hypotheses.length, 0);

  const all = rendered.flatMap((a) => a.hypotheses);
  const byTier = TIER_ORDER.map((tier) => ({
    tier,
    label: TIER_LABEL[tier],
    count: all.filter((h) => h.tier === tier).length,
  }));
  const actionable = all.filter((h) => h.tier === 'ACTIVE_DEMAND' || h.tier === 'STRONG_TRIGGER').length;

  return {
    accounts: [...rendered].sort(order),
    pipeline: {
      rawRecords: signals + input.unassessedSignals,
      accounts: rendered.length,
      hypotheses,
      byTier,
      actionable,
      qualified: all.filter((h) => h.stage === 'QUALIFIED_LEAD' || h.stage === 'ACTIVE_OPPORTUNITY').length,
    },
    noDemandFound:
      all.length > 0 && actionable === 0
        ? `None of the ${all.length} record(s) on this board carry dated demand evidence — every one is a ` +
          `directory or registry listing. That is a sourcing gap, not a scoring one: no amount of ranking turns ` +
          `a list of organisations into a list of buyers. Enable a solicitation or award source (SAM.gov, ` +
          `USAspending, a permit portal) to produce Tier A and B records.`
        : null,
    diagnostics,
    counts: {
      accounts: rendered.length,
      hypotheses,
      signals: signals + input.unassessedSignals,
      duplicateSignals: signals - hypotheses,
      quarantined: rendered.filter((a) => a.quarantined).length,
      unassessedSignals: input.unassessedSignals,
    },
    ranked,
    rankingRefusedBecause: ranked
      ? null
      : `${diagnostics.verdictReason} The list below is in alphabetical order, not priority order, ` +
        `because presenting these scores as a ranking would imply a judgement the data cannot support.`,
  };
}
