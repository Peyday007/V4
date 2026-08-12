import { describe, expect, it } from 'vitest';
import { CallDisposition } from '@prisma/client';
import { DISPOSITIONS } from '@/lib/demand/dispositionList';
import {
  COMMON_FIELDS,
  REQUIREMENTS,
  fieldsForRoute,
  requiredFieldsFor,
  sanitiseDiscovery,
  validateDisposition,
} from '@/lib/caller/discovery';
import { CALLING_WINDOW, localHours, timezoneForState } from '@/lib/caller/localTime';
import { orderServable, type ServableRow } from '@/lib/caller/packets';
import { transitionFor } from '@/lib/demand/outreach';

/**
 * The rules a caller works under.
 *
 * The database-backed half — that a caller cannot reach another caller's
 * assignment, that two tabs cannot claim one record, that a failed save raises
 * an incident rather than blaming somebody — is verified against real Postgres
 * by `scripts/callerWorkspaceAudit.ts`, because none of it can be shown with a
 * fixture. These are the judgement calls: what each outcome must carry, what
 * may be dialled at what hour, and what order the work comes in.
 */

const NOW = new Date('2026-08-12T15:00:00Z'); // 10:00 in Chicago, 08:00 in LA

describe('what each outcome has to carry', () => {
  it('asks nothing of an outcome where nothing was learned', () => {
    for (const disposition of ['NO_ANSWER', 'LEFT_VOICEMAIL'] as const) {
      const result = validateDisposition({ disposition, route: 'BROKERAGE', discovery: {} });
      expect(result.ok, disposition).toBe(true);
    }
  });

  it('never gates a do-not-contact behind anything', () => {
    // The one requirement that would cause harm. Recording it must always be
    // easier than ignoring it.
    const result = validateDisposition({ disposition: 'DO_NOT_CONTACT', route: 'DISTRIBUTION', discovery: {} });
    expect(result.ok).toBe(true);
    expect(REQUIREMENTS.DO_NOT_CONTACT.common).toEqual([]);
  });

  it('never gates a wrong number either', () => {
    // Reporting a bad number is what reopens contact resolution. Making it
    // expensive is how a caller learns to pick "no answer" instead.
    expect(validateDisposition({ disposition: 'WRONG_NUMBER', route: 'BROKERAGE', discovery: {} }).ok).toBe(true);
  });

  it('asks a confirmed need for the scope that makes it one', () => {
    const bare = validateDisposition({
      disposition: 'NEED_CONFIRMED',
      route: 'DISTRIBUTION',
      discovery: { confirmedNeed: 'They want quarterly restock' },
    });
    expect(bare.ok).toBe(false);
    expect(bare.missing).toContain('timing');
    expect(bare.missing).toContain('quantity');

    const full = validateDisposition({
      disposition: 'NEED_CONFIRMED',
      route: 'DISTRIBUTION',
      discovery: {
        confirmedNeed: 'Quarterly restock',
        timing: 'October',
        buyerRole: 'Office manager',
        productCategory: 'Restroom consumables',
        quantity: '20 cases',
      },
    });
    expect(full.ok).toBe(true);
  });

  it('asks different things of the same outcome on different routes', () => {
    // The whole reason the fields are route-specific: a subcontract does not
    // have a reorder cycle and a distribution order does not mobilise.
    const distribution = requiredFieldsFor('NEED_CONFIRMED', 'DISTRIBUTION').map((f) => f.key);
    const subcontract = requiredFieldsFor('NEED_CONFIRMED', 'SUBCONTRACTING').map((f) => f.key);
    expect(distribution).toContain('quantity');
    expect(subcontract).toContain('tradeCapability');
    expect(distribution).not.toContain('tradeCapability');
  });

  it('requires a date wherever a promise was made', () => {
    for (const disposition of ['FOLLOW_UP', 'INTERESTED', 'NEEDS_INFORMATION', 'QUOTE_REQUESTED'] as const) {
      const withoutDate = validateDisposition({
        disposition,
        route: 'BROKERAGE',
        discovery: {
          confirmedNeed: 'x', nextStep: 'send pricing', scope: 'nightly clean',
          locations: '3', frequency: 'nightly',
        },
        followUpAt: null,
      });
      expect(withoutDate.needsFollowUpDate, disposition).toBe(true);
      expect(withoutDate.ok, disposition).toBe(false);
    }
  });

  it('explains why it is asking, rather than just refusing', () => {
    const result = validateDisposition({ disposition: 'QUALIFIED_OPPORTUNITY', route: 'BROKERAGE', discovery: {} });
    expect(result.because.length).toBeGreaterThan(20);
    expect(result.missingLabels.every((label) => label !== '')).toBe(true);
    // Labels, not keys — the caller has never seen `decisionAuthority`.
    expect(result.missingLabels.some((l) => /who decides/i.test(l))).toBe(true);
  });

  it('treats whitespace as absent', () => {
    const result = validateDisposition({
      disposition: 'NOT_INTERESTED',
      route: 'BROKERAGE',
      discovery: { disqualifyReason: '   ' },
    });
    expect(result.ok).toBe(false);
  });

  it('accepts false as an answer, because it is one', () => {
    // `siteVisitRequired: false` is a finding. Treating falsy as missing would
    // make "no" impossible to record.
    const kept = sanitiseDiscovery('BROKERAGE', { siteVisitRequired: false });
    expect(kept.siteVisitRequired).toBe(false);
  });

  it('drops anything the route does not recognise', () => {
    const kept = sanitiseDiscovery('DISTRIBUTION', {
      quantity: '20 cases',
      tradeCapability: 'not a distribution field',
      __proto__: 'nonsense',
      evil: { nested: true },
    });
    expect(kept).toEqual({ quantity: '20 cases' });
  });

  it('covers every disposition the database can store', () => {
    // The drift that bit once already: the enum grew and the list did not, so
    // five outcomes existed that no caller could choose.
    const enumValues = Object.values(CallDisposition);
    const listed = DISPOSITIONS.map((d) => d.value);
    expect([...enumValues].sort()).toEqual([...listed].sort());
    for (const value of enumValues) {
      expect(REQUIREMENTS[value], `no requirement defined for ${value}`).toBeDefined();
    }
  });

  it('has a queue transition for every disposition', () => {
    for (const value of Object.values(CallDisposition)) {
      const result = transitionFor({ disposition: value, attempts: 0, now: NOW });
      expect(result.status, `no transition for ${value}`).toBeTruthy();
      expect(result.effect.length).toBeGreaterThan(5);
    }
  });

  it('offers every common field on every route', () => {
    for (const route of ['DISTRIBUTION', 'BROKERAGE', 'SUBCONTRACTING']) {
      const keys = fieldsForRoute(route).map((f) => f.key);
      for (const common of COMMON_FIELDS) expect(keys).toContain(common.key);
    }
  });
});

describe('what may be dialled, and when', () => {
  it('knows the local hour from the state', () => {
    expect(timezoneForState('IL')).toBe('America/Chicago');
    expect(timezoneForState('CA')).toBe('America/Los_Angeles');
    expect(localHours({ stateCode: 'IL', now: NOW }).localHour).toBe(10);
  });

  it('will not call before the window opens', () => {
    // 12:00 UTC is 06:00 in Chicago.
    const early = localHours({ stateCode: 'IL', now: new Date('2026-08-12T11:00:00Z') });
    expect(early.open).toBe(false);
    expect(early.reason).toMatch(/outside/);
  });

  it('will not call after it closes', () => {
    const late = localHours({ stateCode: 'IL', now: new Date('2026-08-13T01:00:00Z') });
    expect(late.open).toBe(false);
  });

  it('will not call at the weekend', () => {
    // 2026-08-15 is a Saturday.
    const weekend = localHours({ stateCode: 'IL', now: new Date('2026-08-15T16:00:00Z') });
    expect(weekend.open).toBe(false);
    expect(weekend.reason).toMatch(/weekend/i);
  });

  it('says unknown rather than guessing when there is no location', () => {
    const unknown = localHours({ stateCode: null, now: NOW });
    expect(unknown.timezone).toBeNull();
    expect(unknown.open).toBe(false);
    expect(unknown.reason).toMatch(/not assumed/i);
  });

  it('defaults to ordinary commercial hours', () => {
    // Configurable, but the default is the conservative one — a deployment has
    // to decide to widen it rather than inherit a permissive default.
    expect(CALLING_WINDOW.startHour).toBe(8);
    expect(CALLING_WINDOW.endHour).toBe(18);
  });
});

// ---------------------------------------------------------------------------

function row(overrides: Partial<ServableRow> = {}): ServableRow {
  return {
    itemId: Math.random().toString(36).slice(2),
    routeId: Math.random().toString(36).slice(2),
    packetId: 'p1',
    companyId: 'c1',
    organisation: 'Test Co',
    stateCode: 'IL',
    cityName: 'Chicago',
    tier: 'STRONG_TRIGGER',
    route: 'BROKERAGE',
    friction: 'MODERATE',
    fulfilmentStatus: 'PARTIAL',
    windowClosesAt: null,
    phone: '312-555-0100',
    attempts: 0,
    snoozeUntil: null,
    outreachStatus: 'NEW',
    contactVerified: false,
    hasDecisionMaker: false,
    itemStatus: 'PENDING',
    leaseExpiresAt: null,
    ...overrides,
  };
}

describe('the order work is handed out in', () => {
  it('excludes closed hours rather than ranking them down', () => {
    // The rule that matters: no amount of priority resurrects a 4 a.m. call.
    const shut = row({ stateCode: 'CA', tier: 'ACTIVE_DEMAND', windowClosesAt: new Date('2026-08-13') });
    const open = row({ stateCode: 'IL' });
    const ordered = orderServable([shut, open], new Date('2026-08-12T13:00:00Z')); // 06:00 LA, 08:00 Chicago
    expect(ordered.map((r) => r.routeId)).toEqual([open.routeId]);
  });

  it('puts a due callback above all cold work', () => {
    const cold = row({ tier: 'ACTIVE_DEMAND' });
    const promised = row({
      tier: 'STRONG_TRIGGER',
      outreachStatus: 'FOLLOW_UP',
      snoozeUntil: new Date(NOW.getTime() - 3_600_000),
    });
    expect(orderServable([cold, promised], NOW)[0].routeId).toBe(promised.routeId);
  });

  it('keeps a record the caller already claimed at the front', () => {
    // Ownership is stable even though the order is not.
    const claimed = row({ itemStatus: 'IN_PROGRESS', tier: 'STRONG_TRIGGER' });
    const hotter = row({ tier: 'ACTIVE_DEMAND' });
    expect(orderServable([hotter, claimed], NOW)[0].routeId).toBe(claimed.routeId);
  });

  it('takes Tier A before Tier B', () => {
    const a = row({ tier: 'ACTIVE_DEMAND' });
    const b = row({ tier: 'STRONG_TRIGGER' });
    expect(orderServable([b, a], NOW).map((r) => r.tier)).toEqual(['ACTIVE_DEMAND', 'STRONG_TRIGGER']);
  });

  it('takes the nearest buying window within a tier', () => {
    const soon = row({ windowClosesAt: new Date('2026-08-20') });
    const later = row({ windowClosesAt: new Date('2026-10-20') });
    expect(orderServable([later, soon], NOW)[0].routeId).toBe(soon.routeId);
  });

  it('prefers a verified contact and a named decision-maker', () => {
    const plain = row();
    const good = row({ contactVerified: true, hasDecisionMaker: true });
    expect(orderServable([plain, good], NOW)[0].routeId).toBe(good.routeId);
  });

  it('prefers lower friction, then a record nobody has worn out', () => {
    expect(orderServable([row({ friction: 'HIGH' }), row({ friction: 'LOW' })], NOW)[0].friction).toBe('LOW');
    expect(orderServable([row({ attempts: 4 }), row({ attempts: 0 })], NOW)[0].attempts).toBe(0);
  });

  it('sorts an unknown location last rather than dropping it', () => {
    // Lower preference, not exclusion: a record that can never be served is
    // worse than one called at a slightly odd hour.
    const unknown = row({ stateCode: null });
    const known = row({ stateCode: 'IL' });
    const ordered = orderServable([unknown, known], NOW);
    expect(ordered).toHaveLength(2);
    expect(ordered[0].routeId).toBe(known.routeId);
  });

  it('is stable, so the same set produces the same order twice', () => {
    const rows = [row({ tier: 'ACTIVE_DEMAND' }), row(), row({ friction: 'LOW' })];
    const first = orderServable(rows, NOW).map((r) => r.routeId);
    const second = orderServable([...rows].reverse(), NOW).map((r) => r.routeId);
    expect(first).toEqual(second);
  });
});
