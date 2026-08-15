import type { DemandEventType } from '@prisma/client';
import type { Playbook } from './playbooks';
import { LANES, type AcquisitionLane } from '@/lib/universe/registry';

/**
 * Which commercial reading of an event wins, and why the others did not.
 *
 * The pipeline used to iterate every playbook whose qualifying events matched
 * and create a route for each. With thirteen playbooks that turned one Chicago
 * licence record into several "opportunities"; a portfolio audit found 54 live
 * routes resting on two events, one refracted into 42. The board looked like a
 * business and was two phone calls.
 *
 * Adding warehousing, steel and subcontracting playbooks makes that strictly
 * worse — a single contract award now matches four readings — so this has to
 * exist before those are wired, not after.
 *
 * The model is a competition rather than a filter. Every playbook that could
 * apply states its case, the cases are scored against the same six questions,
 * and exactly one wins. The others are kept, with their scores and the reason
 * they lost, because they are the second thing to try when the first is
 * disproved — but they are not work, they are not on the board, and they do not
 * become an opportunity until independent new evidence arrives.
 *
 * The competition is allowed to conclude that nobody wins. "No commercially
 * credible route is established yet" is a real answer and a common one, and a
 * system that cannot say it will always find something to sell.
 */

// ---------------------------------------------------------------------------
// The lane an event belongs to
// ---------------------------------------------------------------------------

/**
 * Direct demand is somebody asking. Everything else is us concluding.
 *
 * This governs how strong a claim the product may make downstream, so it is
 * decided from the event type alone — a property of the record, not of the
 * playbook that fancies it.
 */
const DIRECT_DEMAND_EVENTS: DemandEventType[] = [
  'ACTIVE_RFP',
  'ACTIVE_RFQ',
  'PROCUREMENT_NOTICE',
  'VENDOR_REQUEST',
  'SUBCONTRACTOR_REQUEST',
  'INBOUND_REQUEST',
];

export function laneFor(eventType: DemandEventType): AcquisitionLane {
  return DIRECT_DEMAND_EVENTS.includes(eventType) ? 'DIRECT_DEMAND' : 'TRIGGER_BACKED';
}

// ---------------------------------------------------------------------------
// A candidate reading
// ---------------------------------------------------------------------------

export type Candidate = {
  playbook: Playbook;
  /** Facts the source itself stated, lower-cased for matching. */
  confirmedFacts: string[];
  /** What we concluded. Never counted as evidence for our own conclusion. */
  inferredFacts: string[];
  /** Providers who could actually deliver this reading. */
  providerCount: number;
  /** True when the event names a party in the buying role this reading needs. */
  buyerIdentified: boolean;
  /** True when the event carries a date that puts it inside this playbook's window. */
  insideWindow: boolean;
  /** The event's own words, for trade matching. */
  headline: string;
  /** The event's description or scope text, where the source published one. */
  scopeText: string | null;
};

export type Dimension = {
  key: string;
  /** −5 to +5. Positive supports this reading. */
  score: number;
  because: string;
};

export type ScoredCandidate = {
  playbookKey: string;
  label: string;
  route: string;
  total: number;
  dimensions: Dimension[];
  /** Why this reading is not the primary one, filled in after the winner is known. */
  lostBecause: string | null;
};

export type CompetitionResult = {
  lane: AcquisitionLane;
  /** The winning reading, or null when nothing cleared the gate. */
  primary: ScoredCandidate | null;
  /** Kept, scored, and deliberately not queued as work. */
  alternatives: ScoredCandidate[];
  /** The sentence an operator reads when nothing won. */
  verdict: string;
  /** The bar the winner had to clear, so the number is checkable. */
  gate: number;
};

/**
 * The bar a reading must clear to become an opportunity at all.
 *
 * Set so that a reading resting only on "this business exists and this playbook
 * mentions a trade" cannot pass. That combination scores around two; the gate
 * is above it deliberately.
 */
export const CREDIBILITY_GATE = 4;

/**
 * Words that make an event about a trade rather than merely near one.
 *
 * Matched against what the source published, never against what we inferred.
 * A licence record that says "restaurant" is evidence about a restaurant; it is
 * not evidence that anybody wants steel, and the difference is the whole reason
 * the janitorial default happened.
 */
const TRADE_LANGUAGE: Record<string, RegExp> = {
  'brokerage.warehousing.overflow': /warehous|storage|distribution cent|fulfil|pallet|3pl|logistics|cold stor/i,
  'distribution.materials.steel': /steel|rebar|structural|metal|fabricat|beam|joist|deck|erect/i,
  'subcontracting.facility.commercial': /facilit|janitor|maintenance|custodial|building service|grounds|portfolio/i,

  // The facility and supply paths, added with their playbooks. Without an entry
  // here a reading scores zero on economic fit — neither supported nor
  // penalised — which is how six new playbooks would have quietly started
  // splitting every occupancy approval six ways.
  'construction.subcontracting.trade_packages':
    /construct|renovat|build|contractor|alteration|tenant improvement|permit|remodel/i,
  'facility.brokerage.waste_collection': /waste|refuse|recycl|dumpster|roll.?off|trash|compact/i,
  'facility.brokerage.grounds': /landscap|grounds|lawn|snow|irrigation|parking lot|exterior/i,
  'restaurant.distribution.opening_supply':
    /restaurant|food|kitchen|cafe|caf\u00e9|bar|tavern|grill|bakery|deli|retail food/i,
  'hospitality.distribution.opening_supply': /hotel|motel|lodging|inn|hospitality|guest room|bed and breakfast/i,
  'distribution.packaging.opening_supply':
    /warehous|distribution cent|fulfil|packag|shipping|pallet|carton|3pl/i,
};

export function scoreCandidate(candidate: Candidate, lane: AcquisitionLane): ScoredCandidate {
  const { playbook } = candidate;
  const dimensions: Dimension[] = [];

  // --- 1. Evidence strength ------------------------------------------------
  // Only what the source stated counts. Our own inferences are excluded by
  // construction: a hypothesis cannot be its own evidence.
  const required = playbook.requiredEvidence.length;
  const satisfied = playbook.requiredEvidence.filter((need) =>
    candidate.confirmedFacts.some((fact) => overlaps(fact, need)),
  ).length;
  const evidenceShare = required === 0 ? 0 : satisfied / required;
  dimensions.push({
    key: 'evidence',
    score: Math.round(evidenceShare * 4) - 1,
    because:
      required === 0
        ? 'This playbook states no required evidence, which is itself a weakness.'
        : `${satisfied} of ${required} required piece(s) of evidence are in what the source actually published.`,
  });

  // --- 2. Economic plausibility -------------------------------------------
  // Does the event describe the kind of economic change this reading needs?
  const language = TRADE_LANGUAGE[playbook.key];
  const published = `${candidate.headline} ${candidate.scopeText ?? ''}`;
  const tradeMatch = language ? language.test(published) : null;
  dimensions.push({
    key: 'economic_fit',
    score: tradeMatch === null ? 0 : tradeMatch ? 3 : -3,
    because:
      tradeMatch === null
        ? 'No trade language is defined for this reading, so nothing distinguishes it from any other.'
        : tradeMatch
          ? 'What the source published names this trade or its work.'
          : 'Nothing the source published mentions this trade. The reading is being applied from outside.',
  });

  // --- 3. Buyer specificity ------------------------------------------------
  dimensions.push({
    key: 'buyer',
    score: candidate.buyerIdentified ? 2 : -2,
    because: candidate.buyerIdentified
      ? 'The event names a party in the role this reading needs to sell to.'
      : 'No party in the event holds the buying role this reading needs, so there is nobody to approach.',
  });

  // --- 4. Supply feasibility ----------------------------------------------
  dimensions.push({
    key: 'supply',
    score: candidate.providerCount >= 3 ? 2 : candidate.providerCount > 0 ? 1 : -2,
    because:
      candidate.providerCount > 0
        ? `${candidate.providerCount} provider(s) in the catalogue could deliver ${playbook.requiredCapability}.`
        : `Nobody in the catalogue can deliver ${playbook.requiredCapability}, so this could not be quoted `
          + 'however the buyer conversation went.',
  });

  // --- 5. Timing -----------------------------------------------------------
  dimensions.push({
    key: 'timing',
    score: candidate.insideWindow ? 2 : -3,
    because: candidate.insideWindow
      ? `The event date puts this inside the buying window: ${playbook.window.reason}`
      : 'The event date falls outside this playbook’s buying window, so the moment to sell it has passed or '
        + 'has not arrived.',
  });

  // --- 6. Intermediary advantage ------------------------------------------
  // Direct demand means somebody is already asking, which is when a middleman
  // is most easily gone around. A trigger nobody else has noticed is where the
  // advantage actually is.
  dimensions.push({
    key: 'intermediary',
    score: lane === 'DIRECT_DEMAND' ? 1 : 2,
    because:
      lane === 'DIRECT_DEMAND'
        ? `${LANES.DIRECT_DEMAND.label}: the buyer is asking publicly, so others can see it too.`
        : `${LANES.TRIGGER_BACKED.label}: the need is inferable before it is advertised, which is where an `
          + 'intermediary is worth something.',
  });

  // --- Penalties -----------------------------------------------------------
  // A reading with no trade language, no named buyer and no confirmed evidence
  // is the "this company exists" hypothesis wearing a playbook's name.
  if (evidenceShare === 0 && !candidate.buyerIdentified) {
    dimensions.push({
      key: 'generic_penalty',
      score: -4,
      because:
        'Nothing supports this beyond the organisation existing and this playbook being configured. Business '
        + 'existence is not commercial intent.',
    });
  }

  const total = dimensions.reduce((sum, d) => sum + d.score, 0);
  return {
    playbookKey: playbook.key,
    label: playbook.label,
    route: String(playbook.route),
    total,
    dimensions,
    lostBecause: null,
  };
}

/**
 * Runs the competition and returns one primary reading at most.
 *
 * Ties break on declaration order in `PLAYBOOKS`, which puts the trade
 * playbooks ahead of the cleaning ones — so a construction award that reads
 * equally well as steel supply and as a cleaning contract resolves to steel
 * rather than to whichever file was written first.
 */
export function compete(input: {
  eventType: DemandEventType;
  candidates: Candidate[];
}): CompetitionResult {
  const lane = laneFor(input.eventType);
  const gate = CREDIBILITY_GATE;

  if (input.candidates.length === 0) {
    return {
      lane,
      primary: null,
      alternatives: [],
      gate,
      verdict:
        'No playbook covers this kind of event, so there is no commercial reading of it to compare. The event '
        + 'is kept; nothing was invented from it.',
    };
  }

  const scored = input.candidates.map((c) => scoreCandidate(c, lane));

  // Stable sort: the array arrives in `PLAYBOOKS` order, so equal totals keep
  // that order rather than resolving arbitrarily.
  const ranked = [...scored].sort((a, b) => b.total - a.total);
  const [best, ...rest] = ranked;

  if (best.total < gate) {
    return {
      lane,
      primary: null,
      alternatives: ranked.map((c) => ({
        ...c,
        lostBecause: `Scored ${c.total} against a gate of ${gate}.`,
      })),
      gate,
      verdict:
        `No commercially credible route is established yet. The strongest reading (${best.label}) scored `
        + `${best.total} against a gate of ${gate}: ${weakest(best)}. This event is kept and will be `
        + 'reconsidered if new evidence arrives; nothing has been put on the board.',
    };
  }

  return {
    lane,
    primary: best,
    alternatives: rest.map((c) => ({
      ...c,
      lostBecause:
        c.total === best.total
          ? `Scored the same as ${best.label} and lost the tie on playbook order.`
          : `Scored ${c.total} against ${best.total} for ${best.label}: ${weakest(c)}`,
    })),
    gate,
    verdict:
      `${best.label} is the primary reading, scoring ${best.total} against a gate of ${gate}. `
      + `${rest.length} alternative reading(s) kept and not queued as work — they need independent new evidence `
      + 'before any of them becomes a second opportunity.',
  };
}

/** The dimension that hurt a candidate most, said in words. */
function weakest(candidate: ScoredCandidate): string {
  const worst = [...candidate.dimensions].sort((a, b) => a.score - b.score)[0];
  return worst ? worst.because : 'no dimension stood out.';
}

/**
 * Loose overlap between a stated fact and a required piece of evidence.
 *
 * Deliberately generous, because the cost of being strict here is a real
 * opportunity scored down for wording, while the cost of being generous is
 * caught by the other five dimensions.
 */
function overlaps(fact: string, requirement: string): boolean {
  const words = requirement
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 4);
  if (words.length === 0) return false;
  const haystack = fact.toLowerCase();
  return words.some((w) => haystack.includes(w));
}
