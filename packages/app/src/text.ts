// What a desktop notification says: the screen's own notice text (packages/ui/src/notice.ts), so the
// app, the viewer's banner and its web push say the same.
import type { Notification } from "@agent-office/daemon";
export { noticeFragment as fragmentFor, noticeText as notificationText } from "@agent-office/ui/notice";

/** The stream's `notification` event (packages/daemon/src/notifier.ts). */
export type { Notification };
