// A deterministic presentation seed from a stable id; no clocks, storage or inference.
export function seedUnit(seed: string | number, channel: string): number {
  let hash = 2166136261;
  for (const letter of `${seed}:${channel}`) hash = Math.imul(hash ^ letter.codePointAt(0)!, 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967296;
}
