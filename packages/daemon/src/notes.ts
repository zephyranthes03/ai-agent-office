// The owner's notes on sessions: a nickname (shown instead of the project name), a one-line
// description (shown on the card), a star for sessions to watch, whether a finished turn of the
// session is notified, and the character species chosen for it. Written only from the computer
// (owner or UI token); the viewer reads the nickname, star and species, and the description only at
// `remote_view.detail: full`.
import type { Store } from "./store.ts";

import type { Note, ViewerNote } from "@agent-office/core";
export type { Note, ViewerNote };

export const NICKNAME_MAX = 24;
export const DESCRIPTION_MAX = 120;
/** A species id, as in the config's `species` mapping and character packs. */
const SPECIES_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Text the owner typed: control and format characters dropped, line breaks as spaces, trimmed, cut to `max`; empty is null. */
function clean(value: unknown, max: number): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\r\n\t]+/g, " ").replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  return text === "" ? null : [...text].slice(0, max).join("");
}

/** A note from a request body, or null when the body is not one (wrong types, a malformed species); every field but `species` (added later; missing is null) is required. */
export function parseNote(body: unknown): Note | null {
  if (body === null || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  const nickname = clean(value["nickname"], NICKNAME_MAX);
  const description = clean(value["description"], DESCRIPTION_MAX);
  const species = value["species"] ?? null;
  if (nickname === undefined || description === undefined || typeof value["watched"] !== "boolean" || typeof value["alert_on_rest"] !== "boolean") return null;
  if (species !== null && (typeof species !== "string" || !SPECIES_ID.test(species))) return null;
  return { nickname, description, watched: value["watched"], alert_on_rest: value["alert_on_rest"], species };
}

const empty = (note: Note) => note.nickname === null && note.description === null && !note.watched && !note.alert_on_rest && note.species === null;

export class Notes {
  private readonly store: Store;
  private readonly now: () => number;
  private readonly byId = new Map<string, Note>();

  constructor(store: Store, now: () => number) {
    this.store = store;
    this.now = now;
    for (const row of store.sessionNotes()) this.byId.set(row.session_id, { nickname: row.nickname, description: row.description, watched: row.watched === 1, alert_on_rest: row.alert_on_rest === 1, species: row.species });
  }

  get(id: string): Note | undefined {
    return this.byId.get(id);
  }

  /** Stores the note (an empty one removes it). */
  set(id: string, note: Note): void {
    if (empty(note)) {
      this.store.removeSessionNote(id);
      this.byId.delete(id);
      return;
    }
    this.store.putSessionNote({ session_id: id, nickname: note.nickname, description: note.description, watched: note.watched ? 1 : 0, alert_on_rest: note.alert_on_rest ? 1 : 0, species: note.species, updated_at: new Date(this.now()).toISOString() });
    this.byId.set(id, note);
  }

  all(): Record<string, Note> {
    return Object.fromEntries(this.byId);
  }

  /** What a viewer may see: no notification settings; the description only at `full`; the species always (it is what the office draws). */
  forViewer(full: boolean): Record<string, ViewerNote> {
    return Object.fromEntries([...this.byId].map(([id, note]) => [id, { nickname: note.nickname, description: full ? note.description : null, watched: note.watched, species: note.species }]));
  }
}
