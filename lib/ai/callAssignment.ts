import type { CallType, Company, Contact, Opportunity, Priority } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getOrgConfig } from '@/lib/config';
import { checkContactability } from '@/lib/compliance';
import { recordActivity } from '@/lib/audit';
import { recordDecision } from './decisions';

export const ASSIGNMENT_VERSION = 'call_assignment@2';

/**
 * Question bank. These are the facts a call has to come back with; the AI
 * fills the gaps, the caller just runs the conversation. Every entry maps to a
 * `factKey` so the extractor knows what it is looking for afterwards.
 */
export const DEFAULT_QUESTIONS: Record<CallType, Array<{ prompt: string; factKey: string; required: boolean }>> = {
  BUYER_QUALIFICATION: [
    { prompt: 'What exactly is the work or product you need?', factKey: 'need.scope', required: true },
    { prompt: 'Which locations does this cover?', factKey: 'need.location', required: true },
    { prompt: 'When does it need to start, and is there a hard deadline?', factKey: 'need.timeline', required: true },
    { prompt: 'Is this a one-time job, recurring, overflow, or an emergency?', factKey: 'need.frequency', required: true },
    { prompt: 'Who handles this today?', factKey: 'need.current_provider', required: true },
    { prompt: 'What is working and not working with that arrangement?', factKey: 'need.provider_issues', required: true },
    { prompt: 'What budget range or current spend are you working against?', factKey: 'need.budget', required: false },
    { prompt: 'Who else is involved in the decision?', factKey: 'contact.decision_process', required: false },
    { prompt: 'What insurance or licensing do your vendors have to carry?', factKey: 'need.insurance_requirement', required: false },
  ],
  PRIME_QUALIFICATION: [
    { prompt: 'Which scopes on this award are you planning to subcontract?', factKey: 'need.scope', required: true },
    { prompt: 'What are the site locations and the performance period?', factKey: 'need.location', required: true },
    { prompt: 'What is the estimated value of the packages you are letting out?', factKey: 'need.estimated_value', required: true },
    { prompt: 'What insurance limits and licences do your subs have to carry?', factKey: 'need.insurance_requirement', required: true },
    { prompt: 'Are there small business or participation goals attached to this award?', factKey: 'need.participation_goals', required: false },
    { prompt: 'Do you already have subs lined up for these packages?', factKey: 'need.current_provider', required: true },
    { prompt: 'When do you need to have those packages committed?', factKey: 'need.timeline', required: true },
  ],
  SUBCONTRACTOR_RECRUITMENT: [
    { prompt: 'Do you have capacity for additional work in this territory?', factKey: 'capacity.available', required: true },
    { prompt: 'How many crews could you put on this?', factKey: 'capacity.crew_count', required: true },
    { prompt: 'Which counties or areas do you actually cover?', factKey: 'capacity.territories', required: true },
    { prompt: 'What is your minimum contract size?', factKey: 'capacity.minimum_contract', required: true },
    { prompt: 'What are your general liability and workers comp limits?', factKey: 'capacity.insurance_limits', required: true },
    { prompt: 'What licences do you hold, and what are the numbers?', factKey: 'capacity.licenses', required: true },
    { prompt: 'How soon could you start?', factKey: 'capacity.earliest_start', required: true },
    { prompt: 'Can you cover night or weekend shifts?', factKey: 'capacity.shift_availability', required: false },
    { prompt: 'Do you supply your own consumables and equipment?', factKey: 'capacity.supplies_consumables', required: false },
  ],
  SUPPLIER_QUALIFICATION: [
    { prompt: 'Do you have this product or material available right now?', factKey: 'supply.available', required: true },
    { prompt: 'What quantity can you commit to?', factKey: 'supply.quantity', required: true },
    { prompt: 'What are the exact specifications or gradations you carry?', factKey: 'supply.specifications', required: true },
    { prompt: 'What is your price, and is that picked up or delivered?', factKey: 'supply.unit_cost', required: true },
    { prompt: 'What is the freight cost to the delivery point?', factKey: 'supply.freight', required: true },
    { prompt: 'What is your lead time?', factKey: 'supply.lead_time', required: true },
    { prompt: 'What is your minimum order?', factKey: 'supply.minimum_order', required: false },
    { prompt: 'What payment terms do you offer?', factKey: 'supply.payment_terms', required: false },
  ],
  AVAILABILITY_CONFIRMATION: [
    { prompt: 'Is the capacity or inventory we discussed still available?', factKey: 'supply.available', required: true },
    { prompt: 'Has the price changed since we last spoke?', factKey: 'supply.unit_cost', required: true },
    { prompt: 'How long can you hold it?', factKey: 'supply.hold_period', required: true },
  ],
  PRICING_REQUEST: [
    { prompt: 'What is your price for this exact scope and quantity?', factKey: 'pricing.amount', required: true },
    { prompt: 'What does that price include and exclude?', factKey: 'pricing.inclusions', required: true },
    { prompt: 'How long is that price good for?', factKey: 'pricing.valid_until', required: true },
    { prompt: 'What are your payment terms?', factKey: 'pricing.payment_terms', required: false },
  ],
  QUOTE_FOLLOW_UP: [
    { prompt: 'Did you have a chance to review the quote we sent?', factKey: 'quote.reviewed', required: true },
    { prompt: 'How does the pricing compare to what you expected?', factKey: 'quote.price_feedback', required: true },
    { prompt: 'What would need to change for you to move forward?', factKey: 'quote.objections', required: true },
    { prompt: 'What is your decision timeline?', factKey: 'quote.decision_timeline', required: true },
  ],
  TRIAL_ORDER_REQUEST: [
    { prompt: 'Would you be open to trying us on one location or one order?', factKey: 'trial.willingness', required: true },
    { prompt: 'Which location or order would make the most sense to start with?', factKey: 'trial.scope', required: true },
    { prompt: 'What would we need to prove for you to expand it?', factKey: 'trial.success_criteria', required: true },
  ],
  BACKUP_PROVIDER_POSITIONING: [
    { prompt: 'Would it help to have a backup for overflow or emergencies?', factKey: 'backup.willingness', required: true },
    { prompt: 'What situations would cause you to call a backup?', factKey: 'backup.trigger_conditions', required: true },
    { prompt: 'What would you need from us to have us on the list?', factKey: 'backup.onboarding_requirements', required: true },
  ],
  NEGOTIATION_SUPPORT: [
    { prompt: 'Which specific terms are the sticking point?', factKey: 'negotiation.blocking_terms', required: true },
    { prompt: 'What would make this work on your side?', factKey: 'negotiation.counter_position', required: true },
  ],
  EXPANSION_REQUEST: [
    { prompt: 'How has the work been going at the current location?', factKey: 'expansion.satisfaction', required: true },
    { prompt: 'Which other locations or categories could we quote?', factKey: 'expansion.scope', required: true },
    { prompt: 'What is the timing on those?', factKey: 'expansion.timeline', required: true },
  ],
  RELATIONSHIP_REACTIVATION: [
    { prompt: 'What has changed since we last worked together?', factKey: 'reactivation.changes', required: true },
    { prompt: 'Is the need we handled before still active?', factKey: 'reactivation.need_active', required: true },
  ],
  FULFILLMENT_ISSUE: [
    { prompt: 'What exactly went wrong and when?', factKey: 'issue.description', required: true },
    { prompt: 'What impact has it had on your operation?', factKey: 'issue.impact', required: true },
    { prompt: 'What resolution are you looking for?', factKey: 'issue.desired_resolution', required: true },
  ],
};

const MAY_OFFER: Record<CallType, string[]> = {
  BUYER_QUALIFICATION: ['A written scope and preliminary pricing at no cost', 'A site walk if useful'],
  PRIME_QUALIFICATION: ['Prequalified subcontractor introductions', 'A written capability summary'],
  SUBCONTRACTOR_RECRUITMENT: ['Consideration for an upcoming scope', 'The written scope for pricing'],
  SUPPLIER_QUALIFICATION: ['A specific quantity and delivery point to quote against'],
  AVAILABILITY_CONFIRMATION: ['A short hold window while we confirm with the buyer'],
  PRICING_REQUEST: ['The confirmed scope and quantity in writing'],
  QUOTE_FOLLOW_UP: ['A revised scope or an alternative structure for review'],
  TRIAL_ORDER_REQUEST: ['A single-location or single-order trial', 'Standard commercial terms'],
  BACKUP_PROVIDER_POSITIONING: ['Backup or overflow availability at standard rates', 'Insurance and licence documentation'],
  NEGOTIATION_SUPPORT: ['To take the request back to management for a decision'],
  EXPANSION_REQUEST: ['Pricing on additional locations', 'A consolidated service schedule'],
  RELATIONSHIP_REACTIVATION: ['A refreshed quote on current pricing'],
  FULFILLMENT_ISSUE: ['To escalate internally and come back with a resolution today'],
};

const MAY_NOT_PROMISE: string[] = [
  'Do not commit to a final price. Preliminary figures only, clearly marked as preliminary.',
  'Do not promise a start date, delivery date or crew availability that has not been confirmed in writing.',
  'Do not agree to exclusivity, volume commitments, or penalty clauses.',
  'Do not agree to payment terms, credit terms or discounts.',
  'Do not accept or sign contract terms on this call.',
  'Do not represent capabilities, licences or insurance that are not verified on file.',
  'Do not state or imply that a subcontractor or supplier has already agreed to the work.',
];

const ESCALATE_IF: string[] = [
  'They request exclusivity or a volume commitment',
  'They require an upfront financial commitment or deposit',
  'Their insurance or licensing appears insufficient for the scope',
  'They want changes to contract terms',
  'They disclose a conflict with the buyer or another party in the deal',
  'They raise a legal, regulatory or safety concern',
  'They dispute an invoice, a commitment, or something they were previously told',
  'The pricing they give is materially different from what we have on file',
];

export type BuildAssignmentInput = {
  orgId: string;
  opportunityId?: string | null;
  companyId: string;
  contactId?: string | null;
  callType: CallType;
  reason: string;
  objective: string;
  desiredCommitment: string;
  missingInformation: string[];
  priority?: Priority;
  dueDate?: Date;
};

/**
 * Builds a call assignment complete enough that the caller has to do nothing
 * except have the conversation: why we are calling, what we know, what is
 * missing, what to ask, what may be offered, and when to stop and escalate.
 */
export async function buildCallAssignment(input: BuildAssignmentInput): Promise<string | null> {
  const config = await getOrgConfig(input.orgId);

  // Don't stack duplicate assignments on the same company for the same purpose.
  const existing = await prisma.callAssignment.findFirst({
    where: {
      orgId: input.orgId,
      opportunityId: input.opportunityId ?? undefined,
      companyId: input.companyId,
      callType: input.callType,
      status: { in: ['PENDING', 'ASSIGNED', 'IN_PROGRESS', 'RESCHEDULED'] },
    },
  });
  if (existing) return existing.id;

  const company = await prisma.company.findFirstOrThrow({
    where: { id: input.companyId, orgId: input.orgId },
    include: { contacts: true, locations: true },
  });

  const contact = input.contactId
    ? company.contacts.find((c) => c.id === input.contactId) ?? null
    : pickBestContact(company.contacts, input.callType);

  const opportunity = input.opportunityId
    ? await prisma.opportunity.findUnique({ where: { id: input.opportunityId } })
    : null;

  const compliance = await checkContactability({
    orgId: input.orgId,
    contactId: contact?.id,
    phone: contact?.phone ?? company.phone,
    state: company.locations.find((l) => l.isHeadquarters)?.state ?? null,
  });

  // Compliance blocks that are not just "wrong time of day" stop the assignment.
  const hardBlocks = compliance.reasons.filter((r) => !r.startsWith('Outside'));
  if (hardBlocks.length > 0) {
    await recordDecision({
      orgId: input.orgId,
      opportunityId: input.opportunityId,
      process: 'call_assignment',
      decision: 'Assignment not created',
      reason: `Contactability check failed: ${hardBlocks.join('; ')}`,
      confidence: 0.95,
      rulesApplied: ['suppression_list', 'consent_check'],
      modelName: 'deterministic',
      promptVersion: ASSIGNMENT_VERSION,
    });
    return null;
  }

  const configured = await prisma.qualificationQuestion.findMany({
    where: { orgId: input.orgId, callType: input.callType, isActive: true },
    orderBy: { sortOrder: 'asc' },
  });

  const questions = configured.length
    ? configured.map((q) => ({ prompt: q.prompt, factKey: q.factKey, required: q.required }))
    : DEFAULT_QUESTIONS[input.callType];

  const script = await prisma.scriptTemplate.findFirst({
    where: { orgId: input.orgId, callType: input.callType, isActive: true },
    orderBy: { version: 'desc' },
  });

  const known = await buildKnownInformation(company.id, opportunity?.id ?? null);
  const previous = await buildPreviousSummary(company.id);

  const assignment = await prisma.callAssignment.create({
    data: {
      orgId: input.orgId,
      opportunityId: input.opportunityId ?? null,
      companyId: company.id,
      contactId: contact?.id ?? null,
      scriptId: script?.id ?? null,
      callType: input.callType,
      status: 'PENDING',
      priority: input.priority ?? opportunity?.priority ?? 'MEDIUM',
      reason: input.reason,
      objective: input.objective,
      knownInformation: known as object,
      missingInformation: input.missingInformation.map((m) => ({ label: m })) as object,
      requiredQuestions: questions.filter((q) => q.required) as object,
      optionalQuestions: questions.filter((q) => !q.required) as object,
      desiredCommitment: input.desiredCommitment,
      mayOffer: script?.mayOffer.length ? script.mayOffer : MAY_OFFER[input.callType],
      mayNotPromise: script?.mayNotPromise.length ? script.mayNotPromise : MAY_NOT_PROMISE,
      escalateIf: script?.escalateIf.length ? script.escalateIf : ESCALATE_IF,
      previousSummary: previous,
      maxAttempts: config.callingRules.maxAttemptsPerContact,
      dueDate: input.dueDate ?? new Date(Date.now() + 2 * 86_400_000),
    },
  });

  const assignedTo = await assignCaller(assignment.id);

  await recordDecision({
    orgId: input.orgId,
    opportunityId: input.opportunityId,
    process: 'call_assignment',
    decision: `Created ${input.callType} assignment for ${company.legalName}`,
    reason: input.reason,
    inputs: { missingInformation: input.missingInformation, contactId: contact?.id },
    outputs: { assignmentId: assignment.id, assignedToId: assignedTo?.userId, questionCount: questions.length },
    confidence: contact ? 0.8 : 0.5,
    rulesApplied: ['question_bank', 'compliance_gate', 'caller_matching'],
    modelName: 'deterministic',
    promptVersion: ASSIGNMENT_VERSION,
  });

  await recordActivity({
    orgId: input.orgId,
    opportunityId: input.opportunityId ?? null,
    companyId: company.id,
    contactId: contact?.id ?? null,
    verb: 'call_assignment.created',
    summary: `${input.callType.replace(/_/g, ' ').toLowerCase()} assignment created: ${input.objective}`,
    payload: { assignmentId: assignment.id },
  });

  return assignment.id;
}

function pickBestContact(contacts: Contact[], callType: CallType): Contact | null {
  if (contacts.length === 0) return null;
  const reachable = contacts.filter((c) => (c.phone || c.mobile) && c.consentToCall);
  if (reachable.length === 0) return null;

  const wantsDecisionMaker: CallType[] = [
    'BUYER_QUALIFICATION', 'PRIME_QUALIFICATION', 'TRIAL_ORDER_REQUEST',
    'BACKUP_PROVIDER_POSITIONING', 'NEGOTIATION_SUPPORT', 'EXPANSION_REQUEST',
  ];

  const ranked = [...reachable].sort((a, b) => {
    const authorityScore = (c: Contact) => (c.decisionAuthority === 'decision_maker' ? 2 : c.decisionAuthority === 'influencer' ? 1 : 0);
    if (wantsDecisionMaker.includes(callType)) {
      const diff = authorityScore(b) - authorityScore(a);
      if (diff !== 0) return diff;
    }
    return b.influenceLevel - a.influenceLevel;
  });

  return ranked[0];
}

async function buildKnownInformation(companyId: string, opportunityId: string | null): Promise<Array<{ label: string; value: string; status: string }>> {
  const known: Array<{ label: string; value: string; status: string }> = [];

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    include: {
      locations: true,
      capabilities: { include: { capability: true } },
      subCapacity: true,
      supplyOffers: true,
    },
  });
  if (!company) return known;

  if (company.serviceTerritories.length) {
    known.push({ label: 'Service territory', value: company.serviceTerritories.join(', '), status: 'INFERRED' });
  }
  for (const location of company.locations.slice(0, 2)) {
    known.push({ label: 'Location', value: [location.city, location.state].filter(Boolean).join(', '), status: 'INFERRED' });
  }
  for (const capability of company.capabilities.slice(0, 5)) {
    known.push({ label: 'Capability', value: capability.capability.name, status: capability.status });
  }
  for (const capacity of company.subCapacity.slice(0, 1)) {
    if (capacity.crewCount) known.push({ label: 'Crews', value: String(capacity.crewCount), status: capacity.status });
    if (capacity.minimumContract) known.push({ label: 'Minimum contract', value: `$${capacity.minimumContract}`, status: capacity.status });
  }
  for (const supply of company.supplyOffers.slice(0, 2)) {
    known.push({ label: 'Available supply', value: supply.description, status: supply.status });
  }

  if (opportunityId) {
    const facts = await prisma.extractedFact.findMany({
      where: { opportunityId, status: { in: ['CONFIRMED', 'CLAIMED'] } },
      orderBy: { capturedAt: 'desc' },
      take: 12,
    });
    for (const fact of facts) {
      known.push({ label: fact.factKey, value: fact.factValue, status: fact.status });
    }
  }

  return known;
}

async function buildPreviousSummary(companyId: string): Promise<string | null> {
  const lastCall = await prisma.call.findFirst({
    where: { assignment: { companyId } },
    orderBy: { startedAt: 'desc' },
    include: { transcript: true, assignment: true },
  });
  if (!lastCall) return null;

  const when = lastCall.startedAt.toISOString().slice(0, 10);
  const summary = lastCall.transcript?.summary ?? lastCall.notes ?? 'No summary recorded.';
  return `Last contact ${when} (${lastCall.assignment?.callType.replace(/_/g, ' ').toLowerCase() ?? 'call'}, outcome ${lastCall.outcome ?? 'unknown'}): ${summary}`;
}

/**
 * Caller selection (spec §21). Skill fit and outcome history decide, not who
 * has the emptiest queue — though load is a tiebreaker so no one is buried.
 */
export async function assignCaller(assignmentId: string): Promise<{ userId: string; reason: string } | null> {
  const assignment = await prisma.callAssignment.findUniqueOrThrow({
    where: { id: assignmentId },
    include: { company: { include: { industries: { include: { industry: true } } } }, opportunity: true },
  });
  const config = await getOrgConfig(assignment.orgId);

  const callers = await prisma.user.findMany({
    where: { orgId: assignment.orgId, isActive: true, role: { key: 'CALLER' } },
    include: {
      callerProfile: true,
      assignedCalls: { where: { status: { in: ['PENDING', 'ASSIGNED', 'IN_PROGRESS'] } }, select: { id: true } },
    },
  });
  if (callers.length === 0) return null;

  const supplySideTypes: CallType[] = [
    'SUBCONTRACTOR_RECRUITMENT', 'SUPPLIER_QUALIFICATION', 'AVAILABILITY_CONFIRMATION', 'PRICING_REQUEST',
  ];
  const isSupplySide = supplySideTypes.includes(assignment.callType);
  const isWarm = assignment.previousSummary !== null;
  const industryKeys = assignment.company.industries.map((i) => i.industry.key);
  const isHighValue = (assignment.opportunity?.priority ?? 'MEDIUM') === 'CRITICAL' || assignment.priority === 'CRITICAL';

  const scored = callers.map((caller) => {
    const profile = caller.callerProfile;
    const reasons: string[] = [];
    let score = 0.3;

    if (profile) {
      const sideSkill = isSupplySide ? profile.supplySideSkill : profile.buyerSideSkill;
      score += sideSkill * 0.9;
      reasons.push(`${isSupplySide ? 'supply' : 'buyer'}-side skill ${sideSkill.toFixed(2)}`);

      const contactSkill = isWarm ? profile.warmCallSkill : profile.coldCallSkill;
      score += contactSkill * 0.7;
      reasons.push(`${isWarm ? 'warm' : 'cold'}-call skill ${contactSkill.toFixed(2)}`);

      score += profile.extractionAccuracy * 0.5;
      reasons.push(`extraction accuracy ${profile.extractionAccuracy.toFixed(2)}`);

      if (isHighValue) {
        score += profile.objectionSkill * 0.6;
        reasons.push(`objection handling ${profile.objectionSkill.toFixed(2)} (high-value call)`);
      }

      if (profile.industryStrengths.some((s) => industryKeys.includes(s))) {
        score += 0.5;
        reasons.push('has track record in this industry');
      }
      if (profile.callTypeStrengths.includes(assignment.callType)) {
        score += 0.4;
        reasons.push('strong on this call type');
      }

      const load = caller.assignedCalls.length;
      const capacity = profile.maxDailyCalls || config.planning.dailyCallCapacityPerCaller;
      if (load >= capacity) {
        score -= 1.5;
        reasons.push(`at capacity (${load}/${capacity})`);
      } else {
        score -= (load / capacity) * 0.6;
        reasons.push(`queue ${load}/${capacity}`);
      }
    }

    return { caller, score, reason: reasons.join(', ') };
  });

  scored.sort((a, b) => b.score - a.score);
  const winner = scored[0];
  if (!winner || winner.score <= 0) return null;

  const reason = `Selected ${winner.caller.name}: ${winner.reason}.`;
  await prisma.callAssignment.update({
    where: { id: assignmentId },
    data: { assignedToId: winner.caller.id, status: 'ASSIGNED', assignmentReason: reason },
  });

  await prisma.notification.create({
    data: {
      orgId: assignment.orgId,
      userId: winner.caller.id,
      kind: 'call_assigned',
      title: `New call: ${assignment.company.legalName}`,
      body: assignment.objective,
      link: `/calls/${assignmentId}`,
    },
  });

  return { userId: winner.caller.id, reason };
}

/** Shared shape used by the caller UI. */
export type CallBrief = {
  assignment: Awaited<ReturnType<typeof prisma.callAssignment.findFirstOrThrow>>;
  company: Company;
  contact: Contact | null;
  opportunity: Opportunity | null;
};
