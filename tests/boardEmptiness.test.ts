import { describe, it, expect } from 'vitest';
import { firstBrokenStage } from '@/lib/demand/emptyState';

/**
 * An empty board has to say which of three things it is.
 *
 * The board used to answer with "Nothing in this view. That is a result, not an
 * error — the other tabs may have work." It said that while four of eight
 * configured datasets had moved, been withdrawn or lost the columns the parser
 * needed, and a fifth was answering with a filtering appliance's block page.
 * Reassurance is the one thing an operator must not be given when the engine
 * has stopped collecting.
 */

import type { BoardEmptiness } from '@/lib/demand/emptyState';

type Source = BoardEmptiness['sources'][number];

const source = (name: string, reason = 'because'): Source => ({
  connector: name.toLowerCase(),
  name,
  // The bucket a source is in is decided by the caller; these fixtures are
  // passed to the already-bucketed lists, so the field itself is not the thing
  // under test.
  state: 'failing',
  reason,
});

describe('firstBrokenStage', () => {
  it('names collection when every source that ran is failing', () => {
    const broken = firstBrokenStage({
      totalEvents: 0,
      failing: [source('Municipal open data', '403 from the portal')],
      barren: [],
      working: [],
      neverRun: [],
    });
    expect(broken?.stage).toBe('Collection');
    // The operator needs the portal's own words, not "a source failed".
    expect(broken?.detail).toMatch(/403 from the portal/);
    expect(broken?.fix).toMatch(/Source health/);
  });

  it('still names collection when some sources work but the board is empty', () => {
    const broken = firstBrokenStage({
      totalEvents: 0,
      failing: [source('Contract awards')],
      barren: [],
      working: [source('Chicago licences')],
      neverRun: [],
    });
    expect(broken?.stage).toBe('Collection');
    expect(broken?.fix).toMatch(/not covering the gap/);
  });

  it('refuses to call a fetch-everything-keep-nothing run a quiet week', () => {
    const broken = firstBrokenStage({
      totalEvents: 0,
      failing: [],
      barren: [source('Seattle licences', '200 rows returned, all discarded')],
      working: [],
      neverRun: [],
    });
    expect(broken?.stage).toBe('Collection');
    expect(broken?.fix).toMatch(/not a quiet week/);
  });

  it('names scheduling when nothing has ever been attempted', () => {
    const broken = firstBrokenStage({
      totalEvents: 0,
      failing: [],
      barren: [],
      working: [],
      neverRun: [source('Municipal open data')],
    });
    expect(broken?.stage).toBe('Scheduling');
    expect(broken?.fix).toMatch(/recurring worker/);
  });

  it('names routing when events were collected but became no work', () => {
    // A different stage with a different owner: the sources did their job.
    const broken = firstBrokenStage({
      totalEvents: 40,
      failing: [],
      barren: [],
      working: [source('Chicago licences')],
      neverRun: [],
    });
    expect(broken?.stage).toBe('Routing');
    expect(broken?.detail).toMatch(/40 event/);
  });

  it('says nothing is broken when the sources are working and found nothing', () => {
    // The one case where an empty board really is just an empty board.
    expect(
      firstBrokenStage({
        totalEvents: 0,
        failing: [],
        barren: [],
        working: [source('Chicago licences')],
        neverRun: [],
      }),
    ).toBeNull();
  });
});
