// Web push to paired viewer devices (docs/notifications.md, "Phone"): a device that turned it on
// gets the viewer's notifications while its page is closed or its screen is off. Messages go
// through the device's browser push service (Apple, Google, Mozilla or Microsoft; no other address
// is accepted, so a device token cannot make the daemon post anywhere else), encrypted to the device
// (RFC 8291, aes128gcm) and signed with this daemon's own key (VAPID, RFC 8292), so the push service
// sees when a message goes, not what it says. A subscription the push service calls gone is removed.
import { createCipheriv, createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import type { PushSubscriptionRow, Store } from "./store.ts";

/** The push services browsers use: Safari, Chrome and Android, Firefox, Edge on Windows. */
const PUSH_HOSTS = [/^(?:[a-z0-9-]+\.)*push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^(?:[a-z0-9-]+\.)*push\.services\.mozilla\.com$/, /^(?:[a-z0-9-]+\.)*notify\.windows\.com$/];
const ENDPOINT_MAX = 1024;
/** A wait is news for an hour at most; an undelivered one is dropped after that. */
const TTL_S = 3600;
const SEND_TIMEOUT_MS = 10_000;
/** RFC 8292 asks for a contact; this one names no one (whether every push service takes it is unverified). */
const CONTACT = "mailto:agent-office@example.com";
const META_KEY = "push_vapid_private_jwk";

export const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const unb64url = (text: string): Buffer => Buffer.from(text, "base64url");

export type PushTarget = { endpoint: string; p256dh: string; auth: string };

/** A subscription as a device sends it, checked: a known push service over https, a P-256 public key and a 16-byte secret; else why not. */
export function checkSubscription(value: unknown): PushTarget | { problem: string } {
  const body = value !== null && typeof value === "object" ? (value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }) : {};
  const { endpoint } = body;
  if (typeof endpoint !== "string" || endpoint.length > ENDPOINT_MAX || !URL.canParse(endpoint)) return { problem: "endpoint" };
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "" || !PUSH_HOSTS.some((host) => host.test(url.hostname))) return { problem: "endpoint" };
  const p256dh = body.keys?.p256dh;
  const auth = body.keys?.auth;
  const base64url = /^[A-Za-z0-9_-]+$/;
  if (typeof p256dh !== "string" || !base64url.test(p256dh) || unb64url(p256dh).length !== 65 || unb64url(p256dh)[0] !== 4) return { problem: "keys" };
  if (typeof auth !== "string" || !base64url.test(auth) || unb64url(auth).length !== 16) return { problem: "keys" };
  return { endpoint: url.href, p256dh, auth };
}

/**
 * The message body for one device (RFC 8291): one aes128gcm record with the sender's one-off public
 * key as its key id. `sender` and `salt` are fresh for every message; tests pass the RFC's own.
 */
export function encrypt(payload: Uint8Array, target: { p256dh: string; auth: string }, sender?: { privateKey: Buffer }, salt: Buffer = randomBytes(16)): Buffer {
  const ecdh = createECDH("prime256v1");
  if (sender === undefined) ecdh.generateKeys();
  else ecdh.setPrivateKey(sender.privateKey);
  const senderPublic = ecdh.getPublicKey();
  const receiverPublic = unb64url(target.p256dh);
  const secret = ecdh.computeSecret(receiverPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), receiverPublic, senderPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", secret, unb64url(target.auth), keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // The single (last) record: the payload and the delimiter 0x02, no padding.
  const sealed = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = senderPublic.length;
  return Buffer.concat([header, senderPublic, sealed]);
}

/** This daemon's VAPID key: made once and kept in the database (the home folder is private to its user). */
export function vapidKey(store: Store): { privateKey: KeyObject; publicKey: string } {
  let jwk = store.getMeta(META_KEY);
  if (jwk === null) {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    jwk = JSON.stringify(privateKey.export({ format: "jwk" }));
    store.setMeta(META_KEY, jwk);
  }
  const parsed = JSON.parse(jwk) as { x: string; y: string };
  return { privateKey: createPrivateKey({ key: JSON.parse(jwk) as import("node:crypto").JsonWebKey, format: "jwk" }), publicKey: b64url(Buffer.concat([Buffer.from([4]), unb64url(parsed.x), unb64url(parsed.y)])) };
}

/** The Authorization header for a push service (RFC 8292): a JWT for its origin, valid for twelve hours. */
export function vapidAuthorization(endpoint: string, key: { privateKey: KeyObject; publicKey: string }, nowMs: number): string {
  const part = (value: unknown) => b64url(Buffer.from(JSON.stringify(value)));
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: CONTACT })}`;
  const signature = sign("sha256", Buffer.from(unsigned), { key: key.privateKey, dsaEncoding: "ieee-p1363" });
  return `vapid t=${unsigned}.${b64url(signature)}, k=${key.publicKey}`;
}

export type PushDeps = {
  store: Store;
  now: () => number;
  log: (line: string) => void;
  /** The network (tests pass their own push service). */
  fetch?: typeof fetch;
};

export class PushSender {
  private readonly deps: PushDeps;
  private key: { privateKey: KeyObject; publicKey: string } | null = null;

  constructor(deps: PushDeps) {
    this.deps = deps;
  }

  /** The public key a device subscribes with. */
  publicKey(): string {
    return this.keyPair().publicKey;
  }

  /**
   * Sends `payload` to every subscribed device; `topic` lets a push service replace a message of the
   * same topic still waiting for the device. Failures are logged by status, never thrown.
   */
  async send(payload: unknown, topic: string): Promise<void> {
    const rows = this.deps.store.pushSubscriptions();
    if (rows.length === 0) return;
    const body = Buffer.from(JSON.stringify(payload));
    await Promise.all(rows.map((row) => this.sendOne(row, body, topic)));
  }

  private keyPair() {
    return (this.key ??= vapidKey(this.deps.store));
  }

  private async sendOne(row: PushSubscriptionRow, body: Buffer, topic: string): Promise<void> {
    const post = this.deps.fetch ?? fetch;
    let status: number;
    try {
      const reply = await post(row.endpoint, {
        method: "POST",
        headers: { authorization: vapidAuthorization(row.endpoint, this.keyPair(), this.deps.now()), "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: String(TTL_S), urgency: "high", topic },
        body: encrypt(body, row),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      status = reply.status;
      await reply.body?.cancel();
    } catch (error) {
      this.deps.log(`push_failed ${row.device_id} ${(error as Error).name}`);
      return;
    }
    if (status === 404 || status === 410) {
      // The browser dropped the subscription (unsubscribed, cleared, reinstalled): forget it.
      this.deps.store.removePushSubscription(row.device_id, row.endpoint);
      this.deps.log(`push_gone ${row.device_id} ${status}`);
    } else if (status < 200 || status >= 300) this.deps.log(`push_refused ${row.device_id} ${status}`);
  }
}
