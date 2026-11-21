---
summary: Exactly what the app reads from each AI agent, what its hook forwards, which files it writes, which network calls exist, and what it never touches.
read_when: You want to verify the privacy claims, review what the installer changes on your machine, or audit a release.
---
# Data access

This page lists every source the app reads and every file it writes. Anything not listed here is not accessed. The rules behind it are in [privacy-security.md](privacy-security.md).

## Claude Code

| What | Detail |
| --- | --- |
| Hook events received | `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`, `Notification`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop` |
| Fields the hook forwards | `hook_event_name`, `session_id`, `cwd`, `transcript_path`, `permission_mode`, `prompt_id`, `agent_id`, `agent_type`, `tool_name`, `tool_use_id`, `notification_type`, `source`, `reason`, plus a short `detail` (below) and, for a tool the adapter classes as `delegation` (the Claude app's cloud session start), `tool_meta` = the input's `target` and `initiation` enums, and on Claude Code's `Stop` and `SubagentStop` `background` = how many entries of the input's `background_tasks` list are work still running (idle teammates and the agent's own memory and auto-mode tasks not counted); each entry's commands and descriptions never leave the hook. Prompts, tool inputs and outputs, messages and errors are dropped inside the hook process and never reach the app |
| `detail` (≤ 64 characters) | Tool name, followed by the base name of the program (leading `NAME=value` assignments skipped; just the tool name when such an assignment is quoted or substituted, since part of its value could be mistaken for the program) or of the file. The short description the model writes for a shell command is free text that can repeat anything from the conversation, so it is left out unless you set `privacy.detail_level` to `description`. Setting it to `tool` or `none` reduces `detail` to the tool name or nothing; an unreadable config file or an unknown value counts as `tool` |
| Session transcript (`~/.claude/projects/…/*.jsonl`) | For the session's origin: only the file the hook names (a regular file inside `projects/`), only the last 64 KiB, only these keys of `user` lines: `turnOrigin`, `entrypoint`, `promptSource`, `permissionMode`, `version`, `gitBranch`, `isSidechain`. For usage: the transcripts and `subagents/*.jsonl` files of sessions a hook reported in the last 30 days, first the last 1 MiB, then forward from where the last read stopped (up to 8 MiB a scan); only `assistant` lines with `usage`, and of them only the token counts, `sessionId`, message id, `uuid`, request id, `type`, model and timestamp. For Esc, which sends no hook: the transcript of a top-level session a hook reported that has been quiet in a turn for 10 s, the last 64 KiB, again only when the file changed; of the newest `user` line, `type`, `timestamp` and whether its whole `message.content` equals one of Claude Code's two fixed interrupt markers. Only the marker's time is kept. For the session's title (the one Claude Code's apps show), in the same read of every active top-level session a hook reported, every 30 s and only when the file changed: the newest `custom-title` line's `customTitle`, else the newest `ai-title` line's `aiTitle`, clipped to 64 characters and kept in memory only. Message text is never parsed otherwise |
| Claude desktop app session records (`~/Library/Application Support/Claude/claude-code-sessions/<account>/<org>/local_*.json`) | Only when you open a session that runs in the Claude app: regular files up to 256 KiB (links not followed), and of each only `sessionId` and `cliSessionId`, to find the app's own id of that session for the link `claude://code/continue?session=local_…`. Nothing is kept |
| Files written | `~/.claude/settings.json` (or the folder in `CLAUDE_CONFIG_DIR`): hook entries are added by the installer only after you confirm, with the previous file kept next to it as `settings.json.agent-office-backup-<time>` (readable by you only); `uninstall-hooks` removes exactly those entries |
| Never read | conversation text, prompts, tool inputs and outputs, credentials, `~/.claude.json`, other settings |

## Codex

| What | Detail |
| --- | --- |
| Hook events received | `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop`, `SubagentStart`, `SubagentStop`, `Interrupt` (same forwarded fields as above, plus `model` and `turn_id`). Codex runs the hooks only after you trust them with `/hooks` |
| Session logs (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`) | Only `token_count` events: token counts and `rate_limits` (`limit_id`, `limit_name`, used percent, window, reset time, plan, whether a limit was reached, and the credits balance when the account has credits), plus the thread id from the file's first line and `model` (≤ 64 characters) from each turn's `turn_context` line. The last 1 MiB of each file modified in the last 7 days that changed since it was last read. When a Codex hook asks for an approval, the rollout that hook names (only a regular file inside `sessions/`) is read once per turn, its last 1 MiB, for the newest `turn_context` line's `approval_policy` and `approvals_reviewer`: whether Codex's own reviewer answers the request, in which case the office does not show it as waiting for you |
| Local databases | `~/.codex/state_5.sqlite`, opened read-only: for the title the Codex app shows, `threads.name`, else `threads.title`, of the active top-level sessions a hook reported, and `threads.agent_nickname` of their active subagent threads (the name Codex gives a worker or reviewer), every 30 s, clipped to 64 characters and kept in memory only (`first_user_message` and other columns are not read); the same query tells which reported threads Codex lists at all, so a thread the Codex app runs for itself (absent from the list 5 s after its first hook) is set apart and never opened. Planned, not read yet: thread id, working folder, source, thread source, originator, agent role, approval mode, and parent/child thread links. `~/.codex/sqlite/codex.db`, opened read-only every 30 s and once when a Codex session is first seen: the scheduled tasks of the ChatGPT app (`automations`: id, name ≤ 64 characters, status, kind, rrule, next_run_at, next_run_nominal_at, last_run_at, the first folder of cwds, target_thread_id — the thread the task lives in) and which thread each run row opened (`automation_runs`: thread_id, automation_id, status, created_at); never `prompt`, `inbox_title` or `inbox_summary`. A task names a session only by an identical thread id |
| Files written | `~/.codex/hooks.json` (or the folder in `CODEX_HOME`): hook entries added by the installer after you confirm, with the previous file kept as `hooks.json.agent-office-backup-<time>`. `config.toml` and its `notify` setting are never read or changed |
| Never read | conversation text, prompts, command contents, reasoning, credentials (`auth.json`), internal logs |

## OpenCode and pi

Nothing is read from these agents' conversations, settings or credentials to follow their sessions. When you run `agent-office install-hooks opencode` or `pi`, one small file of ours goes into the agent's plugin folder (`~/.config/opencode/plugins/agent-office.js`, `~/.pi/agent/extensions/agent-office.js`); their settings files are not changed, and `uninstall-hooks` removes it. The file runs inside the agent, with your permissions, and passes these fields to the local hook program, nothing else:

| Agent | Events | Fields |
| --- | --- | --- |
| OpenCode | session created or deleted, turn started or ended, tool started or ended, permission asked or answered | session id, folder, tool name, tool call id |
| pi | session start and end (with pi's reason), turn start and end, tool start and end, an extension's prompt opening or closing | session id, folder, tool name, tool call id, whether a tool failed or a turn was aborted |

OpenCode's plugin subscribes to those event types by name, so the events holding prompts, replies and commands are not delivered to it. Without the file, these agents' sessions simply do not appear. A pi session waiting at its trust question for a new folder appears only after it is answered, because pi has no session until then.

`agent-office doctor` reads the same files, read-only, to report on the setup: the hook entries in the agents' settings files (counted, nothing else), and with `--drift` the last 1 MiB of the 50 newest Codex rollouts (`sessions/YYYY/MM/DD/rollout-*.jsonl`) and of the 20 newest Claude Code transcripts (`projects/<project>/<session>.jsonl` and `projects/<project>/<session>/subagents/*.jsonl`), each modified in the last 7 days, printing only counts and key names. Links inside those folders are not followed, and a file that cannot be read is counted by error code, not opened again.

## Processes and environment

The app checks whether an agent process is alive and which terminal or editor owns it, using the process id, parent id, executable name and start time (on macOS with `ps` (`pid`, `ppid`, `lstart`, `comm`), and on Linux from `/proc/<pid>/stat` (the id, parent id, name and start time in clock ticks since boot; nothing else in that file is kept), for the processes your agents' hooks name and their parents; not on Windows yet). It never reads another process's arguments or environment variables. The hook reads only these keys from its own environment, to focus the right terminal window: `TERM_PROGRAM`, `TMUX`, `TMUX_PANE`, `ITERM_SESSION_ID`, `WEZTERM_PANE`, `KITTY_WINDOW_ID`, `KITTY_LISTEN_ON`, `WT_SESSION`, `VSCODE_PID`, and whether `SSH_CONNECTION`/`SSH_TTY` is set (not their values).

To bring the right editor window forward for a session that runs in VS Code (or Cursor, VSCodium), "open session" reads that editor's own window list, `~/Library/Application Support/<editor>/User/globalStorage/storage.json`, for the folders its windows have open (`windowsState.openedWindows[].folder`; nothing else in the file), and gives the folder that holds the session's working folder to the editor's command line inside its bundle. When no window has it open, nothing is opened.

## Local LLM servers

Only the OpenAI-compatible model list endpoint of servers you configure.

## The app's own files

Everything lives in `.agent-office` in your home folder: `config.json`, `token` (user-only permissions), `daemon.json`, `spool/` (hook events and events reported with `agent-office emit`, waiting for the app), `logs/` (capped), `agent-office.sqlite` ([storage.md](storage.md)), and `bin/` (the hook launcher that the agents' hook entries point to).

## Network

None by default. The app listens on `127.0.0.1` only. Outbound requests happen only if you turn them on: price table refresh from models.dev, phone push (status text only, the same text as a desktop notification), and an optional local CodexBar source on your own machine. In server mode you can start a second, read-only listener for watching from a phone or tablet ([events.md](events.md)); it serves the screen, session states, usage and limits to the devices you paired, at the text level you choose, and accepts nothing from them.


## Additional scheduler metadata

Every 30 seconds, read-only: Claude desktop Code and Cowork `scheduled-tasks.json` manifests under the app's account/org directories, plus Code `local_*.json` records for exact task/CLI session links; OpenClaw's `cron/jobs.json` and bounded `cron/runs/<job>.jsonl` tails; Hermes's `cron/jobs.json`. Provider home overrides select one installation/profile. The respective adapter descriptors enumerate all fields. Only names, identifiers, status, rule, next/processed/run times and working folders leave each parser. Prompts, scripts, descriptions, payloads, delivery/account destinations, messages and output/error summaries are never selected or emitted. Latest OpenClaw shared SQLite is read with explicit metadata columns and individual JSON-leaf projections; only the selected `cron.store` machine-state value chooses a partition. Hermes durable `executions` metadata and matching bounded admission-receipt IDs enrich its JSON definitions. No fallback to stale OpenClaw JSON occurs if the latest store cannot be read. OpenCode 2.2.6 selects only the `schedule` metadata columns, excluding its prompt/action, condition/check and output/state columns. pi exposes an explicit no-native-scheduler source without reading extensions or files. No login, setting edits, scheduling, execution or network requests occur.

Claude recurring next times and actual execution cannot be inferred from its processed-slot timestamp; the screen says they are unconfirmed. OpenClaw running markers mean scheduler admission. Legacy Hermes JSON has no running/session identity field; 0.23.0 durable execution records and optional exact admission receipts are kept distinct from live model activity. These schedule readers do not add OpenClaw/Hermes process or approval monitoring.
