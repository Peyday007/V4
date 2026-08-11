/**
 * Matching a lead's service to a capability we hold.
 *
 * This was string equality, and string equality fails on almost everything
 * real. The catalogue says "Commercial janitorial"; a Places query returns
 * "Commercial cleaning"; a CMS record produces "Medical facility cleaning".
 * Those are the same trade. Under exact matching all three missed, which had
 * two visible consequences: account fit scored its service component at the
 * floor for every record, and — once rejection rules arrived — seventeen of
 * thirty-two hypotheses were rejected for "no provider could fulfil this"
 * when the real problem was that two teams had named the same work
 * differently.
 *
 * A vocabulary mismatch is not a fulfilment gap, and reporting one as the
 * other is worse than not checking at all: it produces a confident rejection
 * of workable business.
 */

/**
 * Words that carry no discriminating meaning in a service name.
 *
 * "Subcontract" and "wholesale" describe the commercial structure, not the
 * work, and the structure is tracked separately by the business path.
 */
const NOISE = new Set([
  'and', 'or', 'the', 'of', 'for', 'a', 'an',
  'service', 'services', 'servicing',
  'subcontract', 'subcontracted', 'subcontracting',
  'supply', 'supplies', 'wholesale', 'consumables',
  'work', 'works', 'general', 'misc', 'miscellaneous',
]);

/**
 * Trade synonyms, canonicalised to one token.
 *
 * Deliberately narrow. Every entry here is a claim that two words name the
 * same work, and a wrong entry silently matches a lead to a provider who
 * cannot do the job — which is a worse failure than missing a match.
 */
const SYNONYMS: Record<string, string> = {
  janitorial: 'cleaning',
  custodial: 'cleaning',
  housekeeping: 'cleaning',
  cleaner: 'cleaning',
  clean: 'cleaning',
  hvac: 'mechanical',
  heating: 'mechanical',
  cooling: 'mechanical',
  electric: 'electrical',
  landscape: 'landscaping',
  grounds: 'landscaping',
  freight: 'logistics',
  trucking: 'logistics',
  haulage: 'logistics',
  warehouse: 'warehousing',
  storage: 'warehousing',
  medical: 'healthcare',
  clinical: 'healthcare',
};

export function capabilityTokens(value: string): Set<string> {
  const tokens = value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 2 && !NOISE.has(t))
    .map((t) => SYNONYMS[t] ?? t);
  return new Set(tokens);
}

export type CapabilityMatch = {
  /** Catalogue entry matched, or null when nothing came close. */
  capability: string | null;
  /** 0–1. 1 means every meaningful word of the shorter name is shared. */
  score: number;
  /** Words that decided it, so a wrong match can be seen and corrected. */
  sharedTerms: string[];
};

/**
 * Below this share of the shorter name, two services are different work.
 *
 * Above half rather than at it, deliberately. At exactly half, any two
 * two-word services sharing one generic word match: "Window cleaning" reaches
 * "Commercial cleaning" on the word "cleaning" alone, and high-rise window
 * work is a specialist trade a commercial janitorial crew cannot do. The
 * asymmetry is intended — a missed match understates what we can fulfil, which
 * is visible and correctable, while a false match routes work to a provider
 * who cannot perform it, which is discovered on site.
 */
const MATCH_THRESHOLD = 0.6;

export function matchCapability(service: string | null | undefined, catalogue: Iterable<string>): CapabilityMatch {
  const empty: CapabilityMatch = { capability: null, score: 0, sharedTerms: [] };
  if (!service) return empty;

  const wanted = capabilityTokens(service);
  if (wanted.size === 0) return empty;

  let best = empty;
  for (const entry of catalogue) {
    const held = capabilityTokens(entry);
    if (held.size === 0) continue;

    const shared = [...wanted].filter((t) => held.has(t));
    if (shared.length === 0) continue;

    // Divided by the smaller set, so a specific lead ("Medical facility
    // cleaning") still matches a broader capability ("Cleaning") rather than
    // being penalised for carrying extra detail.
    const score = shared.length / Math.min(wanted.size, held.size);
    if (score > best.score) best = { capability: entry, score, sharedTerms: shared };
  }

  return best.score >= MATCH_THRESHOLD ? best : empty;
}

/** Whether the catalogue covers this service well enough to price and match. */
export function isCatalogued(service: string | null | undefined, catalogue: Iterable<string>): boolean {
  return matchCapability(service, catalogue).capability !== null;
}
