import { describe, expect, it } from 'vitest';
import { classifyCompanyRole, classifySide, classifyTextDeterministic } from '@/lib/ai/classify';
import { detectSignals } from '@/lib/discovery/signals';
import { evaluateCandidate } from '@/lib/ai/matching';
import { compositeFromDimensions, derivePriority, expectedOpportunityValue } from '@/lib/ai/scoring';
import { recommendLane } from '@/lib/ai/lanes';
import { recommendCoaching } from '@/lib/ai/analytics';
import { recommendExpansion, recommendWedge } from '@/lib/ai/vulnerability';
import { recomputeMissingFields } from '@/lib/ai/transcript';
import { normalizePhone, withinCallingHours } from '@/lib/compliance';
import { parseCsvRecords } from '@/lib/discovery/connectors';
import { DEFAULT_CONFIG } from '@/lib/config';

describe('classification', () => {
  it('classifies the three deal models from source language', () => {
    expect(classifyTextDeterministic('Prime contractor is expected to subcontract multi-trade packages.').type).toBe('SUBCONTRACTING');
    expect(classifyTextDeterministic('Requesting delivered pricing on 18,000 tons; seeking quotes from suppliers.').type).toBe('BROKERAGE');
    expect(classifyTextDeterministic('Recurring order of can liners across multiple locations, consolidate vendors.').type).toBe('DISTRIBUTION');
  });

  it('returns UNCLASSIFIED with low confidence rather than guessing', () => {
    const result = classifyTextDeterministic('The company held its annual picnic last Saturday.');
    expect(result.type).toBe('UNCLASSIFIED');
    expect(result.confidence).toBeLessThan(0.3);
    expect(result.rationale).toMatch(/human triage/i);
  });

  it('marks genuinely mixed signals as hybrid', () => {
    const result = classifyTextDeterministic(
      'General contractor needs subcontractors for overflow work and is also requesting quotes on delivered aggregate with freight constraints and lead time.',
    );
    expect(['HYBRID', 'SUBCONTRACTING', 'BROKERAGE']).toContain(result.type);
    expect(result.matchedTerms.length).toBeGreaterThan(1);
  });

  it('infers a company role only from self-description', () => {
    expect(classifyCompanyRole({ description: 'We are a licensed commercial electrical contractor with crews.' }).role).toBe('SUBCONTRACTOR');
    expect(classifyCompanyRole({ description: 'Regional wholesale distributor of janitorial paper.' }).role).toBe('DISTRIBUTOR');
    expect(classifyCompanyRole({ description: '' }).role).toBe('UNKNOWN');
  });

  it('separates demand-side from supply-side language', () => {
    expect(classifySide('We are seeking quotes and require delivery next month.')).toBe('demand');
    expect(classifySide('We have available capacity and inventory in stock.')).toBe('supply');
  });
});

describe('signal detection', () => {
  it('detects award, subcontracting-goal and multi-trade signals together', () => {
    const detected = detectSignals(
      'The City has awarded a $2,850,000 contract to Meridian. Scope of work covers demolition, electrical, mechanical, drywall. The solicitation includes a 22% small business subcontracting goal.',
    );
    const keys = detected.map((d) => d.definition.key);
    expect(keys).toContain('recent_contract_award');
    expect(keys).toContain('subcontracting_goal');
  });

  it('detects incumbent failure and vendor consolidation for distribution', () => {
    const detected = detectSignals(
      'Current supplier has had repeated stockouts and issued a 9% price increase. Buyer wants one accountable vendor and consolidated invoicing.',
    );
    const keys = detected.map((d) => d.definition.key);
    expect(keys).toContain('supplier_complaints');
    expect(keys).toContain('vendor_consolidation');
    expect(keys).toContain('price_sensitivity');
  });

  it('returns the evidence phrase for every detection', () => {
    const detected = detectSignals('The team is at capacity and cannot keep up with the backlog.');
    expect(detected.length).toBeGreaterThan(0);
    expect(detected.every((d) => d.matches.length > 0 && d.matches[0].length > 0)).toBe(true);
  });

  it('finds nothing in unrelated text', () => {
    expect(detectSignals('The weather has been pleasant this week.')).toHaveLength(0);
  });
});

describe('matching', () => {
  const baseNeed = {
    requiredCapabilities: ['commercial janitorial'],
    requiredCertifications: [],
    insuranceRequirement: { generalLiability: 2_000_000 },
    location: 'Fairview, OH',
    state: 'OH',
    quantity: null,
    unit: null,
    estimatedValue: 40000,
    startDate: new Date(Date.now() + 40 * 86_400_000),
    deadline: null,
    frequency: 'recurring',
    scope: 'Recurring commercial janitorial across nine office properties',
  };

  const baseCompany = {
    id: 'co-2',
    name: 'Apex Commercial Cleaning',
    role: 'SUBCONTRACTOR',
    territories: ['Fairview', 'Westbrook'],
    locations: [{ city: 'Fairview', state: 'OH' }],
    capabilities: [{ key: 'commercial_janitorial', name: 'Commercial janitorial', status: 'CONFIRMED' }],
    certifications: [],
    licenses: [],
    insurance: { generalLiability: 2_000_000 },
    relationshipStrength: 0.4,
    capacities: [
      {
        id: 'cap-1',
        capabilities: ['commercial janitorial'],
        territories: ['Fairview', 'Westbrook'],
        crewCount: 4,
        shiftAvailability: ['night'],
        minimumContract: 2500,
        earliestStart: new Date(Date.now() + 10 * 86_400_000),
        monthlyRate: 2800,
        hourlyRate: null,
        insuranceLimits: { generalLiability: 2_000_000 },
        licenses: [],
        status: 'CONFIRMED',
        staleAfter: new Date(Date.now() + 20 * 86_400_000),
      },
    ],
    supplies: [],
    products: [],
  };

  it('scores a well-matched candidate highly and explains why', () => {
    const result = evaluateCandidate({
      need: baseNeed,
      company: baseCompany,
      opportunityType: 'SUBCONTRACTING',
      buyerState: 'OH',
      config: DEFAULT_CONFIG,
    });
    expect(result.score).toBeGreaterThan(0.6);
    expect(result.explanation).toMatch(/not evidence that the company is suitable/i);
    expect(result.confirmedFactors.length).toBeGreaterThan(3);
  });

  it('returns zero for a candidate with no capability overlap', () => {
    const result = evaluateCandidate({
      need: { ...baseNeed, requiredCapabilities: ['structural steel erection'] },
      company: baseCompany,
      opportunityType: 'SUBCONTRACTING',
      buyerState: 'OH',
      config: DEFAULT_CONFIG,
    });
    expect(result.score).toBe(0);
    expect(result.fulfillmentRisk).toBe(1);
  });

  it('caps the score when insurance falls short of the requirement', () => {
    const result = evaluateCandidate({
      need: baseNeed,
      company: { ...baseCompany, insurance: { generalLiability: 500_000 }, capacities: [{ ...baseCompany.capacities[0], insuranceLimits: { generalLiability: 500_000 } }] },
      opportunityType: 'SUBCONTRACTING',
      buyerState: 'OH',
      config: DEFAULT_CONFIG,
    });
    expect(result.score).toBeLessThanOrEqual(0.35);
    expect(result.potentialMismatches.some((f) => f.factor === 'insurance')).toBe(true);
  });

  it('reports missing information and the calls needed to close it', () => {
    const result = evaluateCandidate({
      need: baseNeed,
      company: { ...baseCompany, capacities: [], territories: [], locations: [] },
      opportunityType: 'SUBCONTRACTING',
      buyerState: 'OH',
      config: DEFAULT_CONFIG,
    });
    expect(result.missingInformation.length).toBeGreaterThan(0);
    expect(result.callsNeeded.length).toBeGreaterThan(0);
  });

  it('penalises a licensed trade with no licence on record', () => {
    const result = evaluateCandidate({
      need: { ...baseNeed, requiredCapabilities: ['commercial electrical'] },
      company: {
        ...baseCompany,
        capabilities: [{ key: 'commercial_electrical', name: 'Commercial electrical', status: 'CLAIMED' }],
        capacities: [{ ...baseCompany.capacities[0], capabilities: ['commercial electrical'], licenses: [] }],
        licenses: [],
      },
      opportunityType: 'SUBCONTRACTING',
      buyerState: 'OH',
      config: DEFAULT_CONFIG,
    });
    expect(result.missingInformation).toContain('Trade licence');
    expect(result.score).toBeLessThanOrEqual(0.35);
  });

  it('flags expired availability as needing re-verification', () => {
    const result = evaluateCandidate({
      need: baseNeed,
      company: { ...baseCompany, capacities: [{ ...baseCompany.capacities[0], staleAfter: new Date(Date.now() - 86_400_000) }] },
      opportunityType: 'SUBCONTRACTING',
      buyerState: 'OH',
      config: DEFAULT_CONFIG,
    });
    expect(result.missingInformation).toContain('Current availability');
    expect(result.callsNeeded.some((c) => /stale/i.test(c))).toBe(true);
  });
});

describe('scoring', () => {
  it('computes expected opportunity value as GP x P(close) x fulfillment confidence', () => {
    const { value } = expectedOpportunityValue({ grossProfit: 10000, closingProbability: 0.5, fulfillmentConfidence: 0.8 });
    expect(value).toBe(4000);
  });

  it('discounts for cash exposure and caller effort, and lifts for strategic value', () => {
    const heavy = expectedOpportunityValue({
      grossProfit: 10000, closingProbability: 0.5, fulfillmentConfidence: 0.8, cashExposure: 0.9, callerEffort: 0.9,
    });
    const strategic = expectedOpportunityValue({
      grossProfit: 10000, closingProbability: 0.5, fulfillmentConfidence: 0.8, strategicValue: 0.9,
    });
    expect(heavy.value).toBeLessThan(4000);
    expect(strategic.value).toBeGreaterThan(4000);
    expect(heavy.adjustments.every((a) => a.because.length > 10)).toBe(true);
  });

  it('never returns a composite outside 0..1', () => {
    const dimensions = {
      needStrength: 1, capabilityMatch: 1, urgency: 1, informationCompleteness: 1, contactability: 1,
      switchingWillingness: 1, incumbentWeakness: 1, supplyAvailability: 1, closingProbability: 1,
      repeatPotential: 1, expansionValue: 1, fulfillmentRisk: 1, paymentRisk: 1, complianceRisk: 1,
      competitivePressure: 1, timeToClose: 1,
    };
    const composite = compositeFromDimensions(dimensions, DEFAULT_CONFIG.scoringWeights);
    expect(composite).toBeGreaterThanOrEqual(0);
    expect(composite).toBeLessThanOrEqual(1);
  });

  it('escalates priority for urgent, strong opportunities', () => {
    expect(derivePriority(0.6, 5000, 0.95)).toBe('CRITICAL');
    expect(derivePriority(0.7, 5000, 0.3)).toBe('HIGH');
    expect(derivePriority(0.1, 100, 0.1)).toBe('LOW');
  });
});

describe('deal lanes', () => {
  const metrics = {
    opportunityFrequency: 12, contactRate: 0.6, qualificationRate: 0.5, averageDealSize: 40000,
    averageGrossMarginPct: 24, averageTimeToCloseDays: 30, fulfillmentReliability: 0.7, repeatFrequency: 0.8,
    switchingFriction: 0.2, competitiveIntensity: 0.4, paymentBehavior: 0.7, operationalComplexity: 0.2,
    callerEffortPerDeal: 6, managementEffortPerDeal: 3, riskScore: 0.2, wonCount: 5, lostCount: 2, sampleSize: 12,
  };

  it('refuses a strategic call below the minimum sample', () => {
    const result = recommendLane({ ...metrics, sampleSize: 3 }, 0.9, 8, 12);
    expect(result.recommendation).toBe('INSUFFICIENT_DATA');
    expect(result.reason).toMatch(/noise/i);
  });

  it('recommends scaling a lane that clears the bar on a real sample', () => {
    expect(recommendLane(metrics, 0.7, 8, 12).recommendation).toBe('SCALE');
  });

  it('blames targeting rather than execution when qualification collapses', () => {
    expect(recommendLane({ ...metrics, qualificationRate: 0.1 }, 0.4, 8, 12).recommendation).toBe('CHANGE_TARGET_PROFILE');
  });

  it('identifies a fulfillment problem distinctly from a sales problem', () => {
    const result = recommendLane({ ...metrics, fulfillmentReliability: 0.2, wonCount: 2, lostCount: 8 }, 0.4, 8, 12);
    expect(result.recommendation).toBe('IMPROVE_FULFILLMENT_COVERAGE');
  });

  it('pauses a lane that cannot clear the margin floor', () => {
    expect(recommendLane({ ...metrics, averageGrossMarginPct: 6 }, 0.5, 8, 12).recommendation).toBe('PAUSE');
  });
});

describe('caller coaching', () => {
  const base = {
    userId: 'u1', name: 'Dana', callsAttempted: 20, contactsReached: 12, meaningfulConversations: 9,
    requiredQuestionsCompletionRate: 0.9, informationAccuracy: 0.95, qualificationRate: 0.4,
    opportunitiesCreated: 8, pricingObtained: 4, matchesEnabled: 6, quotesEnabled: 3, followUpsCompleted: 2,
    trialsSecured: 1, dealsInfluenced: 2, grossProfitInfluenced: 12000, scriptCompliance: 0.9,
    unauthorizedPromises: 0, averageTalkRatio: 0.4, averageCallDurationSec: 300, connectRate: 0.6,
    byCallType: {}, byHour: {}, byWeekday: {},
  };

  it('raises a critical review flag for unauthorised commitments without acting on the worker', () => {
    const recommendations = recommendCoaching({ ...base, unauthorizedPromises: 2 });
    const critical = recommendations.find((r) => r.severity === 'critical');
    expect(critical?.kind).toBe('review');
    expect(critical?.detail).toMatch(/takes no action against a worker/i);
  });

  it('coaches on talk ratio when the caller dominates the call', () => {
    const recommendations = recommendCoaching({ ...base, averageTalkRatio: 0.8 });
    expect(recommendations.some((r) => /talking/i.test(r.headline))).toBe(true);
  });

  it('considers targeting before blaming the caller for low qualification', () => {
    const recommendations = recommendCoaching({ ...base, qualificationRate: 0.05, callsAttempted: 30 });
    const script = recommendations.find((r) => r.kind === 'script');
    expect(script?.detail).toMatch(/target profile/i);
  });
});

describe('relationship vulnerability', () => {
  it('parks locked accounts instead of spending caller hours', () => {
    const wedge = recommendWedge('RELATIONSHIP_LOCKED', [], 3);
    expect(wedge).toMatch(/do not spend caller hours/i);
  });

  it('picks the emergency wedge when there is an urgent gap', () => {
    expect(recommendWedge('ACTIVELY_MOVABLE', [{ key: 'emergency_need' }], 1)).toMatch(/emergency job/i);
  });

  it('positions as backup after reliability failures', () => {
    expect(recommendWedge('CONDITIONALLY_MOVABLE', [{ key: 'missed_shifts' }], 1)).toMatch(/backup/i);
  });

  it('recommends an incremental expansion rather than the whole portfolio', () => {
    const result = recommendExpansion({
      currentStage: 'REPEAT_DEAL', completedDeals: 2, totalLocations: 9, servedLocations: 1, categoriesServed: 1,
    });
    expect(result?.nextStage).toBe('PARTIAL_ACCOUNT');
    expect(result?.recommendation).toMatch(/not the full portfolio/i);
  });

  it('recommends nothing before anything has been delivered', () => {
    expect(recommendExpansion({ currentStage: 'QUALIFIED', completedDeals: 0, totalLocations: 4, servedLocations: 0, categoriesServed: 0 })).toBeNull();
  });
});

describe('need completeness', () => {
  it('lists exactly what a quote would be missing', () => {
    const missing = recomputeMissingFields({ scope: 'Recurring janitorial across nine properties', location: 'Columbus, OH' });
    expect(missing).toContain('Start date');
    expect(missing).toContain('Budget or estimated value');
    expect(missing).not.toContain('Location');
  });

  it('reports nothing missing on a complete need', () => {
    const missing = recomputeMissingFields({
      scope: 'Recurring janitorial across nine office properties',
      location: 'Columbus, OH',
      startDate: new Date(),
      frequency: 'recurring',
      estimatedValue: 168000,
      currentProvider: 'Nationwide Facility Products',
      requiredCapabilities: ['commercial janitorial'],
    });
    expect(missing).toHaveLength(0);
  });
});

describe('compliance', () => {
  it('normalises phone numbers so suppression cannot be defeated by formatting', () => {
    expect(normalizePhone('+1 (513) 555-0142')).toBe('5135550142');
    expect(normalizePhone('513.555.0142')).toBe('5135550142');
    expect(normalizePhone(null)).toBeNull();
  });

  it('blocks calls outside permitted hours', () => {
    const rules = DEFAULT_CONFIG.callingRules;
    // 2026-07-27 is a Monday. 03:00 UTC is 23:00 the previous day in New York.
    const lateNight = new Date('2026-07-28T03:00:00Z');
    expect(withinCallingHours('America/New_York', lateNight, rules).ok).toBe(false);

    const midMorning = new Date('2026-07-27T14:00:00Z');
    expect(withinCallingHours('America/New_York', midMorning, rules).ok).toBe(true);
  });

  it('blocks calls on non-permitted weekdays', () => {
    const sunday = new Date('2026-07-26T14:00:00Z');
    const result = withinCallingHours('America/New_York', sunday, DEFAULT_CONFIG.callingRules);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/calling days/i);
  });
});

describe('csv import', () => {
  it('parses quoted fields with embedded commas', () => {
    const records = parseCsvRecords(
      'company_name,city,state,services,notes\n"Apex Cleaning, Inc.",Fairview,OH,"janitorial, day porter","Needs night crews"\n',
    );
    expect(records).toHaveLength(1);
    expect(records[0].companyName).toBe('Apex Cleaning, Inc.');
    expect(records[0].location).toBe('Fairview, OH');
    expect(records[0].excerpt).toBe('Needs night crews');
  });

  it('returns nothing for a header-only file', () => {
    expect(parseCsvRecords('company_name,city\n')).toHaveLength(0);
  });
});
