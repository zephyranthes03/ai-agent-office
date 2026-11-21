// Pairing a phone or tablet with the read-only viewer: the code from `agent-office pair` (or the
// app's tray) and a name for the device, which is named in the language shown when left empty.
import { pairDevice } from "./client.ts";
import { byId } from "./dom.ts";
import { t } from "./i18n/index.ts";

/** Sends the pairing form; `paired` runs once the daemon accepted the code. */
export function submitPairing(paired: () => void): void {
  const error = byId("pair-error");
  const submit = byId<HTMLButtonElement>("pair-submit");
  submit.disabled = true;
  const name = byId<HTMLInputElement>("pair-name").value;
  pairDevice(byId<HTMLInputElement>("pair-code").value, name.trim() === "" ? t().app.defaultDeviceName : name)
    .then((accepted) => {
      error.hidden = accepted;
      error.textContent = accepted ? "" : t().app.pairRefused;
      if (accepted) paired();
    })
    .catch((failure: unknown) => {
      console.error("agent-office: pairing failed", failure);
      error.hidden = false;
      error.textContent = t().app.pairFailed;
    })
    .finally(() => (submit.disabled = false));
}
