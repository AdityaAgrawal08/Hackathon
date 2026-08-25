/**
 * T4 validation gates:
 *  - byte-determinism across runs (P1-B1)
 *  - class shares within ±5pp bands (P1-B2 / F5)
 *  - corpus isolation trn_/demo_ (P1-B9)
 *  - history depth preserved (~60 cust × ~4 evt, F2 amendment)
 *  - no ground-truth leak into demo corpus
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { generateCorpus } from "../../packages/seed/src/generate.js";
import {
  CLASS_SHARES,
  FAILURE_CLASSES,
  SHARE_TOLERANCE_PP,
} from "../../packages/seed/src/taxonomy.js";

function shaOf(corpus: ReturnType<typeof generateCorpus>): string {
  return createHash("sha256")
    .update(JSON.stringify({ c: corpus.customers, e: corpus.events }))
    .digest("hex");
}

describe("seed generator (T4 gates)", () => {
  it("is byte-deterministic across runs (P1-B1)", () => {
    const a = generateCorpus("demo", { customerCount: 60, targetEvents: 230 });
    const b = generateCorpus("demo", { customerCount: 60, targetEvents: 230 });
    expect(shaOf(a)).toBe(shaOf(b));
    const t1 = generateCorpus("training", { customerCount: 1200, targetEvents: 5000 });
    const t2 = generateCorpus("training", { customerCount: 1200, targetEvents: 5000 });
    expect(shaOf(t1)).toBe(shaOf(t2));
  });

  it("emits class shares within ±5pp of configured distribution (P1-B2)", () => {
    const corpus = generateCorpus("training", { customerCount: 1200, targetEvents: 5000 });
    const n = corpus.events.length;
    for (const fc of FAILURE_CLASSES) {
      const actualPct =
        (corpus.events.filter((e) => e.failureClassHint === fc).length / n) * 100;
      const targetPct = CLASS_SHARES[fc] * 100;
      expect(
        Math.abs(actualPct - targetPct),
        `${fc}: ${actualPct.toFixed(2)}% vs ${targetPct}%`,
      ).toBeLessThanOrEqual(SHARE_TOLERANCE_PP);
    }
  });

  it("corpora are isolated by id prefix (P1-B9)", () => {
    const trn = generateCorpus("training", { customerCount: 200, targetEvents: 800 });
    const demo = generateCorpus("demo", { customerCount: 60, targetEvents: 230 });
    const trnIds = new Set(trn.customers.map((c) => c.id));
    for (const c of demo.customers) expect(trnIds.has(c.id)).toBe(false);
    for (const c of demo.customers) expect(c.id.startsWith("demo_cust_")).toBe(true);
    for (const c of trn.customers) expect(c.id.startsWith("trn_cust_")).toBe(true);
  });

  it("preserves history depth: ~4 events/customer, all covered (F2)", () => {
    const demo = generateCorpus("demo", { customerCount: 60, targetEvents: 230 });
    expect(demo.events.length).toBe(230);
    expect(demo.customers.length).toBe(60);
    const withEvents = new Set(demo.events.map((e) => e.customerId));
    expect(withEvents.size).toBe(60); // every customer has failures to recover
    expect(demo.events.length / demo.customers.length).toBeGreaterThanOrEqual(3.5);
  });

  it("leaks no ground truth into the demo corpus", () => {
    const demo = generateCorpus("demo", { customerCount: 60, targetEvents: 230 });
    for (const e of demo.events) expect(e.trueOutcomeSeed).toBeNull();
    for (const e of demo.events) expect(e.source).toBe("SEED");
  });

  it("every customer has a payday pattern from prior successes", () => {
    const demo = generateCorpus("demo", { customerCount: 60, targetEvents: 230 });
    for (const c of demo.customers) {
      const obs = Object.values(c.paydayPattern).reduce((s, n) => s + n, 0);
      expect(obs).toBe(c.priorSuccessCount);
      expect(c.priorSuccessCount).toBeGreaterThanOrEqual(2); // inference needs depth
    }
  });

  it("opted-out cohort exists and stays small", () => {
    const demo = generateCorpus("demo", { customerCount: 60, targetEvents: 230 });
    const opted = demo.customers.filter((c) => c.optedOut).length;
    expect(opted).toBeGreaterThan(0);
    expect(opted).toBeLessThan(10);
  });
});
