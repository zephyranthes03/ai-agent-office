---
summary: How subscription limits (Codex rate_limits) and token usage are collected from local logs, deduplicated, aggregated per local day, priced from a bundled table (network refresh opt-in), and labelled as estimated vs billed.
read_when: Implementing the usage tab, the lobby board limit bars, log-based token collection, pricing, or anything that shows money.
---
# Usage and cost

Everything here is computed from local files; nothing is sent anywhere. Rules follow the CodexBar reference where it had already solved the problem.

## 1. What is shown where

| Surface | v1 | Source |
| --- | --- | --- |
| Lobby board: **Codex** limit bars (primary and secondary window), reset countdown, plan | yes | Codex session logs `rate_limits` |
| Lobby board: **Claude** limit bar | **no** (needs credential access) | post-v1 strategies or optional CodexBar source |
| Lobby board: today's estimated cost | yes | local logs × price table |
| Usage tab: tokens and estimated cost per agent / project / model / day, week | yes | `usage_daily` ([storage.md](storage.md)) |
| Session list beside the scene: tokens per session | yes | `sessions` + `usage_samples` |
| Billed cost (provider cost APIs with an admin key) | post-v1, opt-in | API |
| Other services' limits (Cursor, Gemini, …) | optional, only if CodexBar is installed and enabled | `codexbar serve` / `usage --format json` |

## 2. Codex rate limits: choosing the latest value

Each `token_count` event in `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` carries `rate_limits` with `limit_id`, `limit_name`, `primary { used_percent, window_minutes, resets_at }`, `secondary { … }`, `credits`, `plan_type` (verified 2026-10-19).

1. **Scan scope.** Files modified in the last 7 days, newest first, each read from the tail (as implemented: every file that changed since its last read, last 1 MiB, one read serving tokens and limits; §10). Older files cannot hold a newer value.
2. **Group by `limit_id`.** Different ids are different accounts/limits and get their own bars, labelled with `plan_type` and `limit_name`.
3. **Pick the newest** by the event's `timestamp` (not file mtime); on a tie prefer the file with the newer mtime. Store every distinct observation in `rate_limits`; the board reads the latest.
4. **Windows.** `primary` and `secondary` are two bars (`window_minutes` tells which is the 5-hour and which the weekly window; label from minutes, do not hard-code). `resets_at` is shown as a countdown. It is a Unix time in seconds: all 35,992 local values had ten digits and 99.6% fell between the line's own time and that time plus the window (checked 2026-10-19). Magnitude detection stays as a guard. Most local lines had only a 10,080-minute `primary` window; some had `primary` 300 and `secondary` 10,080.
5. **Freshness.** Show "measured 12 min ago"; dim after 30 minutes; never animate the bar down between observations. No observation in 7 days → bar hidden with "no recent Codex activity".
6. **Credits.** Show `credits.balance` only when `has_credits` is true and `unlimited` is false.
7. `rate_limit_reached_type` / `spend_control_reached` non-null → `quota_reached` notification.

Reading the logs is a `session_log` strategy of the Codex adapter: read-only, byte-capped, allowlisted keys only, and disabled (not crashing) when the shape differs.

## 3. Token collection and deduplication

Tokens come from log strategies, never from hooks (Claude Code and Codex hooks carry no usage). Each parsed usage record becomes one `usage_samples` row with a deterministic `record_key`; inserting an existing key is a no-op, so rescans and overlapping tail reads are safe.

| Agent | Record | `record_key` | Delta rule |
| --- | --- | --- | --- |
| Claude Code | `assistant` lines with `message.usage` (`input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`), `message.id`, `requestId` | `claude-code:<sessionId>:<message.id ?? uuid>:<requestId>` | Streaming can write several lines for one message; keep the row with the largest `output_tokens` for the same key. Subagent transcripts (`isSidechain` or separate files) are attributed to the parent session's project. Checked on 15,317 local message groups (2026-10-19): repeated lines mostly carry identical usage. Where they differ, input stays the same and output only grows, with the last line the largest. Only one group had a different input. Keeping the largest `output_tokens` is therefore correct |
| Codex | `event_msg/token_count` with `info.total_token_usage` (cumulative per thread) and `info.last_token_usage` | `codex:<thread_id>:<timestamp>` | Use `total_token_usage` as a monotonic series per thread: delta = total − previous total (ignore negative deltas and record them as `anomaly`). Session total = max total. Deltas are attributed to the day of the later observation. `token_usage_record` lines (top-level `type`) carry `thread_id`, `turn_id`, `response_id` and `usage` / `turn_token_usage` / `thread_token_usage`. The `token_count` that follows repeats `usage` as `last_token_usage` (28,391 of 28,408 local pairs), so these lines add nothing and are ignored. Per rollout file the records name one thread, the file's own `session_meta.id`, and `total_token_usage` never decreased (checked 2026-10-19) |
| Direct events (`emit`) | `tokens` with `scope` | `<agent>:<session>:<ts>` | `event` scope sums; `turn` scope sums once per `ts`; `session_total` replaces (max) |

Cross-source rule: one session's tokens come from exactly one strategy; if two strategies could provide tokens the descriptor order decides and the other is ignored for that session.

## 4. Periods and time zones

- **Local day** = `[day_starts_at, next day_starts_at)` in `usage.timezone` (`local` = the machine's zone, default). "Today" on the lobby board is the current local day.
- **Week** = ISO week (Monday start) in the same zone. **Month** = calendar month.
- Provider windows (`resets_at`) are the provider's clock and are shown as countdowns, independent of our day boundary.
- `usage_daily` rows store `tz`. Changing the zone (or `day_starts_at`) re-rolls days that still have samples (`events` retention) and marks older days `complete: false` ("aggregated in a previous zone"); so is the one day the change splits, which the kept samples cover only from where the rolled days end.

## 5. Pricing

- **Bundled table** (`pricing/models.json`, versioned by date) ships with the release: USD per million tokens for input, cached input (read), cache write, and output per model id, with prefix matching for dated variants. Unknown model → cost `null`, shown as "no price", never `0`.
- **Refresh** from models.dev only when `usage.pricing.source = "models_dev"` is set explicitly (the settings tab states that this makes a network request); cached 24 h; on failure the bundled table stays. This resolves the "no outbound traffic" contradiction: default is offline.
- **User overrides** in `~/.agent-office/custom-pricing.json` win over both (same shape as the bundled table). Precedence: overrides > models.dev (when enabled) > bundled. An override row must carry all four prices; a partial row leaves the model unpriced rather than mixing sources (CodexBar rule).
- Formula: `cost = in·p_in + cached_in·p_cache_read + cache_write_in·p_cache_write + out·p_out`. Reasoning tokens are included in `output_tokens` and are not priced twice. For Codex, all 35,909 local records had `total = input + output` and `output ≥ reasoning` (checked 2026-10-19).
- Every aggregate stores `pricing_version`; re-pricing old days is a user action ("recalculate") not an automatic one.

## 6. Estimated vs billed

| Label | Meaning | Display |
| --- | --- | --- |
| **est.** | Local token counts × price table | `≈ $1.23 est.` with tooltip "API-equivalent; subscriptions are not billed per token" |
| **≥ est.** | Same, but at least one source file in the period was unreadable or truncated | `≥ $1.23 est.` (lower bound) |
| **billed** | From a provider cost API (post-v1, admin key, opt-in) | `$1.23 billed · <provider>` |
| **limit** | Subscription window percentage | bar + `resets in 2 h 10 m` |

Rules: never mix the three in one number; the lobby board shows `est.` only; incomplete records (a turn still running) are excluded from totals and shown separately as "in progress".

## 7. Warnings

`usage_warn_percent` (default 80) on any limit window → `quota_low`; 100 % → `quota_reached`; a drop after reset → `quota_reset`. Emitted once per window per crossing ([notifications.md](notifications.md)).

## 8. `guard` command (post-v1)

`agent-office guard --min-remaining 20 --window weekly` exits non-zero when a limit window has less than the given percentage left, so scripts can check before starting long jobs (ported from CodexBar `guard`). It reads the same `rate_limits` rows; no network.

## 9. Optional external source: CodexBar

If `external_sources.codexbar.enabled` and `codexbar serve` answers on its localhost port, its `/usage` adds bars for providers we do not implement, labelled with the source. Our own Codex bar always wins over CodexBar's for the same `limit_id`. Nothing in this document requires CodexBar.

## 10. API shapes and what is implemented

Implemented in the daemon and browser UI: both log strategies (Claude Code and Codex tokens, Codex `turn_context` `model`, Codex `rate_limits`), `usage_samples`, `usage_daily`, `rate_limits`, the polling policy, the bundled price table (`BUNDLED_PRICING` in `core`) with `custom-pricing.json` overrides, the summary bar's limit and today-cost chips, and the side panel's expandable usage and limits view (with 1d / 7d / 30d periods and by-service / by-project / by-model breakdowns). Not yet: `models.dev` network refresh, `quota_*` notifications, and CodexBar.

`GET /v1/usage?days=N` (1–400, default 7): the last N local days, today included.

```json
{
  "tz": "Asia/Seoul",
  "day_starts_at": "00:00",
  "days": [
    { "day": "2026-10-21", "agent": "codex", "project": "ai-pii", "model": "gpt-5-codex",
      "in": 3000, "out": 500, "cached_in": 1500, "cache_write_in": 0, "reasoning_out": 10, "complete": true, "estimated_cost_usd": 0.008938 }
  ],
  "pricing": { "version": "2026-11-14", "source": "bundled" }
}
```

Days within the samples' retention (`events`, 30 days) are summed from `usage_samples`; older days come from `usage_daily`. The samples start exactly where the rolled days end, so every day is whole and nothing counts twice; `complete` is false for days rolled in another zone or with another day start, and for the day such a change split. `project` is the folder name of the session that produced the tokens, null when that session never reached the daemon. Codex records take `model` from the preceding `turn_context` line in the rollout (`null` when none was in the tail read).

`GET /v1/limits`: the newest observation of each limit within 7 days:

```json
{
  "limits": [
    { "provider": "codex", "limit_id": "codex", "limit_name": null, "plan_type": "plus",
      "observed_at": "2026-10-21T08:05:00.000Z", "credits_balance": null, "reached": null,
      "windows": [
        { "window": "primary", "window_minutes": 300, "used_percent": 43, "resets_at": "2026-10-21T10:53:20.000Z" },
        { "window": "secondary", "window_minutes": 10080, "used_percent": 9, "resets_at": "2026-10-25T23:33:20.000Z" }
      ] }
  ]
}
```

Reading rules as implemented:

- Codex: rollouts in `sessions/YYYY/MM/DD/` modified in the last 7 days, newest first; every file that changed since its last read (no file cap, so tokens of a busy hour are not left behind); the last 1 MiB of each (one read serves tokens and limits) plus the first line for the thread id (else the id at the end of the file name). Only `token_count` and `session_meta` lines are parsed. Only the newest limits observation of a file is stored. Tokens: `total_token_usage` per thread as a monotonic series after a stored cursor; a thread first seen in a tail read counts its first total in full, so earlier turns land on that record's day instead of being lost; a total that goes down is logged (`usage_total_decreased`) and becomes the new baseline.
- Claude Code: transcripts (and their `subagents/` files) of sessions a hook reported in the last 30 days. The first read of a file takes its last 1 MiB (earlier tokens of a long transcript are not counted; logged as `usage_files_read_from_tail`); later reads continue forward from where the last one stopped, up to 8 MiB a scan, so nothing written between two scans is skipped; a single line longer than that is skipped. Only lines containing `usage` and `assistant` are parsed; the record with the largest `output_tokens` per message and request is kept.
- Files are found by walking the folder layout the agents write, real folders and regular files only (links are not followed), and opened without following a link or blocking on a pipe; a folder that cannot be listed is logged (`usage_folder_unreadable <code>`) and skipped. A file whose size and modification time did not change since the last read is not opened, and a transcript unchanged for 31 days is not read at all. Sample times are stored in one form (UTC, milliseconds). Unreadable candidate lines are skipped and counted (`usage_lines_skipped`); a file that cannot be read is logged and skipped; a strategy that fails is logged and the other still runs.
- Retention: at cleanup, the days older than `events` days are rolled into `usage_daily` and their samples deleted, whole local days at a time. Rolled days are final: a sample read later for one of them (a transcript read again, a Codex thread first seen with an old total) is left out and logged (`usage_samples_before_rollup`), so it can neither replace the day's total with a part of it nor count twice. `usage_daily` rows go after `usage_daily` days (400); a file's cursor 31 days after the file last changed (such a file is no longer read), a Codex thread's last total after at least 400 days, or the `usage_daily` days when longer (so a resumed thread does not count its history again).
