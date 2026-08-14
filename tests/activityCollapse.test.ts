import { describe, it, expect } from 'vitest';
import { collapseRepeats, type Collapsible } from '@/lib/activity/collapse';

/**
 * A feed that says the same thing four times has told you nothing four times.
 *
 * The audit counted 26 activity rows and 37 AI-decision rows that repeated an
 * identical line, and the worst offender restated one next action three times
 * on an opportunity nobody had touched. The real event on that timeline — a
 * call — was underneath all of it.
 */

const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000);

const event = (over: Partial<Collapsible> & { id: string }): Collapsible => ({
  createdAt: at(1),
  summary: 'Next action: confirm timeline',
  actorType: 'ai',
  verb: 'next_action.set',
  ...over,
});

describe('collapseRepeats', () => {
  it('leaves distinct entries alone', () => {
    const collapsed = collapseRepeats([
      event({ id: 'a', summary: 'Call logged' }),
      event({ id: 'b', summary: 'Next action: confirm timeline' }),
    ]);
    expect(collapsed).toHaveLength(2);
    expect(collapsed.every((c) => c.repeats === 1 && c.note === null)).toBe(true);
  });

  it('folds a consecutive run into one line that keeps the newest entry', () => {
    const collapsed = collapseRepeats([
      event({ id: 'newest', createdAt: at(1) }),
      event({ id: 'middle', createdAt: at(5) }),
      event({ id: 'oldest', createdAt: at(9) }),
    ]);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].entry.id).toBe('newest');
    expect(collapsed[0].repeats).toBe(3);
    expect(collapsed[0].note).toMatch(/restated 3 times/);
  });

  it('does not merge a conclusion that changed and came back', () => {
    // Returning to an earlier conclusion is information: something moved and
    // moved back. Flattening the two stretches would erase that.
    const collapsed = collapseRepeats([
      event({ id: 'a', summary: 'Next action: confirm timeline', createdAt: at(1) }),
      event({ id: 'b', summary: 'Next action: chase the quote', createdAt: at(4) }),
      event({ id: 'c', summary: 'Next action: confirm timeline', createdAt: at(8) }),
    ]);
    expect(collapsed).toHaveLength(3);
  });

  it('keeps a person saying the same thing as the engine separate', () => {
    const collapsed = collapseRepeats([
      event({ id: 'a', actorType: 'user' }),
      event({ id: 'b', actorType: 'ai' }),
    ]);
    // Somebody agreeing by hand is not the engine repeating itself.
    expect(collapsed).toHaveLength(2);
  });

  it('keeps identical summaries under different verbs separate', () => {
    const collapsed = collapseRepeats([
      event({ id: 'a', verb: 'next_action.set', summary: 'same words' }),
      event({ id: 'b', verb: 'deal.blocked', summary: 'same words' }),
    ]);
    expect(collapsed).toHaveLength(2);
  });

  it('describes the span so a reader can tell a rerun from a fortnight of drift', () => {
    const quick = collapseRepeats([
      event({ id: 'a', createdAt: at(0) }),
      event({ id: 'b', createdAt: at(1) }),
    ]);
    const long = collapseRepeats([
      event({ id: 'a', createdAt: at(0) }),
      event({ id: 'b', createdAt: at(24 * 6) }),
    ]);
    expect(quick[0].note).toMatch(/in quick succession/);
    expect(long[0].note).toMatch(/over 6 days/);
  });

  it('reports the start of a run, not just its end', () => {
    const collapsed = collapseRepeats([
      event({ id: 'a', createdAt: at(1) }),
      event({ id: 'b', createdAt: at(50) }),
    ]);
    expect(collapsed[0].firstAt.getTime()).toBeLessThan(collapsed[0].entry.createdAt.getTime());
  });

  it('handles an empty feed', () => {
    expect(collapseRepeats([])).toEqual([]);
  });
});
