import { describe, expect, it } from 'vitest';
import { buildIdentity } from '@/lib/discovery/identity';
import {
  decideContact,
  judgeCandidate,
  mayReplace,
  releasesToCallQueue,
  type ContactCandidate,
} from '@/lib/enrichment/candidates';
import {
  MAX_TRANSIENT_ATTEMPTS,
  NOTHING_FOUND_DAYS,
  fingerprintOf,
  isStale,
  nextAttemptFor,
} from '@/lib/enrichment/policy';

/**
 * The rules that decide whether a number gets dialled.
 *
 * The database-backed half — that scheduling reaches every account, that a
 * resolved contact actually moves a route into Call now, that two workers do
 * not enrich one organisation twice — is verified against real Postgres by
 * `scripts/enrichmentAudit.ts`, because a fixture cannot show any of that.
 * These cover the judgement calls, which are the ones that put a caller through
 * to the wrong business when they are wrong.
 */

const NOW = new Date('2026-08-12T10:00:00Z');
const DAY = 86_400_000;

/** The gym on West Adams whose licence started this month. */
const TARGET = buildIdentity({
  name: 'Ironside Strength LLC',
  address: '1200 W Adams St Chicago IL',
  city: 'Chicago',
  state: 'IL',
});

function candidate(overrides: Partial<ContactCandidate> = {}): ContactCandidate {
  return {
    source: 'google_places',
    sourceUrl: 'https://example.test/listing',
    externalId: 'place-1',
    retrievedAt: NOW,
    name: 'Ironside Strength',
    phone: '312-555-0101',
    website: 'https://ironside.example',
    email: null,
    contactName: null,
    contactRole: null,
    addressLine1: '1200 W Adams St',
    cityName: 'Chicago',
    stateCode: 'IL',
    postalCode: '60607',
    externalPlaceId: 'place-1',
    verified: false,
    ...overrides,
  };
}

describe('a candidate is judged against the location, not the name', () => {
  it('accepts the same business at the same street address', () => {
    const judged = judgeCandidate(TARGET, candidate());
    expect(judged.verdict).toBe('SAME_LOCATION');
  });

  it('keeps a branch in another town as a separate business', () => {
    // The single most expensive mistake available here: two real gyms, one
    // name, and a caller put through to the wrong city.
    const judged = judgeCandidate(
      TARGET,
      candidate({ addressLine1: '88 Broad St', cityName: 'Boston', stateCode: 'MA', externalPlaceId: null }),
    );
    expect(judged.verdict).toBe('SAME_ORG_DIFFERENT_LOCATION');
    expect(judged.score).toBe(0);
  });

  it('accepts the same business in the same city when neither side states an address', () => {
    const looseTarget = buildIdentity({ name: 'Ironside Strength LLC', city: 'Chicago', state: 'IL' });
    const judged = judgeCandidate(looseTarget, candidate({ addressLine1: null, externalPlaceId: null }));
    expect(judged.verdict).toBe('SAME_ORG_SAME_CITY');
  });

  it('rejects a different business entirely', () => {
    expect(judgeCandidate(TARGET, candidate({ name: 'Northside Dental' })).verdict).toBe('DIFFERENT');
  });
});

describe('the verdict when several sources disagree', () => {
  it('verifies a match on name and street address', () => {
    const verdict = decideContact({ target: TARGET, candidates: [candidate()] });
    expect(verdict.confidence).toBe('VERIFIED');
    expect(verdict.chosen?.phone).toBe('312-555-0101');
    expect(verdict.scope).toBe('LOCATION');
  });

  it('holds two different numbers for the same site as ambiguous rather than picking one', () => {
    const verdict = decideContact({
      target: TARGET,
      candidates: [candidate(), candidate({ phone: '312-555-0199', source: 'existing_platform_data', externalId: 'c2' })],
    });
    expect(verdict.confidence).toBe('AMBIGUOUS');
    expect(verdict.chosen).toBeNull();
    expect(verdict.competing).toHaveLength(2);
    expect(verdict.ambiguityReason).toMatch(/different phone numbers/i);
  });

  it('treats two sources agreeing on one number as corroboration', () => {
    const verdict = decideContact({
      target: TARGET,
      candidates: [candidate(), candidate({ source: 'existing_platform_data', externalId: 'c2' })],
    });
    expect(verdict.confidence).toBe('VERIFIED');
    expect(verdict.method).toMatch(/2 sources agree/i);
  });

  it('will not use a branch in another town as this location’s number', () => {
    const verdict = decideContact({
      target: TARGET,
      candidates: [candidate({ addressLine1: '88 Broad St', cityName: 'Boston', stateCode: 'MA', externalPlaceId: null })],
    });
    expect(verdict.confidence).toBe('UNRESOLVED');
    expect(verdict.chosen).toBeNull();
    // Found and kept, so a person can see it exists — labelled, not dialled.
    expect(verdict.otherLocations).toHaveLength(1);
    expect(verdict.blocker).toMatch(/other addresses/i);
  });

  it('reports a total source failure as a failure, never as "no contact exists"', () => {
    const verdict = decideContact({ target: TARGET, candidates: [], allSourcesFailed: true });
    expect(verdict.confidence).toBe('FAILED');
    expect(verdict.blocker).toMatch(/system fault/i);
    expect(verdict.blocker).not.toMatch(/no contact/i);
  });

  it('reports an empty search as searched-and-found-nothing', () => {
    const verdict = decideContact({ target: TARGET, candidates: [] });
    expect(verdict.confidence).toBe('UNRESOLVED');
    expect(verdict.blocker).toMatch(/searched/i);
  });

  it('does not propose a number a caller has already reported wrong', () => {
    const verdict = decideContact({
      target: TARGET,
      candidates: [candidate()],
      rejectedValues: ['(312) 555-0101'],
    });
    expect(verdict.chosen).toBeNull();
    expect(verdict.blocker).toMatch(/reported wrong/i);
  });

  it('prefers a number somebody actually checked over one merely listed', () => {
    const verdict = decideContact({
      target: TARGET,
      candidates: [
        candidate({ addressLine1: null, externalPlaceId: null }),
        candidate({
          addressLine1: null,
          externalPlaceId: null,
          source: 'existing_platform_data',
          verified: true,
        }),
      ],
    });
    expect(verdict.chosen?.source).toBe('existing_platform_data');
    expect(verdict.method).toMatch(/confirmed by a person/i);
  });
});

describe('nothing weaker displaces something stronger', () => {
  it('never overwrites what an operator entered', () => {
    expect(
      mayReplace({ confidence: 'PROBABLE', enteredByOperator: true, verified: true }, { confidence: 'VERIFIED', verified: true }),
    ).toBe(false);
  });

  it('never lets an unverified listing displace a verified value', () => {
    expect(
      mayReplace({ confidence: 'VERIFIED', enteredByOperator: false, verified: true }, { confidence: 'VERIFIED', verified: false }),
    ).toBe(false);
  });

  it('lets stronger evidence win', () => {
    expect(
      mayReplace({ confidence: 'PROBABLE', enteredByOperator: false, verified: false }, { confidence: 'VERIFIED', verified: false }),
    ).toBe(true);
  });

  it('writes into an empty field', () => {
    expect(mayReplace(null, { confidence: 'PROBABLE', verified: false })).toBe(true);
  });
});

describe('what may be put in front of a caller', () => {
  it('releases a verified or probable contact for this location', () => {
    expect(releasesToCallQueue('VERIFIED', 'LOCATION')).toBe(true);
    expect(releasesToCallQueue('PROBABLE', 'LOCATION')).toBe(true);
  });

  it('never releases a head office number as though it were the branch', () => {
    expect(releasesToCallQueue('VERIFIED', 'PARENT_OR_CENTRAL')).toBe(false);
  });

  it('never releases an unresolved or failed result', () => {
    expect(releasesToCallQueue('UNRESOLVED', 'LOCATION')).toBe(false);
    expect(releasesToCallQueue('FAILED', 'LOCATION')).toBe(false);
    expect(releasesToCallQueue('AMBIGUOUS', 'LOCATION')).toBe(false);
  });
});

describe('when to try again', () => {
  it('widens the gap after each transient failure', () => {
    const first = nextAttemptFor({ status: 'FAILED', transientFailures: 1, now: NOW });
    const third = nextAttemptFor({ status: 'FAILED', transientFailures: 3, now: NOW });
    expect(first.nextAttemptAt!.getTime() - NOW.getTime()).toBe(5 * 60_000);
    expect(third.nextAttemptAt!.getTime() - NOW.getTime()).toBe(45 * 60_000);
  });

  it('backs off to once a day rather than retrying forever', () => {
    const exhausted = nextAttemptFor({ status: 'FAILED', transientFailures: MAX_TRANSIENT_ATTEMPTS + 2, now: NOW });
    expect(exhausted.nextAttemptAt!.getTime() - NOW.getTime()).toBe(24 * 60 * 60_000);
    expect(exhausted.note).toMatch(/rather than retrying continuously/i);
  });

  it('says what to fix when the problem is configuration, and keeps checking cheaply', () => {
    const result = nextAttemptFor({ status: 'FAILED', failureKind: 'configuration', now: NOW });
    expect(result.nextAttemptAt!.getTime() - NOW.getTime()).toBe(6 * 60 * 60_000);
    expect(result.note).toMatch(/configuration/i);
  });

  it('does not retry a permanent "nothing published" every minute', () => {
    const result = nextAttemptFor({ status: 'UNRESOLVED', now: NOW });
    expect(result.nextAttemptAt!.getTime() - NOW.getTime()).toBe(NOTHING_FOUND_DAYS * DAY);
  });

  it('never automatically retries an ambiguity, because the answer will not change', () => {
    const result = nextAttemptFor({ status: 'AMBIGUOUS', now: NOW });
    expect(result.nextAttemptAt).toBeNull();
    expect(result.note).toMatch(/waiting for a person/i);
  });

  it('re-checks a resolved contact at its source’s own horizon', () => {
    const result = nextAttemptFor({ status: 'RESOLVED', freshDays: 30, now: NOW });
    expect(result.nextAttemptAt!.getTime() - NOW.getTime()).toBe(30 * DAY);
  });
});

describe('a contact ages out of being trustworthy', () => {
  it('is fresh inside the horizon and stale past it', () => {
    expect(isStale({ retrievedAt: new Date(NOW.getTime() - 10 * DAY), freshDays: 30, now: NOW })).toBe(false);
    expect(isStale({ retrievedAt: new Date(NOW.getTime() - 40 * DAY), freshDays: 30, now: NOW })).toBe(true);
  });
});

describe('new information earns a fresh attempt', () => {
  const base = {
    name: 'Ironside Strength LLC',
    addressLine1: null,
    cityName: 'Chicago',
    stateCode: 'IL',
    postalCode: null,
    website: null,
    externalPlaceId: null,
  };

  it('is stable when nothing changed', () => {
    expect(fingerprintOf(base)).toBe(fingerprintOf({ ...base }));
  });

  it('changes when a later source supplies a street address', () => {
    expect(fingerprintOf(base)).not.toBe(fingerprintOf({ ...base, addressLine1: '1200 W Adams St' }));
  });

  it('changes when a caller rules a number out', () => {
    expect(fingerprintOf(base)).not.toBe(fingerprintOf({ ...base, rejectedValues: ['312-555-0101'] }));
  });
});
