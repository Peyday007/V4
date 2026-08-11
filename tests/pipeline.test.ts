import { describe, expect, it } from 'vitest';
import { describeDistribution, diagnose, inspectDistribution } from '@/lib/discovery/diagnostics';
import { assessIdentity, buildIdentity } from '@/lib/discovery/identity';
import { providersFor, type ProviderIndex } from '@/lib/discovery/reclassify';

/**
 * Whole-pipeline properties.
 *
 * Unit tests on each scorer passed while the workflow produced Fit 100 and
 * Contact 30 for every record, three times running. Testing functions in
 * isolation cannot catch a dimension whose *inputs* are invariant, because
 * each function was behaving correctly given what it was handed. These tests
 * are about the shape of the output across a population.
 */

// ---------------------------------------------------------------------------
// The system notices its own degenerate output
// ---------------------------------------------------------------------------

describe('degenerate distributions are detected automatically', () => {
  const records = Array.from({ length: 20 }, (_, i) => ({
    company: `Co ${i}`,
    cityState: 'Dallas, TX',
    quarantined: false,
    quarantineReason: null,
    contactability: 30,
    intent: 0,
  }));

  it('calls a constant dimension out as carrying no information', () => {
    // This is the exact failure that shipped three times.
    const stats = describeDistribution('accountFit', Array(20).fill(100));
    const warnings = inspectDistribution(stats);
    expect(warnings[0].severity).toBe('CRITICAL');
    expect(warnings[0].finding).toMatch(/not distinguishing anything/i);
    expect(warnings[0].likelyCause).toMatch(/true by construction/i);
  });

  it('refuses to call a run credible when a dimension is constant', () => {
    const result = diagnose({
      fit: Array(20).fill(100),
      intent: Array(20).fill(0),
      contactability: Array(20).fill(30),
      fulfilment: Array(20).fill(0),
      priority: Array(20).fill(35),
      records,
    });
    expect(result.verdict).toBe('NOT_CREDIBLE');
    expect(result.verdictReason).toMatch(/ranking on nothing/i);
    expect(result.warnings.map((w) => w.dimension)).toContain('accountFit');
    expect(result.warnings.map((w) => w.dimension)).toContain('contactability');
  });

  it('treats zero intent as expected rather than broken, but still says so', () => {
    // Intent is legitimately zero with only directory sources enabled. The
    // operator still needs to know the board cannot rank on urgency.
    const stats = describeDistribution('intent', Array(20).fill(0));
    const warnings = inspectDistribution(stats);
    expect(warnings[0].severity).toBe('INFO');
    expect(warnings[0].likelyCause).toMatch(/Enable a permit, award or purchasing source/i);
  });

  it('passes a run whose dimensions genuinely vary', () => {
    const vary = (n: number) => Array.from({ length: 20 }, (_, i) => ((i * 7 + n) % 5) * 20);
    const result = diagnose({
      fit: vary(1),
      intent: vary(2),
      contactability: vary(3),
      fulfilment: vary(4),
      priority: vary(5),
      records: records.map((r, i) => ({ ...r, contactability: (i % 4) * 15, intent: (i % 3) * 20 })),
    });
    expect(result.verdict).toBe('CREDIBLE');
    expect(result.warnings).toHaveLength(0);
  });

  it('flags a near-constant dimension without waiting for a perfect constant', () => {
    // 19 of 20 identical is the same problem wearing a disguise.
    const stats = describeDistribution('contactability', [...Array(19).fill(30), 45]);
    const warnings = inspectDistribution(stats);
    expect(warnings.some((w) => w.severity === 'WARNING')).toBe(true);
  });

  it('stays quiet on a sample too small to judge', () => {
    // Five clinics from one registry may genuinely share a score.
    expect(inspectDistribution(describeDistribution('accountFit', Array(5).fill(100)))).toHaveLength(0);
  });

  it('flags a dimension pinned to its ceiling', () => {
    const stats = describeDistribution('accountFit', [...Array(18).fill(100), 90, 80]);
    expect(inspectDistribution(stats).some((w) => w.finding.match(/at the maximum/i))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Quarantine rather than merge or delete
// ---------------------------------------------------------------------------

describe('unverifiable identities are quarantined, not destroyed', () => {
  it('holds a record that has only a name', () => {
    const verdict = assessIdentity(buildIdentity({ name: 'Some Clinic' }));
    expect(verdict.quarantined).toBe(true);
    expect(verdict.reason).toMatch(/only a name/i);
  });

  it('holds a record with a location but no matchable key', () => {
    // Merging on name and city alone would fuse two real branches.
    const verdict = assessIdentity(buildIdentity({ name: 'Planet Fitness', city: 'Dallas', state: 'TX' }));
    expect(verdict.quarantined).toBe(true);
    expect(verdict.reason).toMatch(/would be a guess/i);
  });

  it('admits a record carrying any strong key', () => {
    const strong = [
      buildIdentity({ name: 'Apex Cleaning', externalPlaceId: 'ChIJx', city: 'Dallas' }),
      buildIdentity({ name: 'Apex Cleaning', phone: '214-555-0142', city: 'Dallas' }),
      buildIdentity({ name: 'Apex Cleaning', address: '1200 Main St', city: 'Dallas' }),
    ];
    for (const identity of strong) {
      expect(assessIdentity(identity).quarantined).toBe(false);
    }
  });

  it('holds a record whose name is too short to be an organisation', () => {
    // A single character survives normalisation of legal suffixes but is not
    // a name anyone could act on.
    expect(assessIdentity(buildIdentity({ name: 'A', phone: '214-555-0142' })).quarantined).toBe(true);
  });

  it('rejects a record whose location was a malformed fragment', () => {
    // "633" is stripped by cleanCity, leaving nothing to locate it by.
    const verdict = assessIdentity(buildIdentity({ name: 'Urgent Care', city: '633', state: '75201' }));
    expect(verdict.quarantined).toBe(true);
  });

  it('keeps quarantined records out of the credibility assessment', () => {
    // Otherwise held-back records would drag the distribution and mask a real
    // problem in the population actually being ranked.
    const result = diagnose({
      fit: [20, 40, 60, 80, 100, 40, 60, 80],
      intent: [0, 0, 0, 0, 0, 0, 0, 0],
      contactability: [10, 20, 30, 45, 20, 30, 10, 45],
      fulfilment: [0, 25, 50, 75, 100, 25, 50, 75],
      priority: [10, 15, 20, 25, 30, 15, 20, 25],
      records: [
        ...Array.from({ length: 8 }, (_, i) => ({ company: `Ranked ${i}`, cityState: 'Dallas, TX', quarantined: false, quarantineReason: null, contactability: 30, intent: 0 })),
        { company: 'Held', cityState: 'unknown', quarantined: true, quarantineReason: 'only a name', contactability: 0, intent: 0 },
      ],
    });
    expect(result.dataQuality.some((q) => q.kind === 'quarantined_identity')).toBe(true);
    expect(result.distributions.find((d) => d.dimension === 'accountFit')?.count).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Fulfilment reflects real capacity
// ---------------------------------------------------------------------------

describe('fulfilment counts actual providers', () => {
  const index: ProviderIndex = {
    byCapability: new Map([
      ['commercial cleaning', new Map([['TX', 4], ['IL', 2]])],
      ['janitorial', new Map([['TX', 1]])],
    ]),
    byStateOnly: new Map(),
    total: 7,
  };

  it('counts local providers fully and distant ones at a fraction', () => {
    // A crew three states away is not nothing, but it is not local coverage.
    expect(providersFor(index, 'Commercial cleaning', 'TX')).toBe(4.5);
    expect(providersFor(index, 'Commercial cleaning', 'IL')).toBe(3);
  });

  it('returns zero for work in a different trade', () => {
    // Structured cabling shares no vocabulary with cleaning. This is the case
    // the exact-string version was meant to catch, and still does.
    expect(providersFor(index, 'Structured cabling', 'TX')).toBe(0);
    expect(providersFor(index, 'Commercial electrical', 'TX')).toBe(0);
    expect(providersFor(index, null, 'TX')).toBe(0);
  });

  it('matches the same trade under a different name', () => {
    // "Commercial janitorial" and "commercial cleaning" are one trade. Exact
    // matching missed every pair like this, which held fulfilment at zero for
    // most of the board and made the fit score's service component a constant.
    expect(providersFor(index, 'Commercial janitorial', 'TX')).toBe(4.5);
    expect(providersFor(index, 'Post-construction cleaning subcontract', 'TX')).toBeGreaterThan(0);
  });

  it('lets a specific need reach a broadly-named capability, but not the reverse', () => {
    // A provider catalogued as "Janitorial" can take cleaning work described
    // more specifically. A provider catalogued only for one specialism cannot
    // be assumed to cover a different one.
    expect(providersFor(index, 'Office cleaning', 'TX')).toBeGreaterThan(0);
    expect(providersFor(index, 'Cold storage logistics', 'TX')).toBe(0);
  });

  it('falls back to the national count when the lead has no state', () => {
    expect(providersFor(index, 'Commercial cleaning', null)).toBe(6);
  });

  it('varies by capability and state rather than returning a constant', () => {
    const values = new Set([
      providersFor(index, 'Commercial cleaning', 'TX'),
      providersFor(index, 'Commercial cleaning', 'IL'),
      providersFor(index, 'Janitorial', 'TX'),
      providersFor(index, 'Window cleaning', 'TX'),
    ]);
    expect(values.size).toBeGreaterThanOrEqual(3);
  });
});
