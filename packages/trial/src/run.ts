/**
 * Trial CLI — runs every production-like payment scenario in a sandboxed,
 * in-memory database and prints a per-scenario report. No real network, no real
 * money. Output is the exact "what happened" table the brief asks for.
 *
 *   pnpm trial
 */
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "@arbiter/core/db";
import { MockRazorpayProvider } from "./provider.js";
import { SCENARIOS } from "./scenarios.js";
import { runTrial } from "./orchestrator.js";

const NOW = Date.UTC(2026, 2, 10, 12, 0, 0);

function pad(s: string | number, n: number): string {
  return String(s).padEnd(n).slice(0, n);
}

async function main() {
  const client: Client = createClient({ url: ":memory:" });
  await runMigrations(client);
  const provider = new MockRazorpayProvider();

  console.log("\n=== ARBITER Payment-Trial Sandbox (no real money / network) ===\n");
  console.log(
    pad("SCENARIO", 34) +
      pad("VISIBLE", 11) +
      pad("INTENT", 11) +
      pad("PROPOSAL", 11) +
      pad("DEBITS", 8) +
      pad("BAL(₹)", 10) +
      pad("IDEM", 6) +
      "RETRY",
  );
  console.log("-".repeat(110));

  let bugs = 0;
  const reports = [];
  for (const sc of SCENARIOS) {
    const rep = await runTrial(client, sc, provider, NOW);
    reports.push(rep);
    const bal = (rep.final.balancePaise / 100).toLocaleString("en-IN");
    console.log(
      pad(sc.title, 34) +
        pad(rep.final.clientVisible, 11) +
        pad(rep.final.intentState, 11) +
        pad(rep.final.proposalState, 11) +
        pad(rep.final.ledgerDebits, 8) +
        pad(bal, 10) +
        pad(rep.isIdempotent ? "yes" : "no", 6) +
        pad(rep.retryAllowed ? "yes" : "no", 6),
    );
    if (rep.notes.length > 0) {
      bugs += rep.notes.length;
      for (const n of rep.notes) console.log("   ⚠ " + n);
    }
  }

  console.log("-".repeat(110));
  console.log(`\nTotal scenarios: ${SCENARIOS.length}   Potential bugs surfaced: ${bugs}\n`);
  console.log("Per-scenario detail (provider response, backend decision, DB, message, notification):");
  for (const rep of reports) {
    console.log(`\n● ${rep.scenarioTitle}  [${rep.scenarioId}]`);
    console.log(`  failure: ${rep.failureClass}/${rep.failureCode}  action: ${rep.action}`);
    rep.steps.forEach((s) => {
      const pr = s.providerResponse
        ? `${s.providerResponse.status}(delivered=${s.providerResponse.delivered}, charge=${s.providerResponse.chargeId})`
        : "— (idempotent, no provider call)";
      console.log(`  - ${s.label}: provider=${pr}`);
      console.log(`      decision: ${s.backendDecision}`);
    });
    console.log(`  final intent=${rep.final.intentState} proposal=${rep.final.proposalState} debits=${rep.final.ledgerDebits} balance=₹${rep.final.balancePaise / 100}`);
    console.log(`  user message: ${rep.userMessage}`);
    rep.notifications.forEach((n) => console.log(`  notification[${n.channel}]: ${n.message}`));
    console.log(`  idempotent=${rep.isIdempotent} retryAllowed=${rep.retryAllowed} auditRows=${rep.auditRows}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
