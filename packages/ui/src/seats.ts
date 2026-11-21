// Which seat each session's character holds: the single owner of session id → seat, kept apart from
// the list's order, filters and search. Pure: the previous assignment and the sessions in a stable
// order come in, the next assignment, the room level and the waiting room's rows go out.
//
// Rules (docs/ui-boards-and-labels.md, docs/spaces.md):
// - A session working or waiting on a dependency sits at a desk for the whole turn, never on a
//   rest seat, however many sessions work at once: the room grows instead.
// - A session that waits for the user, failed, went silent or holds (done, paused, cancelled) stays
//   where it is. A new one in that state takes a desk.
// - A resting session (idle, ready) takes a rest seat when one is free, else stays at its desk.
// - A seat is never taken from its holder to fill a gap, so an occupied wing never folds away;
//   the room shrinks only when its outer wings are empty.
// - Desks of the same project fill together when they can (the project's desk group).
// - A session waiting in the waiting room (only opened, or on its way home) sits on a bench there,
//   keeping its bench while it waits; the room has as many rows as the benches in use need, and a
//   row with someone on it never folds away.
import { capacity, roomAt, seatById, WAITING_ROW_SEATS, waitingRoom } from "./space.ts";
import type { Seat } from "./space.ts";

export type SeatNeed = "work" | "stay" | "rest" | "wait";
export type Seated = { id: string; need: SeatNeed; project: string | null };
export type Seating = { seats: Map<string, string>; level: number; waitingRows: number };

export function allocateSeats(previous: ReadonlyMap<string, string>, people: readonly Seated[]): Seating {
  const waiting = people.filter((person) => person.need === "wait");
  const office = people.filter((person) => person.need !== "wait");
  const kept = new Map<string, Seat>();
  const wantsRest: Seated[] = [];
  for (const person of office) {
    const seat = previous.has(person.id) ? seatById(previous.get(person.id)!) : undefined;
    if (seat === undefined || seat.kind === "wait") continue;
    if (person.need === "work" && seat.kind !== "desk") continue;
    kept.set(person.id, seat);
    if (person.need === "rest" && seat.kind === "desk") wantsRest.push(person);
  }
  // The smallest room that holds everyone, but never one that folds a wing someone still sits in.
  const occupiedWing = Math.max(0, ...[...kept.values()].map((seat) => seat.wing));
  const base = capacity(0);
  let level = Math.max(occupiedWing, Math.ceil(Math.max(0, office.length - base.desk - base.rest) / 6));
  for (;;) {
    const result = place(level, office, kept, wantsRest);
    if (result !== null) {
      const benches = placeWaiting(previous, waiting);
      return { seats: new Map([...result, ...benches.seats]), level, waitingRows: benches.rows };
    }
    level++;
  }
}

/** Benches: a waiting session keeps its bench; a new one takes the first free bench, row by row. */
function placeWaiting(previous: ReadonlyMap<string, string>, waiting: readonly Seated[]): { seats: Map<string, string>; rows: number } {
  const seats = new Map<string, string>();
  const used = new Set<string>();
  let occupiedRow = 0;
  for (const person of waiting) {
    const seat = previous.has(person.id) ? seatById(previous.get(person.id)!) : undefined;
    if (seat?.kind !== "wait" || used.has(seat.id)) continue;
    seats.set(person.id, seat.id);
    used.add(seat.id);
    occupiedRow = Math.max(occupiedRow, seat.waitingRow ?? 0);
  }
  const rows = Math.max(1, occupiedRow + 1, Math.ceil(waiting.length / WAITING_ROW_SEATS));
  const free = waitingRoom(rows).seats.filter((seat) => !used.has(seat.id));
  for (const person of waiting) {
    if (seats.has(person.id)) continue;
    const seat = free.shift();
    if (seat === undefined) throw new Error("The waiting room has fewer benches than its rows should hold");
    seats.set(person.id, seat.id);
  }
  return { seats, rows };
}

function place(level: number, people: readonly Seated[], kept: ReadonlyMap<string, Seat>, wantsRest: readonly Seated[]): Map<string, string> | null {
  const room = roomAt(level);
  const holder = new Map<string, Seated>();
  const seats = new Map<string, string>();
  const byId = new Map(people.map((person) => [person.id, person]));
  for (const [id, seat] of kept) {
    holder.set(seat.id, byId.get(id)!);
    seats.set(id, seat.id);
  }
  const free = (kind: (seat: Seat) => boolean) => room.seats.filter((seat) => kind(seat) && !holder.has(seat.id));
  const take = (person: Seated, seat: Seat) => {
    const old = seats.get(person.id);
    if (old !== undefined) holder.delete(old);
    holder.set(seat.id, person);
    seats.set(person.id, seat.id);
  };
  const deskFor = (person: Seated): Seat | undefined => {
    const options = free((seat) => seat.kind === "desk");
    const score = (seat: Seat) => {
      const neighbours = room.seats.filter((other) => other.desk === seat.desk && other.id !== seat.id && holder.has(other.id));
      if (neighbours.length === 0) return 1;
      return person.project !== null && neighbours.some((other) => holder.get(other.id)!.project === person.project) ? 0 : 2;
    };
    let best: Seat | undefined;
    let bestScore = Infinity;
    for (const seat of options) {
      const value = score(seat);
      if (value < bestScore) {
        best = seat;
        bestScore = value;
      }
    }
    return best;
  };
  const restSeat = () => free((seat) => seat.kind !== "desk")[0];

  // Resting sessions still at a desk move to a free rest seat first, which frees their desk.
  for (const person of wantsRest) {
    const seat = restSeat();
    if (seat === undefined) break;
    take(person, seat);
  }
  for (const person of people) {
    if (seats.has(person.id) || person.need === "rest") continue;
    const seat = deskFor(person);
    if (seat === undefined) return null;
    take(person, seat);
  }
  for (const person of people) {
    if (seats.has(person.id)) continue;
    const seat = restSeat() ?? deskFor(person);
    if (seat === undefined) return null;
    take(person, seat);
  }
  return seats;
}
