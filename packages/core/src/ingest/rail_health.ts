/**
 * Real-time payment-rail health (§4.5) — the "call only when network healthy"
 * signal that makes recovery timing India-aware.
 *
 * In production this ingests an NPCI/UPI status feed (or Razorpay Optimizer
 * health scores). For the demo it is a *deterministic, reproducible* simulator
 * so the rail-health gate is auditable and never flakes.
 *
 * Design: rail health is a SCHEDULING/ELIGIBILITY signal, deliberately kept
 * OUT of the 13-dim model feature vector (§4.5) so adding it cannot silently
 * shift model behavior or break the frozen-feature contract. It feeds the
 * decision engine's timing/deferral, not the logreg score.
 */
import { hashSeed, clamp01 } from "@arbiter/shared";
import { RAIL_HEALTH_THRESHOLD } from "../decide/window.js";

export type RailId = "upi" | "imps" | "neft" | "cards" | "autopay";

export interface RailHealth {
  rail: RailId;
  /** 0 (down) .. 1 (fully healthy). */
  score: number;
  /** True when below the recovery threshold. */
  degraded: boolean;
}

export interface RailHealthSnapshot {
  overall: number;
  rails: RailHealth[];
  asOfUtc: string;
}

/**
 * Deterministic simulated rail-health for a moment. Models a recurring UPI
 * degradation window in late evening IST (when UPI load peaks) plus small
 * per-rail jitter seeded from the timestamp, so the same `nowMs` always yields
 * the same health (reproducible demo).
 */
export function simulatedRailHealth(nowMs: number): RailHealthSnapshot {
  if (!Number.isFinite(nowMs)) throw new Error("simulatedRailHealth: non-finite clock");

  // Hour-of-day in IST drives a smooth UPI stress curve (peak ~21:00 IST).
  // Keep the fractional part so mid-peak vs off-peak differ smoothly.
  const istMs = nowMs + 330 * 60_000;
  const istHour = (istMs % 86_400_000) / 3_600_000;
  const upiStress = Math.max(0, 1 - Math.abs(istHour - 21) / 6); // 0..1, peaks at 21:00
  const seed = hashSeed(`rail:${Math.floor(nowMs / 60_000)}`); // per-minute jitter
  const jitter = ((seed % 1000) / 1000 - 0.5) * 0.1;

  const upi = clamp01(0.95 - upiStress * 0.55 + jitter);
  const imps = clamp01(0.97 - upiStress * 0.2 + jitter * 0.5);
  const neft = clamp01(0.99 + jitter * 0.3);
  const cards = clamp01(0.9 - upiStress * 0.35 + jitter * 0.5);
  const autopay = clamp01(0.92 - upiStress * 0.3 + jitter * 0.4);

  const rails: RailHealth[] = [
    { rail: "upi", score: upi, degraded: upi < RAIL_HEALTH_THRESHOLD },
    { rail: "imps", score: imps, degraded: imps < RAIL_HEALTH_THRESHOLD },
    { rail: "neft", score: neft, degraded: neft < RAIL_HEALTH_THRESHOLD },
    { rail: "cards", score: cards, degraded: cards < RAIL_HEALTH_THRESHOLD },
    { rail: "autopay", score: autopay, degraded: autopay < RAIL_HEALTH_THRESHOLD },
  ];
  const overall = rails.reduce((s, r) => s + r.score, 0) / rails.length;
  return { overall, rails, asOfUtc: new Date(nowMs).toISOString() };
}

/** Convenience: is the overall rail healthy enough to attempt a recovery now? */
export function isRailHealthy(nowMs: number): boolean {
  return simulatedRailHealth(nowMs).overall >= RAIL_HEALTH_THRESHOLD;
}
