// Claude Code's Esc, which sends no hook: when the owner interrupts a turn or turns down a request,
// Claude Code writes a `user` line whose only content is one of two fixed markers. Pure: text in,
// the time of that line out. A line's message is compared with the markers and nothing else is
// kept; a line that only mentions a marker (in its text, a tool result, a string body) is not one.

/** The texts Claude Code writes on Esc: a turn interrupted, and a tool or a request interrupted. */
export const INTERRUPT_MARKERS: readonly string[] = ["[Request interrupted by user]", "[Request interrupted by user for tool use]"];

const isMarker = (content: unknown): boolean => {
  if (!Array.isArray(content) || content.length !== 1) return false;
  const part = content[0] as Record<string, unknown> | null;
  return part !== null && typeof part === "object" && part["type"] === "text" && INTERRUPT_MARKERS.includes(part["text"] as string);
};

/**
 * The `timestamp` of the newest `user` line when that line is an interrupt marker; null when the
 * newest user line is anything else (a prompt or a tool result came after), or there is none. A cut
 * first line of a tail read and lines of other shapes are skipped.
 */
export function interruptedAt(content: string): string | null {
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"user"')) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      continue;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (record["type"] !== "user") continue;
    const message = record["message"] as Record<string, unknown> | null | undefined;
    const at = record["timestamp"];
    if (message === null || typeof message !== "object" || !isMarker(message["content"])) return null;
    return typeof at === "string" && !Number.isNaN(Date.parse(at)) ? at : null;
  }
  return null;
}
