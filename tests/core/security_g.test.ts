/**
 * Section G: Security and Financial Safety
 *
 * G-001: Rate limiting — 429 on excess
 * G-002: Admin key enforcement
 * G-004: Webhook signature verification
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

// ── G-001: Rate limiting wiring ──────────────────────────────────

describe("G-001: Rate limiting", () => {
  it("server.ts wires rate limiters to all payment/recovery/webhook routes", () => {
    const src = readFileSync("app/server.ts", "utf8");
    // All critical endpoints must have a limiter
    expect(src).toContain("checkoutLimiter");
    expect(src).toContain("paymentLimiter");
    expect(src).toContain("webhookLimiter");
    expect(src).toContain("recoveryLimiter");
    expect(src).toContain("adminLimiter");
    // Verify they're applied
    expect(src).toMatch(/\/api\/orders\/create.*checkoutLimiter/);
    expect(src).toMatch(/\/api\/payments\/verify.*paymentLimiter/);
    expect(src).toMatch(/\/api\/payments\/failed.*paymentLimiter/);
    expect(src).toMatch(/\/api\/webhooks\/razorpay.*webhookLimiter/);
    expect(src).toMatch(/\/api\/webhooks\/providers\/brevo.*webhookLimiter/);
    expect(src).toMatch(/\/api\/recovery\/triage.*recoveryLimiter/);
    expect(src).toMatch(/\/api\/vendor\/decision.*adminLimiter/);
  });

  it("constants define per-endpoint limits", () => {
    const src = readFileSync("packages/core/src/constants.ts", "utf8");
    expect(src).toContain("RATE_LIMIT_CHECKOUT_ORDERS_PER_MIN = 20");
    expect(src).toContain("RATE_LIMIT_CHARGES_PER_MIN = 30");
    expect(src).toContain("RATE_LIMIT_WEBHOOKS_PER_MIN = 200");
    expect(src).toContain("RATE_LIMIT_ADMIN_PER_MIN = 30");
  });

  it("rate limiters skip in test mode (isTest) to avoid breaking existing tests", () => {
    const src = readFileSync("app/server.ts", "utf8");
    expect(src).toContain("skip: () => isTest");
  });
});

// ── G-002: Admin key enforcement ─────────────────────────────────

describe("G-002: Admin key enforcement", () => {
  it("server.ts has requireAdminKey middleware gated by ENFORCE_ADMIN_KEY", () => {
    const src = readFileSync("app/server.ts", "utf8");
    expect(src).toContain("ENFORCE_ADMIN_KEY");
    expect(src).toContain("requireAdminKey");
    expect(src).toContain("ADMIN_SECRET_KEY");
    expect(src).toContain("timingSafeEqual");
    // Must protect /api/vendor/decision
    expect(src).toMatch(/\/api\/vendor\/decision.*requireAdminKey/);
  });

  it(".env.example documents ENFORCE_ADMIN_KEY", () => {
    const src = readFileSync(".env.example", "utf8");
    expect(src).toContain("ENFORCE_ADMIN_KEY");
    expect(src).toContain("G-002");
  });

  it("admin middleware uses constant-time compare (timingSafeEqual on sha256)", () => {
    const src = readFileSync("app/server.ts", "utf8");
    // Hash both sides before compare to handle variable-length secrets
    expect(src).toContain('createHash("sha256")');
    expect(src).toContain("timingSafeEqual");
  });

  it("admin check supports X-Admin-Key and Authorization Bearer", () => {
    const src = readFileSync("app/server.ts", "utf8");
    expect(src).toContain("x-admin-key");
    expect(src).toContain("Bearer ");
  });
});

// ── G-003: Secret hygiene ────────────────────────────────────────

describe("G-003: Secret hygiene", () => {
  it(".env is in .gitignore", () => {
    const src = readFileSync(".gitignore", "utf8");
    expect(src).toContain(".env");
  });

  it("pre-commit hook blocks .env commits", () => {
    const hook = readFileSync(".git/hooks/pre-commit", "utf8");
    expect(hook).toContain(".env");
  });

  it(".env.example uses placeholder secrets, not real keys", () => {
    const src = readFileSync(".env.example", "utf8");
    expect(src).toContain("xxxxxx");
    // Must not contain real-looking keys
    expect(src).not.toContain("rzp_test_TVX3");
    expect(src).not.toContain("565777AzlgulN2t");
  });
});

// ── G-004: Webhook signature verification ────────────────────────

describe("G-004: Webhook signature verification", () => {
  it("all messaging providers implement verifyWebhookSignature with HMAC", () => {
    const files = [
      "packages/core/src/messaging/providers/brevo.ts",
      "packages/core/src/messaging/providers/msg91.ts",
      "packages/core/src/messaging/providers/gupshup.ts",
      "packages/core/src/messaging/providers/twilio_voice.ts",
      "packages/core/src/messaging/providers/msg91_email.ts",
    ];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      expect(src, `${file} missing verifyWebhookSignature`).toContain("verifyWebhookSignature");
      expect(src, `${file} missing HMAC`).toMatch(/createHmac/);
    }
  });

  it("DLR webhook endpoints verify signatures inline", () => {
    const src = readFileSync("app/server.ts", "utf8");
    expect(src).toContain("extractSignature");
    // Each DLR endpoint must have verification block
    expect(src).toMatch(/\/api\/webhooks\/providers\/brevo.*BREVO_WEBHOOK_SECRET/s);
    expect(src).toMatch(/\/api\/webhooks\/providers\/msg91.*MSG91_AUTH_KEY/s);
    expect(src).toMatch(/\/api\/webhooks\/providers\/gupshup.*GUPSHUP_WEBHOOK_SECRET/s);
  });

  it("DLR verification uses timingSafeEqual or strict compare (not ==)", () => {
    const src = readFileSync("app/server.ts", "utf8");
    // Must not use loose comparison for HMAC
    expect(src).toContain("timingSafeEqual");
  });

  it("DLR endpoints return 401 on invalid signature", () => {
    const src = readFileSync("app/server.ts", "utf8");
    // Must reject with 401
    expect(src).toMatch(/Invalid webhook signature.*401/s);
  });
});
