// The stored requests of the lifecycle and service controls: creating a row, saving each step, and
// which target has a request under way. One target has one request at a time, and an unexpected error
// fails a request instead of leaving it open.
import { randomUUID } from "node:crypto";
import type { ControlName } from "./lifecycle.ts";
import type { ControlRequestRow, Store } from "./store.ts";

export const KEY = /^[A-Za-z0-9_-]{8,64}$/;
export const INSTANCE = /^[0-9a-f]{16}$/;
export const OPEN = ["requested", "sent"];

export type LedgerDeps = {
  store: Store;
  now: () => number;
  log: (line: string) => void;
  publish: () => void;
  /** A request has reached its outcome. */
  released: (row: ControlRequestRow) => void;
};

export class RequestLedger {
  private readonly deps: LedgerDeps;
  readonly busy = new Map<string, string>();
  closed = false;

  constructor(deps: LedgerDeps) {
    this.deps = deps;
  }

  iso(): string {
    return new Date(this.deps.now()).toISOString();
  }

  newRow(target: string, agent: string, control: ControlName, key: string): ControlRequestRow {
    return { id: randomUUID(), target, agent, control, idempotency_key: key, requested_at: this.iso(), status: "requested", step: null, instance_json: null, launch_json: null, evidence_json: "{}", deadline_at: null, resolved_at: null, failure_reason: null };
  }

  save(row: ControlRequestRow, change: Partial<ControlRequestRow>, evidence: Record<string, unknown> = {}): void {
    Object.assign(row, change);
    if (Object.keys(evidence).length > 0) row.evidence_json = JSON.stringify({ ...(JSON.parse(row.evidence_json) as object), ...evidence });
    if (!OPEN.includes(row.status)) {
      row.resolved_at = this.iso();
      for (const [target, id] of this.busy) if (id === row.id) this.busy.delete(target);
      this.deps.released(row);
      this.deps.log(`control ${row.control} ${row.status}${row.failure_reason === null ? "" : ` ${row.failure_reason}`}`);
    }
    this.deps.store.updateControl(row);
    this.deps.publish();
  }

  fail(row: ControlRequestRow, reason: string, status: "failed" | "timeout" = "failed"): void {
    this.save(row, { status, failure_reason: reason });
  }

  /** Runs a request's steps; an unexpected error fails it instead of leaving it open. */
  async run(row: ControlRequestRow, steps: () => Promise<void>): Promise<void> {
    try {
      await steps();
    } catch (error) {
      this.deps.log(`control_failed ${(error as Error).name} ${(error as NodeJS.ErrnoException).code ?? ""}`.trim());
      if (OPEN.includes(row.status) && !this.closed) this.fail(row, "internal");
    }
  }
}
