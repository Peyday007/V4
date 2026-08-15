import { describe, expect, it } from 'vitest';
import { compete, scoreCandidate, laneFor, CREDIBILITY_GATE, type Candidate } from '@/lib/demand/competition';
import { playbookByKey, playbooksFor } from '@/lib/demand/playbooks';
import { MINI_PATHS, COMMERCIAL_MODELS, PROVEN_PATH_TARGETS } from '@/lib/universe/registry';
import { assessMiniPath, sourceReachability } from '@/lib/universe/status';

/**
 * One event, one primary reading.
 *
 * The failure these lock down is the one that made a board of 54 routes out of
 * two events: every playbook whose qualifying events matched got a route, so a
 * single licence record arrived on the board as four opportunities and the
 * pipeline total was four times the truth.
 */

const steel = playbookByKey('distribution.materials.steel')!;
const warehousing = playbookByKey('brokerage.warehousing.overflow')!;
const cleaning = playbookByKey('cleaning.brokerage.pre_opening')!;

/** A candidate that is strong on everything except what a test varies. */
function strong(overrides: Partial<Candidate> & Pick<Candidate, 'playbook'>): Candidate {
  return {
    confirmedFacts: [],
    inferredFacts: [],
    providerCount: 4,
    buyerIdentified: true,
    insideWindow: true,
    headline: '',
    scopeText: null,
    ...overrides,
  };
}

describe('acquisition lanes', () => {
  it('calls a published solicitation direct demand', () => {
    expect(laneFor('ACTIVE_RFQ')).toBe('DIRECT_DEMAND');
    expect(laneFor('PROCUREMENT_NOTICE')).toBe('DIRECT_DEMAND');
    expect(laneFor('INBOUND_REQUEST')).toBe('DIRECT_DEMAND');
  });

  it('calls an opening a trigger, because nobody has asked for anything', () => {
    expect(laneFor('OCCUPANCY_OR_OPERATING_APPROVAL')).toBe('TRIGGER_BACKED');
    expect(laneFor('CONTRACT_AWARD')).toBe('TRIGGER_BACKED');
    expect(laneFor('NEW_LOCATION')).toBe('TRIGGER_BACKED');
  });
});

describe('scoring one reading', () => {
  it('rewards a reading the source actually names', () => {
    const scored = scoreCandidate(
      strong({ playbook: steel, headline: 'Structural steel package for bridge rehabilitation' }),
      'TRIGGER_BACKED',
    );
    const fit = scored.dimensions.find((d) => d.key === 'economic_fit')!;
    expect(fit.score).toBeGreaterThan(0);
    expect(fit.because).toMatch(/names this trade/i);
  });

  it('punishes a reading applied from outside the source', () => {
    // The exact failure: a steakhouse licence read as a steel order.
    const scored = scoreCandidate(
      strong({ playbook: steel, headline: 'CHICAGO CUT STEAKHOUSE — retail food establishment licence' }),
      'TRIGGER_BACKED',
    );
    const fit = scored.dimensions.find((d) => d.key === 'economic_fit')!;
    expect(fit.score).toBeLessThan(0);
    expect(fit.because).toMatch(/applied from outside/i);
  });

  it('punishes a reading that rests on the business merely existing', () => {
    const scored = scoreCandidate(
      strong({ playbook: cleaning, confirmedFacts: [], buyerIdentified: false }),
      'TRIGGER_BACKED',
    );
    const penalty = scored.dimensions.find((d) => d.key === 'generic_penalty');
    expect(penalty).toBeDefined();
    expect(penalty!.because).toMatch(/existence is not commercial intent/i);
  });

  it('refuses to count our own inference as evidence for our own inference', () => {
    const withInference = scoreCandidate(
      strong({
        playbook: steel,
        confirmedFacts: [],
        // A pile of confident-sounding conclusions we drew ourselves.
        inferredFacts: ['a dated construction award implying a material requirement', 'an identifiable contractor'],
      }),
      'TRIGGER_BACKED',
    );
    const evidence = withInference.dimensions.find((d) => d.key === 'evidence')!;
    expect(evidence.score).toBeLessThan(1);
    expect(evidence.because).toMatch(/source actually published/i);
  });

  it('treats no deliverable provider as a reason against the reading', () => {
    const scored = scoreCandidate(strong({ playbook: warehousing, providerCount: 0 }), 'TRIGGER_BACKED');
    const supply = scored.dimensions.find((d) => d.key === 'supply')!;
    expect(supply.score).toBeLessThan(0);
    expect(supply.because).toMatch(/could not be quoted/i);
  });
});

describe('the competition', () => {
  it('returns exactly one primary reading when several apply', () => {
    const result = compete({
      eventType: 'CONTRACT_AWARD',
      candidates: [
        strong({ playbook: steel, headline: 'Structural steel supply and erection, Phase 2' }),
        strong({ playbook: cleaning, headline: 'Structural steel supply and erection, Phase 2' }),
      ],
    });

    expect(result.primary).not.toBeNull();
    expect(result.primary!.playbookKey).toBe('distribution.materials.steel');
    // The loser is kept, not deleted — and explicitly not queued.
    expect(result.alternatives).toHaveLength(1);
    expect(result.alternatives[0].lostBecause).toBeTruthy();
    expect(result.verdict).toMatch(/not queued as work/i);
  });

  it('says no credible route rather than picking the least bad one', () => {
    const result = compete({
      eventType: 'OCCUPANCY_OR_OPERATING_APPROVAL',
      candidates: [
        strong({
          playbook: steel,
          headline: 'ALTRUISTIC ESTHETICS — limited business licence',
          buyerIdentified: false,
          providerCount: 0,
          insideWindow: false,
        }),
      ],
    });

    expect(result.primary).toBeNull();
    expect(result.verdict).toMatch(/no commercially credible route is established yet/i);
    // The reading is still kept with its score, so the refusal can be checked.
    expect(result.alternatives).toHaveLength(1);
    expect(result.alternatives[0].total).toBeLessThan(CREDIBILITY_GATE);
  });

  it('never returns more than one primary however many candidates apply', () => {
    const many = playbooksFor('OCCUPANCY_OR_OPERATING_APPROVAL').map((playbook) =>
      strong({ playbook, headline: 'Commercial facility opening, janitorial services required' }),
    );
    expect(many.length).toBeGreaterThan(2);

    const result = compete({ eventType: 'OCCUPANCY_OR_OPERATING_APPROVAL', candidates: many });
    const primaries = result.primary ? 1 : 0;
    expect(primaries).toBeLessThanOrEqual(1);
    expect(result.alternatives.length).toBe(many.length - primaries);
  });

  it('is honest when no playbook covers the event at all', () => {
    const result = compete({ eventType: 'CONTRACT_EXPIRATION', candidates: [] });
    expect(result.primary).toBeNull();
    expect(result.verdict).toMatch(/nothing was invented from it/i);
  });
});

// ---------------------------------------------------------------------------
// The universe
// ---------------------------------------------------------------------------

describe('the opportunity universe', () => {
  it('declares all fourteen commercial models', () => {
    expect(COMMERCIAL_MODELS).toHaveLength(14);
    // Each one has to say who contracts with whom, because that is what makes
    // them legally different rather than differently named.
    for (const model of COMMERCIAL_MODELS) {
      expect(model.contracting.length, model.key).toBeGreaterThan(20);
      expect(model.exposure.length, model.key).toBeGreaterThan(20);
    }
  });

  it('gives every declared path a model that exists', () => {
    const keys = new Set(COMMERCIAL_MODELS.map((m) => m.key));
    for (const path of MINI_PATHS) expect(keys.has(path.model), path.key).toBe(true);
  });

  it('never claims a path is operational without a playbook behind it', () => {
    const reach = sourceReachability();
    for (const path of MINI_PATHS.filter((p) => p.playbookKey === null)) {
      const assessment = assessMiniPath({
        path,
        playbook: undefined,
        reach,
        observed: { routes: 0, qualifiedOpportunities: 0, quotes: 0, wins: 0, completions: 0, collectedGrossProfit: 0, lastRecordAt: null },
      });
      expect(assessment.state, path.key).toBe('TAXONOMY_ONLY');
      // And it must say what would change that, or the honesty is useless.
      expect(assessment.toActivate, path.key).toMatch(/playbook/i);
    }
  });

  it('will not call a path operational until a real record has come through it', () => {
    const reach = sourceReachability();
    const path = MINI_PATHS.find((p) => p.key === 'distribution.materials.steel')!;
    const playbook = playbookByKey(path.playbookKey!)!;
    const empty = { routes: 0, qualifiedOpportunities: 0, quotes: 0, wins: 0, completions: 0, collectedGrossProfit: 0, lastRecordAt: null };

    const untested = assessMiniPath({ path, playbook, reach, observed: empty });
    expect(untested.state).not.toBe('OPERATIONAL');
    expect(untested.toActivate).toMatch(/real record/i);

    const used = assessMiniPath({ path, playbook, reach, observed: { ...empty, routes: 3, lastRecordAt: new Date() } });
    expect(used.state).toBe('OPERATIONAL');
  });

  it('distinguishes a blocked source from one nobody has built', () => {
    const reach = sourceReachability();
    // USAspending answers with a block page, so award collection is configured
    // and prevented — an owner action, not an engineering one.
    expect(reach.blocked.size + reach.reachable.size).toBeGreaterThan(0);
    for (const [, why] of reach.blocked) expect(why.length).toBeGreaterThan(20);
  });

  it('keeps the three paths the owner named declared and playbook-backed', () => {
    for (const key of PROVEN_PATH_TARGETS) {
      const path = MINI_PATHS.find((p) => p.key === key);
      expect(path, key).toBeDefined();
      expect(path!.playbookKey, key).not.toBeNull();
      expect(playbookByKey(path!.playbookKey!), key).toBeDefined();
    }
  });

  it('gives the three named paths genuinely different questions', () => {
    const questions = PROVEN_PATH_TARGETS.map((key) => {
      const path = MINI_PATHS.find((p) => p.key === key)!;
      return playbookByKey(path.playbookKey!)!.verificationQuestions.join(' ').toLowerCase();
    });

    // A warehousing call asks about pallets; a steel call asks about tonnage;
    // a subcontracting call asks who holds the head contract. If any two of
    // these were interchangeable the caller would sound like somebody who had
    // not read the file.
    expect(questions[0]).toMatch(/pallet/);
    expect(questions[1]).toMatch(/tonnage|sections/);
    expect(questions[2]).toMatch(/head contract|onboarding/);

    for (const [i, a] of questions.entries()) {
      for (const [j, b] of questions.entries()) {
        if (i < j) expect(a).not.toBe(b);
      }
    }
  });
});
