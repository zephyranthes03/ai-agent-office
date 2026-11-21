// Choices the page remembers on this device (localStorage). Storage may be missing or refuse
// (private windows, blocked site data): a choice that cannot be read keeps its default, one that
// cannot be stored lasts only as long as the page, and either is warned about by name.

/**
 * The stored choice under `key` through `parse` (given null when nothing is stored), or `fallback`
 * when storage cannot be read or `parse` throws; `warning` says which choice in that case.
 */
export function readChoice<T>(key: string, warning: string, fallback: T, parse: (stored: string | null) => T): T {
  let value = fallback;
  try {
    value = parse(localStorage.getItem(key));
  } catch (error) {
    console.warn(`agent-office: ${warning}`, error);
  }
  return value;
}

/** Stores `value` under `key` (null removes it); `warning` says which choice when storage refuses. */
export function writeChoice(key: string, value: string | null, warning: string): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch (error) {
    console.warn(`agent-office: ${warning}`, error);
  }
}
