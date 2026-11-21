// Tokens for the browser UI. A page cannot read the token file, so it cannot prove it acts for the
// user who owns this daemon by itself. Instead a program that can read that file (`agent-office ui`,
// later the desktop app) asks for a one-time launch code with the owner's token and hands it to
// the page in the URL fragment; the page trades the code for a UI token once. Neither `Sec-Fetch-Site`
// nor the request's origin is taken as proof: anything on this machine can send those.
//
// The UI token reads what the hook token reads (sessions, attention, the stream, usage) and
// nothing else: it can neither post hooks or events nor ask for launch codes.
import { createHash, randomBytes } from "node:crypto";

export const LAUNCH_TTL_MS = 60_000;
/** A UI token lapses after this long without a request; the daemon's restart ends all of them. */
export const UI_IDLE_MS = 12 * 3600_000;
const LAUNCHES_MAX = 8;
const TOKENS_MAX = 16;
export const SECRET_PATTERN = /^[0-9a-f]{64}$/;

const key = (secret: string) => createHash("sha256").update(secret).digest("hex");

export class UiAuth {
  /** Digest of a pending launch code → when it expires. Codes themselves are never kept. */
  private readonly launches = new Map<string, number>();
  /** Digest of a UI token → when it was last used. */
  private readonly tokens = new Map<string, number>();

  private readonly now: () => number;
  private readonly random: () => string;

  constructor(now: () => number, random: () => string = () => randomBytes(32).toString("hex")) {
    this.now = now;
    this.random = random;
  }

  /** A new one-time launch code; the caller has proved it holds the owner's token. */
  launch(): { code: string; expiresInS: number } {
    this.sweep();
    const code = this.random();
    // Map order is insertion order: the oldest pending code makes room.
    if (this.launches.size >= LAUNCHES_MAX) this.launches.delete(this.launches.keys().next().value!);
    this.launches.set(key(code), this.now() + LAUNCH_TTL_MS);
    return { code, expiresInS: LAUNCH_TTL_MS / 1000 };
  }

  /** The UI token for a pending, unexpired code, which is used up; null for any other code. */
  redeem(code: unknown): string | null {
    this.sweep();
    if (typeof code !== "string" || !SECRET_PATTERN.test(code)) return null;
    const digest = key(code);
    if (!this.launches.delete(digest)) return null;
    const token = this.random();
    if (this.tokens.size >= TOKENS_MAX) {
      const [oldest] = [...this.tokens.entries()].sort((a, b) => a[1] - b[1])[0]!;
      this.tokens.delete(oldest);
    }
    this.tokens.set(key(token), this.now());
    return token;
  }

  /** Whether `token` is a live UI token; a successful check counts as use. */
  check(token: string): boolean {
    if (!SECRET_PATTERN.test(token)) return false;
    const digest = key(token);
    const last = this.tokens.get(digest);
    if (last === undefined) return false;
    if (this.now() - last > UI_IDLE_MS) {
      this.tokens.delete(digest);
      return false;
    }
    this.tokens.set(digest, this.now());
    return true;
  }

  private sweep(): void {
    const now = this.now();
    for (const [digest, expires] of this.launches) if (expires <= now) this.launches.delete(digest);
    for (const [digest, last] of this.tokens) if (now - last > UI_IDLE_MS) this.tokens.delete(digest);
  }
}
