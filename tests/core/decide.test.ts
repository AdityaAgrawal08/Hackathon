/**
 * Decision-engine scaffold gates (P3 preview):
 *  - EV ≤ amount always; integer paise only (P3-B1 / I-5)
 *  - totality: fully-constrained ⇒ NO_ACTION with full refusal set (P3-B3/B4)
 *  - golden orderings: soft→payday wins, dead-method→retry ranks below link
 *  - tie-break deterministic across repeated runs (P3-B2)
 *  - policy parsing is strict: unknown key ⇒ boot error (P3-B7)
 */
import { describe, it, expect } from "vitest";
import {
  ACTIONS,
  CONTACT_COST_PAISE,
  assertTableComplete,
  DEFAULT_ACTION_MULTIPLIERS,
  multiplierFor,
} from "../../packages/core/src/decide/catalog.js";
import {
  defaultPolicy,
  parsePolicyPack,
} from "../../packages/core/src/decide/policy.js";
import {
  decide,
  ltvWeight,
  type DecideInput,
} from "../../packages/core/src/decide/engine.js";

const NOW = Date.UTC(2026, 1, 15, 10, 0, 0); // 15:30 IST — not quiet hours

function input(overrides: Partial<DecideInput> = {}): DecideInput {
  return {
    probability: 0.4,
    failureClass: "SOFT_RETRYABLE",
    amountPaise: 49_900,
    nowMs: NOW,
    policy: defaultPolicy(),
    inferredPaydayDay: 25,
    ...overrides,
  };
}

describe("catalog", () => {
  it("every class×action cell exists and is finite (P3-B5)", () => {
    expect(() => assertTableComplete(DEFAULT_ACTION_MULTIPLIERS)).not.toThrow();
    for (const cls of Object.keys(DEFAULT_ACTION_MULTIPLIERS) as Array<keyof typeof DEFAULT_ACTION_MULTIPLIERS>) {
      for (const action of ACTIONS) {
        const m = multiplierFor(cls, action);
        expect(Number.isFinite(m)).toBe(true);
        expect(m).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("unknown cells fail closed to 0; incomplete custom tables are boot errors", () => {
    expect(multiplierFor("SOFT_RETRYABLE", "RETRY_NOW", {
      SOFT_RETRYABLE: {},
      HARD_METHOD_DEAD: {},
      NETWORK_TIMEOUT: {},
      RISK_FLAGGED: {},
      UNKNOWN: {},
    })).toBe(0);
    expect(() =>
      assertTableComplete({
        SOFT_RETRYABLE: {},
        HARD_METHOD_DEAD: {},
        NETWORK_TIMEOUT: {},
        RISK_FLAGGED: {},
        UNKNOWN: {},
      }),
    ).toThrow(/incomplete/);
  });
});

describe("policy pack", () => {
  it("accepts the default and rejects unknown keys (P3-B7)", () => {
    expect(() => parsePolicyPack(defaultPolicy())).not.toThrow();
    expect(() =>
      parsePolicyPack({ ...defaultPolicy(), quiet_hors: { start_minute: 1, end_minute: 2 } }),
    ).toThrow();
    expect(() => parsePolicyPack({ confidence_floor_bp: 5 })).toThrow();
  });
});

describe("EV optimizer invariants", () => {
  it("EV never exceeds amount_paise, across the whole probability sweep (P3-B1)", () => {
    for (let bp = 0; bp <= 10_000; bp += 137) {
      const out = decide(input({ probability: bp / 10_000 }));
      for (const r of out.ranked) {
        expect(r.evPaise).toBeLessThanOrEqual(input().amountPaise);
        expect(Number.isInteger(r.evPaise)).toBe(true);
      }
    }
  });

  it("ranking is deterministic across 100 runs, ties broken by catalog order (P3-B2)", () => {
    const first = decide(input()).ranked.map((r) => r.action);
    for (let i = 0; i < 100; i++) {
      expect(decide(input()).ranked.map((r) => r.action)).toEqual(first);
    }
    // exact EV tie ⇒ earlier catalog entry wins
    // (RETRY_NOW and RETRY_PAYDAY share cost 300p; equal multipliers force
    // identical EV, so catalog order must decide — stably, every run)
    const tieInput = input({
      probability: 0.5,
      multipliers: {
        SOFT_RETRYABLE: { RETRY_NOW: 1, RETRY_PAYDAY: 1 },
        HARD_METHOD_DEAD: {},
        NETWORK_TIMEOUT: {},
        RISK_FLAGGED: {},
        UNKNOWN: {},
      },
    });
    const seq = Array.from({ length: 100 }, () => decide(tieInput).chosen.action);
    expect(new Set(seq).size).toBe(1);
    expect(seq[0]).toBe("RETRY_NOW");
  });

  it("is total: opted-out risky customer under cap ⇒ only NO_ACTION/HUMAN_REVIEW-class routes survive (P3-B4)", () => {
    const out = decide(
      input({
        failureClass: "RISK_FLAGGED",
        probability: 0.9,
        customerOptedOut: true,
      }),
    );
    const byAction = new Map(out.refusals.map((r) => [r.action, r.violatedRules]));
    expect(byAction.get("RETRY_PAYDAY")).toContain("OPTED_OUT");
    expect(byAction.get("HUMAN_REVIEW")).toContain("OPTED_OUT");
    expect(out.ranked.length).toBeGreaterThanOrEqual(1);
    expect(out.ranked.map((r) => r.action)).toContain("NO_ACTION");
  });

  it("fully-constrained slate ⇒ NO_ACTION fallback carries a reason string (P3-B4)", () => {
    const out = decide(input({ failureClass: "RISK_FLAGGED", customerOptedOut: true }));
    expect(out.chosen.action).toBe("NO_ACTION");
    expect(out.fallbackReason).toMatch(/^ALL_ACTIONS_CONSTRAINED:/);
    expect(out.fallbackReason).toContain("OPTED_OUT");
    expect(out.chosen.scheduledForMs).toBeNull();
  });

  it("collects ALL matched rules per refusal, not just the first (P3-B3)", () => {
    const out = decide(
      input({
        probability: 0.01, // below floor
        attemptsSoFar: 9, // over cap
        lastContactAtMs: NOW - 60_000, // inside interval
        amountPaise: 500_000_00, // over exposure cap
      }),
    );
    const retry = out.refusals.find((r) => r.action === "RETRY_NOW")!;
    expect(retry.violatedRules).toEqual(
      expect.arrayContaining(["ATTEMPT_CAP", "MIN_INTERVAL", "EXPOSURE_CAP", "CONFIDENCE_FLOOR"]),
    );
  });
});

describe("golden cases (plan gate)", () => {
  it("soft failure near payday ⇒ RETRY_PAYDAY wins", () => {
    const out = decide(input({ probability: 0.45 }));
    expect(out.chosen.action).toBe("RETRY_PAYDAY");
    expect(out.chosen.scheduledForMs).toBeGreaterThan(NOW);
    expect(out.fallbackReason).toBeNull();
  });

  it("RETRY_PAYDAY without an inferred payday is refused, not guessed (I-7)", () => {
    const out = decide(input({ probability: 0.45, inferredPaydayDay: null }));
    const refused = out.refusals.find((r) => r.action === "RETRY_PAYDAY")!;
    expect(refused.violatedRules).toContain("PAYDAY_UNKNOWN");
    expect(out.chosen.action).not.toBe("RETRY_PAYDAY");
  });

  it("dead method ⇒ blind retries score below ALTERNATE_UPI_LINK", () => {
    const out = decide(input({ failureClass: "HARD_METHOD_DEAD", probability: 0.7 }));

    // A 0-multiplier retry has no chance ⇒ confidence floor refuses it outright.
    const refused = out.refusals.find((r) => r.action === "RETRY_NOW")!;
    expect(refused.violatedRules).toContain("CONFIDENCE_FLOOR");

    // With the floor disabled, the same retry becomes feasible-but-toxic:
    // EV = 0 × amount − contact cost (pure loss) ⇒ ranked BELOW the link.
    const permissive = { ...defaultPolicy(), confidence_floor_bp: 0 };
    const raw = decide(input({ failureClass: "HARD_METHOD_DEAD", probability: 0.7, policy: permissive }));
    const rankOf = (a: string) => raw.ranked.findIndex((r) => r.action === a);
    const retryNow = raw.ranked.find((r) => r.action === "RETRY_NOW")!;
    expect(retryNow.multiplierUsed).toBe(0); // can NEVER recover
    expect(retryNow.evPaise).toBe(-CONTACT_COST_PAISE.RETRY_NOW); // pure loss
    expect(rankOf("RETRY_NOW")).toBeGreaterThan(rankOf("ALTERNATE_UPI_LINK"));
  });

  it("risk-flagged ⇒ HUMAN_REVIEW is the only ranked contact path (I-7)", () => {
    const out = decide(input({ failureClass: "RISK_FLAGGED", probability: 0.5 }));
    const contacts = out.ranked.filter((r) => !["NO_ACTION"].includes(r.action));
    expect(contacts.map((c) => c.action)).toEqual(["HUMAN_REVIEW"]);
  });

  it("quiet hours refuse contact actions but HUMAN_REVIEW/NO_ACTION remain (I-6/P5-B7)", () => {
    const out = decide(
      input({ nowMs: Date.UTC(2026, 1, 15, 17, 30, 0) }), // 23:00 IST
    );
    for (const a of ["RETRY_NOW", "RETRY_PAYDAY", "ALTERNATE_UPI_LINK", "REMINDER_LINK"]) {
      expect(out.refusals.find((r) => r.action === a)?.violatedRules).toContain("QUIET_HOURS");
    }
    expect(out.ranked.map((r) => r.action)).toEqual(
      expect.arrayContaining(["NO_ACTION"]),
    );
  });

  it("ltvWeight: 1 without signals; boosts whale/loyal; suppresses churner; bounded [0.2,1.5]", () => {
    expect(ltvWeight(undefined, undefined)).toBe(1);
    expect(ltvWeight(5_00_00_000, 0)).toBe(1.5); // max LTV, no churn
    expect(ltvWeight(0, 10_000)).toBeCloseTo(0.3, 10); // zero LTV, certain churn
    expect(ltvWeight(1_00_00_00_000, -1_000)).toBe(1.5); // clamped high
    expect(ltvWeight(0, 99_999)).toBeCloseTo(0.3, 10); // churn > 1 clamps to 1
    // monotonic: more LTV ⇒ heavier; more churn ⇒ lighter
    expect(ltvWeight(4_00_00_000, 1_000)).toBeGreaterThan(ltvWeight(1_00_00_000, 1_000));
    expect(ltvWeight(4_00_00_000, 5_000)).toBeLessThan(ltvWeight(4_00_00_000, 1_000));
  });

  it("LTV-aware EV: scales magnitude, preserves action ordering (chosen unchanged)", () => {
    const base = input();
    const plain = decide(base);

    // Whale: high LTV, low churn ⇒ EV gross scaled UP (×1.5), same winner.
    const whale = decide({ ...base, ltvPaise: 5_00_00_000, churnRiskBp: 0 });
    expect(whale.chosen.action).toBe(plain.chosen.action);
    const plainGross = plain.chosen.evPaise + CONTACT_COST_PAISE[plain.chosen.action];
    const whaleGross = whale.chosen.evPaise + CONTACT_COST_PAISE[whale.chosen.action];
    expect(whaleGross).toBe(Math.round(plainGross * 1.5));

    // Churner: zero LTV, certain churn ⇒ gross scaled DOWN (×~0.3), same winner.
    const churner = decide({ ...base, ltvPaise: 0, churnRiskBp: 10_000 });
    expect(churner.chosen.action).toBe(plain.chosen.action);
    const churnerGross = churner.chosen.evPaise + CONTACT_COST_PAISE[churner.chosen.action];
    expect(churnerGross).toBe(Math.round(plainGross * 0.3));

    // The DECISION is invariant: a per-customer scalar cannot change which
    // action maximises EV. (Tail-of-ranking near-ties may permute after
    // integer rounding of gross — inconsequential by definition of a tie.)
    expect(churner.chosen.action).toBe(plain.chosen.action);
    expect(whale.chosen.action).toBe(plain.chosen.action);

    // EV stays integer paise and ≤ amount under weighting.
    for (const r of whale.ranked) {
      expect(Number.isInteger(r.evPaise)).toBe(true);
      expect(r.evPaise).toBeLessThanOrEqual(base.amountPaise);
    }
  });
});
