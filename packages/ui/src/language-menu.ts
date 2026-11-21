// The language the page speaks: this device's choice (the menu, remembered here), else the owner's
// ui.language as last received (remembered so a reload starts in it), else this device's own
// languages.
import { byId } from "./dom.ts";
import { currentLanguage, isLanguageChoice, LANGUAGES, messagesOf, resolveLanguage, setLanguage, t } from "./i18n/index.ts";
import type { LanguageChoice } from "./i18n/index.ts";
import { translatePage } from "./i18n/page.ts";
import { readChoice, writeChoice } from "./prefs.ts";

const LANGUAGE_KEY = "agent-office.language";
const OWNER_LANGUAGE_KEY = "agent-office.owner-language";

export function createLanguageMenu() {
  let deviceChoice = readChoice<LanguageChoice>(LANGUAGE_KEY, "the language choice is not readable", "auto", (stored) => (isLanguageChoice(stored) ? stored : "auto"));
  let ownerChoice = readChoice<LanguageChoice | undefined>(OWNER_LANGUAGE_KEY, "the owner's language is not readable", undefined, (stored) => (isLanguageChoice(stored) ? stored : undefined));

  /** Speaks the language the choices give, and writes the page's fixed words in it. */
  function use(): void {
    setLanguage(resolveLanguage(deviceChoice, ownerChoice, navigator.languages));
    document.documentElement.lang = currentLanguage();
    translatePage(document);
  }
  /** The menu: the default (the owner's setting, else this device's languages) and each language in its own words. */
  function render(): void {
    const menu = byId<HTMLSelectElement>("language-choice");
    const automatic = resolveLanguage("auto", ownerChoice, navigator.languages);
    const choice = (label: string, value: LanguageChoice, lang: string) => Object.assign(new Option(label, value), { lang });
    menu.replaceChildren(choice(t().app.languageAuto(messagesOf(automatic).languageName), "auto", currentLanguage()), ...LANGUAGES.map((language) => choice(messagesOf(language).languageName, language, language)));
    menu.value = deviceChoice;
  }

  return {
    use,
    render,
    /** The owner's ui.language as the daemon sent it; false when it is the one already known. */
    setOwner(choice: LanguageChoice | undefined): boolean {
      if (choice === ownerChoice) return false;
      ownerChoice = choice;
      writeChoice(OWNER_LANGUAGE_KEY, ownerChoice ?? null, "the owner's language is not remembered");
      return true;
    },
    /** Takes this device's choice from the menu and remembers it. */
    chooseFromMenu(): void {
      const value = byId<HTMLSelectElement>("language-choice").value;
      deviceChoice = isLanguageChoice(value) ? value : "auto";
      writeChoice(LANGUAGE_KEY, deviceChoice === "auto" ? null : deviceChoice, "the language choice is not remembered");
    },
  };
}
