/**
 * What time it is where the business is.
 *
 * A hard exclusion, not a scoring factor. No priority a record can accumulate
 * justifies ringing a gym at four in the morning, so a closed-hours record is
 * removed from the servable set rather than pushed down it — a bonus large
 * enough to outrank everything else is exactly how a 4 a.m. call happens.
 *
 * Where the timezone is unknown, the answer is "unknown" and the record loses
 * preference. It is never assumed to be the caller's own timezone, and never
 * assumed to be Eastern: a wrong guess produces confident calls at the wrong
 * hour, which is worse than a record that waits.
 */

export type LocalHours = {
  /** Null when the timezone is genuinely unknown. */
  timezone: string | null;
  /** Null when the timezone is unknown, so it cannot be checked. */
  localHour: number | null;
  open: boolean;
  /** Why, in the operator's words. */
  reason: string;
};

/**
 * US states to their predominant IANA timezone.
 *
 * Predominant, and that word is doing real work: several states are split, and
 * this is the majority zone rather than a claim about any given address. It is
 * good enough to keep a call inside business hours and not good enough to be
 * presented as the business's timezone, which is why nothing displays it as a
 * fact about them.
 */
const STATE_TIMEZONES: Record<string, string> = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: 'America/Chicago',
  CA: 'America/Los_Angeles', CO: 'America/Denver', CT: 'America/New_York', DE: 'America/New_York',
  DC: 'America/New_York', FL: 'America/New_York', GA: 'America/New_York', HI: 'Pacific/Honolulu',
  ID: 'America/Denver', IL: 'America/Chicago', IN: 'America/New_York', IA: 'America/Chicago',
  KS: 'America/Chicago', KY: 'America/New_York', LA: 'America/Chicago', ME: 'America/New_York',
  MD: 'America/New_York', MA: 'America/New_York', MI: 'America/New_York', MN: 'America/Chicago',
  MS: 'America/Chicago', MO: 'America/Chicago', MT: 'America/Denver', NE: 'America/Chicago',
  NV: 'America/Los_Angeles', NH: 'America/New_York', NJ: 'America/New_York', NM: 'America/Denver',
  NY: 'America/New_York', NC: 'America/New_York', ND: 'America/Chicago', OH: 'America/New_York',
  OK: 'America/Chicago', OR: 'America/Los_Angeles', PA: 'America/New_York', RI: 'America/New_York',
  SC: 'America/New_York', SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago',
  UT: 'America/Denver', VT: 'America/New_York', VA: 'America/New_York', WA: 'America/Los_Angeles',
  WV: 'America/New_York', WI: 'America/Chicago', WY: 'America/Denver',
  PR: 'America/Puerto_Rico', VI: 'America/Puerto_Rico', GU: 'Pacific/Guam',
};

/**
 * Ordinary commercial calling hours, local to the business.
 *
 * Configurable because operations differ — some call until eight in the
 * evening, some stop at four — and a hard-coded window is a rule that gets
 * worked around rather than changed. The defaults are the conservative ones;
 * widening it is a deliberate decision somebody makes in the environment, and
 * it applies to the prospect's local time, never to the caller's.
 */
function windowHour(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  // An unset variable is not zero. `Number('')` is 0, which passes every
  // sanity check and quietly moves the window to midnight — so the presence of
  // a value is tested before its value is.
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 24 ? parsed : fallback;
}

export const CALLING_WINDOW = {
  get startHour() {
    return windowHour('CALLING_WINDOW_START', 8);
  },
  get endHour() {
    return windowHour('CALLING_WINDOW_END', 18);
  },
};

export function timezoneForState(stateCode: string | null | undefined): string | null {
  if (!stateCode) return null;
  return STATE_TIMEZONES[stateCode.trim().toUpperCase()] ?? null;
}

/** The hour of the day at a given timezone, or null when it cannot be known. */
export function hourIn(timezone: string | null, now: Date = new Date()): number | null {
  if (!timezone) return null;
  try {
    const formatted = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    }).format(now);
    const hour = Number(formatted);
    return Number.isFinite(hour) ? hour % 24 : null;
  } catch {
    // An unrecognised zone is unknown, not midnight.
    return null;
  }
}

/** The day of the week at a given timezone. 0 is Sunday. */
export function weekdayIn(timezone: string | null, now: Date = new Date()): number | null {
  if (!timezone) return null;
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(now);
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
  } catch {
    return null;
  }
}

/**
 * Whether this business can be called right now.
 *
 * An unknown timezone reports `open: false` with `timezone: null`, and the
 * caller of this function decides what that means. Serving treats it as
 * lower preference rather than exclusion, because a record that can never be
 * called is worse than one called at a slightly odd hour — but the two cases
 * are kept distinguishable so that choice is made in one place, visibly.
 */
export function localHours(input: {
  stateCode: string | null | undefined;
  timezone?: string | null;
  now?: Date;
}): LocalHours {
  const now = input.now ?? new Date();
  const timezone = input.timezone ?? timezoneForState(input.stateCode);

  if (!timezone) {
    return {
      timezone: null,
      localHour: null,
      open: false,
      reason: 'No location on this record, so the local time cannot be known. Not assumed.',
    };
  }

  const hour = hourIn(timezone, now);
  const weekday = weekdayIn(timezone, now);
  if (hour === null) {
    return { timezone, localHour: null, open: false, reason: `Could not read the local time in ${timezone}.` };
  }

  if (weekday === 0 || weekday === 6) {
    return {
      timezone,
      localHour: hour,
      open: false,
      reason: `It is the weekend where they are (${timezone}).`,
    };
  }

  const open = hour >= CALLING_WINDOW.startHour && hour < CALLING_WINDOW.endHour;
  return {
    timezone,
    localHour: hour,
    open,
    reason: open
      ? `${String(hour).padStart(2, '0')}:00 where they are.`
      : `${String(hour).padStart(2, '0')}:00 where they are — outside ${CALLING_WINDOW.startHour}:00–${CALLING_WINDOW.endHour}:00.`,
  };
}
