/**
 * §4.6 Audited multilingual (Hinglish / regional) voice + WhatsApp recovery.
 *  - RECOVER_VOICE_HI / RECOVER_WHATSAPP catalog actions with finite multipliers
 *  - Razorpay provider emits a real Gupshup/WhatsApp Business API template
 *    (Hinglish, {{1}} = failed amount) with deterministic ref + idempotency
 *  - reuses §4.5 rail-health gate: "call only when network healthy" defers the
 *    voice/WhatsApp attempt to the next healthy window
 */
import { describe, it, expect, vi } from "vitest";
import {
  ACTIONS,
  DEFAULT_ACTION_MULTIPLIERS,
  multiplierFor,
} from "../../packages/core/src/decide/catalog.js";
import { decide } from "../../packages/core/src/decide/engine.js";
import { defaultPolicy } from "../../packages/core/src/decide/policy.js";
import { razorpayProvider } from "../../packages/core/src/executor/providers/razorpay.js";
import type { ProviderContext } from "../../packages/core/src/executor/providers/types.js";

describe("catalog: voice/WhatsApp actions exist with finite multipliers", () => {
  it("both actions are in the catalog and every class×action cell is finite", () => {
    expect(ACTIONS).toContain("RECOVER_VOICE_HI");
    expect(ACTIONS).toContain("RECOVER_WHATSAPP");
    for (const cls of Object.keys(DEFAULT_ACTION_MULTIPLIERS) as Array<
      keyof typeof DEFAULT_ACTION_MULTIPLIERS
    >) {
      expect(Number.isFinite(multiplierFor(cls, "RECOVER_VOICE_HI"))).toBe(true);
      expect(Number.isFinite(multiplierFor(cls, "RECOVER_WHATSAPP"))).toBe(true);
    }
  });
});

describe("decide: voice/WhatsApp feasible except risk-flagged", () => {
  const NOW = Date.UTC(2026, 1, 15, 10, 0, 0);
  it("SOFT_RETRYABLE → both voice/WhatsApp are feasible ranked actions", () => {
    const out = decide({
      probability: 0.5,
      failureClass: "SOFT_RETRYABLE",
      amountPaise: 49_900,
      nowMs: NOW,
      policy: defaultPolicy(),
    });
    expect(out.ranked.map((r) => r.action)).toEqual(
      expect.arrayContaining(["RECOVER_VOICE_HI", "RECOVER_WHATSAPP"]),
    );
  });
  it("RISK_FLAGGED → voice/WhatsApp refused (human-review-only class)", () => {
    const out = decide({
      probability: 0.7,
      failureClass: "RISK_FLAGGED",
      amountPaise: 49_900,
      nowMs: NOW,
      policy: defaultPolicy(),
    });
    for (const a of ["RECOVER_VOICE_HI", "RECOVER_WHATSAPP"]) {
      const refused = out.refusals.find((r) => r.action === a);
      expect(refused?.violatedRules).toContain("HUMAN_REVIEW_CLASS");
    }
  });
});

describe("Razorpay provider emits an audited Hinglish payload", () => {
  vi.stubEnv("REAL_EXECUTION_MODE", "dry-run");
  function ctx(actionId: string): ProviderContext {
    return {
      proposalId: "prop_v",
      actionId,
      failureClass: "SOFT_RETRYABLE",
      amountPaise: 49_900,
      evPaise: 30_000,
      tenantId: "demo",
      rzpRequestRef: "rzpvw123456",
      idempotencyKey: "idemvwbeef",
      nowMs: Date.UTC(2026, 1, 15, 10, 0, 0),
    };
  }

  it("WhatsApp payload is a Gupshup template with {{1}} = amount (INR)", async () => {
    const res = await razorpayProvider.execute(ctx("RECOVER_WHATSAPP"));
    expect(res.outcome).toBe("SUCCEEDED");
    const p = res.dryRunPayload as Record<string, unknown>;
    expect(p.channel).toBe("whatsapp");
    expect(p.provider).toBe("gupshup");
    const tpl = p.template as Record<string, unknown>;
    expect(tpl.name).toBe("recovery_reminder_hinglish");
    expect(tpl.language).toBe("hi");
    const pers = p.personalization as Record<string, string>;
    expect(pers["1"]).toBe("₹499.00");
    expect(p.rzp_request_ref).toBe("rzpvw123456");
    expect(p.idempotency_key).toBe("idemvwbeef");
    expect(typeof p.preview).toBe("string");
    expect((p.preview as string).length).toBeGreaterThan(0);
  });

  it("Voice payload mirrors the template model on the voice channel", async () => {
    const res = await razorpayProvider.execute(ctx("RECOVER_VOICE_HI"));
    const p = res.dryRunPayload as Record<string, unknown>;
    expect(p.channel).toBe("voice");
    expect((p.template as Record<string, unknown>).name).toBe("recovery_voice_hinglish");
    expect((p.personalization as Record<string, string>)["1"]).toBe("₹499.00");
  });
});

describe("§4.5×§4.6: 'call only when network healthy' defers voice/WhatsApp", () => {
  const NOW = Date.UTC(2026, 1, 15, 10, 0, 0);
  it("degraded rail → voice/WhatsApp deferred to the next healthy window", () => {
    const out = decide({
      probability: 0.5,
      failureClass: "SOFT_RETRYABLE",
      amountPaise: 49_900,
      nowMs: NOW,
      policy: defaultPolicy(),
      railHealthScore: 0.2,
    });
    for (const a of ["RECOVER_VOICE_HI", "RECOVER_WHATSAPP"]) {
      const r = out.ranked.find((x) => x.action === a);
      expect(r?.scheduledForMs).toBe(NOW + 30 * 60_000);
    }
  });
  it("healthy rail → voice/WhatsApp run immediately (no deferral)", () => {
    const out = decide({
      probability: 0.5,
      failureClass: "SOFT_RETRYABLE",
      amountPaise: 49_900,
      nowMs: NOW,
      policy: defaultPolicy(),
      railHealthScore: 0.95,
    });
    for (const a of ["RECOVER_VOICE_HI", "RECOVER_WHATSAPP"]) {
      const r = out.ranked.find((x) => x.action === a);
      expect(r?.scheduledForMs).toBeNull();
    }
  });
});
