// Codex session logs (`sessions/YYYY/MM/DD/rollout-*.jsonl`): token usage and rate limits, from the
// allowlisted keys only (the adapter's session-log strategy; usage-and-cost.md §2–3). Pure: text in,
// records out; a line of another shape is skipped and counted, never fatal. Nothing else of a line is
// kept, and messages are never looked at.

export type CodexTotals = { in: number; cached_in: number; cache_write_in: number; out: number; reasoning_out: number };
export type CodexTokenRecord = { at: string; total: CodexTotals; model?: string | null };
export type CodexLimitWindow = { window: "primary" | "secondary"; used_percent: number; window_minutes: number | null; resets_at: string | null };
export type CodexLimitRecord = { at: string; limit_id: string; limit_name: string | null; plan_type: string | null; windows: CodexLimitWindow[]; credits_balance: string | null; reached: string | null };
export type CodexLog = { threadId: string | null; tokens: CodexTokenRecord[]; limits: CodexLimitRecord[]; badLines: number };

const MODEL_MAX = 64;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const time = (value: unknown): string | null => (typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null);

function totalsOf(usage: unknown): CodexTotals | null {
  if (!isObject(usage)) return null;
  const input = count(usage["input_tokens"]);
  const output = count(usage["output_tokens"]);
  if (input === null || output === null) return null;
  return { in: input, cached_in: count(usage["cached_input_tokens"]) ?? 0, cache_write_in: count(usage["cache_write_input_tokens"]) ?? 0, out: output, reasoning_out: count(usage["reasoning_output_tokens"]) ?? 0 };
}

/** `resets_at` is Unix seconds (all local values had ten digits); milliseconds are recognised by size. */
function resetTime(value: unknown): string | null {
  const n = count(value);
  if (n === null || n === 0) return null;
  return new Date(n > 1e12 ? n : n * 1000).toISOString();
}

function windowOf(name: "primary" | "secondary", value: unknown): CodexLimitWindow | null {
  if (!isObject(value)) return null;
  const used = count(value["used_percent"]);
  if (used === null) return null;
  return { window: name, used_percent: used, window_minutes: count(value["window_minutes"]), resets_at: resetTime(value["resets_at"]) };
}

function limitsOf(at: string, value: unknown): CodexLimitRecord | null {
  if (!isObject(value)) return null;
  const windows = [windowOf("primary", value["primary"]), windowOf("secondary", value["secondary"])].filter((w): w is CodexLimitWindow => w !== null);
  if (windows.length === 0) return null;
  const credits = isObject(value["credits"]) ? value["credits"] : {};
  // The balance is shown only for accounts that have credits and are not unlimited (§2.6).
  const balance = credits["has_credits"] === true && credits["unlimited"] !== true && (typeof credits["balance"] === "string" || typeof credits["balance"] === "number") ? String(credits["balance"]) : null;
  const reached = text(value["rate_limit_reached_type"]) ?? (value["spend_control_reached"] ? "spend_control" : null);
  return { at, limit_id: text(value["limit_id"]) ?? "codex", limit_name: text(value["limit_name"]), plan_type: text(value["plan_type"]), windows, credits_balance: balance, reached };
}

/** Token totals and rate limits of one rollout file (or the tail of one; a cut first line is skipped). */
export function parseRollout(content: string): CodexLog {
  const log: CodexLog = { threadId: null, tokens: [], limits: [], badLines: 0 };
  let model: string | null = null;
  for (const line of content.split("\n")) {
    // Cheap filter first: only the thread's first line, turn contexts and token counts are parsed at all.
    if (!line.includes('"token_count"') && !line.includes('"session_meta"') && !line.includes('"turn_context"')) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      if (line.includes('"token_count"') || line.includes('"session_meta"')) log.badLines++;
      continue;
    }
    if (!isObject(value) || !isObject(value["payload"])) continue;
    const payload = value["payload"];
    if (value["type"] === "session_meta") {
      log.threadId ??= text(payload["id"]);
      continue;
    }
    if (value["type"] === "turn_context") {
      const m = text(payload["model"]);
      if (m !== null && m.length <= MODEL_MAX) model = m;
      continue;
    }
    if (value["type"] !== "event_msg" || payload["type"] !== "token_count") continue;
    const at = time(value["timestamp"]);
    if (at === null) {
      log.badLines++;
      continue;
    }
    const total = isObject(payload["info"]) ? totalsOf(payload["info"]["total_token_usage"]) : null;
    if (total !== null) log.tokens.push({ at, total, ...(model !== null ? { model } : {}) });
    const limits = limitsOf(at, payload["rate_limits"]);
    if (limits !== null) log.limits.push(limits);
  }
  return log;
}

export type CodexCursor = { at: string; total: CodexTotals };
export type CodexSample = { key: string; at: string; model?: string | null } & CodexTotals;

const ZERO: CodexTotals = { in: 0, cached_in: 0, cache_write_in: 0, out: 0, reasoning_out: 0 };
const FIELDS = Object.keys(ZERO) as (keyof CodexTotals)[];

/**
 * Per-turn usage of one thread from its cumulative totals (§3): delta = total − previous total, in
 * time order, after the cursor (what an earlier scan already counted). Without a cursor the first
 * total counts in full: exact when the read started at the beginning of the file; from a tail read,
 * earlier turns land on that record's day rather than being lost. A total that went down is an
 * anomaly: counted, not summed, and it becomes the new baseline. A repeat of the same total adds nothing.
 */
export function codexSamples(threadId: string, records: CodexTokenRecord[], cursor: CodexCursor | null): { samples: CodexSample[]; cursor: CodexCursor | null; anomalies: number } {
  const ordered = [...records].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  let previous: CodexTotals = cursor?.total ?? ZERO;
  let last = cursor;
  let anomalies = 0;
  const samples: CodexSample[] = [];
  for (const record of ordered) {
    if (cursor !== null && Date.parse(record.at) <= Date.parse(cursor.at)) continue;
    const delta = Object.fromEntries(FIELDS.map((field) => [field, record.total[field] - previous[field]])) as CodexTotals;
    previous = record.total;
    last = { at: record.at, total: record.total };
    if (FIELDS.some((field) => delta[field] < 0)) {
      anomalies++;
      continue;
    }
    if (FIELDS.every((field) => delta[field] === 0)) continue;
    const model = typeof record.model === "string" && record.model !== "" ? record.model : undefined;
    samples.push({ key: `codex:${threadId}:${record.at}`, at: record.at, ...(model !== undefined ? { model } : {}), ...delta });
  }
  return { samples, cursor: last, anomalies };
}
