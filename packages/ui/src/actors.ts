// Who the office scene draws, and how: each session in the office on its seat, the ones that wait
// in the waiting room marked as arriving, and the ones on their way home as departing. Pure: the page
// passes its views and seats, the scene gets the actors.
import type { SceneActor } from "./scene.ts";
import type { SessionView } from "./model.ts";

/**
 * The actors for `inOffice` (on the seats `seats` gives them) and for `departing` sessions no longer
 * in the office. Waits, failures and finished turns carry how long they have lasted, from when the
 * daemon says they began (attention's `since`); the scene counts other states itself.
 */
export function sceneActors(inOffice: readonly SessionView[], departing: Iterable<SessionView>, seats: ReadonlyMap<string, string>, nowMs: number): SceneActor[] {
  const actors = inOffice.map((view) => {
    // Resting with background work still running: it stays at its desk, at work, until that work is over.
    const actor: SceneActor = { id: view.id, species: view.species, identity: view.identity, state: view.subprocesses > 0 ? "working" : view.event.state, lifecycle: view.event.lifecycle, seat: seats.get(view.id)!, faded: view.faded };
    // Only opened, gone quiet, or a scheduled task's stand-in before its run: on a bench in the waiting room until a signal takes it to the office.
    if (view.opened !== null || view.event.state === "unknown" || view.standIn || view.benched) actor.waiting = "arrival";
    // A turn on the daemon's `long` list: the colleague works on at its laptop, tired.
    if (view.long !== null) actor.long = true;
    const known = view.needs ?? (view.event.state === "idle" ? view.ready : null);
    const since = known === null ? Number.NaN : Date.parse(known.since);
    if (Number.isFinite(since)) actor.elapsed = Math.max(0, (nowMs - since) / 1000);
    return actor;
  });
  // On the way home: still active as far as the scene is concerned, resting on a bench before it leaves.
  for (const view of departing) if (!inOffice.some((item) => item.id === view.id)) actors.push({ id: view.id, species: view.species, identity: view.identity, state: "idle", lifecycle: "active", seat: seats.get(view.id)!, faded: false, waiting: "departure" });
  return actors;
}
