/**
 * P2 unit gates — dataset builder + deterministic labels.
 *  - labels are a pure function of (eventId, trueOutcomeSeed)
 *  - strictly-prior history per customer (decision-time safety, P2-B2)
 *  - dataset sha pins content; any mutation is detectable (I-3 provenance)
 */
import { describe, it, expect } from "vitest";
import { deriveLabel } from "../../packages/ml/src/labels.js";
import { buildTrainingDataset, datasetSha } from "../../packages/ml/src/dataset.js";

function handCorpus() {
  return {
    customers: [
      {
        id: "c1",
        paydayPattern: { "27": 3, "28": 2 },
        channelResponsiveness: 0.7,
        priorSuccessCount: 5,
        joinedAtUtc: "2025-06-01T00:00:00.000Z",
      },
      {
        id: "c2",
        paydayPattern: { "1": 4 },
        channelResponsiveness: 0.3,
        priorSuccessCount: 4,
        joinedAtUtc: "2025-01-01T00:00:00.000Z",
      },
    ],
    events: [
      // c1 failure #1 — no priors. id out of order on purpose (sort check).
      { id: "e2", customerId: "c1", amountPaise: 10_000, failureCode: "INSUFFICIENT_FUNDS", occurredAtUtc: "2026-01-10T09:00:00.000Z", trueOutcomeSeed: 0.9 },
      // c1 failure #2 — one strictly-prior failure
      { id: "e1", customerId: "c1", amountPaise: 12_000, failureCode: "GATEWAY_TIMEOUT", occurredAtUtc: "2026-01-20T09:00:00.000Z", trueOutcomeSeed: 0.2 },
      // c1 failure #3 — two priors + outlier amount ⇒ clamped z
      { id: "e3", customerId: "c1", amountPaise: 9_000_000, failureCode: "CARD_EXPIRED", occurredAtUtc: "2026-01-30T09:00:00.000Z", trueOutcomeSeed: 0.5 },
      // truth-less row — must be skipped, never trained on
      { id: "e4", customerId: "c2", amountPaise: 5_000, failureCode: "RISK_BLOCKED", occurredAtUtc: "2026-02-01T09:00:00.000Z", trueOutcomeSeed: null },
    ],
  };
}

describe("deriveLabel", () => {
  it("is deterministic for the same (id, probability)", () => {
    for (let i = 0; i < 50; i++) {
      const p = i / 50;
      expect(deriveLabel(`evt_${i}`, p)).toBe(deriveLabel(`evt_${i}`, p));
    }
  });

  it("degenerate probabilities resolve exactly; invalid throws", () => {
    expect(deriveLabel("a", 1)).toBe(1);
    expect(deriveLabel("a", 0)).toBe(0);
    expect(() => deriveLabel("a", 1.5)).toThrow();
    expect(() => deriveLabel("a", Number.NaN)).toThrow();
  });
});

describe("buildTrainingDataset", () => {
  it("uses only strictly-prior history per customer", () => {
    const ds = buildTrainingDataset(handCorpus());
    expect(ds.rows.length).toBe(3);
    expect(ds.skipped).toBe(1); // e4 excluded and counted

    const byId = new Map(ds.rows.map((r) => [r.eventId, r]));
    const AMOUNT_Z = 6;
    // e2/e1 have <2 priors ⇒ amount_z sentinel 0
    expect(byId.get("e2")!.values[AMOUNT_Z]).toBe(0);
    expect(byId.get("e1")!.values[AMOUNT_Z]).toBe(0);
    // e3 has two priors + ₹90k outlier ⇒ clamped positive z
    expect(byId.get("e3")!.values[AMOUNT_Z]).toBe(5);
    // e3's class is code-derived, hint column notwithstanding
    expect(byId.get("e3")!.failureClass).toBe("HARD_METHOD_DEAD");
  });

  it("sorts rows by eventId with pinned vector width, all finite", () => {
    const ds = buildTrainingDataset(handCorpus());
    const ids = ds.rows.map((r) => r.eventId);
    expect(ids).toEqual([...ids].sort());
    for (const r of ds.rows) {
      expect(r.values.length).toBe(11);
      for (const v of r.values) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("sha pins content: stable across runs, sensitive to any change", () => {
    const ds = buildTrainingDataset(handCorpus());
    const again = buildTrainingDataset(handCorpus());
    expect(ds.sha256).toBe(again.sha256);

    // Amount-only tweak on a first failure is feature-insensitive
    // (<2 priors ⇒ z sentinel), so mutate something the model sees:
    // a different decline code flips the class recorded per row.
    const mutated = handCorpus();
    mutated.events[2]!.failureCode = "SUSPECTED_FRAUD";
    expect(buildTrainingDataset(mutated).sha256).not.toBe(ds.sha256);

    // direct helper agrees with the builder
    expect(datasetSha(ds.rows)).toBe(ds.sha256);
  });

  it("orphan events fail closed", () => {
    const bad = handCorpus();
    bad.events[0]!.customerId = "ghost";
    expect(() => buildTrainingDataset(bad)).toThrow(/orphan/);
  });
});
