// The markers over the scene's colleagues: the markers of neighbours that would overlap are stacked
// upward, so every one stays readable.

/** A shown marker: its colleague's anchor (the marker's centre line and top) and the marker's size. */
export type BadgeBox = { id: string; anchorX: number; anchorY: number; width: number; height: number };

/** How far each marker moves up (zero or negative pixels), placed left to right so none overlaps one placed before it; at most six heights. */
type Bounds = { id?: string; left: number; right: number; top: number; bottom: number };

export function badgeLifts(boxes: readonly BadgeBox[], occupied: readonly Bounds[] = []): Map<string, number> {
  const placed: Bounds[] = [...occupied];
  const lifts = new Map<string, number>();
  for (const box of [...boxes].sort((a, b) => a.anchorX - b.anchorX)) {
    const { width, height } = box;
    let lift = 0;
    const at = (offset: number) => ({ left: box.anchorX - width / 2, right: box.anchorX + width / 2, top: box.anchorY + offset, bottom: box.anchorY + offset + height });
    const clash = (r: ReturnType<typeof at>) => placed.some((p) => p.id !== box.id && r.left < p.right && r.right > p.left && r.top < p.bottom && r.bottom > p.top);
    while (clash(at(lift)) && lift > -height * 6) {
      const r = at(lift);
      const blockers = placed.filter(p => p.id !== box.id && r.left < p.right && r.right > p.left && r.top < p.bottom && r.bottom > p.top);
      // Clear the nearest occupied edge exactly instead of wasting a full row
      // on every partial overlap with a head or a differently sized marker.
      lift = Math.max(-height * 6, Math.min(lift - 1, Math.floor(Math.min(...blockers.map(p => p.top)) - height - box.anchorY)));
    }
    placed.push(at(lift));
    lifts.set(box.id, lift);
  }
  return lifts;
}

/** Stacks the shown markers of the buttons over the scene's colleagues (`targets`, by session) for the frame just drawn. */
export function liftBadges(actors: readonly { id: string; anchorX: number; top: number; left: number; width: number; height: number }[], targets: ReadonlyMap<string, HTMLElement>): void {
  const badges = new Map<string, HTMLElement>();
  const boxes: BadgeBox[] = [];
  for (const actor of actors) {
    const badge = targets.get(actor.id)?.querySelector<HTMLElement>(".actor-badge");
    if (!badge || badge.hidden) continue;
    badges.set(actor.id, badge);
    // Measure the CSS bubble's unlifted top, not the name-label anchor.
    // This also handles different marker heights and the phone's spacing.
    const previousLift = Number.parseFloat(badge.style.getPropertyValue("--lift")) || 0;
    boxes.push({ id: actor.id, anchorX: actor.anchorX, anchorY: actor.top + badge.offsetTop - previousLift, width: badge.offsetWidth, height: badge.offsetHeight + 3 });
  }
  const occupied = actors.map(actor => ({ id: actor.id, left: actor.left, right: actor.left + actor.width, top: actor.top, bottom: actor.top + actor.height }));
  for (const [id, lift] of badgeLifts(boxes, occupied)) badges.get(id)?.style.setProperty("--lift", `${lift}px`);
}
