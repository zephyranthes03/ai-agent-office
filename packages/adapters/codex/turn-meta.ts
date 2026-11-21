// Codex's turn settings: who answers a thread's approval requests, read from the tail of the rollout
// the hook names (the adapter's transcript-metadata strategy). Codex writes a `turn_context` line at
// the start of every turn with the turn's `approval_policy` and `approvals_reviewer`; with the
// reviewer `auto_review` (Codex 0.166, the app's "Approve for me") a separate reviewer agent decides
// escalations and the owner is never asked, yet the `PermissionRequest` hook still runs first. Pure:
// text in, the allowlisted keys of the newest turn context out. Messages are never looked at.

/** The keys this strategy may keep; everything else on a line is ignored. */
export const CODEX_TURN_META_KEYS = ["approval_policy", "approvals_reviewer"] as const;

export type CodexTurnMeta = Partial<Record<(typeof CODEX_TURN_META_KEYS)[number], string>>;

const MAX_VALUE = 32;

/**
 * The allowlisted keys of the newest `turn_context` line; null when the text has none (a tail cut
 * before the turn's start, or a file of another shape). A cut first line and lines of other shapes
 * are skipped. Values are strings within 32 characters, as Codex writes them.
 */
export function codexTurnMeta(content: string): CodexTurnMeta | null {
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"turn_context"')) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      continue;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value) || (value as Record<string, unknown>)["type"] !== "turn_context") continue;
    const payload = (value as Record<string, unknown>)["payload"];
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) continue;
    const meta: CodexTurnMeta = {};
    for (const key of CODEX_TURN_META_KEYS) {
      const field = (payload as Record<string, unknown>)[key];
      if (typeof field === "string" && field !== "" && field.length <= MAX_VALUE) meta[key] = field;
    }
    return meta;
  }
  return null;
}
