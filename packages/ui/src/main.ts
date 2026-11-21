// Entry point of the browser UI (a module script, so the document is parsed when it runs).
import { mount } from "./app.ts";

const dispose = mount();
addEventListener("pagehide", (event) => {
  if (!event.persisted) dispose();
});
