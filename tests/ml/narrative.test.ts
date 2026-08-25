/**
 * P2 unit gates — narrative layer compliance + resilience.
 *  - validator strips absolute claims (P2-B9)
 *  - fallback is deterministic and claim-free
 *  - Claude path: temp-0 prompt, cached, never blocks/crashes the pipeline
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  narrateCase,
  validateNarrative,
  fallbackNarrative,
  clearNarrativeCache,
  PROMPT_VERSION,
} from "../../packages/ml/src/narrative.js";

const CASE = {
  eventId: "demo_evt_000042",
  failureClass: "SOFT_RETRYABLE",
  action: "RETRY_PAYDAY",
  probability: 0.423,
  amountPaise: 49_900,
  attributions: [
    { feature: "near_payday", contribution: 0.81 },
    { feature: "f_class_soft", contribution: 0.44 },
  ],
};

function withNoApiKey(fn: () => Promise<void>): Promise<void> {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  return fn().finally(() => {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  });
}

afterEach(() => clearNarrativeCache());

describe("validateNarrative", () => {
  it("strips sentences with absolute claims and flags them (P2-B9)", () => {
    const v = validateNarrative(
      "Model estimates 42.3% recovery probability. Recovery is guaranteed. Next retry is near payday.",
    );
    expect(v.flagged).toBe(true);
    expect(v.text).not.toContain("guaranteed");
    expect(v.text).toContain("42.3%");
    expect(v.text).toContain("payday");
  });

  it("catches the full promise family", () => {
    for (const s of [
      "We promise success.",
      "This will recover the payment.",
      "It is certainly a soft decline.",
      "A risk-free retry.",
      "100% chance of success.",
      "Assured recovery within 2 days.",
    ]) {
      expect(validateNarrative(s).flagged).toBe(true);
    }
  });

  it("passes clean copy unflagged", () => {
    const v = validateNarrative(
      "Model estimates 42.3% recovery probability; approval required before contact.",
    );
    expect(v.flagged).toBe(false);
    expect(v.text).toContain("42.3%");
  });
});

describe("fallbackNarrative", () => {
  it("is byte-deterministic across calls", () => {
    expect(fallbackNarrative(CASE)).toBe(fallbackNarrative(CASE));
  });

  it("cites pre-computed numbers verbatim and stays compliant", () => {
    const text = fallbackNarrative(CASE);
    expect(text).toContain("₹499.00");
    expect(text).toContain("42.3%");
    expect(text).toContain("RETRY_PAYDAY");
    expect(validateNarrative(text).flagged).toBe(false);
  });

  it("never fabricates precision beyond inputs", () => {
    expect(fallbackNarrative({ ...CASE, attributions: [] })).toContain("n/a");
  });
});

describe("narrateCase", () => {
  it("uses the deterministic fallback when no API key exists", async () => {
    await withNoApiKey(async () => {
      const r = await narrateCase(CASE);
      expect(r.source).toBe("fallback");
      expect(r.promptVersion).toBe(PROMPT_VERSION);
      expect(r.text).toBe(fallbackNarrative(CASE));
    });
  });

  it("validates Claude output and flags claim-y prose", async () => {
    const calls: Array<{ url: string; init: { body: string } }> = [];
    const fakeFetch = async (url: string, init: { body: string }) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: "text", text: "Soft decline, 42.3% estimate. Guaranteed to succeed." }],
        }),
      };
    };
    const r = await narrateCase(CASE, { apiKey: "k-test", fetchImpl: fakeFetch as never });
    expect(r.source).toBe("claude");
    expect(r.flagged).toBe(true);
    expect(r.text).not.toContain("Guaranteed");
    expect(r.text).toContain("42.3%");

    // temp-0 pinned prompt
    const body = JSON.parse(calls[0]!.init.body) as { temperature: number; model: string };
    expect(body.temperature).toBe(0);
    expect(calls[0]!.url).toContain("/v1/messages");
  }, 15000);

  it("falls back silently when Claude errors — pipeline never crashes (P2-B10)", async () => {
    const failing = async () => {
      throw new Error("boom");
    };
    const r = await narrateCase(CASE, { apiKey: "k-test", fetchImpl: failing as never });
    expect(r.source).toBe("fallback");
    expect(r.text).toBe(fallbackNarrative(CASE));
  });

  it("falls back on empty/HTTP-error responses too", async () => {
    const empty = async () => ({ ok: true, status: 200, json: async () => ({ content: [] }) });
    expect((await narrateCase(CASE, { apiKey: "k", fetchImpl: empty as never })).source).toBe("fallback");

    const http500 = async () => ({ ok: false, status: 500, json: async () => ({}) });
    expect((await narrateCase(CASE, { apiKey: "k", fetchImpl: http500 as never })).source).toBe("fallback");
  });

  it("caches by case key — identical case hits the memo, not the API", async () => {
    let calls = 0;
    const impl = async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "Clean sentence." }] }) };
    };
    const first = await narrateCase(CASE, { apiKey: "k", fetchImpl: impl as never, noCache: false });
    const second = await narrateCase(CASE, { apiKey: "k", fetchImpl: impl as never, noCache: false });
    expect(second.text).toBe(first.text);
    expect(calls).toBe(1); // second call served from cache

    // changed probability ⇒ new cache key ⇒ real call
    await narrateCase({ ...CASE, probability: 0.9 }, { apiKey: "k", fetchImpl: impl as never });
    expect(calls).toBe(2);
  });
});
