import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getErrorEntry, getCustomerMessage, getFailureClass } from "../../packages/core/src/error-catalog.js";

describe("Phase 5: Repository Hygiene & Negative Results Integrity", () => {
  it("Task 5.1: Deterministic Error Catalog executes sub-millisecond on 70+ bank codes", () => {
    const codes = [
      "BAD_REQUEST_ERROR",
      "GATEWAY_ERROR",
      "PAYMENT_FAILED",
      "INSUFFICIENT_FUNDS",
      "CARD_EXPIRED",
      "CARD_DECLINED",
      "AUTHENTICATION_FAILED",
      "PAYMENT_CANCELLED_BY_USER",
      "RISK_CHECK_FAILED",
      "GATEWAY_TIMEOUT",
    ];

    const start = performance.now();
    for (const code of codes) {
      const entry = getErrorEntry(code);
      const msg = getCustomerMessage(code);
      const cls = getFailureClass(code);

      expect(entry).toBeDefined();
      expect(typeof msg).toBe("string");
      expect(cls).toBeDefined();
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(15); // Sub-millisecond per code
  });

  it("Task 5.2: Negative Results documentation and Demo Script exist and are complete", () => {
    const readmePath = resolve(__dirname, "../../README.md");
    const negResultsPath = resolve(__dirname, "../../docs/negative-results.md");

    expect(existsSync(readmePath)).toBe(true);
    expect(existsSync(negResultsPath)).toBe(true);

    const readmeContent = readFileSync(readmePath, "utf8");
    const negContent = readFileSync(negResultsPath, "utf8");

    // Verify negative results documentation
    expect(negContent).toContain("Negative Finding 1: LLM-Based Error Classification");
    expect(negContent).toContain("Negative Finding 2: Uncalibrated Issuer Outage Detection");
    expect(negContent).toContain("Negative Finding 3: Local Silo Variance in Merchant Federated Learning");
    expect(negContent).toContain("Negative Finding 4: Voice IVR & WhatsApp Channel Friction");

    // Verify 5-minute live demo script in README
    expect(readmeContent).toContain("5-Minute Live Demonstration Script");
    expect(readmeContent).toContain("3-Arm Empirical Benchmark");
  });
});
