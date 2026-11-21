// Starting, stopping and restarting an agent's process from the screen (docs/click-panel-and-controls.md). The card offers
// "Stop" and "Restart" for the selected session only when the daemon says it can be done now (the
// adapter declares it, the session runs in a terminal, it is not at work, its process is known), each
// behind one confirmation; the request is sent with the process the card was showing, so a session
// restarted meanwhile is refused. What follows is the daemon's report, never the click: progress,
// then what was observed or why nothing was done. The list's "New session" opens a small form (agent,
// folder; never a prompt). A background service's line in the schedule list offers what the daemon says
// it can do now, also behind one confirmation. None of it exists on the read-only viewer.
import { currentToken, viewerMode } from "./client.ts";
import { byId, el } from "./dom.ts";
import { t } from "./i18n/index.ts";
import { NO_CONTROLS } from "./model.ts";
import type { ControlRequest, ControlsState } from "./model.ts";

/** How long a finished request's outcome stays on the card. */
const OUTCOME_MS = 10 * 60_000;
const OPEN = ["requested", "sent"];

export type ProcessControlsDeps = {
  selectedId: () => string | null;
  agentName: (agent: string) => string;
  now: () => number;
};

/** What a request says now: its progress, its outcome, or why it failed. */
export function requestText(request: ControlRequest): string {
  const words = t().controls;
  if (OPEN.includes(request.status)) return (request.step !== null ? words.steps[request.step] : undefined) ?? words.pending[request.control] ?? "";
  if (request.status === "confirmed") {
    if (request.service !== null) return words.service.done[request.control] ?? "";
    const leftover = typeof request.evidence["leftover_descendants"] === "number" ? (request.evidence["leftover_descendants"] as number) : 0;
    return `${words.done[request.control] ?? ""}${leftover > 0 ? words.leftover(leftover) : ""}`;
  }
  return request.reason === null ? words.failed(request.status) : (words.reasons[request.reason] ?? words.failed(request.reason));
}

export function createProcessControls(deps: ProcessControlsDeps) {
  let state: ControlsState = NO_CONTROLS;
  /** The session and control waiting for the owner's confirmation. */
  let confirming: { session: string; control: "stop" | "restart" } | null = null;
  /** An answer the daemon gave at once (a refusal), shown on that session's card until it changes. */
  let refused: { session: string | null; text: string } | null = null;
  let startOpen = false;
  let startRequest: string | null = null;
  let cardKey = "";
  let startKey = "";
  /** The service and control waiting for the owner's confirmation, and an immediate refusal for one. */
  let serviceConfirm: { agent: string; control: "start" | "stop" | "restart" } | null = null;
  let serviceRefused: { agent: string; text: string } | null = null;

  const latestFor = (session: string): ControlRequest | undefined => state.requests.find((request) => request.session === session);

  /** The list's chip for a session with a request under way. */
  function chip(session: string): string | null {
    const latest = latestFor(session);
    return latest !== undefined && OPEN.includes(latest.status) ? (t().controls.chip[latest.control] ?? null) : null;
  }

  async function post(path: string, body: unknown): Promise<{ status: number; error: string | null; request: ControlRequest | null }> {
    const reply = await fetch(path, { method: "POST", headers: { authorization: `Bearer ${currentToken() ?? ""}`, "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(body), cache: "no-store" });
    const value = (await reply.json().catch(() => ({}))) as { error?: string; request?: ControlRequest };
    return { status: reply.status, error: value.error ?? null, request: value.request ?? null };
  }

  /** The request the answer named, unless the stream already brought a newer word of it (it may arrive first). */
  function remember(request: ControlRequest): void {
    if (!state.requests.some((known) => known.id === request.id)) state = { ...state, requests: [request, ...state.requests] };
  }

  function refusal(status: number, error: string | null): string {
    return error !== null && Object.hasOwn(t().controls.reasons, error) ? t().controls.reasons[error]! : t().controls.requestFailed(status);
  }

  async function ask(session: string, control: "stop" | "restart"): Promise<void> {
    const instance = state.available[session]?.instance;
    confirming = null;
    if (instance === undefined) return render();
    refused = null;
    const reply = await post(`/v1/sessions/${encodeURIComponent(session)}/controls/${control}`, { instance });
    if (reply.request === null) refused = { session, text: refusal(reply.status, reply.error) };
    else remember(reply.request);
    render();
  }

  async function start(): Promise<void> {
    const agent = byId<HTMLSelectElement>("start-agent").value;
    const folder = byId<HTMLSelectElement>("start-folder").value;
    const cwd = folder === "" ? byId<HTMLInputElement>("start-path").value.trim() : folder;
    refused = null;
    const reply = await post("/v1/controls/start", { agent, cwd });
    if (reply.request === null) refused = { session: null, text: refusal(reply.status, reply.error) };
    else {
      startRequest = reply.request.id;
      remember(reply.request);
    }
    render();
  }

  async function askService(agent: string, control: "start" | "stop" | "restart", instance: string | null): Promise<void> {
    serviceConfirm = null;
    serviceRefused = null;
    const reply = await post(`/v1/services/${encodeURIComponent(agent)}/controls/${control}`, { instance });
    if (reply.request === null) serviceRefused = { agent, text: refusal(reply.status, reply.error) };
    else remember(reply.request);
    render();
  }

  function button(text: string, onClick: () => void, className = "quiet-button"): HTMLButtonElement {
    const node = el("button", className, text);
    node.type = "button";
    node.addEventListener("click", onClick);
    return node;
  }

  const failed = (error: unknown) => {
    console.warn("agent-office: control request failed", error);
    refused = { session: deps.selectedId(), text: t().app.daemonUnreachable };
    render();
  };

  function renderCard(): void {
    const box = byId("process-controls");
    const id = deps.selectedId();
    const available = id === null ? undefined : state.available[id];
    const latest = id === null ? undefined : latestFor(id);
    const shown = latest !== undefined && (OPEN.includes(latest.status) || deps.now() - Date.parse(latest.resolved_at ?? latest.requested_at) < OUTCOME_MS) ? latest : undefined;
    const key = JSON.stringify([id, available, shown, confirming, refused, t().languageName]);
    if (key === cardKey) return;
    cardKey = key;
    const children: HTMLElement[] = [];
    if (id !== null && refused !== null && refused.session === id) children.push(el("p", "control-status is-failed", refused.text));
    else if (shown !== undefined) {
      const status = el("p", `control-status${OPEN.includes(shown.status) ? " is-pending" : shown.status === "confirmed" ? " is-done" : " is-failed"}`, requestText(shown));
      status.setAttribute("role", "status");
      children.push(status);
    }
    if (id !== null && available !== undefined && (shown === undefined || !OPEN.includes(shown.status))) {
      const words = t().controls;
      if (confirming !== null && confirming.session === id) {
        const control = confirming.control;
        const row = el("div", "control-actions");
        row.append(button(control === "stop" ? words.confirmStop : words.confirmRestart, () => void ask(id, control).catch(failed), "quiet-button is-confirm"), button(words.cancel, () => ((confirming = null), render())));
        children.push(el("p", "control-ask", control === "stop" ? words.askStop : words.askRestart), row);
      } else {
        const row = el("div", "control-actions");
        for (const control of available.controls) row.append(button(control === "stop" ? words.stop : words.restart, () => ((confirming = { session: id, control }), render())));
        children.push(row, el("p", "control-note", words.note));
      }
    }
    box.replaceChildren(...children);
    box.hidden = children.length === 0;
  }

  function renderStart(): void {
    const toggle = byId<HTMLButtonElement>("new-session");
    const offered = state.start.agents.length > 0;
    toggle.hidden = !offered;
    toggle.textContent = t().controls.newSession;
    toggle.setAttribute("aria-expanded", String(startOpen && offered));
    const panel = byId<HTMLFormElement>("start-panel");
    panel.hidden = !(startOpen && offered);
    const tracked = startRequest === null ? undefined : state.requests.find((request) => request.id === startRequest);
    const key = JSON.stringify([offered, startOpen, state.start, tracked, refused?.session === null ? refused.text : null, t().languageName]);
    if (key === startKey || panel.hidden) return;
    startKey = key;
    const words = t().controls;
    const agent = el("select");
    agent.id = "start-agent";
    for (const id of state.start.agents) agent.append(new Option(deps.agentName(id), id));
    const folder = el("select");
    folder.id = "start-folder";
    for (const path of state.start.folders) folder.append(new Option(path, path));
    folder.append(new Option(words.startOther, ""));
    const path = el("input");
    path.id = "start-path";
    path.placeholder = words.startPath;
    path.spellcheck = false;
    path.hidden = state.start.folders.length > 0;
    folder.addEventListener("change", () => (path.hidden = folder.value !== ""));
    const label = (text: string, field: HTMLElement) => {
      const node = el("label");
      node.append(el("span", undefined, text), field);
      return node;
    };
    const submit = el("button", "open-button", words.startSubmit);
    submit.type = "submit";
    submit.disabled = tracked !== undefined && OPEN.includes(tracked.status);
    const children: HTMLElement[] = [el("p", "tiny-label", words.startTitle), label(words.startAgent, agent), label(words.startFolder, folder), path, submit, el("p", "control-note", words.startNote)];
    if (refused !== null && refused.session === null) children.push(el("p", "control-status is-failed", refused.text));
    else if (tracked !== undefined) children.push(el("p", `control-status${OPEN.includes(tracked.status) ? " is-pending" : tracked.status === "confirmed" ? " is-done" : " is-failed"}`, requestText(tracked)));
    panel.replaceChildren(...children);
  }

  function renderServices(): void {
    const words = t().controls;
    for (const box of document.querySelectorAll<HTMLElement>(".schedule-service")) {
      const agent = box.dataset["agent"]!;
      const service = state.services.find((entry) => entry.agent === agent);
      const latest = state.requests.find((request) => request.service === agent);
      const shown = latest !== undefined && (OPEN.includes(latest.status) || deps.now() - Date.parse(latest.resolved_at ?? latest.requested_at) < OUTCOME_MS) ? latest : undefined;
      const confirm = serviceConfirm?.agent === agent ? serviceConfirm.control : null;
      const refusedText = serviceRefused?.agent === agent ? serviceRefused.text : null;
      const key = JSON.stringify([service, shown, confirm, refusedText, t().languageName]);
      if (box.dataset["key"] === key) continue;
      box.dataset["key"] = key;
      box.hidden = service === undefined;
      if (service === undefined) {
        box.replaceChildren();
        continue;
      }
      const note = service.note === null ? "" : ` · ${words.reasons[service.note] ?? service.note}`;
      const children: HTMLElement[] = [el("p", "control-note", `${words.service.state[service.state] ?? ""}${note}`)];
      if (refusedText !== null) children.push(el("p", "control-status is-failed", refusedText));
      else if (shown !== undefined) {
        const status = el("p", `control-status${OPEN.includes(shown.status) ? " is-pending" : shown.status === "confirmed" ? " is-done" : " is-failed"}`, requestText(shown));
        status.setAttribute("role", "status");
        children.push(status);
      }
      if (shown === undefined || !OPEN.includes(shown.status)) {
        const row = el("div", "control-actions");
        if (confirm !== null) {
          const ask = `${words.service.ask[confirm] ?? ""}${agent === "codex" && confirm !== "start" ? words.service.askAllThreads : ""}`;
          row.append(button(words.service.confirm, () => void askService(agent, confirm, service.instance).catch(failed), "quiet-button is-confirm"), button(words.cancel, () => ((serviceConfirm = null), render())));
          children.push(el("p", "control-ask", ask), row);
        } else if (service.controls.length > 0) {
          for (const control of service.controls) row.append(button(words.service.action[control] ?? control, () => ((serviceConfirm = { agent, control }), render())));
          children.push(row);
        }
      }
      box.replaceChildren(...children);
    }
  }

  function render(): void {
    if (viewerMode) {
      byId("process-controls").hidden = true;
      byId("new-session").hidden = true;
      byId("start-panel").hidden = true;
      return;
    }
    renderCard();
    renderStart();
    renderServices();
  }

  function wire(on: (target: EventTarget, type: string, listener: EventListener) => void): void {
    on(byId("new-session"), "click", () => {
      startOpen = !startOpen;
      if (!startOpen) refused = refused?.session === null ? null : refused;
      render();
    });
    on(byId("start-panel"), "submit", (event) => {
      event.preventDefault();
      start().catch(failed);
    });
  }

  return {
    setState(next: ControlsState) {
      state = next;
      // A refusal is about the request just made; a new report replaces it once the selection moved on.
      if (refused !== null && refused.session !== null && refused.session !== deps.selectedId()) refused = null;
      render();
    },
    render,
    chip,
    wire,
    relabel() {
      cardKey = "";
      startKey = "";
      render();
    },
  };
}
