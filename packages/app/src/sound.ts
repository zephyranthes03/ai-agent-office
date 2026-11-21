// The sound that goes with a notification (notifications.sound): a general chime, the cry of the
// species the office shows for that session, or nothing. The app plays the screen's sound files
// (packages/ui/static/sounds, which the phone's viewer plays too) in a hidden window of its own, so the sound is heard on every system and even when the system refuses
// the notification's banner; the notification itself is then silent. A cry the app does not have
// falls back to the chime, and while the app has no chime file the system's own notification sound
// plays instead. Several notifications at once make one sound.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserWindow } from "electron";

export type SoundChoice = "chime" | "animal" | "off";
/** One of the screen's sound files (`sounds/<name>.wav`), the system's notification sound, or none. */
export type Sound = { file: string } | "system" | null;

const SOUNDS = join(dirname(createRequire(import.meta.url).resolve("@agent-office/ui/package.json")), "static", "sounds");
const PLAYER = fileURLToPath(new URL("../assets/player/player.html", import.meta.url));
/** Notifications within this long of a sound make no sound of their own. */
const QUIET_AFTER_MS = 2000;

/** What plays: the species' cry when the owner chose cries and the app has it, else the chime (`has` says which files the app has). */
export function soundFor(choice: SoundChoice, species: string | null, has: (name: string) => boolean): Sound {
  if (choice === "off") return null;
  if (choice === "animal" && species !== null && has(species)) return { file: species };
  return has("chime") ? { file: "chime" } : "system";
}

export const hasSound = (name: string): boolean => existsSync(join(SOUNDS, `${name}.wav`));

let player: BrowserWindow | null = null;
let lastAt = Number.NEGATIVE_INFINITY;

/** Whether a notification now may make a sound (none was made in the last two seconds); counts this one. */
export function soundDue(now: number): boolean {
  if (now - lastAt < QUIET_AFTER_MS) return false;
  lastAt = now;
  return true;
}

/** Plays one of the sound files in the app's hidden player window (made on first use). */
export async function play(file: string): Promise<void> {
  if (player === null || player.isDestroyed()) {
    player = new BrowserWindow({ show: false, width: 1, height: 1, skipTaskbar: true, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, autoplayPolicy: "no-user-gesture-required", backgroundThrottling: false } });
    player.webContents.on("will-navigate", (event) => event.preventDefault());
    player.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    await player.loadFile(PLAYER);
  }
  await player.webContents.executeJavaScript(`new Audio(${JSON.stringify(pathToFileURL(join(SOUNDS, `${file}.wav`)).href)}).play()`);
}
