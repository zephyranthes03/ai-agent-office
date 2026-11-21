// How often the daemon polls the agents' logs and limits: a first-match table modelled on
// CodexBar's. Session state never polls; it is event-driven. Pure: the caller says how long ago
// things happened.

export type RefreshInputs = {
  /** Low-power mode or thermal pressure reported by the platform. */
  constrained: boolean;
  /** Seconds since the UI was last open, or null when it never was. */
  uiOpenedAgoS: number | null;
  /** Seconds since the last agent signal, or null when there was none. */
  activityAgoS: number | null;
};

/** The contract's bounds: never more often than every 2 minutes, never less than every 30. */
export const REFRESH_MIN_S = 120;
export const REFRESH_MAX_S = 1800;

const within = (ago: number | null, limitS: number): boolean => ago !== null && ago < limitS;

/**
 * The polling interval in seconds. Rows, first match: constrained → 30 min; UI opened within 5 min →
 * 2 min; within 1 h → 5 min; agent activity within 5 min → 5 min; within 4 h → 15 min; otherwise
 * 30 min. (The table names activity "within 5 min" and "1–4 h"; between 5 min and 1 h the 15-minute
 * row applies, the slower of the two neighbours.)
 */
export function refreshIntervalS(inputs: RefreshInputs): number {
  if (inputs.constrained) return 1800;
  if (within(inputs.uiOpenedAgoS, 300)) return 120;
  if (within(inputs.uiOpenedAgoS, 3600)) return 300;
  if (within(inputs.activityAgoS, 300)) return 300;
  if (within(inputs.activityAgoS, 4 * 3600)) return 900;
  return 1800;
}

/**
 * The local day (YYYY-MM-DD) an instant belongs to, in an IANA time zone, for days that start at
 * `dayStartsAt` (HH:MM, usage.day_starts_at). Days are shifted in absolute time, so on a daylight
 * saving change the boundary can be an hour off for that one day.
 */
export function localDay(at: string, timeZone: string, dayStartsAt = "00:00"): string {
  const [hours = 0, minutes = 0] = dayStartsAt.split(":").map(Number);
  const shifted = new Date(Date.parse(at) - (hours * 60 + minutes) * 60_000);
  return dayFormat(timeZone).format(shifted);
}

// Building a formatter costs far more than formatting with one, and roll-ups format every sample.
const dayFormats = new Map<string, Intl.DateTimeFormat>();

function dayFormat(timeZone: string): Intl.DateTimeFormat {
  let format = dayFormats.get(timeZone);
  if (format === undefined) {
    // en-CA formats dates as YYYY-MM-DD.
    format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    dayFormats.set(timeZone, format);
  }
  return format;
}

const DAY_MS = 86_400_000;

/** The first instant (epoch ms) of a local day: the inverse of `localDay`, found by bisection so the two always agree. */
export function dayStart(day: string, timeZone: string, dayStartsAt = "00:00"): number {
  const midnightUtc = Date.parse(`${day}T00:00:00Z`);
  // The zone's offset (±14 h) and the day's start (< 24 h) keep the answer inside this range.
  let before = midnightUtc - DAY_MS;
  let from = midnightUtc + 2 * DAY_MS;
  while (from - before > 1) {
    const mid = Math.floor((before + from) / 2);
    if (localDay(new Date(mid).toISOString(), timeZone, dayStartsAt) < day) before = mid;
    else from = mid;
  }
  return from;
}

/** The local day `n` days after `day` (YYYY-MM-DD arithmetic, no zone involved). */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}
