/**
 * P2 unit gates — metrics + leakage-safe splitting.
 *  - AUC/Brier/calibration correctness on hand-computable cases
 *  - customer-disjoint split with fail-closed leakage assertions (P2-B1)
 *  - per-class recall reports null (never 0) when a class has no positives
 */
import { describe, it, expect } from "vitest";
import {
  auc,
  brier,
  calibrationBins,
  splitByCustomer,
  assertDisjoint,
  perClassRecall,
} from "../../packages/ml/src/metrics.js";

describe("auc", () => {
  it("perfect ranking ⇒ 1; reversed ⇒ 0", () => {
    expect(auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1])).toBe(1);
    expect(auc([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1])).toBe(0);
  });

  it("averages tied ranks", () => {
    expect(auc([0.5, 0.5], [1, 0])).toBe(0.5);
    // no ties: pos ranks {1,3}, neg rank {2} → (4−3)/2 = 0.5
    expect(auc([0.3, 0.5, 0.6], [1, 0, 1])).toBe(0.5);
    // tied positives straddling the negative: ranks {1, 2.5}, neg {2.5}
    // → (3.5 − 3)/2 = 0.25 (naive ranks would give 1/3 or 0.5)
    expect(auc([0.4, 0.5, 0.5], [1, 0, 1])).toBe(0.25);
  });

  it("fails closed on degenerate input", () => {
    expect(() => auc([], [])).toThrow();
    expect(() => auc([0.5], [1])).toThrow(/single class/);
    expect(() => auc([0.5, 0.4], [1])).toThrow(/bad shapes/);
  });
});

describe("brier + calibrationBins", () => {
  it("brier is 0 for perfect, 1 for worst, bounded otherwise", () => {
    expect(brier([1, 0], [1, 0])).toBe(0);
    expect(brier([0, 1], [1, 0])).toBe(1);
    expect(brier([0.5, 0.5], [1, 0])).toBe(0.25);
    expect(() => brier([], [1])).toThrow();
  });

  it("value 1.0 lands in the last bin; counts partition n", () => {
    const bins = calibrationBins([0, 0.05, 0.95, 1], [0, 0, 1, 1], 10);
    expect(bins.length).toBe(10);
    const total = bins.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(4);
    expect(bins[0]!.count).toBe(2); // 0 and 0.05
    expect(bins[9]!.count).toBe(2); // 0.95 and 1.0
    expect(bins[9]!.meanPredicted).toBeCloseTo(0.975, 12);
    expect(bins[9]!.empiricalRate).toBe(1);
  });
});

describe("splitByCustomer + assertDisjoint", () => {
  function fakeRows(nCustomers: number) {
    return Array.from({ length: nCustomers }, (_, i) => ({
      customerId: `cust_${String(i).padStart(4, "0")}`,
    }));
  }

  it("every customer lands on exactly one side (P2-B1)", () => {
    const rows = fakeRows(500);
    const { train, holdout } = splitByCustomer(rows, 0.7);
    const tr = new Set(train.map((r) => r.customerId));
    const ho = new Set(holdout.map((r) => r.customerId));
    expect(tr.size + ho.size).toBe(500); // no customer duplicated across sides
    assertDisjoint(tr, ho, "unit"); // must not throw
    expect(train.length / 500).toBeGreaterThan(0.55); // ~70% within hash noise
    expect(train.length / 500).toBeLessThan(0.85);
  });

  it("is deterministic across runs", () => {
    const rows = fakeRows(300);
    const a = splitByCustomer(rows, 0.7);
    const b = splitByCustomer(rows, 0.7);
    expect(a.train.map((r) => r.customerId)).toEqual(b.train.map((r) => r.customerId));
  });

  it("assertDisjoint throws on overlap — the leakage alarm", () => {
    expect(() =>
      assertDisjoint(new Set(["a", "b"]), new Set(["b", "c"]), "tampered"),
    ).toThrow(/leakage/);
  });
});

describe("perClassRecall", () => {
  it("computes one-vs-rest recall at threshold; null when no positives", () => {
    //        row:      0     1     2     3     4
    const scores = [0.9, 0.4, 0.8, 0.1, 0.7];
    const labels = [1, 1, 0, 0, 0];
    const classes = ["SOFT", "SOFT", "HARD", "HARD", "NET"];
    const stats = perClassRecall(scores, labels, classes);

    const soft = stats.find((s) => s.failureClass === "SOFT")!;
    expect(soft.n).toBe(2);
    expect(soft.positives).toBe(2);
    expect(soft.recall).toBe(0.5); // only the 0.9 crosses 0.5

    const hard = stats.find((s) => s.failureClass === "HARD")!;
    expect(hard.positives).toBe(0);
    expect(hard.recall).toBeNull(); // honest null — not zero

    const net = stats.find((s) => s.failureClass === "NET")!;
    expect(net.meanScore).toBeCloseTo(0.7, 12);
  });

  it("honors a custom threshold and sorts class names deterministically", () => {
    const stats = perClassRecall([0.45], [1], ["X"], 0.4);
    expect(stats[0]!.recall).toBe(1);
    const order = perClassRecall(
      [0, 0, 0],
      [0, 0, 0],
      ["ZULU", "ALPHA", "MIKE"],
    ).map((s) => s.failureClass);
    expect(order).toEqual(["ALPHA", "MIKE", "ZULU"]);
  });

  it("fails closed on shape mismatch", () => {
    expect(() => perClassRecall([0.5], [1, 0], ["A"])).toThrow();
  });
});
