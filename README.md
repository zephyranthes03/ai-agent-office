# AI Agent Office

**Privacy first: this app reads only metadata from your AI agents (state, tool names, token counts, folder names, titles), never conversation content, and sends nothing off your machine unless you turn on phone push or the remote viewer.**

A local idle-game office for your AI coding agents. Each session is a round animal colleague (otter, cat, bird, dog, rabbit, fox, panda or hedgehog — one per session, per project or per agent kind) sharing a single cozy office that grows by wings as more sessions start, with a waiting room below, weather outside the arched window that reflects how the office is doing, a wall board of how the month's turns went, and a cabinet of monthly rewards.

Underneath the calm screen is an ambient status board you can keep open all day:

- **Attention signals & clickable notifications**: who needs you right now (an approval or input wait, a failed turn, a session lost mid-turn, or a missed scheduled run) and who has finished a turn (counting background subprocesses whole), with a chime or the colleague's animal cry. Clicking a session or notification brings its terminal tab, tmux pane, VS Code window or desktop app conversation forward, or reopens an ended session.
- **Usage, subscription limits & estimated cost**: Codex rate-limit windows with reset countdowns, plus token counts and API-equivalent estimated USD costs per service, project and model from local logs (`Claude Code`, `Codex`, and custom price overrides in `~/.agent-office/custom-pricing.json`).
- **Schedules & background services**: read-only schedule tracking across Codex, Claude Desktop (Code/Cowork), OpenClaw, Hermes and OpenCode, with one-confirmation start/stop/restart for background gateways and servers.
- **Remote phone & tablet viewer**: optional read-only Wi-Fi / Tailscale viewer (`--viewer`) with 8-character device pairing and encrypted Web Push alerts (RFC 8291 + VAPID).

Supported agents: **Claude Code**, **Codex**, **OpenCode** and **pi** (plus **OpenClaw** and **Hermes** schedule/service monitoring, and `agent-office emit` for any script or cron job). Runs as an Electron desktop app and in any browser at `127.0.0.1` (Node 22.18+).

## Quickstart

```bash
# 1. Install dependencies (Node 22.18 or later)
npm install

# 2. Install hooks for your coding agents (shows exact changes first; keeps a backup)
node packages/cli/bin/agent-office.mjs install-hooks claude-code
node packages/cli/bin/agent-office.mjs install-hooks codex
# Optional plugin reporters:
node packages/cli/bin/agent-office.mjs install-hooks opencode
node packages/cli/bin/agent-office.mjs install-hooks pi

# 3A. Run the desktop app (macOS / Linux / Windows; builds UI and starts or joins the daemon)
npm run app

# 3B. Or run the headless daemon + browser UI
npm run build:ui
npm run daemon
# In another terminal, print a one-time launch link for your browser:
npm run ui
```


## Customizing & generating your own characters

The repository ships with the bundled cozy office and eight animal species in `packages/ui/art-preview`. If you want to change the office, tweak settings, replace a character, or **generate your own animal or human colleagues using copy-pasteable image-generation prompts** (3×3 cut-out rig atlas + pixel-aligned garment mask), read [docs/customizing.md](docs/customizing.md).

## Documentation

| If you want to… | Read |
| --- | --- |
| understand the product | [docs/overview.md](docs/overview.md) |
| customize the office or generate your own character set | [docs/customizing.md](docs/customizing.md) |
| know exactly what it reads, stores and sends | [docs/data-access.md](docs/data-access.md), [docs/privacy-security.md](docs/privacy-security.md), [docs/storage.md](docs/storage.md) |
| see how usage, subscription limits and costs are calculated | [docs/usage-and-cost.md](docs/usage-and-cost.md) |
| connect a script or cron job | [docs/events.md](docs/events.md) |
| draw a character or room pack | [docs/packs.md](docs/packs.md), [CONTRIBUTING.md](CONTRIBUTING.md) |
| browse every document | [docs/index.md](docs/index.md) |

## Principles

- Exact state from hooks and official sources; no guessed waits.
- Approvals happen in the original tool, never in the game UI.
- Agents' files are read-only; the installer only adds hook entries (or a single plugin file) and can remove them cleanly.
- One standard event format; open customization and pack formats.
- Platform-neutral core; OS-specific code confined to one layer.

## Licence

Open source under the [MIT License](LICENSE).

## Contributing

Issues, character sets and room packs are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
