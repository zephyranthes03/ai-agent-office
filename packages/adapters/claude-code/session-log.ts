// Claude Code session transcripts (`projects/<project>/<session>.jsonl`, and the subagent files under
// `<session>/subagents/`): token usage of assistant messages, from the allowlisted keys only
// (the adapter's session-log strategy; usage-and-cost.md §3). Pure: text in, records out. Only
// lines that can hold usage are parsed; message content is never kept or looked at.

export type ClaudeUsageRecord = {
  key: string;
  sessionId: string;
  at: string;
  model: string | null;
  in: number;
  cached_in: number;
  cache_write_in: number;
  out: number;
};

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/**
 * Usage records of one transcript (or its tail; a cut first line is skipped). Streaming can write
 * several lines for one message; the record with the largest `output_tokens` per key is kept, which
 * the local data showed to be the last and complete one.
 */
export function parseTranscriptUsage(content: string): { records: ClaudeUsageRecord[]; badLines: number } {
  const byKey = new Map<string, ClaudeUsageRecord>();
  let badLines = 0;
  for (const line of content.split("\n")) {
    // Cheap filter first: only assistant lines with usage are parsed at all.
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      badLines++;
      continue;
    }
    if (!isObject(value) || value["type"] !== "assistant" || !isObject(value["message"])) continue;
    const message = value["message"];
    const usage = message["usage"];
    const sessionId = text(value["sessionId"]);
    const at = text(value["timestamp"]);
    const id = text(message["id"]) ?? text(value["uuid"]);
    if (!isObject(usage) || sessionId === null || at === null || Number.isNaN(Date.parse(at)) || id === null) {
      badLines++;
      continue;
    }
    const record: ClaudeUsageRecord = {
      key: `claude-code:${sessionId}:${id}:${text(value["requestId"]) ?? ""}`,
      sessionId,
      at,
      model: text(message["model"]),
      in: count(usage["input_tokens"]),
      cached_in: count(usage["cache_read_input_tokens"]),
      cache_write_in: count(usage["cache_creation_input_tokens"]),
      out: count(usage["output_tokens"]),
    };
    const seen = byKey.get(record.key);
    if (seen === undefined || record.out > seen.out) byKey.set(record.key, record);
  }
  return { records: [...byKey.values()], badLines };
}
