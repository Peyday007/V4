/**
 * The magnifying glass: every term on a screen, explained against this record.
 *
 * The owner's request was blunt — a control that takes any word on the page and
 * says what it means for somebody who has not worked in procurement. The
 * obvious implementation is a glossary, and a glossary is what fails: "Strong
 * trigger: an event that usually creates a need" is a dictionary entry, and the
 * operator's actual question is "why is *this* one a strong trigger and what do
 * I do about it".
 *
 * So every explanation takes the record's own value and answers six things:
 * what it means, why it matters, how it was worked out, whether it is fact or
 * inference, what to do with it, and what would improve it. Two records showing
 * the same badge get different explanations when the reasons differ.
 *
 * The fact-or-inference line is the one that earns this. A tier, a friction
 * level and a margin all look equally official on screen, and they are not the
 * same kind of thing at all: one is read off a source, one is computed from
 * what is known, one is a guess with a decimal point.
 */

export type Explanation = {
  /** The term as it appears on screen. */
  term: string;
  /** The value this record has. */
  value: string;
  meaning: string;
  whyItMatters: string;
  howItWasWorkedOut: string;
  /** The distinction the screen cannot make on its own. */
  standing: 'FACT' | 'CALCULATED' | 'INFERENCE' | 'ABSENCE';
  howToUseIt: string;
  /** What would move it, or null when nothing would. */
  whatWouldImproveIt: string | null;
};

type Explainer = (value: string, context: ExplainContext) => Explanation | null;

/**
 * What the explanation may draw on besides the value itself.
 *
 * Deliberately small. An explanation that needed the whole record would be
 * rebuilt at every call site and would drift; these are the few things that
 * genuinely change what a term means for a given deal.
 */
export type ExplainContext = {
  organisation?: string | null;
  eventDate?: Date | null;
  sourceUrl?: string | null;
  providerCount?: number;
  requiredCapability?: string | null;
  needIsConfirmed?: boolean;
};

const TIER: Explainer = (value, ctx) => {
  const who = ctx.organisation ?? 'this organisation';
  switch (value) {
    case 'ACTIVE_DEMAND':
      return {
        term: 'Tier', value: 'Active demand',
        meaning: `${who} has actually asked for something — a published solicitation, an inbound enquiry, or a `
          + 'vendor request. Somebody stated a need in their own words.',
        whyItMatters:
          'This is the only tier where the need is theirs rather than ours. It can be quoted against without a '
          + 'discovery call establishing that a need exists at all.',
        howItWasWorkedOut:
          'The source record is a request type — a solicitation, an enquiry or a vendor request — and it carries '
          + 'a date and a durable link back to where it was published.',
        standing: 'FACT',
        howToUseIt: 'Work it first. A stated need with a deadline is the shortest path to money in the system.',
        whatWouldImproveIt: null,
      };
    case 'STRONG_TRIGGER':
      return {
        term: 'Tier', value: 'Strong trigger',
        meaning:
          `Something happened to ${who} that usually creates a need — an opening, an award, an expansion, a `
          + 'permit. Nobody has asked for anything.',
        whyItMatters:
          'This is a reason to make a call, not a reason to send a quote. The commonest way to lose one of these '
          + 'is to open with "I understand you need…", because they will say they do not and be right.',
        howItWasWorkedOut:
          `A dated event was published${ctx.eventDate ? ` on ${ctx.eventDate.toISOString().slice(0, 10)}` : ''}`
          + ', and a playbook says this kind of event creates this kind of need inside a known window.',
        standing: 'INFERENCE',
        howToUseIt:
          'Call and ask. The playbook questions are written to establish in one conversation whether the need is '
          + 'real, and to end it cheaply when it is not.',
        whatWouldImproveIt:
          'One call. A confirmed requirement moves this from our reading of an event to their stated need.',
      };
    case 'PREDICTED_NEED':
      return {
        term: 'Tier', value: 'Predicted need',
        meaning: `${who} fits a pattern that has produced work before. Nothing has happened and nobody has asked.`,
        whyItMatters:
          'Campaign material rather than a live opportunity. It must not compete for attention with work where '
          + 'something has actually happened.',
        howItWasWorkedOut: 'A firmographic match against a pattern, with no dated event behind it.',
        standing: 'INFERENCE',
        howToUseIt: 'Leave it unless a campaign is deliberately working this pattern.',
        whatWouldImproveIt: 'A dated event involving them would move it to a strong trigger.',
      };
    case 'DIRECTORY_PROSPECT':
      return {
        term: 'Tier', value: 'Directory prospect',
        meaning: `We know ${who} exists and roughly what they do. That is the whole of it.`,
        whyItMatters:
          'Existence is not intent. A directory listing proves a company is real and proves nothing about whether '
          + 'they are buying anything — that confusion is how a gym that had never heard of this business once '
          + 'reached 88 points.',
        howItWasWorkedOut: 'A directory or registry listing was matched. No event, no date, no request.',
        standing: 'ABSENCE',
        howToUseIt: 'Nothing, on its own. It is stored cheaply so that a real event about them can be attached later.',
        whatWouldImproveIt: 'A dated event. Without one this cannot legitimately reach a working tier at all.',
      };
    default:
      return null;
  }
};

const FRICTION: Explainer = (value) => {
  switch (value) {
    case 'LOW':
      return {
        term: 'Friction', value: 'Low',
        meaning: 'The things that usually slow a deal down have been checked and are absent.',
        whyItMatters: 'Low friction is why a smaller deal can be worth more per hour than a larger one.',
        howItWasWorkedOut:
          'Evidence about purchasing authority, procurement formality, incumbency and onboarding was weighed. '
          + 'Each factor is a question somebody answered, not a guess.',
        standing: 'CALCULATED',
        howToUseIt: 'Work it sooner. The same gross profit arrives with fewer hours attached.',
        whatWouldImproveIt: null,
      };
    case 'MODERATE':
    case 'HIGH':
      return {
        term: 'Friction', value: value === 'HIGH' ? 'High' : 'Moderate',
        meaning:
          'Known obstacles stand between this and a signature — formal procurement, an incumbent to displace, '
          + 'vendor onboarding, or purchasing controlled somewhere else.',
        whyItMatters:
          'Friction is hours, and hours are the constrained resource. A high-friction deal has to be worth more '
          + 'to be worth the same.',
        howItWasWorkedOut: 'Specific factors were weighed, each one a question with an answer attached.',
        standing: 'CALCULATED',
        howToUseIt: 'Judge it against the gross profit rather than against other deals. Some are still worth it.',
        whatWouldImproveIt: 'Removing a specific obstacle — getting onto a vendor list, finding the real approver.',
      };
    case 'UNKNOWN_RESEARCH_REQUIRED':
      return {
        term: 'Friction', value: 'Unknown',
        meaning: 'Nobody has established how hard this would be.',
        whyItMatters:
          'The important thing here is what it is *not*: it is not low. Not knowing whether something is easy is '
          + 'not the same as it being easy, and treating the two alike fills a day with work that goes nowhere.',
        howItWasWorkedOut: 'It was not. The factors that decide friction have no answers on this record.',
        standing: 'ABSENCE',
        howToUseIt: 'Do not queue it as easy work. One call answers most of the factors at once.',
        whatWouldImproveIt: 'Answering the friction questions — who buys, is there an incumbent, is there a process.',
      };
    default:
      return null;
  }
};

const BASIS: Explainer = (value, ctx) => {
  switch (value) {
    case 'PRIOR':
      return {
        term: 'Economics basis', value: 'Prior',
        meaning:
          'The money on this deal is the playbook\'s typical range for this kind of work. Nobody has been asked '
          + 'anything.',
        whyItMatters:
          'This is the figure most likely to be repeated out loud as though it were revenue, and there is nothing '
          + 'under it. It is why the money on this page is shown as a sentence rather than a number.',
        howItWasWorkedOut: 'A category range times an assumed margin.',
        standing: 'INFERENCE',
        howToUseIt: 'For deciding whether this is worth an hour. Not for planning, forecasting or promising.',
        whatWouldImproveIt:
          `Ask a provider who can deliver ${ctx.requiredCapability ?? 'this'} for a real price with an expiry on it.`,
      };
    case 'ESTIMATE':
      return {
        term: 'Economics basis', value: 'Estimate',
        meaning: 'One side of the money is real and the other is still assumed.',
        whyItMatters:
          'A real cost minus an assumed price is an assumption with a decimal point on it. The arithmetic being '
          + 'correct does not make the answer meaningful.',
        howItWasWorkedOut: 'One side came from somebody; the other came from the playbook range.',
        standing: 'INFERENCE',
        howToUseIt: 'Treat the margin as unknown until both sides are real.',
        whatWouldImproveIt: 'Whichever side is still assumed.',
      };
    case 'QUOTE':
      return {
        term: 'Economics basis', value: 'Quote',
        meaning: 'A provider quoted a cost and a price was set against it. Both sides are real numbers.',
        whyItMatters: 'This is the first point at which the gross profit means anything.',
        howItWasWorkedOut: 'Provider cost received, buyer price set against it.',
        standing: 'CALCULATED',
        howToUseIt: 'Defensible to quote from. Check the cost has not expired.',
        whatWouldImproveIt: 'A commitment from both sides.',
      };
    case 'COMMITMENT':
    case 'REALISED':
      return {
        term: 'Economics basis', value: value === 'REALISED' ? 'Realised' : 'Commitment',
        meaning: value === 'REALISED'
          ? 'Money that actually moved.'
          : 'Both sides committed at agreed numbers.',
        whyItMatters: 'The only figures in this product that are facts about a bank rather than claims about a deal.',
        howItWasWorkedOut: value === 'REALISED' ? 'Settled payments.' : 'Recorded commitments from both parties.',
        standing: 'FACT',
        howToUseIt: 'Count it.',
        whatWouldImproveIt: null,
      };
    default:
      return null;
  }
};

const FULFILMENT: Explainer = (value, ctx) => {
  const count = ctx.providerCount ?? 0;
  if (value === 'NO_PROVIDER' || count === 0) {
    return {
      term: 'Supply', value: 'Nobody to deliver it',
      meaning: `No provider in the catalogue holds ${ctx.requiredCapability ?? 'the capability this needs'}.`,
      whyItMatters:
        'This is half a deal. However well the buyer conversation goes, it cannot be quoted — and promising '
        + 'before a provider exists is how a business ends up owning work it cannot do.',
      howItWasWorkedOut:
        'Capability, geography, capacity, credentials, pricing and timing were checked separately against every '
        + 'provider on file. This is the capability check failing.',
      standing: 'FACT',
      howToUseIt: 'Do not quote. Source or recruit a provider first, or drop it.',
      whatWouldImproveIt: 'One provider who holds the capability and covers the place.',
    };
  }
  return {
    term: 'Supply', value: `${count} candidate(s)`,
    meaning: `${count} provider(s) could deliver ${ctx.requiredCapability ?? 'this work'}.`,
    whyItMatters:
      'A candidate is somebody who might be able to do it, not somebody who has said they will. The gap between '
      + 'those two is where deals fail after the buyer has already agreed.',
    howItWasWorkedOut: 'Matched on capability and geography against the provider catalogue.',
    standing: 'INFERENCE',
    howToUseIt: 'Get a price with an expiry before quoting the buyer.',
    whatWouldImproveIt: 'A verified capability and a dated cost from at least one of them.',
  };
};

const NEED: Explainer = (value, ctx) => ({
  term: 'The requirement', value: value === 'true' ? 'Confirmed by them' : 'Our reading',
  meaning: value === 'true'
    ? `${ctx.organisation ?? 'They'} stated this need themselves.`
    : `Nobody has confirmed this. It is what we concluded from a published event.`,
  whyItMatters: value === 'true'
    ? 'A stated need can be quoted against. Everything downstream rests on it being theirs rather than ours.'
    : 'Stating our conclusion back to a buyer as their need is the fastest way to lose the call. They will '
      + 'correct it, and they will be right.',
  howItWasWorkedOut: value === 'true'
    ? 'Recorded against a call or an inbound message where they said it.'
    : `Concluded from the source event${ctx.sourceUrl ? ', which is linked on this page' : ''}.`,
  standing: value === 'true' ? 'FACT' : 'INFERENCE',
  howToUseIt: value === 'true'
    ? 'Quote against it. Check the scope has not moved since.'
    : 'Ask. The first call exists to turn this into their words or to end it.',
  whatWouldImproveIt: value === 'true' ? null : 'One conversation in which they describe the requirement.',
});

/**
 * Every term the operator surfaces show, keyed by the field behind them.
 *
 * Keyed by field rather than by displayed label, so renaming a column heading
 * does not silently detach its explanation.
 */
const EXPLAINERS: Record<string, Explainer> = {
  tier: TIER,
  friction: FRICTION,
  economicsBasis: BASIS,
  fulfilmentStatus: FULFILMENT,
  needIsConfirmed: NEED,
};

export function explain(field: string, value: string | boolean | null, context: ExplainContext = {}): Explanation | null {
  const explainer = EXPLAINERS[field];
  if (!explainer) return null;
  if (value === null) return null;
  return explainer(String(value), context);
}

/** Every field that can be explained, for a control that offers them. */
export function explainableFields(): string[] {
  return Object.keys(EXPLAINERS);
}

export const STANDING_LABEL: Record<Explanation['standing'], string> = {
  FACT: 'a fact, from a source or a person',
  CALCULATED: 'calculated from things that were established',
  INFERENCE: 'our inference — nobody has confirmed it',
  ABSENCE: 'not a finding; the absence of one',
};
