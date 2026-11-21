# Schemas

JSON Schema (draft 2020-12) for the file formats and wire formats the app owns. They are the contract between the app, pack authors, and scripts that post events.

| Schema | Describes | Consumers |
| --- | --- | --- |
| `event.schema.json` | Standard event = one session's state report (`POST /v1/events`, `emit`) | app, scripts |
| `hook-envelope.schema.json` | What the hook program sends to the app (allowlisted hook fields + process/terminal identity; content fields are forbidden) | hook, app |
| `character-pack.schema.json` | `manifest.json` of a character pack (Aseprite sheet + tag mapping + licence) | pack authors, app |
| `room-pack.schema.json` | `manifest.json` of a room pack (Tiled map + markers + overrides + licence) | pack authors, app |
| `config.schema.json` | `~/.agent-office/config.json` user settings | you, app |

`examples/` holds valid documents for these schemas; they double as documentation.


## Compatibility rules

1. **Fields are only added, never removed or renamed.** A removed field keeps its name and becomes optional/ignored.
2. **Unknown fields are ignored, never rejected.** No schema sets `additionalProperties: false` on a document root. (The `terminal` allowlist in the hook envelope is the one deliberate exception: it is a privacy boundary, and the hook controls both sides.)
3. **`schema_version` is an integer in every document root.** It changes only for an incompatible change (a required field added, a type changed, an enum value removed). Readers accept any version ≤ theirs and log-and-ignore newer ones instead of failing.
4. **Enums grow.** Readers treat unknown enum values as their closest safe default (`state` → `unknown`, `reason` → `tool`, `origin` → `unknown`) and keep going.
5. **Length caps are part of the contract.** `detail`, `target`, titles: 64 characters; the app truncates and strips control characters again on receipt.
