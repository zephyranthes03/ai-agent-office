---
summary: One-page introduction to the project, its differentiators, the character model, and shared terminology.
read_when: You are new to the repository, or you need the canonical meaning of a term used in other docs.
---

# Overview

A local, source-available tool that shows the sessions of several AI coding agents (Claude Code, Codex, later Hermes, OpenClaw and others) as a cute idle-game office, together with the utilities that make it worth keeping open all day: notifications when an agent needs you or has finished, usage and quota, and local server health.

- **Game side**: the characters are round animal colleagues; a session is one character with its own species (eight animals; or one species per agent kind, a cat for Claude Code and an otter for Codex, with `scene.cast: per-agent`), and every session is in one office, with a list of every session beside it. A small board and a cabinet of monthly rewards hang on the office's side walls and open their records when clicked. Kinds of work become zones inside that office later, never separate rooms to switch between.
- **Utility side**: who needs you (an approval or input wait, a failed turn, a session lost mid-turn) and who has finished and waits for the next instruction, how much subscription quota is left, and whether the local LLM server is alive, all at a glance. The screen is meant to be watched from the corner of the eye: the movement on the floor is background, and only those signals call you ([notifications.md](notifications.md)).
- **Openness**: both the agent side (standard events) and the art side (character packs, room packs) are open formats, so the community can fill in the game while the maintainer focuses on daemon and adapter quality.
- **Self-contained**: no feature requires another monitoring app to be installed. External tools attach only as optional extensions.
- **Platform**: the core (daemon, standard events, adapters, web screen) is platform-neutral. Only process lookup, window focus, notifications, and sleep prevention are implemented per OS. The daemon can also run headless on a development server and be watched from a phone or tablet through a read-only viewer, with phone push as the notification channel (server mode, after the first release; [events.md](events.md)).
- **Principle**: everything runs locally, only metadata is read (never conversation content), and nothing is sent outside unless you turn on phone push or the remote viewer.

The first public version ships two agents (Claude Code and Codex), attention notifications, and one office.



Every agent is normalized into one standard event stream; the screen and the notifier only see that stream. See [events.md](events.md).

## How this differs from existing tools

Game screens and usage dashboards each exist. No tool combines the two and gathers several agent kinds on one screen.

| Tool | What it does | Gap |
| --- | --- | --- |
| [Pixel Agents](https://github.com/martinmunozhr/pixel-agents) | VS Code extension; shows agents as pixel-art office characters | Claude Code only; waiting and completion are detected by heuristics that are often wrong; no usage or cost |
| [CodexBar](https://github.com/steipete/CodexBar) | macOS menu bar app and CLI (MIT). Quota, reset time, cost estimate, and outage status for 100+ services. Agent Sessions lists Codex, Claude Code, and pi sessions and focuses their windows | Approval-wait state, tmux pane focus, and history are explicit non-goals; no game screen; no Hermes or OpenClaw |

Three differentiators: hook-based, accurate tracking of several agents; approval-wait notifications at the center (a CodexBar non-goal); and local LLM server status on the same screen. Usage and cost follow CodexBar's approach but are implemented in-house for the services we need; CodexBar itself is only an optional source.

## Character model

One conversation (session or process) is one character. The characters are round animal colleagues; by default the session id picks the species (one of eight) and its colours, so an individual always looks the same and three Claude Code windows are told apart; with `scene.cast: per-project` every session of a project gets the same species, and with `scene.cast: per-agent` the species tells which tool a session belongs to instead. A session that needs you or runs long always has its own character.

| Game concept | Maps to | Example |
| --- | --- | --- |
| Species | Session (default), project or agent kind | By default from the session id over eight animals; with `scene.cast: per-project`, from the project's folder name; with `scene.cast: per-agent`, Claude Code = cat, Codex = otter and other kinds bird; a species chosen on the card wins |
| Individual | One session (`session`) | The cat working on ai-pii |
| Child | Subagent (`parent` set) | Follows its parent, disappears when done |
| Desk group | Project folder (`cwd`) | A Claude Code cat and a Codex otter in the same repo sit side by side |

- **Telling individuals apart**: the character, its colours, name tag, and props are derived from the session ID and stay the same for that session. The name tag shows the project folder name.
- **Life cycle**: session start = arriving through the door, session end = leaving, resume = the same individual arriving again.
- **State**: see the glossary below. Spawning a subagent is not a state; it is the event of a child appearing (a first event with `parent` set).
- **Always-on agents** (Hermes, OpenClaw): one messenger conversation is one individual. Where there are no per-conversation events, start with one process = one individual.
- **Role props**: Codex records subagent roles (explorer, reviewer, worker) and the guardian auto-approval review, so these can be shown as role props or a guard character.
- **Entry-point props**: Claude Code's `entrypoint` (`claude-desktop`, `claude-vscode`, `sdk-ts`) distinguishes where a session was opened.

## Screen at a glance



Mockup caption: at the top, the lobby board with quota bars, an approval-wait badge, today's cost, and a notification ticker. Bottom left, the office room: a whiteboard listing sessions (session, project, state) with the approval-wait row highlighted, and four assigned desks with two cats, one dog, and one empty seat; the waiting cat has its hand raised. Right, the server-room status board (now planned as service equipment inside the office, after v1) with LLM server liveness, memory and GPU bars, and process liveness. The Claude quota bar in this mockup is out of v1 scope. The mockup predates the current cast and layout: the characters are round animals (cats for Claude Code, otters for Codex) and a waiting character keeps its place with a marker; the office is one space with a list of every session beside it (tabs Needs you, Finished and All, with search), which takes over the whiteboard's session list, and the lobby board above it is a summary row. Boards and the list are specified in [ui-boards-and-labels.md](ui-boards-and-labels.md).

## Glossary

| Term | Meaning |
| --- | --- |
| Agent kind | A type of agent (Claude Code, Codex, ...). Shown as a species. |
| Session | One conversation or process of an agent. Shown as one character (individual); a session that needs you or runs long always has its own character, and the list beside the office holds every session. |
| Subagent | A session with `parent` set. Shown as a child that follows its parent. |
| Project folder | The session's working directory. Characters from the same folder form a desk group. |
| Space / room | The office, one space on one screen. Kinds of work become zones inside it later, chosen by the kind of work. See [spaces.md](spaces.md). |
| State | One of `idle`, `working`, `waiting_dependency`, `waiting_user`, `error`, `done`, `unknown`, plus `paused` and `cancelled` where supported. |
| `waiting_on.reason` | Why a session waits: `approval`, `input`, `child`, `tool`, or `schedule`. |
| Boards | Lobby board (the summary row), room whiteboard, service cards (after v1), timetable board. Static panels for numbers and lists; the list of every session sits beside the office. |
| Control tab | The second tab beside the game screen with sub-tabs Sessions, Queue, Usage, Servers, Schedule, History, Settings. See [control-tab.md](control-tab.md). |
| Open session | The default click action: open the exact session in its original tool via `session_link`, `cli`, `api`, or `focus_window`. |
| Controls | `pause`, `resume`, `interrupt_turn`, `cancel`, `rerun`. Only shown when the adapter declares them. See [click-panel-and-controls.md](click-panel-and-controls.md). |
| Adapter | Per-agent module that turns hooks, logs, or APIs into standard events. |
| Pack | A character pack (one character; several packs may share a species) or a room pack (one space). See [packs.md](packs.md). |
