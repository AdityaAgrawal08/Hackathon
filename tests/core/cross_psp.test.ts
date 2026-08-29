/**
 * §4.1 Cross-PSP / cross-rail recovery orchestration.
 *  - railForFailureClass maps a failure class to the best alternate rail
 *  - decide() may choose RECOVER_VIA_RAIL as the top action for dead-method /
 *    network-timeout failures (the moat: a neutral agent switches rails the
 *    merchant owns, which a single PSP cannot do)
 *  - the Razorpay provider emits a real cross-rail payload with a deterministic
 *    rzpRequestRef and reuses the idempotency key (double-charge prevention)
 *  - bug #13: dry-run now honors catalog multipliers (dead action → FAILED)
 */
import { describe, it, expect, vi } from "vitest";
import {
  railForFailureClass,
  ACTIONS,
  DEFAULT_ACTION_MULTIPLIERS,
  multiplierFor,
} from "../../packages/core/src/decide/catalog.js";
import { decide } from "../../packages/core/src/decide/engine.js";
import { defaultPolicy } from "../../packages/core/src/decide/policy.js";
import { razorpayProvider } from "../../packages/core/src/executor/providers/razorpay.js";
import type { ProviderContext } from "../../packages/core/src/executor/providers/types.js";

describe("railForFailureClass (§4.1 mapping)", () => {
  it("maps dead method → same-PSP Payment Link", () => {
    expect(railForFailureClass("HARD_METHOD_DEAD")).toBe("razorpay_payment_link");
    expect(railForFailureClass("SOFT_RETRYABLE")).toBe("razorpay_payment_link");
  });
  it("maps network timeout → Optimizer secondary PSP", () => {
    expect(railForFailureClass("NETWORK_TIMEOUT")).toBe("optimizer_secondary_psp");
  });
  it("RECOVER_VIA_RAIL exists in the catalog and every class×action cell is finite", () => {
    expect(ACTIONS).toContain("RECOVER_VIA_RAIL");
    for (const cls of Object.keys(DEFAULT_ACTION_MULTIPLIERS) as Array<
      keyof typeof DEFAULT_ACTION_MULTIPLIERS
    >) {
      expect(Number.isFinite(multiplierFor(cls, "RECOVER_VIA_RAIL"))).toBe(true);
    }
  });
});

describe("decide picks RECOVER_VIA_RAIL for the moat scenarios", () => {
  const NOW = Date.UTC(2026, 1, 15, 10, 0, 0); // 15:30 IST, not quiet
  it("HARD_METHOD_DEAD → RECOVER_VIA_RAIL wins (switch instrument, not blind retry)", () => {
    const out = decide({
      probability: 0.7,
      failureClass: "HARD_METHOD_DEAD",
      amountPaise: 49_900,
      nowMs: NOW,
      policy: defaultPolicy(),
    });
    expect(out.chosen.action).toBe("RECOVER_VIA_RAIL");
    expect(out.chosen.scheduledForMs).toBeNull(); // immediate
  });

  it("NETWORK_TIMEOUT → RECOVER_VIA_RAIL wins (route to secondary PSP)", () => {
    const out = decide({
      probability: 0.7,
      failureClass: "NETWORK_TIMEOUT",
      amountPaise: 49_900,
      nowMs: NOW,
      policy: defaultPolicy(),
    });
    expect(out.chosen.action).toBe("RECOVER_VIA_RAIL");
  });

  it("RISK_FLAGGED → RECOVER_VIA_RAIL is refused (human-review-only class)", () => {
    const out = decide({
      probability: 0.7,
      failureClass: "RISK_FLAGGED",
      amountPaise: 49_900,
      nowMs: NOW,
      policy: defaultPolicy(),
    });
    const refused = out.refusals.find((r) => r.action === "RECOVER_VIA_RAIL");
    expect(refused?.violatedRules).toContain("HUMAN_REVIEW_CLASS");
    expect(out.ranked.map((r) => r.action)).not.toContain("RECOVER_VIA_RAIL");
  });
});

describe("Razorpay provider emits a cross-PSP payload (dry-run)", () => {
  vi.stubEnv("REAL_EXECUTION_MODE", "dry-run");
  function ctx(overrides: Partial<ProviderContext> = {}): ProviderContext {
    return {
      proposalId: "prop_xyz",
      actionId: "RECOVER_VIA_RAIL",
      failureClass: "HARD_METHOD_DEAD",
      amountPaise: 49_900,
      evPaise: 38_000,
      tenantId: "demo",
      rzpRequestRef: "rzpabc123456",
      idempotencyKey: "idemdeadbeef",
      nowMs: Date.UTC(2026, 1, 15, 10, 0, 0),
      ...overrides,
    };
  }

  it("builds a cross-rail payload with deterministic ref + idempotency key", async () => {
    const res = await razorpayProvider.execute(ctx());
    expect(res.outcome).toBe("SUCCEEDED");
    const payload = res.dryRunPayload as Record<string, unknown>;
    expect(payload.recovery_rail).toBe("razorpay_payment_link");
    expect(payload.rzp_request_ref).toBe("rzpabc123456");
    expect(payload.idempotency_key).toBe("idemdeadbeef");
    expect((payload.notes as Record<string, unknown>).switched_from).toBe("primary_rail");
    expect(payload.amount).toBe(49_900);
  });

  it("network timeout → routes via Optimizer to a secondary PSP", async () => {
    const res = await razorpayProvider.execute(ctx({ failureClass: "NETWORK_TIMEOUT" }));
    const payload = res.dryRunPayload as Record<string, unknown>;
    expect(payload.recovery_rail).toBe("optimizer_secondary_psp");
    expect(payload.optimizer_route).toBe(true);
  });

  it("bug #13: a DEAD action for its class fails even in dry-run (honest)", async () => {
    // RISK_FLAGGED has multiplier 0 for RECOVER_VIA_RAIL → should FAIL.
    const res = await razorpayProvider.execute(
      ctx({ failureClass: "RISK_FLAGGED" }),
    );
    expect(res.outcome).toBe("FAILED");
  });
});
