import type { OpportunityType, Prisma } from '@prisma/client';
import { num, num0, prisma } from '@/lib/db';
import { getOrgConfig, type OrgConfig } from '@/lib/config';
import { recordActivity } from '@/lib/audit';
import { recordDecision, round } from './decisions';
import { evaluateGovernance } from './escalation';

export const DEAL_CONFIG_VERSION = 'deal_config@2';

export type DealConfigResult = {
  isConfigurable: boolean;
  configuration: Record<string, unknown>;
  missingTerms: string[];
  risks: string[];
  requiredApprovals: string[];
  buyerPrice: number | null;
  supplierCost: number | null;
  freightCost: number | null;
  grossProfit: number | null;
  grossMarginPct: number | null;
  explanation: string;
};

/**
 * Builds the deal from confirmed data only.
 *
 * The rule that matters here: a term that is not known is reported as missing.
 * It is never invented, never averaged, never "assumed standard". An
 * unconfigurable deal returns the exact list of what is absent so the
 * next-action engine can go get it.
 */
export async function configureDeal(opportunityId: string): Promise<DealConfigResult> {
  const opportunity = await prisma.opportunity.findUniqueOrThrow({
    where: { id: opportunityId },
    include: {
      parties: { include: { company: true } },
      buyerNeed: true,
      matches: { include: { candidate: true, supply: true, capacity: true }, orderBy: { score: 'desc' } },
      quotes: { include: { lineItems: true } },
      deal: true,
    },
  });
  const config = await getOrgConfig(opportunity.orgId);

  const buyer = opportunity.parties.find((p) => p.isPrimary)?.company ?? opportunity.parties[0]?.company ?? null;
  const selected = opportunity.matches.find((m) => m.isSelected) ?? opportunity.matches[0] ?? null;
  const need = opportunity.buyerNeed;

  const result =
    opportunity.type === 'SUBCONTRACTING'
      ? buildSubcontractingDeal({ opportunity, buyer, selected, need, config })
      : opportunity.type === 'BROKERAGE'
        ? buildBrokerageDeal({ opportunity, buyer, selected, need, config })
        : opportunity.type === 'DISTRIBUTION'
          ? buildDistributionDeal({ opportunity, buyer, selected, need, config })
          : buildGenericDeal({ opportunity, buyer, selected, need, config });

  const deal = await prisma.deal.upsert({
    where: { opportunityId },
    create: {
      orgId: opportunity.orgId,
      opportunityId,
      type: opportunity.type,
      configuration: result.configuration as object,
      buyerPrice: result.buyerPrice,
      supplierCost: result.supplierCost,
      freightCost: result.freightCost,
      grossProfit: result.grossProfit,
      grossMarginPct: result.grossMarginPct,
      risks: result.risks,
      missingTerms: result.missingTerms,
      requiredApprovals: result.requiredApprovals,
      isConfigurable: result.isConfigurable,
      configuredAt: result.isConfigurable ? new Date() : null,
      configuredBy: 'ai',
    },
    update: {
      type: opportunity.type,
      configuration: result.configuration as object,
      buyerPrice: result.buyerPrice,
      supplierCost: result.supplierCost,
      freightCost: result.freightCost,
      grossProfit: result.grossProfit,
      grossMarginPct: result.grossMarginPct,
      risks: result.risks,
      missingTerms: result.missingTerms,
      requiredApprovals: result.requiredApprovals,
      isConfigurable: result.isConfigurable,
      configuredAt: result.isConfigurable ? new Date() : null,
      version: { increment: 1 },
    },
  });

  if (result.isConfigurable && result.buyerPrice !== null && result.supplierCost !== null) {
    await prisma.margin.create({
      data: {
        dealId: deal.id,
        revenue: result.buyerPrice,
        cost: result.supplierCost + (result.freightCost ?? 0),
        grossProfit: result.grossProfit ?? 0,
        grossMarginPct: result.grossMarginPct ?? 0,
        belowThreshold: (result.grossMarginPct ?? 0) < config.marginRules.minimumGrossMarginPct,
        thresholdPct: config.marginRules.minimumGrossMarginPct,
      },
    });

    await prisma.cost.deleteMany({ where: { dealId: deal.id } });
    const costLines: Array<{ label: string; category: string; amount: number }> = [
      { label: opportunity.type === 'SUBCONTRACTING' ? 'Subcontractor cost' : 'Supplier cost', category: 'direct', amount: result.supplierCost },
    ];
    if (result.freightCost) costLines.push({ label: 'Freight', category: 'logistics', amount: result.freightCost });
    await prisma.cost.createMany({
      data: costLines.map((line) => ({
        dealId: deal.id,
        label: line.label,
        category: line.category,
        amount: line.amount,
        status: 'CLAIMED' as const,
        sourceRef: selected ? `match:${selected.id}` : null,
      })),
    });
  }

  await prisma.opportunity.update({
    where: { id: opportunityId },
    data: {
      estimatedValue: result.buyerPrice ?? opportunity.estimatedValue,
      estimatedGrossProfit: result.grossProfit ?? opportunity.estimatedGrossProfit,
      missingInformation: result.missingTerms,
      primaryBlocker: result.isConfigurable ? null : result.missingTerms[0] ?? null,
    },
  });

  await recordDecision({
    orgId: opportunity.orgId,
    opportunityId,
    process: 'deal_configuration',
    decision: result.isConfigurable
      ? `Configured ${opportunity.type} deal: $${result.buyerPrice?.toFixed(0)} buyer price, $${result.grossProfit?.toFixed(0)} gross profit`
      : `Deal not configurable — ${result.missingTerms.length} term(s) missing`,
    reason: result.explanation,
    inputs: { selectedMatchId: selected?.id, needId: need?.id },
    outputs: result as unknown as Record<string, unknown>,
    confidence: result.isConfigurable ? 0.75 : 0.9,
    rulesApplied: ['no_fabricated_terms', 'margin_rules', 'approval_limits'],
    modelName: 'deterministic',
    promptVersion: DEAL_CONFIG_VERSION,
  });

  await recordActivity({
    orgId: opportunity.orgId,
    opportunityId,
    verb: result.isConfigurable ? 'deal.configured' : 'deal.blocked',
    summary: result.isConfigurable
      ? `Deal configured: $${result.buyerPrice?.toFixed(0)} price, ${result.grossMarginPct?.toFixed(1)}% margin`
      : `Deal cannot be configured — missing: ${result.missingTerms.slice(0, 3).join(', ')}`,
    payload: { missingTerms: result.missingTerms, risks: result.risks },
  });

  if (result.isConfigurable) await evaluateGovernance(opportunityId);

  return result;
}

type BuildArgs = {
  opportunity: Prisma.OpportunityGetPayload<{ include: { quotes: { include: { lineItems: true } } } }>;
  buyer: { id: string; legalName: string } | null;
  selected: Prisma.MatchGetPayload<{ include: { candidate: true; supply: true; capacity: true } }> | null;
  need: Prisma.BuyerNeedGetPayload<object> | null;
  config: OrgConfig;
};

function baseChecks(args: BuildArgs): { missing: string[]; risks: string[] } {
  const missing: string[] = [];
  const risks: string[] = [];
  if (!args.buyer) missing.push('Buyer or prime contractor');
  if (!args.need) missing.push('Confirmed scope of work');
  if (!args.selected) missing.push('Fulfillment partner');
  if (args.need && args.need.status !== 'CONFIRMED') {
    risks.push(`Scope is ${args.need.status.toLowerCase()}, not confirmed — re-verify before contracting.`);
  }
  if (args.selected && args.selected.missingInformation.length > 0) {
    risks.push(`Fulfillment partner has unverified: ${args.selected.missingInformation.join(', ')}.`);
  }
  return { missing, risks };
}

function finalise(
  args: BuildArgs,
  configuration: Record<string, unknown>,
  missing: string[],
  risks: string[],
  money: { buyerPrice: number | null; supplierCost: number | null; freightCost: number | null },
): DealConfigResult {
  const { config } = args;
  const totalCost = money.supplierCost !== null ? money.supplierCost + (money.freightCost ?? 0) : null;
  const grossProfit = money.buyerPrice !== null && totalCost !== null ? round(money.buyerPrice - totalCost) : null;
  const grossMarginPct = grossProfit !== null && money.buyerPrice ? round((grossProfit / money.buyerPrice) * 100, 1) : null;

  const requiredApprovals: string[] = [];
  if (money.buyerPrice !== null && money.buyerPrice > config.approvalLimits.dealValueRequiringApproval) {
    requiredApprovals.push(`Deal terms approval (value exceeds $${config.approvalLimits.dealValueRequiringApproval})`);
  }
  if (grossProfit !== null && grossProfit > config.approvalLimits.grossProfitRequiringApproval) {
    requiredApprovals.push('Pricing approval (gross profit exceeds review threshold)');
  }
  if (grossMarginPct !== null && grossMarginPct < config.marginRules.minimumGrossMarginPct) {
    requiredApprovals.push(`Margin exception (${grossMarginPct}% below the ${config.marginRules.minimumGrossMarginPct}% floor)`);
    risks.push('Margin is below the configured floor.');
  }
  if (args.opportunity.type === 'DISTRIBUTION' && totalCost !== null && totalCost > config.approvalLimits.cashExposureLimit) {
    requiredApprovals.push('Credit and cash exposure approval');
  }

  const isConfigurable = missing.length === 0 && money.buyerPrice !== null && money.supplierCost !== null;

  const explanation = isConfigurable
    ? `All required terms are present. Buyer price $${money.buyerPrice?.toFixed(0)}, cost $${totalCost?.toFixed(0)}, ` +
      `gross profit $${grossProfit?.toFixed(0)} (${grossMarginPct}%). ` +
      (requiredApprovals.length ? `Requires: ${requiredApprovals.join('; ')}.` : 'Within standard authority.') +
      (risks.length ? ` Open risks: ${risks.join(' ')}` : '')
    : `Deal cannot be configured. ${missing.length} term(s) are unknown and will not be assumed: ${missing.join(', ')}. ` +
      'Calls and tasks have been created to obtain them.';

  return {
    isConfigurable,
    configuration,
    missingTerms: missing,
    risks,
    requiredApprovals,
    buyerPrice: money.buyerPrice,
    supplierCost: money.supplierCost,
    freightCost: money.freightCost,
    grossProfit,
    grossMarginPct,
    explanation,
  };
}

function buildSubcontractingDeal(args: BuildArgs): DealConfigResult {
  const { missing, risks } = baseChecks(args);
  const { need, selected, buyer, config } = args;
  const capacity = selected?.capacity ?? null;

  const buyerPrice = num(need?.estimatedValue) ?? num(selected?.estimatedRevenue);
  let supplierCost = num(selected?.estimatedCost);
  if (supplierCost === null && capacity?.monthlyRate) {
    supplierCost = round(num0(capacity.monthlyRate) * (need?.frequency === 'recurring' ? 12 : 1));
  }

  if (buyerPrice === null) missing.push('Buyer price or contract value');
  if (supplierCost === null) missing.push('Subcontractor cost');
  if (!need?.startDate) missing.push('Start date');
  if (!need?.location) missing.push('Site location');
  if (!capacity?.licenses?.length && need?.requiredCapabilities.some((c) => config.riskRules.requireLicenseForTrades.some((t) => c.toLowerCase().includes(t)))) {
    missing.push('Subcontractor trade licence');
  }
  if (capacity && Object.keys(capacity.insuranceLimits as object).length === 0) {
    missing.push('Subcontractor insurance limits');
  }

  const managementFee =
    buyerPrice !== null && supplierCost !== null ? round(buyerPrice - supplierCost) : null;

  const configuration = {
    model: 'subcontracting',
    primeContractorOrBuyer: buyer?.legalName ?? null,
    subcontractor: selected?.candidate.legalName ?? null,
    scope: need?.scope ?? null,
    location: need?.location ?? null,
    schedule: {
      startDate: need?.startDate ?? null,
      deadline: need?.deadline ?? null,
      frequency: need?.frequency ?? null,
      shiftAvailability: capacity?.shiftAvailability ?? [],
    },
    requiredLabor: capacity?.crewCount ? `${capacity.crewCount} crew(s)` : null,
    requiredEquipment: 'To be confirmed with the subcontractor',
    materialsResponsibility: capacity?.suppliesConsumables === true
      ? 'Subcontractor supplies consumables'
      : capacity?.suppliesConsumables === false
        ? 'Buyer or we supply consumables'
        : null,
    licensing: capacity?.licenses ?? [],
    insurance: capacity?.insuranceLimits ?? {},
    certifications: need?.requiredCertifications ?? [],
    deliverables: need?.scope ?? null,
    qualityRequirements: 'Per buyer specification — to be documented in the scope of work',
    buyerPrice,
    subcontractorCost: supplierCost,
    managementFee,
    managementFeePct:
      buyerPrice && managementFee !== null ? round((managementFee / buyerPrice) * 100, 1) : null,
    paymentTiming: null,
  };

  return finalise(args, configuration, missing, risks, { buyerPrice, supplierCost, freightCost: null });
}

function buildBrokerageDeal(args: BuildArgs): DealConfigResult {
  const { missing, risks } = baseChecks(args);
  const { need, selected } = args;
  const supply = selected?.supply ?? null;

  const quantity = num(need?.quantity);
  const unitCost = num(supply?.unitCost);
  const supplierCost = unitCost !== null && quantity !== null ? round(unitCost * quantity) : num(selected?.estimatedCost);

  // Freight is a separate, explicit line. If it is unknown, the deal is not
  // configurable — a delivered price built on an assumed freight rate is a
  // fabricated term.
  const freightCost = supply?.freightBasis?.toLowerCase().includes('delivered') ? 0 : null;
  const buyerPrice = num(need?.estimatedValue) ?? num(selected?.estimatedRevenue);

  if (quantity === null) missing.push('Quantity');
  if (!need?.unit) missing.push('Unit of measure');
  if (unitCost === null && supplierCost === null) missing.push('Source price');
  if (freightCost === null) missing.push('Freight or fulfillment cost');
  if (buyerPrice === null) missing.push('Buyer price');
  if (!need?.deadline && !need?.startDate) missing.push('Delivery timing');
  if (!supply?.location && !need?.location) missing.push('Delivery point');

  const spread = buyerPrice !== null && supplierCost !== null ? round(buyerPrice - supplierCost - (freightCost ?? 0)) : null;

  const configuration = {
    model: 'brokerage',
    buyer: args.buyer?.legalName ?? null,
    sellerOrSupplier: selected?.candidate.legalName ?? null,
    item: supply?.description ?? need?.scope ?? null,
    specification: need?.requiredCapabilities ?? [],
    quantity,
    unit: need?.unit ?? null,
    sourcePrice: unitCost,
    freightBasis: supply?.freightBasis ?? null,
    freightCost,
    buyerPrice,
    spread,
    spreadPct: buyerPrice && spread !== null ? round((spread / buyerPrice) * 100, 1) : null,
    deliveryTerms: supply?.freightBasis ?? null,
    paymentTerms: null,
    timing: { availableFrom: supply?.availableFrom ?? null, requiredBy: need?.deadline ?? need?.startDate ?? null, leadTimeDays: supply?.leadTimeDays ?? null },
    requiredConfirmations: [
      'Supplier confirms quantity is still available at the quoted price',
      'Freight rate confirmed to the exact delivery point',
      'Buyer confirms specification and delivery window',
    ],
  };

  if (supply?.staleAfter && supply.staleAfter < new Date()) {
    risks.push(`Supplier availability expired ${supply.staleAfter.toISOString().slice(0, 10)} — re-confirm before committing.`);
  }

  return finalise(args, configuration, missing, risks, { buyerPrice, supplierCost, freightCost });
}

function buildDistributionDeal(args: BuildArgs): DealConfigResult {
  const { missing, risks } = baseChecks(args);
  const { need, selected, opportunity } = args;
  const supply = selected?.supply ?? null;

  const inboundQuote = opportunity.quotes.find((q) => q.direction === 'inbound');
  const lineItems = inboundQuote?.lineItems ?? [];

  const productCost = lineItems.length
    ? round(lineItems.reduce((sum, li) => sum + num0(li.lineCost), 0))
    : num(selected?.estimatedCost);
  const buyerPrice = num(need?.estimatedValue) ?? num(selected?.estimatedRevenue);
  const freightCost = supply?.freightBasis?.toLowerCase().includes('delivered') ? 0 : null;

  if (lineItems.length === 0 && productCost === null) missing.push('Product list with costs');
  if (buyerPrice === null) missing.push('Customer price');
  if (freightCost === null) missing.push('Freight terms');
  if (!need?.frequency) missing.push('Purchase frequency');
  if (num(need?.quantity) === null && lineItems.length === 0) missing.push('Purchase volume');

  const configuration = {
    model: 'distribution',
    customer: args.buyer?.legalName ?? null,
    manufacturerOrSupplier: selected?.candidate.legalName ?? null,
    productList: lineItems.map((li) => ({
      description: li.description,
      quantity: num0(li.quantity),
      unit: li.unit,
      unitCost: num0(li.unitCost),
      unitPrice: num0(li.unitPrice),
    })),
    purchaseQuantity: num(need?.quantity),
    recurringFrequency: need?.frequency ?? null,
    productCost,
    freightCost,
    storageOrHandling: 0,
    customerPrice: buyerPrice,
    grossMargin: buyerPrice !== null && productCost !== null ? round(buyerPrice - productCost - (freightCost ?? 0)) : null,
    reorderRules: need?.frequency === 'recurring' ? 'Reorder on the agreed delivery schedule; confirm quantities each cycle.' : null,
    substitutionRules: 'No substitutions without written customer approval.',
    deliverySchedule: null,
    accountExpansionPotential: need?.location ?? null,
  };

  if (need?.currentProviderIssues.length) {
    risks.push(`Incumbent issues create the opening but also set the bar: ${need.currentProviderIssues.join(', ')}.`);
  }

  return finalise(args, configuration, missing, risks, { buyerPrice, supplierCost: productCost, freightCost });
}

function buildGenericDeal(args: BuildArgs): DealConfigResult {
  const { missing, risks } = baseChecks(args);
  missing.push('Opportunity type must be classified before a deal can be configured');
  return finalise(
    args,
    { model: 'unclassified', note: 'Classify this opportunity as subcontracting, brokerage or distribution first.' },
    missing,
    risks,
    { buyerPrice: null, supplierCost: null, freightCost: null },
  );
}
