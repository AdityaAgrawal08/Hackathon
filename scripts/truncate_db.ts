try {
  process.loadEnvFile();
} catch (e) {
  // ignore if not present or already loaded
}
import { openDb } from "../packages/core/src/db/index.js";

async function main() {
  console.log("Connecting to DB:", process.env.ARBITER_DB_PATH);
  const { client } = await openDb();

  const tables = [
    "scheduled_outreach",
    "live_payment_events",
    "customer_profiles",
    "audit_log",
    "customer_purchase_ledger",
    "webhook_dedupe",
    "checkout_sessions",
    "payment_attempts",
    "provider_payments",
    "local_settlements",
    "promise_to_pay",
    "payment_events",
    "proposals",
    "actions",
    "approval_records",
  ];

  console.log("\n--- Row Counts Before Clean Slate ---");
  for (const table of tables) {
    try {
      const res = await client.execute(`SELECT COUNT(*) as cnt FROM ${table}`);
      console.log(`[BEFORE] ${table}: ${res.rows[0]?.cnt ?? 0}`);
    } catch (e: any) {
      console.log(`[BEFORE] ${table}: not found or error (${e.message})`);
    }
  }

  console.log("\n--- Executing Truncation (DELETE FROM) ---");
  for (const table of tables) {
    try {
      await client.execute(`DELETE FROM ${table}`);
      console.log(`[CLEARED] ${table}`);
    } catch (e: any) {
      console.log(`[SKIP] ${table}: ${e.message}`);
    }
  }

  console.log("\n--- Row Counts After Clean Slate ---");
  for (const table of tables) {
    try {
      const res = await client.execute(`SELECT COUNT(*) as cnt FROM ${table}`);
      console.log(`[AFTER] ${table}: ${res.rows[0]?.cnt ?? 0}`);
    } catch (e: any) {
      // ignore
    }
  }

  console.log("\nDatabase clean slate completed successfully!");
}

main().catch((err) => {
  console.error("Fatal error during database truncation:", err);
  process.exit(1);
});
