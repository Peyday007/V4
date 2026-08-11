import { assessIdentity, buildIdentity } from './identity';
import { diagnose, type RunDiagnostics } from './diagnostics';
import { eventRecency, type EventRecency } from './eventTime';
import { needLabel, type NeedLabel } from './qualification';
import type { LeadRole, LeadStage } from '@prisma/client';

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

  return {
    accounts: [...rendered].sort(order),
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
