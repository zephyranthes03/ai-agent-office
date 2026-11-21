// Work that is asked for several times in one go is done once. The events of one chunk of the
// daemon's stream (a connection's first lists; a hook's session and its attention list) each change
// what the page knows, and the page is worked out and drawn once, after the last of them. The work
// runs in a microtask, when the code that asked is done, not on a display frame or a timer: a hidden
// tab gets no frames and slow timers, and its title and list must keep up.

export type Batch = {
  /** Asks for the work: it runs once when the running code is done, however often it is asked for until then. */
  ask: () => void;
  /** Whether the work is asked for and not yet done. */
  owed: () => boolean;
  /** The work was just done directly: what was asked for is no longer owed. */
  clear: () => void;
};

export function createBatch(run: () => void): Batch {
  let owed = false;
  return {
    ask() {
      if (owed) return;
      owed = true;
      queueMicrotask(() => {
        if (!owed) return;
        owed = false;
        run();
      });
    },
    owed: () => owed,
    clear() {
      owed = false;
    },
  };
}
