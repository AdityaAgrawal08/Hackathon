/**
 * Deterministic RNG — Invariant I-3 support, bug P1-B1 prevention.
 * Math.random() is banned in this repo. All randomness flows from an
 * explicit, seedable stream (mulberry32) so runs are byte-reproducible.
 */

/** FNV-1a 32-bit string hash → numeric seed. Stable across JS engines. */
export function hashSeed(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(state: number): () => number {
  let a = state >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private readonly next_: () => number;

  constructor(seed: string | number) {
    this.next_ = mulberry32(typeof seed === "string" ? hashSeed(seed) : seed >>> 0);
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.next_();
  }

  /** Uniform integer in [minIncl, maxExcl). */
  int(minIncl: number, maxExcl: number): number {
    if (!Number.isInteger(minIncl) || !Number.isInteger(maxExcl) || maxExcl <= minIncl) {
      throw new Error(`int(${minIncl},${maxExcl}) invalid range`);
    }
    const span = maxExcl - minIncl;
    // Rejection sampling avoids modulo bias.
    const limit = Math.floor(4294967296 / span) * span;
    for (;;) {
      const u = this.next_() * 4294967296;
      if (u < limit) return minIncl + (u % span);
    }
  }

  /** True with probability p ∈ [0,1]. */
  bernoulli(p: number): boolean {
    if (p < 0 || p > 1) throw new Error(`bernoulli p out of range: ${p}`);
    return this.next_() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick from empty array");
    return items[this.int(0, items.length)] as T;
  }

  /** Fisher–Yates, in place, deterministic. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(0, i + 1);
      const tmp = items[i] as T;
      items[i] = items[j] as T;
      items[j] = tmp;
    }
    return items;
  }
}
