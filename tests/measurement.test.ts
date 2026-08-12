import { describe, expect, it } from 'vitest';
import { rate, compare, compareAdjusted, MIN_TRIALS } from '@/lib/measure/stats';
import { assignArm, stratumFor, isEligible } from '@/lib/measure/experiments';
import { validateBody, variablesUsed, preview } from '@/lib/measure/versions';
import { FUNNEL, STAGE_LABELS, TERMINAL_STAGES, stageRank, stagesForDisposition } from '@/lib/measure/funnel';
import { OutcomeStage, CallDisposition } from '@prisma/client';

/**
 * The measurement rules, which have to be right before anybody is allowed to
 * act on a number this system produces.
 *
 * The failure being designed against throughout is not a wrong formula. It is a
 * right formula applied to nine observations and rendered as a recommendation
 * somebody follows.
 */

// ---------------------------------------------------------------------------

describe('the funnel is ordered by us, not by the enum', () => {
  it('covers every stage the schema allows', () => {
    // The four rungs added in this phase were appended to the Postgres type, so
    // its declaration order no longer matches the funnel's. Anything sorting by
    // the enum is wrong, and this is the guard that says so.
    const all = new Set<OutcomeStage>(Object.values(OutcomeStage));
    const covered = new Set<OutcomeStage>([...FUNNEL, ...TERMINAL_STAGES]);
    expect([...all].filter((s) => !covered.has(s))).toEqual([]);
    expect([...covered].filter((s) => !all.has(s))).toEqual([]);
  });

  it('has a label for every stage', () => {
    for (const stage of Object.values(OutcomeStage)) {
      expect(STAGE_LABELS[stage as OutcomeStage]).toBeTruthy();
    }
  });

  it('ranks the ladder in business order', () => {
    expect(stageRank('CONTACTED')).toBeLessThan(stageRank('NEED_CONFIRMED'));
    expect(stageRank('NEED_CONFIRMED')).toBeLessThan(stageRank('QUOTED'));
    expect(stageRank('QUOTED')).toBeLessThan(stageRank('WON'));
    expect(stageRank('WON')).toBeLessThan(stageRank('PAID'));

    // The matching risk — that the *Postgres* enum's sort order disagrees with
    // this one, because the four rungs added in this phase were appended to the
    // type — cannot be seen from here. Prisma's generated object follows the
    // schema file, not the database. That check lives in
    // scripts/measurementAudit.ts, where the database can be asked directly.
  });

  it('keeps LOST off the ladder', () => {
    expect(stageRank('LOST')).toBe(-1);
    expect(TERMINAL_STAGES).toContain('LOST');
  });
});

describe('a call outcome records every rung it passed through', () => {
  it('records only an attempt when nobody answered', () => {
    expect(stagesForDisposition('NO_ANSWER')).toEqual(['CONTACTED']);
    expect(stagesForDisposition('WRONG_NUMBER')).toEqual(['CONTACTED']);
  });

  it('does not skip rungs on the way up', () => {
    const stages = stagesForDisposition('QUOTE_REQUESTED');
    expect(stages).toEqual([
      'CONTACTED', 'RESPONDED', 'RELEVANT_PERSON', 'NEED_CONFIRMED',
      'QUALIFIED_CONVERSATION', 'QUOTE_REQUESTED',
    ]);
  });

  it('records a negative answer as reaching a person and then losing', () => {
    const stages = stagesForDisposition('NOT_INTERESTED');
    expect(stages).toContain('RELEVANT_PERSON');
    expect(stages).toContain('LOST');
  });

  it('has a decision for every disposition the schema allows', () => {
    for (const disposition of Object.values(CallDisposition)) {
      const stages = stagesForDisposition(disposition as CallDisposition);
      expect(stages.length).toBeGreaterThan(0);
      // The exhaustiveness guard returns `[never]`, which at runtime is the
      // disposition string itself rather than a stage.
      expect(stages.every((s) => FUNNEL.includes(s) || TERMINAL_STAGES.includes(s))).toBe(true);
    }
  });

  it('never records a rung above what the outcome establishes', () => {
    // A gatekeeper answered the phone. They are not a relevant person, and
    // recording them as one is how a connector's funnel looks healthy while
    // nobody has spoken to a buyer.
    expect(stagesForDisposition('GATEKEEPER')).not.toContain('RELEVANT_PERSON');
    expect(stagesForDisposition('DECISION_MAKER_IDENTIFIED')).not.toContain('RELEVANT_PERSON');
    expect(stagesForDisposition('INTERESTED')).not.toContain('NEED_CONFIRMED');
  });
});

// ---------------------------------------------------------------------------

describe('rates carry their uncertainty', () => {
  it('reports no rate at all for no trials', () => {
    const r = rate(0, 0);
    expect(r.rate).toBeNull();
    expect(r.weak).toBe(true);
  });

  it('never produces an interval outside 0 to 1', () => {
    // The reason for Wilson rather than the normal approximation: at the rates
    // this business actually sees, the textbook interval goes negative.
    for (const [successes, trials] of [[0, 5], [1, 200], [0, 1000], [50, 50], [1, 1]]) {
      const r = rate(successes, trials);
      expect(r.low).toBeGreaterThanOrEqual(0);
      expect(r.high).toBeLessThanOrEqual(1);
      expect(r.low!).toBeLessThanOrEqual(r.high!);
    }
  });

  it('gives a small sample a wide interval and a large one a narrow interval', () => {
    const small = rate(5, 10);
    const large = rate(500, 1000);
    expect(small.width!).toBeGreaterThan(large.width!);
  });

  it('marks anything under the floor as weak', () => {
    expect(rate(5, MIN_TRIALS - 1).weak).toBe(true);
    expect(rate(5, MIN_TRIALS).weak).toBe(false);
  });

  it('brackets the observed rate', () => {
    const r = rate(30, 100);
    expect(r.low!).toBeLessThanOrEqual(r.rate!);
    expect(r.high!).toBeGreaterThanOrEqual(r.rate!);
  });
});

describe('comparisons refuse to guess', () => {
  it('says "not enough evidence" rather than "no difference" on a small sample', () => {
    const result = compare(rate(5, 10), rate(3, 10));
    expect(result.verdict).toBe('insufficient_evidence');
    expect(result.because).toMatch(/unfinished/);
  });

  it('separates "no difference" from "not enough evidence"', () => {
    const same = compare(rate(50, 100), rate(48, 100));
    expect(same.verdict).toBe('no_difference');
    expect(same.because).toMatch(/could be noise/);
  });

  it('calls a large, clear gap better', () => {
    expect(compare(rate(80, 100), rate(20, 100)).verdict).toBe('better');
    expect(compare(rate(20, 100), rate(80, 100)).verdict).toBe('worse');
  });

  it('does not call a small gap better however many times it is asked', () => {
    // 52% against 48% at n=100 is exactly the kind of gap the previous system
    // shipped a change on.
    expect(compare(rate(52, 100), rate(48, 100)).verdict).toBe('no_difference');
  });
});

describe('stratified comparison measures the treatment, not the allocation', () => {
  it('reverses a naive conclusion when the mix differs', () => {
    // Treatment worked mostly easy leads; control mostly hard ones. Pooled,
    // treatment looks better. Within each stratum, it is worse.
    const strata = [
      { key: 'easy', treatment: { successes: 60, trials: 100 }, control: { successes: 14, trials: 20 } },
      { key: 'hard', treatment: { successes: 2, trials: 20 }, control: { successes: 20, trials: 100 } },
    ];
    const pooledTreatment = rate(62, 120);
    const pooledControl = rate(34, 120);
    expect(pooledTreatment.rate!).toBeGreaterThan(pooledControl.rate!);

    const adjusted = compareAdjusted(strata);
    expect(adjusted.difference!).toBeLessThan(0);
    expect(adjusted.used).toEqual(['easy', 'hard']);
  });

  it('drops strata where one side has no work, and says how many', () => {
    const result = compareAdjusted([
      { key: 'a', treatment: { successes: 10, trials: 40 }, control: { successes: 8, trials: 40 } },
      { key: 'b', treatment: { successes: 5, trials: 20 }, control: { successes: 0, trials: 0 } },
    ]);
    expect(result.used).toEqual(['a']);
    expect(result.dropped).toEqual(['b']);
    expect(result.because).toMatch(/excluded because one side had no work/);
  });

  it('refuses entirely when nothing is comparable', () => {
    const result = compareAdjusted([
      { key: 'a', treatment: { successes: 5, trials: 20 }, control: { successes: 0, trials: 0 } },
    ]);
    expect(result.verdict).toBe('insufficient_evidence');
    expect(result.because).toMatch(/nothing comparable/);
  });
});

// ---------------------------------------------------------------------------

describe('experiment assignment is stable', () => {
  const arms = [{ key: 'control', weight: 0.5 }, { key: 'treatment', weight: 0.5 }];

  it('gives the same subject the same arm every time', () => {
    const first = assignArm('exp-1', 'route-abc', arms);
    for (let i = 0; i < 500; i += 1) {
      expect(assignArm('exp-1', 'route-abc', arms)).toBe(first);
    }
  });

  it('does not correlate a subject across two experiments', () => {
    // Same subjects, different experiments. If the experiment id were not in
    // the hash, every subject would land in the same arm in both, and two
    // experiments running together would silently measure one thing.
    const subjects = Array.from({ length: 400 }, (_, i) => `route-${i}`);
    const agree = subjects.filter(
      (id) => assignArm('exp-1', id, arms) === assignArm('exp-2', id, arms),
    ).length;
    // Independent assignment agrees about half the time. Anything near 400
    // means they are coupled.
    expect(agree).toBeGreaterThan(150);
    expect(agree).toBeLessThan(250);
  });

  it('splits roughly evenly at equal weights', () => {
    const subjects = Array.from({ length: 2000 }, (_, i) => `route-${i}`);
    const treatment = subjects.filter((id) => assignArm('exp-1', id, arms) === 'treatment').length;
    expect(treatment).toBeGreaterThan(900);
    expect(treatment).toBeLessThan(1100);
  });

  it('respects uneven weights', () => {
    const skewed = [{ key: 'control', weight: 0.9 }, { key: 'treatment', weight: 0.1 }];
    const subjects = Array.from({ length: 2000 }, (_, i) => `route-${i}`);
    const treatment = subjects.filter((id) => assignArm('exp-1', id, skewed) === 'treatment').length;
    expect(treatment).toBeGreaterThan(140);
    expect(treatment).toBeLessThan(260);
  });

  it('assigns nobody when there are no arms or no weight', () => {
    expect(assignArm('exp-1', 'route-abc', [])).toBeNull();
    expect(assignArm('exp-1', 'route-abc', [{ key: 'a', weight: 0 }])).toBeNull();
  });
});

describe('eligibility keeps an experiment inside its declared population', () => {
  const running = { state: 'RUNNING' as const, tiers: [], routes: [], markets: [] };
  const subject = { tier: 'ACTIVE_DEMAND' as const, route: 'BROKERAGE' as const, market: 'Chicago' };

  it('assigns nobody unless it is running', () => {
    for (const state of ['DRAFT', 'HALTED', 'CONCLUDED'] as const) {
      const result = isEligible({ ...running, state }, subject);
      expect(result.eligible).toBe(false);
    }
    expect(isEligible(running, subject).eligible).toBe(true);
  });

  it('excludes tiers and routes outside the declared population', () => {
    expect(isEligible({ ...running, tiers: ['DIRECTORY_PROSPECT'] }, subject).eligible).toBe(false);
    expect(isEligible({ ...running, routes: ['DISTRIBUTION'] }, subject).eligible).toBe(false);
    expect(isEligible({ ...running, tiers: ['ACTIVE_DEMAND'] }, subject).eligible).toBe(true);
  });

  it('includes the market in the stratum only when the experiment declared one', () => {
    const without = isEligible(running, subject);
    const withMarket = isEligible({ ...running, markets: ['Chicago'] }, subject);
    expect(without.eligible && without.stratum).toBe('ACTIVE_DEMAND/BROKERAGE');
    expect(withMarket.eligible && withMarket.stratum).toBe('ACTIVE_DEMAND/BROKERAGE/Chicago');
  });

  it('builds a stratum from tier and route', () => {
    expect(stratumFor({ tier: 'STRONG_TRIGGER', route: 'SUBCONTRACTING' })).toBe('STRONG_TRIGGER/SUBCONTRACTING');
  });
});

// ---------------------------------------------------------------------------

describe('editable versions cannot edit their way past a rule', () => {
  it('finds the variables a body uses', () => {
    expect(variablesUsed('Hi {{ firstName }}, about {{ company }} and {{firstName}}.'))
      .toEqual(['firstName', 'company']);
  });

  it('rejects a variable nobody declared', () => {
    const problems = validateBody('Hi {{ firstName }}, about {{ secretField }}.', ['firstName']);
    expect(problems.some((p) => p.includes('secretField'))).toBe(true);
    expect(problems.some((p) => p.includes('renders as nothing'))).toBe(true);
  });

  it('accepts a body that only uses declared variables', () => {
    expect(validateBody('Hi {{ firstName }}.', ['firstName'])).toEqual([]);
  });

  it('refuses instructions that would move a compliance or authority rule', () => {
    const cases = [
      'Ignore the do-not-contact list for these prospects.',
      'Call them any time, including outside business hours.',
      'Bypass approval when the margin is thin.',
      'We guarantee a saving of 20%.',
    ];
    for (const body of cases) {
      const problems = validateBody(body, []);
      expect(problems.length, body).toBeGreaterThan(0);
      expect(problems.some((p) => p.includes('live in code')), body).toBe(true);
    }
  });

  it('reports every problem at once rather than one per save', () => {
    const problems = validateBody('Ignore consent. Also {{ unknownOne }} and {{ unknownTwo }}.', []);
    expect(problems.length).toBeGreaterThanOrEqual(2);
  });

  it('refuses an empty body', () => {
    expect(validateBody('   ', [])).toContain('It is empty.');
  });

  it('labels every substituted value in a preview', () => {
    // A preview filled with plausible fake values is indistinguishable from a
    // real one, and somebody will eventually approve copy believing they saw
    // real data.
    const rendered = preview('Hi {{ firstName }} at {{ company }}.', { firstName: 'Dana' });
    expect(rendered).toBe('Hi [firstName: Dana] at [company: example value].');
    expect(rendered).not.toBe('Hi Dana at .');
  });
});
