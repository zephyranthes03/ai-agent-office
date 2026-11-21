---
summary: What happens when a character or a list row is pointed at or clicked: the hover card, the pinned detail panel and the phone bottom sheet, the ways to open the exact session, the control actions an adapter may declare, and the request and duplicate-prevention rules.
read_when: You implement the hover card, the detail panel or the phone bottom sheet, add an open-session means or a control to an adapter, or change how control requests are confirmed.
---

# Click panel and controls

Pointing at a character or a row of the session list opens a small preview card; a click pins it as the detail panel. The default action is to open the exact session in its original tool. Control buttons appear only for controls the adapter has declared.

## Preview card

- Pointing at a character or a row opens a small read-only card after a short delay: name tag, state, elapsed time, last signal. Keyboard focus shows the same card. Pointing never runs a command.
- A click or Enter pins it as the detail panel beside the scene, which never covers the scene. On a phone a tap opens the same card as a bottom sheet; closing it returns to where the user was.
- A character being looked at stops moving, and new events never change which session an open card or panel shows.

## Detail panel

- State (icon + text), waiting reason and target, last result, project, elapsed time. For a turn that runs long, the turn time, the time in the current state, the last signal and the last liveness check are shown separately, with the basis of the marker (for example "over your 20-minute mark").
- Default button: **Open session**. Double-clicking the session's row in the list does the same.
- Below it, only the declared control buttons.

## Open session

Each tool supports some of the means below. The adapter implements the supported ones, and when several are available they are tried from most to least precise.

| Means | Description | Verified for |
| --- | --- | --- |
| `session_link` | Open the session through a deep link or web URL. Used only when the adapter can obtain the URL from the provider; it is never assembled from an id | Claude Remote Control shows a URL per session that opens it on claude.ai/code; its exact form, and whether agent-office can obtain it locally, are unverified. Unverified for Codex |
| `cli` | Run the resume command with the session ID in a new terminal | `claude --resume <session-id>` and `codex resume <SESSION_ID>` exist (checked with `--help` on 2026-10-19) |
| `api` | Use an API or app-server protocol of the tool | Unverified. Codex app-server exposes `thread/read` and `thread/resume`, but resuming makes the client an active participant |
| `focus_window` | Bring the already open terminal or tmux window to the front | Window focus by PID follows the CodexBar approach; tmux pane focus is our addition. See [notifications.md](notifications.md) |

On a phone (server mode) the bottom sheet hands off instead of acting: it shows the provider's session link when the adapter can obtain one; otherwise it names the machine and the session, with the resume command and the tmux window to copy.

Window focus and terminal activation are OS-specific and live behind the platform layer.

## Controls

Each control is a distinct action and is never merged with another.

| Control | Meaning |
| --- | --- |
| `pause` | Stop the work and keep its state. Can be resumed |
| `resume` | Continue paused work |
| `interrupt_turn` | Stop only the current response or tool call; the session stays alive |
| `cancel` | End the work itself |
| `rerun` | Run the same work again. May create a new session |
| `stop` | End the agent's process. The conversation stays and can be opened again. Not while the session is at work |
| `restart` | Stop the process, then open the same conversation in a new terminal window |
| `start` | Open a new session of the agent in a folder, in a new terminal window, with no prompt |

`pause` to `rerun` act on a turn; `stop`, `restart` and `start` act on the agent's process (below).

Three rules that keep different things apart:

- **Stopping the animation is not stopping the work.** The screen pause button only freezes the picture and uses a different place and wording than work controls.
- **Disabling a schedule is not interrupting the current run.** Scheduled tasks show "turn off from the next run" and "stop the current run" separately.
- **Approve and reject are not controls.** Approval happens by opening the session in the original tool.

## Adapter declaration

An adapter declares what it supports. This is the shape:

```json
{
  "id": "example-agent",
  "open": ["session_link", "cli", "focus_window"],
  "controls": ["interrupt_turn", "cancel"],
  "schedule": ["disable_next"]
}
```

(The planning record used the key `adapter`; the schema names it `id`. Real descriptors also carry strategies, tool classes and permissions — see the `descriptor.json` shipped with each adapter.)

The card shows only controls declared by the adapter. In this release Claude Code declares `start`. Use **Open session** to manage an existing conversation in its terminal. **Hide from list** hides its entry until new activity arrives. Hiding a session leaves its process running.

## Starting a Claude Code session

**Start.** The list's "New session" asks for the agent and a folder (the folders of the sessions the office knows, or another absolute path). It is offered only for an agent whose hooks have reached the daemon, because only a hook can confirm the start. The daemon chooses the session's id, opens a new window in the terminal app of the latest terminal session (iTerm2, otherwise Terminal.app), and the start counts as done when the new process reports that id. The new session waits by the office's front until its first prompt.

**After a daemon restart** the daemon settles the requests it was waiting on from what it finds, before it checks any process: a stop whose process is gone is done; one whose process still runs, and a restart whose window had not opened, are reported as interrupted. It sends no signal and opens no window again.

Not on the phone viewer: its listener answers `405`.

## Background services

OpenClaw's and Hermes's gateways, OpenCode's background server and Codex's app-server daemon can be started, stopped and restarted from their agent's line in the schedule list, on macOS. The tool's own command does the work; the office never signals these processes. Each button asks once more.

| Service | Identified by | Counts as stopped | Counts as running |
| --- | --- | --- | --- |
| OpenClaw gateway | its launchd job, which must be the process its status names | status stopped, process gone, job unloaded | a new process and the gateway answering its connection check |
| Hermes gateway | its launchd job, with the gateway process below it | status not running, both processes gone, job unloaded | a new gateway process |
| OpenCode server | the process listening on the port its status names | status `stopped`, process gone | a new process |
| Codex app-server daemon | the process holding its log file open | no daemon to connect to, process gone | a new process |

**Protecting scheduled runs.** Stop and restart are refused while one of that agent's scheduled tasks is running or due within 10 minutes, and the line says why. A Codex thread at work does not refuse them, and the confirmation says every thread of the daemon stops with it. OpenClaw's own command refuses to stop a running gateway unless told it is meant, so the office passes `--force` after the confirmation.

**Time limits.** A command may run for a limit set per service (Hermes up to 32 minutes, because it lets runs in flight finish first); after a limit the request reports that, and nothing is retried. The office checks what happened after the command returned, so a command that exits cleanly with the service unchanged is reported as not done. After a daemon restart an open request is settled from what is found and no command runs again. Codex's updater keeps running after its daemon stops; the office leaves it alone.

## Control request flow

1. Pressing a button creates a request bound to the target session ID, locks the button, and shows "requesting" on the character and on the boards.
2. The state changes only after the tool's response or a state event confirms the result. Pressing the button is never shown as success by itself.
3. On failure or timeout, the reason is shown and the previous state is restored.

Requests and their outcomes are stored for the History sub-tab ([storage.md](storage.md)); the lifecycle controls' requests are also sent on the stream as `controls` ([events.md](events.md)), so the card, the list's chip and the start form show the daemon's word, not the click.

## Duplicate and misclick prevention

- The target is the session ID, never a screen position or character order.
- A session with a pending request accepts no new request. Every request carries a unique key so it is never processed twice.
- Right before sending, the daemon re-checks that the session is still alive and is the same session the panel was opened for. If not, the request is blocked and the panel is refreshed.
- `rerun`, `cancel`, `stop` and `restart` ask for one extra confirmation.

## Related

- The same rules apply in the control tab: [control-tab.md](control-tab.md)
- Notification click opens the Queue sub-tab and can open the session: [notifications.md](notifications.md)
