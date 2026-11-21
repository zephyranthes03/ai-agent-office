---
summary: The control tab beside the game screen: seven sub-tabs that show the same data as tables and lists and host every editing action.
read_when: You implement or change a sub-tab, or need to know where a setting or action lives.
---

# Control tab

The control tab is the second tab beside the game screen. It shows the same data as tables and lists and is where you search and operate. The game screen is for seeing everything at a glance; the control tab is for finding and acting.

The session list and the attention list also stay beside the scene on the game screen, as its Needs you, Working, Resting and All tabs; the control tab keeps the tables, search and operations.

## Sub-tabs

| Sub-tab | Shows | Actions |
| --- | --- | --- |
| Sessions | Every session: agent kind, nickname and description, project, room, state, waiting reason, elapsed time, tokens | Sort and filter, edit description, open session, declared controls |
| Queue | The attention list: sessions that need you (approval or input wait, longest first; then failed turns, lost sessions), and below them sessions ready for the next instruction | Open session, snooze notifications, dismiss a lost entry |
| Usage | Subscription quota and reset time per service; tokens and estimated cost per agent kind and project | Choose period, set warning threshold |
| Servers | Local LLM servers and loaded models, memory and GPU, agent process liveness | Refresh |
| Schedule | Scheduled tasks per tool, next run, last result, missed runs | Disable schedule (where supported), open the result session |
| History | State changes, control requests and results, notification history | Search, inspect failure reasons |
| Settings | Head labels, space classification rules, character mapping, notification channels, paired viewer devices (server mode), adapter connection status, hook install and remove | Edit, revoke a paired device |

Usage rules are in [usage-and-cost.md](usage-and-cost.md); history storage in [storage.md](storage.md).

## Rules

- **Linked with the game screen**: selecting a row highlights the matching character on the game screen, and clicking a character can jump to its row here.
- **Same rules as the click panel**: control buttons, the "requesting" indicator, and duplicate prevention follow [click-panel-and-controls.md](click-panel-and-controls.md).
- **Adapter status**: Settings shows each adapter as connected, disconnected, or not installed. Sessions of a disconnected adapter are shown as `unknown`.
- **Shortcuts**: the menu-bar mini window and notifications open the Queue sub-tab directly. See [notifications.md](notifications.md).

## Out of v1

Servers, Schedule, and the controls column depend on post-v1 adapters and platform work; the tabs may exist as empty placeholders in v1.

## Columns and their sources

Every column in the Sessions table comes from a standard event field or from local storage; the control tab never reads agent logs directly.

| Column | Source | Notes |
| --- | --- | --- |
| Agent kind | event `agent` | Shown with the species icon from the character mapping |
| Nickname, description | user data in local storage | Edited here or in the click panel; kept by session ID or scheduled-task name ([storage.md](storage.md)) |
| Project | event `project` | Folder name only |
| Room | classification result | See [spaces.md](spaces.md); v1 is always the office |
| State | reducer output | Meanings in the [overview](overview.md) glossary |
| Waiting reason | event `waiting_on` | `reason` and `target`, shown only in waiting states |
| Elapsed time | time since the last state change | Measured by the daemon, not by the agent |
| Tokens | aggregated `tokens` | Deduplicated as described in [usage-and-cost.md](usage-and-cost.md) |
| Last result | event `result` | Kept after the session returns to `idle` |

Hidden fields follow the screen-share mode of [ui-boards-and-labels.md](ui-boards-and-labels.md): when it is on, description, tool target, and project name are hidden here as well.
