import type { ContactResolutionStatus } from '@prisma/client';

/**
 * When to try again.
 *
 * Pure, because the schedule is the part most likely to be wrong in a way that
 * only shows up as a bill: a permanent "nobody publishes a number for this
 * business" retried every minute is a loop that costs money and never changes
 * its answer, and a transient timeout never retried is a record lost forever.
 *
 * The four outcomes get four different schedules on purpose:
 *
 *   transient failure  — short, widening backoff. The provider will come back.
 *   configuration      — slow. Nothing changes until a person sets a variable,
 *                        but checking costs nothing, so it stays scheduled.
 *   nothing found      — fortnightly. New listings appear; not by tea time.
 *   ambiguous          — never automatically. More attempts produce the same
 *                        two candidates. It needs a person, and re-running it
 *                        would bury the fact that it is waiting for one.
 *   resolved           — at the staleness horizon of whatever source it came
 *                        from, which for a licensed directory is also when the
 *                        terms stop letting us rely on the cached value.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Transient backoff, in minutes. Widening, and bounded. */
export const TRANSIENT_BACKOFF_MINUTES = [5, 15, 45, 120, 360];

/** After this many consecutive transient failures the record stops retrying fast. */
export const MAX_TRANSIENT_ATTEMPTS = TRANSIENT_BACKOFF_MINUTES.length;

export const NOTHING_FOUND_DAYS = 14;
export const CONFIGURATION_RECHECK_HOURS = 6;
/** A record whose sources all failed permanently is still re-checked daily. */
export const EXHAUSTED_RECHECK_HOURS = 24;

export type RetryDecision = {
  nextAttemptAt: Date | null;
  /** Plain-language note about what happens next, shown to the operator. */
  note: string;
};

export function nextAttemptFor(input: {
  status: ContactResolutionStatus;
  failureKind?: string | null;
  transientFailures?: number;
  /** How long the source that produced the value stays trustworthy. */
  freshDays?: number;
  now?: Date;
}): RetryDecision {
  const now = input.now ?? new Date();
  const at = (ms: number) => new Date(now.getTime() + ms);

  switch (input.status) {
    case 'RESOLVED': {
      const days = Math.max(1, input.freshDays ?? 30);
      return {
        nextAttemptAt: at(days * DAY),
        note: `Contact held. Re-checked in ${days} days, when the source's data stops being current.`,
      };
    }

    case 'AMBIGUOUS':
      return {
        nextAttemptAt: null,
        // Not scheduled, and that is the point: this is waiting for judgement,
        // not for time to pass.
        note: 'Waiting for a person to choose between the candidates. Retrying would return the same ones.',
      };

    case 'UNRESOLVED':
      return {
        nextAttemptAt: at(NOTHING_FOUND_DAYS * DAY),
        note: `Searched and nothing found. Looked at again in ${NOTHING_FOUND_DAYS} days in case a listing appears.`,
      };

    case 'FAILED': {
      if (input.failureKind === 'configuration') {
        return {
          nextAttemptAt: at(CONFIGURATION_RECHECK_HOURS * HOUR),
          note: `Blocked on configuration. Re-checked every ${CONFIGURATION_RECHECK_HOURS} hours, and immediately if you retry it.`,
        };
      }
      const failures = input.transientFailures ?? 1;
      if (failures >= MAX_TRANSIENT_ATTEMPTS) {
        return {
          nextAttemptAt: at(EXHAUSTED_RECHECK_HOURS * HOUR),
          note: `${failures} consecutive failures. Backed off to once a day rather than retrying continuously.`,
        };
      }
      const minutes = TRANSIENT_BACKOFF_MINUTES[Math.min(failures, TRANSIENT_BACKOFF_MINUTES.length) - 1];
      return {
        nextAttemptAt: at(minutes * MINUTE),
        note: `Temporary failure. Retrying in ${minutes} minutes.`,
      };
    }

    case 'QUEUED':
    case 'IN_PROGRESS':
    default:
      return { nextAttemptAt: now, note: 'Waiting for the next worker pass.' };
  }
}

/**
 * Whether a resolved contact has aged out.
 *
 * Two things happen at the same horizon and it is worth saying both: the number
 * is likely to have changed, and for a licensed directory the terms stop
 * permitting reliance on the cached copy. Either alone would justify
 * re-resolving.
 */
export function isStale(input: { retrievedAt: Date; freshDays: number; now?: Date }): boolean {
  const now = input.now ?? new Date();
  return now.getTime() - input.retrievedAt.getTime() > input.freshDays * DAY;
}

/**
 * A stable summary of the inputs a resolution was based on.
 *
 * When a later source run adds a street address to an event, or a caller fills
 * in a website, the record deserves another attempt even though its schedule
 * says otherwise. Comparing fingerprints is how that is noticed without
 * re-running everything every hour.
 */
export function fingerprintOf(input: {
  name: string;
  addressLine1: string | null;
  cityName: string | null;
  stateCode: string | null;
  postalCode: string | null;
  website: string | null;
  externalPlaceId: string | null;
  /** Values a caller has ruled out; a new one is new information. */
  rejectedValues?: string[];
}): string {
  return [
    input.name.trim().toLowerCase(),
    input.addressLine1?.trim().toLowerCase() ?? '',
    input.cityName?.trim().toLowerCase() ?? '',
    input.stateCode?.trim().toUpperCase() ?? '',
    input.postalCode?.trim() ?? '',
    input.website?.trim().toLowerCase() ?? '',
    input.externalPlaceId ?? '',
    [...(input.rejectedValues ?? [])].sort().join(','),
  ].join('|');
}
