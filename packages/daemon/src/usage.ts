// The log strategies of the adapters, run by the daemon: token usage from Claude Code transcripts and
// Codex rollouts, and Codex rate limits (usage-and-cost.md §2–4). Files are found and read by
// log-files.ts (folder layout, no links, read-only, byte caps); the adapters' parsers keep
// allowlisted keys only. Results go to `usage_samples` and
// `rate_limits`; `usage_daily` keeps days past the samples' retention.
import { codexSamples, parseRollout, parseTranscriptUsage } from "@agent-office/adapters";
import type { CodexCursor } from "@agent-office/adapters";
import { addDays, BUNDLED_PRICING, dayStart, estimateCostUsd, localDay } from "@agent-office/core";
import type { LimitsResponse, PricingOverrides, UsageResponse } from "@agent-office/core";
import { claudeTranscripts, codexRollouts, readForward, readHead, readTail, SESSION_FILE_ID, TAIL_BYTES } from "./log-files.ts";
import type { AgentHomes, ForwardRead, FoundFile, Unlisted } from "./log-files.ts";
import type { Store } from "./store.ts";

export type { LimitsResponse, UsageResponse };

/** Byte cap of each forward read after a file's first (TAIL_BYTES, log-files.ts). */
const FORWARD_BYTES = 8 * 1024 * 1024;
const CODEX_RECENT_DAYS = 7;
const CLAUDE_SESSION_DAYS = 30;
const DAILY_DAYS = 400;
/** How long a file's cursor outlives the file's last change: a day past the longest scan window. */
const FILE_CURSOR_DAYS = CLAUDE_SESSION_DAYS + 1;
const DAY_MS = 86_400_000;

type Sample = { key: string; agent: string; session: string | null; at: string; model: string | null; in: number; out: number; cached_in: number; cache_write_in: number; reasoning_out: number; file: string };

export type ScanResult = { files: number; samples: number; limits: number; badLines: number; anomalies: number; unreadable: number; partial: number; tooOld: number };

export type UsageOptions = {
  store: Store;
  homes: AgentHomes;
  now: () => number;
  log: (line: string) => void;
  timeZone: string;
  dayStartsAt: string;
  eventsDays: number;
  /** Days `usage_daily` keeps (storage.retention_days.usage_daily); default 400. */
  dailyDays?: number;
  /** User price overrides from `custom-pricing.json`; null or omitted uses the bundled table alone. */
  overrides?: PricingOverrides | null;
};

/** Where a file was read up to: its size and modification time then, and for forward reads the next byte. */
type FileCursor = { mtimeMs: number; size: number; offset?: number; cut?: boolean; capped?: boolean };

/** The roll-up's state in `meta`: the samples start at `since` (epoch ms), where the final days end; the zone of the last roll-up. */
type RollupState = { since: number; timeZone: string; dayStartsAt: string };

export class UsageCollector {
  private readonly options: UsageOptions;

  constructor(options: UsageOptions) {
    this.options = options;
  }

  private get db() {
    return this.options.store.db;
  }

  private day(ms: number): string {
    return localDay(new Date(ms).toISOString(), this.options.timeZone, this.options.dayStartsAt);
  }

  private cursor(key: string): { at: string; value: unknown } | null {
    const row = this.db.prepare("SELECT at, value_json FROM usage_cursors WHERE key = ?").get(key) as { at: string; value_json: string } | undefined;
    return row ? { at: row.at, value: JSON.parse(row.value_json) as unknown } : null;
  }

  private setCursor(key: string, at: string, value: unknown): void {
    this.db.prepare("INSERT INTO usage_cursors (key, at, value_json) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET at = excluded.at, value_json = excluded.value_json").run(key, at, JSON.stringify(value));
  }

  private fileCursor(file: string): FileCursor | null {
    const value = this.cursor(`file:${file}`)?.value;
    return value !== null && typeof value === "object" && typeof (value as FileCursor).mtimeMs === "number" ? (value as FileCursor) : null;
  }

  private setFileCursor(file: string, cursor: FileCursor): void {
    this.setCursor(`file:${file}`, new Date(cursor.mtimeMs).toISOString(), cursor);
  }

  private rollupState(): RollupState | null {
    const text = this.options.store.getMeta("usage_rollup");
    return text === null ? null : (JSON.parse(text) as RollupState);
  }

  /**
   * Stores the samples; a sample from before the roll-up's frozen days is left out (its day was rolled
   * and its samples deleted, so it could only replace that day's total with a part of it).
   */
  private saveSamples(samples: Sample[], result: ScanResult, since: number | null): number {
    // A repeated key keeps the larger output (Claude Code streams one message over several lines).
    const insert = this.db.prepare(`INSERT INTO usage_samples (record_key, agent, session_id, at, model, "in", out, cached_in, cache_write_in, reasoning_out, source_file)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (record_key) DO UPDATE SET "in" = excluded."in", out = excluded.out, cached_in = excluded.cached_in, cache_write_in = excluded.cache_write_in, reasoning_out = excluded.reasoning_out
      WHERE excluded.out > usage_samples.out`);
    let saved = 0;
    for (const s of samples) {
      // Stored in one form (UTC, milliseconds), so the time comparisons in SQL are exact.
      const at = Date.parse(s.at);
      if (since !== null && at < since) {
        result.tooOld++;
        continue;
      }
      insert.run(s.key, s.agent, s.session, new Date(at).toISOString(), s.model, s.in, s.out, s.cached_in, s.cache_write_in, s.reasoning_out, s.file);
      saved++;
    }
    return saved;
  }

  /**
   * Reads one file; a file that cannot be read (gone since the listing, not a regular file, no
   * permission) is counted and skipped, so it does not stop the others.
   */
  private readFile<T>(read: () => T, result: ScanResult): { read: T } | { unreadable: string } {
    try {
      return { read: read() };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (typeof code !== "string") throw error;
      result.unreadable++;
      this.options.log(`usage_file_unreadable ${code}`);
      return { unreadable: code };
    }
  }

  /**
   * Codex rollouts modified in the last 7 days, newest first (§2.1); a file whose size and
   * modification time did not change since the last read is not opened.
   */
  private scanCodex(result: ScanResult, since: number | null): void {
    const recent = this.options.now() - CODEX_RECENT_DAYS * DAY_MS;
    const files = codexRollouts(this.options.homes.codex, this.unlisted(result))
      .filter(({ mtimeMs }) => mtimeMs >= recent)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const { file, mtimeMs, size } of files) {
      const previous = this.fileCursor(file);
      if (previous?.mtimeMs === mtimeMs && previous.size === size) continue;
      const outcome = this.readFile(() => {
        const tail = readTail(file, TAIL_BYTES);
        return { tail, head: tail.fromStart ? "" : readHead(file) };
      }, result);
      if ("unreadable" in outcome) continue;
      const { tail, head } = outcome.read;
      result.files++;
      const log = parseRollout(head + tail.text);
      result.badLines += log.badLines;
      // A rollout names one thread (its session_meta); the file name ends with the same id.
      const threadId = log.threadId ?? /-([0-9a-f-]{36})\.jsonl$/.exec(file)?.[1] ?? null;
      this.options.store.transaction(() => {
        if (threadId !== null) {
          const stored = this.cursor(`codex:${threadId}`);
          const { samples, cursor, anomalies } = codexSamples(threadId, log.tokens, stored ? (stored.value as CodexCursor) : null);
          result.anomalies += anomalies;
          result.samples += this.saveSamples(samples.map((s) => ({ ...s, agent: "codex", session: threadId, model: s.model ?? null, file })), result, since);
          if (cursor !== null) this.setCursor(`codex:${threadId}`, cursor.at, cursor);
        }
        // The newest observation of the file is the one that counts (§2.1); older ones are not stored.
        const latest = log.limits.at(-1);
        if (latest !== undefined) {
          const insert = this.db.prepare(`INSERT OR IGNORE INTO rate_limits (provider, limit_id, observed_at, window, window_minutes, used_percent, resets_at, plan_type, limit_name, credits_balance, reached, source_file)
            VALUES ('codex', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
          for (const w of latest.windows) insert.run(latest.limit_id, latest.at, w.window, w.window_minutes, w.used_percent, w.resets_at, latest.plan_type, latest.limit_name, latest.credits_balance, latest.reached, file);
          result.limits++;
        }
        this.setFileCursor(file, { mtimeMs: tail.mtimeMs, size: tail.size });
      });
    }
  }

  /** Counts and logs a folder the walk could not list; the walk goes on without it. */
  private unlisted(result: ScanResult): Unlisted {
    return (code) => {
      result.unreadable++;
      this.options.log(`usage_folder_unreadable ${code}`);
    };
  }

  /**
   * Claude Code transcripts (and subagent files) of sessions whose hooks reached the daemon in the
   * last 30 days, modified within the time a file's cursor is kept (an older file has nothing new).
   */
  private claudeFiles(result: ScanResult): FoundFile[] {
    const now = this.options.now();
    const since = new Date(now - CLAUDE_SESSION_DAYS * DAY_MS).toISOString();
    // Only sessions a hook reported (they carry the hook's parent process id): `agent-office emit`
    // can name any session, and its ids must not decide which files are opened.
    const ids = (this.db.prepare("SELECT session_id FROM sessions WHERE agent = 'claude-code' AND last_signal_at >= ? AND reported_pid IS NOT NULL").all(since) as { session_id: string }[])
      .map((row) => row.session_id)
      .filter((id) => SESSION_FILE_ID.test(id));
    if (ids.length === 0) return [];
    return claudeTranscripts(this.options.homes.claude, new Set(ids), this.unlisted(result)).filter(({ mtimeMs }) => mtimeMs >= now - FILE_CURSOR_DAYS * DAY_MS);
  }

  /**
   * A transcript is first read from its tail (1 MiB), then forward from where the last read stopped,
   * up to 8 MiB a pass, so lines written between two scans are never skipped. A file that got shorter
   * was replaced and is read from its tail again; record keys keep a re-read from counting twice.
   */
  private scanClaude(result: ScanResult, since: number | null): void {
    for (const { file, mtimeMs, size } of this.claudeFiles(result)) {
      const previous = this.fileCursor(file);
      if (previous?.mtimeMs === mtimeMs && previous.size === size && previous.capped !== true) continue;
      const forward = previous?.offset !== undefined && previous.offset <= size ? previous.offset : null;
      const outcome = this.readFile((): ForwardRead & { partial: boolean } => {
        if (forward !== null) return { ...readForward(file, forward, FORWARD_BYTES, previous?.cut === true), partial: false };
        const tail = readTail(file, TAIL_BYTES);
        return { text: tail.text, next: tail.end, cut: tail.cut, capped: false, size: tail.size, mtimeMs: tail.mtimeMs, partial: !tail.fromStart };
      }, result);
      if ("unreadable" in outcome) continue;
      const read = outcome.read;
      result.files++;
      // Tokens before the first read's tail are not counted (usage-and-cost.md §6, "≥ est.").
      if (read.partial) result.partial++;
      const { records, badLines } = parseTranscriptUsage(read.text);
      result.badLines += badLines;
      this.options.store.transaction(() => {
        result.samples += this.saveSamples(records.map((r) => ({ key: r.key, agent: "claude-code", session: r.sessionId, at: r.at, model: r.model, in: r.in, out: r.out, cached_in: r.cached_in, cache_write_in: r.cache_write_in, reasoning_out: 0, file })), result, since);
        this.setFileCursor(file, { mtimeMs: read.mtimeMs, size: read.size, offset: read.next, cut: read.cut, capped: read.capped });
      });
    }
  }

  /** One pass of both log strategies. A strategy that fails is logged and the other still runs. */
  scan(): ScanResult {
    const result: ScanResult = { files: 0, samples: 0, limits: 0, badLines: 0, anomalies: 0, unreadable: 0, partial: 0, tooOld: 0 };
    const since = this.rollupState()?.since ?? null;
    for (const [name, run] of [["codex", () => this.scanCodex(result, since)], ["claude", () => this.scanClaude(result, since)]] as const) {
      try {
        run();
      } catch (error) {
        this.options.log(`usage_scan_failed ${name} ${(error as Error).name} ${(error as NodeJS.ErrnoException).code ?? ""}`.trim());
      }
    }
    if (result.badLines > 0) this.options.log(`usage_lines_skipped ${result.badLines}`);
    if (result.anomalies > 0) this.options.log(`usage_total_decreased ${result.anomalies}`);
    if (result.partial > 0) this.options.log(`usage_files_read_from_tail ${result.partial}`);
    if (result.tooOld > 0) this.options.log(`usage_samples_before_rollup ${result.tooOld}`);
    return result;
  }

  /** Per local day, agent, project and model, from the samples in [`fromMs`, `untilMs`). */
  private dailyFromSamples(fromMs: number, untilMs: number | null = null): Map<string, DailyRow> {
    const range = untilMs === null ? "u.at >= ?" : "u.at >= ? AND u.at < ?";
    const bounds = [fromMs, ...(untilMs === null ? [] : [untilMs])].map((ms) => new Date(ms).toISOString());
    const rows = this.db
      .prepare(`SELECT u.agent, u.at, u.model, u."in" AS input, u.out, u.cached_in, u.cache_write_in, u.reasoning_out, s.project
        FROM usage_samples u LEFT JOIN sessions s ON s.session_id = u.session_id WHERE ${range}`)
      .all(...bounds) as { agent: string; at: string; model: string | null; input: number; out: number; cached_in: number; cache_write_in: number; reasoning_out: number; project: string | null }[];
    const days = new Map<string, DailyRow>();
    for (const row of rows) {
      const day = localDay(row.at, this.options.timeZone, this.options.dayStartsAt);
      const key = JSON.stringify([day, row.agent, row.project ?? "", row.model ?? ""]);
      const sum = days.get(key) ?? { day, agent: row.agent, project: row.project ?? "", model: row.model ?? "", in: 0, out: 0, cached_in: 0, cache_write_in: 0, reasoning_out: 0 };
      sum.in += row.input;
      sum.out += row.out;
      sum.cached_in += row.cached_in;
      sum.cache_write_in += row.cache_write_in;
      sum.reasoning_out += row.reasoning_out;
      days.set(key, sum);
    }
    return days;
  }

  /** The day `since` falls in when it is not that day's start (the zone or day start changed): the samples hold only part of it. */
  private partialDay(since: number | null): string | null {
    if (since === null) return null;
    const day = this.day(since);
    return dayStart(day, this.options.timeZone, this.options.dayStartsAt) < since ? day : null;
  }

  /**
   * Rolls the days past the `events` retention into `usage_daily` and deletes their samples, whole
   * local days at a time. Rolled days are final: the samples kept start where they end (`since`, in
   * `meta`), and a sample read later for a final day is left out, so it can neither replace that day's
   * total with a part of it nor count twice. After a change of zone or day start, earlier roll-ups are
   * marked `complete: false`, and so is the first day rolled after it (it starts at `since`, not at
   * its own start). Also drops roll-ups past `usage_daily` retention, rate limits past `events`, and
   * cursors no scan can need again.
   */
  rollup(): void {
    const { timeZone, dayStartsAt, eventsDays } = this.options;
    const now = this.options.now();
    const state = this.rollupState();
    const cutoff = dayStart(this.day(now - eventsDays * DAY_MS), timeZone, dayStartsAt);
    const since = state?.since ?? null;
    const dailyDays = this.options.dailyDays ?? DAILY_DAYS;
    this.options.store.transaction(() => {
      if (state !== null && (state.timeZone !== timeZone || state.dayStartsAt !== dayStartsAt)) this.db.prepare("UPDATE usage_daily SET complete = 0").run();
      if (state === null && this.db.prepare("SELECT 1 FROM usage_daily LIMIT 1").get() !== undefined) {
        // Roll-ups written before the samples' start was kept rolled every past day the samples held:
        // the days past the retention are final in them (their samples go, strays included), the later
        // ones are still whole in the samples (their roll-ups go).
        this.db.prepare("DELETE FROM usage_samples WHERE at < ?").run(new Date(cutoff).toISOString());
        this.db.prepare("DELETE FROM usage_daily WHERE day >= ?").run(this.day(cutoff));
      }
      if (since === null || cutoff > since) {
        const partial = this.partialDay(since);
        const insert = this.db.prepare(`INSERT INTO usage_daily (day, tz, agent, project, model, "in", out, cached_in, cache_write_in, reasoning_out, estimated_cost_usd, pricing_version, complete)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (day, tz, agent, project, model) DO UPDATE SET "in" = "in" + excluded."in", out = out + excluded.out, cached_in = cached_in + excluded.cached_in,
            cache_write_in = cache_write_in + excluded.cache_write_in, reasoning_out = reasoning_out + excluded.reasoning_out, estimated_cost_usd = CASE WHEN usage_daily.estimated_cost_usd IS NULL OR excluded.estimated_cost_usd IS NULL THEN NULL ELSE usage_daily.estimated_cost_usd + excluded.estimated_cost_usd END, pricing_version = excluded.pricing_version, complete = MIN(complete, excluded.complete)`);
        for (const r of this.dailyFromSamples(since ?? 0, cutoff).values()) {
          const cost = estimateCostUsd({ ...r, model: r.model || null }, this.options.overrides);
          insert.run(r.day, timeZone, r.agent, r.project, r.model, r.in, r.out, r.cached_in, r.cache_write_in, r.reasoning_out, cost, BUNDLED_PRICING.version, r.day === partial ? 0 : 1);
        }
        this.db.prepare("DELETE FROM usage_samples WHERE at < ?").run(new Date(cutoff).toISOString());
      }
      this.options.store.setMeta("usage_rollup", JSON.stringify({ since: Math.max(since ?? cutoff, cutoff), timeZone, dayStartsAt } satisfies RollupState));
      this.db.prepare("DELETE FROM usage_daily WHERE day < ?").run(this.day(now - dailyDays * DAY_MS));
      this.db.prepare("DELETE FROM rate_limits WHERE observed_at < ?").run(new Date(now - eventsDays * DAY_MS).toISOString());
      // A file's cursor goes when the file has not changed for longer than both scans look back (7
      // and 30 days); such a file is no longer read. A Codex thread's last total is kept at least 400
      // days (longer when the roll-ups are): without it, a thread resumed later would count its whole
      // history again on the day it resumed.
      this.db.prepare("DELETE FROM usage_cursors WHERE key LIKE 'file:%' AND at < ?").run(new Date(now - FILE_CURSOR_DAYS * DAY_MS).toISOString());
      this.db.prepare("DELETE FROM usage_cursors WHERE key LIKE 'codex:%' AND at < ?").run(new Date(now - Math.max(dailyDays, DAILY_DAYS) * DAY_MS).toISOString());
    });
  }

  /**
   * GET /v1/usage: tokens per local day, agent, project and model for the last `days` days, today
   * included: the roll-ups of final days plus the samples, which start where the roll-ups end, so
   * nothing counts twice and every day is whole. `complete` is false for days rolled with another zone
   * or day start, and for the day that change split. Costs come from the bundled table (and any user
   * overrides), or `null` when the model is unknown ("no price", never 0).
   */
  usage(days: number): UsageResponse {
    const { timeZone, dayStartsAt, overrides } = this.options;
    const firstDay = addDays(this.day(this.options.now()), -(days - 1));
    const since = this.rollupState()?.since ?? null;
    const partial = this.partialDay(since);
    const merged = new Map<string, DailyRow & { complete: boolean }>();
    const add = (row: DailyRow, complete: boolean) => {
      const key = JSON.stringify([row.day, row.agent, row.project, row.model]);
      const sum = merged.get(key);
      if (sum === undefined) merged.set(key, { ...row, complete });
      else merged.set(key, { ...sum, in: sum.in + row.in, out: sum.out + row.out, cached_in: sum.cached_in + row.cached_in, cache_write_in: sum.cache_write_in + row.cache_write_in, reasoning_out: sum.reasoning_out + row.reasoning_out, complete: sum.complete && complete });
    };
    const rolled = this.db.prepare(`SELECT day, tz, agent, project, model, "in" AS input, out, cached_in, cache_write_in, reasoning_out, complete FROM usage_daily WHERE day >= ?`).all(firstDay) as (Omit<DailyRow, "in"> & { tz: string; input: number; complete: number })[];
    for (const { input, tz, complete, ...rest } of rolled) add({ ...rest, in: input }, complete === 1 && tz === timeZone);
    for (const row of this.dailyFromSamples(Math.max(since ?? 0, dayStart(firstDay, timeZone, dayStartsAt))).values()) add(row, row.day !== partial);
    const rows = [...merged.values()].sort((a, b) => a.day.localeCompare(b.day) || a.agent.localeCompare(b.agent) || a.project.localeCompare(b.project) || a.model.localeCompare(b.model));
    return {
      tz: timeZone,
      day_starts_at: dayStartsAt,
      days: rows.map((row) => {
        const model = row.model || null;
        return { ...row, project: row.project || null, model, estimated_cost_usd: estimateCostUsd({ ...row, model }, overrides) };
      }),
      pricing: { version: BUNDLED_PRICING.version, source: overrides !== undefined && overrides !== null ? "custom" : "bundled" },
    };
  }

  /** GET /v1/limits: the newest observation of each limit, with its windows; none older than 7 days. */
  limits(): LimitsResponse {
    const since = new Date(this.options.now() - CODEX_RECENT_DAYS * DAY_MS).toISOString();
    const latest = this.db
      .prepare(`SELECT provider, limit_id, MAX(observed_at) AS observed_at FROM rate_limits WHERE observed_at >= ? GROUP BY provider, limit_id`)
      .all(since) as { provider: string; limit_id: string; observed_at: string }[];
    const windows = this.db.prepare(`SELECT window, window_minutes, used_percent, resets_at, plan_type, limit_name, credits_balance, reached FROM rate_limits WHERE provider = ? AND limit_id = ? AND observed_at = ? ORDER BY window`);
    return {
      limits: latest.map(({ provider, limit_id, observed_at }) => {
        const rows = windows.all(provider, limit_id, observed_at) as { window: string; window_minutes: number | null; used_percent: number; resets_at: string | null; plan_type: string | null; limit_name: string | null; credits_balance: string | null; reached: string | null }[];
        const first = rows[0];
        return {
          provider,
          limit_id,
          limit_name: first?.limit_name ?? null,
          plan_type: first?.plan_type ?? null,
          observed_at,
          credits_balance: first?.credits_balance ?? null,
          reached: first?.reached ?? null,
          windows: rows.map((w) => ({ window: w.window, window_minutes: w.window_minutes, used_percent: w.used_percent, resets_at: w.resets_at })),
        };
      }),
    };
  }
}

type DailyRow = { day: string; agent: string; project: string; model: string; in: number; out: number; cached_in: number; cache_write_in: number; reasoning_out: number };
