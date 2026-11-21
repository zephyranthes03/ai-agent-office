// The pinned card of the selected session: its facts, the owner's note editor, and the card's one
// action. On the computer that action brings the session's window forward or opens it again (the
// daemon does it; it never answers the agent), and an opened session in a turn waiting for nothing
// can be sent home from the office; on the viewer the card says which computer to go to and what to
// run there. The page's state is read when it is used, as it is then, also after each request.
import { currentToken, viewerMode } from "./client.ts";
import { byId, el } from "./dom.ts";
import { facts, stateLabel, toolLine } from "./format.ts";
import { t } from "./i18n/index.ts";
import { agentLine, canSendHome, SPECIES, speciesName, speciesOf } from "./model.ts";
import type { Cast, Notes, Office, SessionView } from "./model.ts";
import { pill, portrait, star } from "./widgets.ts";
import type { PortraitUrl } from "./widgets.ts";

/** What the page holds about the selection. */
export type CardState = { selectedId: string | null; selectedLast: SessionView | null; office: Office; notes: Notes; cast: Cast };

export type CardDeps = {
  state: () => CardState;
  now: () => number;
  portraitUrl: PortraitUrl;
  closeDetail: () => void;
};

/** An "open session" result as the card shows it, for the session it belongs to; its words are read when shown, in the language shown then. */
export type Opened = { id: string; text: () => string; command: string | null };

/** What the card says about an open: what worked, else why nothing could. */
export function openMessage(means: string | null, reason: string | null, active: boolean): string {
  const words = t().card;
  if (means !== null) return words.opened[means] ?? words.openedOther;
  if (reason === "ssh") return words.openSsh;
  if (reason === "unsupported") return words.openUnsupported;
  return active ? words.windowNotFound : words.reopenFailed;
}

export function createCard(deps: CardDeps) {
  const { state, now } = deps;
  /** The last "open session" result; the id of an open still running. */
  let opened: Opened | null = null;
  let opening: string | null = null;
  /** The note editor follows the selected session; it is filled when the selection changes, not on every update, so typing is kept. */
  let editing: string | null = null;
  /** The session and state the send-home note was written for (a failed attempt's message stays until either changes). */
  let sendHomeShown = "";
  // The viewer (phone, tablet): which computer this is, and the resume command per session.
  let machine: string | null = null;
  const continueCommands = new Map<string, string | null>();

  function fact(label: string, value: string, note?: string): HTMLDivElement {
    const node = el("div", "fact");
    node.append(el("span", undefined, label), el("strong", undefined, value));
    if (note) node.append(el("small", undefined, note));
    return node;
  }

  function renderDetail(): void {
    const { selectedId, selectedLast, office } = state();
    if (selectedId === null || selectedLast === null) return;
    const view = office.all.find((item) => item.id === selectedId) ?? selectedLast;
    const gone = !office.present.some((item) => item.id === selectedId);
    byId("detail-panel").style.setProperty("--identity-color", view.identity.color);
    const hero = el("div", "detail-hero");
    const title = el("div", "detail-title");
    const heading = el("h2");
    heading.append(...star(view), view.name);
    heading.id = "detail-title";
    title.append(el("p", "detail-kicker", `${agentLine(view)} · ${t().card.identity(view.identity.code)}`), heading, el("p", "detail-subtitle", stateLabel(view.event.state)));
    hero.append(portrait(view, deps.portraitUrl, true), title);
    const status = el("div", "detail-status");
    status.append(pill(view, now()));
    const list = el("div", "facts");
    for (const item of facts(view, now())) list.append(fact(item.label, item.value, item.note));
    const children: HTMLElement[] = [hero, status];
    // The owner's memo shows on the card only, never on the name tag.
    if (view.note?.description) children.push(el("p", "detail-memo", view.note.description));
    // The tool line keeps its place (and height) whether or not a tool is running, so the card never jumps.
    const tool = toolLine(view);
    const toolNode = el("p", "detail-target");
    toolNode.append(el("span", "detail-target-label", tool.label), el("strong", undefined, tool.value));
    children.push(toolNode, list);
    if (gone) children.push(el("p", "departure-note", view.standIn ? t().card.taskGone : t().card.sessionGone));
    children.push(el("p", "detail-note", view.standIn ? t().schedules.manageNote : t().card.sessionNote));
    byId("detail-content").replaceChildren(...children);
    renderOpen();
  }

  function renderEditor(): void {
    const { selectedId, selectedLast, office, notes } = state();
    const form = byId("note-editor");
    // A scheduled task's stand-in has no session to keep a note on.
    const isTask = selectedId !== null && (office.all.find((item) => item.id === selectedId) ?? selectedLast)?.standIn === true;
    form.hidden = viewerMode || selectedId === null || isTask;
    if (selectedId === editing || selectedId === null || isTask) return;
    editing = selectedId;
    const note = Object.hasOwn(notes, selectedId) ? notes[selectedId]! : null;
    // The field holds the name as it is shown: the owner's name, else the automatic one (the project).
    byId<HTMLInputElement>("note-nickname").value = note?.nickname ?? automaticName(selectedId);
    byId<HTMLInputElement>("note-description").value = note?.description ?? "";
    byId<HTMLInputElement>("note-watched").checked = note?.watched === true;
    byId<HTMLInputElement>("note-alert").checked = note?.alert_on_rest === true;
    speciesChoices(selectedId);
    const select = byId<HTMLSelectElement>("note-species");
    select.value = note?.species != null && (SPECIES as readonly string[]).includes(note.species) ? note.species : "";
    byId("note-status").textContent = "";
  }

  /** The species menu in the language shown, keeping what is chosen; "automatic" names the species the setting gives this session, so choosing it again changes nothing. */
  function speciesChoices(id: string): void {
    const { office, cast } = state();
    const event = office.all.find((item) => item.id === id)?.event;
    const automatic = speciesOf(id, event?.agent ?? "", cast, null, event?.project ?? null);
    const select = byId<HTMLSelectElement>("note-species");
    const chosen = select.value;
    select.replaceChildren(new Option(t().card.automaticSpecies(speciesName(automatic)), ""), ...SPECIES.map((name) => new Option(speciesName(name), name)));
    select.value = chosen;
  }

  /** After a change of language: what the card wrote once (the species menu, the send-home note) is written again. */
  function relabel(): void {
    if (editing !== null) speciesChoices(editing);
    sendHomeShown = "";
    renderDetail();
  }

  /** The name a session has without the owner's: its title, else its project, else its agent. */
  function automaticName(id: string): string {
    const { office, selectedLast } = state();
    const view = office.all.find((item) => item.id === id) ?? selectedLast;
    return view?.event.title ?? view?.event.project ?? view?.agentName ?? "";
  }

  async function saveNote(): Promise<void> {
    const id = state().selectedId;
    if (id === null) return;
    const typed = byId<HTMLInputElement>("note-nickname").value.trim();
    const body = {
      // The automatic name (or nothing) means no name of the owner's: it follows the project again.
      nickname: typed === automaticName(id) ? null : typed,
      description: byId<HTMLInputElement>("note-description").value,
      watched: byId<HTMLInputElement>("note-watched").checked,
      alert_on_rest: byId<HTMLInputElement>("note-alert").checked,
      species: byId<HTMLSelectElement>("note-species").value || null,
    };
    const status = byId("note-status");
    status.textContent = t().card.saving;
    const reply = await fetch(`/v1/sessions/${encodeURIComponent(id)}/note`, { method: "PUT", headers: { authorization: `Bearer ${currentToken() ?? ""}`, "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
    status.textContent = reply.ok ? t().card.saved : reply.status === 404 ? t().card.noLongerKnown : t().card.saveFailed(reply.status);
  }

  function renderOpen(): void {
    renderEditor();
    if (viewerMode) return renderContinue();
    const { selectedId, selectedLast, office } = state();
    const shown = opened !== null && opened.id === selectedId ? opened : null;
    const button = byId<HTMLButtonElement>("open-session");
    button.setAttribute("aria-busy", String(opening !== null && opening === selectedId));
    button.disabled = opening !== null && opening === selectedId;
    // A scheduled task's stand-in has nothing to open yet.
    button.hidden = (office.all.find((item) => item.id === selectedId) ?? selectedLast)?.standIn === true;
    const result = byId("open-result");
    result.hidden = shown === null;
    result.textContent = shown?.text() ?? "";
    const command = byId("open-command");
    command.hidden = shown?.command == null;
    byId("open-command-text").textContent = shown?.command ?? "";
    const view = office.present.find((item) => item.id === selectedId);
    byId("send-home").hidden = view === undefined || !canSendHome(view);
    if (view !== undefined && sendHomeShown !== view.id + view.event.state) {
      sendHomeShown = view.id + view.event.state;
      byId("send-home-note").textContent = view.event.state === "waiting_user" ? t().card.sendHomeWaitingNote : t().card.sendHomeNote;
    }
  }

  /** Sends the selected session home (the daemon lets it go until it signals again) and closes its card. */
  async function sendHome(): Promise<void> {
    const id = state().selectedId;
    if (id === null) return;
    const note = byId("send-home-note");
    const reply = await fetch(`/v1/sessions/${encodeURIComponent(id)}/dismiss`, { method: "POST", headers: { authorization: `Bearer ${currentToken() ?? ""}` }, cache: "no-store" });
    if (reply.ok) {
      sendHomeShown = "";
      if (state().selectedId === id) deps.closeDetail();
      return;
    }
    note.textContent = reply.status === 409 ? t().card.busyCannotSendHome : reply.status === 404 ? t().card.noLongerKnown : t().card.sendHomeFailed(reply.status);
  }

  /** The viewer's card: which computer to go to, and the command that continues the session there. */
  function renderContinue(): void {
    const { selectedId: id, office } = state();
    byId("continue-here").hidden = id === null;
    if (id === null) return;
    const active = office.present.some((view) => view.id === id);
    byId("continue-text").textContent = t().card.continueThere(machine ?? t().card.computer, active);
    const command = continueCommands.get(id);
    byId("continue-command").textContent = command ?? "";
    byId("continue-command").hidden = command == null;
    if (!continueCommands.has(id)) loadContinue(id).catch((error: unknown) => {
      continueCommands.delete(id);
      console.warn("agent-office: resume command unreachable", error);
    });
  }

  async function loadContinue(id: string): Promise<void> {
    continueCommands.set(id, null);
    const reply = await fetch(`/v1/sessions/${encodeURIComponent(id)}/resume`, { headers: { authorization: `Bearer ${currentToken() ?? ""}` }, cache: "no-store" });
    if (!reply.ok) {
      // Tried again the next time the card opens.
      continueCommands.delete(id);
      console.warn(`agent-office: resume command HTTP ${reply.status}`);
      return;
    }
    continueCommands.set(id, ((await reply.json()) as { command: string | null }).command);
    if (state().selectedId === id) renderContinue();
  }

  /** The viewer asks once which computer it shows, to name it on the card. */
  async function loadMachine(): Promise<void> {
    const reply = await fetch("/v1/health", { headers: { authorization: `Bearer ${currentToken() ?? ""}` }, cache: "no-store" });
    if (!reply.ok) return console.warn(`agent-office: health HTTP ${reply.status}`);
    machine = ((await reply.json()) as { machine?: string }).machine ?? null;
    renderOpen();
  }

  async function openSelected(): Promise<void> {
    const { selectedId: id, office } = state();
    if (id === null || opening !== null) return;
    const active = office.present.some((view) => view.id === id);
    opening = id;
    byId("copy-command").textContent = t().page.copy;
    renderOpen();
    try {
      const reply = await fetch(`/v1/sessions/${encodeURIComponent(id)}/open`, { method: "POST", headers: { authorization: `Bearer ${currentToken() ?? ""}` }, cache: "no-store" });
      if (reply.ok) {
        const result = (await reply.json()) as { means: string | null; reason: string | null; command: string | null };
        opened = { id, text: () => openMessage(result.means, result.reason, active), command: result.command };
      } else {
        const status = reply.status;
        const text = () => (status === 409 ? t().card.alreadyOpening : status === 401 ? t().card.accessEnded : t().card.openFailed(status));
        opened = { id, text, command: null };
      }
    } catch (error) {
      console.warn("agent-office: open session failed", error);
      opened = { id, text: () => t().app.daemonUnreachable, command: null };
    } finally {
      opening = null;
      renderOpen();
    }
  }

  /** Copies the command shown under an open's result (to run by hand) to the clipboard. */
  function copyCommand(): void {
    const button = byId<HTMLButtonElement>("copy-command");
    navigator.clipboard.writeText(byId("open-command-text").textContent ?? "").then(
      () => (button.textContent = t().app.copied),
      (error: unknown) => {
        console.warn("agent-office: copy failed", error);
        button.textContent = t().app.copyFailed;
      },
    );
  }

  /** Wires the card's buttons and its note editor; `on` adds a listener the page removes again when it is taken down. */
  function wire(on: (target: EventTarget, type: string, listener: EventListener) => void): void {
    on(byId("close-detail"), "click", () => deps.closeDetail());
    on(byId("open-session"), "click", () => void openSelected());
    on(byId("dismiss-session"), "click", () => {
      sendHome().catch((error: unknown) => {
        console.warn("agent-office: send home failed", error);
        byId("send-home-note").textContent = t().app.daemonUnreachable;
      });
    });
    on(byId("note-editor"), "submit", (event) => {
      event.preventDefault();
      saveNote().catch((error: unknown) => {
        console.error("agent-office: saving the note failed", error);
        byId("note-status").textContent = t().app.daemonUnreachable;
      });
    });
    on(byId("copy-command"), "click", () => copyCommand());
  }

  return {
    renderDetail,
    renderOpen,
    relabel,
    wire,
    loadMachine,
    /** Which computer the viewer shows, once asked. */
    machine: () => machine,
    /** An open the desktop app already did before it showed the card (`#…&opened=`). */
    setOpened: (result: Opened) => {
      opened = result;
    },
  };
}
