import type { BusinessPath, LeadRole, MarketSegment, SignalCategory } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * Business paths as configuration.
 *
 * Distribution, brokerage and subcontracting are how this operation earns
 * today. They are not a closed set, and the cost of pretending otherwise is
 * paid later: once "if type === BROKERAGE" appears in the scorer, the matcher
 * and four page components, adding a fourth path means editing all of them and
 * finding the ones you missed in production.
 *
 * So paths live in a table and the code asks the table. The three original ones
 * keep a `legacyCategory` pointing at the SignalCategory enum, because the
 * classifier and scorer were built against that enum and rewriting them buys
 * nothing today. New paths carry no legacy category and are driven entirely by
 * their JSON rules. Nothing is ever added to the enum again.
 */

export type PathQualificationRules = {
  /** A lead below this is held rather than surfaced. */
  minimumStrength?: number;
  minimumConfidence?: number;
  /** Fields that must be present before the lead is considered qualified. */
  requiresContact?: boolean;
  requiresService?: boolean;
  /** Segments this path refuses. */
  excludeSegments?: MarketSegment[];
};

export type PathScoringWeights = {
  freshness?: number;
  contactability?: number;
  segmentFit?: number;
  sourceReliability?: number;
  signalStrength?: number;
};

export type PathDefinition = {
  key: string;
  name: string;
  description: string;
  legacyCategory: SignalCategory | null;
  isActive: boolean;
  priority: number;
  leadRoles: LeadRole[];
  segments: MarketSegment[];
  sourceKeys: string[];
  qualificationRules: PathQualificationRules;
  scoringWeights: PathScoringWeights;
  requiredFields: string[];
  recommendedActions: Record<string, string>;
  revenueModel: string | null;
  expectedCycleDays: number | null;
  typicalMarginPct: number | null;
};

/**
 * The paths a new organisation starts with.
 *
 * Written here rather than in the seed so they are installed for real
 * deployments too — an operation that clears the demonstration data must not
 * lose its paths along with it.
 */
export const DEFAULT_PATHS: PathDefinition[] = [
  {
    key: 'distribution',
    name: 'Distribution',
    description:
      'Supplying janitorial consumables, chemicals, paper, liners and equipment on a recurring replenishment cycle, and the wholesale partners who make that possible.',
    legacyCategory: 'DISTRIBUTION',
    isActive: true,
    // Fastest cash of the three: a consumables order can ship and invoice in
    // days, where a service contract needs a site visit and a signature.
    priority: 10,
    leadRoles: ['BUYER', 'SUPPLIER', 'PARTNER'],
    segments: ['COMMERCIAL', 'INDUSTRIAL', 'PUBLIC_SECTOR'],
    sourceKeys: [],
    qualificationRules: { minimumStrength: 0.35, requiresService: true },
    scoringWeights: { freshness: 1.0, contactability: 1.2, segmentFit: 0.8, sourceReliability: 0.9, signalStrength: 1.1 },
    requiredFields: ['requiredService', 'contact'],
    recommendedActions: {
      BUYER: 'Confirm current supplier, order frequency, monthly spend and who signs off reorders.',
      SUPPLIER: 'Obtain wholesale pricing, stocked lines, minimum order quantity and delivery terms.',
      PARTNER: 'Establish what they stock, where they deliver and on what terms.',
    },
    revenueModel: 'Product margin on recurring replenishment',
    expectedCycleDays: 21,
    typicalMarginPct: 22,
  },
  {
    key: 'brokerage',
    name: 'Brokerage',
    description:
      'Matching organisations that need cleaning and facility services with local providers able to perform the work, and taking a spread on the arrangement.',
    legacyCategory: 'BROKERAGE',
    isActive: true,
    priority: 20,
    leadRoles: ['BUYER', 'PROVIDER'],
    segments: ['COMMERCIAL', 'RESIDENTIAL', 'INDUSTRIAL'],
    sourceKeys: [],
    // Both sides are required. A buyer with no provider is an obligation, not
    // an opportunity, so the path insists on knowing the service.
    qualificationRules: { minimumStrength: 0.3, requiresService: true },
    scoringWeights: { freshness: 1.3, contactability: 1.1, segmentFit: 1.0, sourceReliability: 0.8, signalStrength: 1.2 },
    requiredFields: ['requiredService', 'market'],
    recommendedActions: {
      BUYER: 'Confirm the service need, incumbent provider, contract end date and decision-maker.',
      PROVIDER: 'Confirm capacity, service radius, crew count, insurance and licensing.',
    },
    revenueModel: 'Spread between buyer price and provider cost',
    expectedCycleDays: 45,
    typicalMarginPct: 28,
  },
  {
    key: 'subcontracting',
    name: 'Subcontracting',
    description:
      'Taking fulfilment work from general contractors, facility-management firms and national service vendors who hold contracts in markets where they lack their own crews.',
    legacyCategory: 'SUBCONTRACTING',
    isActive: true,
    priority: 30,
    leadRoles: ['CONTRACTOR', 'PARTNER', 'SUBCONTRACTOR'],
    segments: ['COMMERCIAL', 'INDUSTRIAL', 'PUBLIC_SECTOR'],
    sourceKeys: [],
    qualificationRules: { minimumStrength: 0.35 },
    scoringWeights: { freshness: 1.1, contactability: 1.0, segmentFit: 0.9, sourceReliability: 1.0, signalStrength: 1.3 },
    requiredFields: ['market'],
    recommendedActions: {
      CONTRACTOR: 'Ask about vendor registration and overflow work, and get onto the approved subcontractor list.',
      PARTNER: 'Establish which markets they are short of crews in and what their onboarding requires.',
      SUBCONTRACTOR: 'Qualify as fulfilment capacity: crews, coverage, insurance, references.',
    },
    revenueModel: 'Contracted rate per site or per job, net of fulfilment cost',
    expectedCycleDays: 60,
    typicalMarginPct: 24,
  },

  // ---------------------------------------------------------------------------
  // The three that were missing
  // ---------------------------------------------------------------------------
  //
  // Playbooks existed for all six commercial routes and paths existed for three
  // of them, so the three below produced routes that belonged to no path — and
  // every surface that groups, scores or reports by path silently dropped them.
  // A route with a null pathId is not a fourth way of earning; it is a route
  // nobody is counting.
  //
  // They differ from the first three in what is actually being sold. The first
  // three all sell somebody else's labour or goods to a buyer. Direct service
  // sells our own. Supplier development spends to create capacity that does not
  // exist yet. Provider recruitment produces no revenue at all on its own — it
  // removes the constraint that stops the other five earning, and pretending
  // otherwise by attaching a margin to it would be the same fabrication as a
  // closing probability nobody set.
  {
    key: 'direct_service',
    name: 'Direct service',
    description:
      'Performing the work ourselves with our own crew, where the job is close enough, small enough and '
      + 'urgent enough that finding a provider costs more than doing it.',
    // No legacy category on new paths, by the rule at the top of this file.
    legacyCategory: null,
    isActive: true,
    // Below the three broking paths: self-performing consumes capacity that
    // cannot be bought back, so it should be what happens when placing fails
    // rather than the first thing tried.
    priority: 40,
    leadRoles: ['BUYER'],
    segments: ['COMMERCIAL', 'RESIDENTIAL'],
    sourceKeys: [],
    // The highest bar of the six. Committing our own crew is committing the
    // one resource that cannot be sourced on demand, so a thin signal is not
    // enough — the service and a contact both have to be established.
    qualificationRules: { minimumStrength: 0.5, requiresService: true, requiresContact: true },
    scoringWeights: { freshness: 1.4, contactability: 1.3, segmentFit: 1.1, sourceReliability: 0.9, signalStrength: 1.2 },
    requiredFields: ['requiredService', 'market'],
    recommendedActions: {
      BUYER:
        'Confirm the scope, the date and the access arrangements, establish who signs off, then check the crew '
        + 'is actually free before anything is promised.',
    },
    revenueModel: 'Full job value, net of our own labour and materials',
    expectedCycleDays: 14,
    // Higher than broking because there is no provider taking a share, and
    // lower than it looks because our own labour is the cost.
    typicalMarginPct: 45,
  },
  {
    key: 'supplier_development',
    name: 'Supplier development',
    description:
      'Growing a provider\'s capability — coverage, credentials, crew or equipment — so they can take work we '
      + 'already have buyers for and cannot currently place.',
    legacyCategory: null,
    isActive: true,
    priority: 50,
    leadRoles: ['PROVIDER', 'SUBCONTRACTOR', 'PARTNER'],
    segments: ['COMMERCIAL', 'INDUSTRIAL'],
    sourceKeys: [],
    qualificationRules: { minimumStrength: 0.4 },
    scoringWeights: { freshness: 0.7, contactability: 1.2, segmentFit: 1.0, sourceReliability: 1.0, signalStrength: 1.1 },
    requiredFields: ['market'],
    recommendedActions: {
      PROVIDER: 'Establish what specifically stops them taking this work — coverage, credentials, crew or cash.',
      SUBCONTRACTOR: 'Agree what we would fund or arrange, and what work follows once it is in place.',
      PARTNER: 'Establish whether the gap is worth closing at all, or whether another provider already has it.',
    },
    // Deliberately not a margin. This path spends before it earns, and the
    // return arrives through whichever path sells the capacity afterwards.
    revenueModel: 'No direct revenue; it removes a fulfilment gap that another path then earns through',
    expectedCycleDays: 90,
    typicalMarginPct: null,
  },
  {
    key: 'provider_recruitment',
    name: 'Provider recruitment',
    description:
      'Finding and qualifying providers where supply is the binding constraint — the trades, territories and '
      + 'credentials we keep losing work for want of.',
    legacyCategory: null,
    isActive: true,
    priority: 60,
    leadRoles: ['PROVIDER', 'SUBCONTRACTOR'],
    segments: ['COMMERCIAL', 'INDUSTRIAL', 'PUBLIC_SECTOR'],
    sourceKeys: [],
    // The lowest bar, because a thin lead on a provider costs one call and the
    // alternative is a confirmed buyer with nobody to send.
    qualificationRules: { minimumStrength: 0.2 },
    scoringWeights: { freshness: 0.6, contactability: 1.4, segmentFit: 1.1, sourceReliability: 1.0, signalStrength: 0.8 },
    requiredFields: [],
    recommendedActions: {
      PROVIDER: 'Establish capability, coverage, capacity, insurance and licensing — and whether they want the work.',
      SUBCONTRACTOR: 'Qualify as fulfilment capacity, and record what they cannot do as carefully as what they can.',
    },
    revenueModel: 'No direct revenue; it is what makes the other paths fulfillable',
    expectedCycleDays: 30,
    typicalMarginPct: null,
  },
];

export function toPathDefinition(row: BusinessPath): PathDefinition {
  return {
    key: row.key,
    name: row.name,
    description: row.description,
    legacyCategory: row.legacyCategory,
    isActive: row.isActive,
    priority: row.priority,
    leadRoles: row.leadRoles,
    segments: row.segments,
    sourceKeys: row.sourceKeys,
    qualificationRules: (row.qualificationRules ?? {}) as PathQualificationRules,
    scoringWeights: (row.scoringWeights ?? {}) as PathScoringWeights,
    requiredFields: Array.isArray(row.requiredFields) ? (row.requiredFields as string[]) : [],
    recommendedActions: (row.recommendedActions ?? {}) as Record<string, string>,
    revenueModel: row.revenueModel,
    expectedCycleDays: row.expectedCycleDays,
    typicalMarginPct: row.typicalMarginPct,
  };
}

/** Installs any default path the organisation does not already have. Idempotent. */
export async function ensureDefaultPaths(orgId: string): Promise<number> {
  const existing = await prisma.businessPath.findMany({ where: { orgId }, select: { key: true } });
  const have = new Set(existing.map((p) => p.key));
  const missing = DEFAULT_PATHS.filter((p) => !have.has(p.key));

  for (const path of missing) {
    await prisma.businessPath.create({
      data: {
        orgId,
        key: path.key,
        name: path.name,
        description: path.description,
        legacyCategory: path.legacyCategory,
        isActive: path.isActive,
        priority: path.priority,
        leadRoles: path.leadRoles,
        segments: path.segments,
        sourceKeys: path.sourceKeys,
        qualificationRules: path.qualificationRules as object,
        scoringWeights: path.scoringWeights as object,
        requiredFields: path.requiredFields as object,
        recommendedActions: path.recommendedActions as object,
        revenueModel: path.revenueModel,
        expectedCycleDays: path.expectedCycleDays,
        typicalMarginPct: path.typicalMarginPct,
      },
    });
  }

  return missing.length;
}

export async function getActivePaths(orgId: string): Promise<BusinessPath[]> {
  return prisma.businessPath.findMany({
    where: { orgId, isActive: true },
    orderBy: [{ priority: 'asc' }, { name: 'asc' }],
  });
}

/**
 * Resolves a signal's path.
 *
 * Matching on `legacyCategory` first keeps every record produced before this
 * table existed correctly attributed. `leadRoles` is the fallback, which is how
 * a path added later claims records the enum has no name for.
 */
export function choosePathFor(
  paths: BusinessPath[],
  input: { category: SignalCategory; leadRole: LeadRole; segment: MarketSegment },
): BusinessPath | null {
  const byCategory = paths.filter((p) => p.legacyCategory === input.category);
  if (byCategory.length === 1) return byCategory[0];

  const candidates = (byCategory.length > 0 ? byCategory : paths).filter((path) => {
    const roleOk = path.leadRoles.length === 0 || path.leadRoles.includes(input.leadRole);
    const segmentOk = path.segments.length === 0 || path.segments.includes(input.segment);
    return roleOk && segmentOk;
  });

  if (candidates.length === 0) return byCategory[0] ?? null;
  // Lowest priority number wins — the path the operation wants worked first.
  return candidates.reduce((best, path) => (path.priority < best.priority ? path : best));
}

/**
 * Whether a lead clears its path's bar for being shown as qualified.
 *
 * Returns the reasons it did not, rather than a bare boolean, because "this
 * lead is unqualified" is not actionable and "no reachable contact" is.
 */
export function qualifyAgainstPath(
  path: BusinessPath,
  lead: {
    strength: number;
    confidence: number;
    hasContact: boolean;
    requiredService: string | null;
    segment: MarketSegment;
  },
): { qualified: boolean; blockers: string[] } {
  const rules = (path.qualificationRules ?? {}) as PathQualificationRules;
  const blockers: string[] = [];

  if (rules.minimumStrength !== undefined && lead.strength < rules.minimumStrength) {
    blockers.push(`Signal strength ${lead.strength.toFixed(2)} is below the ${rules.minimumStrength} this path requires.`);
  }
  if (rules.minimumConfidence !== undefined && lead.confidence < rules.minimumConfidence) {
    blockers.push(`Confidence ${lead.confidence.toFixed(2)} is below the ${rules.minimumConfidence} this path requires.`);
  }
  if (rules.requiresContact && !lead.hasContact) {
    blockers.push('No reachable contact on the source record.');
  }
  if (rules.requiresService && !lead.requiredService) {
    blockers.push('No service or product identified, so there is nothing to quote or match on.');
  }
  if (rules.excludeSegments?.includes(lead.segment)) {
    blockers.push(`This path does not work the ${lead.segment.toLowerCase().replace('_', ' ')} segment.`);
  }

  return { qualified: blockers.length === 0, blockers };
}
