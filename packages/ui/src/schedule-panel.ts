// Read-only inventory, including paused/far-off tasks and sources with no visible bench sitter.
import { byId, el } from "./dom.ts";
import { clockDay, scheduleManager, scheduleRule, scheduleStatus } from "./format.ts";
import { t } from "./i18n/index.ts";
import type { Schedule } from "./model.ts";

export function renderSchedulePanel(schedule: Schedule, now: number): void {
  byId("schedule-status").hidden = schedule.sources.length === 0;
  byId("schedule-summary").textContent = `${t().schedules.title} · ${schedule.tasks.length}`;
  byId("schedule-sources").replaceChildren(...schedule.sources.flatMap((source) => {
    const row = el("p", "schedule-source", `${scheduleManager(source.agent)} · ${(source.code === "no_native_scheduler" ? t().schedules.noNativeScheduler : t().schedules.sourceState[source.outcome])}`);
    row.dataset["agent"] = source.agent;
    row.dataset["outcome"] = source.outcome;
    // process-controls.ts fills this with the agent's background service, when it has one.
    const service = el("div", "schedule-service");
    service.dataset["agent"] = source.agent;
    service.hidden = true;
    return [row, service];
  }));
  byId("schedule-tasks").replaceChildren(el("p", "detail-note", t().schedules.definitionsOnly), ...schedule.tasks.map((task) => {
    const next = task.next_run_at === null ? t().schedules.nextUnknown : clockDay(task.next_run_at, now);
    const row = el("p", "schedule-task", `${task.name ?? task.key} · ${scheduleManager(task.agent)} · ${scheduleStatus(task)} · ${scheduleRule(task)} · ${next}`);
    row.dataset["key"] = task.key;
    return row;
  }));
}
