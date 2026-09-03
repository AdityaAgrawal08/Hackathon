/**
 * Numeric utilities — clamping functions used across the codebase.
 * Extracted from duplicate definitions in decide/engine.ts, features.ts,
 * and rail_health.ts (C-002).
 */

/** Clamp a number to [0, 1]. Returns 0 if non-finite. */
export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/** Clamp a number to [lo, hi]. Returns lo if non-finite. */
export function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}
