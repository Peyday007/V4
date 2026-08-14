import type { Priority } from '@prisma/client';
import { num, num0, prisma } from '@/lib/db';
import { getOrgConfig, type OrgConfig } from '@/lib/config';
import { clamp01, recordDecision, round } from './decisions';

export const SCORING_VERSION = 'scoring@3';

export type ScoreReason = { dimension: string; value: number; because: string };

export type ScoreBreakdown = {
  needStrength: number;
  capabilityMatch: number;
  urgency: number;
  informationCompleteness: number;
  contactability: number;
  switchingWillingness: number;
  incumbentWeakness: number;
  supplyAvailability: number;
  expectedGrossProfit: number;
  closingProbability: number;
  repeatPotential: number;
  expansionValue: number;
  fulfillmentRisk: number;
  paymentRisk: number;
  complianceRisk: number;
  competitivePressure: number;
  timeToClose: number;
  compositeScore: number;
  expectedValue: number;
  reasons: ScoreReason[];
};

/**
 * Expected Opportunity Value = Gross Profit x Closing Probability x Fulfillment
 * Confidence, then adjusted for time sensitivity, effort, cash exposure, legal
 * complexity and strategic value. Kept pure so it is directly testable.
 */
export function expectedOpportunityValue(input: {
  grossProfit: number;
  closingProbability: number;
  fulfillmentConfidence: number;
  timeSensitivity?: number;
  callerEffort?: number;
  managementEffort?: number;
  cashExposure?: number;
  legalComplexity?: number;
  strategicValue?: number;
}): { value: number; adjustments: ScoreReason[] } {
  const base = input.grossProfit * clamp01(input.closingProbability) * clamp01(input.fulfillmentConfidence);
  const adjustments: ScoreReason[] = [];
  let multiplier = 1;

  if (input.timeSensitivity !== undefined && input.timeSensitivity > 0.6) {
    multiplier *= 1.1;
    adjustments.push({ dimension: 'timeSensitivity', value: 1.1, because: 'Time-sensitive work closes faster and competes less.' });
  }
  if (input.callerEffort !== undefined && input.callerEffort > 0.6) {
    multiplier *= 0.85;
    adjustments.push({ dimension: 'callerEffort', value: 0.85, because: 'High caller effort reduces the return per hour worked.' });
  }
  if (input.managementEffort !== undefined && input.managementEffort > 0.6) {
    multiplier *= 0.9;
    adjustments.push({ dimension: 'managementEffort', value: 0.9, because: 'Heavy management involvement is scarce capacity.' });
  }
  if (input.cashExposure !== undefined && input.cashExposure > 0.5) {
    multiplier *= 0.85;
    adjustments.push({ dimension: 'cashExposure', value: 0.85, because: 'Cash must be fronted before collection.' });
  }
  if (input.legalComplexity !== undefined && input.legalComplexity > 0.5) {
    multiplier *= 0.9;
    adjustments.push({ dimension: 'legalComplexity', value: 0.9, because: 'Legal or regulatory complexity slows and risks the deal.' });
  }
  if (input.strategicValue !== undefined && input.strategicValue > 0.6) {
    multiplier *= 1.15;
    adjustments.push({ dimension: 'strategicValue', value: 1.15, because: 'Strategic account value exceeds this transaction alone.' });
  }

  return { value: round(base * multiplier), adjustments };
}

export function compositeFromDimensions(
  dimensions: Omit<ScoreBreakdown, 'compositeScore' | 'expectedValue' | 'reasons' | 'expectedGrossProfit'>,
  weights: Record<string, number>,
): number {
  let weighted = 0;
  let positiveWeight = 0;
  for (const [key, weight] of Object.entries(weights)) {
    const value = (dimensions as unknown as Record<string, number>)[key];
    if (typeof value !== 'number') continue;
    weighted += value * weight;
    if (weight > 0) positiveWeight += weight;
  }
  // Normalise into 0..1 against the maximum achievable positive contribution.
  return clamp01(positiveWeight > 0 ? weighted / positiveWeight : 0);
}

/** Scores one opportunity from current database state and persists the result. */
export async function scoreOpportunity(opportunityId: string): Promise<ScoreBreakdown> {
  const opportunity = await prisma.opportunity.findUniqueOrThrow({
    where: { id: opportunityId },
    include: {
      parties: { include: { company: { include: { contacts: true, locations: true } } } },
      buyerNeed: true,
      matches: { orderBy: { score: 'desc' } },
      deal: true,
      quotes: true,
      signal: true,
      lane: true,
    },
  });
  const config = await getOrgConfig(opportunity.orgId);
  const reasons: ScoreReason[] = [];

  const primary = opportunity.parties.find((p) => p.isPrimary)?.company ?? opportunity.parties[0]?.company ?? null;
  const need = opportunity.buyerNeed;
  const bestMatch = opportunity.matches[0] ?? null;

  // --- Need strength -------------------------------------------------------
  let needStrength = 0.25;
  if (need) {
    needStrength = need.status === 'CONFIRMED' ? 0.95 : need.status === 'CLAIMED' ? 0.7 : need.confidence;
    reasons.push({
      dimension: 'needStrength',
      value: needStrength,
      because: `Buyer need is ${need.status.toLowerCase()} (confidence ${need.confidence.toFixed(2)}).`,
    });
  } else {
    needStrength = clamp01((opportunity.signal?.strength ?? 0.3) * 0.6);
    reasons.push({
      dimension: 'needStrength',
      value: needStrength,
      because: 'No confirmed buyer need yet; inferred from discovery signal only.',
    });
  }

  // --- Capability match ----------------------------------------------------
  const capabilityMatch = bestMatch ? clamp01(bestMatch.score) : 0;
  reasons.push({
    dimension: 'capabilityMatch',
    value: capabilityMatch,
    because: bestMatch
      ? `Best candidate scores ${bestMatch.score.toFixed(2)}: ${bestMatch.explanation.slice(0, 160)}`
      : 'No fulfillment candidate identified yet.',
  });

  // --- Urgency -------------------------------------------------------------
  const deadline = need?.deadline ?? need?.startDate ?? opportunity.dueDate;
  let urgency = opportunity.urgency;
  if (deadline) {
    const days = (deadline.getTime() - Date.now()) / 86_400_000;
    urgency = days <= 0 ? 1 : days <= 7 ? 0.95 : days <= 21 ? 0.8 : days <= 60 ? 0.55 : 0.3;
    reasons.push({ dimension: 'urgency', value: urgency, because: `${Math.round(days)} days until the stated date.` });
  } else {
    reasons.push({ dimension: 'urgency', value: urgency, because: 'No confirmed date; urgency carried from signal strength.' });
  }

  // --- Information completeness -------------------------------------------
  const missingCount = opportunity.missingInformation.length;
  const informationCompleteness = clamp01(1 - missingCount / 10);
  reasons.push({
    dimension: 'informationCompleteness',
    value: informationCompleteness,
    because: missingCount === 0 ? 'No outstanding information gaps.' : `${missingCount} unanswered question(s): ${opportunity.missingInformation.slice(0, 3).join(', ')}.`,
  });

  // --- Contactability ------------------------------------------------------
  const contacts = primary?.contacts ?? [];
  const reachable = contacts.filter((c) => (c.phone || c.mobile || c.email) && c.consentToCall);
  const decisionMakers = reachable.filter((c) => c.decisionAuthority === 'decision_maker');
  const contactability = clamp01(reachable.length === 0 ? 0 : 0.5 + (decisionMakers.length > 0 ? 0.4 : 0) + Math.min(0.1, reachable.length * 0.03));
  reasons.push({
    dimension: 'contactability',
    value: contactability,
    because: reachable.length === 0
      ? 'No reachable contact on file.'
      : `${reachable.length} reachable contact(s), ${decisionMakers.length} with decision authority.`,
  });

  // --- Switching willingness / incumbent weakness --------------------------
  const movability = primary?.movability ?? 'UNKNOWN';
  const switchingWillingness =
    movability === 'ACTIVELY_MOVABLE' ? 0.9 : movability === 'CONDITIONALLY_MOVABLE' ? 0.6 : movability === 'RELATIONSHIP_LOCKED' ? 0.12 : 0.35;
  reasons.push({
    dimension: 'switchingWillingness',
    value: switchingWillingness,
    because: `Account classified ${movability.replace(/_/g, ' ').toLowerCase()}${primary?.movabilityReasons.length ? `: ${primary.movabilityReasons.slice(0, 2).join('; ')}` : ''}.`,
  });

  const incumbentIssues = need?.currentProviderIssues.length ?? 0;
  const incumbentWeakness = clamp01(incumbentIssues > 0 ? 0.5 + incumbentIssues * 0.15 : primary ? clamp01(primary.movabilityScore) * 0.7 : 0.2);
  reasons.push({
    dimension: 'incumbentWeakness',
    value: incumbentWeakness,
    because: incumbentIssues > 0
      ? `${incumbentIssues} documented incumbent problem(s): ${need?.currentProviderIssues.slice(0, 3).join(', ')}.`
      : 'No documented incumbent problems.',
  });

  // --- Supply availability -------------------------------------------------
  const viableMatches = opportunity.matches.filter((m) => m.score >= 0.5).length;
  const supplyAvailability = clamp01(viableMatches === 0 ? 0.1 : Math.min(1, 0.45 + viableMatches * 0.18));
  reasons.push({
    dimension: 'supplyAvailability',
    value: supplyAvailability,
    because: viableMatches === 0
      ? 'No qualified fulfillment partner identified — the deal cannot be delivered yet.'
      : `${viableMatches} candidate(s) scoring 0.50 or better.`,
  });

  // --- Financials ----------------------------------------------------------
  const dealGp = num(opportunity.deal?.grossProfit);
  const estimatedGp = num(opportunity.estimatedGrossProfit);
  const matchGp = num(bestMatch?.estimatedGrossProfit);
  const expectedGrossProfit = dealGp ?? matchGp ?? estimatedGp ?? estimateGrossProfit(opportunity.type, num0(opportunity.estimatedValue), config);
  reasons.push({
    dimension: 'expectedGrossProfit',
    value: expectedGrossProfit,
    because: dealGp !== null
      ? 'Taken from the configured deal.'
      : matchGp !== null
        ? 'Taken from the best-scoring match.'
        : `Modelled from estimated value using the configured ${opportunity.type.toLowerCase()} margin rule.`,
  });

  // --- Risks ---------------------------------------------------------------
  const fulfillmentRisk = clamp01(bestMatch ? bestMatch.fulfillmentRisk : 0.75);
  reasons.push({
    dimension: 'fulfillmentRisk',
    value: fulfillmentRisk,
    because: bestMatch ? `Best candidate carries ${(fulfillmentRisk * 100).toFixed(0)}% fulfillment risk.` : 'No confirmed fulfillment path.',
  });

  const complianceRisk = computeComplianceRisk(need, bestMatch ? opportunity.matches[0] : null, config);
  reasons.push({
    dimension: 'complianceRisk',
    value: complianceRisk.value,
    because: complianceRisk.because,
  });

  const paymentRisk = primary?.estimatedRevenue ? 0.25 : 0.5;
  reasons.push({
    dimension: 'paymentRisk',
    value: paymentRisk,
    because: primary?.estimatedRevenue ? 'Buyer has a revenue estimate on file; standard terms assumed.' : 'No financial profile on the buyer — treat terms conservatively.',
  });

  const competitivePressure = clamp01(
    (need?.currentProvider ? 0.55 : 0.3) + (opportunity.quotes.length > 1 ? 0.15 : 0),
  );
  reasons.push({
    dimension: 'competitivePressure',
    value: competitivePressure,
    because: need?.currentProvider ? `Incumbent in place (${need.currentProvider}).` : 'No known incumbent.',
  });

  // --- Repeat and expansion ------------------------------------------------
  const recurring = need?.frequency === 'recurring';
  const repeatPotential = clamp01(recurring ? 0.9 : opportunity.type === 'DISTRIBUTION' ? 0.7 : 0.35);
  reasons.push({
    dimension: 'repeatPotential',
    value: repeatPotential,
    because: recurring ? 'Need is explicitly recurring.' : `Baseline for ${opportunity.type.toLowerCase()} work.`,
  });

  const locationCount = primary?.locations.length ?? 1;
  const expansionValue = clamp01(0.2 + Math.min(0.7, locationCount * 0.12) + (recurring ? 0.1 : 0));
  reasons.push({
    dimension: 'expansionValue',
    value: expansionValue,
    because: `${locationCount} known location(s) at the account.`,
  });

  // --- Time to close (normalised: higher = slower) -------------------------
  const timeToClose = clamp01(
    0.2 + (missingCount * 0.06) + (viableMatches === 0 ? 0.25 : 0) + (opportunity.type === 'SUBCONTRACTING' ? 0.1 : 0),
  );
  reasons.push({
    dimension: 'timeToClose',
    value: timeToClose,
    because: `${missingCount} open question(s) and ${viableMatches} viable candidate(s) drive the expected cycle length.`,
  });

  // --- Closing probability -------------------------------------------------
  const closingProbability = clamp01(
    0.05 +
      needStrength * 0.25 +
      capabilityMatch * 0.2 +
      switchingWillingness * 0.2 +
      contactability * 0.1 +
      informationCompleteness * 0.15 -
      complianceRisk.value * 0.1,
  );
  reasons.push({
    dimension: 'closingProbability',
    value: closingProbability,
    because: 'Derived from need strength, capability match, switching willingness, contactability and information completeness, less compliance risk.',
  });

  const fulfillmentConfidence = clamp01(1 - fulfillmentRisk);

  const dimensions = {
    needStrength,
    capabilityMatch,
    urgency,
    informationCompleteness,
    contactability,
    switchingWillingness,
    incumbentWeakness,
    supplyAvailability,
    closingProbability,
    repeatPotential,
    expansionValue,
    fulfillmentRisk,
    paymentRisk,
    complianceRisk: complianceRisk.value,
    competitivePressure,
    timeToClose,
  };

  const compositeScore = compositeFromDimensions(dimensions, config.scoringWeights);

  const { value: expectedValue, adjustments } = expectedOpportunityValue({
    grossProfit: expectedGrossProfit,
    closingProbability,
    fulfillmentConfidence,
    timeSensitivity: urgency,
    callerEffort: clamp01(missingCount / 8),
    managementEffort: num0(opportunity.estimatedValue) > config.approvalLimits.dealValueRequiringApproval ? 0.8 : 0.3,
    cashExposure: opportunity.type === 'DISTRIBUTION' ? 0.6 : 0.3,
    legalComplexity: complianceRisk.value,
    strategicValue: expansionValue,
  });
  reasons.push(...adjustments.map((a) => ({ ...a, dimension: `adjustment:${a.dimension}` })));

  const breakdown: ScoreBreakdown = {
    ...dimensions,
    expectedGrossProfit,
    compositeScore,
    expectedValue,
    reasons,
  };

  await prisma.opportunityScore.create({
    data: {
      opportunityId,
      needStrength,
      capabilityMatch,
      urgency,
      informationCompleteness,
      contactability,
      switchingWillingness,
      incumbentWeakness,
      supplyAvailability,
      expectedGrossProfit,
      closingProbability,
      repeatPotential,
      expansionValue,
      fulfillmentRisk,
      paymentRisk,
      complianceRisk: complianceRisk.value,
      competitivePressure,
      timeToClose,
      compositeScore,
      expectedValue,
      reasons: reasons as object,
      modelVersion: SCORING_VERSION,
    },
  });

  await prisma.opportunity.update({
    where: { id: opportunityId },
    data: {
      closingProbability,
      fulfillmentConfidence,
      informationCompleteness,
      urgency,
      expectedValue,
      estimatedGrossProfit: expectedGrossProfit,
      relationshipVulnerability: clamp01((switchingWillingness + incumbentWeakness) / 2),
      priority: derivePriority(compositeScore, expectedValue, urgency),
    },
  });

  await recordDecision({
    orgId: opportunity.orgId,
    opportunityId,
    process: 'scoring',
    decision: `Composite ${compositeScore.toFixed(3)}, expected value $${expectedValue.toFixed(0)}`,
    reason: reasons.slice(0, 5).map((r) => `${r.dimension}: ${r.because}`).join(' '),
    inputs: { missingCount, viableMatches, movability },
    outputs: breakdown as unknown as Record<string, unknown>,
    confidence: informationCompleteness,
    rulesApplied: ['scoring_weights', 'expected_opportunity_value'],
    modelName: 'deterministic',
    promptVersion: SCORING_VERSION,
    // Runs on a schedule and re-derives the same composite whether or not the
    // deal moved. An unchanged score is not a new decision.
    derived: true,
  });

  return breakdown;
}

function computeComplianceRisk(
  need: { requiredCertifications: string[]; insuranceRequirement: unknown; requiredCapabilities: string[] } | null,
  match: { missingInformation: string[] } | null,
  config: OrgConfig,
): { value: number; because: string } {
  const notes: string[] = [];
  let risk = 0.2;

  const licensedTrade = need?.requiredCapabilities.some((c) =>
    config.riskRules.requireLicenseForTrades.some((t) => c.toLowerCase().includes(t)),
  );
  if (licensedTrade) {
    risk += 0.25;
    notes.push('scope includes a trade requiring licensure');
  }
  if (need?.requiredCertifications.length) {
    risk += 0.1;
    notes.push(`${need.requiredCertifications.length} certification requirement(s)`);
  }
  const insurance = (need?.insuranceRequirement ?? {}) as Record<string, unknown>;
  if (Object.keys(insurance).length > 0) {
    risk += 0.1;
    notes.push('specific insurance limits demanded');
  }
  const unverified = match?.missingInformation.filter((m) => /insurance|licen|certif/i.test(m)) ?? [];
  if (unverified.length > 0) {
    risk += 0.2;
    notes.push(`candidate has unverified ${unverified.join(', ')}`);
  }

  return {
    value: clamp01(risk),
    because: notes.length ? `Compliance exposure: ${notes.join('; ')}.` : 'No specific licensing, insurance or certification exposure identified.',
  };
}

function estimateGrossProfit(type: string, estimatedValue: number, config: OrgConfig): number {
  if (estimatedValue <= 0) return 0;
  const pct =
    type === 'SUBCONTRACTING'
      ? config.marginRules.subcontractingManagementFeePct
      : type === 'BROKERAGE'
        ? config.marginRules.brokerageSpreadPct
        : config.marginRules.distributionMarginPct;
  return round((estimatedValue * pct) / 100);
}

export function derivePriority(composite: number, expectedValue: number, urgency: number): Priority {
  if (urgency >= 0.9 && composite >= 0.5) return 'CRITICAL';
  if (composite >= 0.65 || expectedValue >= 15000) return 'HIGH';
  if (composite >= 0.4 || expectedValue >= 4000) return 'MEDIUM';
  return 'LOW';
}

/** Rescore a batch — used by the nightly planning job. */
export async function scoreAllActive(orgId: string, limit = 500): Promise<number> {
  const opportunities = await prisma.opportunity.findMany({
    where: { orgId, status: { in: ['ACTIVE', 'WAITING', 'BLOCKED', 'ESCALATED'] } },
    select: { id: true },
    take: limit,
  });
  for (const opportunity of opportunities) {
    await scoreOpportunity(opportunity.id);
  }
  return opportunities.length;
}
