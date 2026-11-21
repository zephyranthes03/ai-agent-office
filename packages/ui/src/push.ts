// Web push on the viewer: "이 기기에 알림 받기" lets a paired phone or tablet get the office's
// notifications while its page is closed or its screen is off. It needs a secure page (an HTTPS
// address, such as `tailscale serve` gives; or this computer itself), a browser with push, and on an
// iPhone or iPad the page added to the Home Screen and opened from there. The page registers its
// service worker (sw.ts), asks the device's permission, subscribes with the daemon's key and hands
// the subscription to the daemon (`PUT /v1/push`); turning it off unsubscribes and tells the daemon.
// What is turned on stays with the device (its browser keeps the subscription); a subscription the
// daemon no longer has (a new database, a push service that dropped it) is handed over again.
import { byId } from "./dom.ts";
import { t } from "./i18n/index.ts";

type PushState = "unsupported" | "needs-https" | "needs-install" | "off" | "on" | "denied" | "busy";
/** The one Trusted Types policy the page's CSP allows: the service worker's own address and nothing else. */
type Policy = { createScriptURL: (url: string) => unknown };
const SW_URL = "./sw.js";

const isApple = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

function swScript(): unknown {
  const types = (globalThis as { trustedTypes?: { createPolicy: (name: string, rules: { createScriptURL: (url: string) => string }) => Policy } }).trustedTypes;
  if (types === undefined) return SW_URL;
  const policy = types.createPolicy("agent-office-sw", {
    createScriptURL: (url) => {
      if (url !== SW_URL) throw new TypeError(`not the service worker: ${url}`);
      return url;
    },
  });
  return policy.createScriptURL(SW_URL);
}

/** `token`: the device token the viewer's requests carry. */
export function createPush(token: () => string | null) {
  let state: PushState = "busy";
  let problem: string | null = null;
  let registration: Promise<ServiceWorkerRegistration> | null = null;
  const button = byId<HTMLButtonElement>("push-toggle");
  const note = byId("push-note");

  const request = async (method: "GET" | "PUT" | "DELETE", body?: unknown): Promise<{ key: string; subscribed: boolean } | { subscribed: boolean }> => {
    const auth = token();
    if (auth === null) throw new Error("not paired");
    const reply = await fetch("/v1/push", { method, headers: { authorization: `Bearer ${auth}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: "no-store" });
    if (!reply.ok) throw new Error(`push HTTP ${reply.status}`);
    return (await reply.json()) as { key: string; subscribed: boolean };
  };

  function register(): Promise<ServiceWorkerRegistration> {
    registration ??= navigator.serviceWorker.register(swScript() as string, { type: "module", scope: "./" });
    return registration;
  }

  function render(): void {
    const words = t().alerts;
    button.hidden = state === "unsupported" || state === "needs-https" || state === "needs-install";
    button.disabled = state === "busy" || state === "denied";
    button.setAttribute("aria-pressed", String(state === "on"));
    button.textContent = state === "on" ? words.pushOn : words.pushOff;
    const text = problem !== null ? words.pushFailed(problem) : state === "needs-https" ? words.pushNeedsHttps : state === "needs-install" ? words.pushNeedsInstall : state === "denied" ? words.pushDenied : state === "unsupported" ? words.pushUnsupported : "";
    note.hidden = text === "";
    note.textContent = text;
  }

  /** Where the device stands: a subscription it holds and the daemon has, or why it cannot have one. */
  async function check(): Promise<void> {
    if (!isSecureContext) state = "needs-https";
    else if (isApple() && !standalone() && !("PushManager" in window)) state = "needs-install";
    else if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) state = "unsupported";
    else {
      // The worker is registered whatever the permission, so a tap on a notification it showed finds it.
      const held = await (await register()).pushManager.getSubscription();
      if (Notification.permission === "denied") state = "denied";
      else {
        const known = (await request("GET")) as { key: string; subscribed: boolean };
        if (held !== null && !known.subscribed) await request("PUT", held.toJSON());
        state = held === null ? "off" : "on";
      }
    }
    render();
  }

  async function turnOn(): Promise<void> {
    if ((await Notification.requestPermission()) !== "granted") {
      state = Notification.permission === "denied" ? "denied" : "off";
      return;
    }
    const { key } = (await request("GET")) as { key: string };
    const held = await (await register()).pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(atob(key.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)) });
    await request("PUT", held.toJSON());
    state = "on";
  }

  async function turnOff(): Promise<void> {
    const held = await (await register()).pushManager.getSubscription();
    await request("DELETE");
    await held?.unsubscribe();
    state = "off";
  }

  button.addEventListener("click", () => {
    const was = state;
    state = "busy";
    problem = null;
    render();
    (was === "on" ? turnOff() : turnOn())
      .catch((error: unknown) => {
        console.warn("agent-office: web push", error);
        problem = error instanceof Error ? error.message : String(error);
        state = was;
      })
      .finally(render);
  });

  // A tap on a notification while the page is open: the worker asks the page to show what it opens.
  if ("serviceWorker" in navigator)
    navigator.serviceWorker.addEventListener("message", (event: MessageEvent<{ fragment?: unknown }>) => {
      if (typeof event.data.fragment === "string") location.hash = event.data.fragment;
    });

  return {
    /** Once the device is paired and connected. */
    start(): void {
      check().catch((error: unknown) => {
        console.warn("agent-office: web push unavailable", error);
        problem = error instanceof Error ? error.message : String(error);
        state = "off";
        render();
      });
    },
    relabel: render,
  };
}
