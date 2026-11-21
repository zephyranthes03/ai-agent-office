---
summary: The one office space and the list of every session beside it, where numbers live (the lobby board's summary row, service cards, timetable board), the hover card, and the rules for head labels above characters.
read_when: You render the list beside the scene, a board, the hover card or a head label, add a displayed item, or change label settings and overlap handling.
---

# Boards and head labels

Numbers and long information go on static boards. The label above a character shows only the short items chosen in settings. Characters move and overlap, so head labels have a length limit and overlap rules.

The waiting cat only waits where it is, with its marker; its project and state are read from the list beside the scene and from the lobby board.

## One space and the list beside it

However many sessions there are, the office is one space on one screen: it is never split into rooms, tabs or a scrolling floor because of their number. Characters may overlap a little and share furniture. A session that needs you or runs long always has its own character, placed with the least overlap in this order: approval or input wait, failed, silent, long, then the rest. Whether every other session also gets its own character, or fewer characters stand for them, is still open; until it is decided, every session is one character.

In the desktop and landscape layouts a list of every session stays beside the office, with six tabs (when the list and its card make the page taller than the window, the page scrolls but the office stays pinned in view, drawn to fit the screen; owner, 2026-11-01):

- **Needs you**, in the order of the attention list ([notifications.md](notifications.md));
- **Working**: sessions in a turn (working, or waiting only on a child or dependency);
- **Resting**: sessions whose turn is over and that wait for the next instruction (`idle` or `done`). A session whose last turn ended cleanly (the ready entry) and one that was opened, cleared or interrupted without finishing a turn are the same to the owner, so they are listed and counted together; the first keeps its check and the time its turn ended (owner, 2026-10-28);
- **Waiting room** ("대기실", owner, 2026-11-01: the tab row lacked it, so 전체 did not add up to the tabs beside it): who sits on a bench — sessions only opened, sessions gone quiet, scheduled tasks' stand-ins and a scheduled task's thread between its runs — in the fixed order of session start; the same number as the summary row's 대기실;
- **All**, in the fixed order of session start: who is in the office — working, resting, waiting for you, sessions only opened and sessions gone quiet (both sitting on a bench in the waiting room, until a first prompt or a signal takes them in), and scheduled tasks whose run is near (on a bench too, "예약 09:00", until the run starts, unless the task's own thread is a session the daemon knows: then that session carries the task, with the "예약" chip, and there is no second figure; after a run it rests at its desk for `schedule.rest_after_min` (5 minutes) and then waits on a bench in the waiting room ("예약 대기 · 다음 HH:MM", the "◷ HH:MM" marker) until it goes home or its run starts, coming back to the bench an hour before the next run; owner, 2026-11-01; a helper — a subagent — is listed right under the session it works for, indented, with "↳" and that session's name); sessions gone home are on the Home tab instead, and the apps' own threads ("앱 내부 작업") are listed only while "앱 내부 작업 보기" above the list is ticked (off by default, remembered on this device; owner, 2026-10-30);
- **Home** ("퇴근", owner, 2026-10-29): sessions that left the office — away after a long rest, sent home with "목록에서 숨기기", ended by their agent, or lost mid-turn — latest first, each with how its last turn ended (정상 완료, Esc로 중단, 취소됨, 실패; 작업 중 종료 for a lost one). The daemon remembers an ended session for a day. Three condition rows above the list narrow it: the agent (전체, Claude Code, Codex), when the session left (1시간, 2시간, 오늘 by this device's day, 전체) and 확인 필요만 (lost mid-turn or failed: the two kinds that never leave the office on their own; an Esc was the owner's own doing); the choice is kept on this device only, and the number on the tab is the rows under these conditions (owner, 2026-10-31: the tab had counted every session that left while the list showed only today's), as the All tab's number follows its checkbox; the search box narrows the rows only. Its card keeps "세션 열기", which reopens an ended session with the agent's own resume command; a session that does anything again comes back into the office by itself.

Working, Resting, Waiting room and All keep the order of session start. The summary row's counts open the matching tab. Clicking the tab already shown closes the whole side panel (the office alone fills the view, as "크게 보기" does without the full screen), and so does the "목록 닫기 »" button at the panel's head; a handle on the right edge ("목록", with the needs-you number) opens it again, as do a summary count, a `#tab=` link and Esc; the choice is kept on this device (owner, 2026-11-01: "탭 닫힘이라는게 오른쪽에 존재하는 탭 전체가 열리고 닫히고 하는거였어"). The window's size never changes with the panel: the office fills whatever width is left (owner, 2026-11-01, after trying a window that widened for the panel). A session with work handed to another session (the Claude app's cloud sessions) wears a "위임 N" chip on every tab, home included; its row at rest reads "쉬는 중 · 클라우드 N건 돌아오길 기다림", its marker while resting is "⋯ 위임" (after needs-you, quiet and long, before the finished turn's tick), and its card ends with "위임한 일" (where, who asked, since when, how many came back); after a day without a result the chip fades and the card says "돌아오지 않음". The tab and the counts follow the session's own state: a delegation is a layer, not a state (owner, 2026-11-01).

Below the office is the waiting room (owner, 2026-10-31): a separate room joined to the office by a door, with benches in rows and a front door out. A session only opened sits on a bench there ("열리기만 함 · 출근 대기") until its first prompt takes it to a desk, and so does a session gone quiet ("신호 없음", faded, from 15 minutes of silence until it goes home at 30; owner, 2026-11-01) until its next signal, and a scheduled task from `schedule.bench_before_min` (default 60 minutes) before its run ("예약 09:00", the task's name, faded; a missed occurrence carries the needs-you mark, an unwatched one says "실행 확인 못 함"; owner, 2026-11-01) until the run starts, and a scheduled task's own thread between its runs ("예약 대기 · 다음 09:00", not faded, from `schedule.rest_after_min` after its turn until it goes home or its run starts; owner, 2026-11-01); a session leaving the office (away after a long rest, sent home, ended) sits on a bench a moment and walks out of the front door, after which it is on the Home tab only. The room grows a row at a time as benches are needed. "대기실 끄기" on the office switches it off (remembered on this device): the office alone fills the view, sessions only opened are not drawn, and a session leaving fades out.

The list has search. Opening it never covers the scene, and reading a problem never requires finding a character first. It takes over the session list of the room whiteboard. Reading an entry does not resolve it.

## Boards

| Board | Where | Shows |
| --- | --- | --- |
| Lobby board | Top of the screen, always visible | The summary row: the number of sessions that need you (approval or input wait, failed turn, lost, a scheduled run that never came; the same number as the tray icon and the queue badge), the only accented number, with quiet counts of working, resting, waiting-room (only opened, gone quiet, or a scheduled task before its run; owner, 2026-11-01: 전체 = 작업 중 + 쉬는 중 + 대기실 + those in the office waiting for you) and running long sessions beside it; subscription quota bars per service (usage, time to reset), today's cost, a ticker of notifications |
| Room whiteboard | Wall of the office | The session list now lives beside the scene; what a wall board shows is decided with the UI |
| Service cards (after v1) | Small equipment inside the office, not a separate room | Local LLM servers and loaded models, memory and GPU, agent process liveness; the same card as a character, opened the same way |
| Timetable board | Rooms with scheduled work, such as the classroom | Next run, last result, and missed runs of scheduled tasks |

In v1 the lobby board shows the Codex quota only. The Claude quota bar drawn in the mockup is excluded because no collection method is verified; see [usage-and-cost.md](usage-and-cost.md). The server-room board comes after v1.

## Board principles

- **Fixed row order**: the rows of the list's All tab are ordered by session start time and do not move when state changes. Only the rows of sessions that need you get an accent color.
- **Markers readable from a distance**: the icon and text of a needs-you marker (the amber "!", failed, lost) keep a minimum on-screen size independent of the room zoom, so they read on a tablet across the desk; the value is set with the UI. A lost session has no floor marker, because its character has already left; its accented row in the list and the queue carry it. The ready marker (a small check above a top-level character after a finished turn, until the next prompt) is quiet. So is the long marker, a neutral blue clock above a top-level character whose current turn has run longer than `states.long_turn_min` minutes (default 20; 0 turns it off). Neither is notified or counted with needs-you; the summary row shows them only as quiet counts.
- **Linked both ways**: selecting a character highlights its row in the list; selecting a row outlines the character. Double-clicking a row opens the session ([click-panel-and-controls.md](click-panel-and-controls.md)).
- **Work seats**: a working session holds a work seat in its project's area for the whole turn; waiting, failed and quiet characters stay where they are. Characters stay in place most of the time, which reduces overlap. The seat count and what happens when seats run out are still open; the list always holds everyone.
- **Board positions come from the room pack**: the Tiled object layer marks `board` areas. Text on a board is drawn by the engine with a crisp font, not as pixel sprites, so it stays readable when zoomed. See [packs.md](packs.md).
- **Every number carries its measurement time**: stale values are dimmed rather than removed (the same philosophy as the `unknown` state).
- **Mini mode**: the menu-bar mini window shows only the lobby board, so quota and the needs-you count are visible without opening the game screen.

## Looking at one session

Pointing at a character or a row opens a small read-only card after a short delay: name tag, state, elapsed time, last signal. Keyboard focus shows the same card. A click or Enter pins it as the detail panel beside the scene; on a phone a tap opens it as a bottom sheet. A character being looked at stops moving, new events never change which session an open card shows, and pointing never runs a command. The panel is described in [click-panel-and-controls.md](click-panel-and-controls.md).

## The marker of a colleague that needs you

The marker over a colleague that needs you carries its name: "! api · 승인 대기", the same name as its row in the list (on a phone, the short marker, the project and the agent: "! api · Claude Code"). The longer it waits, the stronger it gets — colour and size only, never motion: from `scene.needs_you_marker.stronger_after_min` (5 minutes) it is filled and says how long ("· 6분"), from `strongest_after_min` (15 minutes) it is at its deepest; `null` turns a stage off. While anyone needs you, the office's edge holds a still, warm light, so the count reaches the corner of the eye even with the list closed. `labels.show` chooses whose name tags show without pointing: `needs-you` (default), `everyone`, or `on-hover`.

The colleague itself holds a paw up beside its cheek while it waits (lowered while it walks) and stands in a still, warm light: an amber glow behind its head and a pale rim around it. Neither moves; `scene.needs_you_glow: false` turns the light off.

## Head labels

Choose a display level, then switch individual items on or off.

| Level | Shown above the head |
| --- | --- |
| Minimal | Name tag (nickname or project) |
| Default | Name tag + state icon and short text (for example "waiting for approval") |
| Detailed | Default + user description + current tool or waiting target + elapsed time |

- **Items**: nickname, user description, project, state text, current tool or waiting target, elapsed time, tokens.
- **Setting scope**: global default → per agent kind → per room → per individual, each level overriding the previous.
- **User description**: one line per session or scheduled task (for example "sort tax receipts"). Edited in the click panel or the control tab, bound to the session ID or scheduled-task name so it survives the next run. See [storage.md](storage.md).
- **Overlap**: overlapping labels stack vertically. If there is still not enough room, lower-priority labels collapse to the name tag only. `waiting_user` and `error` labels are always expanded. Hovering expands a collapsed label; labels are dimmed while the character is moving.
- **Length**: one line, maximum length from settings (default 24 characters). Longer text is truncated with an ellipsis; the full text is on the board or in the panel.
- **Screen-share mode**: when on, hides user description, tool target, and project name, leaving only nickname and state. Labels never contain conversation content in any mode.

## Screen sizes

The same UI serves three layouts; the remote ones arrive with server mode, after v1.

| Layout | Where | Arrangement |
| --- | --- | --- |
| Desktop and landscape tablet | the app, a browser tab, a tablet standing beside the monitor ("the office window") | the lobby board's summary row on top, the office with the list beside it |
| Portrait phone | a phone browser through the read-only viewer ([events.md](events.md)) | the summary row and the attention list on top, a small office below; details open as a bottom sheet that shows how to reach the session (the provider's session link when the adapter can obtain one, otherwise the machine and session with the resume command and tmux window to copy) rather than acting on it |
| Mini (after v1) | the menu-bar mini window | the lobby board only |

Needs-you markers keep their minimum size in every layout. Keeping a tablet screen awake and web push on iOS are unverified.

## Accessibility

State is never conveyed by color alone. Each state has an icon, a posture, and a short text that appear together on labels and boards.

## Language

The screens speak Korean or English: the desktop window, the browser UI, the phone viewer, and the desktop app's tray menu, notifications and dialogs. Each device can choose its own in the menu at the end of the top bar (remembered in that browser); otherwise every screen follows `ui.language` in `config.json` (`auto`, `ko` or `en`; applied when the daemon starts), and `auto` follows the device's own languages: Korean when it prefers Korean, English otherwise. The tray menu and notifications follow `ui.language` only. Times use the 24-hour clock in both languages.

## Settings

Label level, per-item switches, scope overrides, maximum label length, and screen-share mode live in the Settings sub-tab ([control-tab.md](control-tab.md)). The authoritative file format is [../schemas/config.schema.json](../schemas/config.schema.json).
