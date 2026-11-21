// The clothing colour and three-character code that tell sessions of one species apart. They are
// visual aids only: they carry no state, risk or priority, they may repeat, and selection, cards and
// seats are always keyed by the full session id.
import { seedUnit } from "./seed.ts";

export type Identity = { paletteId: string; label: string; color: string; ink: string; code: string };

export const identityPalettes = Object.freeze(
  [
    { id: "moss", name: "moss", color: "#658257", ink: "#395035" },
    { id: "lagoon", name: "lagoon", color: "#447f83", ink: "#2b5154" },
    { id: "denim", name: "denim", color: "#59739e", ink: "#354766" },
    { id: "heather", name: "lilac", color: "#9573a3", ink: "#62486e" },
    { id: "clay", name: "clay", color: "#ae785f", ink: "#704936" },
    { id: "oat", name: "sand", color: "#b39b6c", ink: "#665737" },
  ].map((palette) => Object.freeze(palette)),
);

export function identityFor(sessionId: string): Identity {
  if (typeof sessionId !== "string" || sessionId.length === 0) throw new TypeError("A nonempty stable session ID is required");
  const palette = identityPalettes[Math.floor(seedUnit(sessionId, "identity-palette-v1") * identityPalettes.length)]!;
  const code = Math.floor(seedUnit(sessionId, "identity-label-v1") * 4294967296).toString(36).toUpperCase().padStart(7, "0").slice(-3);
  return { paletteId: palette.id, label: palette.name, color: palette.color, ink: palette.ink, code };
}
