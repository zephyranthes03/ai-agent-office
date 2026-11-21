---
summary: One SQLite file holds session snapshots, state history, control requests, notifications, usage samples and daily aggregates, rate-limit observations, desk assignments and user notes, with per-table retention and a cleanup policy.
read_when: Implementing the daemon's persistence, the history/usage tabs, migrations, or retention cleanup.
---
# Local storage

Decision: a single SQLite database, `~/.agent-office/agent-office.sqlite` (WAL mode, `0600`), owned exclusively by the daemon, opened with Node's built-in `node:sqlite` in both the system Node and the Electron app. Everything else on disk is configuration (`config.json`), the hook token, spool files, logs, and packs. Agents' own databases are never written; see [privacy-security.md](privacy-security.md).

## Tables

Derived data (produced by the daemon from hooks and the agents' own logs; raw hook envelopes are not kept, so history before the retention window is not rebuildable) and user-owned data (not rebuildable at all) are kept in separate tables so retention can differ. On restart the daemon reloads `snapshot_json` for active sessions and then drains the spool, so reducer state survives restarts.

| Table | Owner | Purpose | Key columns | Retention |
| --- | --- | --- | --- | --- |
| `sessions` | derived | Current snapshot per session (what the UI reads) and the reducer's full state for restart | `session_id` PK, `agent`, `parent`, `cwd`, `project`, `space`, `origin`, `state`, `waiting_reason`, `waiting_target`, `detail`, `result_json`, `lifecycle`, `state_since`, `last_signal_at`, `first_seen_at`, `ended_at`, `pid`, `pid_confidence`, `terminal_json`, `launcher`, `desk_id`, `snapshot_json` (the complete reducer snapshot incl. `active_tools`, `finished_tool_ids`, `pending_approval`, `children`, `hold_until`, `state_before_unknown`) | ended rows deleted after `history` days |
| `session_notes` | user | The owner's nickname (shown instead of the project name), one-line description (shown on the card only), a star for sessions to watch, whether a finished turn is notified, and the character species chosen on the card (implemented 2026-10-27, migration 0005; `species` 2026-10-28, migration 0006; the pinned desk is not yet) | `session_id` PK, `nickname` (24 chars), `description` (120 chars, one line), `watched`, `alert_on_rest`, `species` (species id or NULL for the configured assignment), `updated_at` | until the owner clears every field (the row is then deleted) |
| `task_notes` | user | Description for scheduled tasks (kept across runs) | `task_key` PK (`<agent>:<task name>`), `description`, `updated_at` | same as `session_notes` |
| `state_changes` | derived | History tab: every state transition | `id`, `seq` (the input that caused it; rows of inputs reduced again in the reorder window are replaced by `seq`), `session_id`, `at`, `from_state`, `to_state`, `lifecycle`, `rule`, `waiting_reason`, `waiting_target`, `detail` | `history` days (90) |
| `ingest_log` | derived | Hook dedupe (also the content ids of spooled `emit` events, `event:<sha256>`) | `hook_id` PK, `received_at` | 1 day |
| `recent_inputs` | derived | Reorder window for late inputs (in memory, mirrored here so a restart can replay). **Not implemented yet**: after a restart the window starts empty and older inputs count as late | `session_id`, `at`, `seq`, `input_json` | `reorder_window_s` (10 min) |
| `control_requests` | derived | The owner's start, stop and restart of an agent's process or background service (target `service:<agent>`), from the click to its outcome, so the screens show what was asked and what came of it and a restarted daemon can settle a request without acting again ([click-panel-and-controls.md](click-panel-and-controls.md); migration 0012, 2026-11-08) | `id`, `target` (the session id, or `start:<agent>` until a started session is bound), `agent`, `control` (`start`/`stop`/`restart`), `idempotency_key` UNIQUE, `requested_at`, `status` (`requested`/`sent`/`confirmed`/`failed`/`timeout`), `step`, `instance_json` (the process it was bound to: id and start time), `launch_json` (the session id, pid file and launch time of a new window), `evidence_json` (times and counts only), `deadline_at`, `resolved_at`, `failure_reason` | `history` days (settled ones) |
| `notifications` | derived | Sent notifications, clicks, snoozes, dismissals (a lost session's row in the queue) | `id`, `session_id`, `kind`, `at`, `channel`, `delivered`, `clicked_at`, `snoozed_until`, `dismissed_at` | `history` days |
| `usage_samples` | derived | One row per token usage record read from agent logs | `record_key` PK (see [usage-and-cost.md](usage-and-cost.md)), `agent`, `session_id`, `at`, `model`, `in`, `out`, `cached_in`, `cache_write_in`, `reasoning_out`, `source_file` | `events` days (30), after roll-up |
| `usage_daily` | derived | Roll-up per local day | PK (`day`, `tz`, `agent`, `project`, `model`), token columns, `estimated_cost_usd`, `pricing_version`, `complete` | `usage_daily` days (400) |
| `turns_daily` | derived | The office board's completed and cancelled top-level turns per local day, and how they went: done without waiting for the owner (`solo`), failed or lost mid-turn (`failed`), the owner's answered waits (`waits`) and those over five minutes (`long_waits`), for days rolled out of `state_changes` (recent days are counted from it); a row means the day was observed, and NULL in the last four means a day rolled up before they were counted (migration 0007, 2026-10-28; 0010, 2026-11-05) | `day` PK, `completed`, `cancelled`, `solo`, `failed`, `waits`, `long_waits` | kept (one small row per day) |
| `board_months` | derived | The owner's monthly goal (`scene.board.monthly_target`) as it stood in each month; a past month keeps it (migration 0007) | `month` PK (`YYYY-MM`), `target` (NULL: no goal) | kept |
| `rate_limits` | derived | Every rate-limit observation | PK (`provider`, `limit_id`, `observed_at`), `window_minutes`, `used_percent`, `resets_at`, `plan_type`, `source_file` | `events` days |
| `desks` | derived | Seat assignment per room | PK (`space`, `desk_id`), `session_id` NULL, `assigned_at` | with session |
| `push_subscriptions` | user | A paired device's web push subscription, made by the device: its browser push service address and the public key and secret messages are encrypted to (migration 0011, 2026-11-06). The daemon's own VAPID key pair is in `meta` (`push_vapid_private_jwk`) | `device_id` PK, `endpoint`, `p256dh`, `auth`, `created_at` | until the device turns it off, the push service calls it gone, or the device is revoked |
| `viewer_devices` | user | Devices paired with the read-only viewer (server mode, since 2026-10-27): a name and the SHA-256 of the device token, never the token | `id`, `name`, `token_sha256`, `created_at`, `last_seen_at` | until revoked (`agent-office devices revoke <id>` or the tray menu) |
| `scheduled_tasks` | derived | The scheduled tasks as last read from the agents' schedulers (today Codex's), the schedule apart from the newest run, the occurrence the daemon awaits and what it decided about one that passed without a run (missed, or unsure with a reason), so a missed mark survives a restart (migration 0009) | `task_key` PK (`<agent>:<scheduler id>`), `agent`, `name`, `project`, `cwd`, `status`, `kind`, `rrule`, `next_run_at`, `last_run_at`, `expected_at`, `missed_at`, `unsure_at`, `unsure_reason`, `run_session`, `run_status`, `run_at`, `observed_at` | replaced on each pass; a task the scheduler no longer lists is dropped |
| `server_status` | derived | Local LLM server polls (post-v1) | `name`, `at`, `alive`, `models_json`, `latency_ms` | 1 day |
| `meta` | daemon | `db_schema_version`, `pricing_version`, `last_drain_at`, `last_cleanup_at` | — | — |

Notes

- `sessions` is upserted on every reduce; `state_changes` gets a row only when `state`, `waiting_on`, or `lifecycle` changes. Tool-level churn (`detail`) is not historised. A snapshot that changed only by a newer alive report (the 30-second liveness check of a running agent) is not announced over SSE and is written only once the stored report is `liveness_fresh_s` (90 s) old, so a restart still loads a recent one.
- `rule` in `state_changes` is the id of the state rule that caused the change; the history tab shows it in the "why" column.
- `control_requests.idempotency_key` is generated by the UI per click; a second click with the same key answers the same request, and a different key for the same session while one request is open (`requested` or `sent`) is rejected (409 `busy`). Open requests are never deleted by the retention cleanup; on start the daemon settles them before its first liveness pass.
- `terminal_json` is the allowlisted terminal object from the hook envelope. `launcher` is where the session runs (`claude-app`, `codex-app`, `vscode`, `terminal`), read once by the liveness check from the path of the verified process and the terminal object; the path itself is not kept. `pid` is nulled when liveness says the process is gone.
- Desk assignment: on first sight a session gets the lowest free `desk_id` in its project's area, or a bench (`bench:<n>`) when none is free; a `pinned_desk` in `session_notes` is honoured if free. Seats are released when the session ends. A working session keeps its seat at least for the whole turn; seat count and overflow are still open.

Implemented so far (migration `0001-initial`, 2026-10-20): `sessions`, `state_changes`, `ingest_log` and `meta` (`db_schema_version`, `head_at`, `last_cleanup_at`). The file is opened with `locking_mode = EXCLUSIVE`, which also stops a second daemon from starting on the same folder, in WAL mode with `synchronous = NORMAL`; it is created with mode `0600` before SQLite opens it. On start the daemon reloads active sessions and those ended within the last day.

Migration `0002-usage` (2026-10-21): `usage_samples`, `usage_daily` (unknown project or model stored as `''` so the key can be replaced), `rate_limits` with one row per window (`window` = `primary`/`secondary` joins the primary key, plus `limit_name`, `credits_balance`, `reached`), and `usage_cursors` (where the log strategies stopped: a Codex thread's last cumulative total; a file's size and modification time at its last read and, for transcripts, the byte the next read starts at). Upgrading a version-1 file makes the private `.bak-1` copy first (tested).

Migration `0008-session-launcher` (2026-10-28): `sessions.launcher`.

Migration `0011-push-subscriptions` (2026-11-06): `push_subscriptions`, one row per viewer device.

Migration `0012-control-requests` (2026-11-08): `control_requests`, one row per start, stop or restart the owner asked for, with an index on the open ones.

Migration `0010-board-care` (2026-11-05): `turns_daily.solo`, `failed`, `waits`, `long_waits` (NULL for days rolled up before; a day partly rolled up before keeps them NULL).

Migration `0007-board` (2026-10-28): `turns_daily` and `board_months` for the office board. Cleanup rolls the history rows it is about to delete into `turns_daily` in the same transaction; the current month's goal is recorded at start, at each cleanup and when a screen reads the board.

Migration `0003-liveness` (2026-10-21): `sessions.reported_pid` (the parent process the hooks named) and `pid_started_at` (the start time of the verified process); `pid` and `pid_confidence` now hold the liveness check's result, and `pid` is null once the process is gone.

## Retention and cleanup

- Cleanup runs at daemon start and every 6 hours: roll the local days past `events` retention from `usage_samples` into `usage_daily` (where the kept samples start is in `meta` as `usage_rollup`), then delete rows past their retention. Defaults come from `config.json` → `storage.retention_days` (`events: 30`, `history: 90`, `usage_daily: 400`).
- `VACUUM` runs only when the file exceeds 64 MiB after cleanup; expected size for heavy use is a few MiB.
- "Clear history" in the settings tab truncates the derived tables only; user notes survive. "Reset" deletes the database file after confirmation.

## Migrations

- `migrations/NNNN-<name>.sql`, applied in order inside one transaction; `meta.db_schema_version` records the last applied number. Forward-only; the daemon copies the file to `agent-office.sqlite.bak-<version>` before applying.
- A database newer than the running daemon is refused with a clear message (downgrade is a manual restore of the backup).

## Not stored

Conversation content, prompts, tool inputs, tool outputs, credentials, environment variables of other processes, or raw hook envelopes. Logs (`~/.agent-office/logs/`) contain only daemon/hook diagnostics and are capped at 5 MiB total.
