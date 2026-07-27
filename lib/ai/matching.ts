import type { OpportunityType, Prisma } from '@prisma/client';
import { num, num0, prisma } from '@/lib/db';
import { getOrgConfig, type OrgConfig } from '@/lib/config';
import { recordActivity } from '@/lib/audit';
import { clamp01, recordDecision, round } from './decisions';

export const MATCHING_VERSION = 'matching@2';

export type MatchFactor = { factor: string; weight: number; score: number; because: string };

export type MatchCandidate = {
  companyId: string;
  companyName: string;
  score: number;
  explanation: string;
  confirmedFactors: MatchFactor[];
  potentialMismatches: MatchFactor[];
  missingInformation: string[];
  estimatedCost: number | null;
  estimatedRevenue: number | null;
  estimatedGrossProfit: number | null;
  closingProbability: number;
  fulfillmentRisk: number;
  callsNeeded: string[];
  supplyId?: string;
  capacityId?: string;
};

/** Relative importance of each matching dimension. Sums are normalised. */
const FACTOR_WEIGHTS: Record<string, number> = {
  serviceAlignment: 3.0,
  geography: 2.5,
  capacity: 2.0,
  availability: 1.8,
  licensing: 1.8,
  insurance: 1.6,
  certifications: 1.0,
  pricing: 1.5,
  minimumContract: 1.0,
  leadTime: 1.2,
  reliability: 1.4,
  responsiveness: 0.8,
  paymentTerms: 0.6,
  freightFeasibility: 1.2,
  marginPotential: 1.6,
  relationshipHistory: 1.0,
  risk: 1.2,
  repeatPotential: 0.8,
};

type OpportunityForMatching = Prisma.OpportunityGetPayload<{
  include: {
    buyerNeed: true;
    parties: { include: { company: { include: { locations: true } } } };
  };
}>;

/**
 * Finds and ranks fulfillment candidates for an opportunity.
 *
 * A match score is an argument, not a verdict. Every candidate carries the
 * factors that were actually confirmed, the ones that look wrong, and the
 * questions still outstanding — plus the specific calls needed before the
 * candidate can be put in front of a buyer.
 */
export async function findMatches(opportunityId: string, limit = 8): Promise<MatchCandidate[]> {
  const opportunity = (await prisma.opportunity.findUniqueOrThrow({
    where: { id: opportunityId },
    include: {
      buyerNeed: true,
      parties: { include: { company: { include: { locations: true } } } },
    },
  })) as OpportunityForMatching;

  const config = await getOrgConfig(opportunity.orgId);
  const need = opportunity.buyerNeed;
  const buyerParty = opportunity.parties.find((p) => p.isPrimary) ?? opportunity.parties[0];
  const excludeIds = opportunity.parties.map((p) => p.companyId);

  if (!need) {
    await recordDecision({
      orgId: opportunity.orgId,
      opportunityId,
      process: 'matching',
      decision: 'No matching performed',
      reason: 'No buyer need is recorded yet. Matching a candidate against an unconfirmed scope would fabricate the requirement.',
      confidence: 0.9,
      rulesApplied: ['require_buyer_need_before_matching'],
      modelName: 'deterministic',
      promptVersion: MATCHING_VERSION,
    });
    return [];
  }

  const supplierRoles: Record<OpportunityType, string[]> = {
    SUBCONTRACTING: ['SUBCONTRACTOR', 'HYBRID', 'UNKNOWN'],
    BROKERAGE: ['SUPPLIER', 'MANUFACTURER', 'DISTRIBUTOR', 'CARRIER', 'HYBRID'],
    DISTRIBUTION: ['DISTRIBUTOR', 'MANUFACTURER', 'SUPPLIER', 'HYBRID'],
    HYBRID: ['SUBCONTRACTOR', 'SUPPLIER', 'DISTRIBUTOR', 'MANUFACTURER', 'HYBRID'],
    UNCLASSIFIED: ['SUBCONTRACTOR', 'SUPPLIER', 'DISTRIBUTOR', 'MANUFACTURER', 'HYBRID', 'UNKNOWN'],
  };

  const pool = await prisma.company.findMany({
    where: {
      orgId: opportunity.orgId,
      id: { notIn: excludeIds },
      companyRole: { in: supplierRoles[opportunity.type] as never },
    },
    include: {
      locations: true,
      subCapacity: true,
      supplyOffers: true,
      capabilities: { include: { capability: true } },
      products: { include: { product: true } },
    },
    take: 400,
  });

  const candidates: MatchCandidate[] = [];
  for (const company of pool) {
    const candidate = evaluateCandidate({
      need: {
        requiredCapabilities: need.requiredCapabilities,
        requiredCertifications: need.requiredCertifications,
        insuranceRequirement: need.insuranceRequirement as Record<string, number>,
        location: need.location,
        state: need.state,
        quantity: num(need.quantity),
        unit: need.unit,
        estimatedValue: num(need.estimatedValue),
        startDate: need.startDate,
        deadline: need.deadline,
        frequency: need.frequency,
        scope: need.scope,
      },
      company: {
        id: company.id,
        name: company.legalName,
        role: company.companyRole,
        territories: company.serviceTerritories,
        locations: company.locations.map((l) => ({ city: l.city, state: l.state })),
        capabilities: company.capabilities.map((c) => ({
          key: c.capability.key,
          name: c.capability.name,
          status: c.status,
        })),
        certifications: company.certifications,
        licenses: company.licenses as Array<Record<string, unknown>>,
        insurance: company.insurance as Record<string, number>,
        relationshipStrength: company.relationshipStrength,
        capacities: company.subCapacity.map((c) => ({
          id: c.id,
          capabilities: c.capabilities,
          territories: c.territories,
          crewCount: c.crewCount,
          shiftAvailability: c.shiftAvailability,
          minimumContract: num(c.minimumContract),
          earliestStart: c.earliestStart,
          monthlyRate: num(c.monthlyRate),
          hourlyRate: num(c.hourlyRate),
          insuranceLimits: c.insuranceLimits as Record<string, number>,
          licenses: c.licenses,
          status: c.status,
          staleAfter: c.staleAfter,
        })),
        supplies: company.supplyOffers.map((s) => ({
          id: s.id,
          description: s.description,
          quantity: num(s.quantity),
          unit: s.unit,
          unitCost: num(s.unitCost),
          leadTimeDays: s.leadTimeDays,
          location: s.location,
          minimumOrder: num(s.minimumOrder),
          status: s.status,
          staleAfter: s.staleAfter,
          freightBasis: s.freightBasis,
        })),
        products: company.products.map((p) => ({ name: p.product.name, category: p.product.category, unitCost: num(p.unitCost), role: p.role })),
      },
      opportunityType: opportunity.type,
      buyerState: buyerParty?.company.locations[0]?.state ?? null,
      config,
    });
    if (candidate.score > 0.15) candidates.push(candidate);
  }

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, limit);

  // Persist. Existing matches are updated so history of selection survives.
  for (const [index, candidate] of top.entries()) {
    await prisma.match.upsert({
      where: { opportunityId_candidateCompanyId: { opportunityId, candidateCompanyId: candidate.companyId } },
      create: {
        orgId: opportunity.orgId,
        opportunityId,
        candidateCompanyId: candidate.companyId,
        buyerNeedId: need.id,
        supplyId: candidate.supplyId ?? null,
        capacityId: candidate.capacityId ?? null,
        score: candidate.score,
        rank: index + 1,
        explanation: candidate.explanation,
        confirmedFactors: candidate.confirmedFactors as object,
        potentialMismatches: candidate.potentialMismatches as object,
        missingInformation: candidate.missingInformation,
        estimatedCost: candidate.estimatedCost,
        estimatedRevenue: candidate.estimatedRevenue,
        estimatedGrossProfit: candidate.estimatedGrossProfit,
        closingProbability: candidate.closingProbability,
        fulfillmentRisk: candidate.fulfillmentRisk,
        callsNeeded: candidate.callsNeeded,
      },
      update: {
        score: candidate.score,
        rank: index + 1,
        explanation: candidate.explanation,
        confirmedFactors: candidate.confirmedFactors as object,
        potentialMismatches: candidate.potentialMismatches as object,
        missingInformation: candidate.missingInformation,
        estimatedCost: candidate.estimatedCost,
        estimatedRevenue: candidate.estimatedRevenue,
        estimatedGrossProfit: candidate.estimatedGrossProfit,
        closingProbability: candidate.closingProbability,
        fulfillmentRisk: candidate.fulfillmentRisk,
        callsNeeded: candidate.callsNeeded,
        supplyId: candidate.supplyId ?? null,
        capacityId: candidate.capacityId ?? null,
      },
    });
  }

  await recordDecision({
    orgId: opportunity.orgId,
    opportunityId,
    process: 'matching',
    decision: `Ranked ${top.length} candidate(s) from a pool of ${pool.length}`,
    reason: top.length
      ? `Top candidate ${top[0].companyName} at ${top[0].score.toFixed(2)}: ${top[0].explanation}`
      : 'No company in the graph plausibly covers this scope. New fulfillment capacity must be sourced.',
    inputs: { poolSize: pool.length, requiredCapabilities: need.requiredCapabilities, location: need.location },
    outputs: { candidates: top.map((c) => ({ id: c.companyId, name: c.companyName, score: c.score })) },
    confidence: top.length ? top[0].score : 0.2,
    rulesApplied: ['factor_weights', 'geography_gate', 'compliance_gate'],
    modelName: 'deterministic',
    promptVersion: MATCHING_VERSION,
  });

  if (top.length > 0) {
    await recordActivity({
      orgId: opportunity.orgId,
      opportunityId,
      verb: 'matching.completed',
      summary: `${top.length} fulfillment candidate(s) ranked; best is ${top[0].companyName} (${(top[0].score * 100).toFixed(0)}%)`,
      payload: { candidates: top.map((c) => c.companyName) },
    });
  }

  return top;
}

type NeedShape = {
  requiredCapabilities: string[];
  requiredCertifications: string[];
  insuranceRequirement: Record<string, number>;
  location: string | null;
  state: string | null;
  quantity: number | null;
  unit: string | null;
  estimatedValue: number | null;
  startDate: Date | null;
  deadline: Date | null;
  frequency: string | null;
  scope: string;
};

type CompanyShape = {
  id: string;
  name: string;
  role: string;
  territories: string[];
  locations: Array<{ city: string | null; state: string | null }>;
  capabilities: Array<{ key: string; name: string; status: string }>;
  certifications: string[];
  licenses: Array<Record<string, unknown>>;
  insurance: Record<string, number>;
  relationshipStrength: number;
  capacities: Array<{
    id: string;
    capabilities: string[];
    territories: string[];
    crewCount: number | null;
    shiftAvailability: string[];
    minimumContract: number | null;
    earliestStart: Date | null;
    monthlyRate: number | null;
    hourlyRate: number | null;
    insuranceLimits: Record<string, number>;
    licenses: string[];
    status: string;
    staleAfter: Date | null;
  }>;
  supplies: Array<{
    id: string;
    description: string;
    quantity: number | null;
    unit: string | null;
    unitCost: number | null;
    leadTimeDays: number | null;
    location: string | null;
    minimumOrder: number | null;
    status: string;
    staleAfter: Date | null;
    freightBasis: string | null;
  }>;
  products: Array<{ name: string; category: string; unitCost: number | null; role: string }>;
};

/** Pure scoring function — no I/O, so it is directly unit-testable. */
export function evaluateCandidate(input: {
  need: NeedShape;
  company: CompanyShape;
  opportunityType: OpportunityType;
  buyerState: string | null;
  config: OrgConfig;
}): MatchCandidate {
  const { need, company, config } = input;
  const confirmed: MatchFactor[] = [];
  const mismatches: MatchFactor[] = [];
  const missing: string[] = [];
  const calls: string[] = [];

  const push = (factor: string, score: number, because: string) => {
    const entry = { factor, weight: FACTOR_WEIGHTS[factor] ?? 1, score, because };
    (score >= 0.6 ? confirmed : mismatches).push(entry);
    return entry;
  };

  // --- Service / product alignment ----------------------------------------
  const haystack = [
    ...company.capabilities.map((c) => `${c.key} ${c.name}`),
    ...company.capacities.flatMap((c) => c.capabilities),
    ...company.supplies.map((s) => s.description),
    ...company.products.map((p) => `${p.name} ${p.category}`),
  ]
    .join(' ')
    .toLowerCase();

  const requiredTerms = need.requiredCapabilities.length
    ? need.requiredCapabilities
    : need.scope.toLowerCase().split(/[,.;]/).map((s) => s.trim()).filter((s) => s.length > 4).slice(0, 4);

  const covered = requiredTerms.filter((term) => termMatches(haystack, term));
  const uncovered = requiredTerms.filter((term) => !termMatches(haystack, term));
  const serviceAlignment = requiredTerms.length === 0 ? 0.3 : covered.length / requiredTerms.length;
  push(
    'serviceAlignment',
    serviceAlignment,
    covered.length
      ? `Covers ${covered.join(', ')}${uncovered.length ? `; no evidence of ${uncovered.join(', ')}` : ''}.`
      : `No evidence of the required scope (${requiredTerms.join(', ')}).`,
  );
  if (uncovered.length) calls.push(`Confirm whether they self-perform: ${uncovered.join(', ')}`);

  // A candidate with no service overlap at all is not a candidate.
  if (serviceAlignment === 0) {
    return {
      companyId: company.id,
      companyName: company.name,
      score: 0,
      explanation: `${company.name} shows no capability overlap with the required scope.`,
      confirmedFactors: confirmed,
      potentialMismatches: mismatches,
      missingInformation: ['Capability profile'],
      estimatedCost: null,
      estimatedRevenue: null,
      estimatedGrossProfit: null,
      closingProbability: 0,
      fulfillmentRisk: 1,
      callsNeeded: calls,
    };
  }

  // --- Geography -----------------------------------------------------------
  const needPlace = (need.location ?? '').toLowerCase();
  const needState = (need.state ?? '').toUpperCase();
  const territoryText = [...company.territories, ...company.capacities.flatMap((c) => c.territories)].join(' ').toLowerCase();
  const companyStates = company.locations.map((l) => (l.state ?? '').toUpperCase()).filter(Boolean);

  let geography = 0.3;
  let geoReason = 'Service territory not documented — must be confirmed.';
  if (needPlace && territoryText && needPlace.split(/[,\s]+/).some((tok) => tok.length > 3 && territoryText.includes(tok))) {
    geography = 0.95;
    geoReason = `Published service territory covers ${need.location}.`;
  } else if (needState && companyStates.includes(needState)) {
    geography = 0.65;
    geoReason = `Operates in ${needState} but coverage of ${need.location ?? 'the specific area'} is unconfirmed.`;
  } else if (needState && companyStates.length > 0) {
    geography = 0.15;
    geoReason = `Known locations are in ${companyStates.join(', ')}, not ${needState}.`;
  } else {
    missing.push('Service territory');
    calls.push('Confirm service territory and whether they will travel to the job location');
  }
  push('geography', geography, geoReason);

  // --- Capacity and availability ------------------------------------------
  const capacity = company.capacities[0];
  const supply = pickSupply(company.supplies, need);

  let capacityScore = 0.35;
  let capacityReason = 'Capacity unknown.';
  if (capacity?.crewCount) {
    capacityScore = capacity.crewCount >= 3 ? 0.9 : capacity.crewCount >= 2 ? 0.7 : 0.5;
    capacityReason = `${capacity.crewCount} crew(s) on record${capacity.status === 'CONFIRMED' ? ' (confirmed)' : ' (claimed, unverified)'}.`;
  } else if (supply?.quantity && need.quantity) {
    capacityScore = supply.quantity >= need.quantity ? 0.9 : clamp01(supply.quantity / need.quantity);
    capacityReason = `${supply.quantity} ${supply.unit ?? ''} available against ${need.quantity} ${need.unit ?? ''} required.`;
  } else {
    missing.push('Capacity');
    calls.push('Confirm crew or volume capacity for this scope');
  }
  push('capacity', capacityScore, capacityReason);

  let availability = 0.4;
  let availabilityReason = 'Start availability unknown.';
  const staleRef = capacity?.staleAfter ?? supply?.staleAfter ?? null;
  if (staleRef && staleRef < new Date()) {
    availability = 0.25;
    availabilityReason = `Availability data expired on ${staleRef.toISOString().slice(0, 10)} — must be re-verified before quoting.`;
    missing.push('Current availability');
    calls.push('Re-verify availability; the recorded figure is stale');
  } else if (capacity?.earliestStart && need.startDate) {
    availability = capacity.earliestStart <= need.startDate ? 0.95 : 0.3;
    availabilityReason =
      capacity.earliestStart <= need.startDate
        ? `Can start ${capacity.earliestStart.toISOString().slice(0, 10)}, before the required ${need.startDate.toISOString().slice(0, 10)}.`
        : `Earliest start ${capacity.earliestStart.toISOString().slice(0, 10)} is after the required ${need.startDate.toISOString().slice(0, 10)}.`;
  } else if (supply?.leadTimeDays !== null && supply?.leadTimeDays !== undefined && need.startDate) {
    const daysAvailable = (need.startDate.getTime() - Date.now()) / 86_400_000;
    availability = supply.leadTimeDays <= daysAvailable ? 0.9 : 0.35;
    availabilityReason = `Lead time ${supply.leadTimeDays} days against ${Math.round(daysAvailable)} days until required.`;
  } else {
    missing.push('Earliest start date');
    calls.push('Confirm earliest start date or lead time');
  }
  push('availability', availability, availabilityReason);

  // --- Licensing, insurance, certifications --------------------------------
  const licenseRequired = need.requiredCapabilities.some((c) =>
    config.riskRules.requireLicenseForTrades.some((t) => c.toLowerCase().includes(t)),
  );
  const heldLicenses = [...(capacity?.licenses ?? []), ...company.licenses.map((l) => String(l.number ?? l.type ?? ''))].filter(Boolean);
  let licensing = 0.6;
  let licensingReason = 'No licensure requirement identified for this scope.';
  if (licenseRequired) {
    if (heldLicenses.length > 0) {
      licensing = 0.85;
      licensingReason = `Holds ${heldLicenses.join(', ')}, but the licence must be verified against the issuing authority before award.`;
      missing.push('Licence verification with issuing authority');
      calls.push('Request licence number and expiry for verification');
    } else {
      licensing = 0.1;
      licensingReason = 'Scope requires licensure and no licence is on record.';
      missing.push('Trade licence');
      calls.push('Confirm licensure for the required trade');
    }
  }
  push('licensing', licensing, licensingReason);

  const requiredInsurance = need.insuranceRequirement ?? {};
  const heldInsurance = { ...(company.insurance ?? {}), ...(capacity?.insuranceLimits ?? {}) };
  let insurance = 0.5;
  let insuranceReason = 'Insurance limits not stated by the buyer; standard limits assumed.';
  const insuranceKeys = Object.keys(requiredInsurance);
  if (insuranceKeys.length > 0) {
    const shortfalls = insuranceKeys.filter((k) => (heldInsurance[k] ?? 0) < requiredInsurance[k]);
    const unknowns = insuranceKeys.filter((k) => heldInsurance[k] === undefined);
    if (unknowns.length > 0) {
      insurance = 0.3;
      insuranceReason = `Buyer requires ${insuranceKeys.join(', ')}; no limits on record for ${unknowns.join(', ')}.`;
      missing.push('Certificate of insurance');
      calls.push('Request a certificate of insurance showing required limits');
    } else if (shortfalls.length > 0) {
      insurance = 0.05;
      insuranceReason = `Coverage is below requirement on ${shortfalls.map((k) => `${k} (${heldInsurance[k]} vs ${requiredInsurance[k]})`).join(', ')}.`;
    } else {
      insurance = 0.95;
      insuranceReason = `Meets all stated limits (${insuranceKeys.join(', ')}).`;
    }
  }
  push('insurance', insurance, insuranceReason);

  const certsHeld = company.certifications.map((c) => c.toLowerCase());
  const certsMissing = need.requiredCertifications.filter((c) => !certsHeld.includes(c.toLowerCase()));
  const certifications = need.requiredCertifications.length === 0 ? 0.7 : clamp01(1 - certsMissing.length / need.requiredCertifications.length);
  push(
    'certifications',
    certifications,
    need.requiredCertifications.length === 0
      ? 'No certification requirement stated.'
      : certsMissing.length
        ? `Missing ${certsMissing.join(', ')}.`
        : 'Holds all required certifications.',
  );
  if (certsMissing.length) calls.push(`Confirm certification status: ${certsMissing.join(', ')}`);

  // --- Pricing and margin --------------------------------------------------
  const costing = estimateCosting({ need, capacity, supply, products: company.products, type: input.opportunityType, config });
  const pricing = costing.cost === null ? 0.3 : 0.8;
  push(
    'pricing',
    pricing,
    costing.cost === null ? 'No cost basis on record — pricing must be requested.' : `Cost basis $${costing.cost.toFixed(0)} from ${costing.basis}.`,
  );
  if (costing.cost === null) {
    missing.push('Cost or pricing');
    calls.push('Request pricing for the confirmed scope');
  }

  const marginPct = costing.revenue && costing.cost ? ((costing.revenue - costing.cost) / costing.revenue) * 100 : null;
  const marginPotential =
    marginPct === null ? 0.4 : marginPct >= config.marginRules.targetGrossMarginPct ? 0.95 : marginPct >= config.marginRules.minimumGrossMarginPct ? 0.65 : 0.15;
  push(
    'marginPotential',
    marginPotential,
    marginPct === null
      ? 'Margin cannot be computed until pricing exists.'
      : `Modelled gross margin ${marginPct.toFixed(1)}% against a ${config.marginRules.minimumGrossMarginPct}% floor.`,
  );

  // --- Minimum contract ----------------------------------------------------
  let minimumContract = 0.6;
  let minimumReason = 'No stated minimum contract size.';
  if (capacity?.minimumContract && need.estimatedValue) {
    const meets = need.estimatedValue >= capacity.minimumContract;
    minimumContract = meets ? 0.95 : 0.1;
    minimumReason = meets
      ? `Deal value $${need.estimatedValue.toFixed(0)} clears their $${capacity.minimumContract.toFixed(0)} minimum.`
      : `Deal value $${need.estimatedValue.toFixed(0)} is below their $${capacity.minimumContract.toFixed(0)} minimum.`;
  } else if (supply?.minimumOrder && need.quantity) {
    const meets = need.quantity >= supply.minimumOrder;
    minimumContract = meets ? 0.95 : 0.15;
    minimumReason = meets ? 'Order clears the supplier minimum.' : `Order below the ${supply.minimumOrder} ${supply.unit ?? ''} minimum.`;
  }
  push('minimumContract', minimumContract, minimumReason);

  // --- Lead time and freight ----------------------------------------------
  const leadTime = supply?.leadTimeDays === null || supply?.leadTimeDays === undefined ? 0.5 : supply.leadTimeDays <= 14 ? 0.9 : 0.5;
  push('leadTime', leadTime, supply?.leadTimeDays != null ? `Lead time ${supply.leadTimeDays} days.` : 'Lead time unknown.');

  const freightFeasibility =
    input.opportunityType === 'SUBCONTRACTING'
      ? 0.8
      : supply?.freightBasis
        ? supply.freightBasis.toLowerCase().includes('delivered')
          ? 0.9
          : 0.5
        : 0.4;
  push(
    'freightFeasibility',
    freightFeasibility,
    input.opportunityType === 'SUBCONTRACTING'
      ? 'Freight is not a driver for on-site services.'
      : supply?.freightBasis
        ? `Quoted ${supply.freightBasis}.`
        : 'Freight basis unknown — delivered cost cannot be computed.',
  );
  if (input.opportunityType !== 'SUBCONTRACTING' && !supply?.freightBasis) {
    missing.push('Freight basis');
    calls.push('Obtain delivered (freight-inclusive) pricing');
  }

  // --- Track record --------------------------------------------------------
  const reliability = clamp01(0.4 + company.relationshipStrength * 0.5);
  push('reliability', reliability, company.relationshipStrength > 0 ? `Relationship strength ${company.relationshipStrength.toFixed(2)} from prior work.` : 'No prior work with this company — no reliability history.');

  const responsiveness = company.relationshipStrength > 0 ? 0.7 : 0.5;
  push('responsiveness', responsiveness, company.relationshipStrength > 0 ? 'Has responded in past interactions.' : 'Responsiveness untested.');

  push('paymentTerms', 0.5, 'Payment terms not yet negotiated.');

  const relationshipHistory = clamp01(company.relationshipStrength);
  push('relationshipHistory', relationshipHistory, relationshipHistory > 0 ? 'Existing relationship on file.' : 'Cold relationship.');

  const repeatPotential = need.frequency === 'recurring' ? 0.9 : 0.4;
  push('repeatPotential', repeatPotential, need.frequency === 'recurring' ? 'Recurring need creates repeat volume.' : 'One-time need.');

  const unverifiedClaims = [
    ...company.capabilities.filter((c) => c.status !== 'CONFIRMED'),
    ...(capacity && capacity.status !== 'CONFIRMED' ? [capacity] : []),
    ...(supply && supply.status !== 'CONFIRMED' ? [supply] : []),
  ].length;
  const risk = clamp01(1 - unverifiedClaims * 0.12);
  push('risk', risk, unverifiedClaims > 0 ? `${unverifiedClaims} unverified claim(s) on this candidate.` : 'All recorded facts are confirmed.');

  // --- Composite -----------------------------------------------------------
  const all = [...confirmed, ...mismatches];
  const totalWeight = all.reduce((sum, f) => sum + f.weight, 0);
  const score = clamp01(all.reduce((sum, f) => sum + f.score * f.weight, 0) / (totalWeight || 1));

  // Hard gates: compliance failures cap the score regardless of other merits.
  const capped =
    insurance <= 0.1 || licensing <= 0.1 ? Math.min(score, 0.35) : geography <= 0.15 ? Math.min(score, 0.4) : score;

  const fulfillmentRisk = clamp01(1 - (capacityScore * 0.3 + availability * 0.3 + licensing * 0.2 + insurance * 0.2));
  const closingProbability = clamp01(capped * 0.7 + (marginPct !== null ? 0.15 : 0) + (missing.length === 0 ? 0.15 : 0));

  const topReasons = [...all].sort((a, b) => b.weight * b.score - a.weight * a.score).slice(0, 3);
  const topGaps = [...mismatches].sort((a, b) => b.weight * (1 - b.score) - a.weight * (1 - a.score)).slice(0, 2);

  const explanation =
    `${company.name} scores ${(capped * 100).toFixed(0)}%. Strengths: ${topReasons.map((r) => r.because).join(' ')}` +
    (topGaps.length ? ` Gaps: ${topGaps.map((r) => r.because).join(' ')}` : '') +
    (missing.length ? ` Outstanding: ${missing.join(', ')}.` : '') +
    ' This score ranks candidates for outreach; it is not evidence that the company is suitable.';

  return {
    companyId: company.id,
    companyName: company.name,
    score: round(capped, 3),
    explanation,
    confirmedFactors: confirmed,
    potentialMismatches: mismatches,
    missingInformation: [...new Set(missing)],
    estimatedCost: costing.cost,
    estimatedRevenue: costing.revenue,
    estimatedGrossProfit: costing.revenue !== null && costing.cost !== null ? round(costing.revenue - costing.cost) : null,
    closingProbability: round(closingProbability, 3),
    fulfillmentRisk: round(fulfillmentRisk, 3),
    callsNeeded: [...new Set(calls)],
    supplyId: supply?.id,
    capacityId: capacity?.id,
  };
}

function termMatches(haystack: string, term: string): boolean {
  const normalized = term.toLowerCase().trim();
  if (!normalized) return false;
  if (haystack.includes(normalized)) return true;
  // Fall back to significant word overlap so "commercial janitorial" matches
  // "janitorial services" without matching on filler words.
  const words = normalized.split(/\s+/).filter((w) => w.length > 4);
  return words.length > 0 && words.every((w) => haystack.includes(w));
}

function pickSupply(supplies: CompanyShape['supplies'], need: NeedShape): CompanyShape['supplies'][number] | undefined {
  if (supplies.length === 0) return undefined;
  const terms = [...need.requiredCapabilities, need.scope].join(' ').toLowerCase();
  return (
    supplies.find((s) => terms.includes(s.description.toLowerCase().split(/[\s,]/)[0])) ??
    supplies.find((s) => s.description.toLowerCase().split(/\s+/).some((w) => w.length > 4 && terms.includes(w))) ??
    supplies[0]
  );
}

function estimateCosting(input: {
  need: NeedShape;
  capacity: CompanyShape['capacities'][number] | undefined;
  supply: CompanyShape['supplies'][number] | undefined;
  products: CompanyShape['products'];
  type: OpportunityType;
  config: OrgConfig;
}): { cost: number | null; revenue: number | null; basis: string } {
  const { need, capacity, supply, config } = input;

  if (supply?.unitCost != null && need.quantity != null) {
    const cost = round(supply.unitCost * need.quantity);
    const marginPct = input.type === 'BROKERAGE' ? config.marginRules.brokerageSpreadPct : config.marginRules.distributionMarginPct;
    const revenue = need.estimatedValue ?? round(cost / (1 - marginPct / 100));
    return { cost, revenue, basis: `supplier unit cost $${supply.unitCost}/${supply.unit ?? 'unit'}` };
  }

  if (capacity?.monthlyRate != null) {
    const months = need.frequency === 'recurring' ? 12 : 1;
    const cost = round(capacity.monthlyRate * months);
    const revenue = need.estimatedValue ?? round(cost * (1 + config.marginRules.subcontractingManagementFeePct / 100));
    return { cost, revenue, basis: `subcontractor monthly rate $${capacity.monthlyRate} x ${months}` };
  }

  if (need.estimatedValue != null) {
    const feePct =
      input.type === 'SUBCONTRACTING'
        ? config.marginRules.subcontractingManagementFeePct
        : input.type === 'BROKERAGE'
          ? config.marginRules.brokerageSpreadPct
          : config.marginRules.distributionMarginPct;
    // Buyer-side value is known; supplier cost is modelled, not quoted.
    return {
      cost: round(need.estimatedValue * (1 - feePct / 100)),
      revenue: need.estimatedValue,
      basis: `buyer-side estimate less the configured ${feePct}% margin (modelled, not quoted)`,
    };
  }

  return { cost: null, revenue: null, basis: 'no pricing available' };
}

/** Marks one match as the selected fulfillment path. */
export async function selectMatch(opportunityId: string, matchId: string, actorId?: string): Promise<void> {
  const match = await prisma.match.findUniqueOrThrow({ where: { id: matchId }, include: { candidate: true } });
  await prisma.match.updateMany({ where: { opportunityId }, data: { isSelected: false } });
  await prisma.match.update({ where: { id: matchId }, data: { isSelected: true } });

  await prisma.opportunityParty.upsert({
    where: {
      opportunityId_companyId_role: {
        opportunityId,
        companyId: match.candidateCompanyId,
        role: 'CANDIDATE',
      },
    },
    create: { opportunityId, companyId: match.candidateCompanyId, role: 'CANDIDATE' },
    update: {},
  });

  await recordActivity({
    orgId: match.orgId,
    opportunityId,
    userId: actorId ?? null,
    actorType: actorId ? 'user' : 'ai',
    verb: 'matching.selected',
    summary: `${match.candidate.legalName} selected as the fulfillment path`,
    payload: { matchId, score: match.score },
  });
}

export { num0 };
