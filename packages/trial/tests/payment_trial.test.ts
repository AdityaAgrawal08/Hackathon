import { describe, it, expect, beforeEach } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "@arbiter/core/db";
import { MockRazorpayProvider } from "../src/provider.js";
import { SCENARIOS } from "../src/scenarios.js";
import { runTrial } from "../src/orchestrator.js";

const NOW = Date.UTC(2026, 2, 10, 12, 0, 0);

let client: Client;
let provider: MockRazorpayProvider;

beforeEach(async () => {
  // Fresh sandbox DB per test so scenarios don't idempotently short-circuit
  // across tests (a real idempotency feature, not what these assertions want).
  client = createClient({ url: ":memory:" });
  await runMigrations(client);
  provider = new MockRazorpayProvider();
});

describe("payment-trial sandbox", () => {
  it("runs all 20 production-like scenarios with no double charges and no surfaced bugs", async () => {
    for (const sc of SCENARIOS) {
      const rep = await runTrial(client, sc, provider, NOW);
      // Core invariant: a single idempotency key must settle at most once.
      expect(rep.final.doubleCharged, `${sc.id}: double charged`).toBe(false);
      expect(rep.final.ledgerDebits, `${sc.id}: debit count`).toBeLessThanOrEqual(1);
      // No debit on a failed/cancelled intent.
      if (rep.final.intentState === "FAILED" || rep.final.intentState === "CANCELLED") {
        expect(rep.final.ledgerDebits, `${sc.id}: debit on terminal-fail`).toBe(0);
      }
      // A succeeded intent must actually debit the balance once.
      if (rep.final.intentState === "SUCCEEDED") {
        expect(rep.final.ledgerDebits, `${sc.id}: missing debit`).toBe(1);
      }
      expect(rep.notes, `${sc.id}: surfaced a bug`).toEqual([]);
      expect(rep.auditRows, `${sc.id}: no audit row`).toBeGreaterThanOrEqual(1);
    }
  });

  it("multi-attempt scenarios are idempotent (one charge only)", async () => {
    const multi = SCENARIOS.filter((s) => s.pattern !== "single");
    for (const sc of multi) {
      const rep = await runTrial(client, sc, provider, NOW);
      expect(rep.isIdempotent, `${sc.id}: not idempotent`).toBe(true);
      expect(rep.final.ledgerDebits).toBe(1); // settled exactly once
    }
  });

  it("lost-response keeps the charge but shows the client UNKNOWN (no premature success)", async () => {
    const rep = await runTrial(client, SCENARIOS.find((s) => s.id === "success_lost_response")!, provider, NOW);
    expect(rep.final.intentState).toBe("SUCCEEDED");
    expect(rep.final.ledgerDebits).toBe(1);
    expect(rep.final.clientVisible).toBe("UNKNOWN");
    expect(rep.final.balancePaise).toBe(50_00_000 - 49_900);
  });

  it("uncertain outcomes are not prematurely terminated — initial attempt leaves UNKNOWN/EXECUTING, settled exactly once on reconcile", async () => {
    for (const id of ["no_internet", "gateway_timeout", "gateway_unavailable", "server_error", "client_disconnect", "retry_after_uncertain"]) {
      const rep = await runTrial(client, SCENARIOS.find((s) => s.id === id)!, provider, NOW);
      // The initial charge must NOT have settled/charged — it waits for reconcile.
      expect(rep.steps[0]!.result.intentState).toBe("UNKNOWN");
      expect(rep.final.intentState).toBe("SUCCEEDED"); // reconciled exactly once
      expect(rep.final.ledgerDebits).toBe(1); // settled once, never more
      expect(rep.final.proposalState).toBe("EXECUTED");
    }
  });

  it("user-facing message is always safe (no stack traces, no raw error codes)", async () => {
    for (const sc of SCENARIOS) {
      const rep = await runTrial(client, sc, provider, NOW);
      expect(rep.userMessage.length).toBeGreaterThan(0);
      expect(rep.userMessage).not.toMatch(/undefined|Error|stack|RZP_|SQL|trace/i);
    }
  });

  it("a notification is written for every client-visible outcome", async () => {
    for (const sc of SCENARIOS) {
      const rep = await runTrial(client, sc, provider, NOW);
      expect(rep.notifications.length, `${sc.id}: no notification`).toBeGreaterThanOrEqual(1);
      for (const n of rep.notifications) {
        expect(n.channel).toMatch(/^(WHATSAPP|SMS|VOICE|IN_APP|EMAIL)$/);
        expect(n.message.length).toBeGreaterThan(0);
      }
    }
  });

  it("concurrent same-key attempts settle exactly once", async () => {
    const rep = await runTrial(client, SCENARIOS.find((s) => s.id === "concurrent_attempts")!, provider, NOW);
    expect(rep.final.ledgerDebits).toBe(1);
    expect(rep.final.intentState).toBe("SUCCEEDED");
    expect(rep.isIdempotent).toBe(true);
  });
});
