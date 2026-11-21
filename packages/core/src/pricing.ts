// Model token pricing (usage-and-cost.md §5): bundled USD-per-million-token table, prefix
// matching for dated model variants, and user overrides (`custom-pricing.json`). Pure: no I/O, no
// network. Unknown models and partial override rows yield `null` ("no price", never 0).

export type ModelPrice = {
  in: number;
  cached_in: number;
  cache_write_in: number;
  out: number;
};

export type PricingTable = {
  version: string;
  models: Record<string, ModelPrice>;
};

/**
 * Parsed user overrides: a valid entry holds all four prices; a partial or invalid entry is `null`,
 * which leaves matching models unpriced rather than mixing override and bundled sources.
 */
export type PricingOverrides = Record<string, ModelPrice | null>;

/** Released Anthropic Claude and OpenAI / Codex models, USD per 1M tokens. */
export const BUNDLED_PRICING: PricingTable = {
  version: "2026-11-14",
  models: {
    "claude-fable-5-1": { in: 15, cached_in: 1.5, cache_write_in: 18.75, out: 75 },
    "claude-opus-5-5": { in: 5, cached_in: 0.5, cache_write_in: 6.25, out: 25 },
    "claude-opus-5": { in: 5, cached_in: 0.5, cache_write_in: 6.25, out: 25 },
    "claude-sonnet-5-5": { in: 3, cached_in: 0.3, cache_write_in: 3.75, out: 15 },
    "claude-sonnet-5": { in: 3, cached_in: 0.3, cache_write_in: 3.75, out: 15 },
    "claude-haiku-5-5": { in: 1, cached_in: 0.1, cache_write_in: 1.25, out: 5 },
    "claude-haiku-5": { in: 1, cached_in: 0.1, cache_write_in: 1.25, out: 5 },
    "claude-opus-4-6": { in: 5, cached_in: 0.5, cache_write_in: 6.25, out: 25 },
    "claude-opus-4-5": { in: 5, cached_in: 0.5, cache_write_in: 6.25, out: 25 },
    "claude-sonnet-4-6": { in: 3, cached_in: 0.3, cache_write_in: 3.75, out: 15 },
    "claude-sonnet-4-5": { in: 3, cached_in: 0.3, cache_write_in: 3.75, out: 15 },
    "claude-haiku-4-5": { in: 1, cached_in: 0.1, cache_write_in: 1.25, out: 5 },
    "gpt-6.1-sol": { in: 1.5, cached_in: 0.15, cache_write_in: 0, out: 12 },
    "gpt-6.1-codex": { in: 1.5, cached_in: 0.15, cache_write_in: 0, out: 12 },
    "gpt-6.1": { in: 1.5, cached_in: 0.15, cache_write_in: 0, out: 12 },
    "gpt-6-codex": { in: 1.5, cached_in: 0.15, cache_write_in: 0, out: 12 },
    "gpt-6": { in: 1.5, cached_in: 0.15, cache_write_in: 0, out: 12 },
    "gpt-5.3-codex": { in: 1.75, cached_in: 0.175, cache_write_in: 0, out: 14 },
    "gpt-5.2-codex": { in: 1.75, cached_in: 0.175, cache_write_in: 0, out: 14 },
    "gpt-5.1-codex-max": { in: 1.25, cached_in: 0.125, cache_write_in: 0, out: 10 },
    "gpt-5.1-codex-mini": { in: 0.25, cached_in: 0.025, cache_write_in: 0, out: 2 },
    "gpt-5.1-codex": { in: 1.25, cached_in: 0.125, cache_write_in: 0, out: 10 },
    "gpt-5-codex": { in: 1.25, cached_in: 0.125, cache_write_in: 0, out: 10 },
    "gpt-5.2": { in: 1.75, cached_in: 0.175, cache_write_in: 0, out: 14 },
    "gpt-5.1": { in: 1.25, cached_in: 0.125, cache_write_in: 0, out: 10 },
    "gpt-5-mini": { in: 0.25, cached_in: 0.025, cache_write_in: 0, out: 2 },
    "gpt-5-nano": { in: 0.05, cached_in: 0.005, cache_write_in: 0, out: 0.4 },
    "gpt-5": { in: 1.25, cached_in: 0.125, cache_write_in: 0, out: 10 },
  },
};

const isPriceNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function parsePriceRow(value: unknown): ModelPrice | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const input = row["in"];
  const cachedIn = row["cached_in"];
  const cacheWriteIn = row["cache_write_in"];
  const out = row["out"];
  if (!isPriceNumber(input) || !isPriceNumber(cachedIn) || !isPriceNumber(cacheWriteIn) || !isPriceNumber(out)) return null;
  return { in: input, cached_in: cachedIn, cache_write_in: cacheWriteIn, out };
}

/**
 * Parses `custom-pricing.json` content (either `{ models: { ... } }` or a flat `{ "<model>": { ... } }`
 * object). Each row must carry all four prices; a partial row becomes `null` so it overrides the bundled
 * table as unpriced rather than mixing sources.
 */
export function parsePricingOverrides(raw: unknown): PricingOverrides | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const source = obj["models"] !== null && typeof obj["models"] === "object" && !Array.isArray(obj["models"]) ? (obj["models"] as Record<string, unknown>) : obj;
  const out: PricingOverrides = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "version" && typeof value === "string") continue;
    out[key] = parsePriceRow(value);
  }
  return out;
}

function findModel<T>(map: Record<string, T>, model: string): { found: true; value: T } | { found: false } {
  if (Object.hasOwn(map, model)) return { found: true, value: map[model]! };
  let bestKey = "";
  for (const key of Object.keys(map)) {
    if (key.length <= bestKey.length || !model.startsWith(key)) continue;
    const sep = model[key.length];
    if (sep === "-" || sep === "@") bestKey = key;
  }
  return bestKey === "" ? { found: false } : { found: true, value: map[bestKey]! };
}

/**
 * Resolves the price of `model`: user overrides win over the bundled table, with prefix matching for
 * dated variants (`claude-sonnet-5-5-20261001` matches `claude-sonnet-5-5`).
 */
export function matchModelPrice(model: string | null, overrides?: PricingOverrides | null, table: PricingTable = BUNDLED_PRICING): ModelPrice | null {
  if (model === null || model === "") return null;
  if (overrides !== undefined && overrides !== null) {
    const hit = findModel(overrides, model);
    if (hit.found) return hit.value;
  }
  const bundled = findModel(table.models, model);
  return bundled.found ? bundled.value : null;
}

/**
 * Estimated API-equivalent cost in USD (`in·p_in + cached_in·p_cache_read + cache_write_in·p_cache_write + out·p_out`),
 * or `null` when the model is unknown or unpriced. Reasoning tokens are included in `out` and not priced twice.
 */
export function estimateCostUsd(
  tokens: { model: string | null; in: number; cached_in: number; cache_write_in: number; out: number },
  overrides?: PricingOverrides | null,
  table: PricingTable = BUNDLED_PRICING,
): number | null {
  const price = matchModelPrice(tokens.model, overrides, table);
  if (price === null) return null;
  const usd = (tokens.in * price.in + tokens.cached_in * price.cached_in + tokens.cache_write_in * price.cache_write_in + tokens.out * price.out) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
