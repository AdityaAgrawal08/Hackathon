/**
 * Trial orchestrator — runs a scenario end-to-end through the REAL core
 * execution path (executePaymentIntent / reconcileIntent) against a REAL
 * in-memory SQLite database, and produces a structured report covering every
 * field the brief requires: request state, simulated provider response,
 * backend decision, final payment state, DB result, user-facing message,
 * notification, retry allowance, and idempotency.
 *
 * Everything is sandboxed: the "provider" is MockRazorpayProvider (no network,
 * no money), and balances/charges live only in the trial database.
 */
import type { Client } from "@libsql/client";
import { isoUtc } from "@arbiter/shared";
import {
  executePaymentIntent,
  reconcileIntent,
  getBalance,
  type ChargeProvider,
  type PaymentIntentResult,
} from "@arbiter/core/executor";
import { PROVIDER_SCRIPT, deterministicChargeId } from "./provider.js";
import {
  userFacingMessage,
  channelForAction,
  type TrialClientVisible,
} from "./userMessage.js";
import type { Scenario } from "./scenarios.js";

export interface TrialStep {
  label: string;
  clientIdemKey: string;
  request: { proposalId: string; actionId: string; amountPaise: number };
  providerResponse: {
    status: string;
    delivered: boolean;
    chargeId: string;
    latencyMs: number;
    errorCode?: string;
  } | null;
  backendDecision: string;
  result: PaymentIntentResult;
}

export interface TrialReport {
  scenarioId: string;
  scenarioTitle: string;
  failureClass: string;
  failureCode: string;
  action: string;
  steps: TrialStep[];
  final: {
    clientVisible: TrialClientVisible;
    intentState: string;
    proposalState: string;
    actionOutcome: string | null;
    ledgerDebits: number;
    balancePaise: number;
    chargeId?: string;
    idempotent: boolean;
    doubleCharged: boolean;
    retryAllowed: boolean;
  };
  notifications: { channel: string; message: string; atUtc: string }[];
  auditRows: number;
  userMessage: string;
  retryAllowed: boolean;
  isIdempotent: boolean;
  notes: string[];
}

const TRIAL_TENANT = "demo";
const TRIAL_MODEL = "intent@1.0.0";
const TRIAL_START_BALANCE = 50_00_000; // ₹5,000 sandbox balance
const TRIAL_AMOUNT = 49_900; // ₹499 recovery amount
let notifSeq = 0;

export async function ensureTrialSeed(client: Client, customerId: string): Promise<void> {
  await client.execute({
    sql: `INSERT INTO tenants (id, name, created_at_utc) VALUES (?, 'Demo', ?)
          ON CONFLICT(id) DO NOTHING`,
    args: [TRIAL_TENANT, isoUtc(0)],
  });
  await client.execute({
    sql: `INSERT INTO model_versions (id, kind, weights_json, weights_sha256, dataset_sha256, feature_names_json, metrics_json, trained_at_utc, status) VALUES (?, 'logreg', '{}', '0', '0', '[]', '{}', ?, 'INCUMBENT')
          ON CONFLICT(id) DO NOTHING`,
    args: [TRIAL_MODEL, isoUtc(0)],
  });
  await client.execute({
    sql: `INSERT INTO customers (id, tenant_id, pseudo_name, phone_fake, email_fake, payday_pattern_json, channel_responsiveness, opted_out, prior_success_count, joined_at_utc)
          VALUES (?, ?, 'Trial', '+919000000000', 't@e.test', '{"25":4}', 0.7, 0, 5, ?)
          ON CONFLICT(id) DO NOTHING`,
    args: [customerId, TRIAL_TENANT, isoUtc(0)],
  });
  await client.execute({
    sql: `INSERT INTO account_balances (customer_id, balance_paise, updated_at_utc) VALUES (?, ?, ?)
          ON CONFLICT(customer_id) DO UPDATE SET balance_paise = excluded.balance_paise`,
    args: [customerId, TRIAL_START_BALANCE, isoUtc(0)],
  });
}

async function createEventAndProposal(
  client: Client,
  scenario: Scenario,
  nowMs: number,
  tag: string,
  customerId: string,
): Promise<{ eventId: string; proposalId: string }> {
  const eventId = `evt_${scenario.id}_${tag}`;
  const proposalId = `prop_${scenario.id}_${tag}`;
  await client.execute({
    sql: `INSERT INTO payment_events (id, tenant_id, customer_id, rzp_payment_id, subscription_id, amount_paise, failure_code, failure_class_hint, source, true_outcome_seed, occurred_at_utc, ingested_at_utc)
          VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, 'SEED', NULL, ?, ?)
          ON CONFLICT(id) DO NOTHING`,
    args: [eventId, TRIAL_TENANT, customerId, TRIAL_AMOUNT, scenario.failureCode, scenario.failureClass, isoUtc(nowMs), isoUtc(nowMs)],
  });
  await client.execute({
    sql: `INSERT INTO proposals (id, event_id, customer_id, model_version_id, policy_version, action_json, ev_paise, confidence, attributions_json, narrative, state, state_version, dedupe_key, created_at_utc, updated_at_utc)
          VALUES (?, ?, ?, ?, 'policy-v1', ?, ?, 0.5, '[]', NULL, 'APPROVED', 0, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING`,
    args: [
      proposalId,
      eventId,
      customerId,
      TRIAL_MODEL,
      JSON.stringify({ action: scenario.action, evPaise: TRIAL_AMOUNT, failureClass: scenario.failureClass }),
      TRIAL_AMOUNT,
      `${eventId}|${TRIAL_MODEL}|policy-v1`,
      isoUtc(nowMs),
      isoUtc(nowMs),
    ],
  });
  return { eventId, proposalId };
}

function providerResponseFor(scenario: Scenario, key: string) {
  const script = PROVIDER_SCRIPT[scenario.id]!;
  return {
    status: script.status,
    delivered: script.delivered,
    chargeId: deterministicChargeId(key),
    latencyMs: script.latencyMs,
    errorCode: script.errorCode,
  };
}

function decisionText(r: PaymentIntentResult): string {
  if (r.idempotent && !r.reExecuted) {
    return `Idempotent — returned the existing settlement (${r.intentState}); NO new provider call, NO new charge.`;
  }
  switch (r.intentState) {
    case "SUCCEEDED":
      return r.clientVisible === "UNKNOWN"
        ? "Provider charged but response lost → intent SUCCEEDED server-side; client shown UNKNOWN (await confirmation)."
        : "Recovery collected → intent SUCCEEDED; balance debited once.";
    case "FAILED":
      return `Recovery failed (${r.errorCode ?? "provider"}) → intent FAILED; no debit.`;
    case "CANCELLED":
      return "User cancelled → intent CANCELLED; no debit.";
    case "UNKNOWN":
      return "Uncertain outcome → intent UNKNOWN; proposal left EXECUTING for reconciliation (no premature terminal state).";
    default:
      return `Intent ${r.intentState}.`;
  }
}

function retryAllowedFor(visible: TrialClientVisible): boolean {
  if (visible === "FAILED") return true;
  return false; // SUCCEEDED/CANCELLED/UNKNOWN/PROCESSING/ALREADY_SUBMITTED => do not blind-retry
}

async function recordNotification(
  client: Client,
  customerId: string,
  visible: TrialClientVisible,
  channel: string,
  message: string,
  nowMs: number,
): Promise<void> {
  notifSeq += 1;
  await client.execute({
    sql: `INSERT INTO notifications (id, customer_id, channel, scenario, message, at_utc, delivered)
          VALUES (?, ?, ?, NULL, ?, ?, 1)`,
    args: [`notif_${customerId}_${notifSeq}`, customerId, channel, message, isoUtc(nowMs)],
  });
}

export async function runTrial(
  client: Client,
  scenario: Scenario,
  provider: ChargeProvider,
  nowMs: number,
): Promise<TrialReport> {
  const customerId = `cust_trial_${scenario.id}`;
  await ensureTrialSeed(client, customerId);
  const key = `trial_${scenario.id}`;
  const { eventId, proposalId } = await createEventAndProposal(client, scenario, nowMs, "run", customerId);

  const steps: TrialStep[] = [];
  const channel = channelForAction(scenario.action);

  const runOnce = async (label: string, makeProviderResp: boolean): Promise<PaymentIntentResult> => {
    const r = await executePaymentIntent(client, {
      clientIdemKey: key,
      proposalId,
      scenario: scenario.id,
      provider,
      nowMs,
    });
    steps.push({
      label,
      clientIdemKey: key,
      request: { proposalId, actionId: scenario.action, amountPaise: TRIAL_AMOUNT },
      providerResponse: makeProviderResp ? providerResponseFor(scenario, key) : null,
      backendDecision: decisionText(r),
      result: r,
    });
    if (r.clientVisible !== "PROCESSING") {
      await recordNotification(client, customerId, r.clientVisible, channel, userFacingMessage({ visible: r.clientVisible, amountPaise: TRIAL_AMOUNT, errorCode: providerResponseFor(scenario, key).errorCode, failureClass: scenario.failureClass }), nowMs);
    }
    return r;
  };

  const initial = await runOnce("initial charge", true);

  if (scenario.pattern === "retry") {
    const n = scenario.retryCount ?? 1;
    for (let i = 0; i < n; i++) {
      await runOnce(`retry #${i + 1} (same idempotency key)`, false);
    }
  } else if (scenario.pattern === "lostResponse") {
    await runOnce("retry after lost response (same key)", false);
  } else if (scenario.pattern === "uncertainReconcile") {
    await runOnce("retry after uncertain (same key)", false);
    const rec = await reconcileIntent(client, key, "SUCCEEDED", nowMs + 1);
    if (rec) {
      steps.push({
        label: "reconcile (provider webhook confirms success)",
        clientIdemKey: key,
        request: { proposalId, actionId: scenario.action, amountPaise: TRIAL_AMOUNT },
        providerResponse: providerResponseFor(scenario, key),
        backendDecision: "Provider webhook confirms success → settled exactly once (idempotent debit).",
        result: rec,
      });
      await recordNotification(client, customerId, rec.clientVisible, channel, userFacingMessage({ visible: rec.clientVisible, amountPaise: TRIAL_AMOUNT, failureClass: scenario.failureClass }), nowMs + 1);
    }
  } else if (scenario.pattern === "concurrent") {
    const [a, b] = await Promise.all([
      executePaymentIntent(client, { clientIdemKey: key, proposalId, scenario: scenario.id, provider, nowMs }),
      executePaymentIntent(client, { clientIdemKey: key, proposalId, scenario: scenario.id, provider, nowMs }),
    ]);
    steps.push({
      label: "concurrent attempt A",
      clientIdemKey: key,
      request: { proposalId, actionId: scenario.action, amountPaise: TRIAL_AMOUNT },
      providerResponse: providerResponseFor(scenario, key),
      backendDecision: decisionText(a),
      result: a,
    });
    steps.push({
      label: "concurrent attempt B",
      clientIdemKey: key,
      request: { proposalId, actionId: scenario.action, amountPaise: TRIAL_AMOUNT },
      providerResponse: null,
      backendDecision: decisionText(b),
      result: b,
    });
    if (a.clientVisible !== "PROCESSING") {
      await recordNotification(client, customerId, a.clientVisible, channel, userFacingMessage({ visible: a.clientVisible, amountPaise: TRIAL_AMOUNT, errorCode: providerResponseFor(scenario, key).errorCode }), nowMs);
    }
  }

  // ── gather final DB state ──
  const intent = await client.execute({ sql: `SELECT status FROM payment_intents WHERE client_idem_key = ?`, args: [key] });
  const prop = await client.execute({ sql: `SELECT state FROM proposals WHERE id = ?`, args: [proposalId] });
  const act = await client.execute({ sql: `SELECT outcome FROM actions WHERE proposal_id = ? ORDER BY executed_at_utc DESC LIMIT 1`, args: [proposalId] });
  const debits = await client.execute({ sql: `SELECT COUNT(*) AS n FROM ledger_entries WHERE idem_key = ? AND kind = 'DEBIT'`, args: [key] });
  const balance = await getBalance(client, customerId);
  const notifs = await client.execute({ sql: `SELECT channel, message, at_utc FROM notifications WHERE customer_id = ? ORDER BY at_utc ASC`, args: [customerId] });
  const audit = await client.execute({ sql: `SELECT COUNT(*) AS n FROM audit_log WHERE event_id = ?`, args: [eventId] });

  const intentState = String((intent.rows[0] as unknown as { status: string }).status);
  const proposalState = String((prop.rows[0] as unknown as { state: string }).state);
  const actionOutcome = act.rows.length > 0 ? String((act.rows[0] as unknown as { outcome: string }).outcome) : null;
  const ledgerDebits = Number((debits.rows[0] as unknown as { n: number }).n);
  const doubleCharged = ledgerDebits > 1;
  const lastVisible = steps[steps.length - 1]!.result.clientVisible;
  const retryAllowed = retryAllowedFor(lastVisible as TrialClientVisible);
  const isIdempotent =
    scenario.pattern === "single"
      ? false
      : ledgerDebits <= 1; // multi-attempt scenarios must settle at most once

  const userMessage = userFacingMessage({
    visible: lastVisible as TrialClientVisible,
    amountPaise: TRIAL_AMOUNT,
    errorCode: providerResponseFor(scenario, key).errorCode,
    failureClass: scenario.failureClass,
  });

  const notes: string[] = [];
  if (doubleCharged) notes.push("BUG: balance debited more than once for the same idempotency key (double charge).");
  if ((intentState === "FAILED" || intentState === "CANCELLED") && ledgerDebits > 0) notes.push("BUG: a debit occurred on a failed/cancelled intent.");
  if (intentState === "SUCCEEDED" && ledgerDebits === 0) notes.push("BUG: intent SUCCEEDED but no ledger debit (money not actually collected).");
  if (lastVisible === "UNKNOWN" && intentState === "UNKNOWN" && proposalState === "EXECUTED")
    notes.push("Potential bug: proposal marked terminal EXECUTED while both client and server state are UNKNOWN.");

  return {
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    failureClass: scenario.failureClass,
    failureCode: scenario.failureCode,
    action: scenario.action,
    steps,
    final: {
      clientVisible: lastVisible as TrialClientVisible,
      intentState,
      proposalState,
      actionOutcome,
      ledgerDebits,
      balancePaise: balance,
      chargeId: initial.chargeId,
      idempotent: isIdempotent,
      doubleCharged,
      retryAllowed,
    },
    notifications: notifs.rows.map((r) => r as unknown as { channel: string; message: string; at_utc: string }).map((n) => ({ channel: n.channel, message: n.message, atUtc: n.at_utc })),
    auditRows: Number((audit.rows[0] as unknown as { n: number }).n),
    userMessage,
    retryAllowed,
    isIdempotent,
    notes,
  };
}
