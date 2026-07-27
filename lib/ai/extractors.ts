import type { FactStatus } from '@prisma/client';

/**
 * Deterministic transcript extractors.
 *
 * Kept pure and separate from database work so they can be unit-tested against
 * raw text. Each extractor returns the literal quote it fired on, which becomes
 * the fact's provenance — a manager can always see the sentence a fact came
 * from and disagree with it.
 */

export type RawExtraction = {
  factKey: string;
  factValue: string;
  valueJson?: Record<string, unknown>;
  status: FactStatus;
  confidence: number;
  sourceQuote: string;
  speaker: string;
};

export type Segment = { speaker: string; startSec: number; endSec: number; text: string };

/**
 * Speaker labels that mean "our side of the call".
 *
 * Matched as whole tokens, never as substrings: "Marcus" contains "us" and
 * "Mel" contains "me", and a substring match would silently discard everything
 * the other party said — which is the only side that produces business facts.
 */
const OUR_SPEAKER_TOKENS = new Set(['caller', 'rep', 'agent', 'me', 'us', 'sales', 'dispatcher']);

function tokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export function isOurSide(speaker: string, callerName?: string): boolean {
  const speakerTokens = tokens(speaker);
  if (speakerTokens.length === 0) return false;

  if (callerName) {
    const callerTokens = new Set(tokens(callerName));
    // A shared name token (first or last) identifies our caller.
    if (speakerTokens.some((token) => callerTokens.has(token))) return true;
  }
  return speakerTokens.some((token) => OUR_SPEAKER_TOKENS.has(token));
}

const MONEY = /\$\s?([\d,]+(?:\.\d{1,2})?)\s*(k|thousand|m|million)?/gi;
const QUANTITY = /\b([\d,]+(?:\.\d+)?)\s*(tons?|tonnes?|cases?|pallets?|units?|each|cubic yards?|yards?|loads?|truckloads?|gallons?|sq\.?\s?ft\.?|square feet)\b/gi;
const CREWS = /\b(\w+|\d+)\s+(?:full\s+)?(crews?|teams?|technicians?|trucks?)\b/gi;
const PERCENT = /\b(\d{1,3}(?:\.\d+)?)\s?%/g;
// Allows the filler people actually use: "license number is OH-EL-44821",
// "our licence #: OH-EL-44821", "lic no. OH-EL-44821".
const LICENSE = /\b(?:licen[sc]e|lic\.?)\s*(?:number|no\.?|#)?\s*(?:is|are|:|#)?\s*([A-Za-z]{2}-?[A-Za-z]{0,3}-?\d{3,8})\b/gi;
const DATE_ISO = /\b(20\d{2})-(\d{2})-(\d{2})\b/g;
const MONTH_DAY = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi;
const RELATIVE_DATE = /\b(next|this)\s+(week|month|monday|tuesday|wednesday|thursday|friday)\b/gi;
const PHONE = /\b(?:\+?1[-.\s]?)?\(?([2-9]\d{2})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})\b/g;

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1, an: 1,
};


const COVERAGE_TERMS: Array<[string, RegExp]> = [
  ['general_liability', /general liability|\bgl\b/gi],
  ['workers_comp', /workers'? ?comp(?:ensation)?/gi],
  ['auto_liability', /auto(?:mobile)? liability|auto coverage/gi],
  ['umbrella', /umbrella|excess liability/gi],
  ['unspecified', /liability|coverage|insur(?:ance|ed)/gi],
];

/**
 * Picks the coverage type nearest to a stated amount.
 *
 * Nearest, not first-match: "$2,000,000 general liability and $1,000,000
 * workers comp" states two limits in one sentence, and scanning in a fixed
 * order would file both under whichever term happens to appear earlier.
 */
function nearestCoverage(text: string, amountIndex: number, amountLength: number): string | null {
  const amountEnd = amountIndex + amountLength;
  let best: { type: string; distance: number } | null = null;

  for (const [type, pattern] of COVERAGE_TERMS) {
    for (const match of text.matchAll(pattern)) {
      const termIndex = match.index ?? 0;
      // A coverage term after the amount ("$2M general liability") binds more
      // tightly than one before it, so weight backward distance higher.
      const distance = termIndex >= amountEnd ? termIndex - amountEnd : (amountIndex - (termIndex + match[0].length)) * 2;
      if (distance > 90) continue;
      if (!best || distance < best.distance) best = { type, distance };
    }
  }
  return best?.type ?? null;
}

function parseMoney(raw: string, suffix?: string): number {
  const base = Number(raw.replace(/,/g, ''));
  if (!suffix) return base;
  const s = suffix.toLowerCase();
  if (s === 'k' || s === 'thousand') return base * 1000;
  if (s === 'm' || s === 'million') return base * 1_000_000;
  return base;
}

/** Phrase banks. Explicit and reviewable rather than a hidden model. */
const DISSATISFACTION = [
  'not happy', 'unhappy', 'frustrated', 'fed up', 'let us down', 'let me down', 'dropped the ball',
  'missed', 'no-show', 'no show', 'never showed', 'stopped showing', 'poor quality', 'sloppy',
  'complaints', 'complained', 'issues with', 'problems with', 'unreliable', 'inconsistent',
  'slow to respond', 'never call back', 'took too long', 'price increase', 'raised our prices',
  'stockout', 'out of stock', 'back-ordered', 'backordered', 'short shipped',
];

const SWITCHING_WILLINGNESS = [
  'open to', 'would consider', 'willing to try', 'happy to look at', 'send me', 'send us',
  'get us a quote', 'we would look at', 'shopping around', 'looking at alternatives',
  'due for renewal', 'contract is up', 'not locked in', 'month to month',
];

const LOCKED_IN = [
  'under contract', 'locked in', 'exclusive', 'we are committed', 'long-term agreement',
  'my brother-in-law', 'been with them for years', 'not looking to change', 'happy with',
];

const URGENCY = [
  'asap', 'as soon as possible', 'urgent', 'urgently', 'immediately', 'right away', 'this week',
  'yesterday', 'emergency', 'behind schedule', 'shut down', 'can\'t wait',
];

const OBJECTION_PATTERNS: Array<{ category: string; phrases: string[] }> = [
  { category: 'price', phrases: ['too expensive', 'too high', 'price is', 'cheaper', 'better price', 'budget won\'t'] },
  { category: 'incumbent_loyalty', phrases: ['we already have', 'happy with our current', 'been with them'] },
  { category: 'timing', phrases: ['not right now', 'call me back in', 'maybe next quarter', 'bad timing'] },
  { category: 'authority', phrases: ['i don\'t make that decision', 'need to check with', 'that\'s not my call'] },
  { category: 'trust', phrases: ['never heard of you', 'who are you with', 'send me something in writing first'] },
  { category: 'capacity_doubt', phrases: ['can you actually handle', 'are you big enough', 'do you have the crews'] },
];

const COMMITMENT_VERBS =
  'send|get|call|email|have|put together|check|confirm|follow up|review|look at|look into|come back|circulate|price|quote|talk to|run it by|think about';

const COMMITMENT_PATTERNS = [
  new RegExp(String.raw`\bi(?:'| a)?ll (?:${COMMITMENT_VERBS})\b[^.!?]*`, 'gi'),
  new RegExp(String.raw`\bwe(?:'| wi)?ll (?:${COMMITMENT_VERBS}|start|deliver)\b[^.!?]*`, 'gi'),
  /\b(?:i|we) can (start|deliver|have|do) (?:it |that )?(?:by|on|next)\b[^.!?]*/gi,
  /\blet me (send|get|check|confirm|look)\b[^.!?]*/gi,
];

/**
 * Things a caller is not authorised to say. Detecting these is a governance
 * control, not a style note — an unauthorised promise creates real exposure.
 */
const UNAUTHORIZED_PROMISE_PATTERNS: Array<{ pattern: RegExp; issue: string }> = [
  { pattern: /\b(?:i|we) guarantee\b[^.!?]*/gi, issue: 'Gave a guarantee' },
  { pattern: /\b(?:i|we) promise\b[^.!?]*/gi, issue: 'Made a promise' },
  { pattern: /\byou have my word\b[^.!?]*/gi, issue: 'Gave a personal assurance' },
  { pattern: /\bthe price (?:is|will be) (?:locked|fixed|guaranteed)\b[^.!?]*/gi, issue: 'Locked a price' },
  { pattern: /\bwe(?:'| wi)?ll beat (?:any|that|their)\b[^.!?]*/gi, issue: 'Committed to beat a competitor price' },
  { pattern: /\b(?:i|we) can definitely (?:do|have|deliver|start)\b[^.!?]*/gi, issue: 'Committed to delivery without confirmation' },
  { pattern: /\bexclusiv(?:e|ity)\b[^.!?]*/gi, issue: 'Discussed exclusivity' },
  { pattern: /\bno charge\b[^.!?]*/gi, issue: 'Offered work at no charge' },
  { pattern: /\bwe(?:'| wi)?ll waive\b[^.!?]*/gi, issue: 'Waived a fee or term' },
];

const COMPLIANCE_CONCERN_PATTERNS: Array<{ pattern: RegExp; concern: string }> = [
  { pattern: /\btake me off (?:your|the) list\b/i, concern: 'do_not_call_request' },
  { pattern: /\bdo not call\b/i, concern: 'do_not_call_request' },
  { pattern: /\bstop calling\b/i, concern: 'do_not_call_request' },
  { pattern: /\bunsubscribe\b/i, concern: 'do_not_contact_request' },
  { pattern: /\b(?:don't|do not) record\b/i, concern: 'recording_refusal' },
  { pattern: /\bunder investigation\b/i, concern: 'legal_matter' },
  { pattern: /\blawsuit|litigation|attorney\b/i, concern: 'legal_matter' },
  { pattern: /\bnon[- ]compete\b/i, concern: 'contractual_restriction' },
  { pattern: /\bconflict of interest\b/i, concern: 'conflict_of_interest' },
];

function anyPhrase(text: string, phrases: string[]): string | null {
  const lower = text.toLowerCase();
  for (const phrase of phrases) {
    const index = lower.indexOf(phrase);
    if (index >= 0) {
      const start = Math.max(0, index - 40);
      return text.slice(start, Math.min(text.length, index + phrase.length + 60)).trim();
    }
  }
  return null;
}

/** Main entry point: run every extractor over the segmented transcript. */
export function extractFacts(segments: Segment[], callerName?: string): RawExtraction[] {
  const facts: RawExtraction[] = [];
  const push = (f: RawExtraction) => facts.push(f);

  for (const segment of segments) {
    const text = segment.text;
    const theirSide = !isOurSide(segment.speaker, callerName);
    // Only the other party's statements become business facts. Our own words
    // are commitments or errors, never evidence about their business.
    if (!theirSide) continue;

    // --- Money ------------------------------------------------------------
    for (const match of text.matchAll(MONEY)) {
      const amount = parseMoney(match[1], match[2]);
      // Classify from the words immediately around this amount, not the whole
      // sentence: "$2,000,000 general liability and $1,000,000 workers comp"
      // is two different limits stated in one breath.
      const index = match.index ?? 0;
      const context = text
        .slice(Math.max(0, index - 45), Math.min(text.length, index + match[0].length + 45))
        .toLowerCase();
      // Insurance is keyed by coverage type: general liability and workers
      // comp are different limits, and collapsing them into one key makes the
      // second value look like it contradicts the first.
      const insuranceType = nearestCoverage(text, index, match[0].length);

      const key = /per month|monthly|a month/.test(context)
        ? 'pricing.monthly_amount'
        : /minimum/.test(context)
          ? 'capacity.minimum_contract'
          : insuranceType
            ? `capacity.insurance_limit.${insuranceType}`
            : /per ton|per unit|per case|a ton/.test(context)
              ? 'supply.unit_cost'
              : 'pricing.amount';
      push({
        factKey: key,
        factValue: String(amount),
        valueJson: { amount, currency: 'USD', raw: match[0], ...(insuranceType ? { coverage: insuranceType } : {}) },
        status: 'CLAIMED',
        confidence: 0.75,
        sourceQuote: text,
        speaker: segment.speaker,
      });
    }

    // --- Quantities -------------------------------------------------------
    for (const match of text.matchAll(QUANTITY)) {
      push({
        factKey: 'supply.quantity',
        factValue: `${match[1]} ${match[2]}`,
        valueJson: { quantity: Number(match[1].replace(/,/g, '')), unit: match[2].toLowerCase() },
        status: 'CLAIMED',
        confidence: 0.75,
        sourceQuote: text,
        speaker: segment.speaker,
      });
    }

    // --- Crews / capacity -------------------------------------------------
    for (const match of text.matchAll(CREWS)) {
      const raw = match[1].toLowerCase();
      const count = NUMBER_WORDS[raw] ?? Number(raw);
      if (!Number.isFinite(count)) continue;
      push({
        factKey: 'capacity.crew_count',
        factValue: String(count),
        valueJson: { count, unit: match[2].toLowerCase() },
        status: 'CLAIMED',
        confidence: 0.7,
        sourceQuote: text,
        speaker: segment.speaker,
      });
    }

    // --- Percentages ------------------------------------------------------
    for (const match of text.matchAll(PERCENT)) {
      if (/increase|raised|went up/i.test(text)) {
        push({
          factKey: 'need.price_increase_pct',
          factValue: match[1],
          valueJson: { percent: Number(match[1]) },
          status: 'CLAIMED',
          confidence: 0.7,
          sourceQuote: text,
          speaker: segment.speaker,
        });
      }
    }

    // --- Licences ---------------------------------------------------------
    for (const match of text.matchAll(LICENSE)) {
      push({
        factKey: 'capacity.license',
        factValue: match[1],
        valueJson: { number: match[1] },
        // A licence number stated on a call is a claim until verified with the
        // issuing authority. Never CONFIRMED here.
        status: 'CLAIMED',
        confidence: 0.8,
        sourceQuote: text,
        speaker: segment.speaker,
      });
    }

    // --- Dates ------------------------------------------------------------
    for (const match of text.matchAll(DATE_ISO)) {
      push({
        factKey: inferDateKey(text),
        factValue: match[0],
        valueJson: { date: match[0] },
        status: 'CLAIMED',
        confidence: 0.8,
        sourceQuote: text,
        speaker: segment.speaker,
      });
    }
    for (const match of text.matchAll(MONTH_DAY)) {
      push({
        factKey: inferDateKey(text),
        factValue: `${match[1]} ${match[2]}`,
        valueJson: { month: match[1], day: Number(match[2]) },
        status: 'CLAIMED',
        confidence: 0.6,
        sourceQuote: text,
        speaker: segment.speaker,
      });
    }
    for (const match of text.matchAll(RELATIVE_DATE)) {
      push({
        factKey: inferDateKey(text),
        factValue: match[0],
        valueJson: { relative: match[0] },
        // Relative dates need pinning down; flag as estimated.
        status: 'ESTIMATED',
        confidence: 0.45,
        sourceQuote: text,
        speaker: segment.speaker,
      });
    }

    // --- Phone numbers ----------------------------------------------------
    for (const match of text.matchAll(PHONE)) {
      push({
        factKey: 'contact.phone',
        factValue: `${match[1]}${match[2]}${match[3]}`,
        status: 'CLAIMED',
        confidence: 0.7,
        sourceQuote: text,
        speaker: segment.speaker,
      });
    }

    // --- Frequency --------------------------------------------------------
    if (/\b(every week|weekly|every month|monthly|quarterly|recurring|ongoing|standing order)\b/i.test(text)) {
      push({
        factKey: 'need.frequency',
        factValue: 'recurring',
        valueJson: { raw: /\b(every week|weekly|every month|monthly|quarterly|recurring|ongoing|standing order)\b/i.exec(text)?.[0] },
        status: 'CLAIMED',
        confidence: 0.8,
        sourceQuote: text,
        speaker: segment.speaker,
      });
    } else if (/\b(one[- ]time|one off|just this once|single job)\b/i.test(text)) {
      push({ factKey: 'need.frequency', factValue: 'one_time', status: 'CLAIMED', confidence: 0.8, sourceQuote: text, speaker: segment.speaker });
    } else if (/\b(overflow|when we get slammed|when we're busy)\b/i.test(text)) {
      push({ factKey: 'need.frequency', factValue: 'overflow', status: 'CLAIMED', confidence: 0.75, sourceQuote: text, speaker: segment.speaker });
    }

    // --- Incumbent provider ----------------------------------------------
    // The prefix is case-insensitive (sentences start with "We use"), but the
    // captured name stays case-sensitive so it picks up a proper noun rather
    // than the next few ordinary words.
    const providerMatch =
      /(?:\b[Ww]e (?:use|have|work with|buy from)|\b[Cc]urrently (?:with|using)|\b[Oo]ur (?:current )?(?:vendor|supplier|contractor|provider) is)\s+([A-Z][\w&'-]*(?:\s+[A-Z][\w&'-]*){0,3})/.exec(text);
    if (providerMatch) {
      push({
        factKey: 'need.current_provider',
        factValue: providerMatch[1].trim(),
        status: 'CLAIMED',
        confidence: 0.75,
        sourceQuote: text,
        speaker: segment.speaker,
      });
    }

    // --- Sentiment / posture ---------------------------------------------
    const dissatisfaction = anyPhrase(text, DISSATISFACTION);
    if (dissatisfaction) {
      push({
        factKey: 'need.provider_issue',
        factValue: dissatisfaction,
        status: 'CLAIMED',
        confidence: 0.7,
        sourceQuote: text,
        speaker: segment.speaker,
      });
    }
    const willingness = anyPhrase(text, SWITCHING_WILLINGNESS);
    if (willingness) {
      push({ factKey: 'need.switching_willingness', factValue: 'open', status: 'CLAIMED', confidence: 0.7, sourceQuote: willingness, speaker: segment.speaker });
    }
    const locked = anyPhrase(text, LOCKED_IN);
    if (locked) {
      push({ factKey: 'need.switching_willingness', factValue: 'locked', status: 'CLAIMED', confidence: 0.7, sourceQuote: locked, speaker: segment.speaker });
    }
    const urgent = anyPhrase(text, URGENCY);
    if (urgent) {
      push({ factKey: 'need.urgency', factValue: 'high', status: 'CLAIMED', confidence: 0.7, sourceQuote: urgent, speaker: segment.speaker });
    }

    // --- Territory --------------------------------------------------------
    const territory = /\b(?:we (?:cover|serve|service)|our (?:service )?area(?: is)?|we work in)\s+([A-Za-z][\w\s,&-]{3,60})/i.exec(text);
    if (territory) {
      push({
        factKey: 'capacity.territories',
        factValue: territory[1].trim().replace(/[.,]$/, ''),
        status: 'CLAIMED',
        confidence: 0.7,
        sourceQuote: text,
        speaker: segment.speaker,
      });
    }

    // --- Shifts -----------------------------------------------------------
    if (/\b(night shift|nights|after hours|overnight|second shift|third shift)\b/i.test(text)) {
      push({ factKey: 'capacity.shift_availability', factValue: 'night', status: 'CLAIMED', confidence: 0.75, sourceQuote: text, speaker: segment.speaker });
    }
    if (/\b(weekends?|saturday|sunday)\b/i.test(text)) {
      push({ factKey: 'capacity.shift_availability', factValue: 'weekend', status: 'CLAIMED', confidence: 0.7, sourceQuote: text, speaker: segment.speaker });
    }

    // --- Explicit confirmations ------------------------------------------
    if (/\b(yes,? (?:that'?s|that is) (?:right|correct)|confirmed|that'?s correct|correct)\b/i.test(text) && text.length < 120) {
      push({ factKey: 'call.confirmation', factValue: text.trim(), status: 'CONFIRMED', confidence: 0.85, sourceQuote: text, speaker: segment.speaker });
    }
  }

  return facts;
}

function inferDateKey(text: string): string {
  const lower = text.toLowerCase();
  if (/start|begin|kick off|mobiliz/.test(lower)) return 'need.start_date';
  if (/deadline|due|complete by|finish/.test(lower)) return 'need.deadline';
  if (/deliver|delivery|arrive/.test(lower)) return 'supply.delivery_date';
  if (/available|free|open/.test(lower)) return 'capacity.earliest_start';
  return 'call.date_mentioned';
}

export type DetectedCommitment = { madeBy: 'us' | 'them'; text: string; isAuthorized: boolean; issue?: string };

export function extractCommitments(segments: Segment[], callerName?: string): DetectedCommitment[] {
  const commitments: DetectedCommitment[] = [];
  for (const segment of segments) {
    const ours = isOurSide(segment.speaker, callerName);
    for (const pattern of COMMITMENT_PATTERNS) {
      for (const match of segment.text.matchAll(pattern)) {
        commitments.push({ madeBy: ours ? 'us' : 'them', text: match[0].trim(), isAuthorized: true });
      }
    }
    if (!ours) continue;
    for (const { pattern, issue } of UNAUTHORIZED_PROMISE_PATTERNS) {
      for (const match of segment.text.matchAll(pattern)) {
        commitments.push({ madeBy: 'us', text: match[0].trim(), isAuthorized: false, issue });
      }
    }
  }
  // De-duplicate: an unauthorised finding always wins over an authorised one.
  const seen = new Map<string, DetectedCommitment>();
  for (const commitment of commitments) {
    const key = commitment.text.toLowerCase();
    const existing = seen.get(key);
    if (!existing || (existing.isAuthorized && !commitment.isAuthorized)) seen.set(key, commitment);
  }
  return [...seen.values()];
}

export type DetectedObjection = { category: string; text: string };

export function extractObjections(segments: Segment[], callerName?: string): DetectedObjection[] {
  const objections: DetectedObjection[] = [];
  for (const segment of segments) {
    if (isOurSide(segment.speaker, callerName)) continue;
    for (const { category, phrases } of OBJECTION_PATTERNS) {
      const hit = anyPhrase(segment.text, phrases);
      if (hit) objections.push({ category, text: hit });
    }
  }
  return objections;
}

export function extractComplianceConcerns(segments: Segment[]): Array<{ concern: string; text: string }> {
  const concerns: Array<{ concern: string; text: string }> = [];
  for (const segment of segments) {
    for (const { pattern, concern } of COMPLIANCE_CONCERN_PATTERNS) {
      if (pattern.test(segment.text)) concerns.push({ concern, text: segment.text.trim() });
    }
  }
  return concerns;
}

/** Share of speaking time taken by our side. High ratios are a coaching flag. */
export function computeTalkRatio(segments: Segment[], callerName?: string): number {
  let ours = 0;
  let total = 0;
  for (const segment of segments) {
    const duration = Math.max(0, segment.endSec - segment.startSec) || segment.text.split(/\s+/).length / 2.6;
    total += duration;
    if (isOurSide(segment.speaker, callerName)) ours += duration;
  }
  return total > 0 ? Math.round((ours / total) * 100) / 100 : 0;
}

export function summarizeTranscript(segments: Segment[]): string {
  if (segments.length === 0) return 'No conversation recorded.';
  const theirs = segments.filter((s) => !isOurSide(s.speaker));
  const longest = [...theirs].sort((a, b) => b.text.length - a.text.length).slice(0, 3);
  const speakers = [...new Set(segments.map((s) => s.speaker))];
  return (
    `Conversation between ${speakers.join(' and ')} across ${segments.length} turns. ` +
    `Key statements from the other party: ${longest.map((s) => `"${s.text.slice(0, 160)}"`).join(' ')}`
  );
}
