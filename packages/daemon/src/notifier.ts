// When to notify (docs/notifications.md). The input is the attention list the daemon already judged;
// nothing is judged again. Each needs-you entry (session, signal, since) is one episode and is
// notified once; leaving the list and coming back is a new episode. Waits must last `min_wait_s`
// (`min_wait_s_sdk` for sdk sessions, which auto-deny within seconds). Entries already present when
// the daemon finishes starting (spool drained, first liveness pass) are listed, not notified: what
// a restart replays is past news. The text a channel shows is built by the channel; privacy is
// applied here, once.
import { toMs } from "@agent-office/core";
import type { StandardEvent } from "@agent-office/core";
import type { Attention, NeedsYouSignal } from "./attention.ts";
import type { Note } from "./notes.ts";

export type NotifyRules = {
  waitingUser: boolean;
  error: boolean;
  lost: boolean;
  /** A scheduled task's occurrence passed with no run while the daemon watched (notifications.schedule_missed). */
  scheduleMissed: boolean;
  ready: boolean;
  /** With ready on, the shortest turn that is notified; 0 = every turn. */
  readyMinTurnS: number;
  minWaitS: number;
  minWaitSdkS: number;
  /** Hide project names and tool targets (privacy.screen_share_mode). */
  screenShare: boolean;
  /** What a click on the notification opens (notifications.channels.desktop.click_opens). */
  opens: "session" | "queue";
};

import type { Notification } from "@agent-office/core";
export type { Notification };

export type Step = { notifications: Notification[]; /** When a pending wait becomes due, else null. */ dueMs: number | null };

const WAITS: readonly NeedsYouSignal[] = ["approval", "input"];

export class Notifier {
  private readonly rules: NotifyRules;
  /** Episodes already notified or set aside, by id; pruned to the ones still listed. */
  private seen = new Set<string>();
  private started = false;
  private noteOf: (id: string) => Note | undefined = () => undefined;
  private taskOf: (key: string) => { agent: string; name: string | null } | undefined = () => undefined;

  constructor(rules: NotifyRules) {
    this.rules = rules;
  }

  /** Marks every entry listed now as already known; notifications start after this. */
  baseline(list: Attention): void {
    this.seen = new Set([...list.needs_you.map((entry) => idOf(entry.session, entry.signal, entry.since)), ...list.ready.map((entry) => idOf(entry.session, "ready", entry.since))]);
    this.started = true;
  }

  /** `taskOf`: a missed scheduled task by its key (its agent and name name the notification). */
  step(list: Attention, sessionOf: (id: string) => StandardEvent | undefined, nowMs: number, noteOf: (id: string) => Note | undefined = () => undefined, taskOf: (key: string) => { agent: string; name: string | null } | undefined = () => undefined): Step {
    this.noteOf = noteOf;
    this.taskOf = taskOf;
    if (!this.started) return { notifications: [], dueMs: null };
    const listed = new Set<string>();
    const notifications: Notification[] = [];
    let dueMs: number | null = null;
    for (const entry of list.needs_you) {
      const id = idOf(entry.session, entry.signal, entry.since);
      listed.add(id);
      if (this.seen.has(id) || !this.enabled(entry.signal)) continue;
      const event = sessionOf(entry.session);
      if (WAITS.includes(entry.signal)) {
        const due = toMs(entry.since) + 1000 * (event?.origin === "sdk" ? this.rules.minWaitSdkS : this.rules.minWaitS);
        if (due > nowMs) {
          dueMs = dueMs === null ? due : Math.min(dueMs, due);
          continue;
        }
      }
      this.seen.add(id);
      notifications.push(this.make(id, "needs_you", entry.signal, entry.session, entry.since, event, sessionOf, null));
    }
    for (const entry of list.ready) {
      const id = idOf(entry.session, "ready", entry.since);
      listed.add(id);
      if (this.seen.has(id)) continue;
      this.seen.add(id);
      const long = this.rules.readyMinTurnS === 0 || (entry.turn_s !== null && entry.turn_s >= this.rules.readyMinTurnS);
      // A session the owner asked to hear about when it starts resting is notified whatever the defaults say.
      const asked = noteOf(entry.session)?.alert_on_rest === true;
      if ((this.rules.ready && long) || asked) notifications.push(this.make(id, "ready", "ready", entry.session, entry.since, sessionOf(entry.session), sessionOf, entry.turn_s));
    }
    for (const id of this.seen) if (!listed.has(id)) this.seen.delete(id);
    return { notifications, dueMs };
  }

  private enabled(signal: NeedsYouSignal): boolean {
    if (signal === "approval" || signal === "input") return this.rules.waitingUser;
    return signal === "schedule_missed" ? this.rules.scheduleMissed : this.rules[signal];
  }

  private make(id: string, kind: Notification["kind"], signal: Notification["signal"], session: string, since: string, event: StandardEvent | undefined, sessionOf: (id: string) => StandardEvent | undefined, turnS: number | null): Notification {
    // Children notify under the parent's name.
    const named = event?.parent ? (sessionOf(event.parent) ?? event) : event;
    const hide = this.rules.screenShare;
    // The nickname stays in screen-share mode (it is the owner's own label); the project does not.
    const nickname = (named === undefined ? undefined : this.noteOf(named.session)?.nickname) ?? null;
    // A missed scheduled task has no session: its agent and name come from the schedule.
    const task = signal === "schedule_missed" ? this.taskOf(session) : undefined;
    return {
      id,
      kind,
      signal,
      session,
      since,
      agent: task?.agent ?? named?.agent ?? event?.agent ?? "unknown",
      title: task !== undefined ? (hide ? null : task.name) : (nickname ?? (hide ? null : (named?.project ?? null))),
      target: hide || kind === "ready" ? null : (event?.waiting_on?.target ?? null),
      turn_s: turnS,
      opens: this.rules.opens,
    };
  }
}

const idOf = (session: string, signal: string, since: string): string => `${session}|${signal}|${since}`;
