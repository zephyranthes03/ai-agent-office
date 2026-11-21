// The office's wall objects (the art run's flow-board-v1): a small wooden board on the left
// side wall and a cabinet of monthly rewards on the right one, projected onto the room's own walls
// with the scene's camera (a CSS perspective transform; no wall is painted). Small and glanceable on
// the wall; selecting either opens its record in a dialog: the month or quarter with its chart and
// stamps, today's issues, the year's rewards and each month's. Session names are set as text. The
// pieces they are built from are in wall-parts.ts, how they hang on the walls in wall-mount.ts.
import { ART_BASE, loadImage, loadJson } from "./art.ts";
import { boardView, DEFAULT_BOARD, monthsOf, shiftMonth } from "./board.ts";
import { plural, t } from "./i18n/index.ts";
import type { BoardRecord, BoardSettings, BoardView, Care, MonthView, Period } from "./board.ts";
import type { Attention } from "./model.ts";
import { NO_ATTENTION } from "./model.ts";
import type { SceneStats } from "./scene.ts";
import { COZY } from "./space.ts";
import { mount, slots } from "./wall-mount.ts";
import { awardArt, cancelledLine, chart, empty, h, metrics, MONTH_NAMES, monthIndex, note, number, pendingMark, percent, periodMonths, progress, rewardText, smallStamps, stamps } from "./wall-parts.ts";

export type WallDeps = {
  stage: HTMLElement;
  /** The daemon's record of a year (null: the current one). */
  load: (year: number | null) => Promise<BoardRecord>;
  /** A session's name tag as the office shows it, or null for one it does not know. */
  nameOf: (id: string) => string | null;
};
export type Wall = {
  /** Shows the wall objects (the main screen) or keeps them away (the phone viewer). */
  enable: (on: boolean) => void;
  setSettings: (settings: BoardSettings) => void;
  setAttention: (attention: Attention) => void;
  /** Places the objects on the walls for the frame just drawn. */
  place: (stats: SceneStats) => void;
  refresh: () => void;
  /** Writes the objects and any open dialog again in the language shown. */
  relabel: () => void;
  /** Whether one of the record dialogs is open (Esc belongs to it). */
  dialogOpen: () => boolean;
  destroy: () => void;
};

/** The wall objects' frame pictures (assets-cozy-v4/parts.json): each one's sheet, its size and its crop (source pixels). */
type FrameParts = Record<"goal" | "cabinet", { image: string; size: [number, number]; rect: [number, number, number, number] }>;

export function createWall({ stage, load, nameOf }: WallDeps): Wall {
  let settings: BoardSettings = DEFAULT_BOARD;
  let attention: Attention = NO_ATTENTION;
  let enabled = false;
  let known = false;
  const records = new Map<number, BoardRecord>();
  let today: string | null = null;
  let period: Period = "month";
  let month: string | null = null;
  let archiveView: Period = "month";
  /** The month whose record dialog was last opened. */
  let shownMonth: string | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;

  // The fixed words of the objects and dialogs, written again after a change of language.
  const labels: (() => void)[] = [];
  const label = (apply: () => void) => {
    labels.push(apply);
    apply();
  };

  // Wall objects, behind the colleagues' targets.
  const board = h("button", { type: "button", class: "wall-board", id: "wall-board" });
  const shelf = h("div", { class: "reward-shelf" });
  const caption = h("button", { type: "button", class: "display-caption" });
  const rewards = h("section", { class: "reward-display", id: "reward-display" }, caption, shelf);
  label(() => {
    rewards.setAttribute("aria-label", t().wall.plaques);
    caption.textContent = t().wall.seasons;
  });
  const layer = h("div", { class: "office-wall", id: "office-wall", hidden: "" }, board, rewards);
  stage.querySelector(".actor-targets")?.before(layer);
  // The cozy v4 frames (the art run's flow-board-v4: a sage-framed paper board, a cream cabinet), laid
  // in once the private art is there: the board's cut out of its sheet as a picture of its own (the
  // style lays it as a border image, so its corners keep their shape at the board's width), the
  // cabinet's as a background cut to its crop. Without the art the style's own drawn frames stay.
  void (async () => {
    const parts = await loadJson<FrameParts>(`./${COZY}/parts.json`);
    for (const name of ["goal", "cabinet"] as const) {
      const { image, size, rect } = parts[name];
      const picture = await loadImage(`./${COZY}/${image}`);
      const [x, y, w, h] = rect;
      const [iw, ih] = size;
      if (name === "goal") {
        const crop = document.createElement("canvas");
        crop.width = w;
        crop.height = h;
        crop.getContext("2d")?.drawImage(picture, x, y, w, h, 0, 0, w, h);
        const blob = await new Promise<Blob | null>((done) => crop.toBlob(done));
        if (blob === null) throw new Error("the board's frame could not be cut out");
        layer.style.setProperty("--goal-art", `url("${URL.createObjectURL(blob)}")`);
        continue;
      }
      layer.style.setProperty(`--${name}-art`, `url("${new URL(`${COZY}/${image}`, new URL(ART_BASE, document.baseURI)).href}")`);
      layer.style.setProperty(`--${name}-art-size`, `${(iw / w) * 100}% ${(ih / h) * 100}%`);
      layer.style.setProperty(`--${name}-art-position`, `${(x / (iw - w)) * 100}% ${(y / (ih - h)) * 100}%`);
    }
    layer.dataset["art"] = "";
  })().catch((error: unknown) => console.warn("agent-office: the board's frame pictures are not available; plain frames are drawn", error));

  // Dialogs: the board's record, a month's record, the year's rewards.
  const dialogs: HTMLDialogElement[] = [];
  function dialog(id: string, className: string, ...header: Node[]): { root: HTMLDialogElement; body: HTMLElement } {
    const close = h("button", { type: "button", class: "dialog-close" }, "×");
    label(() => close.setAttribute("aria-label", t().wall.close));
    const body = h("div", { class: "dialog-body" });
    const root = h("dialog", { id, class: `record-dialog ${className}`, "aria-labelledby": `${id}-title` }, h("div", { class: "dialog-header" }, h("div", {}, ...header), close), body);
    close.addEventListener("click", () => root.close());
    // A click on the backdrop (outside the dialog's box) closes it.
    root.addEventListener("click", (event) => {
      if (event.target === root) root.close();
    });
    document.body.append(root);
    dialogs.push(root);
    return { root, body };
  }
  const boardKicker = h("p", { class: "record-kicker" });
  const boardTitle = h("h2", { id: "board-dialog-title" });
  const periodLabel = h("span", { "aria-live": "polite" });
  const periodButtons = (["month", "quarter"] as const).map((p) => h("button", { type: "button", "data-period": p }));
  const back = h("button", { type: "button", "data-step": -1 }, "‹");
  const forward = h("button", { type: "button", "data-step": 1 }, "›");
  const periodGroup = h("div", { class: "segmented", role: "group" }, ...periodButtons);
  const periodControls = h("div", { class: "period-controls" }, periodGroup, h("div", { class: "date-nav" }, back, periodLabel, forward));
  label(() => {
    for (const button of periodButtons) button.textContent = button.dataset["period"] === "month" ? t().wall.month : t().wall.quarter;
    back.setAttribute("aria-label", t().wall.previousPeriod);
    forward.setAttribute("aria-label", t().wall.nextPeriod);
    periodGroup.setAttribute("aria-label", t().wall.recordPeriod);
  });
  const boardDialog = dialog("board-dialog", "detail-dialog", boardKicker, boardTitle, periodControls);
  const monthTitle = h("h2", { id: "month-dialog-title" });
  const monthDialog = dialog("month-dialog", "detail-dialog", h("p", { class: "record-kicker" }, "A MOMENT TO REMEMBER"), monthTitle);
  const archiveYear = h("strong");
  const archiveButtons = (["month", "quarter"] as const).map((p) => h("button", { type: "button", "data-archive": p }));
  const archiveTitle = h("h2", { id: "archive-dialog-title" });
  const archiveLead = h("p");
  const archiveGroup = h("div", { class: "segmented", role: "group" }, ...archiveButtons);
  const archiveDialog = dialog("archive-dialog", "archive-dialog", h("p", { class: "record-kicker" }, "THE LITTLE THINGS WE KEEP"), archiveTitle, archiveLead, h("div", { class: "archive-controls" }, archiveYear, archiveGroup));
  label(() => {
    for (const button of archiveButtons) button.textContent = button.dataset["archive"] === "month" ? t().wall.byMonth : t().wall.byQuarter;
    archiveTitle.textContent = t().wall.archiveTitle;
    archiveLead.textContent = t().wall.archiveLead;
    archiveGroup.setAttribute("aria-label", t().wall.archiveGrouping);
  });

  const view = (p: Period, m: string) => boardView(records, today!, settings, attention, p, m);
  const thisYear = () => Number(today!.slice(0, 4));

  function renderBoard(): void {
    const words = t().wall;
    const v = view("month", today!.slice(0, 7));
    let heading = words.presets[settings.preset];
    const periodText = settings.preset === "health" ? `${today!.slice(5, 7)}.${today!.slice(8, 10)} · TODAY` : words.boardPeriod(thisYear(), monthIndex(today!));
    let body: Node[];
    if (settings.preset === "health") {
      body = v.today.observed
        ? [
            h("div", { class: "health-summary" }, h("span", { class: "health-mark" }, "!"), h("div", { class: "health-copy" }, h("strong", {}, String(v.today.currentIssues)), h("span", {}, plural(words.sessionsToCheck, v.today.currentIssues)))),
            h("div", { class: "health-list" }, h("div", {}, h("span", {}, words.issuesToday), h("b", {}, words.sessions(v.today.affectedSessions))), h("div", {}, h("span", {}, words.approvalWaits), h("b", {}, words.sessions(v.today.approvalWaits)))),
          ]
        : [h("div", { class: "board-empty" }, h("strong", {}, "—"), h("p", {}, words.nothingToday))];
    } else if (!v.hasRecords) {
      body = [h("div", { class: "board-empty" }, h("strong", {}, "···"), h("p", {}, v.coverageLabel), h("p", {}, words.drawnLater))];
    } else {
      if (settings.preset === "goal" && v.target === null) heading = words.monthRecord;
      const unit = settings.preset === "rhythm" || v.target === null ? plural(words.times, v.total ?? 0) : `/ ${number(v.target)}`;
      // The office's own board leads with how the turns went; how many ended moves to the line below.
      const care = settings.preset === "combined" && v.care !== null && v.care.soloPercent !== null ? v.care : null;
      body = [
        care !== null
          ? h("div", { class: "board-number" }, h("strong", {}, `${care.soloPercent}%`), h("span", {}, words.soloTurns))
          : h("div", { class: "board-number" }, h("strong", {}, number(v.total)), h("span", {}, unit), settings.preset !== "rhythm" && v.percent !== null && h("em", {}, `${v.percent}%`)),
        // Room for the line of figures below: the default board keeps a goal's progress, not the daily chart.
        settings.preset !== "rhythm" && v.target !== null ? progress(v) : care === null && chart(v, today!, { compact: true }),
      ].filter((node): node is HTMLElement => node !== false);
      if (settings.preset === "goal") body.push(...[smallStamps(v)].filter((node): node is HTMLElement => node !== null));
      if (care !== null)
        body.push(
          h(
            "div",
            { class: "board-summary" },
            h("span", {}, words.stoppedTurns, h("b", {}, percent(care.stoppedPercent))),
            h("span", {}, words.longWaits, h("b", { class: care.longWaits > 0 ? "issue-value" : undefined }, words.count(care.longWaits))),
            h("span", {}, words.endedTurns, h("b", {}, v.target === null ? number(v.total) : `${number(v.total)} / ${number(v.target)}`)),
          ),
        );
      else if (settings.preset === "combined") body.push(h("div", { class: "board-summary" }, h("span", {}, words.completedToday, h("b", {}, number(v.today.completed))), h("span", {}, words.issuesNow, h("b", { class: "issue-value" }, String(v.today.currentIssues)))));
    }
    board.replaceChildren(h("div", { class: "board-heading" }, h("span", {}, heading), h("small", {}, periodText)), ...body);
    const summary = settings.preset === "health" ? words.healthSummary(v.today.currentIssues) : settings.preset === "combined" && v.care?.soloPercent != null ? words.careSummary(v.title, `${v.care.soloPercent}%`, number(v.total)) : words.turnsSummary(v.title, number(v.total));
    board.setAttribute("aria-label", words.boardLabel(heading, summary));
  }

  function renderShelf(): void {
    rewards.dataset["display"] = settings.rewards;
    const all = monthsOf(records, today!, settings, thisYear());
    const current = all[monthIndex(today!)]!;
    const shown = [...all.filter((m) => m.key < current.key && m.earned).slice(-2), current];
    shelf.replaceChildren(
      ...shown.map((m) =>
        h(
          "button",
          { type: "button", class: "shelf-award", "data-month": m.key, "aria-label": t().wall.viewRecord(`${m.label} ${rewardText(m)}`) },
          m.earned ? awardArt(m) : h("span", { class: "award-pending" }, pendingMark(m)),
          h("span", {}, `${m.label}${m.earned ? "" : m.isCurrent ? t().wall.inProgress : t().wall.record}`),
        ),
      ),
    );
  }

  function render(): void {
    if (today === null) return;
    renderBoard();
    renderShelf();
    if (boardDialog.root.open) renderBoardDialog();
    if (archiveDialog.root.open) renderArchive();
  }

  /** Today's sessions with an issue, by name (set as text); a session the office no longer knows by its id. */
  function issueRows(v: BoardView): HTMLElement {
    return h(
      "div",
      { class: "issue-rows" },
      ...v.today.issues.map((issue) =>
        h("div", { class: "issue-row" }, h("span", { class: "issue-symbol" }, issue.current ? "!" : "↩"), h("div", {}, h("b", {}, nameOf(issue.session) ?? issue.session), h("small", {}, t().wall.issues[issue.kind])), h("span", { class: issue.current ? "issue-current" : "issue-cleared" }, issue.current ? t().wall.needsLook : t().wall.resolved)),
      ),
    );
  }

  /** How the period's turns went: each share with the counts it is made of. */
  function careMetrics(care: Care | null): HTMLElement | null {
    if (care === null) return null;
    const words = t().wall;
    const of = (part: number, whole: number) => `${number(part)} / ${number(whole)}`;
    return metrics([
      [words.soloTurns, percent(care.soloPercent), of(care.solo, care.completed)],
      [words.stoppedTurns, percent(care.stoppedPercent), of(care.stopped, care.ended)],
      [words.longWaits, percent(care.longWaitPercent), of(care.longWaits, care.waits)],
    ]);
  }

  function renderBoardDialog(): void {
    const words = t().wall;
    const health = settings.preset === "health";
    periodControls.hidden = health;
    if (health) {
      const v = view("month", today!.slice(0, 7));
      boardKicker.textContent = "TODAY, AT A GLANCE";
      boardTitle.textContent = words.healthTitle;
      boardDialog.body.replaceChildren(
        ...(v.today.observed
          ? [
              h("div", { class: "record-total" }, h("strong", {}, String(v.today.currentIssues)), h("span", {}, plural(words.sessionsUnit, v.today.currentIssues))),
              h("p", { class: "record-total-label" }, words.issuesLabel),
              h("div", { class: "record-issues" }, h("div", {}, h("p", {}, words.issuesToday), h("strong", {}, String(v.today.affectedSessions)), h("small", {}, plural(words.sessionsShort, v.today.affectedSessions))), h("div", {}, h("p", {}, words.approvalWaits), h("strong", {}, String(v.today.approvalWaits)), h("small", {}, plural(words.sessionsShort, v.today.approvalWaits)))),
              issueRows(v),
            ]
          : [empty("—", words.nothingToday, words.notZero)]),
        note(words.healthNote),
      );
      return;
    }
    const m = month!;
    const v = view(period, m);
    boardKicker.textContent = v.isQuarter ? "THREE MONTHS TOGETHER" : `${MONTH_NAMES[monthIndex(m)]} JOURNAL`;
    boardTitle.textContent = `${v.title} · ${settings.preset === "rhythm" ? words.rhythm : words.progressTitle}`;
    periodLabel.textContent = v.title;
    for (const button of periodButtons) button.setAttribute("aria-pressed", String(button.dataset["period"] === period));
    const step = period === "quarter" ? 3 : 1;
    // From January of last year (the record keeps about 400 days) to December of this year.
    const index = (Number(m.slice(0, 4)) - thisYear()) * 12 + monthIndex(m);
    back.disabled = index - step < -12;
    forward.disabled = index + step > 11;
    const cumulative = settings.preset !== "rhythm";
    const caption = cumulative ? words.runningTotal : v.isQuarter ? words.byMonthTurns : words.byDayTurns;
    boardDialog.body.replaceChildren(
      careMetrics(v.care) ?? "",
      metrics([
        [words.observedTurns, number(v.total)],
        [v.isQuarter ? words.quarterGoal : words.monthGoal, number(v.target)],
        [words.progress, v.percent === null ? "—" : `${v.percent}%`],
      ]),
      cancelledLine(v.cancelled) ?? "",
      h(
        "div",
        { class: "detail-chart" },
        ...(v.hasRecords
          ? [h("div", { class: "chart-caption" }, h("span", {}, caption), h("span", {}, cumulative && v.target !== null ? words.goalLine : "")), chart(v, today!, { cumulative }), h("div", { class: "chart-axis" }, h("span", {}, v.isQuarter ? v.months[0]!.label : words.day(1)), h("span", {}, v.isQuarter ? v.months[2]!.label : words.day(v.series.length)))]
          : [empty("—", v.coverageLabel)]),
      ),
      ...stamps(v),
      ...(v.isQuarter ? [periodMonths(v)] : []),
      note(`${v.coverageLabel}. ${v.isQuarter ? words.quarterNote : words.gapsNote}${v.target === null ? words.setGoalNote : ""}`, ...(v.care === null ? [] : [words.careNote]), words.note),
    );
  }

  function showMonth(key: string): void {
    shownMonth = key;
    const year = Number(key.slice(0, 4));
    const m = monthsOf(records, today!, settings, year)[monthIndex(key)]!;
    const v = view("month", key);
    const words = t().wall;
    monthTitle.textContent = words.monthRecordTitle(year, m.label);
    const story = m.earned ? (m.isCurrent ? words.storyEarnedCurrent : words.storyEarned) : m.status === "partial" ? words.storyPartial : m.status === "future" ? words.storyFuture : m.target === null && m.total !== null ? words.storyNoGoal : words.storyOther;
    const rule = m.isCurrent ? words.ruleCurrent : m.finalized ? words.ruleFinal : words.ruleFuture;
    monthDialog.body.replaceChildren(
      h("div", { class: "record-hero" }, m.earned ? awardArt(m) : empty(pendingMark(m)), h("h3", {}, m.earned ? words.awards[monthIndex(key)]! : rewardText(m)), h("p", {}, story)),
      careMetrics(v.care) ?? "",
      metrics([
        [words.observedTurns, number(m.total)],
        [words.thatMonthGoal, number(m.target)],
        [words.reached, m.percent === null ? "—" : `${m.percent}%`],
      ]),
      cancelledLine(m.cancelled) ?? "",
      ...(v.hasRecords ? [h("div", { class: "detail-chart" }, chart(v, today!, { cumulative: true }), h("div", { class: "chart-axis" }, h("span", {}, words.day(1)), h("span", {}, words.day(v.series.length))))] : []),
      note(`${v.coverageLabel}. ${rule}`, ...(v.care === null ? [] : [words.careNote]), words.note),
    );
    if (!monthDialog.root.open) monthDialog.root.showModal();
  }

  function archiveCard(m: MonthView): HTMLElement {
    const amount = m.total === null ? "—" : t().wall.turns(`${number(m.total)}${m.target === null ? "" : ` / ${number(m.target)}`}`);
    return h("button", { type: "button", class: `archive-month ${m.status}`, "data-month": m.key, "aria-label": `${m.label} ${rewardText(m)}` }, h("strong", {}, m.label), m.earned ? awardArt(m) : h("div", { class: "archive-empty" }, pendingMark(m)), h("span", {}, amount), h("small", {}, rewardText(m)));
  }
  function renderArchive(): void {
    const all = monthsOf(records, today!, settings, thisYear());
    archiveYear.textContent = String(thisYear());
    for (const button of archiveButtons) button.setAttribute("aria-pressed", String(button.dataset["archive"] === archiveView));
    const grid = (months: MonthView[]) => h("div", { class: "archive-month-grid" }, ...months.map(archiveCard));
    archiveDialog.body.replaceChildren(
      ...(archiveView === "month" ? [grid(all)] : Array.from({ length: 4 }, (_, q) => h("section", { class: "archive-quarter" }, h("h3", {}, t().wall.quarterHeading(q + 1), h("span", {}, t().wall.quarterMonths(q * 3, q * 3 + 2))), grid(all.slice(q * 3, q * 3 + 3))))),
      h("p", { class: "archive-note" }, `${t().wall.archiveNote}${settings.monthly_target === null ? t().wall.archiveNoGoal : ""}`),
    );
  }

  async function stepPeriod(step: number): Promise<void> {
    const next = shiftMonth(month!, step, period);
    const year = Number(next.slice(0, 4));
    if (!records.has(year)) records.set(year, await load(year));
    month = next;
    renderBoardDialog();
  }

  board.addEventListener("click", () => {
    if (today === null) return;
    period = "month";
    month = today.slice(0, 7);
    renderBoardDialog();
    boardDialog.root.showModal();
  });
  rewards.addEventListener("click", (event) => {
    const award = (event.target as Element).closest<HTMLElement>("[data-month]");
    if (award !== null) showMonth(award.dataset["month"]!);
    else if (today !== null) {
      renderArchive();
      archiveDialog.root.showModal();
    }
  });
  boardDialog.root.addEventListener("click", (event) => {
    const target = (event.target as Element).closest<HTMLElement>("[data-period],[data-step]");
    if (target === null) return;
    if (target.dataset["period"] !== undefined) {
      period = target.dataset["period"] as Period;
      renderBoardDialog();
    } else stepPeriod(Number(target.dataset["step"])).catch((error: unknown) => console.error("agent-office: board record unavailable", error));
  });
  archiveDialog.root.addEventListener("click", (event) => {
    const target = (event.target as Element).closest<HTMLElement>("[data-archive],[data-month]");
    if (target?.dataset["archive"] !== undefined) {
      archiveView = target.dataset["archive"] as Period;
      renderArchive();
    } else if (target?.dataset["month"] !== undefined) showMonth(target.dataset["month"]);
  });

  /** Reloads the current year (earlier years are kept: they no longer change). */
  async function reload(): Promise<void> {
    const record = await load(null);
    if (today !== null && record.today.slice(0, 4) !== today.slice(0, 4)) records.clear();
    today = record.today;
    records.set(record.year, record);
    render();
  }
  function refresh(): void {
    clearTimeout(refreshTimer);
    if (!enabled || !known) return;
    reload().catch((error: unknown) => console.error("agent-office: board record unavailable", error));
    // A quiet office still crosses midnight.
    refreshTimer = setTimeout(refresh, 300_000);
  }

  return {
    enable(on) {
      enabled = on;
      if (!on) layer.hidden = true;
      refresh();
    },
    setSettings(next) {
      settings = next;
      known = true;
      refresh();
    },
    setAttention(next) {
      const before = attention;
      attention = next;
      render();
      // A turn that just ended shows up in the attention list; count it a moment later.
      if (!pending && (next.ready.length !== before.ready.length || next.needs_you.length !== before.needs_you.length)) {
        pending = true;
        setTimeout(() => {
          pending = false;
          refresh();
        }, 2000);
      }
    },
    place(stats) {
      const hidden = !enabled || today === null || stats.art !== "ready" || stats.layout.transitioning;
      layer.hidden = hidden;
      if (hidden) return;
      board.hidden = !settings.show;
      rewards.hidden = settings.rewards === "none";
      const walls = slots(stats.layout, stats);
      if (settings.show) mount(board, walls.board, stats);
      if (settings.rewards !== "none") mount(rewards, walls.rewards, stats);
    },
    refresh,
    relabel() {
      for (const apply of labels) apply();
      render();
      if (monthDialog.root.open && shownMonth !== null) showMonth(shownMonth);
    },
    dialogOpen: () => dialogs.some((d) => d.open),
    destroy() {
      clearTimeout(refreshTimer);
      layer.remove();
      for (const d of dialogs) d.remove();
    },
  };
}
