/**
 * §4.5 Real-time payment-rail health / alternative-data signals.
 *  - deterministic simulated feed (reproducible, no flake)
 *  - nextRailHealthyWindowMs defers rail-dependent recovery when degraded
 *  - engine defers rail-dependent actions (opt-in railHealthScore) without
 *    changing EV or breaking golden cases that don't pass a score
 */
import { describe, it, expect } from "vitest";
import {
  simulatedRailHealth,
  isRailHealthy,
  type RailId,
} from "../../packages/core/src/ingest/rail_health.js";
import {
  nextRailHealthyWindowMs,
  RAIL_HEALTH_THRESHOLD,
  RAIL_DEPENDENT_ACTIONS,
} from "../../packages/core/src/decide/window.js";
import { decide } from "../../packages/core/src/decide/engine.js";
import { defaultPolicy } from "../../packages/core/src/decide/policy.js";

const NOW = Date.UTC(2026, 1, 15, 10, 0, 0); // 15:30 IST — healthy-ish

describe("simulated rail-health feed (deterministic)", () => {
  it("is reproducible for the same instant", () => {
    const a = simulatedRailHealth(NOW);
    const b = simulatedRailHealth(NOW);
    expect(a.overall).toBe(b.overall);
    expect(a.rails).toEqual(b.rails);
  });

  it("degrades during the UPI evening peak (≈21:00 IST) and is healthy mid-day", () => {
    const peak = simulatedRailHealth(Date.UTC(2026, 1, 15, 15, 30, 0)); // 21:00 IST
    const mid = simulatedRailHealth(Date.UTC(2026, 1, 15, 7, 0, 0)); // 12:30 IST
    expect(peak.overall).toBeLessThan(mid.overall);
    expect(isRailHealthy(Date.UTC(2026, 1, 15, 7, 0, 0))).toBe(true);
    // mid-day should be healthy by threshold
    expect(mid.overall).toBeGreaterThanOrEqual(RAIL_HEALTH_THRESHOLD);
  });

  it("reports per-rail scores in [0,1] with a degraded flag", () => {
    const snap = simulatedRailHealth(Date.UTC(2026, 1, 15, 15, 30, 0));
    for (const r of snap.rails) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
      expect(r.degraded).toBe(r.score < RAIL_HEALTH_THRESHOLD);
    }
    expect(snap.rails.map((r) => r.rail)).toEqual<RailId[]>([
      "upi",
      "imps",
      "neft",
      "cards",
      "autopay",
    ]);
  });
});

describe("nextRailHealthyWindowMs", () => {
  it("returns now when healthy", () => {
    expect(nextRailHealthyWindowMs(0.9, NOW)).toBe(NOW);
  });
  it("defers a fixed, deterministic slot when degraded", () => {
    const deferred = nextRailHealthyWindowMs(0.2, NOW);
    expect(deferred).toBe(NOW + 30 * 60_000);
  });
  it("throws on non-finite inputs", () => {
    expect(() => nextRailHealthyWindowMs(NaN, NOW)).toThrow();
    expect(() => nextRailHealthyWindowMs(0.2, NaN)).toThrow();
  });
});

describe("engine defers rail-dependent actions when the rail is degraded", () => {
  const NOW2 = Date.UTC(2026, 1, 15, 10, 0, 0);
  it("healthy rail → no deferral (existing behavior unchanged)", () => {
    const out = decide({
      probability: 0.7,
      failureClass: "HARD_METHOD_DEAD",
      amountPaise: 49_900,
      nowMs: NOW2,
      policy: defaultPolicy(),
      railHealthScore: 0.95,
    });
    const chosen = out.chosen;
    // RECOVER_VIA_RAIL is the moat winner; on a healthy rail it runs now.
    expect(chosen.scheduledForMs).toBeNull(); // immediate
  });

  it("degraded rail → rail-dependent action deferred to next healthy window", () => {
    const out = decide({
      probability: 0.7,
      failureClass: "HARD_METHOD_DEAD",
      amountPaise: 49_900,
      nowMs: NOW2,
      policy: defaultPolicy(),
      railHealthScore: 0.2,
    });
    const rail = out.ranked.find((r) => r.action === "RECOVER_VIA_RAIL");
    expect(rail?.scheduledForMs).toBe(NOW2 + 30 * 60_000);
    // EV is unchanged by deferral — same winner, just later.
    expect(out.chosen.action).toBe("RECOVER_VIA_RAIL");
  });

  it("opt-in: omitting railHealthScore leaves behavior identical (no regressions)", () => {
    const withScore = decide({
      probability: 0.5,
      failureClass: "SOFT_RETRYABLE",
      amountPaise: 49_900,
      nowMs: NOW2,
      policy: defaultPolicy(),
    });
    expect(withScore.chosen.scheduledForMs).toBeNull();
  });

  it("RAIL_DEPENDENT_ACTIONS enumerates the rail-touching actions", () => {
    expect([...RAIL_DEPENDENT_ACTIONS]).toEqual(
      expect.arrayContaining(["RETRY_NOW", "ALTERNATE_UPI_LINK", "RECOVER_VIA_RAIL"]),
    );
  });
});
