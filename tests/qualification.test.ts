import { describe, expect, it } from 'vitest';
import {
  decideStage,
  describeRelevance,
  intentDecay,
  scoreAccountFit,
  scoreContactability,
  scoreIntent,
  scorePriority,
  type QualificationEvidence,
} from '@/lib/discovery/qualification';
import { buildIdentity, normalizeAddress, normalizePhone, sameCompany } from '@/lib/discovery/identity';
import { intentKindFor } from '@/lib/discovery/reclassify';

/**
 * The model these tests defend.
 *
 * A directory listing proves an organisation exists and may fit the profile.
 * It does not prove anyone is buying. Everything below exists because the
 * previous implementation collapsed those two into one number and produced
 * 88-point "qualified leads" out of businesses that had never heard of us.
 */

const FULL_EVIDENCE: QualificationEvidence = {
  need: { present: true, tier: 'USER_CONFIRMED' },
  decisionMaker: { present: true, verified: true },
  timing: { present: true },
  fit: { present: true },
  nextStep: { present: true },
};

// ---------------------------------------------------------------------------
// Intent cannot be manufactured
// ---------------------------------------------------------------------------

describe('intent requires a dated external event', () => {
  it('scores zero for a Google Places listing with no events', () => {
    const result = scoreIntent([]);
    expect(result.score).toBe(0);
    expect(result.reason).toMatch(/not that it is buying/i);
  });

  it('caps priority low for a perfect-fit account with no intent', () => {
    // Perfect on every other dimension. Still a cold call.
    const priority = scorePriority({ accountFit: 1, intent: 0, contactability: 1, fulfilmentReadiness: 1 });
    expect(priority.score).toBeLessThanOrEqual(35);
    expect(priority.reason).toMatch(/no intent evidence/i);
  });

  it('lets a real signal outrank a perfect-fit cold account', () => {
    const cold = scorePriority({ accountFit: 1, intent: 0, contactability: 1, fulfilmentReadiness: 1 });
    const warm = scorePriority({ accountFit: 0.5, intent: 0.8, contactability: 0.3, fulfilmentReadiness: 0.5 });
    expect(warm.score).toBeGreaterThan(cold.score);
  });

  it('awards nothing for being discovered recently, listed, or category-matched', () => {
    // None of these are expressible as an IntentSignal, which is the point —
    // there is no code path by which they can reach the intent score.
    const placesListing = scoreIntent([]);
    expect(placesListing.score).toBe(0);
    const cmsListing = scoreIntent([]);
    expect(cmsListing.score).toBe(0);
  });

  it('treats a directory or registry connector as producing no intent', () => {
    expect(intentKindFor({ signalKey: 'sourced_buyer', category: 'BROKERAGE', dataSource: { connector: 'google_places' } })).toBeNull();
    expect(intentKindFor({ signalKey: 'sourced_buyer', category: 'BROKERAGE', dataSource: { connector: 'nppes_healthcare' } })).toBeNull();
    // A permit is an event with a date, so it does.
    expect(intentKindFor({ signalKey: 'x', category: 'BROKERAGE', dataSource: { connector: 'socrata_open_data' } })).toBe('PERMIT_FILED');
  });

  it('decays intent so an old permit is not treated as a live lead', () => {
    const now = new Date('2026-08-10T00:00:00Z');
    const fresh = intentDecay(new Date('2026-08-08T00:00:00Z'), now);
    const old = intentDecay(new Date('2025-06-01T00:00:00Z'), now);
    expect(fresh).toBeGreaterThan(0.9);
    expect(old).toBeLessThan(0.1);
    expect(intentDecay(new Date('2023-01-01T00:00:00Z'), now)).toBe(0);
  });

  it('counts an inference at half the weight of a stated fact', () => {
    const at = new Date();
    const stated = scoreIntent([{ kind: 'PERMIT_FILED', occurredAt: at, tier: 'SOURCE_FACT' }]);
    const inferred = scoreIntent([{ kind: 'PERMIT_FILED', occurredAt: at, tier: 'SYSTEM_INFERENCE' }]);
    expect(inferred.score).toBeLessThan(stated.score);
    expect(inferred.reason).toMatch(/half weight/i);
  });
});

// ---------------------------------------------------------------------------
// Discovery time is not publication time
// ---------------------------------------------------------------------------

describe('discovery time is never presented as publication time', () => {
  it('reports the event date, not the moment it was ingested', () => {
    const now = new Date('2026-08-10T00:00:00Z');
    const result = scoreIntent(
      [{ kind: 'PERMIT_FILED', occurredAt: new Date('2026-06-10T00:00:00Z'), tier: 'SOURCE_FACT' }],
      now,
    );
    // Ingested today, filed two months ago. The lead is two months old.
    expect(result.reason).toMatch(/61 day\(s\) ago/);
    expect(result.reason).not.toMatch(/today/);
  });

  it('says nothing about dates at all when the source supplied none', () => {
    const result = scoreIntent([]);
    expect(result.lastSignalAt).toBeNull();
    expect(result.reason).not.toMatch(/today|published/i);
  });
});

// ---------------------------------------------------------------------------
// A main phone is not a decision-maker
// ---------------------------------------------------------------------------

describe('contactability distinguishes a switchboard from a decision-maker', () => {
  const none = { hasRoutingPhone: false, hasDirectPhone: false, hasEmail: false, hasIdentifiedDecisionMaker: false, decisionMakerVerified: false };

  it('does not treat a main business phone as an identified decision-maker', () => {
    const routing = scoreContactability({ ...none, hasRoutingPhone: true });
    expect(routing.score).toBeLessThanOrEqual(0.3);
    expect(routing.reason).toMatch(/not a decision-maker|gatekeeper/i);
  });

  it('scores a verified decision-maker far above a switchboard', () => {
    const verified = scoreContactability({ ...none, hasIdentifiedDecisionMaker: true, decisionMakerVerified: true });
    const routing = scoreContactability({ ...none, hasRoutingPhone: true });
    expect(verified.score).toBe(1);
    expect(verified.score).toBeGreaterThan(routing.score * 3);
  });

  it('gives no contactability at all when there is no route in', () => {
    expect(scoreContactability(none).score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Qualification gate
// ---------------------------------------------------------------------------

describe('a record cannot reach qualified lead without the evidence', () => {
  it('refuses to qualify a high-fit account with nothing established', () => {
    const decision = decideStage({
      intentScore: 0,
      accountFit: 1,
      evidence: { need: { present: false }, decisionMaker: { present: false }, timing: { present: false }, fit: { present: true }, nextStep: { present: false } },
    });
    expect(decision.stage).not.toBe('QUALIFIED_LEAD');
    expect(decision.stage).toBe('OPPORTUNITY_HYPOTHESIS');
    expect(decision.missing).toContain('an identified decision-maker');
    expect(decision.missing).toContain('timing — when they would buy');
  });

  it('refuses to qualify on an inferred need', () => {
    // We do not get to qualify a lead on our own guess about what they want.
    const decision = decideStage({
      intentScore: 0.6,
      accountFit: 1,
      evidence: { ...FULL_EVIDENCE, need: { present: true, tier: 'SYSTEM_INFERENCE' } },
    });
    expect(decision.stage).toBe('INTENT_DETECTED');
    expect(decision.missing.join(' ')).toMatch(/not inferred/);
  });

  it('qualifies only when all five are present', () => {
    const decision = decideStage({ intentScore: 0.6, accountFit: 1, evidence: FULL_EVIDENCE });
    expect(decision.stage).toBe('QUALIFIED_LEAD');
    expect(decision.missing).toHaveLength(0);
  });

  it('names every missing requirement, one by one', () => {
    for (const field of ['need', 'decisionMaker', 'timing', 'fit', 'nextStep'] as const) {
      const evidence = { ...FULL_EVIDENCE, [field]: { present: false } } as QualificationEvidence;
      const decision = decideStage({ intentScore: 1, accountFit: 1, evidence });
      expect(decision.stage, `${field} missing should block qualification`).not.toBe('QUALIFIED_LEAD');
      expect(decision.missing.length).toBeGreaterThan(0);
    }
  });

  it('leaves a place listing with no intent as a discovered account or hypothesis', () => {
    const lowFit = decideStage({
      intentScore: 0,
      accountFit: 0.2,
      evidence: { need: { present: false }, decisionMaker: { present: false }, timing: { present: false }, fit: { present: false }, nextStep: { present: false } },
    });
    expect(lowFit.stage).toBe('DISCOVERED_ACCOUNT');
  });

  it('does not recompute a stage a person set', () => {
    const held = decideStage({ intentScore: 1, accountFit: 1, evidence: FULL_EVIDENCE, currentStage: 'DISQUALIFIED' });
    expect(held.stage).toBe('DISQUALIFIED');
  });
});

// ---------------------------------------------------------------------------
// Role-appropriate language
// ---------------------------------------------------------------------------

describe('role-specific language', () => {
  it('never calls a provider capability a buyer need', () => {
    const provider = describeRelevance('PROVIDER', 'Commercial cleaning', false);
    expect(provider).toMatch(/offers .* capability/i);
    expect(provider).not.toMatch(/need/i);
  });

  it('says "possible need" for a buyer with no demand signal', () => {
    const buyer = describeRelevance('BUYER', 'Commercial cleaning', false);
    expect(buyer).toMatch(/possible need/i);
    expect(buyer).not.toMatch(/identified need/i);
    expect(buyer).toMatch(/they have not said anything/i);
  });

  it('upgrades to an evidenced need only when intent exists', () => {
    expect(describeRelevance('BUYER', 'Commercial cleaning', true)).toMatch(/evidenced need/i);
  });

  it('describes suppliers as offering products and subcontractors as having capacity', () => {
    expect(describeRelevance('SUPPLIER', 'Janitorial supply', false)).toMatch(/offers .* products/i);
    expect(describeRelevance('SUBCONTRACTOR', 'Janitorial', true)).toMatch(/capacity/i);
  });
});

// ---------------------------------------------------------------------------
// Identity and deduplication
// ---------------------------------------------------------------------------

describe('one company appears once', () => {
  const planetFitnessPlaces = buildIdentity({
    name: 'Planet Fitness',
    externalPlaceId: 'ChIJpf123',
    phone: '(214) 555-0142',
    address: '1200 Main Street, Suite 400',
    city: 'Dallas',
    state: 'TX',
  });

  it('matches the same Planet Fitness location across three different sources', () => {
    // Same site, three sources, three spellings — one company.
    const fromPermit = buildIdentity({ name: 'PLANET FITNESS #4412', phone: '214-555-0142', address: '1200 Main St Ste 400', city: 'Dallas', state: 'TX' });
    const fromImport = buildIdentity({ name: 'Planet Fitness Inc', phone: '+1 214 555 0142', address: '1200 Main St., Suite 400, Dallas TX 75201', city: 'Dallas', state: 'TX' });

    expect(sameCompany(planetFitnessPlaces, fromPermit).matched).toBe(true);
    expect(sameCompany(planetFitnessPlaces, fromImport).matched).toBe(true);
    expect(sameCompany(fromPermit, fromImport).matched).toBe(true);
  });

  it('keeps two genuinely different branches apart', () => {
    // Two real gyms in the same city are not one company, so the weakest rule
    // must not fire when addresses distinguish them.
    const branchA = buildIdentity({ name: 'Planet Fitness', phone: '214-555-0101', address: '1200 Main St', city: 'Dallas', state: 'TX' });
    const branchB = buildIdentity({ name: 'Planet Fitness', phone: '214-555-0202', address: '88 Elm St', city: 'Dallas', state: 'TX' });
    expect(sameCompany(branchA, branchB).matched).toBe(false);
  });

  it('treats differing place IDs as different companies even when names match', () => {
    const a = buildIdentity({ name: 'Planet Fitness', externalPlaceId: 'ChIJaaa', city: 'Dallas', state: 'TX' });
    const b = buildIdentity({ name: 'Planet Fitness', externalPlaceId: 'ChIJbbb', city: 'Dallas', state: 'TX' });
    expect(sameCompany(a, b).matched).toBe(false);
  });

  it('normalises phones and addresses to comparable form', () => {
    expect(normalizePhone('+1 (214) 555-0142')).toBe('2145550142');
    expect(normalizePhone('214.555.0142')).toBe('2145550142');
    expect(normalizePhone('555')).toBeNull();
    expect(normalizeAddress('1200 Main Street, Suite 400')).toBe(normalizeAddress('1200 Main St Ste 400'));
    expect(normalizeAddress('1200 Main St, Dallas TX 75201')).toBe(normalizeAddress('1200 Main Street, Dallas TX'));
  });

  it('records which key established the match, for audit', () => {
    const byPhone = buildIdentity({ name: 'Different Name LLC', phone: '214-555-0142', city: 'Dallas', state: 'TX' });
    const match = sameCompany(
      buildIdentity({ name: 'Planet Fitness', phone: '2145550142', city: 'Dallas', state: 'TX' }),
      byPhone,
    );
    expect(match.matched).toBe(true);
    expect(match.via).toBe('phone');
  });
});

// ---------------------------------------------------------------------------
// Multiple hypotheses, one account
// ---------------------------------------------------------------------------

describe('one facility, several path hypotheses', () => {
  it('is the same company whether found as a cleaning buyer or a consumables buyer', () => {
    // NPPES emits two records per facility — one brokerage, one distribution.
    // They must resolve to one account with two hypotheses, not two cards.
    const brokerage = buildIdentity({ name: 'Big Sky Dental PC', phone: '406-555-0142', address: '12 Main St', city: 'Bozeman', state: 'MT' });
    const distribution = buildIdentity({ name: 'Big Sky Dental PC', phone: '406-555-0142', address: '12 Main St', city: 'Bozeman', state: 'MT' });
    expect(sameCompany(brokerage, distribution).matched).toBe(true);
  });

  it('scores the two hypotheses independently', () => {
    // Same account, different fulfilment position: we can sell consumables
    // without a cleaning crew, so the paths must not share one number.
    const cleaning = scorePriority({ accountFit: 0.8, intent: 0, contactability: 0.3, fulfilmentReadiness: 0 });
    const consumables = scorePriority({ accountFit: 0.8, intent: 0, contactability: 0.3, fulfilmentReadiness: 1 });
    expect(consumables.score).toBeGreaterThanOrEqual(cleaning.score);
  });
});

// ---------------------------------------------------------------------------
// Account fit says what it is
// ---------------------------------------------------------------------------

describe('account fit', () => {
  it('states plainly that fit is not intent', () => {
    const fit = scoreAccountFit({
      pathSegments: ['COMMERCIAL'],
      segment: 'COMMERCIAL',
      hasRelevantService: true,
      inServedMarket: true,
      sourceVerified: true,
    });
    expect(fit.score).toBe(1);
    expect(fit.reason).toMatch(/says nothing about whether they are buying/i);
  });
});
