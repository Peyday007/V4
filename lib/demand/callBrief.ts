import type { DemandEventType, FrictionLevel, LeadTier, SignalCategory } from '@prisma/client';
import { humaniseEvent } from './events';
import { playbookByKey } from './playbooks';
import type { Thesis } from './thesis';

/**
 * The call brief.
 *
 * Everything here is assembled from facts already stored on the event and the
 * route. Nothing is generated, inferred fresh, or filled in to make a sentence
 * flow. The constraint that shapes every line: the opening must reference the
 * real event without implying the buyer asked for anything.
 *
 * "I saw your new location was registered recently" is true and checkable.
 * "I understand you're looking for a cleaning provider" is a lie the operator
 * would be caught in on the first reply, and it is the exact lie a script
 * generator writes when it is optimising for a smooth opening.
 *
 * So: the opening states what the source published, then says why we are
 * calling in our own voice. The buyer's position is never asserted.
 */

export type CallBrief = {
  /** Two or three sentences to say when somebody answers. */
  opening: string;
  /** Who to ask for, from the playbook's role guidance. */
  askFor: string;
  /** What must be learned on this call. The point of dialling. */
  discoveryObjective: string[];
  /** Which route and the specific need being explored. */
  offerDirection: string;
  /** Facts the source published. Safe to state as fact. */
  sourcedFacts: string[];
  /** Our conclusions. Must never be stated as the buyer's position. */
  ourInferences: string[];
  /** The one thing most likely to make this call pointless. */
  keyUncertainty: string;
  /** Said out loud only if it comes up. */
  supplyCaveat: string | null;
  /** Things the script must not claim, kept visible to the operator. */
  doNotClaim: string[];
};

/**
 * What we are offering, in the words a caller would use.
 *
 * Three of these named cleaning explicitly, which was fine when cleaning was
 * the only trade the engine could route. It is not any more: a campaign can
 * target any capability, and a brokerage call about window cleaning that opens
 * with "arranging a cleaning crew" is close enough, while one about security
 * guarding is simply wrong. The offer now names the route and the capability
 * is filled in by the caller's card, which knows it.
 */
const ROUTE_OFFER: Record<SignalCategory, string> = {
  BROKERAGE: 'arranging a crew for the work',
  DISTRIBUTION: 'supplying the consumables',
  SUBCONTRACTING: 'providing local crew capacity under their contract',
  DIRECT_SERVICE: 'doing the work ourselves',
  SUPPLIER_DEVELOPMENT: 'helping them take on work they cannot cover today',
  PROVIDER_RECRUITMENT: 'putting work their way when we have it',
  GENERAL: 'facility services',
};

/**
 * The opening line for each event type.
 *
 * Phrased as an observation about a public record, because that is what it is.
 * Each one has to survive the buyer replying "how do you know that?" — the
 * answer is always "it was published, here is where".
 */
function observationFor(type: DemandEventType, eventDate: Date | null, hasDeadline: boolean): string {
  const when = eventDate ? nearDate(eventDate) : 'recently';

  switch (type) {
    case 'OCCUPANCY_OR_OPERATING_APPROVAL':
      return `I saw your business licence came through ${when}`;
    case 'NEW_LOCATION':
      return `I saw a new location registered ${when}`;
    case 'FACILITY_OPENING':
      return `I saw you have an opening coming up ${when}`;
    case 'NEW_LEASE':
      return `I saw a new lease recorded ${when}`;
    case 'RENOVATION_OR_CONSTRUCTION':
      return `I saw a commercial permit issued ${when}`;
    case 'PROPERTY_TURNOVER':
      return `I saw a turnover recorded on one of your properties ${when}`;
    case 'EXPANSION':
      return `I saw you are expanding ${when}`;
    case 'ACTIVE_RFP':
    case 'ACTIVE_RFQ':
    case 'PROCUREMENT_NOTICE':
      return hasDeadline
        ? `I'm calling about the solicitation you published ${when}`
        : `I saw the notice you published ${when}`;
    case 'VENDOR_REQUEST':
      return `I saw you are taking vendor registrations ${when}`;
    case 'SUBCONTRACTOR_REQUEST':
      return `I saw you are looking for local crews ${when}`;
    case 'CONTRACT_AWARD':
      return `I saw you picked up the contract ${when}`;
    case 'CONTRACT_EXPIRATION':
      return `I saw a contract of yours is coming up for renewal ${when}`;
    case 'VENDOR_FAILURE_OR_COMPLAINT':
      return `I saw there had been some trouble with a vendor ${when}`;
    case 'STAFFING_OR_CAPACITY_GAP':
      return `I saw you are short of crews ${when}`;
    case 'INBOUND_REQUEST':
      return `You got in touch ${when}`;
    default:
      return `I saw a record about your business ${when}`;
  }
}

function nearDate(date: Date, now = new Date()): string {
  const days = Math.round((date.getTime() - now.getTime()) / 86_400_000);
  if (days > 45) return `for ${date.toISOString().slice(0, 10)}`;
  if (days > 14) return 'in a few weeks';
  if (days > 1) return `on the ${ordinal(date.getUTCDate())}`;
  if (days >= -1) return 'today';
  if (days > -14) return 'last week';
  if (days > -45) return 'last month';
  return `back in ${date.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })}`;
}

function ordinal(day: number): string {
  const suffix = day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
  return `${day}${suffix}`;
}

export function buildCallBrief(input: {
  organisation: string;
  eventType: DemandEventType;
  eventDate: Date | null;
  deadlineAt: Date | null;
  confirmedFacts: string[];
  playbookKey: string;
  route: SignalCategory;
  requiredCapability: string | null;
  needIsConfirmed: boolean;
  tier: LeadTier;
  friction: FrictionLevel;
  fulfilmentStatus: string;
  thesis: Thesis | null;
  /** What an earlier call established, so the second call is not the first. */
  knownContactName?: string | null;
  previousDisposition?: string | null;
}): CallBrief {
  const playbook = playbookByKey(input.playbookKey);
  const observation = observationFor(input.eventType, input.eventDate, Boolean(input.deadlineAt));
  const offer = ROUTE_OFFER[input.route] ?? ROUTE_OFFER.GENERAL;
  const need = input.requiredCapability?.toLowerCase() ?? 'facility services';

  // The reason for calling, in our voice. The buyer's position is never stated
  // — this says what we do, not what they need.
  const reason = input.needIsConfirmed
    ? `and I wanted to talk about it — we handle ${offer}.`
    : `and I'm calling because we help businesses with ${offer} around that point. ` +
      `I don't know whether it's something you need — that's really what I'm ringing to find out.`;

  const returning =
    input.previousDisposition && input.knownContactName
      ? ` I spoke with ${input.knownContactName} previously.`
      : input.previousDisposition
        ? ' I left a message previously.'
        : '';

  const opening = `${observation}, ${reason}${returning}`;

  // What must be learned. The playbook's own questions, which were written per
  // route rather than generated here.
  const discoveryObjective = playbook?.verificationQuestions.slice(0, 3) ?? [
    'Is this something they handle in-house or buy in?',
    'Who owns this decision?',
    'When would it need to be in place?',
  ];

  const sourcedFacts = input.confirmedFacts.slice(0, 5);
  const ourInferences = input.thesis
    ? [input.thesis.likelyNeed, ...(input.needIsConfirmed ? [] : ['That they need this at all is our conclusion, not theirs.'])]
    : ['That this event creates a need is our conclusion, not theirs.'];

  const keyUncertainty =
    input.thesis?.uncertainties[0] ??
    (playbook?.verificationQuestions[0] ?? 'Whether anybody there is actually buying this.');

  // Said only if the buyer asks how fast we can move. Volunteering it early
  // kills a qualification call that was worth having.
  const supplyCaveat =
    input.fulfilmentStatus !== 'AVAILABLE'
      ? 'We do not have a confirmed provider in this market yet. This call is to qualify the need — do not commit ' +
        'to a start date, a crew or a price.'
      : null;

  return {
    opening,
    askFor: input.thesis?.likelyStakeholder ?? 'The owner or general manager.',
    discoveryObjective,
    offerDirection: `${input.route.toLowerCase()} — ${need}.`,
    sourcedFacts,
    ourInferences,
    keyUncertainty,
    supplyCaveat,
    // Kept on screen rather than in a policy document, because these are the
    // four things a caller under pressure invents.
    doNotClaim: [
      'That they told us they need anything.',
      'That we already have a crew or stock lined up for them.',
      'Any price, rate or discount.',
      'Any deadline the source did not publish.',
    ],
  };
}
