---
summary: The open pack formats: character packs as Aseprite sheet exports and room packs as Tiled maps, with required animations, manifest fields, and the asset policy.
read_when: You create or validate a character or room pack, or change what the engine expects from a pack.
---

# Packs

We do not invent a new art format. Packs are the plain output of tools artists already use: characters are Aseprite sheet exports, rooms are Tiled maps.

The authoritative formats are the JSON Schemas [../schemas/character-pack.schema.json](../schemas/character-pack.schema.json) and [../schemas/room-pack.schema.json](../schemas/room-pack.schema.json). Schema compatibility rules (fields are only added, unknown fields are ignored, every file carries a version) apply.

## Character pack (one pack = one character)

A pack is one character of a species. Several packs may declare the same `species`, and the engine picks one of the installed packs for each session from the session id, so an individual always looks the same.

One folder containing:

- a sprite sheet PNG,
- the Aseprite JSON export with animation tags,
- `manifest.json`.

Required animation tags (seven):

| Tag | State | Notes |
| --- | --- | --- |
| `idle` | `idle` | Default posture |
| `walk` | (movement, not a state) | Played while moving between points; the state animation resumes on arrival |
| `work` | `working` | Room packs may override the motion and props |
| `wait_dependency` | `waiting_dependency` | Waiting only for a child, tool, or scheduled result |
| `wait_user` | `waiting_user` | Waiting for input or approval; the state that triggers notifications |
| `error` | `error` | A first reaction, then a held posture with a marker |
| `done` | `done` | A short celebration, then back to `idle` |

Optional tags: `paused`, `cancelled`, `unknown`. When missing, the engine substitutes the default posture plus the state icon.

Optional lifestyle tags: `drink_coffee`, `read_book`, `stretch`. They are not states: the engine may play them only while a character rests (`idle`, ready included), never in another state, and they count against the scene's small motion budget (rest, walk, work and look around; one character walks at a time). The bundled cast does not plan them. `stretch` uses both arms and a relaxed face so it cannot be mistaken for `wait_user`.

Also included:

- colour variants (`palettes`, written as swaps from the default colours) and props for telling individuals apart (role and entry-point props are separate images; personal accessories such as glasses are part of the character's art),
- metadata: name, author, and **license (required)**.

State icons and state text are engine-wide; packs do not redraw them.

## Room pack (one pack = one space)

- A Tiled map plus an object layer marking points: desks, door, boss desk, coffee machine, timetable board, and `board` areas for the panels described in [ui-boards-and-labels.md](ui-boards-and-labels.md).
- Per-state animation overrides and props (for example the tax team's `working` is a calculator).
- Character behavior is a simple state machine moving between the marked points.
- Metadata: name, author, **license (required)**.

Board text is rendered by the engine with a crisp font, not stored in the map as pixels.

## Mapping configuration

How sessions get their species, and the room rules, are user configuration (authoritative schema: [../schemas/config.schema.json](../schemas/config.schema.json)):

```yaml
scene:
  cast: per-session   # default; per-project: one species per project folder; per-agent uses the mapping below
species:              # agent kind → species, for per-agent
  claude-code: cat
  codex: otter
spaces: { ... }   # rules from spaces.md
```

With `per-session` each session gets one of the bundled species from its session id, so it looks the same on every screen and after reconnecting. A species chosen on a session's card (stored with its note) wins over both.

## Asset policy

- Default packs contain only original characters or assets under `CC0-1.0`, `CC-BY-4.0` or `MIT`, so they can ship in every edition of the app, including commercially licensed ones.
- Community packs are welcome under the same licences; how to submit one is in [CONTRIBUTING.md](../CONTRIBUTING.md).
- Packs that imitate existing game characters or brands are not accepted.
- Every pack is checked automatically: valid manifest, allowed licence, `original_work: true`, referenced files present and inside the pack folder, only PNG, JSON, Tiled and Markdown/text files of at most 8 MiB, no symbolic links. Packs contain no code.
- Third-party packs installed from elsewhere declare their permissions in the manifest and are approved by the user on first use (the same model as third-party adapters; see [privacy-security.md](privacy-security.md)).

## Bundled cast and art targets

The bundled characters are round animal colleagues whose body shape differs per species: `otter`, `cat`, `bird`, `dog`, `rabbit`, `fox`, `panda` and `hedgehog`. By default each session gets its own, so sessions of one agent look different; the name tag and the card say which agent a session belongs to. With `scene.cast: per-agent` the default mapping is `claude-code` → `cat`, `codex` → `otter`, and other agent kinds get `bird`.

Individuals of one species are told apart by their name tag and the pack's `palettes`.

Targets for these packs, and a good starting point for community packs:

- Soft 2D/2.5D drawing with large colour areas and few inner lines, shown at about 128 CSS px. That is a working size, not a rule.
- Source resolution, colour count, anchors and frames per direction are fixed when the first species' motion is produced.
- No text, letters, icons or speech bubbles in the art: those are drawn by the engine.
- Aseprite JSON + PNG and Tiled stay the exchange formats.

## v1 contents

v1 ships one office and two species (a cat for Claude Code, an otter for Codex), plus this format documentation.
