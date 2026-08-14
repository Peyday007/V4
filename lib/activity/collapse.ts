/**
 * Consecutive restatements read as one line.
 *
 * The writers now refuse to record a derived conclusion that repeats the last
 * one, which fixes the future. It does not fix the history already written,
 * and it never could have fixed all of it: two runs an hour apart can each say
 * something true and still say the same thing, and a feed that shows
 *
 *   2 days ago · ai   Next action: confirm timeline — the need is recorded…
 *   2 days ago · ai   Next action: confirm timeline — the need is recorded…
 *   3 days ago · ai   Next action: confirm timeline — the need is recorded…
 *
 * has spent three lines telling the reader nothing three times, and buried the
 * call that actually happened underneath. Collapsing them keeps every row —
 * nothing is deleted and the count is shown — while giving the repetition the
 * one line it is worth.
 *
 * Only *consecutive* runs collapse. If a conclusion changes and later returns,
 * that is two separate stretches and they stay separate, because coming back
 * is information.
 */

export type Collapsible = {
  id: string;
  createdAt: Date;
  summary: string;
  actorType?: string;
  verb?: string;
};

export type CollapsedEntry<T extends Collapsible> = {
  /** The most recent of the run, and the one to link to. */
  entry: T;
  /** How many consecutive entries said this. 1 means it did not repeat. */
  repeats: number;
  /** When the run started — the oldest of the stretch. */
  firstAt: Date;
  /** A phrase for the extra ones, or null when there are none. */
  note: string | null;
};

/**
 * Collapses a newest-first list.
 *
 * Two entries belong to the same run when the same actor said the same thing
 * about the same verb. Deliberately including the actor: a person writing the
 * same note the engine had written is not the engine repeating itself, and
 * flattening the two would hide that somebody agreed by hand.
 */
export function collapseRepeats<T extends Collapsible>(entries: T[]): Array<CollapsedEntry<T>> {
  const out: Array<CollapsedEntry<T>> = [];

  for (const entry of entries) {
    const open = out[out.length - 1];
    const sameRun =
      open
      && open.entry.summary === entry.summary
      && open.entry.verb === entry.verb
      && open.entry.actorType === entry.actorType;

    if (sameRun) {
      open.repeats += 1;
      // The list is newest-first, so each further match is older.
      open.firstAt = entry.createdAt;
      open.note = describe(open.repeats, open.firstAt, open.entry.createdAt);
      continue;
    }

    out.push({ entry, repeats: 1, firstAt: entry.createdAt, note: null });
  }

  return out;
}

function describe(repeats: number, firstAt: Date, lastAt: Date): string {
  const hours = Math.round((lastAt.getTime() - firstAt.getTime()) / 3_600_000);
  const span =
    hours >= 48 ? `over ${Math.round(hours / 24)} days` : hours >= 2 ? `over ${hours} hours` : 'in quick succession';
  // "Restated", not "repeated": the engine reaching the same conclusion again
  // is not an error, it is just not news, and the wording should not imply a
  // fault that is not there.
  return `restated ${repeats} times ${span}`;
}
