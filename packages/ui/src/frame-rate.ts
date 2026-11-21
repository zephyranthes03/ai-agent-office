// How often the office is drawn: at most FRAME_RATE times a second, whatever the display's refresh
// rate. The page is offered a frame on every refresh; one that comes too soon after the last drawn
// frame is skipped. The scene moves on by the time since the last drawn frame, so a colleague walks
// as fast at 30 frames a second as at 120, in fewer and longer steps.

/** Frames drawn per second, at most. */
export const FRAME_RATE = 30;
/** A frame due within this many ms is drawn now rather than one refresh late (refresh times jitter a little). */
const SLACK_MS = 2;

export type FrameClock = {
  /**
   * For the frame offered at `time` (ms, as requestAnimationFrame gives it): the seconds the scene
   * moves on by, at most `maxStepS`, or null when the frame is skipped. The first frame moves nothing on.
   */
  tick: (time: number) => number | null;
  /** Forgets the last drawn frame (the page was hidden): the next frame is drawn and moves nothing on. */
  reset: () => void;
};

export function createFrameClock(rate = FRAME_RATE, maxStepS = 0.1): FrameClock {
  const interval = 1000 / rate;
  let last: number | null = null;
  return {
    tick(time) {
      if (last === null) {
        last = time;
        return 0;
      }
      const elapsed = time - last;
      if (elapsed < interval - SLACK_MS) return null;
      last = time;
      return Math.min(elapsed / 1000, maxStepS);
    },
    reset() {
      last = null;
    },
  };
}
