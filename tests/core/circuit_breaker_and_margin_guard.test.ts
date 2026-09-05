/**
 * Tests for MarginGuard (Discount Invariants) and BankCircuitBreaker (Bank Outage Protection)
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MarginGuard, defaultMarginGuard } from "../../packages/core/src/agent/margin_guard.js";
import { OutageCircuitBreaker, defaultOutageCircuitBreaker } from "../../packages/core/src/agent/circuit_breaker.js";

describe("MarginGuard Financial Invariant Tests", () => {
  it("enforces maximum discount ceiling (default 1500 bps / 15%)", () => {
    const guard = new MarginGuard({ maxDiscountBps: 1500 });
    const original = 100000; // ₹1,000.00

    // 10% discount (allowed)
    const validProposal = 90000; // ₹900.00
    const res1 = guard.validateDiscount(original, validProposal);
    expect(res1.allowed).toBe(true);
    expect(res1.discountPercent).toBe(10);
    expect(res1.discountPaise).toBe(10000);

    // 20% discount (blocked)
    const invalidProposal = 80000; // ₹800.00
    const res2 = guard.validateDiscount(original, invalidProposal);
    expect(res2.allowed).toBe(false);
    expect(res2.discountPercent).toBe(20);
    expect(res2.reason).toContain("exceeds maximum allowable ceiling");
  });

  it("computes safe downsell amount clamped to merchant ceiling", () => {
    const guard = new MarginGuard({ maxDiscountBps: 1500 });
    const original = 500000; // ₹5,000.00

    // Requested 25% discount should be clamped to 15%
    const safeAmount = guard.computeSafeDownsellPaise(original, 2500);
    expect(safeAmount).toBe(425000); // ₹4,250.00 (15% discount)
  });

  it("enforces product floor pricing when configured", () => {
    const guard = new MarginGuard({
      maxDiscountBps: 2000,
      productFloorPaiseMap: { "prod_vip": 450000 },
    });

    const res = guard.validateDiscount(500000, 400000, "prod_vip");
    expect(res.allowed).toBe(false);
    expect(res.reason).toContain("below product floor");
  });
});

describe("OutageCircuitBreaker Rail Outage Protection Tests", () => {
  let cb: OutageCircuitBreaker;

  beforeEach(() => {
    cb = new OutageCircuitBreaker({ failureThreshold: 3, cooldownPeriodMs: 60000 });
  });

  it("starts in CLOSED state and allows dispatch", () => {
    const check = cb.canDispatch("HDFC");
    expect(check.allowed).toBe(true);
    expect(check.state).toBe("CLOSED");
  });

  it("trips to OPEN after consecutive bank downtime failures", () => {
    cb.recordOutcome("HDFC", true, "BANK_DOWNTIME");
    cb.recordOutcome("HDFC", true, "BANK_DOWNTIME_NETWORK_ERROR");
    expect(cb.canDispatch("HDFC").state).toBe("CLOSED");

    // 3rd failure trips threshold
    const state = cb.recordOutcome("HDFC", true, "NPCI_UNAVAILABLE");
    expect(state).toBe("OPEN");

    const check = cb.canDispatch("HDFC");
    expect(check.allowed).toBe(false);
    expect(check.state).toBe("OPEN");
    expect(check.reason).toContain("active banking downtime outage");
  });

  it("transitions from OPEN to HALF_OPEN after cooldown expires", () => {
    const now = 1000000;
    cb.recordOutcome("SBI", true, "INTERNAL_SERVER_ERROR", now);
    cb.recordOutcome("SBI", true, "INTERNAL_SERVER_ERROR", now);
    cb.recordOutcome("SBI", true, "INTERNAL_SERVER_ERROR", now);
    expect(cb.canDispatch("SBI", now).state).toBe("OPEN");

    // After cooldown (60s)
    const checkProbe = cb.canDispatch("SBI", now + 65000);
    expect(checkProbe.allowed).toBe(true);
    expect(checkProbe.state).toBe("HALF_OPEN");

    // Successful probe returns rail to CLOSED
    cb.recordOutcome("SBI", false, undefined, now + 66000);
    expect(cb.canDispatch("SBI", now + 66000).state).toBe("CLOSED");
  });
});
