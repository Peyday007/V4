import { prisma } from '@/lib/db';
import type { DealRecord } from './record';
import { costIsUsable } from './provider';

/**
 * The one question the opportunity page has to answer: what now?
 *
 * Everything else on that page is evidence — what the source said, what a
 * person confirmed, what we inferred, what is still unknown. Evidence is what
 * you read when you are deciding whether to believe something. It is not what
 * you read at nine in the morning with forty routes open and an hour to spend.
 *
 * So this walks the chain from a dated demand event to money in the bank,
 * decides which rung is the first one actually broken, and says who has to do
 * what by when for it to stop being broken. A stage that is waiting on a buyer
 * or a provider is *not* broken — the difference between "nobody has done this"
 * and "we are waiting for somebody outside the building" is the difference
 * between a task and a follow-up, and conflating them is how pipelines fill up
 * with work nobody can actually do.
 *
 * Deliberately not a score. A number between nought and one hundred tells you
 * how somebody felt about the deal; the first broken rung tells you where to go.
 */

export type StageKey =
  | 'DATED_DEMAND'
  | 'RESOLVED_CONTACT'
  | 'DISCOVERY'
  | 'REQUIREMENT'
  | 'PROVIDER'
  | 'PROVIDER_COST'
  | 'OFFER'
  | 'COMMITMENTS'
  | 'DELIVERY'
  | 'INVOICE'
  | 'PAYMENT'
  | 'COLLECTED_PROFIT';

export type StageState =
  /** Finished, with the evidence the stage demands. */
  | 'DONE'
  /** Ours to move, and nothing outside the building is in the way. */
  | 'BLOCKED'
  /** Done on our side. A person outside the building has to act next. */
  | 'WAITING_EXTERNAL'
  /** Not reachable yet, because an earlier rung is unfinished. */
  | 'NOT_STARTED';

export type Stage = {
  key: StageKey;
  label: string;
  state: StageState;
  /** Why it is in that state, in words somebody can act on. */
  because: string;
  /** The single next thing. Null only when the stage is finished. */
  nextAction: string | null;
  /** Whose job it is. A task with no owner is a wish. */
  owner: string;
  /** When it stops being useful. Null when nothing external dates it. */
  deadline: Date | null;
  /** What has to be true for this rung to count as finished. */
  completionCondition: string;
  /** What has to exist on the record for that to be believed. */
  evidenceRequired: string;
  /**
   * True when the action needs a person with authority rather than the system:
   * external communication, pricing, binding commitments, money movement.
   */
  needsAuthority: boolean;
};

export type DealPlan = {
  stages: Stage[];
  /** The first rung that is ours to move. Null when everything is done or waiting. */
  firstBroken: Stage | null;
  /** Rungs finished on our side and waiting on somebody outside the building. */
  waitingOn: Stage[];
  /** One sentence for the top of the page. */
  headline: string;
  /** How far along, as rungs finished — a count, never a probability. */
  progress: { done: number; total: number };
};

/** Facts from outside the deal record that the chain's first rungs depend on. */
export type DemandContext = {
  /** A date the source stated. Our own first-seen timestamp does not count. */
  externalDate: Date | null;
  /** When the opportunity stops being worth anything. */
  windowClosesAt: Date | null;
  deadlineAt: Date | null;
  /** A usable number or address for the buyer. */
  hasContactRoute: boolean;
  contactBlocker: string | null;
  /** Somebody has actually spoken to them and written down what was said. */
  discoveryAttempts: number;
  lastAttemptAt: Date | null;
  /** Set when the route is closed for a reason that ends the chain. */
  terminalReason: string | null;
};

const OWNER_SYSTEM = 'the system, automatically';
const OWNER_CALLER = 'a caller';
const OWNER_DEAL = 'whoever runs this deal';
const OWNER_FINANCE = 'finance';

/**
 * Reads the demand-side facts the first rungs stand on.
 *
 * Separate from the deal record because these live on the route, the event and
 * the outreach trail rather than on the deal, and because a plan for a route
 * with no deal at all still has to be able to say what to do next.
 */
export async function loadDemandContext(params: {
  orgId: string;
  routeId: string;
}): Promise<DemandContext | null> {
  const route = await prisma.routeHypothesis.findFirst({
    where: { id: params.routeId, orgId: params.orgId },
    select: {
      status: true,
      statusReason: true,
      windowClosesAt: true,
      event: { select: { eventDate: true, deadlineAt: true, effectiveAt: true } },
      company: {
        select: {
          phone: true,
          contacts: { select: { phone: true, mobile: true, email: true }, take: 25 },
        },
      },
    },
  });
  if (!route) return null;

  const [attempts, last] = await Promise.all([
    prisma.outreachAttempt.count({
      where: {
        orgId: params.orgId,
        routeId: params.routeId,
        // An attempt that reached nobody taught us nothing about what they need.
        disposition: { in: ['NEED_CONFIRMED', 'DECISION_MAKER_IDENTIFIED', 'FOLLOW_UP', 'GATEKEEPER', 'NOT_INTERESTED', 'DO_NOT_CONTACT'] },
      },
    }),
    prisma.outreachAttempt.findFirst({
      where: { orgId: params.orgId, routeId: params.routeId },
      orderBy: { occurredAt: 'desc' },
      select: { occurredAt: true },
    }),
  ]);

  const hasContactRoute = Boolean(
    route.company.phone
    || route.company.contacts.some((c) => c.phone || c.mobile || c.email),
  );

  return {
    // A date the source itself stated, in its own words. `discoveredAt` is our
    // clock and is deliberately not eligible here.
    externalDate: route.event.eventDate ?? route.event.effectiveAt ?? route.event.deadlineAt,
    windowClosesAt: route.windowClosesAt,
    deadlineAt: route.event.deadlineAt,
    hasContactRoute,
    contactBlocker: hasContactRoute ? null : 'No phone number or address for anybody at this organisation.',
    discoveryAttempts: attempts,
    lastAttemptAt: last?.occurredAt ?? null,
    terminalReason: ['EXPIRED', 'REJECTED', 'COLD'].includes(route.status)
      ? (route.statusReason ?? `The route is ${route.status.toLowerCase()}.`)
      : null,
  };
}

/**
 * The chain, decided.
 *
 * Pure on purpose: every input is already loaded, so the rules can be tested
 * against any shape of deal without a database, and the same function decides
 * what the page shows and what the tests assert.
 */
export function buildDealPlan(input: { record: DealRecord; demand: DemandContext }): DealPlan {
  const { record, demand } = input;
  const stages: Stage[] = [];

  const deal = record.deal.record;
  const money = record.deal.money;
  const quote = record.quotes.live;

  // --- 1. a dated demand event -------------------------------------------
  stages.push({
    key: 'DATED_DEMAND',
    label: 'A dated demand event',
    state: demand.externalDate ? 'DONE' : 'BLOCKED',
    because: demand.externalDate
      ? 'The source stated a date, so this is an event rather than a listing we happened to read.'
      : 'The source never stated a date. Without one there is no reason to believe anything is happening now.',
    nextAction: demand.externalDate ? null : 'Re-check the source record for a stated date, or drop the route.',
    owner: OWNER_SYSTEM,
    deadline: demand.deadlineAt ?? demand.windowClosesAt,
    completionCondition: 'The event carries a date the source itself stated.',
    evidenceRequired: 'The source record, with its own date field.',
    needsAuthority: false,
  });

  // --- 2. a way to reach them --------------------------------------------
  stages.push({
    key: 'RESOLVED_CONTACT',
    label: 'A way to reach them',
    state: demand.hasContactRoute ? 'DONE' : 'BLOCKED',
    because: demand.hasContactRoute
      ? 'There is at least one number or address on the account.'
      : (demand.contactBlocker ?? 'No contact route.'),
    nextAction: demand.hasContactRoute
      ? null
      : 'Run contact resolution, or add a number by hand with its source.',
    owner: OWNER_SYSTEM,
    deadline: null,
    completionCondition: 'A phone number or email address exists against this organisation.',
    evidenceRequired: 'A provenance row naming where the number came from.',
    needsAuthority: false,
  });

  // --- 3. somebody has actually spoken to them ---------------------------
  stages.push({
    key: 'DISCOVERY',
    label: 'A conversation with somebody there',
    state: demand.discoveryAttempts > 0 ? 'DONE' : 'BLOCKED',
    because: demand.discoveryAttempts > 0
      ? `${demand.discoveryAttempts} conversation${demand.discoveryAttempts === 1 ? '' : 's'} recorded against this route.`
      : demand.lastAttemptAt
        ? 'It has been called, but nobody has been reached who said anything about what they need.'
        : 'Nobody has called yet.',
    nextAction: demand.discoveryAttempts > 0 ? null : 'Put this in a caller packet and have the conversation.',
    owner: OWNER_CALLER,
    deadline: demand.deadlineAt ?? demand.windowClosesAt,
    completionCondition: 'An outreach attempt exists whose outcome carries what they said.',
    evidenceRequired: 'The saved call outcome, with its discovery fields.',
    needsAuthority: false,
  });

  // --- 4. a requirement they confirmed -----------------------------------
  const req = record.requirement;
  stages.push({
    key: 'REQUIREMENT',
    label: 'A requirement they confirmed',
    state: req.ready ? 'DONE' : 'BLOCKED',
    because: req.ready
      ? 'Enough is known, from them rather than from us, to put a price against it.'
      : req.missing.length > 0
        ? req.missing.join(' ')
        : 'No buyer requirement recorded.',
    nextAction: req.ready
      ? null
      : req.current
        ? `Close the gaps on the next call: ${req.missing.slice(0, 3).join(' ')}`
        : 'Record what they asked for, from a call rather than from the source.',
    owner: OWNER_CALLER,
    deadline: demand.deadlineAt ?? demand.windowClosesAt,
    completionCondition: 'A requirement version exists with scope, quantity, timing and who decides.',
    evidenceRequired: 'Fields marked as stated by them, not inferred by us.',
    needsAuthority: false,
  });

  // --- 5. somebody who would do the work ---------------------------------
  const supply = record.supply;
  const hasCandidate = supply.candidateCount > 0;
  const verified = supply.best !== null
    && ['VERIFIED', 'QUOTED', 'AVAILABILITY_CONFIRMED', 'COMMITTED'].includes(supply.best);
  stages.push({
    key: 'PROVIDER',
    label: 'A provider who would actually do it',
    state: verified ? 'DONE' : hasCandidate ? 'BLOCKED' : 'BLOCKED',
    because: verified
      ? supply.headline
      : hasCandidate
        ? `${supply.candidateCount} candidate${supply.candidateCount === 1 ? '' : 's'}, none verified. A candidate is a name, not fulfilment.`
        : 'Nobody has been identified who could do this work.',
    nextAction: verified
      ? null
      : hasCandidate
        ? 'Call the candidate and verify they cover this capability and area.'
        : 'Source providers for this capability and area.',
    owner: hasCandidate ? OWNER_DEAL : OWNER_SYSTEM,
    deadline: demand.windowClosesAt,
    completionCondition: 'At least one candidate has been verified as able to do this work.',
    evidenceRequired: 'A note of who confirmed it and when.',
    needsAuthority: false,
  });

  // --- 6. a cost we can stand behind -------------------------------------
  const usableCost = supply.candidates.some((c) => costIsUsable(c));
  stages.push({
    key: 'PROVIDER_COST',
    label: 'A cost from the provider',
    state: usableCost ? 'DONE' : 'BLOCKED',
    because: usableCost
      ? 'A provider has given a cost that has not expired.'
      : supply.staleCostIds.length > 0
        ? 'The cost we hold has expired. Pricing against it would be pricing against a number nobody stands behind.'
        : 'No provider has given a cost.',
    nextAction: usableCost ? null : 'Ask the provider for a cost, with a date it is good until.',
    owner: OWNER_DEAL,
    deadline: demand.windowClosesAt,
    completionCondition: 'A candidate holds a cost that has not passed its expiry.',
    evidenceRequired: 'The cost, its currency, and the date it expires.',
    needsAuthority: false,
  });

  // --- 7. something in front of the buyer --------------------------------
  const quoteSent = quote !== null && ['SENT', 'ACCEPTED', 'DECLINED', 'SUPERSEDED', 'EXPIRED'].includes(quote.state);
  const quoteAnswered = quote !== null && ['ACCEPTED', 'DECLINED'].includes(quote.state);
  const roomAnswered = record.room.exists && ['RESPONDED', 'DECLINED'].includes(record.room.state ?? '');
  const offerOut = quoteSent || record.room.state === 'SENT' || record.room.state === 'OPENED';
  stages.push({
    key: 'OFFER',
    label: 'A price or a first step in front of them',
    state: quoteAnswered || roomAnswered
      ? 'DONE'
      : offerOut
        ? 'WAITING_EXTERNAL'
        : 'BLOCKED',
    because: quoteAnswered
      ? `They answered the quote: ${quote?.state.toLowerCase()}.`
      : roomAnswered
        ? `They answered the deal room: ${(record.room.state ?? '').toLowerCase()}.`
        : offerOut
          ? 'Sent. Nothing more can happen here until they reply.'
          : record.quotes.blocking.length > 0
            ? 'A quote is drafted and waiting for approval before it can be sent.'
            : quote
              ? 'A quote is drafted but has not been sent.'
              : 'Nothing has been put in front of them.',
    nextAction: quoteAnswered || roomAnswered
      ? null
      : offerOut
        ? 'Chase it if the follow-up date has passed.'
        : record.quotes.blocking.length > 0
          ? 'Approve or reject the quote.'
          : quote
            ? 'Send the quote.'
            : 'Draft a quote, or offer a low-risk first step instead.',
    owner: OWNER_DEAL,
    deadline: quote?.validUntil ?? demand.deadlineAt ?? null,
    completionCondition: 'The buyer has accepted or declined what was put in front of them.',
    evidenceRequired: 'Their reply, recorded against the quote or the room.',
    needsAuthority: true,
  });

  // --- 8. both sides committed -------------------------------------------
  const buyerCommitted = Boolean(deal?.buyerCommittedAt);
  const providerCommitted = Boolean(deal?.providerCommittedAt);
  stages.push({
    key: 'COMMITMENTS',
    label: 'Both sides committed',
    state: buyerCommitted && providerCommitted
      ? 'DONE'
      : buyerCommitted
        ? 'BLOCKED'
        : quoteAnswered && quote?.state === 'ACCEPTED'
          ? 'BLOCKED'
          : 'NOT_STARTED',
    because: buyerCommitted && providerCommitted
      ? `Buyer committed on ${deal?.buyerCommitmentBasis?.toLowerCase().replace(/_/g, ' ')}, provider on ${deal?.providerCommitmentBasis?.toLowerCase().replace(/_/g, ' ')}.`
      : buyerCommitted
        ? 'The buyer has committed and the provider has not. We are exposed on this one.'
        : 'Nobody has committed. An accepted quote is not a commitment.',
    nextAction: buyerCommitted && providerCommitted
      ? null
      : buyerCommitted
        ? 'Get the provider committed, on the strongest basis they will give.'
        : 'Record the buyer commitment, with what it rests on.',
    owner: OWNER_DEAL,
    deadline: null,
    completionCondition: 'Both commitments recorded, each with a basis and evidence.',
    evidenceRequired: 'The email, purchase order or signed document behind each.',
    needsAuthority: true,
  });

  // --- 9. the work done ---------------------------------------------------
  const delivered = Boolean(deal?.deliveryCompletedAt);
  const inDelivery = Boolean(deal?.deliveryStartedAt) && !delivered;
  stages.push({
    key: 'DELIVERY',
    label: 'The work done',
    state: delivered
      ? 'DONE'
      : inDelivery
        ? 'WAITING_EXTERNAL'
        : buyerCommitted && providerCommitted
          ? 'BLOCKED'
          : 'NOT_STARTED',
    because: delivered
      ? 'Delivery completed and recorded.'
      : inDelivery
        ? 'The provider is doing the work. Nothing to do here until they finish.'
        : 'Not started.',
    nextAction: delivered ? null : inDelivery ? 'Confirm completion with the buyer when the provider reports done.' : 'Start delivery.',
    owner: OWNER_DEAL,
    deadline: deal?.milestones?.find((m) => !m.completedAt)?.dueAt ?? null,
    completionCondition: 'Delivery is marked complete with evidence the buyer accepts.',
    evidenceRequired: 'Completion evidence — a sign-off, a photo set, a report.',
    needsAuthority: false,
  });

  // --- 10. invoiced -------------------------------------------------------
  const invoiced = (money?.invoiced ?? 0) > 0;
  stages.push({
    key: 'INVOICE',
    label: 'Invoiced',
    state: invoiced ? 'DONE' : delivered ? 'BLOCKED' : 'NOT_STARTED',
    because: invoiced
      ? `${money?.invoiced.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} billed.`
      : delivered
        ? 'The work is done and nothing has been billed for it.'
        : 'Nothing to bill yet.',
    nextAction: invoiced ? null : delivered ? 'Raise the invoice.' : null,
    owner: OWNER_FINANCE,
    deadline: null,
    completionCondition: 'An inbound invoice line exists against the deal.',
    evidenceRequired: 'The invoice reference.',
    needsAuthority: true,
  });

  // --- 11. paid -----------------------------------------------------------
  const outstanding = money?.outstanding ?? 0;
  const collected = money?.collected ?? 0;
  stages.push({
    key: 'PAYMENT',
    label: 'Paid',
    state: invoiced && outstanding <= 0 && collected > 0
      ? 'DONE'
      : invoiced
        ? 'WAITING_EXTERNAL'
        : 'NOT_STARTED',
    because: !invoiced
      ? 'Nothing has been billed.'
      : outstanding > 0
        ? `${outstanding.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} outstanding.`
        : 'Settled.',
    nextAction: !invoiced ? null : outstanding > 0 ? 'Chase payment, and record it against the invoice when it lands.' : null,
    owner: OWNER_FINANCE,
    deadline: deal?.payments?.find((p) => p.direction === 'INBOUND' && !p.settledAt)?.dueAt ?? null,
    completionCondition: 'Every inbound line is settled.',
    evidenceRequired: 'The payment reference and the date it settled.',
    needsAuthority: true,
  });

  // --- 12. money we actually kept ----------------------------------------
  const gp = money?.collectedGrossProfit ?? 0;
  stages.push({
    key: 'COLLECTED_PROFIT',
    label: 'Gross profit collected',
    state: money?.fullySettled && gp !== 0 ? 'DONE' : invoiced ? 'BLOCKED' : 'NOT_STARTED',
    because: money?.fullySettled
      ? `${gp.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} collected minus paid out.`
      : 'Not every line has settled, so there is no collected figure yet — only claims.',
    nextAction: money?.fullySettled ? null : invoiced ? 'Settle the outbound side once the provider invoices us.' : null,
    owner: OWNER_FINANCE,
    deadline: null,
    completionCondition: 'Inbound and outbound both settled, nothing disputed.',
    evidenceRequired: 'Both payment references.',
    needsAuthority: true,
  });

  // -------------------------------------------------------------------------
  // A route that has been closed ends the chain wherever it stands. Continuing
  // to demand the next action on a dead route generates work nobody should do.
  if (demand.terminalReason) {
    for (const stage of stages) {
      if (stage.state === 'BLOCKED' || stage.state === 'NOT_STARTED') {
        stage.state = 'NOT_STARTED';
        stage.nextAction = null;
        stage.because = demand.terminalReason;
      }
    }
  }

  const firstBroken = stages.find((s) => s.state === 'BLOCKED') ?? null;
  const waitingOn = stages.filter((s) => s.state === 'WAITING_EXTERNAL');
  const done = stages.filter((s) => s.state === 'DONE').length;

  const headline = demand.terminalReason
    ? demand.terminalReason
    : firstBroken
      ? `${firstBroken.label}: ${firstBroken.nextAction ?? 'blocked.'}`
      : waitingOn.length > 0
        ? `Waiting on somebody outside the building — ${waitingOn.map((s) => s.label.toLowerCase()).join(', ')}.`
        : done === stages.length
          ? 'Finished. The money is in and the margin is real.'
          : 'Nothing to do on this one right now.';

  return { stages, firstBroken, waitingOn, headline, progress: { done, total: stages.length } };
}

/** The plan for one route, loaded and decided. */
export async function loadDealPlan(params: {
  orgId: string;
  routeId: string;
  record: DealRecord;
}): Promise<DealPlan | null> {
  const demand = await loadDemandContext({ orgId: params.orgId, routeId: params.routeId });
  if (!demand) return null;
  return buildDealPlan({ record: params.record, demand });
}
