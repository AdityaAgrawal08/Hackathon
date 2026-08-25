import { describe, it, expect } from "vitest";
import { Rng, hashSeed } from "@arbiter/shared";

describe("Rng (invariant I-3 support: no Math.random anywhere)", () => {
  it("same seed ⇒ identical stream (byte-reproducibility)", () => {
    const a = new Rng("corpus/demo/v1");
    const b = new Rng("corpus/demo/v1");
    const seqA = Array.from({ length: 100 }, () => a.next());
    const seqB = Array.from({ length: 100 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("different seed ⇒ different stream", () => {
    const a = new Rng("seed-1");
    const b = new Rng("seed-2");
    expect(a.next()).not.toBe(b.next());
  });

  it("int() stays in range and covers span", () => {
    const r = new Rng(42);
    const seen = new Set<number>();
    for (let i = 0; i < 5_000; i++) {
      const v = r.int(3, 8);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThan(8);
      seen.add(v);
    }
    for (let v = 3; v < 8; v++) expect(seen.has(v)).toBe(true);
  });

  it("bernoulli respects bounds", () => {
    const r = new Rng("b");
    expect(r.bernoulli(0)).toBe(false);
    expect(r.bernoulli(1)).toBe(true);
    expect(() => r.bernoulli(1.5)).toThrow();
  });

  it("shuffle preserves multiset", () => {
    const r = new Rng("s");
    const src = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = r.shuffle([...src]).sort((x, y) => x - y);
    expect(out).toEqual(src);
  });

  it("hashSeed is stable and well-spread enough", () => {
    expect(hashSeed("arbiter")).toBe(hashSeed("arbiter"));
    expect(hashSeed("arbiter")).not.toBe(hashSeed("arbiteR"));
    expect(Number.isInteger(hashSeed("anything"))).toBe(true);
  });
});
