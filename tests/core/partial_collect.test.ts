/**
 * §4.8 B2B partial-collect via Razorpay Smart Collect.
 *  - PARTIAL_COLLECT is a contact action generalizing ALTERNATE_UPI_LINK
 *  - the executor builds a deterministic Smart Collect UPI identifier + partial amount
 *  - partial amount = round(full * PARTIAL_COLLECT_FRACTION), reproducible & idempotent
 */
import { describe, it, expect } from "vitest";
import { razorpayProvider } from "../../packages/core/src/executor/providers/razorpay.js";
import {
  isContactAction,
  PARTIAL_COLLECT_FRACTION,
  ACTIONS,
} from "../../packages/core/src/decide/catalog.js";
import type { ProviderContext } from "../../packages/core/src/executor/providers/types.js";

function ctx(partial: Partial<ProviderContext>): ProviderContext {
  return {
    proposalId: "prop_xyz",
    actionId: "PARTIAL_COLLECT",
    failureClass: "NETWORK_TIMEOUT",
    amountPaise: 5_00_000,
    evPaise: 1_50_000,
    tenantId: "demo",
    rzpRequestRef: "abc123def456",
    idempotencyKey: "idem0011",
    nowMs: Date.UTC(2026, 1, 15, 10, 0, 0),
    ...partial,
  };
}

describe("catalog: PARTIAL_COLLECT", () => {
  it("is a recognized contact action", () => {
    expect(ACTIONS).toContain("PARTIAL_COLLECT");
    expect(isContactAction("PARTIAL_COLLECT")).toBe(true);
  });

  it("PARTIAL_COLLECT_FRACTION is 0.3 (first-installment default)", () => {
    expect(PARTIAL_COLLECT_FRACTION).toBe(0.3);
  });
});

describe("executor: Smart Collect payload (§4.8)", () => {
  it("builds a Smart Collect UPI intent with partial amount", async () => {
    const r = await razorpayProvider.execute(ctx({}));
    expect(r.outcome).toBe("SUCCEEDED");
    const p = r.dryRunPayload as Record<string, unknown>;
    expect(p.rail).toBe("smart_collect_upi");
    expect(p.full_amount).toBe(5_00_000);
    // 30% of 5,00,000 = 1,50,000
    expect(p.amount).toBe(1_50_000);
    const sc = p.smart_collect as Record<string, unknown>;
    expect(sc.vpa).toBe("rzpsc.demo.prop_xyz");
    expect(sc.collector_id).toBe("sc_abc123def456");
    expect(sc.partial_allowed).toBe(true);
    expect(sc.min_amount).toBe(1_50_000);
  });

  it("partial amount is reproducible from the fraction", async () => {
    const r = await razorpayProvider.execute(ctx({ amountPaise: 12_50_000 }));
    const p = r.dryRunPayload as Record<string, unknown>;
    // 30% of 12,50,000 = 3,75,000
    expect(p.amount).toBe(3_75_000);
    expect(p.full_amount).toBe(12_50_000);
  });

  it("deterministic Smart Collect identifier (idempotent across retries)", async () => {
    const a = await razorpayProvider.execute(ctx({}));
    const b = await razorpayProvider.execute(ctx({}));
    expect(a.dryRunPayload).toEqual(b.dryRunPayload);
    const pa = a.dryRunPayload as Record<string, unknown>;
    const pb = b.dryRunPayload as Record<string, unknown>;
    expect((pa.smart_collect as Record<string, unknown>).vpa).toBe(
      (pb.smart_collect as Record<string, unknown>).vpa,
    );
  });

  it("generalizes ALTERNATE_UPI_LINK for a large B2B invoice (HARD_METHOD_DEAD)", async () => {
    const r = await razorpayProvider.execute(ctx({ failureClass: "HARD_METHOD_DEAD" }));
    expect(r.outcome).toBe("SUCCEEDED");
    const p = r.dryRunPayload as Record<string, unknown>;
    expect(p.rail).toBe("smart_collect_upi");
    expect(p.amount).toBe(1_50_000);
  });
});
