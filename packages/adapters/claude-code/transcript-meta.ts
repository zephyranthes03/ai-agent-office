// Claude Code's transcript metadata: where a session's turns come from (a person, a schedule, the
// SDK, another task's result), read from the tail of the transcript the hook names (the adapter's
// transcript-metadata strategy). Pure: text in, the allowlisted keys of the newest prompt line out.
// Message objects are never looked at; `queue-operation` lines (queued prompts) are ignored.

/** The top-level keys this strategy may keep; everything else on a line is ignored. */
export const TRANSCRIPT_META_KEYS = ["turnOrigin", "entrypoint", "promptSource", "permissionMode", "version", "gitBranch", "isSidechain"] as const;
/** The keys of a prompt line's `origin` object this strategy may keep (a task notification's kind, producer and run id), flattened as `origin.<key>`. */
export const TRANSCRIPT_ORIGIN_KEYS = ["kind", "producer", "runId"] as const;

export type TranscriptMeta = Partial<Record<(typeof TRANSCRIPT_META_KEYS)[number], string | boolean> & Record<`origin.${(typeof TRANSCRIPT_ORIGIN_KEYS)[number]}`, string>>;

/** Keys that only a prompt line carries; tool results are `user` lines too, without them. */
const PROMPT_KEYS = ["turnOrigin", "promptSource"] as const;

/**
 * The allowlisted keys of the newest `user` line that is a prompt (it carries `turnOrigin` or
 * `promptSource`; Claude Code also writes tool results as `user` lines). Without such a line, the
 * keys of the newest user line of any kind; null when the text has no user line yet (the session
 * just started: the strategy reads again at the first prompt). A cut first line of a tail read and
 * lines of other shapes are skipped.
 */
export function transcriptMeta(content: string): TranscriptMeta | null {
  let fallback: TranscriptMeta | null = null;
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
    if (value === null || typeof value !== "object" || Array.isArray(value) || (value as Record<string, unknown>)["type"] !== "user") continue;
    const record = value as Record<string, unknown>;
    const meta: TranscriptMeta = {};
    for (const key of TRANSCRIPT_META_KEYS) {
      const field = record[key];
      if ((typeof field === "string" && field.length <= 128) || typeof field === "boolean") meta[key] = field;
    }
    const origin = record["origin"];
    if (origin !== null && typeof origin === "object" && !Array.isArray(origin)) {
      for (const key of TRANSCRIPT_ORIGIN_KEYS) {
        const field = (origin as Record<string, unknown>)[key];
        if (typeof field === "string" && field.length <= 128) meta[`origin.${key}`] = field;
      }
    }
    if (PROMPT_KEYS.some((key) => key in meta)) return meta;
    fallback ??= meta;
  }
  return fallback;
}
