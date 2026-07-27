import { describe, expect, it } from 'vitest';
import { planNextAction } from '@/lib/ai/nextAction';

const BASE = {
  opportunity: {
    id: 'opp-1',
    type: 'SUBCONTRACTING',
    stage: 'RESEARCHING' as const,
    status: 'ACTIVE' as const,
    missingInformation: ['Confirmed scope'],
    estimatedValue: 40000,
    createdAt: new Date(),
  },
  primaryCompany: { id: 'co-1', name: 'Meridian Construction Group', contactCount: 2, reachableContactCount: 2 },
  buyerNeed: null,
  matches: [],
  deal: null,
  quotes: [],
  openApprovals: 0,
  openEscalations: 0,
  approvalLimit: 25000,
  daysSinceLastActivity: 0,
  isSupplySide: false,
  supplyConfirmed: false,
};

const CONFIRMED_NEED = {
  id: 'need-1',
  status: 'CONFIRMED',
  scope: 'Recurring commercial janitorial across three floors',
  missingFields: [],
  startDate: new Date(Date.now() + 30 * 86_400_000),
  estimatedValue: 40000,
};

describe('planNextAction', () => {
  it('escalation blocks everything else', () => {
    const plan = planNextAction({ ...BASE, openEscalations: 1, buyerNeed: CONFIRMED_NEED });
    expect(plan.type).toBe('RESOLVE_BLOCKER');
    expect(plan.targetStatus).toBe('ESCALATED');
  });

  it('finds a decision-maker before trying to qualify anything', () => {
    const plan = planNextAction({
      ...BASE,
      primaryCompany: { ...BASE.primaryCompany, reachableContactCount: 0 },
    });
    expect(plan.type).toBe('FIND_DECISION_MAKER');
    expect(plan.call).toBeUndefined();
  });

  it('qualifies the buyer need when none exists, via a call', () => {
    const plan = planNextAction(BASE);
    expect(plan.type).toBe('QUALIFY_BUYER_NEED');
    expect(plan.call?.callType).toBe('PRIME_QUALIFICATION');
    expect(plan.targetStage).toBe('QUALIFICATION_REQUIRED');
  });

  it('confirms availability rather than qualifying demand on a supply-side opportunity', () => {
    const plan = planNextAction({ ...BASE, isSupplySide: true });
    expect(plan.type).toBe('CONFIRM_AVAILABILITY');
    expect(plan.call?.callType).toBe('SUPPLIER_QUALIFICATION');
  });

  it('looks for buyers once supply is confirmed', () => {
    const plan = planNextAction({ ...BASE, isSupplySide: true, supplyConfirmed: true });
    expect(plan.type).toBe('RESEARCH_COMPANY');
    expect(plan.reason).toMatch(/no buyer is attached/i);
  });

  it('closes gaps on an unconfirmed need before pricing', () => {
    const plan = planNextAction({
      ...BASE,
      buyerNeed: { ...CONFIRMED_NEED, status: 'CLAIMED', missingFields: ['Start date'] },
    });
    expect(plan.type).toBe('CONFIRM_TIMELINE');
    expect(plan.call?.missingInformation).toContain('Start date');
  });

  it('blocks when demand is confirmed but nobody can deliver it', () => {
    const plan = planNextAction({ ...BASE, buyerNeed: CONFIRMED_NEED });
    expect(plan.type).toBe('FIND_SUBCONTRACTORS');
    expect(plan.targetStatus).toBe('BLOCKED');
    expect(plan.targetStage).toBe('SUPPLIER_REQUIRED');
  });

  it('verifies compliance before a candidate is presented to a buyer', () => {
    const plan = planNextAction({
      ...BASE,
      buyerNeed: CONFIRMED_NEED,
      matches: [
        {
          id: 'm1',
          companyId: 'co-2',
          companyName: 'Apex Commercial Cleaning',
          score: 0.8,
          isSelected: false,
          missingInformation: ['Certificate of insurance'],
          estimatedCost: 30000,
          callsNeeded: ['Request a certificate of insurance'],
        },
      ],
    });
    expect(plan.type).toBe('VERIFY_LICENSING_INSURANCE');
    expect(plan.call?.companyId).toBe('co-2');
  });

  it('requests pricing when a verified candidate has no cost basis', () => {
    const plan = planNextAction({
      ...BASE,
      buyerNeed: CONFIRMED_NEED,
      matches: [
        { id: 'm1', companyId: 'co-2', companyName: 'Apex', score: 0.8, isSelected: true, missingInformation: [], estimatedCost: null, callsNeeded: [] },
      ],
    });
    expect(plan.type).toBe('REQUEST_PRICING');
    expect(plan.call?.callType).toBe('PRICING_REQUEST');
  });

  it('compares before committing when several candidates are priced', () => {
    const plan = planNextAction({
      ...BASE,
      buyerNeed: CONFIRMED_NEED,
      matches: [
        { id: 'm1', companyId: 'co-2', companyName: 'Apex', score: 0.8, isSelected: false, missingInformation: [], estimatedCost: 30000, callsNeeded: [] },
        { id: 'm2', companyId: 'co-3', companyName: 'Bluegrass', score: 0.7, isSelected: false, missingInformation: [], estimatedCost: 28000, callsNeeded: [] },
      ],
    });
    expect(plan.type).toBe('BUILD_COMPARISON');
  });

  it('requires approval before a deal over the limit goes anywhere', () => {
    const plan = planNextAction({
      ...BASE,
      buyerNeed: CONFIRMED_NEED,
      matches: [
        { id: 'm1', companyId: 'co-2', companyName: 'Apex', score: 0.8, isSelected: true, missingInformation: [], estimatedCost: 30000, callsNeeded: [] },
      ],
      deal: { isConfigurable: true, missingTerms: [], grossProfit: 8000, buyerPrice: 40000 },
    });
    expect(plan.type).toBe('OBTAIN_APPROVAL');
    expect(plan.targetStage).toBe('AWAITING_APPROVAL');
  });

  it('prepares a quote once the deal is configured and within limits', () => {
    const plan = planNextAction({
      ...BASE,
      approvalLimit: 100000,
      buyerNeed: CONFIRMED_NEED,
      matches: [
        { id: 'm1', companyId: 'co-2', companyName: 'Apex', score: 0.8, isSelected: true, missingInformation: [], estimatedCost: 30000, callsNeeded: [] },
      ],
      deal: { isConfigurable: true, missingTerms: [], grossProfit: 8000, buyerPrice: 40000 },
    });
    expect(plan.type).toBe('PREPARE_QUOTE');
  });

  it('chases a sent quote rather than letting it go cold', () => {
    const plan = planNextAction({
      ...BASE,
      approvalLimit: 100000,
      buyerNeed: CONFIRMED_NEED,
      matches: [
        { id: 'm1', companyId: 'co-2', companyName: 'Apex', score: 0.8, isSelected: true, missingInformation: [], estimatedCost: 30000, callsNeeded: [] },
      ],
      deal: { isConfigurable: true, missingTerms: [], grossProfit: 8000, buyerPrice: 40000 },
      quotes: [{ id: 'q1', status: 'SENT', direction: 'outbound', sentAt: new Date(Date.now() - 4 * 86_400_000) }],
    });
    expect(plan.type).toBe('FOLLOW_UP_QUOTE');
    expect(plan.call?.callType).toBe('QUOTE_FOLLOW_UP');
    expect(plan.dueInDays).toBe(0);
  });

  it('pursues backup status after a loss instead of abandoning the account', () => {
    const plan = planNextAction({
      ...BASE,
      approvalLimit: 100000,
      buyerNeed: CONFIRMED_NEED,
      matches: [
        { id: 'm1', companyId: 'co-2', companyName: 'Apex', score: 0.8, isSelected: true, missingInformation: [], estimatedCost: 30000, callsNeeded: [] },
      ],
      deal: { isConfigurable: true, missingTerms: [], grossProfit: 8000, buyerPrice: 40000 },
      quotes: [{ id: 'q1', status: 'DECLINED', direction: 'outbound', sentAt: new Date(Date.now() - 10 * 86_400_000) }],
    });
    expect(plan.type).toBe('REQUEST_BACKUP_STATUS');
    expect(plan.call?.callType).toBe('BACKUP_PROVIDER_POSITIONING');
  });

  it('every plan names an owner, a reason and completion criteria', () => {
    const plans = [
      planNextAction(BASE),
      planNextAction({ ...BASE, buyerNeed: CONFIRMED_NEED }),
      planNextAction({ ...BASE, isSupplySide: true }),
      planNextAction({ ...BASE, openEscalations: 1 }),
    ];
    for (const plan of plans) {
      expect(plan.reason.length).toBeGreaterThan(20);
      expect(plan.ownerRole).toBeTruthy();
      expect(plan.expectedResult.length).toBeGreaterThan(10);
      expect(plan.completionCriteria.length).toBeGreaterThan(10);
      expect(plan.dueInDays).toBeGreaterThanOrEqual(0);
    }
  });
});
