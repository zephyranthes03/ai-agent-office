// The page: the summary row, the office scene with its markers, the list beside it (needs you,
// working, resting, all, search) and the hover, pinned and phone cards. It shows what the daemon judged
// and offers no controls over the agents: approvals and answers happen in the original tool; the
// card can only send a session home from the office, which the agent never sees. Session text is
// always set as text, never as markup.
import type { StandardEvent } from "@agent-office/core";
import { authenticate, currentToken, detectMode, follow, launchRefused, viewerMode } from "./client.ts";
import type { Connection, Settings, Warnings } from "./client.ts";
import type { Notice } from "./notice.ts";
import { setClockZone } from "./format.ts";
import { t } from "./i18n/index.ts";
import type { Attention, ControlsState, Notes, Schedule, SessionView } from "./model.ts";
import { createOfficeStore } from "./office-store.ts";
import { createOfficeScene } from "./scene.ts";
import { createFrameClock } from "./frame-rate.ts";
import { createBatch } from "./batch.ts";
import { DEFAULT_BOARD } from "./board.ts";
import type { BoardRecord } from "./board.ts";
import { createWall } from "./wall.ts";
import { readChoice, writeChoice } from "./prefs.ts";
import type { Scenery } from "./windows.ts";
import { weatherOf } from "./weather.ts";
import { sceneActors } from "./actors.ts";
import { byId, setData, setStyle, setText } from "./dom.ts";
import { createListControls } from "./list-controls.ts";
import { createListPanel } from "./list-panel.ts";
import type { ListState } from "./list-panel.ts";
import { createCard, openMessage } from "./card.ts";
import { createProcessControls } from "./process-controls.ts";
import { createPreview } from "./preview.ts";
import { liftBadges } from "./badges.ts";
import { readFragment } from "./fragment.ts";
import { createLanguageMenu } from "./language-menu.ts";
import { createOfficeOnly } from "./office-only.ts";
import { submitPairing } from "./pairing.ts";
import { keepFocusInSheet, syncSheet } from "./sheet.ts";
import { createTopBar } from "./top-bar.ts";
import { createAlerts } from "./alerts.ts";
import { renderSchedulePanel } from "./schedule-panel.ts";
import { createUsagePanel } from "./usage-panel.ts";
import { createPush } from "./push.ts";

export function mount(): () => void {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const mobile = matchMedia("(max-width: 780px)");
  let controller = new AbortController();
  // Whether the waiting room is shown below the office, remembered on this device (on unless turned off).
  const WAITING_ROOM_KEY = "agent-office.waiting-room";
  // What the daemon's stream said and what follows from it: the office, the seats, who is on the way home.
  const store = createOfficeStore({ showWaiting: readChoice(WAITING_ROOM_KEY, "the waiting room setting is not readable", true, (stored) => stored !== "off") });
  /** The attention list the wall was last given: it gets a new one once the office is worked out for it, so the names it shows are known. */
  let wallAttention = store.attention();
  const SCENERY_KEY = "agent-office.window-view";
  let selectedId: string | null = null;
  let selectedLast: SessionView | null = null;
  let hoverId: string | null = null;
  let userPaused = false;
  let returnFocus: HTMLElement | null = null;
  let sceneTime = 0;
  /** Which display frames the office is drawn on (frame-rate.ts). */
  const frameClock = createFrameClock();
  let frameHandle = 0;
  /** A session named by `#session=` before the daemon listed it. */
  let wanted: string | null = null;
  let modeKnown = false;
  // The top bar's notes (the stream, the hooks, the art) and the language the page speaks.
  const topBar = createTopBar();
  // On the viewer, the stream's notifications show as a banner with the owner's sound; web push reaches the device while the page is not shown.
  const alerts = createAlerts({ speciesOf: (id) => store.office().all.find((view) => view.id === id)?.species ?? null, open: (fragment) => (location.hash = fragment) });
  const push = createPush(currentToken);
  let pushStarted = false;
  const language = createLanguageMenu();
  language.use();
  const scene = createOfficeScene(byId<HTMLCanvasElement>("office"));
  scene.setScenery(readChoice<Scenery>(SCENERY_KEY, "the view outside is not readable", "forest", (stored) => (stored === "ocean" ? "ocean" : "forest")));
  // The list beside the office and the buttons over the scene's colleagues.
  const panel = createListPanel({ portraitUrl: scene.portrait, select, setHover, clearHover });
  const targets = panel.targets;
  // The board and the rewards on the walls (main screen only: the viewer hands details to the agent's own app).
  const wall = createWall({
    stage: byId("stage"),
    async load(year) {
      const reply = await fetch(year === null ? "/v1/board" : `/v1/board?year=${year}`, { headers: { authorization: `Bearer ${currentToken() ?? ""}` }, cache: "no-store" });
      if (!reply.ok) throw new Error(`board record ${reply.status}`);
      const record = (await reply.json()) as BoardRecord;
      // A daemon from before the board counted how turns went (still running after an update) sends days without those counts: unknown.
      return { ...record, days: record.days.map((day) => ({ ...day, solo: day.solo ?? null, failed: day.failed ?? null, waits: day.waits ?? null, long_waits: day.long_waits ?? null })) };
    },
    nameOf: (id) => store.office().all.find((view) => view.id === id)?.name ?? null,
  });
  const paused = () => userPaused || reduce.matches || document.hidden;
  const now = () => Date.now();
  // The hover preview over the office, and the pinned card of the selected session with its note editor and its one action.
  const preview = createPreview({ state: () => ({ office: store.office(), selectedId }), enabled: () => !mobile.matches, now, actors: () => scene.stats()?.actors, targets });
  const card = createCard({ state: () => ({ selectedId, selectedLast, office: store.office(), notes: store.notes(), cast: store.choices().cast }), now, portraitUrl: scene.portrait, closeDetail });
  // Start, stop and restart of an agent's process: the card's buttons and the list's "New session" (computer only).
  const processControls = createProcessControls({ selectedId: () => selectedId, agentName: (agent) => store.office().all.find((view) => view.event.agent === agent)?.agentName ?? agent, now });
  // The full-window office, and the card's panel (a sheet on a phone).
  const officeOnly = createOfficeOnly(drawScene);
  const usagePanel = createUsagePanel({ now, officeOnly });
  const syncCardPanel = () => syncSheet(selectedId !== null, mobile.matches);

  // --- data -----------------------------------------------------------------------------------
  // The stream's events only change what the page knows; the page is worked out and drawn once for
  // all the events that arrive together (batch.ts).
  const refresh = createBatch(update);
  function update(): void {
    refresh.clear();
    store.derive(now());
    if (selectedId !== null) selectedLast = store.office().all.find((view) => view.id === selectedId) ?? selectedLast;
    if (wallAttention !== store.attention()) {
      wallAttention = store.attention();
      wall.setAttention(wallAttention);
    }
    if (wanted !== null && store.has(wanted)) {
      const id = wanted;
      wanted = null;
      return select(id, null);
    }
    render();
  }
  const handlers = {
    sessions(list: StandardEvent[]) {
      topBar.alive(now());
      store.setSessions(list);
      refresh.ask();
    },
    session(event: StandardEvent) {
      topBar.alive(now());
      store.setSession(event);
      refresh.ask();
    },
    attention(list: Attention) {
      const prevReady = store.attention().ready.length;
      topBar.alive(now());
      store.setAttention(list);
      if (list.ready.length > prevReady) void usagePanel.load();
      refresh.ask();
    },
    settings(settings: Settings) {
      alerts.settings(settings);
      store.setSettings(settings);
      wall.setSettings(settings.board ?? DEFAULT_BOARD);
      if (settings.schedule !== undefined) setClockZone(settings.schedule.time_zone);
      if (!language.setOwner(settings.language)) return refresh.ask();
      relabel();
    },
    schedule(list: Schedule) {
      topBar.alive(now());
      store.setSchedule(list);
      renderSchedulePanel(list, now());
      processControls.render();
      refresh.ask();
    },
    notes(list: Notes) {
      topBar.alive(now());
      store.setNotes(list);
      refresh.ask();
    },
    // Hooks that do not reach the daemon would leave the office looking idle for hours (2026-10-31,
    // a Node upgrade): the daemon says so and the top bar shows it until it is over.
    warnings(next: Warnings) {
      topBar.alive(now());
      topBar.setWarnings(next);
    },
    controls(next: ControlsState) {
      topBar.alive(now());
      processControls.setState(next);
      // With the page's update owed, the list is written then.
      if (!refresh.owed()) renderList();
    },
    notification(notice: Notice) {
      if (!viewerMode) return;
      // The banner and the sound name the session's species: the office is worked out first.
      if (refresh.owed()) update();
      alerts.notice(notice);
    },
    alive() {
      topBar.alive(now());
      topBar.renderLastUpdate();
    },
    status(status: Connection) {
      topBar.setConnection(status);
      byId("pair-panel").hidden = status !== "needs-pair";
      byId("app").classList.toggle("is-pairing", status === "needs-pair");
      if (status === "live" && viewerMode && card.machine() === null) card.loadMachine().catch((error: unknown) => console.warn("agent-office: health unreachable", error));
      if (status === "live" && !viewerMode) void usagePanel.load();
      byId("viewer-alerts").hidden = !(viewerMode && status === "live");
      if (status === "live" && viewerMode && !pushStarted) {
        pushStarted = true;
        push.start();
      }
      topBar.renderLastUpdate();
      const note = byId("launch-note");
      note.hidden = status !== "needs-launch";
      // A refused link may mean someone else opened it first: say so instead of a plain "no access".
      if (status === "needs-launch" && launchRefused) note.dataset["refused"] = "true";
    },
  };

  // --- rendering --------------------------------------------------------------------------------
  const listState = (): ListState => ({ office: store.office(), ...listControls.choice(), selectedId, departing: store.departing(), seats: store.seating().seats, labelsShow: store.choices().labelsShow, needsMarker: store.choices().needsMarker, now, controlChip: (id) => processControls.chip(id) });
  const renderSummary = () => panel.renderSummary(listState());
  const renderList = () => panel.renderList(listState());
  const renderTargets = () => panel.renderTargets(listState());

  /** After a change of language choice: everything on screen is written again in the language shown now. */
  function relabel(): void {
    language.use();
    language.render();
    topBar.relabel();
    renderSchedulePanel(store.schedule(), now());
    usagePanel.render();
    alerts.relabel();
    push.relabel();
    motionLabel();
    waitingLabel();
    sceneryLabel();
    officeOnly.label();
    syncCardPanel();
    wall.relabel();
    card.relabel();
    processControls.relabel();
    refresh.ask();
  }

  function render(): void {
    topBar.renderLastUpdate();
    byId("app").classList.toggle("has-detail", selectedId !== null);
    renderSummary();
    renderTargets();
    renderList();
    card.renderDetail();
    processControls.render();
    const shown = preview.shownId();
    if (shown !== null) preview.show(shown);
    byId("office-panel").dataset["level"] = String(store.seating().level);
    byId("app").classList.toggle("is-crowded", store.office().inOffice.length > 6);
    drawScene();
  }

  // --- scene ------------------------------------------------------------------------------------
  // The office's header lies over the top of the stage; the office is fitted below it.
  const officeChrome = document.querySelector(".office-chrome");
  if (officeChrome === null) throw new Error("The office's header is missing");
  const stage = byId("stage");
  const covered = () => Math.max(0, officeChrome.getBoundingClientRect().bottom - stage.getBoundingClientRect().top);
  function drawScene(): void {
    const seating = store.seating();
    const choices = store.choices();
    const stats = scene.draw(sceneTime, sceneActors(store.office().inOffice, store.departing().values(), seating.seats, now()), seating.level, { selectedId, hoverId, paused: paused(), reducedMotion: reduce.matches, instant: store.instant(), stateTime: now() / 1000, wanderAfterS: choices.wanderAfterS, waitingRows: seating.waitingRows, showWaiting: store.showWaiting(), needsYouGlow: choices.needsYouGlow, covered: covered(), weather: weatherOf(store.office()) });
    if (stats === null) return;
    store.drawn();
    // Out of the front door: the session is on the home tab only now.
    if (store.left(stats.gone)) {
      update();
      return;
    }
    wall.place(stats);
    setData(byId("office-panel"), "weather", stats.weather);
    // Only what changed is written: a frame in which nothing moved leaves the page as it was, and the
    // browser has nothing to lay out again.
    const shown = new Set(stats.actors.map((box) => box.id));
    for (const [id, button] of targets) if (button.hidden === shown.has(id)) button.hidden = !shown.has(id);
    for (const box of stats.actors) {
      const button = targets.get(box.id);
      if (button === undefined) continue;
      setStyle(button, "left", `${box.left}px`);
      setStyle(button, "top", `${box.top}px`);
      setStyle(button, "width", `${box.width}px`);
      setStyle(button, "height", `${box.height}px`);
      setData(button, "walking", String(box.walking));
      setData(button, "routine", box.routine);
    }
    liftBadges(stats.actors, targets);
    const layout = stats.layout;
    setText(byId("room-size-label"), t().app.desks(4 + 4 * layout.level));
    setText(byId("room-status"), layout.pendingShrink ? t().app.roomPendingShrink : layout.transitioning ? t().app.roomTransitioning : t().app.roomSettled);
    if (preview.shownId() !== null) preview.place();
  }
  function frame(time: number): void {
    const delta = frameClock.tick(time);
    if (delta !== null && !paused()) {
      sceneTime += delta;
      drawScene();
    }
    frameHandle = requestAnimationFrame(frame);
  }

  // --- hover, preview and the pinned card --------------------------------------------------------
  function setHover(id: string): void {
    hoverId = id;
    preview.enter(id);
    drawScene();
  }
  function clearHover(id: string): void {
    if (hoverId === id) hoverId = null;
    preview.leave();
    drawScene();
  }
  function select(id: string, source: HTMLElement | null): void {
    const view = store.office().all.find((item) => item.id === id);
    if (view === undefined) return;
    returnFocus = source;
    selectedId = id;
    selectedLast = view;
    preview.hide();
    syncCardPanel();
    render();
    if (mobile.matches) byId("close-detail").focus({ preventScroll: true });
  }
  function closeDetail(): void {
    selectedId = null;
    selectedLast = null;
    hoverId = null;
    preview.hide();
    syncCardPanel();
    render();
    const back = returnFocus?.isConnected ? returnFocus : (targets.values().next().value ?? null);
    back?.focus({ preventScroll: true });
    returnFocus = null;
  }

  function motionLabel(): void {
    const button = byId<HTMLButtonElement>("motion-toggle");
    button.disabled = reduce.matches;
    button.setAttribute("aria-pressed", String(userPaused || reduce.matches));
    button.textContent = reduce.matches ? t().app.motionReduced : userPaused ? t().app.motionShow : t().app.motionPause;
  }

  // --- wiring -----------------------------------------------------------------------------------
  const listeners: [EventTarget, string, EventListener][] = [];
  const on = (target: EventTarget, type: string, listener: EventListener) => {
    target.addEventListener(type, listener);
    listeners.push([target, type, listener]);
  };
  // The tabs, the search box and the list's conditions.
  const listControls = createListControls({
    on,
    officeOnly,
    changed(what) {
      if (what === "page") return render();
      if (what === "counts") renderSummary();
      renderList();
    },
  });
  card.wire(on);
  processControls.wire(on);
  usagePanel.wire(on);
  on(byId("expand-office"), "click", () => officeOnly.set(!officeOnly.isOn(), true));
  // The waiting room below the office, where sessions only opened wait and sessions going home leave
  // from. Turned off, the office alone fills the view, nobody waits on screen and leaving is a fade.
  function waitingLabel(): void {
    const button = byId<HTMLButtonElement>("waiting-toggle");
    button.setAttribute("aria-pressed", String(store.showWaiting()));
    button.textContent = store.showWaiting() ? t().app.waitingOff : t().app.waitingOn;
    byId("office-panel").dataset["waiting"] = String(store.showWaiting());
  }
  on(byId("waiting-toggle"), "click", () => {
    store.setShowWaiting(!store.showWaiting());
    writeChoice(WAITING_ROOM_KEY, store.showWaiting() ? "on" : "off", "the waiting room setting is not remembered");
    waitingLabel();
    update();
  });
  waitingLabel();
  // What the windows look out on: a forest or the sea, remembered on this device like the waiting room.
  function sceneryLabel(): void {
    const button = byId<HTMLButtonElement>("scenery-toggle");
    const shown = scene.scenery();
    button.textContent = t().app.viewTo[shown === "forest" ? "ocean" : "forest"];
    button.setAttribute("aria-label", t().app.viewNow[shown]);
    button.title = t().app.viewNow[shown];
    byId("office-panel").dataset["scenery"] = shown;
  }
  on(byId("scenery-toggle"), "click", () => {
    const next = scene.scenery() === "forest" ? "ocean" : "forest";
    scene.setScenery(next);
    writeChoice(SCENERY_KEY, next, "the view outside is not remembered");
    sceneryLabel();
    update();
  });
  sceneryLabel();
  // Leaving full screen (Esc in the browser) also brings the list back.
  on(document, "fullscreenchange", () => {
    if (document.fullscreenElement === null && officeOnly.isOn()) officeOnly.set(false, false);
  });
  officeOnly.restore();
  on(byId("language-choice"), "change", () => {
    language.chooseFromMenu();
    relabel();
  });
  language.render();
  topBar.relabel();
  on(byId("pair-form"), "submit", (event) => {
    event.preventDefault();
    submitPairing(connect);
  });
  on(byId("sheet-backdrop"), "click", () => closeDetail());
  on(byId("preview-card"), "pointerenter", () => preview.hold());
  on(byId("preview-card"), "pointerleave", () => preview.hide());
  on(byId("preview-card"), "click", () => {
    const shown = preview.shownId();
    if (shown !== null) select(shown, targets.get(shown) ?? null);
  });
  on(byId("list-close"), "click", () => officeOnly.set(true, false));
  on(byId("list-handle"), "click", () => officeOnly.set(false, false));
  on(byId("motion-toggle"), "click", () => {
    userPaused = !userPaused;
    motionLabel();
    drawScene();
  });
  on(reduce, "change", () => {
    motionLabel();
    drawScene();
  });
  on(mobile, "change", () => {
    preview.hide();
    syncCardPanel();
  });
  on(document, "visibilitychange", () => {
    frameClock.reset();
    drawScene();
  });
  on(document, "keydown", (event) => {
    const key = event as KeyboardEvent;
    // Esc in an open record dialog closes only that dialog.
    if (key.key === "Escape" && wall.dialogOpen()) return;
    if (key.key === "Escape") {
      preview.hide();
      // Esc closes an open card first; with none open it leaves the full-window office.
      if (selectedId !== null) closeDetail();
      else if (officeOnly.isOn()) officeOnly.set(false, false);
    }
    if (key.key === "Tab" && selectedId !== null && mobile.matches) keepFocusInSheet(key);
  });
  const resizer = new ResizeObserver(() => {
    scene.resize();
    drawScene();
  });
  resizer.observe(byId("office"));
  // Times on rows and cards move on even while nothing changes.
  const clock = setInterval(() => {
    topBar.renderLastUpdate();
    renderList();
    renderTargets();
    card.renderDetail();
  }, 15_000);

  scene.ready.then(
    () => {
      topBar.setArt(null);
      render();
    },
    (error: unknown) => {
      topBar.setArt(error instanceof Error ? error.message : String(error));
      console.error("agent-office: art failed to load", error);
      render();
    },
  );

  function connect(): void {
    controller.abort();
    const current = new AbortController();
    controller = current;
    void (async () => {
      if (!modeKnown) {
        await detectMode();
        modeKnown = true;
        document.body.dataset["mode"] = viewerMode ? "viewer" : "main";
        wall.enable(!viewerMode);
        card.renderOpen();
      }
      const token = await authenticate();
      if (current.signal.aborted) return;
      if (token === null) return handlers.status(viewerMode ? "needs-pair" : "needs-launch");
      await follow(token, handlers, current.signal);
    })().catch((error: unknown) => {
      console.error("agent-office: connection failed", error);
      handlers.status("failed");
    });
  }
  /** Follows a `#session=` or `#tab=` fragment (fragment.ts), then clears it, so the same link works again. */
  function followFragment(): void {
    const fragment = readFragment(location.hash);
    if (fragment === null) return;
    history.replaceState(null, "", location.pathname + location.search);
    if (fragment.notificationsBlocked !== null) topBar.setNotificationsBlocked(fragment.notificationsBlocked);
    if (fragment.tab !== null) {
      if (selectedId !== null) closeDetail();
      listControls.showTab(fragment.tab);
    }
    const { session, opened } = fragment;
    if (session === null) return;
    // The desktop app opens the session before it shows the card, and says how it went.
    if (opened !== null) {
      const active = store.office().present.some((view) => view.id === session);
      card.setOpened({ id: session, text: () => openMessage(opened.means, opened.reason, active), command: null });
    }
    if (store.has(session)) select(session, null);
    else wanted = session;
  }
  // A new launch link pasted into an open tab changes only the fragment, which reloads nothing.
  on(window, "hashchange", () => {
    if (location.hash.startsWith("#launch=")) connect();
    else followFragment();
  });

  motionLabel();
  syncCardPanel();
  render();
  frameHandle = requestAnimationFrame(frame);
  // What depends on the clock alone (a scheduled task's bench window, its thread's rest at the desk) is derived again every half minute.
  const derived = setInterval(update, 30_000);
  followFragment();
  connect();

  return () => {
    controller.abort();
    cancelAnimationFrame(frameHandle);
    clearInterval(clock);
    clearInterval(derived);
    preview.destroy();
    resizer.disconnect();
    wall.destroy();
    for (const [target, type, listener] of listeners) target.removeEventListener(type, listener);
  };
}
