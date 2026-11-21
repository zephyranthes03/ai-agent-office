// What the page knows and what follows from it: the sessions, lists and settings the daemon's stream
// sent, the office worked out from them, who sits where and who is on the way home. Nothing here
// touches the document: app.ts hands it the stream's events and shows what it holds.
import type { StandardEvent } from "@agent-office/core";
import type { Settings } from "./client.ts";
import { DEFAULT_NEEDS_MARKER } from "./format.ts";
import { DEFAULT_WANDER_AFTER_S } from "./life.ts";
import { DEFAULT_BENCH_BEFORE_S, DEFAULT_CAST, DEFAULT_REST_AFTER_S, NO_ATTENTION, NO_SCHEDULE, officeOf } from "./model.ts";
import type { Attention, Notes, Office, Schedule, SessionView } from "./model.ts";
import { allocateSeats } from "./seats.ts";
import type { Seated, Seating } from "./seats.ts";
import { withSettings } from "./settings.ts";
import type { SceneChoices } from "./settings.ts";

export type OfficeStore = {
  /** A connection's full list of sessions: the ones the daemon no longer has are let go. */
  setSessions: (list: readonly StandardEvent[]) => void;
  setSession: (event: StandardEvent) => void;
  setAttention: (list: Attention) => void;
  setSchedule: (list: Schedule) => void;
  setNotes: (list: Notes) => void;
  /** The owner's settings, as far as they choose how the office looks (settings.ts). */
  setSettings: (settings: Settings) => void;
  /** Whether the waiting room is shown; turned off, nobody is on the way home on screen. */
  setShowWaiting: (shown: boolean) => void;
  /** Works out the office, who is on the way home and everyone's seat from what is known, at `nowMs`. */
  derive: (nowMs: number) => void;
  /** Colleagues that walked out of the front door: they are no longer on the way home. Whether any of them was. */
  left: (ids: Iterable<string>) => boolean;
  /** Whether the next drawing puts everyone in place at once: after a connection's lists, until one is `drawn`. */
  instant: () => boolean;
  drawn: () => void;
  /** Whether the daemon listed this session. */
  has: (id: string) => boolean;
  office: () => Office;
  seating: () => Seating;
  /**
   * Sessions on their way home (gone away after a long rest, sent home, ended): kept in the scene,
   * with the last the daemon said about them, until they have walked out of the waiting room.
   */
  departing: () => ReadonlyMap<string, SessionView>;
  attention: () => Attention;
  /** The scheduled tasks the agents' schedulers plan. */
  schedule: () => Schedule;
  notes: () => Notes;
  choices: () => SceneChoices;
  showWaiting: () => boolean;
};

export function createOfficeStore({ showWaiting: waitingShown }: { showWaiting: boolean }): OfficeStore {
  const sessions = new Map<string, StandardEvent>();
  const order: string[] = [];
  let attention: Attention = NO_ATTENTION;
  let notes: Notes = {};
  let schedule: Schedule = NO_SCHEDULE;
  let choices: SceneChoices = { wanderAfterS: DEFAULT_WANDER_AFTER_S, cast: DEFAULT_CAST, benchBeforeS: DEFAULT_BENCH_BEFORE_S, restAfterS: DEFAULT_REST_AFTER_S, labelsShow: "needs-you", needsMarker: DEFAULT_NEEDS_MARKER, needsYouGlow: true };
  let office: Office = officeOf(sessions, order, attention);
  let seating: Seating = { seats: new Map<string, string>(), level: 0, waitingRows: 1 };
  const departing = new Map<string, SessionView>();
  let showWaiting = waitingShown;
  let settle = false;
  let settling = false;

  function remember(event: StandardEvent): void {
    if (!sessions.has(event.session) && !order.includes(event.session)) order.push(event.session);
    sessions.set(event.session, event);
  }

  return {
    setSessions(list) {
      const ids = new Set(list.map((event) => event.session));
      for (const id of [...sessions.keys()]) if (!ids.has(id)) sessions.delete(id);
      for (let i = order.length - 1; i >= 0; i--) if (!ids.has(order[i]!)) order.splice(i, 1);
      for (const event of list) remember(event);
      settle = true;
      settling = true;
    },
    setSession: remember,
    setAttention(list) {
      attention = list;
      // The first list after a full session list completes the picture: nobody walks to a seat they already had.
      if (settling) {
        settle = true;
        settling = false;
      }
    },
    setSchedule(list) {
      schedule = list;
    },
    setNotes(list) {
      notes = list;
    },
    setSettings(settings) {
      choices = withSettings(choices, settings);
    },
    setShowWaiting(shown) {
      showWaiting = shown;
      if (!showWaiting) departing.clear();
    },
    derive(nowMs) {
      const before = office;
      office = officeOf(sessions, order, attention, notes, choices.cast, schedule, choices.benchBeforeS, nowMs, choices.restAfterS);
      // A session that was in the office and no longer is (away, ended, or gone from the list) walks
      // home through the waiting room; one back in the office (its next turn) is simply back.
      const inOffice = new Set(office.inOffice.map((view) => view.id));
      for (const id of departing.keys()) if (inOffice.has(id)) departing.delete(id);
      if (showWaiting) for (const view of before.inOffice) if (!inOffice.has(view.id) && view.opened === null) departing.set(view.id, office.all.find((item) => item.id === view.id) ?? view);
      // A session only opened waits on a bench (its seat need says so); one going home takes a bench too.
      const people: Seated[] = [...office.inOffice.map((view) => ({ id: view.id, need: view.seat, project: view.event.project })), ...[...departing.values()].map((view) => ({ id: view.id, need: "wait" as const, project: view.event.project }))];
      seating = allocateSeats(seating.seats, people);
    },
    left(ids) {
      let left = false;
      for (const id of ids) left = departing.delete(id) || left;
      return left;
    },
    instant: () => settle,
    drawn() {
      settle = false;
    },
    has: (id) => sessions.has(id),
    office: () => office,
    seating: () => seating,
    departing: () => departing,
    attention: () => attention,
    schedule: () => schedule,
    notes: () => notes,
    choices: () => choices,
    showWaiting: () => showWaiting,
  };
}
