import { describe, expect, it } from 'vitest';
import { transitionFor } from '@/lib/demand/outreach';
import { buildCallBrief } from '@/lib/demand/callBrief';

/**
 * Queue transitions and call guidance.
 *
 * The database-backed half of this workflow — eligibility, ordering, paging,
 * persistence — is verified against real Postgres by `scripts/callerAudit.ts`,
 * because a fixture cannot prove that a do-not-contact record is unreachable
 * through a direct server request. These cover the rules that decide where a
 * record goes and what the operator is told to say.
 */

const NOW = new Date('2026-08-12T10:00:00Z');
const DAY = 86_400_000;

describe('a disposition decides where the record goes next', () => {
  it('schedules a widening retry after a voicemail', () => {
    // A fourth voicemail on the same day as the third is not persistence.
    const first = transitionFor({ disposition: 'LEFT_VOICEMAIL', attempts: 0, now: NOW });
    const third = transitionFor({ disposition: 'LEFT_VOICEMAIL', attempts: 2, now: NOW });
    expect(first.status).toBe('ATTEMPTED');
    expect(first.snoozeUntil!.getTime() - NOW.getTime()).toBe(1 * DAY);
    expect(third.snoozeUntil!.getTime() - NOW.getTime()).toBe(4 * DAY);
  });

  it('stops calling after six attempts rather than looping forever', () => {
    const result = transitionFor({ disposition: 'NO_ANSWER', attempts: 5, now: NOW });
    expect(result.status).toBe('CLOSED_NOT_INTERESTED');
    expect(result.snoozeUntil).toBeNull();
    expect(result.effect).toMatch(/not a rejection/i);
  });

  it('hides a follow-up until the date the operator chose', () => {
    const chosen = new Date(NOW.getTime() + 10 * DAY);
    const result = transitionFor({ disposition: 'FOLLOW_UP', attempts: 1, followUpAt: chosen, now: NOW });
    expect(result.status).toBe('FOLLOW_UP');
    expect(result.snoozeUntil).toEqual(chosen);
    expect(result.effect).toMatch(/hidden from call now/i);
  });

  it('treats reaching a decision-maker as a follow-up, not a close', () => {
    // Getting through is the start of the conversation, not the end of it.
    const result = transitionFor({ disposition: 'REACHED_DECISION_MAKER', attempts: 0, now: NOW });
    expect(result.status).toBe('FOLLOW_UP');
    expect(result.snoozeUntil).not.toBeNull();
  });

  it('takes every terminal outcome out of the queue permanently', () => {
    for (const disposition of ['NOT_INTERESTED', 'BAD_FIT', 'ALREADY_HANDLED', 'DO_NOT_CONTACT'] as const) {
      const result = transitionFor({ disposition, attempts: 0, now: NOW });
      expect(result.snoozeUntil).toBeNull();
      expect(['CLOSED_NOT_INTERESTED', 'CLOSED_BAD_FIT', 'CLOSED_HANDLED', 'DO_NOT_CONTACT']).toContain(result.status);
    }
  });

  it('moves a qualified opportunity out of cold calling', () => {
    const result = transitionFor({ disposition: 'QUALIFIED_OPPORTUNITY', attempts: 2, now: NOW });
    expect(result.status).toBe('QUALIFIED');
    expect(result.effect).toMatch(/out of cold calling/i);
  });

  it('gives a gatekeeper a short retry rather than a week', () => {
    const result = transitionFor({ disposition: 'GATEKEEPER', attempts: 0, now: NOW });
    expect(result.snoozeUntil!.getTime() - NOW.getTime()).toBe(2 * DAY);
  });
});

// ---------------------------------------------------------------------------
// Call guidance
// ---------------------------------------------------------------------------

const BASE = {
  organisation: 'Ironside Strength',
  eventType: 'OCCUPANCY_OR_OPERATING_APPROVAL' as const,
  eventDate: new Date(NOW.getTime() + 21 * DAY),
  deadlineAt: null,
  confirmedFacts: ['Chicago business licences records a licence start date of 2026-09-02'],
  playbookKey: 'cleaning.brokerage.pre_opening',
  route: 'BROKERAGE' as const,
  requiredCapability: 'Post-construction cleaning',
  needIsConfirmed: false,
  tier: 'STRONG_TRIGGER' as const,
  friction: 'LOW' as const,
  fulfilmentStatus: 'AVAILABLE',
  thesis: null,
};

describe('the call brief never puts words in the buyer’s mouth', () => {
  it('references the real event without claiming they asked for anything', () => {
    const brief = buildCallBrief(BASE);
    expect(brief.opening).toMatch(/I saw your business licence came through/i);
    // The whole discipline: we say what we do, and the buyer's position is
    // raised as an open question rather than asserted. "whether it's something
    // you need" is the opposite of a claim; "you need" standing alone is the
    // thing that gets an operator caught out on the first reply.
    expect(brief.opening).toMatch(/I don't know whether it's something you need/i);
    // A regex cannot judge a subordinate clause, so the property tested is the
    // one that matters: if the opening mentions their needing anything, it is
    // hedged in the same sentence.
    if (/you need/i.test(brief.opening)) {
      expect(brief.opening).toMatch(/don't know whether|whether it's/i);
    }
    // The assertive forms have no hedge available and are simply absent.
    expect(brief.opening).not.toMatch(/I understand you|I hear you'?re|since you need|you'?re looking for/i);
  });

  it('says outright that an unconfirmed need is ours', () => {
    const brief = buildCallBrief(BASE);
    expect(brief.ourInferences.join(' ')).toMatch(/our conclusion, not theirs/i);
  });

  it('speaks differently when the buyer actually asked', () => {
    const brief = buildCallBrief({
      ...BASE,
      eventType: 'ACTIVE_RFQ',
      needIsConfirmed: true,
      deadlineAt: new Date(NOW.getTime() + 14 * DAY),
      playbookKey: 'cleaning.brokerage.solicitation',
    });
    expect(brief.opening).toMatch(/I'm calling about the solicitation you published/i);
    expect(brief.opening).not.toMatch(/I don't know whether/i);
  });

  it('lists the four things a caller under pressure invents', () => {
    const brief = buildCallBrief(BASE);
    expect(brief.doNotClaim.join(' ')).toMatch(/told us they need/i);
    expect(brief.doNotClaim.join(' ')).toMatch(/price, rate or discount/i);
    expect(brief.doNotClaim.join(' ')).toMatch(/deadline the source did not publish/i);
  });

  it('warns the caller not to promise delivery when no provider exists', () => {
    const brief = buildCallBrief({ ...BASE, fulfilmentStatus: 'UNAVAILABLE' });
    expect(brief.supplyCaveat).toMatch(/do not commit/i);
    expect(brief.supplyCaveat).toMatch(/qualify the need/i);
  });

  it('says nothing about supply when a provider is lined up', () => {
    expect(buildCallBrief(BASE).supplyCaveat).toBeNull();
  });

  it('uses the playbook’s own questions as the discovery objective', () => {
    const brief = buildCallBrief(BASE);
    expect(brief.discoveryObjective.length).toBeGreaterThan(0);
    expect(brief.discoveryObjective.join(' ')).toMatch(/opening date|cleaning contractor|franchisor/i);
  });

  it('acknowledges a previous conversation rather than opening cold again', () => {
    const brief = buildCallBrief({ ...BASE, knownContactName: 'Dana', previousDisposition: 'GATEKEEPER' });
    expect(brief.opening).toMatch(/I spoke with Dana previously/i);
  });

  it('names the route and the specific need, not a generic pitch', () => {
    expect(buildCallBrief(BASE).offerDirection).toBe('brokerage — post-construction cleaning.');
    expect(buildCallBrief({ ...BASE, route: 'DISTRIBUTION', requiredCapability: 'Janitorial consumables' }).offerDirection)
      .toBe('distribution — janitorial consumables.');
  });

  it('does not invent a date when the source published none', () => {
    const brief = buildCallBrief({ ...BASE, eventDate: null });
    expect(brief.opening).toMatch(/recently/);
    expect(brief.opening).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
