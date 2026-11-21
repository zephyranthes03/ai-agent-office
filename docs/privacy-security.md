---
summary: The privacy and security rules every component follows: metadata only, local only, read-only access to agent data, additive installer, and the contract for running external commands.
read_when: You touch anything that reads agent files or databases, sends data anywhere, runs an external command, or displays text that came from an agent.
---

# Privacy and security

Session logs contain code and conversation content verbatim. These rules therefore sit at the top of the README and apply to every component.

## Principles

- **Metadata only**: read state, tool names, token counts, folder names, and titles. Never read conversation content.
- **Limited reads**: session files are read within a fixed size and time budget. The environment variables of other processes are never read (no `ps eww`, no `/proc/<pid>/environ`). Displayed titles have control characters stripped and are cut to 64 characters, the same rule as CodexBar. The default display is the project name because titles may contain sensitive text.
- **Nothing leaves the machine**: no telemetry. Features that send anything out or let another device look in, such as phone push and the remote viewer, run only when the user turns them on. Push carries state text only; the viewer is read-only (a device can write only its own pairing and its own web push subscription), paired per device with its own revocable token, and shows the text level the user chooses (name tag, state and waiting reason by default). Web push, turned on by each device for itself, sends that same text encrypted to the device through its browser's push service (Apple, Google, Mozilla or Microsoft, and no other address): the service sees when a message goes and its size, not what it says.
- **Content-based classification uses local models only**: classifying a room from content is optional and runs only against a local LLM ([spaces.md](spaces.md)).
- **Read-only access**: the agents' internal databases and logs are opened read-only. When a schema differs from what we expect, only that feature turns itself off and the app keeps running.
- **The installer only adds**: existing hook and `notify` settings are never overwritten, a plugin file of ours is placed only where no file of someone else's has that name, and a remove command is provided.
- **No approval in the game screen**: approving shell commands by tapping a cute UI leads to security incidents. Approval happens in the original terminal.
- **Event API on localhost only**: the HTTP endpoint that accepts standard events binds to the loopback interface only. Received text is displayed, never executed. Changing requests need a token from a file only your user account can read, and web pages cannot send events (no cross-origin access, loopback host check). The optional viewer listener for phones and tablets ([events.md](events.md)) is a separate, read-only listener: off by default, bound only to an address given on the command line, never accepting events, opens or settings. Pairing a device needs a code the owner shows on the computer; each device has its own token, only its digest is stored, and revoking it disconnects it at once. On a plain Wi-Fi address the traffic is not encrypted: others on that network could read what a paired device receives (names, states, waiting reasons at the default `remote_view.detail: status`; never folders), so the daemon warns when it starts.
- **Platform permissions are explicit**: window focus on macOS needs the accessibility permission; the app asks for it only when the user enables window focus, and works without it.

## External execution contract

Any feature that runs a user-supplied command (notification hooks, quota hooks) follows the CodexBar hook contract.

| Rule | Value |
| --- | --- |
| Enablement | Explicit, both globally and per rule |
| Executable | Absolute path only |
| Shell | None; the executable is spawned directly with an argument vector |
| Environment | Allowlist only, plus our own prefixed variables |
| Payload | JSON on stdin |
| Timeout | 0.1–300 s per invocation (configurable); noisy events (`usage_updated`, `provider_unavailable`, `refresh_failed`) are throttled to one per 600 s per provider |
| Caps | 32 rules, 32 arguments, 4 KiB per string, 32 KiB command path, 4 KiB payload; fail closed when exceeded |
| Payload shape | Sorted-key JSON, fractions in 0..1, optional fields omitted rather than null |
| Unknown fields | Ignored (compatibility rule) |
| Sync | Hook configuration is never synced off the machine (CodexBar excludes it from iCloud); ours lives in `config.json` only |

Emitted event names match CodexBar so scripts can be shared: `quota_low`, `quota_reached`, `quota_reset`, `usage_updated`, `provider_unavailable`, `provider_recovered`, `refresh_failed`. Session events (`waiting_user`, `error`, and the attention signals `session_silent`, `session_lost`, `turn_ready`) are added by us and documented in [notifications.md](notifications.md).

## Process control

Stopping, restarting and starting an agent's process ([click-panel-and-controls.md](click-panel-and-controls.md)) is the one thing the daemon does to another program, so it is held to these rules:

- **Only on the owner's click** on the computer (the owner's or the UI token on the loopback listener), behind one confirmation. The viewer and the network cannot ask for it (`405`). Nothing is retried, and after a daemon restart no signal is sent again.
- **One process, one signal.** The process the session's own hooks named and the liveness check verified, looked up again right before with the same start time and the agent's own executable, and listed by the agent's own session list at that id. One signal (`SIGTERM` for Claude Code), never to a process group, never `SIGKILL`; the daemon itself, its parent and init are never targets.
- **What is read to identify it:** process id, parent id, start time and executable name, the path of the executable (macOS: `lsof`'s text-file entry; Linux: `/proc/<pid>/exe`), and whether it has a controlling terminal (macOS: `ps -o tty=`; Linux: `/proc/<pid>/stat`) — never arguments or environment. The agent's session list (`claude agents --json`) is run with that absolute executable, no shell, the environment limited to `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `LANG`, `CLAUDE_CONFIG_DIR` and a fixed `PATH`, within 5 s and 1 MiB; only `pid`, `sessionId` and `kind` are read and nothing is kept. To choose how to restart, the daemon checks whether a transcript file named for the session exists, by name only.
- **What is written:** the request (times and counts, never names or content) in the daemon's database; for a start or restart, the same one-time script a resume uses, which removes a fixed list of another agent session's marker variables (`unset`) and writes its own process id to a file in the daemon's private folder before it becomes the agent.
- **Never:** a prompt or any text into a session, an approval, a stop while the session is at work, an automatic restart of a session that ended on its own.

A background service (a gateway, a local server) is controlled by its own command, not by a signal, on the owner's click and behind one confirmation. The command is found in fixed folders (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`; a file only its owner or root can change), run by absolute path with no shell, an environment allowlist and a time and size limit. Its status output is read for the state, a process id or port and whether the service answered; command lines, addresses and paths in that output are not read, and nothing of it is stored or logged. To identify the process the office reads launchd's job table (ids and labels, no job's arguments or environment), the process listening on the port the status names, or the process holding the service's own log file open.

## Third-party adapters and packs

Third-party adapters, character packs, and room packs declare the permissions they need in their manifest. The user approves them on first use. There is no catalog and no remote download; packs and adapters are local files. See [packs.md](packs.md).

## What we read, by source

| Source | Read | Never read |
| --- | --- | --- |
| Claude Code hooks | The hook input fields listed in [data-access.md](data-access.md) | Prompt text, tool input contents beyond the tool name and a short sanitized target |
| Claude Code session JSONL | Per-line metadata fields (`sessionId`, `cwd`, `entrypoint`, `turnOrigin`, `isSidechain`, usage counts); whether the newest `user` line is exactly Claude Code's interrupt marker (compared, not kept); the session title (`custom-title`/`ai-title` lines) | `message` bodies |
| Claude desktop app | `sessionId` and `cliSessionId` of its Code session records, only when you open such a session | titles, folders and everything else in those records |
| Codex hooks | Hook input fields listed in [data-access.md](data-access.md) | Prompt text, command contents beyond a short sanitized target |
| OpenCode and pi reporter files | The event names and fields listed in [data-access.md](data-access.md) | Prompt text, replies, tool inputs and outputs, permission targets, OpenCode's server password |
| Codex session logs | `session_meta` metadata and `token_count` payloads | `agent_message`, `user_message`, reasoning items |
| Codex SQLite databases | Thread metadata columns, and `threads.name`/`threads.title` for the title its app shows (read-only connection) | `title` beyond sanitized display, prompts of automations |
| Local LLM servers | Model list endpoint | Request or response bodies |

## Testing rules

Tests that touch real accounts, the keychain, or credentials run only when explicitly requested. The default is fixtures and fake stores.

## Desktop app shell

The Electron app follows a fixed baseline: `contextIsolation` on, `nodeIntegration` off, sandboxed renderer, no remote content, a strict Content-Security-Policy, and the renderer talks to the daemon only through the same loopback HTTP/SSE API and UI token as a browser. Electron security releases are applied promptly.

