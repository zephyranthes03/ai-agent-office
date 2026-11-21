// The page's fixed words: index.html marks a text with `data-i18n` and an attribute with
// `data-i18n-<attribute>`, each naming a key of the words' `page` section. A `code` span is written
// between backticks and built as a node, never as markup. A key the words lack is an error, not a blank.
import { t } from "./index.ts";
import type { Messages } from "./index.ts";

const ATTRIBUTES = ["aria-label", "title", "placeholder"] as const;

function word(key: string): string {
  const page = t().page;
  if (!Object.hasOwn(page, key)) throw new Error(`agent-office: the page has no words for "${key}"`);
  return page[key as keyof Messages["page"]];
}

function withCode(text: string): (string | HTMLElement)[] {
  return text.split("`").map((part, index) => {
    if (index % 2 === 0) return part;
    const code = document.createElement("code");
    code.textContent = part;
    return code;
  });
}

/** Writes the marked texts and attributes under `root` in the language shown. */
export function translatePage(root: ParentNode): void {
  for (const node of root.querySelectorAll<HTMLElement>("[data-i18n]")) node.replaceChildren(...withCode(word(node.dataset["i18n"]!)));
  for (const attribute of ATTRIBUTES) for (const node of root.querySelectorAll(`[data-i18n-${attribute}]`)) node.setAttribute(attribute, word(node.getAttribute(`data-i18n-${attribute}`)!));
}
