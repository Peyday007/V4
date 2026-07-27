import type { CallType, NextActionType, OpportunityStatus, PipelineStage, Prisma } from '@prisma/client';
import { num, num0, prisma } from '@/lib/db';
import { getOrgConfig } from '@/lib/config';
import { recordActivity } from '@/lib/audit';
import { buildCallAssignment } from './callAssignment';
import { recordDecision } from './decisions';
import { raiseEscalation } from './escalation';

export const NEXT_ACTION_VERSION = 'next_action@4';

/** Party roles that mean the company is offering, not buying. */
const SUPPLY_SIDE_ROLES: string[] = ['SUPPLIER', 'DISTRIBUTOR', 'CARRIER', 'SUBCONTRACTOR'];

export type PlannedAction = {
  type: NextActionType;
  reason: string;
  ownerRole: string;
  dueInDays: number;
  inputsRequired: string[];
  expectedResult: string;
  completionCriteria: string;
  fallbackAction: NextActionType | null;
  escalationCondition: string | null;
  targetStage: PipelineStage;
  targetStatus: OpportunityStatus;
  /** When set, a call assignment is created against this company. */
  call?: {
    companyId: string;
    callType: CallType;
    objective: string;
    desiredCommitment: string;
    missingInformation: string[];
  };
};

type OpportunityContext = Prisma.OpportunityGetPayload<{
  include: {
    parties: { include: { company: { include: { contacts: true, locations: true } } } };
    buyerNeed: true;
    matches: { include: { candidate: true } };
    deal: true;
    quotes: true;
    callAssignments: true;
    nextActions: true;
    approvals: true;
    escalations: true;
  };
}>;

/**
 * Decides the single next action for an opportunity.
 *
 * The rules run in dependency order — you cannot price what you have not
 * scoped, and you cannot quote what nobody has agreed to fulfil. The first
 * rule that fires wins, which keeps "one primary next action" literally true.
 */
export function planNextAction(context: {
  opportunity: {
    id: string;
    type: string;
    stage: PipelineStage;
    status: OpportunityStatus;
    missingInformation: string[];
    estimatedValue: number | null;
    createdAt: Date;
  };
  primaryCompany: { id: string; name: string; contactCount: number; reachableContactCount: number } | null;
  buyerNeed: {
    id: string;
    status: string;
    scope: string;
    missingFields: string[];
    startDate: Date | null;
    estimatedValue: number | null;
  } | null;
  matches: Array<{
    id: string;
    companyId: string;
    companyName: string;
    score: number;
    isSelected: boolean;
    missingInformation: string[];
    estimatedCost: number | null;
    callsNeeded: string[];
  }>;
  deal: { isConfigurable: boolean; missingTerms: string[]; grossProfit: number | null; buyerPrice: number | null } | null;
  quotes: Array<{ id: string; status: string; direction: string; sentAt: Date | null }>;
  openApprovals: number;
  openEscalations: number;
  approvalLimit: number;
  daysSinceLastActivity: number;
  /** The primary party is offering capacity rather than asking for work. */
  isSupplySide: boolean;
  /** That offered capacity has been confirmed by someone at the company. */
  supplyConfirmed: boolean;
}): PlannedAction {
  const { opportunity, primaryCompany, buyerNeed, matches, deal, quotes } = context;
  const isSubcontracting = opportunity.type === 'SUBCONTRACTING';
  const supplySideAction: NextActionType = isSubcontracting ? 'FIND_SUBCONTRACTORS' : 'FIND_SUPPLIERS';
  const supplyCallType: CallType = isSubcontracting ? 'SUBCONTRACTOR_RECRUITMENT' : 'SUPPLIER_QUALIFICATION';

  // Rule 0 — an open escalation blocks autonomous progress by design.
  if (context.openEscalations > 0) {
    return {
      type: 'RESOLVE_BLOCKER',
      reason: 'An open escalation is holding this deal. Management judgement is required before the AI advances it further.',
      ownerRole: 'DEAL_MANAGER',
      dueInDays: 1,
      inputsRequired: ['Escalation detail', 'Deal configuration'],
      expectedResult: 'Escalation resolved or dismissed with a recorded decision.',
      completionCriteria: 'All escalations on this opportunity are RESOLVED or DISMISSED.',
      fallbackAction: 'ESCALATE',
      escalationCondition: 'Escalation is unresolved after 48 hours.',
      targetStage: opportunity.stage,
      targetStatus: 'ESCALATED',
    };
  }

  // Rule 1 — no company, nothing to work.
  if (!primaryCompany) {
    return {
      type: 'RESEARCH_COMPANY',
      reason: 'No company is attached to this opportunity, so there is nobody to contact.',
      ownerRole: 'RESEARCH_REVIEWER',
      dueInDays: 2,
      inputsRequired: ['Source evidence'],
      expectedResult: 'A resolved company record attached as the primary party.',
      completionCriteria: 'Opportunity has a primary party company.',
      fallbackAction: 'DISQUALIFY',
      escalationCondition: 'The source evidence does not identify a real company.',
      targetStage: 'RESEARCHING',
      targetStatus: 'ACTIVE',
    };
  }

  // Rule 2 — no way to reach anyone.
  if (primaryCompany.reachableContactCount === 0) {
    return {
      type: 'FIND_DECISION_MAKER',
      reason: `No reachable contact at ${primaryCompany.name}. Every downstream step needs someone to talk to.`,
      ownerRole: 'RESEARCH_REVIEWER',
      dueInDays: 2,
      inputsRequired: ['Company website', 'Directory listings', 'Existing CRM records'],
      expectedResult: 'At least one contact with a phone number, a title and a role in the buying process.',
      completionCriteria: 'A contact exists with a phone number and call consent.',
      fallbackAction: 'PAUSE',
      escalationCondition: 'No contact can be identified after two research passes.',
      targetStage: 'RESEARCHING',
      targetStatus: 'ACTIVE',
    };
  }

  // Rule 3 — supply-side opportunity: a provider has capacity, but nobody is
  // buying it yet. Qualifying a "buyer need" here would be qualifying the
  // wrong party; the work is to confirm what they actually have and then find
  // demand for it.
  if (context.isSupplySide && !buyerNeed) {
    const availabilityConfirmed = context.supplyConfirmed;
    return availabilityConfirmed
      ? {
          type: 'RESEARCH_COMPANY',
          reason: `${primaryCompany.name} has confirmed available capacity or inventory, but no buyer is attached. The deal exists only once demand is found for it.`,
          ownerRole: 'RESEARCH_REVIEWER',
          dueInDays: 3,
          inputsRequired: ['Confirmed supply details', 'Territory', 'Pricing'],
          expectedResult: 'At least two buyers with a plausible requirement for this supply.',
          completionCriteria: 'A buyer company is attached to the opportunity as a party.',
          fallbackAction: 'PAUSE',
          escalationCondition: 'No plausible buyer exists for this supply in our markets.',
          targetStage: 'RESEARCHING',
          targetStatus: 'ACTIVE',
        }
      : {
          type: 'CONFIRM_AVAILABILITY',
          reason: `${primaryCompany.name} appears to have capacity or inventory available, but that came from a published listing rather than from them. Confirm what actually exists before offering it to anyone.`,
          ownerRole: 'CALLER',
          dueInDays: 2,
          inputsRequired: ['Source listing'],
          expectedResult: 'Confirmed quantity, specification, price, lead time and how long it holds.',
          completionCriteria: 'A supplier availability record exists with CONFIRMED status.',
          fallbackAction: 'PAUSE',
          escalationCondition: 'What they have differs materially from what was published.',
          targetStage: 'QUALIFICATION_REQUIRED',
          targetStatus: 'ACTIVE',
          call: {
            companyId: primaryCompany.id,
            callType: 'SUPPLIER_QUALIFICATION',
            objective: 'Confirm exactly what is available: quantity, specification, price, whether it is delivered or picked up, lead time and how long it holds.',
            desiredCommitment: 'A written confirmation of availability and price with a stated validity period.',
            missingInformation: ['Quantity', 'Specification', 'Price', 'Freight basis', 'Lead time'],
          },
        };
  }

  // Rule 5 — demand is not established.
  if (!buyerNeed) {
    return {
      type: 'QUALIFY_BUYER_NEED',
      reason: `The signal suggests ${primaryCompany.name} has a need, but nothing is confirmed. A conversation has to establish whether a real requirement exists.`,
      ownerRole: 'CALLER',
      dueInDays: 2,
      inputsRequired: ['Discovery evidence', 'Company profile'],
      expectedResult: 'A recorded buyer need with scope, location, timing and current provider — or a clean disqualification.',
      completionCriteria: 'A BuyerNeed record exists with scope and location captured.',
      fallbackAction: 'DISQUALIFY',
      escalationCondition: 'Contact denies the need and no alternative requirement surfaces.',
      targetStage: 'QUALIFICATION_REQUIRED',
      targetStatus: 'ACTIVE',
      call: {
        companyId: primaryCompany.id,
        callType: isSubcontracting ? 'PRIME_QUALIFICATION' : 'BUYER_QUALIFICATION',
        objective: 'Confirm whether a real requirement exists, and capture scope, location, timing, volume and the current provider.',
        desiredCommitment: 'Permission to send a written scope and preliminary pricing.',
        missingInformation: opportunity.missingInformation,
      },
    };
  }

  // Rule 5 — demand exists but is too vague to fulfil.
  if (buyerNeed.status !== 'CONFIRMED' || buyerNeed.missingFields.length > 0) {
    const gaps = buyerNeed.missingFields.length ? buyerNeed.missingFields : ['Confirmation of the stated scope'];
    return {
      type: buyerNeed.missingFields.some((f) => /date|timeline|start/i.test(f)) ? 'CONFIRM_TIMELINE' : 'QUALIFY_SCOPE',
      reason: `The need is recorded but ${buyerNeed.status.toLowerCase()}, with ${gaps.length} gap(s): ${gaps.join(', ')}. Pricing anything now would be guesswork.`,
      ownerRole: 'CALLER',
      dueInDays: 2,
      inputsRequired: ['Existing need record'],
      expectedResult: `Confirmed values for: ${gaps.join(', ')}.`,
      completionCriteria: 'BuyerNeed status is CONFIRMED with no missing fields.',
      fallbackAction: 'ESCALATE',
      escalationCondition: 'The buyer cannot or will not define the scope.',
      targetStage: 'QUALIFICATION_REQUIRED',
      targetStatus: 'ACTIVE',
      call: {
        companyId: primaryCompany.id,
        callType: isSubcontracting ? 'PRIME_QUALIFICATION' : 'BUYER_QUALIFICATION',
        objective: `Close the remaining gaps: ${gaps.join(', ')}.`,
        desiredCommitment: 'A confirmed scope we can price against.',
        missingInformation: gaps,
      },
    };
  }

  // Rule 6 — demand confirmed, nobody can deliver it.
  if (matches.length === 0) {
    return {
      type: supplySideAction,
      reason: `${primaryCompany.name}'s need is confirmed, but no company in the graph can deliver it. Without a fulfillment partner there is no deal.`,
      ownerRole: 'RESEARCH_REVIEWER',
      dueInDays: 2,
      inputsRequired: ['Confirmed scope', 'Required capabilities', 'Service territory'],
      expectedResult: `At least two ${isSubcontracting ? 'subcontractors' : 'suppliers'} capable of the scope in the required territory.`,
      completionCriteria: 'Two or more candidates score 0.50 or better.',
      fallbackAction: 'ESCALATE',
      escalationCondition: 'No capable provider can be found in the territory.',
      targetStage: 'SUPPLIER_REQUIRED',
      targetStatus: 'BLOCKED',
    };
  }

  // Rule 7 — candidates exist, but their claims are unverified.
  const unverified = matches
    .filter((m) => m.missingInformation.length > 0)
    .sort((a, b) => b.score - a.score)[0];
  if (unverified && !matches.some((m) => m.isSelected && m.missingInformation.length === 0)) {
    const gaps = unverified.missingInformation;
    const isComplianceGap = gaps.some((g) => /insurance|licen|certif/i.test(g));
    return {
      type: isComplianceGap ? 'VERIFY_LICENSING_INSURANCE' : gaps.some((g) => /pricing|cost|freight/i.test(g)) ? 'REQUEST_PRICING' : 'CONFIRM_CAPACITY',
      reason: `${unverified.companyName} is the strongest candidate at ${(unverified.score * 100).toFixed(0)}%, but ${gaps.join(', ')} ${gaps.length === 1 ? 'is' : 'are'} unverified. Presenting them to the buyer now would be representing facts we do not have.`,
      ownerRole: 'CALLER',
      dueInDays: 2,
      inputsRequired: ['Confirmed buyer scope', 'Candidate profile'],
      expectedResult: `Confirmed values for: ${gaps.join(', ')}.`,
      completionCriteria: 'The candidate has no outstanding missing information.',
      fallbackAction: supplySideAction,
      escalationCondition: 'The candidate\'s insurance or licensing turns out to be insufficient.',
      targetStage: 'FULFILLMENT_CAPABILITY_CONFIRMED',
      targetStatus: 'ACTIVE',
      call: {
        companyId: unverified.companyId,
        callType: supplyCallType,
        objective: `Confirm capability and close gaps: ${gaps.join(', ')}. ${unverified.callsNeeded.join(' ')}`,
        desiredCommitment: 'Written confirmation of capacity, coverage, insurance and pricing for this scope.',
        missingInformation: gaps,
      },
    };
  }

  // Rule 8 — everything is verified but no cost basis exists.
  const priced = matches.filter((m) => m.estimatedCost !== null);
  if (priced.length === 0) {
    const best = matches[0];
    return {
      type: 'REQUEST_PRICING',
      reason: `${best.companyName} is confirmed capable but has given no price. A deal cannot be configured without a cost basis.`,
      ownerRole: 'CALLER',
      dueInDays: 2,
      inputsRequired: ['Confirmed scope', 'Quantity', 'Delivery point'],
      expectedResult: 'A price for the exact confirmed scope, with what it includes and how long it holds.',
      completionCriteria: 'A cost figure is recorded against the candidate.',
      fallbackAction: supplySideAction,
      escalationCondition: 'Pricing comes back materially different from what we told the buyer to expect.',
      targetStage: 'PRICING_REQUIRED',
      targetStatus: 'ACTIVE',
      call: {
        companyId: best.companyId,
        callType: 'PRICING_REQUEST',
        objective: 'Obtain firm pricing for the confirmed scope, including freight and validity period.',
        desiredCommitment: 'A written price valid for a stated period.',
        missingInformation: ['Pricing', 'Validity period', 'Inclusions and exclusions'],
      },
    };
  }

  // Rule 9 — comparison before commitment, when there is something to compare.
  if (priced.length >= 2 && !matches.some((m) => m.isSelected)) {
    return {
      type: 'BUILD_COMPARISON',
      reason: `${priced.length} priced candidates are available. Comparing delivered cost, risk and compliance before choosing protects the margin and the buyer.`,
      ownerRole: 'DEAL_MANAGER',
      dueInDays: 1,
      inputsRequired: ['Candidate pricing', 'Compliance status', 'Lead times'],
      expectedResult: 'A side-by-side comparison with a selected fulfillment path.',
      completionCriteria: 'One match is flagged as selected.',
      fallbackAction: 'ESCALATE',
      escalationCondition: 'Pricing between candidates varies by more than 30% with no explanation.',
      targetStage: 'MATCH_BEING_CONFIGURED',
      targetStatus: 'ACTIVE',
    };
  }

  // Rule 10 — deal not yet configurable.
  if (!deal || !deal.isConfigurable) {
    const missing = deal?.missingTerms ?? ['Deal configuration has not been attempted'];
    return {
      type: 'CONFIRM_SPECIFICATIONS',
      reason: `The deal cannot be configured yet. Outstanding: ${missing.join(', ')}.`,
      ownerRole: 'DEAL_MANAGER',
      dueInDays: 2,
      inputsRequired: missing,
      expectedResult: 'A complete deal configuration with buyer price, cost and gross profit.',
      completionCriteria: 'Deal.isConfigurable is true.',
      fallbackAction: 'ESCALATE',
      escalationCondition: 'A required term cannot be obtained from either side.',
      targetStage: 'MATCH_BEING_CONFIGURED',
      targetStatus: 'ACTIVE',
    };
  }

  // Rule 11 — configured deals over the limit need a human before they go out.
  const dealValue = deal.buyerPrice ?? opportunity.estimatedValue ?? 0;
  if (dealValue > context.approvalLimit && context.openApprovals === 0) {
    return {
      type: 'OBTAIN_APPROVAL',
      reason: `Deal value $${dealValue.toFixed(0)} exceeds the $${context.approvalLimit.toFixed(0)} approval limit. Nothing goes to the buyer until a manager signs off.`,
      ownerRole: 'DEAL_MANAGER',
      dueInDays: 1,
      inputsRequired: ['Deal configuration', 'Margin analysis', 'Compliance status'],
      expectedResult: 'An approval decision recorded against this deal.',
      completionCriteria: 'An APPROVED approval exists for the deal terms.',
      fallbackAction: 'ESCALATE',
      escalationCondition: 'Approval is not decided within 48 hours.',
      targetStage: 'AWAITING_APPROVAL',
      targetStatus: 'ESCALATED',
    };
  }

  // Rule 12 — approved and ready to quote.
  const outboundQuote = quotes.find((q) => q.direction === 'outbound');
  if (!outboundQuote) {
    return {
      type: 'PREPARE_QUOTE',
      reason: 'The deal is configured and within limits. Put it in front of the buyer.',
      ownerRole: 'DEAL_MANAGER',
      dueInDays: 1,
      inputsRequired: ['Deal configuration', 'Confirmed scope', 'Candidate pricing'],
      expectedResult: 'A quote drafted from confirmed figures only.',
      completionCriteria: 'A quote exists in DRAFT or later status.',
      fallbackAction: 'ESCALATE',
      escalationCondition: 'A line item cannot be priced from confirmed data.',
      targetStage: 'QUOTE_BEING_PREPARED',
      targetStatus: 'ACTIVE',
    };
  }

  if (outboundQuote.status === 'DRAFT' || outboundQuote.status === 'APPROVED') {
    return {
      type: 'SEND_QUOTE',
      reason: 'A quote is ready and the buyer is waiting.',
      ownerRole: 'DEAL_MANAGER',
      dueInDays: 1,
      inputsRequired: ['Approved quote'],
      expectedResult: 'Quote delivered to the buyer with a recorded send date.',
      completionCriteria: 'Quote status is SENT.',
      fallbackAction: 'ESCALATE',
      escalationCondition: 'The quote requires terms outside standard authority.',
      targetStage: 'QUOTE_BEING_PREPARED',
      targetStatus: 'ACTIVE',
    };
  }

  if (outboundQuote.status === 'SENT') {
    const daysSinceSent = outboundQuote.sentAt ? (Date.now() - outboundQuote.sentAt.getTime()) / 86_400_000 : 0;
    return {
      type: 'FOLLOW_UP_QUOTE',
      reason: `Quote sent ${Math.round(daysSinceSent)} day(s) ago with no response. Quotes that are not followed up are quotes that are lost.`,
      ownerRole: 'CALLER',
      dueInDays: daysSinceSent >= 3 ? 0 : 3 - daysSinceSent,
      inputsRequired: ['Sent quote', 'Original scope'],
      expectedResult: 'A decision, an objection to work, or a firm decision date.',
      completionCriteria: 'Buyer response recorded on the quote.',
      fallbackAction: 'REQUEST_TRIAL',
      escalationCondition: 'The buyer asks for terms or pricing outside standard authority.',
      targetStage: 'FOLLOW_UP_REQUIRED',
      targetStatus: 'WAITING',
      call: {
        companyId: primaryCompany.id,
        callType: 'QUOTE_FOLLOW_UP',
        objective: 'Confirm the quote was received and reviewed, surface objections, and get a decision date.',
        desiredCommitment: 'A yes, a no with a reason, or a firm decision date.',
        missingInformation: ['Buyer reaction to pricing', 'Decision timeline', 'Competing options'],
      },
    };
  }

  if (outboundQuote.status === 'ACCEPTED') {
    return {
      type: 'SCHEDULE_FULFILLMENT',
      reason: 'The buyer accepted. Lock in the fulfillment partner and the schedule before anything slips.',
      ownerRole: 'DEAL_MANAGER',
      dueInDays: 1,
      inputsRequired: ['Accepted quote', 'Selected fulfillment partner', 'Insurance verification'],
      expectedResult: 'A confirmed start date with the fulfillment partner committed in writing.',
      completionCriteria: 'Fulfillment scheduled with a confirmed date.',
      fallbackAction: 'ESCALATE',
      escalationCondition: 'The fulfillment partner is no longer available.',
      targetStage: 'FULFILLMENT_SCHEDULED',
      targetStatus: 'ACTIVE',
    };
  }

  if (outboundQuote.status === 'DECLINED') {
    return {
      type: 'REQUEST_BACKUP_STATUS',
      reason: 'The buyer declined this quote. The relationship is still worth something as a backup or overflow provider.',
      ownerRole: 'CALLER',
      dueInDays: 3,
      inputsRequired: ['Decline reason'],
      expectedResult: 'Backup-provider status, or a clean disqualification with a reason.',
      completionCriteria: 'Account is recorded as a backup option or disqualified.',
      fallbackAction: 'DISQUALIFY',
      escalationCondition: 'The decline reason indicates a service or compliance failure on our side.',
      targetStage: 'REPEAT_OR_EXPANSION',
      targetStatus: 'WAITING',
      call: {
        companyId: primaryCompany.id,
        callType: 'BACKUP_PROVIDER_POSITIONING',
        objective: 'Understand why we lost, and secure backup or overflow status.',
        desiredCommitment: 'Agreement to be called for overflow, emergency or backup work.',
        missingInformation: ['Loss reason', 'Winning competitor', 'Renewal date'],
      },
    };
  }

  // Rule 13 — neglect guard: nothing above fired, but time is passing.
  if (context.daysSinceLastActivity > 7) {
    return {
      type: 'CHECK_ACTIVE_WORK',
      reason: `No activity for ${Math.round(context.daysSinceLastActivity)} days. An opportunity with no movement and no owner action is an opportunity being lost quietly.`,
      ownerRole: 'DEAL_MANAGER',
      dueInDays: 1,
      inputsRequired: ['Activity history'],
      expectedResult: 'Either a new action, or a decision to pause or disqualify.',
      completionCriteria: 'Opportunity has a fresh action or a terminal status.',
      fallbackAction: 'PAUSE',
      escalationCondition: 'Still no movement after another 7 days.',
      targetStage: 'FOLLOW_UP_REQUIRED',
      targetStatus: 'WAITING',
    };
  }

  // Rule 14 — no safe next action. Never guess; hand it to a human.
  return {
    type: 'ESCALATE',
    reason: 'No safe next action can be determined from the current state. Escalating rather than inventing a step.',
    ownerRole: 'DEAL_MANAGER',
    dueInDays: 1,
    inputsRequired: ['Full opportunity state'],
    expectedResult: 'A human decision on how to proceed.',
    completionCriteria: 'A manager records a next action or closes the opportunity.',
    fallbackAction: null,
    escalationCondition: 'Immediate.',
    targetStage: 'FOLLOW_UP_REQUIRED',
    targetStatus: 'ESCALATED',
  };
}

/** Loads context, plans, persists the action, transitions the stage. */
export async function determineNextAction(opportunityId: string): Promise<PlannedAction> {
  const opportunity = (await prisma.opportunity.findUniqueOrThrow({
    where: { id: opportunityId },
    include: {
      parties: { include: { company: { include: { contacts: true, locations: true } } } },
      buyerNeed: true,
      matches: { include: { candidate: true }, orderBy: { score: 'desc' } },
      deal: true,
      quotes: true,
      callAssignments: true,
      nextActions: true,
      approvals: true,
      escalations: true,
    },
  })) as OpportunityContext;

  const config = await getOrgConfig(opportunity.orgId);
  const primaryParty = opportunity.parties.find((p) => p.isPrimary) ?? opportunity.parties[0] ?? null;
  const contacts = primaryParty?.company.contacts ?? [];
  const supplyOffers = primaryParty
    ? await prisma.supplierAvailability.findMany({ where: { orgId: opportunity.orgId, companyId: primaryParty.companyId } })
    : [];

  const plan = planNextAction({
    opportunity: {
      id: opportunity.id,
      type: opportunity.type,
      stage: opportunity.stage,
      status: opportunity.status,
      missingInformation: opportunity.missingInformation,
      estimatedValue: num(opportunity.estimatedValue),
      createdAt: opportunity.createdAt,
    },
    primaryCompany: primaryParty
      ? {
          id: primaryParty.companyId,
          name: primaryParty.company.legalName,
          contactCount: contacts.length,
          reachableContactCount: contacts.filter((c) => (c.phone || c.mobile) && c.consentToCall).length,
        }
      : null,
    buyerNeed: opportunity.buyerNeed
      ? {
          id: opportunity.buyerNeed.id,
          status: opportunity.buyerNeed.status,
          scope: opportunity.buyerNeed.scope,
          missingFields: opportunity.buyerNeed.missingFields,
          startDate: opportunity.buyerNeed.startDate,
          estimatedValue: num(opportunity.buyerNeed.estimatedValue),
        }
      : null,
    matches: opportunity.matches.map((m) => ({
      id: m.id,
      companyId: m.candidateCompanyId,
      companyName: m.candidate.legalName,
      score: m.score,
      isSelected: m.isSelected,
      missingInformation: m.missingInformation,
      estimatedCost: num(m.estimatedCost),
      callsNeeded: m.callsNeeded,
    })),
    deal: opportunity.deal
      ? {
          isConfigurable: opportunity.deal.isConfigurable,
          missingTerms: opportunity.deal.missingTerms,
          grossProfit: num(opportunity.deal.grossProfit),
          buyerPrice: num(opportunity.deal.buyerPrice),
        }
      : null,
    quotes: opportunity.quotes.map((q) => ({ id: q.id, status: q.status, direction: q.direction, sentAt: q.sentAt })),
    openApprovals: opportunity.approvals.filter((a) => a.status === 'PENDING').length,
    openEscalations: opportunity.escalations.filter((e) => e.status === 'OPEN' || e.status === 'ACKNOWLEDGED').length,
    approvalLimit: config.approvalLimits.dealValueRequiringApproval,
    daysSinceLastActivity: (Date.now() - opportunity.lastActivityAt.getTime()) / 86_400_000,
    isSupplySide: SUPPLY_SIDE_ROLES.includes(primaryParty?.role ?? 'BUYER'),
    supplyConfirmed: supplyOffers.some((s) => s.status === 'CONFIRMED'),
  });

  // Supersede the previous action — exactly one is current at any time.
  await prisma.nextAction.updateMany({
    where: { opportunityId, isCurrent: true },
    data: { isCurrent: false },
  });

  const dueDate = new Date(Date.now() + Math.max(0, plan.dueInDays) * 86_400_000);
  const owner = await pickOwner(opportunity.orgId, plan.ownerRole);

  await prisma.nextAction.create({
    data: {
      orgId: opportunity.orgId,
      opportunityId,
      type: plan.type,
      reason: plan.reason,
      ownerId: owner?.id ?? null,
      ownerRole: plan.ownerRole,
      dueDate,
      inputsRequired: plan.inputsRequired,
      expectedResult: plan.expectedResult,
      completionCriteria: plan.completionCriteria,
      fallbackAction: plan.fallbackAction,
      escalationCondition: plan.escalationCondition,
    },
  });

  // Stage transition, recorded in the append-only ledger.
  if (plan.targetStage !== opportunity.stage || plan.targetStatus !== opportunity.status) {
    await prisma.dealStatusHistory.create({
      data: {
        opportunityId,
        fromStage: opportunity.stage,
        toStage: plan.targetStage,
        fromStatus: opportunity.status,
        toStatus: plan.targetStatus,
        reason: plan.reason,
        actorType: 'ai',
      },
    });
    await prisma.opportunity.update({
      where: { id: opportunityId },
      data: {
        stage: plan.targetStage,
        status: plan.targetStatus,
        stageEnteredAt: new Date(),
        primaryBlocker: plan.targetStatus === 'BLOCKED' ? plan.reason : null,
        dueDate,
      },
    });
  } else {
    await prisma.opportunity.update({ where: { id: opportunityId }, data: { dueDate } });
  }

  // Ensure the owner has a task they can see in their own queue.
  if (owner && plan.ownerRole !== 'CALLER') {
    await prisma.task.create({
      data: {
        orgId: opportunity.orgId,
        opportunityId,
        ownerId: owner.id,
        title: `${plan.type.replace(/_/g, ' ').toLowerCase()} — ${opportunity.name}`,
        description: `${plan.reason}\n\nExpected result: ${plan.expectedResult}\nDone when: ${plan.completionCriteria}`,
        kind: plan.type,
        priority: opportunity.priority,
        dueDate,
      },
    });
  }

  if (plan.call) {
    await buildCallAssignment({
      orgId: opportunity.orgId,
      opportunityId,
      companyId: plan.call.companyId,
      callType: plan.call.callType,
      reason: plan.reason,
      objective: plan.call.objective,
      desiredCommitment: plan.call.desiredCommitment,
      missingInformation: plan.call.missingInformation,
      priority: opportunity.priority,
      dueDate,
    });
  }

  if (plan.type === 'ESCALATE') {
    await raiseEscalation({
      orgId: opportunity.orgId,
      opportunityId,
      reason: 'NO_SAFE_NEXT_ACTION',
      title: `No safe next action for ${opportunity.name}`,
      detail: plan.reason,
      severity: 'MEDIUM',
    });
  }

  await recordDecision({
    orgId: opportunity.orgId,
    opportunityId,
    process: 'next_action',
    decision: `${plan.type} due ${dueDate.toISOString().slice(0, 10)}`,
    reason: plan.reason,
    inputs: {
      stage: opportunity.stage,
      matchCount: opportunity.matches.length,
      hasNeed: Boolean(opportunity.buyerNeed),
      hasDeal: Boolean(opportunity.deal),
    },
    outputs: { type: plan.type, targetStage: plan.targetStage, ownerRole: plan.ownerRole },
    confidence: 0.85,
    rulesApplied: ['next_action_decision_table'],
    modelName: 'deterministic',
    promptVersion: NEXT_ACTION_VERSION,
  });

  await recordActivity({
    orgId: opportunity.orgId,
    opportunityId,
    verb: 'next_action.set',
    summary: `Next action: ${plan.type.replace(/_/g, ' ').toLowerCase()} — ${plan.reason.slice(0, 180)}`,
    payload: { type: plan.type, dueDate },
  });

  return plan;
}

async function pickOwner(orgId: string, roleKey: string): Promise<{ id: string } | null> {
  const user = await prisma.user.findFirst({
    where: { orgId, isActive: true, role: { key: roleKey } },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  if (user) return user;
  return prisma.user.findFirst({
    where: { orgId, isActive: true, role: { key: { in: ['DEAL_MANAGER', 'OWNER'] } } },
    select: { id: true },
  });
}

/** Sweeps every active opportunity — used by the daily planning job. */
export async function refreshAllNextActions(orgId: string, limit = 300): Promise<number> {
  const opportunities = await prisma.opportunity.findMany({
    where: { orgId, status: { in: ['ACTIVE', 'WAITING', 'BLOCKED'] } },
    select: { id: true },
    take: limit,
  });
  for (const opportunity of opportunities) {
    try {
      await determineNextAction(opportunity.id);
    } catch (error) {
      console.error(`[next_action] ${opportunity.id}:`, String(error));
    }
  }
  return opportunities.length;
}

export { num0 };
