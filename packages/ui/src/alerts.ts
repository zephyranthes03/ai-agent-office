// The viewer's own alerts (a phone or tablet watching the office): a notification from the stream
// shows as a banner at the top of the page — the same words as the desktop app's — makes the owner's
// sound (notifications.sound: the chime, the cry of the species the office shows, or nothing) and,
// where the device can, a short vibration. A tap on the banner opens what the notification opens.
// Phones play sound only after a tap on the page, so the first tap anywhere unlocks it; the sound
// can be turned off on the device (kept on it). Sounds are fetched and played through Web Audio,
// which also works where a media element would need range requests. Several notifications at once
// make one sound. While the page is not shown, web push (push.ts, sw.ts) is what reaches the owner.
import type { Settings } from "./client.ts";
import { byId } from "./dom.ts";
import { t } from "./i18n/index.ts";
import type { Species } from "./model.ts";
import { noticeFragment, noticeText } from "./notice.ts";
import type { Notice } from "./notice.ts";

const SOUND_KEY = "agent-office.viewer-sound";
const QUIET_AFTER_MS = 2000;
const VIBRATION = [120, 60, 120];

export type AlertsDeps = {
  /** The species the office shows for a session, or null when it is not in the office. */
  speciesOf: (session: string) => Species | null;
  /** Opens what a notification opens (an address fragment, as app.ts follows it). */
  open: (fragment: string) => void;
};

function readSoundOn(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== "off";
  } catch (error) {
    console.warn("agent-office: the sound setting is not readable", error);
    return true;
  }
}

export function createAlerts(deps: AlertsDeps) {
  let choice: NonNullable<Settings["notification_sound"]> = "chime";
  let soundOn = readSoundOn();
  let audio: AudioContext | null = null;
  const buffers = new Map<string, Promise<AudioBuffer>>();
  let lastSound = Number.NEGATIVE_INFINITY;
  let shown: Notice | null = null;

  const banner = byId("alert-banner");
  const soundButton = byId<HTMLButtonElement>("alert-sound");

  // The first tap or key on the page lets it play sound from then on (and again after the phone suspended it).
  const unlock = () => {
    if (!soundOn) return;
    audio ??= new AudioContext();
    if (audio.state === "suspended") audio.resume().catch((error: unknown) => console.warn("agent-office: sound not resumed", error));
  };
  for (const type of ["pointerdown", "keydown"] as const) document.addEventListener(type, unlock, { capture: true });

  function renderSound(): void {
    soundButton.textContent = soundOn ? t().alerts.soundOn : t().alerts.soundOff;
    soundButton.setAttribute("aria-pressed", String(soundOn));
    soundButton.hidden = choice === "off";
  }
  soundButton.addEventListener("click", () => {
    soundOn = !soundOn;
    try {
      localStorage.setItem(SOUND_KEY, soundOn ? "on" : "off");
    } catch (error) {
      console.warn("agent-office: the sound setting is not remembered", error);
    }
    if (soundOn) unlock();
    renderSound();
  });

  function buffer(name: string): Promise<AudioBuffer> {
    let loaded = buffers.get(name);
    if (loaded === undefined) {
      const context = audio!;
      loaded = fetch(`./sounds/${name}.wav`).then(async (reply) => {
        if (!reply.ok) throw new Error(`sound ${name}: HTTP ${reply.status}`);
        return context.decodeAudioData(await reply.arrayBuffer());
      });
      // A failed load is tried again next time.
      loaded.catch(() => buffers.delete(name));
      buffers.set(name, loaded);
    }
    return loaded;
  }

  async function play(species: Species | null): Promise<void> {
    if (choice === "off" || !soundOn || audio === null || audio.state !== "running") return;
    const now = performance.now();
    if (now - lastSound < QUIET_AFTER_MS) return;
    lastSound = now;
    // The chime when cries are not chosen or the session is not in the office (a missed scheduled task).
    const name = choice === "animal" && species !== null ? species : "chime";
    const source = audio.createBufferSource();
    source.buffer = await buffer(name);
    source.connect(audio.destination);
    source.start();
  }

  function renderBanner(): void {
    banner.hidden = shown === null;
    if (shown === null) return;
    const { title, body } = noticeText(shown, deps.speciesOf(shown.session));
    byId("alert-title").textContent = title;
    byId("alert-body").textContent = body;
    byId("alert-close").setAttribute("aria-label", t().alerts.close);
  }
  byId("alert-open").addEventListener("click", () => {
    if (shown === null) return;
    const fragment = noticeFragment(shown);
    shown = null;
    renderBanner();
    deps.open(fragment);
  });
  byId("alert-close").addEventListener("click", () => {
    shown = null;
    renderBanner();
  });

  renderSound();
  return {
    /** A `notification` from the stream. */
    notice(n: Notice): void {
      shown = n;
      renderBanner();
      const species = deps.speciesOf(n.session);
      play(species).catch((error: unknown) => console.warn("agent-office: notification sound failed", error));
      navigator.vibrate?.(VIBRATION);
    },
    /** The owner's settings: which sound notifications make. */
    settings(settings: Settings): void {
      choice = settings.notification_sound ?? "chime";
      renderSound();
    },
    /** Writes the banner and the button again in the language shown. */
    relabel(): void {
      renderSound();
      renderBanner();
    },
  };
}
