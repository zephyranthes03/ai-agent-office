// Timestamp arithmetic on ISO 8601 strings. Comparisons go through epoch milliseconds, never
// through the strings themselves (`Z` and `.000Z` spell the same instant). A timestamp must carry
// its offset: without one, parsing would depend on the host's time zone.

const HAS_OFFSET = /(Z|[+-]\d\d:?\d\d)$/;

export function toMs(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms) || !HAS_OFFSET.test(iso)) throw new RangeError(`not an ISO 8601 timestamp with an offset: ${iso}`);
  return ms;
}

export function addSeconds(iso: string, seconds: number): string {
  return new Date(toMs(iso) + seconds * 1000).toISOString();
}

/** Seconds from `from` to `to`; negative when `to` is earlier. */
export function elapsedSeconds(from: string, to: string): number {
  return (toMs(to) - toMs(from)) / 1000;
}

/** `at` is at or after `deadline`. */
export function reached(at: string, deadline: string): boolean {
  return toMs(at) >= toMs(deadline);
}
