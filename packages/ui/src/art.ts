// Loading the temporary preview art (packages/ui/art-preview), served by the daemon under `art/`.
import { t } from "./i18n/index.ts";

export const ART_BASE = "art/";

export async function loadImage(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = new URL(url, new URL(ART_BASE, document.baseURI)).href;
  await image.decode();
  return image;
}

export async function loadJson<T>(url: string): Promise<T> {
  const response = await fetch(new URL(url, new URL(ART_BASE, document.baseURI)));
  if (!response.ok) throw new Error(t().app.artFileFailed(url));
  return (await response.json()) as T;
}
