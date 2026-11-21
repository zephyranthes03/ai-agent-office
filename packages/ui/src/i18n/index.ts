// Which language the screens speak and their words in it. A device's own choice (the language menu,
// kept on that device) comes first, then the owner's `ui.language` from config.json, then the
// device's own languages; a device whose languages include none of these gets English. Words are
// read when they are used (`t()`), so a change of language shows on the next render.
import { en } from "./en.ts";
import { ko } from "./ko.ts";
import type { Messages, Plural } from "./ko.ts";

export type { Messages, Plural, Weekday } from "./ko.ts";
export type Language = "ko" | "en";
/** How a language is chosen; `auto` follows the device's languages. */
export type LanguageChoice = Language | "auto";
/** The languages in the order the language menu lists them. */
export const LANGUAGES: readonly Language[] = ["ko", "en"];
const MESSAGES: Record<Language, Messages> = { ko, en };

let current: Language = "ko";

/** The words in the language shown. */
export const t = (): Messages => MESSAGES[current];
/** The words in a given language (the language menu names each language in its own words). */
export const messagesOf = (language: Language): Messages => MESSAGES[language];
export const currentLanguage = (): Language => current;
export function setLanguage(language: Language): void {
  current = language;
}

export const isLanguageChoice = (value: unknown): value is LanguageChoice => value === "auto" || LANGUAGES.includes(value as Language);

/** The first of a device's languages (BCP 47 tags, most wanted first) the screens speak; English otherwise. */
export function deviceLanguage(preferred: readonly string[]): Language {
  for (const tag of preferred) {
    const base = tag.toLowerCase().split("-")[0] as Language;
    if (LANGUAGES.includes(base)) return base;
  }
  return "en";
}

/** The language shown: the device's choice, else the owner's setting (none from an older daemon), else the device's languages. */
export function resolveLanguage(device: LanguageChoice, owner: LanguageChoice | undefined, preferred: readonly string[]): Language {
  if (device !== "auto") return device;
  if (owner !== undefined && owner !== "auto") return owner;
  return deviceLanguage(preferred);
}

/** The word after `count` in its plural form for the language shown. */
export function plural(forms: Plural, count: number): string {
  return new Intl.PluralRules(t().locale).select(count) === "one" && forms.one !== undefined ? forms.one : forms.other;
}
