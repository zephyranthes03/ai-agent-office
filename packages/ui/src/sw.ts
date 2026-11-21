// The viewer's service worker (registered by push.ts as a module worker): it shows the office's web
// push as a notification on the device — the same words as the desktop app's, in the owner's
// language or else the device's (the language a device chose in its menu stays in its page) — and a
// tap focuses the open viewer and shows what the notification opens, or opens the viewer there.
// While the viewer is on screen the notification is silent: the page itself already sounds (alerts.ts).
// It only handles push and clicks; it caches nothing and serves no requests.
import { isLanguageChoice, resolveLanguage, setLanguage } from "./i18n/index.ts";
import { noticeFragment, noticeText } from "./notice.ts";
import type { Notice } from "./notice.ts";

// The worker's own globals, named here because the page's DOM types do not describe them.
type WindowClient = { url: string; visibilityState: string; focus: () => Promise<WindowClient>; postMessage: (message: unknown) => void };
type WaitEvent = { waitUntil: (work: Promise<unknown>) => void };
type Scope = {
  registration: { showNotification: (title: string, options: Record<string, unknown>) => Promise<void> };
  clients: { matchAll: (options: { type: "window"; includeUncontrolled: boolean }) => Promise<WindowClient[]>; openWindow: (url: string) => Promise<unknown> };
  addEventListener(type: "push", listener: (event: WaitEvent & { data: { json: () => unknown } | null }) => void): void;
  addEventListener(type: "notificationclick", listener: (event: WaitEvent & { notification: { close: () => void; data: unknown } }) => void): void;
};
const scope = self as unknown as Scope;

async function show(payload: { notice: Notice; language?: unknown }): Promise<void> {
  setLanguage(resolveLanguage("auto", isLanguageChoice(payload.language) ? payload.language : undefined, navigator.languages));
  const { title, body } = noticeText(payload.notice);
  const windows = await scope.clients.matchAll({ type: "window", includeUncontrolled: true });
  await scope.registration.showNotification(title, {
    body,
    tag: payload.notice.session,
    renotify: true,
    silent: windows.some((client) => client.visibilityState === "visible"),
    icon: "./icons/icon-192.png",
    data: { fragment: noticeFragment(payload.notice) },
  });
}

scope.addEventListener("push", (event) => {
  if (event.data === null) return;
  event.waitUntil(show(event.data.json() as { notice: Notice; language?: unknown }));
});

scope.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const fragment = (event.notification.data as { fragment?: string } | null)?.fragment ?? "tab=needs";
  event.waitUntil(
    (async () => {
      const [open] = await scope.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (open === undefined) return void (await scope.clients.openWindow(`./#${fragment}`));
      await open.focus();
      open.postMessage({ fragment });
    })(),
  );
});
