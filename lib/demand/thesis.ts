import type { FrictionLevel, LeadTier, RiskLevel } from '@prisma/client';
import { humaniseEvent } from './events';
import type { Playbook } from './playbooks';
import type { DemandEventType } from '@prisma/client';

/**
 * The lead thesis.
 *
 * Written for the person about to pick up the phone. The board can show a
 * tier, a friction level and a number, and none of that answers the only
 * question that matters at the moment of dialling: why am I calling this
 * company today rather than any of the other four hundred?
 *
 * Held as structured parts rather than prose so each can be checked for
 * presence. A thesis missing its stakeholder is missing something specific,
 * and the interface can say so — where a paragraph would simply read a little
 * thin and nobody would notice which part was absent.
 *
 * The hardest rule here is the separation between what the source said and
 * what we concluded. "A licence was issued on the first" is theirs. "Which
 * usually means a final clean is needed in the fortnight before" is ours, and
 * every sentence of ours is marked as ours.
 */

export type Thesis = {
  /** Why this company at all. */
  whyThisCompany: string;
  /** Why now rather than in six months. */
  whyNow: string;
  /** What the source stated, verbatim-ish. Never our conclusion. */
  externalEvidence: string[];
  /** What we concluded from it. Always labelled. */
  likelyNeed: string;
  needIsConfirmed: boolean;
  /** Who inside the organisation owns this problem. */
  likelyStakeholder: string;
  /** Which commercial route and why that one. */
  commercialRoute: string;
  /** What the supply side has to provide. */
  fulfilmentRequirement: string;
  buyingWindow: string;
  friction: string;
  economics: string;
  /** Everything that could make this wrong. */
  uncertainties: string[];
  nextAction: string;
  /** Generated when, so a stale thesis is visible as stale. */
  writtenAt: string;
};

/**
 * Stakeholder by organisation type and route.
 *
 * A guess, and marked as one. It is still worth making: "ask for the general
 * manager" beats "find the decision-maker" by about ten minutes on every call,
 * and being wrong costs one question.
 */
function likelyStakeholder(input: { route: string; eventType: DemandEventType; organisation: string }): string {
  const name = input.organisation.toLowerCase();

  if (input.route === 'SUBCONTRACTING') {
    return 'Operations or regional manager at the prime — whoever is responsible for staffing this territory. ' +
      'Not their sales side, who will route you back to a vendor form.';
  }
  if (/property|realty|management|reit|holdings|trust/.test(name)) {
    return 'The property or facilities manager for this specific site. A portfolio owner will have one per building.';
  }
  if (/clinic|dental|medical|health|urgent/.test(name)) {
    return 'The practice manager. Clinical staff will not have this and will not want it.';
  }
  if (/school|district|college|university/.test(name)) {
    return 'Facilities or business services. Purchasing may be centralised.';
  }
  if (input.route === 'DISTRIBUTION') {
    return 'Whoever orders supplies — usually the owner or general manager at a single site, purchasing at a chain.';
  }
  return 'The owner or general manager. At a single independent site these are the same person.';
}

export function buildThesis(input: {
  organisation: string;
  location: string | null;
  eventType: DemandEventType;
  eventDate: Date | null;
  confirmedFacts: string[];
  playbook: Playbook;
  tier: LeadTier;
  tierReason: string;
  needIsConfirmed: boolean;
  friction: FrictionLevel;
  frictionReason: string;
  fulfilmentStatus: string;
  fulfilmentReason: string;
  buyingWindow: string;
  windowClosesAt: Date | null;
  grossProfit: number | null;
  humanMinutes: number;
  economicsBasis: string;
  paymentRisk: RiskLevel;
  counterpartyRisk: RiskLevel;
  complianceGaps: string[];
  missingInfo: string[];
  nextAction: string;
  now?: Date;
}): Thesis {
  const now = input.now ?? new Date();
  const dateStr = input.eventDate?.toISOString().slice(0, 10) ?? 'an undated event';

  const whyThisCompany =
    `${input.organisation}${input.location ? ` in ${input.location}` : ''} appeared in a source because ` +
    `${humaniseEvent(input.eventType).toLowerCase()} was recorded on ${dateStr} — not because they match a ` +
    `category. ${input.tierReason}`;

  const whyNow = input.windowClosesAt
    ? `${input.playbook.window.reason} On this event that window closes ${input.windowClosesAt.toISOString().slice(0, 10)}.`
    : `${input.playbook.window.reason} No closing date could be calculated for this one.`;

  const likelyNeed = input.needIsConfirmed
    ? `${input.playbook.label}. They asked for this — it is their statement, not our inference.`
    : `${input.playbook.label}. This is our inference from the event, not something they have said. ` +
      `An event of this kind usually creates this work; this particular organisation has not confirmed it.`;

  const economics =
    input.grossProfit === null
      ? `No gross profit can be estimated yet. ${input.economicsBasis}`
      : `Roughly $${input.grossProfit.toLocaleString()} gross profit against ${input.humanMinutes} minutes of ` +
        `human time — about $${Math.round((input.grossProfit / Math.max(1, input.humanMinutes)) * 60).toLocaleString()} ` +
        `per hour of attention. ${input.economicsBasis}`;

  // Everything that could make this wrong, gathered rather than scattered.
  const uncertainties = [
    ...input.playbook.verificationQuestions,
    ...input.missingInfo.map((m) => `Unknown: ${m}.`),
    ...(input.paymentRisk === 'UNKNOWN' ? ['Nothing is known about whether or how this buyer pays.'] : []),
    ...(input.counterpartyRisk === 'UNKNOWN' ? ['The counterparty has not been assessed.'] : []),
    ...(input.complianceGaps.length > 0 ? [`Compliance outstanding: ${input.complianceGaps.join('; ')}.`] : []),
    ...(input.needIsConfirmed ? [] : ['The need itself is inferred. They may already have this handled.']),
  ];

  return {
    whyThisCompany,
    whyNow,
    // Only what the source stated. Our reasoning lives in the other fields.
    externalEvidence: input.confirmedFacts.slice(0, 8),
    likelyNeed,
    needIsConfirmed: input.needIsConfirmed,
    likelyStakeholder: likelyStakeholder({
      route: input.playbook.route,
      eventType: input.eventType,
      organisation: input.organisation,
    }),
    commercialRoute: `${input.playbook.route.toLowerCase()} — ${input.playbook.label.toLowerCase()}.`,
    fulfilmentRequirement: `${input.playbook.requiredCapability}. ${input.fulfilmentReason}`,
    buyingWindow: `${input.buyingWindow.replace(/_/g, ' ').toLowerCase()}. ${whyNow}`,
    friction: input.frictionReason,
    economics,
    uncertainties: [...new Set(uncertainties)].slice(0, 10),
    nextAction: input.nextAction,
    writtenAt: now.toISOString(),
  };
}

/**
 * Which parts of a thesis are missing.
 *
 * Every Tier A and B opportunity is required to carry all of them, so this is
 * the check that makes the requirement enforceable rather than aspirational.
 */
export function thesisGaps(thesis: Thesis | null): string[] {
  if (!thesis) return ['no thesis has been written'];
  const gaps: string[] = [];
  if (!thesis.whyThisCompany) gaps.push('why this company');
  if (!thesis.whyNow) gaps.push('why now');
  if (thesis.externalEvidence.length === 0) gaps.push('external evidence');
  if (!thesis.likelyNeed) gaps.push('likely need');
  if (!thesis.likelyStakeholder) gaps.push('likely stakeholder');
  if (!thesis.commercialRoute) gaps.push('commercial route');
  if (!thesis.fulfilmentRequirement) gaps.push('fulfilment requirement');
  if (!thesis.buyingWindow) gaps.push('buying window');
  if (!thesis.friction) gaps.push('friction');
  if (!thesis.economics) gaps.push('economics');
  if (!thesis.nextAction) gaps.push('next action');
  return gaps;
}
