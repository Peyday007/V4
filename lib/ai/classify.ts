import { z } from 'zod';
import type { CompanyRole, OpportunityType, SignalCategory } from '@prisma/client';
import { getLLM } from '@/lib/providers/llm';
import { clamp01 } from './decisions';

export const PROMPT_VERSION = 'classify@2';

/**
 * Keyword lexicons drive the deterministic classifier. They are intentionally
 * explicit and auditable: a reviewer can see exactly why a signal was typed
 * the way it was, which an opaque score cannot provide.
 */
const SUBCONTRACTING_TERMS = [
  'subcontract', 'sub-contract', 'subcontractor', 'trade partner', 'prime contractor',
  'awarded a contract', 'contract award', 'general contractor', 'overflow', 'capacity constraint',
  'need crews', 'additional crews', 'staffing shortage', 'local coverage', 'field service partner',
  'outsource', 'outsourcing', 'sub award', 'small business participation', 'sbe goal', 'mbe goal',
  'scope of work', 'multi-trade', 'renovation', 'build-out', 'buildout', 'emergency coverage',
  'night shift', 'weekend coverage', 'incumbent underperforming', 'service territory',
];

const BROKERAGE_TERMS = [
  'excess inventory', 'surplus', 'available capacity', 'unused capacity', 'spot capacity',
  'seeking quotes', 'request for quote', 'rfq', 'multiple quotes', 'sourcing', 'procure',
  'shortage', 'lead time', 'freight', 'truckload', 'delivered price', 'fob', 'aggregate',
  'looking for suppliers', 'need a source', 'backhaul', 'disposal capacity', 'recycling capacity',
  'liquidation', 'allocation', 'broker',
];

const DISTRIBUTION_TERMS = [
  'recurring order', 'reorder', 'standing order', 'monthly supply', 'consumables', 'janitorial supplies',
  'safety supplies', 'packaging', 'ppe', 'replacement parts', 'restock', 'purchase order',
  'multiple locations', 'multi-site', 'branches', 'vendor consolidation', 'consolidate vendors',
  'price increase', 'price sensitivity', 'stockout', 'out of stock', 'substitution', 'scheduled delivery',
  'one vendor', 'supply agreement', 'blanket order',
];

const BUYER_TERMS = ['seeking', 'needs', 'requires', 'looking for', 'requesting', 'shortage', 'rfp', 'rfq', 'solicitation'];
const SUPPLY_TERMS = ['available', 'in stock', 'capacity', 'we supply', 'distributor of', 'manufacturer of', 'inventory'];

export type ClassificationResult = {
  type: OpportunityType;
  category: SignalCategory;
  confidence: number;
  matchedTerms: string[];
  rationale: string;
};

function countMatches(haystack: string, terms: string[]): string[] {
  return terms.filter((term) => haystack.includes(term));
}

/** Deterministic classifier — always runs, and is the fallback for the LLM. */
export function classifyTextDeterministic(text: string): ClassificationResult {
  const lower = text.toLowerCase();
  const sub = countMatches(lower, SUBCONTRACTING_TERMS);
  const brk = countMatches(lower, BROKERAGE_TERMS);
  const dist = countMatches(lower, DISTRIBUTION_TERMS);

  const scores: Array<[OpportunityType, SignalCategory, string[]]> = [
    ['SUBCONTRACTING', 'SUBCONTRACTING', sub],
    ['BROKERAGE', 'BROKERAGE', brk],
    ['DISTRIBUTION', 'DISTRIBUTION', dist],
  ];
  scores.sort((a, b) => b[2].length - a[2].length);

  const [topType, topCategory, topTerms] = scores[0];
  const [, , secondTerms] = scores[1];

  if (topTerms.length === 0) {
    return {
      type: 'UNCLASSIFIED',
      category: 'GENERAL',
      confidence: 0.15,
      matchedTerms: [],
      rationale: 'No subcontracting, brokerage or distribution language detected. Needs human triage.',
    };
  }

  // Two strong readings at once is a hybrid, not a coin flip.
  const isHybrid = secondTerms.length >= 2 && topTerms.length - secondTerms.length <= 1;
  const matched = isHybrid ? [...topTerms, ...secondTerms] : topTerms;
  const confidence = clamp01(0.35 + Math.min(matched.length, 6) * 0.09 - (isHybrid ? 0.05 : 0));

  return {
    type: isHybrid ? 'HYBRID' : topType,
    category: isHybrid ? 'GENERAL' : topCategory,
    confidence,
    matchedTerms: matched,
    rationale: isHybrid
      ? `Signal carries both ${scores[0][0].toLowerCase()} and ${scores[1][0].toLowerCase()} language (${matched.join(', ')}).`
      : `Matched ${topType.toLowerCase()} language: ${topTerms.join(', ')}.`,
  };
}

const classificationSchema = z.object({
  type: z.enum(['SUBCONTRACTING', 'BROKERAGE', 'DISTRIBUTION', 'HYBRID', 'UNCLASSIFIED']),
  category: z.enum(['SUBCONTRACTING', 'BROKERAGE', 'DISTRIBUTION', 'GENERAL']),
  confidence: z.number().min(0).max(1),
  matchedTerms: z.array(z.string()),
  rationale: z.string(),
});

export async function classifyOpportunityText(text: string): Promise<{
  result: ClassificationResult;
  modelName: string;
  promptVersion: string;
}> {
  const deterministic = classifyTextDeterministic(text);
  const llm = getLLM();
  const response = await llm.structured({
    promptVersion: PROMPT_VERSION,
    system:
      'You classify raw business signals into deal models. Answer only from the text provided. ' +
      'Never assert a business fact that is not present. If the text does not clearly indicate a ' +
      'subcontracting, brokerage or distribution opportunity, return UNCLASSIFIED with low confidence.',
    user: `Classify this signal:\n\n${text}`,
    schema: classificationSchema,
    fallback: () => deterministic,
  });

  return {
    result: response.data as ClassificationResult,
    modelName: response.modelName,
    promptVersion: response.promptVersion,
  };
}

/** Infers a company's position in the graph from its own description. */
export function classifyCompanyRole(input: {
  description?: string | null;
  capabilities?: string[];
  products?: string[];
  industryKeys?: string[];
}): { role: CompanyRole; confidence: number; rationale: string } {
  const text = [
    input.description ?? '',
    ...(input.capabilities ?? []),
    ...(input.products ?? []),
    ...(input.industryKeys ?? []),
  ]
    .join(' ')
    .toLowerCase();

  const signals: Array<[CompanyRole, string[]]> = [
    ['PRIME_CONTRACTOR', ['general contractor', 'prime contractor', 'construction manager', 'design-build']],
    ['SUBCONTRACTOR', ['subcontractor', 'trade contractor', 'crews', 'janitorial services', 'electrical contractor', 'landscaping services']],
    ['DISTRIBUTOR', ['distributor', 'wholesale', 'wholesaler', 'stocking dealer']],
    ['MANUFACTURER', ['manufacturer', 'we manufacture', 'production facility', 'mill', 'quarry']],
    ['SUPPLIER', ['supplier', 'we supply', 'materials supplier', 'vendor']],
    ['CARRIER', ['trucking', 'carrier', 'freight hauler', 'logistics provider']],
    ['BUYER', ['property management', 'facility management', 'we purchase', 'procurement', 'owner']],
  ];

  const hits = signals
    .map(([role, terms]) => ({ role, matched: terms.filter((t) => text.includes(t)) }))
    .filter((h) => h.matched.length > 0)
    .sort((a, b) => b.matched.length - a.matched.length);

  if (hits.length === 0) {
    return { role: 'UNKNOWN', confidence: 0.1, rationale: 'No role-identifying language found; requires research.' };
  }
  if (hits.length > 1 && hits[0].matched.length === hits[1].matched.length) {
    return {
      role: 'HYBRID',
      confidence: 0.45,
      rationale: `Operates in multiple roles (${hits[0].role}, ${hits[1].role}).`,
    };
  }
  return {
    role: hits[0].role,
    confidence: clamp01(0.4 + hits[0].matched.length * 0.15),
    rationale: `Matched ${hits[0].role.toLowerCase()} language: ${hits[0].matched.join(', ')}.`,
  };
}

/** Whether a signal reads as demand-side or supply-side. Drives who to call. */
export function classifySide(text: string): 'demand' | 'supply' | 'unknown' {
  const lower = text.toLowerCase();
  const demand = countMatches(lower, BUYER_TERMS).length;
  const supply = countMatches(lower, SUPPLY_TERMS).length;
  if (demand === supply) return 'unknown';
  return demand > supply ? 'demand' : 'supply';
}
