---
summary: The one office space and its planned zones: which kind of work goes to which zone, how a session is assigned to one, and how scheduled work is shown.
read_when: You implement zone (room) assignment, add a room pack, or change classification rules.
---

# Spaces

The office is one space on one screen. However many sessions there are, it is never split into rooms, tabs or a scrolling floor because of their number; characters may overlap a little and share furniture. Kinds of work become zones inside that one space after v1, and a character goes to the zone that matches its work; their form is decided when they are built.

In v1 there is exactly one space, the office, and every session in a turn or at rest is placed there. Beside it, below, is the waiting room: an anteroom for sessions only opened (no prompt yet) and sessions on their way home, joined to the office by doors; it is not a zone for kinds of work, and it can be switched off. Classification rules and the zones come after v1. Room packs and the rules below still call a zone a room.

## Kinds of work

| Space | Kind of work | Background and animations |
| --- | --- | --- |
| Office | Company work, development | Typing at desks, meeting-room whiteboard |
| Tax team | Tax, accounting, receipts | Calculator, stamping a pile of documents |
| Classroom | School, classes, academy schedules | Blackboard, timetable board, bell and roll call |
| Warehouse / shop | Online sales, inventory, shipping | Carrying boxes, sticking labels |
| Lab | Side projects, experiments | Flasks, several monitors |
| Lounge | Unclassified work, resting | Coffee, sofa |

## State meaning is shared; actions and props differ

The meaning of every state is the same in every zone; only the motion and props change.

- The same `working` is typing in the office, calculator and stamp in the tax team, writing in the classroom.
- `waiting_user` is a waiting pose where the character is: a raised hand in the office, holding an approval form in the tax team.
- In every zone the same state also shows the same engine-wide icon and short text, so state is never conveyed by color alone.

## Room assignment priority

The first matching rule wins.

1. `space` set directly on the event (by a scheduled-task prompt or by the adapter).
2. User rules (folder or task name).
3. Working folder and project name.
4. Keywords in the scheduled-task name or thread title.
5. Optional: a local LLM classifies the title. Only when the user turns it on, and only with a local model (see [privacy-security.md](privacy-security.md)).
6. Nothing matches: lounge.

Rule configuration example (the authoritative schema is [../schemas/config.schema.json](../schemas/config.schema.json)):

```yaml
spaces:
  default: lounge
  rules:
    office:    { cwd: ["~/dev/**"] }
    tax:       { keywords: ["세무", "세금", "tax", "1099", "invoice"] }
    school:    { task_name: ["*수업*", "*학원*", "*school*"] }
    warehouse: { keywords: ["amazon", "재고", "inventory", "shipping"] }
```

(The original planning record wrote the same rules with `default` at the top level; the config schema nests both under `spaces`.)

Keyword matching uses only titles, task names, and folder names, never conversation content.

## Scheduled work in a zone

When a scheduled run starts, the character arrives at its zone; the zone's timetable board shows the next planned run; when the run finishes, the result is written on the board and the character leaves. A missed run is marked with a red mark on the empty desk. The boards are described in [ui-boards-and-labels.md](ui-boards-and-labels.md).

## Related

- Room packs (Tiled maps with desk, door, and board markers): [packs.md](packs.md)
