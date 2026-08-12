import { describe, expect, it } from 'vitest';
import { recommendProofStep, LADDER, NO_STEP, PROOF_STEP_LABELS } from '@/lib/room/proofSteps';
import { chooseAudience, greeting, isGenericAddress, draftRoomEmail } from '@/lib/room/email';
import { classifyAgent, newToken } from '@/lib/room/rooms';
import { promiseFromCall, scheduleFollowUp, overduePriority } from '@/lib/deal/followup';
import type { Contact, ProofStepKind } from '@prisma/client';
import type { RoomContent } from '@/lib/room/content';

/**
 * The pure rules behind the Deal Room.
 *
 * What is under test here is mostly restraint: that we do not offer a step we
 * could not deliver, do not greet somebody by a placeholder, do not count a
 * mail scanner as a reader, and do not put a deadline on a call where nothing
 * was promised. Each of those is a small thing that, done wrong at volume,
 * reads to a prospect as a machine that has not thought about them.
 */

const NOW = new Date('2026-08-12T12:00:00.000Z');

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'c1', orgId: 'o1', companyId: 'co1',
    firstName: 'Dana', lastName: 'Whitfield', title: 'Facilities Director',
    department: null, buyingRole: null,
    email: 'dana.whitfield@example.com', phone: null, mobile: null,
    preferredChannel: 'phone', bestContactTime: null, timezone: 'America/Chicago',
    contactKind: 'DIRECT_LINE', isDecisionMaker: false,
    purchasingAuthority: null, verificationStatus: 'UNVERIFIED', verifiedAt: null,
    roleTier: 'SYSTEM_INFERENCE', decisionAuthority: 'unknown', influenceLevel: 0.5,
    knownPriorities: [], consentToCall: true, consentToRecord: null, consentToEmail: true,
    consentToSms: false, hasMobile: false, lastInteractionAt: null, nextInteractionAt: null,
    createdAt: NOW, updatedAt: NOW,
    ...overrides,
  } as Contact;
}

const NO_SUPPLY = { secured: false, best: null, liveCount: 0 };
const CANDIDATE_ONLY = { secured: false, best: 'COST_RECEIVED' as const, liveCount: 1 };
const COMMITTED = { secured: true, best: 'COMMITTED' as const, liveCount: 1 };

function baseStep() {
  return {
    route: 'BROKERAGE',
    supply: CANDIDATE_ONLY,
    costUsable: true,
    requirementReady: true,
    hasSpecification: true,
    vendorRequirementsKnown: true,
    quoteAlreadySent: false,
  };
}

// ---------------------------------------------------------------------------

describe('proof steps: never offer what we could not deliver', () => {
  it('withholds every step that needs a committed provider when none has committed', () => {
    const decision = recommendProofStep({ ...baseStep(), supply: CANDIDATE_ONLY, quoteAlreadySent: true });
    const withheldKinds = decision.withheld.map((w) => w.kind);
    for (const kind of ['ONE_TIME_SERVICE', 'SINGLE_LOCATION_PILOT', 'PAID_DIAGNOSTIC'] as ProofStepKind[]) {
      expect(withheldKinds).toContain(kind);
    }
    expect(decision.withheld[0].because).toMatch(/promise we cannot keep/);
  });

  it('offers a delivery step once a provider has actually committed', () => {
    const decision = recommendProofStep({ ...baseStep(), supply: COMMITTED, quoteAlreadySent: true });
    expect(decision.step.kind).toBe('ONE_TIME_SERVICE');
  });

  it('withholds a walkthrough when there is no live provider to attend it', () => {
    const decision = recommendProofStep({
      ...baseStep(), supply: NO_SUPPLY, hasSpecification: false, vendorRequirementsKnown: true,
    });
    expect(decision.withheld.map((w) => w.kind)).toContain('SITE_WALKTHROUGH');
    expect(decision.step.kind).toBe('NONE');
  });

  it('refuses to offer a price with no usable provider cost behind it', () => {
    const decision = recommendProofStep({ ...baseStep(), costUsable: false });
    expect(decision.withheld.map((w) => w.kind)).toContain('PRELIMINARY_QUOTE');
    expect(decision.step.kind).not.toBe('PRELIMINARY_QUOTE');
  });
});

describe('proof steps: ask about the thing actually in doubt', () => {
  it('asks about vendor requirements first, before arranging anything', () => {
    const decision = recommendProofStep({ ...baseStep(), vendorRequirementsKnown: false });
    expect(decision.step.kind).toBe('VENDOR_CAPABILITY_REVIEW');
    expect(decision.reason).toMatch(/vendor requirements/);
  });

  it('sends a sample when the distribution specification is unconfirmed', () => {
    const decision = recommendProofStep({
      ...baseStep(), route: 'DISTRIBUTION', hasSpecification: false, supply: CANDIDATE_ONLY,
    });
    expect(decision.step.kind).toBe('SAMPLE_ORDER');
  });

  it('arranges a walkthrough when a service scope is unconfirmed', () => {
    const decision = recommendProofStep({
      ...baseStep(), route: 'BROKERAGE', hasSpecification: false, supply: CANDIDATE_ONLY,
    });
    expect(decision.step.kind).toBe('SITE_WALKTHROUGH');
  });

  it('offers a price once the scope is known and nothing has been sent', () => {
    expect(recommendProofStep(baseStep()).step.kind).toBe('PRELIMINARY_QUOTE');
  });

  it('offers nothing when the requirement is still partly our assumption', () => {
    const decision = recommendProofStep({ ...baseStep(), requirementReady: false });
    expect(decision.step.kind).toBe('NONE');
    expect(decision.reason).toMatch(/partly our assumption/);
  });

  it('never recommends a step that does not belong to the route, under any input', () => {
    // Swept rather than sampled. A single case only pins the branch it happens
    // to take, so a step wrongly added to a route's list stays invisible as
    // long as something earlier in the ladder keeps winning — which is exactly
    // how the mapping drifts.
    const allowed: Record<string, ProofStepKind[]> = {
      DISTRIBUTION: ['VENDOR_CAPABILITY_REVIEW', 'SAMPLE_ORDER', 'PRELIMINARY_QUOTE', 'SMALL_INITIAL_SHIPMENT', 'NONE'],
      BROKERAGE: [
        'VENDOR_CAPABILITY_REVIEW', 'SITE_WALKTHROUGH', 'PRELIMINARY_QUOTE',
        'ONE_TIME_SERVICE', 'SINGLE_LOCATION_PILOT', 'PAID_DIAGNOSTIC', 'NONE',
      ],
      SUBCONTRACTING: ['VENDOR_CAPABILITY_REVIEW', 'PRELIMINARY_QUOTE', 'LIMITED_SCOPE_SUBCONTRACT', 'NONE'],
      GENERAL: ['VENDOR_CAPABILITY_REVIEW', 'PRELIMINARY_QUOTE', 'NONE'],
    };

    let cases = 0;
    for (const [route, kinds] of Object.entries(allowed)) {
      for (const supply of [NO_SUPPLY, CANDIDATE_ONLY, COMMITTED]) {
        for (const costUsable of [true, false]) {
          for (const requirementReady of [true, false]) {
            for (const hasSpecification of [true, false]) {
              for (const vendorRequirementsKnown of [true, false]) {
                for (const quoteAlreadySent of [true, false]) {
                  const decision = recommendProofStep({
                    route, supply, costUsable, requirementReady,
                    hasSpecification, vendorRequirementsKnown, quoteAlreadySent,
                  });
                  cases += 1;
                  expect(
                    kinds,
                    `${route} produced ${decision.step.kind} for ${JSON.stringify({ costUsable, requirementReady, hasSpecification, vendorRequirementsKnown, quoteAlreadySent, supply: supply.best })}`,
                  ).toContain(decision.step.kind);
                }
              }
            }
          }
        }
      }
    }
    expect(cases).toBe(4 * 3 * 2 * 2 * 2 * 2 * 2);
  });

  it('never offers a step it has just withheld', () => {
    for (const supply of [NO_SUPPLY, CANDIDATE_ONLY, COMMITTED]) {
      for (const costUsable of [true, false]) {
        for (const hasSpecification of [true, false]) {
          const decision = recommendProofStep({
            ...baseStep(), supply, costUsable, hasSpecification,
          });
          expect(decision.withheld.map((w) => w.kind)).not.toContain(decision.step.kind);
        }
      }
    }
  });

  it('names what every step commits them to, and what it settles', () => {
    for (const step of [...Object.values(LADDER), NO_STEP]) {
      expect(step.ask.length).toBeGreaterThan(10);
      expect(step.commitment.length).toBeGreaterThan(5);
      expect(step.tests.length).toBeGreaterThan(10);
    }
  });

  it('has a label for every kind the schema allows', () => {
    const kinds = [...Object.keys(LADDER), 'NONE'];
    for (const kind of kinds) {
      expect(PROOF_STEP_LABELS[kind as ProofStepKind]).toBeTruthy();
    }
  });

  it('uses no hype, urgency or savings claims anywhere on the ladder', () => {
    const banned = /\b(limited time|act now|hurry|guarantee|guaranteed|save \$|savings of|risk[- ]free|exclusive offer|don't miss)\b/i;
    for (const step of [...Object.values(LADDER), NO_STEP]) {
      expect(`${step.ask} ${step.commitment} ${step.tests}`).not.toMatch(banned);
    }
  });
});

// ---------------------------------------------------------------------------

describe('audience: the best address we hold, and never a worse one silently', () => {
  it('prefers a verified decision-maker', () => {
    const choice = chooseAudience([
      contact({ id: 'a', firstName: 'Sam', email: 'sam@example.com' }),
      contact({ id: 'b', firstName: 'Dana', isDecisionMaker: true, verificationStatus: 'VERIFIED_BY_CALL' }),
    ], { allowGenericInbox: false });
    expect(choice?.contact.id).toBe('b');
    expect(choice?.audience).toBe('VERIFIED_DECISION_MAKER');
    expect(choice?.confidence).toBe('verified');
  });

  it('falls back to a named individual, and says the authority is unconfirmed', () => {
    const choice = chooseAudience([contact()], { allowGenericInbox: false });
    expect(choice?.audience).toBe('PUBLISHED_PERSONAL');
    expect(choice?.reason).toMatch(/Not established as the person who decides/);
  });

  it('refuses a generic inbox unless it has been switched on', () => {
    const only = [contact({ firstName: 'Info', email: 'info@example.com' })];
    expect(chooseAudience(only, { allowGenericInbox: false })).toBeNull();
    expect(chooseAudience(only, { allowGenericInbox: true })?.audience).toBe('GENERIC_INBOX');
  });

  it('never sends to an address already known to be bad', () => {
    const choice = chooseAudience(
      [contact({ verificationStatus: 'INVALID' })],
      { allowGenericInbox: true },
    );
    expect(choice).toBeNull();
  });

  it('respects withdrawn email consent', () => {
    expect(chooseAudience([contact({ consentToEmail: false })], { allowGenericInbox: true })).toBeNull();
  });

  it('recognises the inboxes that are rooms rather than people', () => {
    for (const address of ['info@x.com', 'sales@x.com', 'purchasing@x.com', 'accounts@x.com']) {
      expect(isGenericAddress(address)).toBe(true);
    }
    expect(isGenericAddress('dana.whitfield@x.com')).toBe(false);
  });
});

describe('greeting: never "Hi ," and never "Hi Owner,"', () => {
  it('uses the first name when we hold a real one', () => {
    const choice = chooseAudience([contact()], { allowGenericInbox: false })!;
    expect(greeting(choice)).toBe('Hi Dana,');
  });

  it('falls back to a plain opener rather than a placeholder', () => {
    for (const placeholder of ['Owner', 'Manager', 'Contact', 'Facilities', 'N/A', '']) {
      const choice = chooseAudience(
        [contact({ firstName: placeholder, email: 'someone@example.com' })],
        { allowGenericInbox: true },
      );
      // Either no name was usable, or the greeting avoided the placeholder.
      if (choice) expect(greeting(choice)).toBe('Hello,');
    }
  });

  it('takes only the first word of a compound first name', () => {
    const choice = chooseAudience([contact({ firstName: 'Mary Jane' })], { allowGenericInbox: false })!;
    expect(greeting(choice)).toBe('Hi Mary,');
  });
});

describe('the email is grounded, or it is blocked', () => {
  const content = (overrides: Partial<RoomContent> = {}): RoomContent => ({
    organisation: 'Ironside Facilities',
    location: 'Chicago, IL',
    route: 'BROKERAGE',
    headline: 'Janitorial contract expiring',
    why: {
      text: 'Janitorial services contract listed as expiring',
      eventDate: '2026-08-01',
      source: 'a published solicitation',
      sourceUrl: 'https://example.gov/record/1',
    },
    sections: [{
      heading: 'The scope, as we understand it',
      facts: [],
      ours: ['Likely scope: nightly janitorial — our assumption, not something you told us.'],
      questions: ['What is actually in scope, and what is explicitly out?'],
    }],
    price: null,
    proofStep: LADDER.SITE_WALKTHROUGH,
    proofStepReason: 'The scope is not confirmed.',
    withheldSteps: [],
    tooThinToSend: false,
    thinReasons: [],
    builtAt: NOW.toISOString(),
    ...overrides,
  });

  const choice = () => chooseAudience([contact()], { allowGenericInbox: false })!;

  it('opens with the dated record rather than a pleasantry', () => {
    const draft = draftRoomEmail({ content: content(), choice: choice(), url: 'https://x/room/t', senderName: 'Alex' });
    expect(draft.body).toContain('dated 2026-08-01');
    expect(draft.blockers).toEqual([]);
    expect(draft.grounding.some((g) => g.includes('2026-08-01'))).toBe(true);
  });

  it('labels the inference as ours, in the body, the way the room does', () => {
    const draft = draftRoomEmail({ content: content(), choice: choice(), url: 'https://x/room/t', senderName: 'Alex' });
    expect(draft.body).toMatch(/We think that means/);
    expect(draft.body).toMatch(/We may have that wrong/);
  });

  it('blocks the send when there is no dated event to open with', () => {
    const draft = draftRoomEmail({
      content: content({ why: null }), choice: choice(), url: 'https://x/room/t', senderName: 'Alex',
    });
    expect(draft.blockers.length).toBeGreaterThan(0);
    expect(draft.blockers[0]).toMatch(/no dated event/);
  });

  it('blocks the send when the room itself is too thin', () => {
    const draft = draftRoomEmail({
      content: content({ tooThinToSend: true, thinReasons: ['Nothing has been confirmed.'] }),
      choice: choice(), url: 'https://x/room/t', senderName: 'Alex',
    });
    expect(draft.blockers).toContain('Nothing has been confirmed.');
  });

  it('offers an easy way out, in the message itself', () => {
    const draft = draftRoomEmail({ content: content(), choice: choice(), url: 'https://x/room/t', senderName: 'Alex' });
    expect(draft.body).toMatch(/we will stop/i);
  });

  it('contains no hype, urgency or fabricated savings', () => {
    const draft = draftRoomEmail({ content: content(), choice: choice(), url: 'https://x/room/t', senderName: 'Alex' });
    expect(draft.body).not.toMatch(/\b(act now|limited time|guaranteed|save \$|risk[- ]free|exclusive|don't miss|urgent)\b/i);
  });
});

// ---------------------------------------------------------------------------

describe('tokens and agents', () => {
  it('generates a token long enough for the database to accept', () => {
    for (let i = 0; i < 20; i += 1) {
      expect(newToken().length).toBeGreaterThanOrEqual(32);
    }
  });

  it('generates a different token every time', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => newToken()));
    expect(tokens.size).toBe(200);
  });

  it('tells a mail scanner from a person', () => {
    expect(classifyAgent('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/128 Safari/537.36')).toBe('human');
    expect(classifyAgent('Slackbot-LinkExpanding 1.0')).toBe('automated');
    expect(classifyAgent('curl/8.4.0')).toBe('automated');
    expect(classifyAgent('python-requests/2.31.0')).toBe('automated');
    expect(classifyAgent('Mozilla/5.0 HeadlessChrome/128')).toBe('automated');
    expect(classifyAgent(null)).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------

describe('follow-up: the clock comes from what was promised', () => {
  it('promises nothing when nothing was said', () => {
    for (const disposition of ['NO_ANSWER', 'WRONG_NUMBER', 'DO_NOT_CONTACT', 'LEFT_VOICEMAIL'] as const) {
      expect(promiseFromCall({ disposition })).toBe('NONE');
    }
    const followUp = scheduleFollowUp({ kind: 'NONE', now: NOW });
    expect(followUp.dueAt).toBeNull();
    expect(followUp.isPromise).toBe(false);
    expect(followUp.priority).toBe(0);
  });

  it('reads the caller\'s own words ahead of the disposition category', () => {
    expect(promiseFromCall({ disposition: 'FOLLOW_UP', nextStep: 'Send them a price on Friday' })).toBe('SEND_PRICE');
    expect(promiseFromCall({ disposition: 'FOLLOW_UP', nextStep: 'Arrange a walkthrough' })).toBe('ARRANGE_VISIT');
    expect(promiseFromCall({ disposition: 'FOLLOW_UP' })).toBe('CALL_BACK');
  });

  it('gives a promised price a tighter deadline than a decision chase', () => {
    const price = scheduleFollowUp({ kind: 'SEND_PRICE', now: NOW });
    const chase = scheduleFollowUp({ kind: 'CHASE_DECISION', now: NOW });
    expect(price.dueAt!.getTime()).toBeLessThan(chase.dueAt!.getTime());
    expect(price.priority).toBeGreaterThan(chase.priority);
  });

  it('never overrides a date the prospect actually asked for', () => {
    const theirDate = new Date('2026-11-01T09:00:00.000Z');
    const followUp = scheduleFollowUp({ kind: 'SEND_PRICE', now: NOW, promisedFor: theirDate });
    expect(followUp.dueAt).toEqual(theirDate);
    expect(followUp.because).toMatch(/not ours to move/);
  });

  it('pulls a promise forward when their window closes before the default', () => {
    const closes = new Date(NOW.getTime() + 10 * 3_600_000);
    const followUp = scheduleFollowUp({ kind: 'SEND_PRICE', now: NOW, windowClosesAt: closes });
    expect(followUp.dueAt!.getTime()).toBeLessThan(NOW.getTime() + 24 * 3_600_000);
    expect(followUp.because).toMatch(/window closes/);
  });

  it('leaves the deadline alone when the window closes long after it', () => {
    const closes = new Date(NOW.getTime() + 90 * 86_400_000);
    const followUp = scheduleFollowUp({ kind: 'SEND_PRICE', now: NOW, windowClosesAt: closes });
    expect(followUp.dueAt!.getTime()).toBe(NOW.getTime() + 24 * 3_600_000);
  });

  it('ranks an overdue promise above fresh work, and keeps climbing', () => {
    const followUp = scheduleFollowUp({ kind: 'CALL_BACK', now: NOW });
    const onTime = overduePriority(followUp, NOW);
    const dayLate = overduePriority(followUp, new Date(NOW.getTime() + 72 * 3_600_000));
    const weekLate = overduePriority(followUp, new Date(NOW.getTime() + 216 * 3_600_000));
    expect(dayLate).toBeGreaterThan(onTime);
    expect(weekLate).toBeGreaterThan(dayLate);
    // A promise nobody kept must be able to outrank anything merely urgent.
    expect(weekLate).toBeGreaterThan(100);
  });
});
