// The DOM helpers the page's modules share: a new element with its class and text (always set as
// text, never as markup), an element of the page by id, which must exist, and writes that leave an
// element alone when it already shows the value (for what is written on every frame).

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`Missing element #${id}`);
  return node as T;
}

/** Sets an inline style property, only when it differs. */
export function setStyle(node: HTMLElement, property: "left" | "top" | "width" | "height", value: string): void {
  if (node.style[property] !== value) node.style[property] = value;
}

/** Sets a `data-` attribute, or removes it for null, only when that changes it. */
export function setData(node: HTMLElement, key: string, value: string | null): void {
  if ((node.dataset[key] ?? null) === value) return;
  if (value === null) delete node.dataset[key];
  else node.dataset[key] = value;
}

/** Sets an element's text, only when it differs. */
export function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}
