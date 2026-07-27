import type { DiscoverySignal, OpportunityType, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { recordActivity } from '@/lib/audit';
import { classifyTextDeterministic, classifySide } from '@/lib/ai/classify';
import { deriveScopeFromEvidence, inferRequiredCapabilities } from '@/lib/ai/capabilities';
import { recordDecision } from '@/lib/ai/decisions';
import { recomputeMissingFields } from '@/lib/ai/transcript';
import { signalLabel } from './signals';

/** Signals weaker than this are left for human triage rather than promoted. */
const PROMOTION_THRESHOLD = 0.55;

export type PromotionResult = {
  promoted: number;
  dismissed: number;
  triaged: number;
  opportunityIds: string[];
};

/**
 * Turns raw signals into opportunities.
 *
 * Signals about the same company and deal model are grouped: three signals
 * pointing at one situation are one opportunity, not three. Weak or lone
 * signals go to TRIAGED so a Research Reviewer decides, rather than the system
 * manufacturing a deal out of thin evidence.
 */
export async function promoteSignals(params: {
  orgId: string;
  limit?: number;
}): Promise<PromotionResult> {
  const signals = await prisma.discoverySignal.findMany({
    where: { orgId: params.orgId, status: 'NEW' },
    include: { company: true, evidence: true },
    orderBy: [{ strength: 'desc' }, { observedAt: 'desc' }],
    take: params.limit ?? 200,
  });

  const result: PromotionResult = { promoted: 0, dismissed: 0, triaged: 0, opportunityIds: [] };

  // Group by company + category. Signals with no company can't be actioned.
  const groups = new Map<string, typeof signals>();
  for (const signal of signals) {
    if (!signal.companyId) {
      await prisma.discoverySignal.update({ where: { id: signal.id }, data: { status: 'TRIAGED' } });
      result.triaged += 1;
      continue;
    }
    const key = `${signal.companyId}:${signal.category}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(signal);
    groups.set(key, bucket);
  }

  for (const [, group] of groups) {
    const outcome = await promoteGroup(params.orgId, group);
    if (outcome.opportunityId) {
      result.promoted += group.length;
      result.opportunityIds.push(outcome.opportunityId);
    } else if (outcome.action === 'dismissed') {
      result.dismissed += group.length;
    } else {
      result.triaged += group.length;
    }
  }

  return result;
}

type SignalWithRelations = DiscoverySignal & {
  company: Prisma.CompanyGetPayload<object> | null;
  evidence: Prisma.SourceEvidenceGetPayload<object> | null;
};

async function promoteGroup(
  orgId: string,
  group: SignalWithRelations[],
): Promise<{ action: 'promoted' | 'triaged' | 'dismissed'; opportunityId?: string }> {
  const company = group[0].company;
  if (!company) return { action: 'triaged' };

  const combinedText = group.map((s) => `${s.headline}. ${s.detail}`).join('\n');
  const classification = classifyTextDeterministic(combinedText);

  // What the company *is* outranks what the signal text sounds like. A quarry
  // with surplus stockpile reads as demand to a keyword counter ("seeking
  // quotes" appears in the same excerpt), and treating it as a buyer would
  // send a caller to qualify a need the company does not have.
  const SUPPLY_SIDE_COMPANY_ROLES = ['SUPPLIER', 'DISTRIBUTOR', 'MANUFACTURER', 'CARRIER', 'SUBCONTRACTOR'];
  const side = SUPPLY_SIDE_COMPANY_ROLES.includes(company.companyRole)
    ? 'supply'
    : company.companyRole === 'BUYER' || company.companyRole === 'PRIME_CONTRACTOR'
      ? 'demand'
      : classifySide(combinedText);

  // Composite strength: the strongest signal, lifted by corroboration.
  const maxStrength = Math.max(...group.map((s) => s.strength));
  const corroboration = Math.min(0.2, (group.length - 1) * 0.07);
  const composite = Math.min(1, maxStrength + corroboration);

  if (composite < PROMOTION_THRESHOLD) {
    await prisma.discoverySignal.updateMany({
      where: { id: { in: group.map((s) => s.id) } },
      data: { status: 'TRIAGED' },
    });
    await recordDecision({
      orgId,
      process: 'discovery.promotion',
      decision: 'Held for human triage',
      reason: `Composite signal strength ${composite.toFixed(2)} is below the ${PROMOTION_THRESHOLD} promotion threshold. Not enough evidence to open an opportunity.`,
      inputs: { companyId: company.id, signalKeys: group.map((s) => s.signalKey), composite },
      confidence: composite,
      rulesApplied: ['promotion_threshold'],
      modelName: 'deterministic',
      promptVersion: 'promote@1',
    });
    return { action: 'triaged' };
  }

  const type: OpportunityType =
    classification.type === 'UNCLASSIFIED'
      ? (group[0].category === 'GENERAL' ? 'UNCLASSIFIED' : (group[0].category as OpportunityType))
      : classification.type;

  // Don't open a second opportunity for a situation already being worked.
  const existing = await prisma.opportunity.findFirst({
    where: {
      orgId,
      type,
      status: { notIn: ['LOST', 'DISQUALIFIED'] },
      parties: { some: { companyId: company.id, isPrimary: true } },
    },
  });

  if (existing) {
    await prisma.opportunity.update({
      where: { id: existing.id },
      data: {
        summary: `${existing.summary}\n\nNew corroborating signals: ${group.map((s) => signalLabel(s.signalKey)).join(', ')}.`,
        urgency: Math.min(1, existing.urgency + 0.05 * group.length),
        lastActivityAt: new Date(),
      },
    });
    await prisma.discoverySignal.updateMany({
      where: { id: { in: group.map((s) => s.id) } },
      data: { status: 'DUPLICATE' },
    });
    await recordActivity({
      orgId,
      opportunityId: existing.id,
      companyId: company.id,
      verb: 'discovery.signals_merged',
      summary: `${group.length} additional signal(s) merged into existing opportunity`,
      payload: { signalKeys: group.map((s) => s.signalKey) },
    });
    return { action: 'promoted', opportunityId: existing.id };
  }

  const primaryRole =
    side === 'supply'
      ? 'SUPPLIER'
      : type === 'SUBCONTRACTING'
        ? 'PRIME_CONTRACTOR'
        : 'BUYER';

  const opportunity = await prisma.opportunity.create({
    data: {
      orgId,
      name: buildOpportunityName(type, company.legalName, group),
      type,
      stage: 'RESEARCHING',
      status: 'ACTIVE',
      priority: composite >= 0.85 ? 'HIGH' : 'MEDIUM',
      signalId: group[0].id,
      location: group.find((s) => s.location)?.location ?? null,
      summary: buildSummary(company.legalName, group, classification.rationale),
      urgency: composite,
      informationCompleteness: 0.1,
      closingProbability: 0.1,
      fulfillmentConfidence: 0.2,
      missingInformation: baselineMissingInfo(type),
      aiExplanation:
        `Opened from ${group.length} discovery signal(s): ${group.map((s) => signalLabel(s.signalKey)).join('; ')}. ` +
        `${classification.rationale} Composite strength ${composite.toFixed(2)}. ` +
        'All facts here are inferred from source material and unconfirmed until a call verifies them.',
      parties: {
        create: {
          companyId: company.id,
          role: primaryRole as never,
          isPrimary: true,
          notes: `Primary party inferred from signal side: ${side}`,
        },
      },
    },
  });

  await prisma.discoverySignal.updateMany({
    where: { id: { in: group.map((s) => s.id) } },
    data: { status: 'PROMOTED' },
  });

  // The group *is* the situation, so the requirement is read from every piece
  // of evidence behind it — the strongest signal often comes from a job
  // posting while the actual scope sits in the award notice.
  const evidenceTexts = group.map((s) => s.evidence?.excerpt ?? '').filter(Boolean);
  const payload = mergePayloads(group.map((s) => (s.evidence?.rawPayload ?? {}) as Record<string, unknown>));
  const richest = [...group].sort((a, b) => (b.evidence?.excerpt.length ?? 0) - (a.evidence?.excerpt.length ?? 0))[0];

  const scope = deriveScopeFromEvidence({
    signalDetail: richest.detail,
    evidenceExcerpt: richest.evidence?.excerpt,
    evidenceTitle: richest.evidence?.title,
    opportunityName: opportunity.name,
  });
  const capabilities = await inferRequiredCapabilities(
    orgId,
    [scope, ...evidenceTexts, ...group.map((s) => s.detail), JSON.stringify(payload.trades ?? payload.categories ?? payload.materials ?? [])].join(' '),
  );

  if (side === 'supply') {
    // A supplier advertising capacity is not a buyer need. Record what they
    // say they have — unverified — and let the next-action engine send someone
    // to confirm it and find a buyer.
    const material = Array.isArray(payload.materials) ? (payload.materials[0] as Record<string, unknown>) : null;
    await prisma.supplierAvailability.create({
      data: {
        orgId,
        companyId: company.id,
        description: scope.slice(0, 400),
        quantity: typeof payload.quantity === 'number' ? payload.quantity : typeof material?.quantity === 'number' ? material.quantity : null,
        unit: typeof payload.unit === 'string' ? payload.unit : typeof material?.unit === 'string' ? material.unit : null,
        location: richest.location ?? opportunity.location,
        status: 'INFERRED',
        confidence: Math.min(0.45, composite * 0.5),
      },
    });
  } else if (type !== 'UNCLASSIFIED') {
    // Demand side gets an inferred BuyerNeed straight away. It is explicitly
    // INFERRED with its gaps listed, never CONFIRMED — but without one there
    // is nothing for matching to work against and the deal has no route
    // forward.
    const need = await prisma.buyerNeed.create({
      data: {
        orgId,
        companyId: company.id,
        opportunityType: type,
        title: opportunity.name,
        scope,
        location: richest.location ?? opportunity.location,
        requiredCapabilities: capabilities,
        quantity: extractQuantity(payload),
        unit: extractUnit(payload),
        estimatedValue: estimateOpportunityValue(payload, type),
        deadline: parseIsoDate(payload.neededBy ?? payload.dueDate ?? payload.performanceStart),
        // Everything here came from a published record, not from anyone at the
        // company confirming it.
        status: 'INFERRED',
        confidence: Math.min(0.5, composite * 0.6),
      },
    });

    await prisma.buyerNeed.update({
      where: { id: need.id },
      data: { missingFields: recomputeMissingFields(need) },
    });
    await prisma.opportunity.update({ where: { id: opportunity.id }, data: { buyerNeedId: need.id } });
  }

  await recordDecision({
    orgId,
    opportunityId: opportunity.id,
    process: 'discovery.promotion',
    decision: `Opened ${type} opportunity for ${company.legalName}`,
    reason:
      `Composite signal strength ${composite.toFixed(2)} cleared the ${PROMOTION_THRESHOLD} threshold across ` +
      `${group.length} signal(s). ${classification.rationale}`,
    inputs: { companyId: company.id, signalKeys: group.map((s) => s.signalKey), composite, side },
    outputs: { opportunityId: opportunity.id, type, primaryRole },
    confidence: composite,
    rulesApplied: ['promotion_threshold', 'signal_grouping', 'classification_lexicon'],
    modelName: 'deterministic',
    promptVersion: 'promote@1',
  });

  await recordActivity({
    orgId,
    opportunityId: opportunity.id,
    companyId: company.id,
    verb: 'opportunity.created',
    summary: `Opportunity opened from ${group.length} signal(s)`,
    payload: { signalKeys: group.map((s) => s.signalKey), type },
  });

  return { action: 'promoted', opportunityId: opportunity.id };
}

function buildOpportunityName(type: OpportunityType, companyName: string, group: SignalWithRelations[]): string {
  const label = signalLabel(group[0].signalKey);
  const prefix =
    type === 'SUBCONTRACTING' ? 'Subcontracting' : type === 'BROKERAGE' ? 'Brokerage' : type === 'DISTRIBUTION' ? 'Distribution' : 'Opportunity';
  return `${prefix}: ${companyName} — ${label}`;
}

function buildSummary(companyName: string, group: SignalWithRelations[], rationale: string): string {
  const lines = [
    `${companyName} surfaced ${group.length} opportunity signal(s).`,
    '',
    ...group.map((s) => `• ${signalLabel(s.signalKey)} — ${s.detail}`),
    '',
    rationale,
    '',
    'Status: nothing here is confirmed. Every field below is inferred from published source material and requires verification before it drives a commitment.',
  ];
  return lines.join('\n');
}

function mergePayloads(payloads: Array<Record<string, unknown>>): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const payload of payloads) {
    for (const [key, value] of Object.entries(payload)) {
      if (value === null || value === undefined) continue;
      if (merged[key] === undefined) merged[key] = value;
      else if (Array.isArray(merged[key]) && Array.isArray(value)) {
        merged[key] = [...new Set([...(merged[key] as unknown[]), ...value])];
      }
    }
  }
  return merged;
}

/**
 * Values the *opportunity*, not the record.
 *
 * A $2.85M award is not a $2.85M subcontracting opportunity — only the portion
 * being let out is. Where the record states a subcontracting goal, that is the
 * honest basis; where it does not, no value is asserted and it is reported as
 * missing rather than guessed from the headline number.
 */
function estimateOpportunityValue(payload: Record<string, unknown>, type: OpportunityType): number | null {
  if (typeof payload.monthlySpend === 'number') return payload.monthlySpend * 12;

  const awardValue = typeof payload.value === 'number' ? payload.value : null;
  if (type === 'SUBCONTRACTING' && awardValue !== null) {
    const goalPct = typeof payload.subcontractingGoalPct === 'number' ? payload.subcontractingGoalPct : null;
    // Without a stated goal the subcontracted share is unknown. Do not guess.
    return goalPct !== null ? Math.round((awardValue * goalPct) / 100) : null;
  }
  if (type === 'BROKERAGE') {
    // Brokerage value follows the material, not the prime contract.
    return null;
  }
  if (typeof payload.valuation === 'number') return payload.valuation;
  return awardValue;
}

function extractQuantity(payload: Record<string, unknown>): number | null {
  if (typeof payload.quantity === 'number') return payload.quantity;
  const materials = Array.isArray(payload.materials) ? (payload.materials[0] as Record<string, unknown>) : null;
  return typeof materials?.quantity === 'number' ? materials.quantity : null;
}

function extractUnit(payload: Record<string, unknown>): string | null {
  if (typeof payload.unit === 'string') return payload.unit;
  const materials = Array.isArray(payload.materials) ? (payload.materials[0] as Record<string, unknown>) : null;
  return typeof materials?.unit === 'string' ? materials.unit : null;
}

function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

function baselineMissingInfo(type: OpportunityType): string[] {
  const shared = ['Decision-maker contact', 'Confirmed scope', 'Timeline', 'Budget or price expectation'];
  if (type === 'SUBCONTRACTING') {
    return [...shared, 'Required licenses and insurance', 'Current provider and their performance', 'Candidate subcontractor with capacity'];
  }
  if (type === 'BROKERAGE') {
    return [...shared, 'Exact specification', 'Quantity', 'Delivery requirements', 'Confirmed supply source and price'];
  }
  if (type === 'DISTRIBUTION') {
    return [...shared, 'Product list and specifications', 'Purchase frequency and volume', 'Current supplier and pricing', 'Freight requirements'];
  }
  return shared;
}
