---
summary: When and how the daemon notifies about attention signals (approval/input waits, failed turns, lost sessions, finished turns) and quota events, which channels exist, what the queue tab lists, how a click reaches the right terminal window or tmux pane, and how session, PID and window are linked.
read_when: Implementing the notifier, a notification channel, window focus, or the queue tab; or changing what a notification may contain.
---
# Notifications and window focus

The screen is meant to be watched from the corner of the eye. What calls the user is an **attention signal**: a session that *needs you* (an approval or input wait, a failed turn, a session that fell silent or was lost mid-turn) or one that is *ready* for the next instruction. The single most valuable one is "someone is waiting for me": agents idle in approval prompts waste more time than anything else. Notifications are derived from state transitions, are never acted on inside the game, and carry status text only.

## Triggers

| Event | Condition | Default |
| --- | --- | --- |
| `waiting_user_entered` | A session enters `waiting_user` (approval or input), including scheduled/automation sessions | on |
| `waiting_user_reminder` | Still waiting after `remind_after_min` | off |
| `error_entered` | A session enters `error` (a failed turn); a subagent's failure ends the subagent instead and is its parent's to handle | on |
| ~~`session_silent`~~ | Retired 2026-10-28: a session with no signal for `states.working_stale_s` is still shown as `unknown` with a quiet "?", but it is no longer an attention signal and never notified, because most such turns were long commands or thoughts that came back by themselves. The owner can send it home from its card. `notifications.silent` is accepted and ignored | — |
| `session_lost` | A top-level session that was working, waiting or silent ends because its process is gone (needs exact process liveness: macOS and Linux today). An end the agent reports is not reported: Claude Code reports one on `/exit`, Ctrl+C, closing the terminal and `kill` (SIGTERM), so only a force quit (SIGKILL) or a crash counts as lost; for Codex this is unverified. A child's loss is reported once, through its parent. | on |
| `turn_ready` | A top-level session finished its turn and has had no new prompt since, with no background work of its own still running (commands, subagents or monitors it left on: those wake it again when they end); only turns that took at least `ready_min_turn_min` minutes (default 10; 0 = every turn), counted from the prompt the work began at (a turn that goes on with background work left running counts from that work's first prompt) | off |
| `quota_low` / `quota_reached` / `quota_reset` | A rate-limit window crosses `usage_warn_percent` (default 80 %) / reaches 100 % / resets (names aligned with CodexBar) | on |
| `provider_unavailable` / `provider_recovered` | An adapter strategy stops/starts working (shown in settings, notified once) | on |
| `server_down` / `server_up` | Local LLM server poll fails/recovers (post-v1) | on |
| `schedule_missed` | A scheduled task's occurrence passed with no run while the daemon was watching (`schedule.missed_after_min` after its time, the source read without a gap since before it); an occurrence the daemon could not watch is unsure and never notified. The entry's `session` is the task's key, its title the task's name | on |

The daemon decides when to notify (`packages/daemon/src/notifier.ts`, from the attention list only) and sends `notification` events on its stream ([events.md](events.md)), with screen-share mode already applied; the desktop app turns them into notifications. A notification the system refuses (macOS: the app is not allowed to notify) is logged and shown in the tray menu with a link to the notification settings, never dropped silently. A finished turn is notified only with `notifications.ready` on and when it took at least `ready_min_turn_min`, or, whatever those say, when the owner turned on "쉬기 시작하면 알림" for that session (`alert_on_rest` in its note, since 2026-10-27); a notification names the session by the owner's nickname first (kept in screen-share mode); each signal has its switch (`notifications.waiting_user`, `error`, `silent`, `lost`). Rules: a desktop notification is sent only when the wait has lasted `min_wait_s` (default 3 s; `min_wait_s_sdk`, default 15 s, for sessions with `origin: sdk`). Captured on 2026-10-19: Claude Code in print mode (`claude -p`, transcript `turnOrigin: "sdk"`) fires `PermissionRequest` and auto-denies about 2 s later, so an immediate notification would always be a false alarm. The in-game marker still shows at once. Nothing listed when the daemon finishes starting (the spool drained and the first liveness pass done) is notified, whatever the signal: those entries are listed only, so a restart that replays hours of spooled hooks does not raise them as news (owner decision 2026-10-27; it was a rule for lost sessions only before). One notification per waiting episode per session (re-entering after a release starts a new episode); children notify under the parent's name; `screen_share_mode` and `detail_level` apply to the text; snooze per session from the queue tab (`snooze_default_min`).

The other attention signals follow the same episode, snooze, screen-share and detail rules; `min_wait_s` applies to waits only. The signals form two tiers. **Needs you**: approval and input waits, failed turns, lost sessions, missed scheduled runs (`schedule_missed`, under the task's key, last in the order). **Ready**: a finished turn. The tray icon, the queue badge and the accented number on the lobby board count needs-you sessions only (the lobby board's quiet counts stand apart); a ready session shows a quiet marker and is listed separately, so the count keeps meaning "someone needs you". A turn that runs longer than `states.long_turn_min` minutes (default 20) gets only a quiet clock marker and a quiet count on the lobby board; it is never notified and never counted with needs-you. The silence threshold is `states.working_stale_s`; it will be tuned after use, and whether a long tool run that sends nothing (a build inside one command) crosses it in practice is unverified.

Work a session handed to another session (a delegation, shown as a "위임 N" chip) is in neither tier and is never notified: the session is not waiting, and the daemon cannot see the other session; its result arrives as an ordinary prompt and that turn's end is the ordinary `turn_ready`.

## Content

The event first, then whose it is as the name tag names it (the nickname, else the project, else the agent), and in the body the agent, what the wait is about and the species the office shows for the session: `승인 대기 · <nickname or project>` with `Claude Code · Bash: npm test · 고양이` / `입력 대기 · …` with `… · AskUserQuestion · …` / `턴 실패 · …` (the turn failed; a failed tool is not an error) / `작업 중 종료 · …` / `예약 놓침 · <task name>` (a scheduled run that never came; no species) / `마친 턴 · …` with `… · 12분 걸림 · …`. Never the prompt, the message text, or command arguments beyond what `detail` already allows. In screen-share mode the project and the target are left out: `승인 대기 · <nickname>`, or the agent when there is no nickname.

**Sound.** `notifications.sound` chooses what the desktop app plays with a notification: `chime` (a general chime, the default), `animal` (the cry of the species the office shows for that session: the one chosen on its card, else the one `scene.cast` gives it) or `off`. The app plays the screen's sound files (`packages/ui/static/sounds/`, which the viewer plays too) in a hidden window of its own and keeps the notification itself silent, so the sound is the same on every system and is heard also while the system refuses the banner; notifications within two seconds of a sound make none, and a paused app none at all. A missed scheduled task, or a species whose cry the app does not have, plays the chime; while the app has no chime file, the system's own notification sound plays instead. With species given at random a cry says little, which is why the chime is the default.

## Channels

| Channel | v1 | Mechanism | Click |
| --- | --- | --- | --- |
| In-game | yes | The character waits with the amber marker, a paw held up and a still, warm light around it; after `scene.wander_after_s` (default 5 min) it may move about the office, keeping the marker, its row accented in the list beside the scene, lobby ticker, queue badge | Opens the detail panel |
| Desktop app notification (macOS, Windows, Linux) | yes | Electron `Notification` in the app, with the app's own sound (above). While the system refuses the app's notifications, the office's top bar says so with a button to the system's notification settings (the owner can close the note until the app starts again); they are never sent another way, since refusing may be the owner's choice | `click` → open session (focus order below), then show the queue tab |
| Tray icon | yes | Count of sessions that need you (the menu bar title on macOS); menu: open the app, show the needs-you list, pause notifications for an hour or until turned on again (in memory), a test notification ("알림 시험": a sample approval wait with the owner's sound, each test crying as the next species with `animal`), quit | Opens the menu |
| Headless daemon (no app running) | yes | Plain OS notification from the platform layer: `osascript` (macOS), `notify-send` (Linux), PowerShell toast (Windows) | Not clickable; the browser UI's queue tab is the target |
| Tray mini window (lobby board only) | post-v1 | Small app window | Opens queue tab |
| Phone web push | yes (2026-11-06), opt-in per device | A paired device whose viewer page is at an HTTPS address (a proxy such as `tailscale serve`, named with `--viewer-host`; on an iPhone or iPad the page added to the Home Screen) turns on "이 기기에 알림 받기"; the daemon then sends each notification the viewer gets, at the viewer's detail level (`remote_view.detail`, by default without the tool target) and in the owner's `ui.language`, encrypted to the device (RFC 8291) and signed with the daemon's own key (VAPID), through the device's browser push service only (Apple, Google, Mozilla, Microsoft). The device's service worker shows it in the same words, with the device's own sound, silent while the viewer is on screen. Sent also while the desktop channel is off (a headless server) | Focuses the viewer and opens the card, or opens the viewer there |
| Phone push (ntfy-compatible) | later, opt-in | Outbound HTTP with status text at the remote viewer's detail level; for a server without HTTPS, where web push cannot run | Opens the queue of the remote viewer (`click_url`; how the ntfy apps handle it is unverified) |
| Remote viewer (phone or tablet browser) | server mode, opt-in | The same markers and queue over the read-only viewer listener ([events.md](events.md)); a notification shows as a banner at the top with the desktop app's words and makes the owner's sound (`notifications.sound`; phones need one tap on the page first; a device can turn its sound off) and, where the device can, a short vibration | The banner and the rows open the detail panel (a bottom sheet on a phone), which shows how to reach the session: the provider's session link when the adapter can obtain one, otherwise the resume command and tmux window to copy; the session itself is continued in the original tool |

No separate notifier binary is bundled: the app provides clickable notifications on all three OSes. Windows needs the installer's Start-menu shortcut and AppUserModelID for toasts; Linux click handling depends on the desktop's notification server.

### Capability matrix

What v1 promises per OS. "Unverified" means designed but not yet exercised on that OS; the first smoke test there must confirm it.

| Capability | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Daemon, game screen, control tab, browser UI | yes | yes | yes |
| Claude Code hooks reach the daemon | verified (CLI 2.1.287, exec form) | unverified | hooks fire in a Linux container (CLI 2.1.304); desktop unverified |
| Codex hooks reach the daemon | unverified (the user must trust the hook once in Codex; the trust then persists) | unverified | hooks fire in a Linux container once trusted (0.163.0); desktop unverified |
| Clickable desktop notification (app) | yes | yes (installer shortcut + AppUserModelID) | depends on notification server |
| Open session: CLI resume in a new terminal | Terminal / iTerm2 | Windows Terminal or `cmd` (unverified) | `x-terminal-emulator` or configured terminal (unverified) |
| Focus the agent's window | app activation; tmux / iTerm2 / WezTerm / kitty panes | app activation, best effort (foreground-lock rules); Windows Terminal pane focus unverified | X11: `xdotool` / `wmctrl` if installed; Wayland: generally not possible |
| Process liveness and PID → app | `ps` | PowerShell CIM query (unverified speed) | `/proc` / `ps` |
| Launch at login | login item | login item | XDG autostart file |
| Stay awake while agents run | `powerSaveBlocker` | `powerSaveBlocker` | `powerSaveBlocker` |
| Tray icon | menu bar | notification area | needs AppIndicator support (GNOME extension) |

## Session → process → window

Linking happens once per session from the hook envelope and is verified by the platform layer; nothing reads another process's environment.

1. **PID.** The hook sends its `ppid` (the agent process when installed in exec form). The platform layer checks the executable name against the adapter's `process_names` → `pid_confidence: exact`; if not matching, it walks up the parent chain to find one → `ancestor`; else `unknown`.
2. **Terminal identity.** The hook's allowlisted environment: `TMUX`/`TMUX_PANE` (tmux server socket + pane), `ITERM_SESSION_ID`, `WEZTERM_PANE`, `KITTY_WINDOW_ID`/`KITTY_LISTEN_ON`, `WT_SESSION`, `TERM_PROGRAM`, `VSCODE_PID`, `ssh` flag.
3. **Owning app.** From the PID, walk the parent chain to the first process that is a GUI application (macOS: bundle id via the platform layer; Linux: desktop entry if resolvable). This is the CodexBar approach. Process facts come only from pid, ppid, executable path, start time and argv (CodexBar uses libproc; in Node this is `ps -o pid=,ppid=,comm=,lstart=` through the platform layer). Environment is never read.

### Focus order (`open session`)

| Step | When | Action |
| --- | --- | --- |
| 0 | the session runs in its agent's desktop app and the app's link to it is known | open the link (`codex://threads/<id>`, `claude://code/continue?session=local_…`; adapters); then step 4 brings the app forward if the link does not work |
| 1 | `TMUX_PANE` present | `tmux -S <socket> select-window -t <pane>` and `select-pane`, then activate the owning terminal app |
| 2 | `ITERM_SESSION_ID` present | iTerm2 scripting selects that session, then activate iTerm2 |
| 3 | `WEZTERM_PANE` / `KITTY_WINDOW_ID` present | the terminal's CLI focuses that pane/window |
| 3b | `VSCODE_PID` present (VS Code, Cursor, VSCodium: one process for every window) and the session's folder, or one above it, is open in one of the editor's windows (its own window list, `storage.json` → `windowsState.openedWindows[].folder`) | the editor's command line inside its bundle is given that folder, which it answers by raising the window that holds it; when no window holds the folder nothing is opened and step 4 follows. The window's Codex panel or terminal tab cannot be chosen (unverified whether the extension offers a way). Implemented 2026-11-01 (VS Code verified; the others share its layout, unverified) |
| 4 | owning app known | activate the app (macOS: System Events by PID; Linux: `xdotool`/`wmctrl` if present, else no-op). The owning app is the first ancestor whose bundle id is in a terminal/editor allowlist (CodexBar's list: Ghostty, iTerm2, Terminal, Warp, WezTerm, kitty, Alacritty, VS Code, Cursor, Zed, Claude Desktop; ours starts from the same list and is user-extensible). Window-level raise (Accessibility permission, pick the window whose title contains the project name, degrade to app activation without trust) is post-v1 |
| 5 | process dead, `open` includes `cli` | run the adapter's `open_cli` (`claude --resume <id>`, `codex resume <id>`; both verified 2026-10-19) in a new terminal window |
| 6 | `ssh: true` | cannot focus; show the session id and `open_cli` command to copy |

Implemented 2026-10-27 for macOS (step 0 on 2026-10-29, steps 1, 2, the Terminal tab by the agent's tty, 4 by `open -a` on the outermost app bundle above the agent's process, 5 in the terminal the session ran in, 6); WezTerm and kitty panes are not yet, and on Linux and Windows the card offers the command to copy. A notification click runs it first and loads the card behind with the result; the window comes forward only when nothing worked. Each step reports success/failure to the UI; the panel shows which means worked (`focus_window:tmux`, `cli`, …), mirroring how adapters report the strategy they used.

## Queue tab (the attention list)

Sessions that **need you** come first, in this order: approval and input waits (active sessions, ordered by `state_since`, longest first), failed turns, lost sessions. Each row shows the reason, the target, the project, the elapsed time and the buttons **Open session** and **Snooze**; a lost row has **Dismiss** instead of Snooze and stays until it is dismissed, the session comes back, or the app forgets the ended session (a day later). Below them a separate **Ready** section lists top-level sessions that finished a turn and have had no prompt since, oldest first. A session that ends while waiting leaves the waits and emits `waiting_user_left`: when the agent reported the end it leaves the list, when its process vanished it moves to the lost rows. Notification clicks and the tray icon land here when a session cannot be identified.
