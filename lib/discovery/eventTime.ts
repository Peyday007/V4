/**
 * Event time versus discovery time.
 *
 * These were conflated, and the interface said two contradictory things on the
 * same card: "Source gave no publication date" next to "Published 0 days ago —
 * still current". Both were rendered honestly from different fields. One read
 * `sourcePublishedAt`, which was null. The other read `observedAt`, which is
 * when our ingest wrote the row, and then printed it with the word
 * "Published".
 *
 * The distinction is not cosmetic. Ingestion time is under our control and is
 * always today on a first run, so ranking by it makes every record maximally
 * fresh and a backlog look like a windfall. This module makes that mistake
 * unrepresentable: freshness takes a nullable event date and returns null when
 * there is not one, and there is no overload that accepts a discovery date.
 */

export type Freshness = 'FRESH' | 'RECENT' | 'AGEING' | 'STALE';

export type EventRecency =
  | { known: true; freshness: Freshness; days: number; label: string }
  | { known: false; freshness: null; days: null; label: string };

/** Weight for a known event age. Unknown ages get no weight at all, ever. */
export const FRESHNESS_VALUE: Record<Freshness, number> = {
  FRESH: 1.0,
  RECENT: 0.75,
  AGEING: 0.4,
  STALE: 0.15,
};

/**
 * How old the underlying event is, measured from the date the *source* stated.
 *
 * Callers cannot pass an ingestion timestamp here without lying about the
 * argument's name, and the null branch is not optional: a directory listing
 * has no event date, and the correct answer is that its recency is unknown,
 * not that it is fresh.
 */
export function eventRecency(sourcePublishedAt: Date | null | undefined, now = new Date()): EventRecency {
  if (!sourcePublishedAt) {
    return {
      known: false,
      freshness: null,
      days: null,
      label: 'No event date — the source published none, so recency is unknown.',
    };
  }

  const days = Math.max(0, Math.round((now.getTime() - sourcePublishedAt.getTime()) / 86_400_000));
  const freshness: Freshness = days <= 7 ? 'FRESH' : days <= 30 ? 'RECENT' : days <= 90 ? 'AGEING' : 'STALE';

  return {
    known: true,
    freshness,
    days,
    label: {
      FRESH: `Source published this ${days} day(s) ago — still current.`,
      RECENT: `Source published this ${days} days ago. Worth acting on, but the window is narrowing.`,
      AGEING: `Source published this ${days} days ago. A decision may already have been made.`,
      STALE: `Source published this ${days} days ago. Likely resolved; verify before spending a call on it.`,
    }[freshness],
  };
}

/**
 * Whether a date came from the source or from us.
 *
 * Used at the render boundary so that a discovery timestamp can be shown —
 * operators do want to know when a record arrived — without any wording that
 * implies the world did something on that date.
 */
export function describeDiscoveryTime(firstDiscoveredAt: Date, now = new Date()): string {
  const days = Math.max(0, Math.round((now.getTime() - firstDiscoveredAt.getTime()) / 86_400_000));
  if (days === 0) return 'We first saw this record today. That is our timestamp, not an event.';
  return `We first saw this record ${days} day(s) ago. That is our timestamp, not an event.`;
}
