// `reduce(snapshots, input, config) → snapshots`: the pure state judgment. Rule ids in the
// trace and in comments are named in rules.ts.
import type { StatesConfig } from "./config.ts";
import { applySignal } from "./signals.ts";
import { createCtx, stampWaits } from "./store.ts";
import { applyAdapterStatus, applyDismissal, applyLiveness, applyStopped, applyTick } from "./ticks.ts";
import type { Input, Snapshots, TraceEntry } from "./types.ts";

export type Reduction = { snapshots: Snapshots; trace: TraceEntry[] };

/** Like `reduce`, and also returns the rules that applied, in order, for replay diagnostics. */
export function reduceTraced(snapshots: Snapshots, input: Input, config: StatesConfig): Reduction {
  const ctx = createCtx(snapshots, config, input.at);
  switch (input.kind) {
    case "signal":
      applySignal(ctx, input);
      break;
    case "tick":
      applyTick(ctx);
      break;
    case "liveness":
      applyLiveness(ctx, input);
      break;
    case "adapter_status":
      applyAdapterStatus(ctx, input);
      break;
    case "dismissal":
      applyDismissal(ctx, input);
      break;
    case "stopped":
      applyStopped(ctx, input);
      break;
  }
  stampWaits(ctx, snapshots);
  // When no snapshot was created or edited, the input map itself comes back, so callers can
  // detect "nothing changed" by identity.
  return { snapshots: ctx.cloned.size === 0 ? snapshots : ctx.out, trace: ctx.trace };
}

/** Next snapshots after one input. The input map and its snapshots are left untouched. */
export function reduce(snapshots: Snapshots, input: Input, config: StatesConfig): Snapshots {
  return reduceTraced(snapshots, input, config).snapshots;
}
