// Claude Code's session title, the one its apps show in their session lists: a `custom-title` line
// (set by the desktop app or the owner) or, without one, an `ai-title` line Claude Code writes from
// the first turn. Pure: text in, the newest such title out; nothing else of a line is kept.

const TITLE_KEYS: Record<string, string> = { "custom-title": "customTitle", "ai-title": "aiTitle" };

/**
 * The newest `customTitle` of the text, else its newest `aiTitle`; null when there is neither (a new
 * session, or a title line before the tail that was read). A cut first line and lines of other
 * shapes are skipped. The caller clips it for display.
 */
export function transcriptTitle(content: string): string | null {
  let ai: string | null = null;
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes("-title")) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      continue;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const type = record["type"];
    if (typeof type !== "string" || !Object.hasOwn(TITLE_KEYS, type)) continue;
    const title = record[TITLE_KEYS[type]!];
    if (typeof title !== "string" || title.trim() === "") continue;
    if (type === "custom-title") return title;
    ai ??= title;
  }
  return ai;
}
