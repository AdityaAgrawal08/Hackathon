/**
 * ARBITER Interactive Payment Server & Merchant Console.
 *
 * Exposes:
 *  - GET  /                     -> Desktop Checkout with Dynamic QR
 *  - POST /api/orders           -> Creates Checkout Session + QR
 *  - GET  /pay/:token           -> Smartphone Mobile Checkout Page
 *  - POST /api/payments/charge  -> Dispatches payment attempt with idempotency guard
 *  - POST /api/webhooks/razorpay-> Fast async webhook ingestion (<100ms ACK)
 *  - GET  /api/status/:token    -> Live SSE payment status stream with reconnection
 *  - GET  /dashboard            -> Merchant Reconciliation & Audit Console
 *  - GET  /api/admin/intents    -> Admin data for console
 *  - POST /api/admin/reconcile  -> Manual sweep trigger
 */
import express, { type Request, type Response, type NextFunction } from "express";
import { rateLimit } from "express-rate-limit";
import qrcode from "qrcode";
import { createClient, type Client } from "@libsql/client";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Load environment variables from .env file natively if it exists
if (existsSync(".env")) {
  try {
    process.loadEnvFile();
  } catch (err) {
    console.warn("Failed to load .env file:", err);
  }
}

import { isoUtc, formatINR, paise } from "../packages/shared/src/index.js";
import {
  RazorpayLiveGateway,
  LocalDeterministicGateway,
  type PaymentGateway,
  type PaymentMode,
  userFacingMessage,
} from "../packages/trial/src/index.js";
import {
  runMigrations,
  reconcilePaymentIntent,
  sweepStuckIntents,
  ingestDomainWebhook,
  computeCanonicalPayloadHash,
  CHECKOUT_SESSION_TTL_MS,
  DEFAULT_LOCAL_ADMIN_SECRET,
  DEFAULT_LOCAL_WEBHOOK_SECRET,
  RATE_LIMIT_CHECKOUT_ORDERS_PER_MIN,
  RATE_LIMIT_CHARGES_PER_MIN,
  RATE_LIMIT_WEBHOOKS_PER_MIN,
  RATE_LIMIT_ADMIN_PER_MIN,
  MAX_SSE_CONNECTIONS_PER_TOKEN,
  generateTwilioHandoffTwiML,
} from "../packages/core/src/index.js";


import {
  simulateFailureTriage,
  approveProposal,
  completeRecovery,
  initiateRecoveryOrder,
  recordPromiseToPay,
  runBatchBenchmark,
  recoverySessions,
  liveMetrics,
  PRESETS,
} from "./recovery.js";



const __dirname = dirname(fileURLToPath(import.meta.url));

export const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

const HOST = process.env.HOST || "0.0.0.0";
const DEFAULT_MODE: PaymentMode = (process.env.PAYMENT_MODE as PaymentMode) || "LOCAL_SANDBOX";

const ADMIN_SECRET = process.env.ADMIN_SECRET_KEY || DEFAULT_LOCAL_ADMIN_SECRET;
const WEBHOOK_SECRET = process.env.RZP_WEBHOOK_SECRET || (DEFAULT_MODE === "REAL_SANDBOX" ? "" : DEFAULT_LOCAL_WEBHOOK_SECRET);

if (DEFAULT_MODE === "REAL_SANDBOX" && !WEBHOOK_SECRET) {
  console.warn("WARNING: RZP_WEBHOOK_SECRET is not configured for REAL_SANDBOX mode.");
}

// ── Database Initialization ─────────────────────────────────────────
const dbPath = process.env.ARBITER_DB_PATH || "data/arbiter.sqlite";
const dbUrl = dbPath.startsWith("file:") ? dbPath : `file:${resolve(dbPath)}`;
export const dbClient: Client = createClient({ url: dbUrl });

// ── Gateways ────────────────────────────────────────────────────────
export const localGateway = new LocalDeterministicGateway(dbClient, WEBHOOK_SECRET || DEFAULT_LOCAL_WEBHOOK_SECRET);
let liveGateway: RazorpayLiveGateway | null = null;
try {
  liveGateway = new RazorpayLiveGateway({ webhookSecret: WEBHOOK_SECRET });
} catch {
  // Live gateway missing keys; LOCAL_SANDBOX will remain active
}

export function getGateway(mode: PaymentMode): PaymentGateway {
  if (mode === "REAL_SANDBOX") {
    if (!liveGateway) {
      throw new Error("Razorpay Test Mode credentials not configured. Please set RZP_TEST_KEY_ID and RZP_TEST_KEY_SECRET.");
    }
    return liveGateway;
  }
  return localGateway;
}

// ── Rate Limiters ───────────────────────────────────────────────────
const orderLimiter = rateLimit({ windowMs: 60 * 1000, limit: RATE_LIMIT_CHECKOUT_ORDERS_PER_MIN, standardHeaders: true });
const chargeLimiter = rateLimit({ windowMs: 60 * 1000, limit: RATE_LIMIT_CHARGES_PER_MIN, standardHeaders: true });
const webhookLimiter = rateLimit({ windowMs: 60 * 1000, limit: RATE_LIMIT_WEBHOOKS_PER_MIN, standardHeaders: true });
const adminLimiter = rateLimit({ windowMs: 60 * 1000, limit: RATE_LIMIT_ADMIN_PER_MIN, standardHeaders: true });

// ── Middleware ───────────────────────────────────────────────────────
// Raw body for webhooks
app.use("/api/webhooks/razorpay", express.raw({ type: "*/*" }));
// JSON parser for other endpoints
app.use(express.json());

// Host Header Validation helper (protects QR URLs from Host header injection)
function getSanitizedHost(req: Request): string {
  const host = req.get("host") || `localhost:${PORT}`;
  const validHostRegex = /^[a-zA-Z0-9.:_-]+$/;
  if (!validHostRegex.test(host)) {
    return `localhost:${PORT}`;
  }
  return host;
}

// Admin Auth Middleware
function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = (req.headers["x-admin-key"] as string) || (req.query.admin_key as string);
  if (!authHeader) {
    // In local dev without key supplied, check if admin key is explicitly requested
    if (process.env.NODE_ENV === "production" || process.env.ENFORCE_ADMIN_KEY === "true") {
      return res.status(401).json({ error: "UNAUTHORIZED_ADMIN_ACCESS" });
    }
    return next();
  }
  const keyBuf = Buffer.from(authHeader, "utf-8");
  const secretBuf = Buffer.from(ADMIN_SECRET, "utf-8");
  if (keyBuf.length !== secretBuf.length || !timingSafeEqual(keyBuf, secretBuf)) {
    return res.status(401).json({ error: "UNAUTHORIZED_ADMIN_ACCESS" });
  }
  next();
}

// ── SSE Live Status Stream Manager ──────────────────────────────────
interface SSEClient {
  res: Response;
  token: string;
  connectedAt: number;
}
const sseClients = new Map<string, Set<SSEClient>>();

function broadcastStatus(token: string, state: Record<string, unknown>) {
  const clients = sseClients.get(token);
  if (!clients) return;
  const msg = `data: ${JSON.stringify(state)}\n\n`;
  for (const c of clients) {
    try {
      c.res.write(msg);
    } catch {}
  }
}

// ── HTML Views ──────────────────────────────────────────────────────
const checkoutHtml = readFileSync(resolve(__dirname, "views/checkout.html"), "utf8");
const mobilePayHtml = readFileSync(resolve(__dirname, "views/mobile_pay.html"), "utf8");
const dashboardHtml = readFileSync(resolve(__dirname, "views/dashboard.html"), "utf8");
const recoverHtml = readFileSync(resolve(__dirname, "views/recover.html"), "utf8");

// ── Routes ──────────────────────────────────────────────────────────

// 1. Merchant Recovery Command Center UI (Default Home)
app.get(["/", "/dashboard"], (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(dashboardHtml);
});

// 2. Customer 1-Click Recovery Portal (Task 3.1 & 3.3)
app.get(["/recover", "/pay/:token"], (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(recoverHtml);
});

// Standalone Checkout UI (for test/manual checkout)
app.get("/checkout", (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(checkoutHtml);
});

// ── Recovery Engine API Endpoints ────────────────────────────────────

// A. Simulate failure ingestion and execute real-time triage
app.post("/api/recovery/triage", async (req, res) => {
  try {
    const { preset = "SALARY_DELAY" } = req.body;
    const hostHeader = getSanitizedHost(req);
    const proto = req.protocol === "https" || req.get("x-forwarded-proto") === "https" ? "https" : "http";
    const baseUrl = `${proto}://${hostHeader}`;
    const session = await simulateFailureTriage(preset, baseUrl, dbClient);
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// B. Initiate dedicated recovery order & dynamic QR (Task 3.2)
app.post("/api/recovery/initiate", async (req, res) => {
  try {
    const { proposalId, token, preferredMethod = "upi" } = req.body || {};
    const order = await initiateRecoveryOrder(proposalId || token, preferredMethod, dbClient);
    if (!order) {
      return res.status(404).json({ error: "NO_ACTIVE_RECOVERY_SESSION" });
    }
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// C. Promise-to-Pay Salary Day Commitment (Task 3.5)
app.post("/api/recovery/promise-to-pay", async (req, res) => {
  try {
    const { proposalId, promisedDay = 28 } = req.body || {};
    const result = await recordPromiseToPay(proposalId, promisedDay, dbClient);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// D. Approve proposal in merchant queue
app.post("/api/recovery/approve", async (req, res) => {
  try {
    const { proposalId } = req.body;
    const ok = await approveProposal(proposalId, dbClient);
    res.json({ success: ok, proposalId });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// E. Complete customer recovery payment
app.post("/api/recovery/complete", async (req, res) => {
  try {
    const { proposalId } = req.body;
    const ok = await completeRecovery(proposalId, dbClient);
    res.json({ success: ok, proposalId });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});


// F. Run 100-event Monte Carlo Batch Benchmark (The Bar)
app.get("/api/recovery/batch-proof", (_req, res) => {

  try {
    const result = runBatchBenchmark();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// E. Get current recovery state
app.get("/api/recovery/state", (_req, res) => {
  res.json({
    sessions: Array.from(recoverySessions.values()).reverse(),
    metrics: {
      ...liveMetrics,
      totalAtRiskFormatted: formatINR(paise(liveMetrics.totalAtRiskPaise)),
      totalRecoveredFormatted: formatINR(paise(liveMetrics.totalRecoveredPaise)),
      recoveryRate:
        liveMetrics.totalAtRiskPaise > 0
          ? ((liveMetrics.totalRecoveredPaise / liveMetrics.totalAtRiskPaise) * 100).toFixed(1) + "%"
          : "0.0%",
    },
    presets: PRESETS,
  });
});

// ── Provider DLR & IVR Webhook Endpoints (Task 2.8) ──────────────────

// 1. Brevo Email DLR Webhook
app.post("/api/webhooks/providers/brevo", async (req, res) => {
  try {
    const event = req.body;
    if (dbClient) {
      await dbClient.execute({
        sql: `INSERT INTO audit_log (ts_utc, tenant_id, event_id, actor, entry_type, payload_json)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [
          isoUtc(Date.now()),
          "demo",
          String(event.messageId || event["message-id"] || `brevo_evt_${Date.now()}`),
          "PIPELINE",
          "OUTCOME",
          JSON.stringify({ modelVersion: "logreg@1.0.0", policyVersion: "policy-v1", provider: "brevo", event: event.event, email: event.email, timestamp: event.date }),
        ],
      });
    }
    res.json({ received: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// 2. MSG91 SMS DLR Webhook
app.post("/api/webhooks/providers/msg91", async (req, res) => {
  try {
    const event = req.body;
    if (dbClient) {
      await dbClient.execute({
        sql: `INSERT INTO audit_log (ts_utc, tenant_id, event_id, actor, entry_type, payload_json)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [
          isoUtc(Date.now()),
          "demo",
          String(event.requestId || `msg91_evt_${Date.now()}`),
          "PIPELINE",
          "OUTCOME",
          JSON.stringify({ modelVersion: "logreg@1.0.0", policyVersion: "policy-v1", provider: "msg91", status: event.status, mobile: event.mobile }),
        ],
      });
    }
    res.json({ received: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// 3. Gupshup WhatsApp DLR Webhook
app.post("/api/webhooks/providers/gupshup", async (req, res) => {
  try {
    const event = req.body;
    if (dbClient) {
      await dbClient.execute({
        sql: `INSERT INTO audit_log (ts_utc, tenant_id, event_id, actor, entry_type, payload_json)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [
          isoUtc(Date.now()),
          "demo",
          String(event.payload?.id || `gupshup_evt_${Date.now()}`),
          "PIPELINE",
          "OUTCOME",
          JSON.stringify({ modelVersion: "logreg@1.0.0", policyVersion: "policy-v1", provider: "gupshup", type: event.type, payload: event.payload }),
        ],
      });
    }
    res.json({ received: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// 4. Twilio IVR Keypad Gather Webhook (Press 1 Handoff)
app.post("/api/webhooks/twilio/gather", async (req, res) => {
  try {
    const { Digits } = req.body;
    const proposalId = String(req.query.proposalId || "");
    const session = recoverySessions.get(proposalId);

    // If user pressed "1", complete handoff to instant WhatsApp payment link
    if (Digits === "1" || Digits === 1) {
      if (dbClient) {
        await dbClient.execute({
          sql: `INSERT INTO audit_log (ts_utc, tenant_id, event_id, actor, entry_type, payload_json)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [
            isoUtc(Date.now()),
            "demo",
            proposalId || `twilio_gather_${Date.now()}`,
            "CUSTOMER",
            "ACTION",
            JSON.stringify({ modelVersion: "logreg@1.0.0", policyVersion: "policy-v1", action: "PRESS_1_GATHER_HANDOFF", channel: "WHATSAPP", customer: session?.customerName }),
          ],
        });
      }
      const isHindi = session ? session.messages.voiceHi !== null : true;
      const handoffXml = generateTwilioHandoffTwiML(isHindi);
      res.setHeader("Content-Type", "text/xml");
      res.send(handoffXml);
      return;
    }

    // Default hangup response
    res.setHeader("Content-Type", "text/xml");
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  } catch (err) {
    res.status(500).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  }
});




// 2. Order & Checkout Session Creation
app.post("/api/orders", orderLimiter, async (req, res) => {
  try {
    const { amountPaise = 49900, paymentMode = DEFAULT_MODE, tenantId = "demo" } = req.body;
    const gateway = getGateway(paymentMode);
    const nowMs = Date.now();
    const nowIso = isoUtc(nowMs);
    const expiresIso = isoUtc(nowMs + CHECKOUT_SESSION_TTL_MS);

    // Create Order with Gateway
    const order = await gateway.createOrder({
      tenantId,
      amountPaise,
      receipt: `rcpt_${nowMs}`,
    });

    // Create Opaque Token for Checkout Session
    const token = randomBytes(24).toString("base64url");

    // Persist Checkout Session in SQLite
    await dbClient.execute({
      sql: `INSERT INTO checkout_sessions
              (token, tenant_id, order_id, amount_paise, currency, payment_mode, expires_at_utc, created_at_utc)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [token, tenantId, order.id, amountPaise, "INR", paymentMode, expiresIso, nowIso],
    });

    // Generate Mobile Checkout URL & Scannable QR Code
    const hostHeader = getSanitizedHost(req);
    const proto = req.protocol === "https" || req.get("x-forwarded-proto") === "https" ? "https" : "http";
    const mobileUrl = `${proto}://${hostHeader}/pay/${token}`;
    const qrCodeDataUrl = await qrcode.toDataURL(mobileUrl, { width: 300, margin: 2 });

    res.json({
      token,
      orderId: order.id,
      amountPaise,
      paymentMode,
      mobileUrl,
      qrCodeDataUrl,
      expiresAtUtc: expiresIso,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// 3. Mobile Payment Checkout Page
app.get("/pay/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const r = await dbClient.execute({
      sql: `SELECT * FROM checkout_sessions WHERE token = ?`,
      args: [token],
    });

    if (r.rows.length === 0) {
      // Check if token belongs to an active recovery session
      const recoverySession = Array.from(recoverySessions.values()).find(
        (s) => s.recoveryToken === token || s.id === token,
      );
      if (recoverySession) {
        const formattedAmount = (recoverySession.amountPaise / 100).toFixed(2);
        const rendered = mobilePayHtml
          .replace(/{{SESSION_TOKEN}}/g, recoverySession.recoveryToken)
          .replace(/{{TOKEN}}/g, recoverySession.recoveryToken)
          .replace(/{{ORDER_ID}}/g, `order_rec_${recoverySession.id}`)
          .replace(/{{AMOUNT_PAISE}}/g, String(recoverySession.amountPaise))
          .replace(/{{AMOUNT_FORMATTED}}/g, formattedAmount)
          .replace(/{{PAYMENT_MODE}}/g, "RECOVERY_PORTAL")
          .replace(/{{MODE_BADGE_CLASS}}/g, "badge-real")
          .replace(/{{RZP_KEY_ID}}/g, process.env.RZP_KEY_ID || "rzp_test_demo")
          .replace(/{{KEY_ID}}/g, process.env.RZP_KEY_ID || "rzp_test_demo");
        res.setHeader("Content-Type", "text/html");
        return res.send(rendered);
      }
      return res.status(404).send("<h3>Checkout Session Not Found</h3>");
    }

    const session = r.rows[0] as unknown as {
      token: string;
      order_id: string;
      amount_paise: number;
      payment_mode: PaymentMode;
      expires_at_utc: string;
      revoked_at_utc?: string;
    };

    if (session.revoked_at_utc) {
      return res.status(410).send("<h3>Checkout Session Already Completed</h3>");
    }

    if (Date.parse(session.expires_at_utc) < Date.now()) {
      return res.status(401).send("<h3>Checkout Session Expired</h3>");
    }

    const formattedAmount = (session.amount_paise / 100).toFixed(2);
    const badgeClass = session.payment_mode === "REAL_SANDBOX" ? "badge-real" : "badge-local";

    const rendered = mobilePayHtml
      .replace(/{{SESSION_TOKEN}}/g, session.token)
      .replace(/{{TOKEN}}/g, session.token)
      .replace(/{{ORDER_ID}}/g, session.order_id)
      .replace(/{{AMOUNT_PAISE}}/g, String(session.amount_paise))
      .replace(/{{AMOUNT_FORMATTED}}/g, formattedAmount)
      .replace(/{{PAYMENT_MODE}}/g, session.payment_mode)
      .replace(/{{MODE_BADGE_CLASS}}/g, badgeClass)
      .replace(/{{RZP_KEY_ID}}/g, process.env.RZP_TEST_KEY_ID || process.env.RZP_KEY_ID || "rzp_test_demo")
      .replace(/{{KEY_ID}}/g, process.env.RZP_TEST_KEY_ID || process.env.RZP_KEY_ID || "rzp_test_demo");

    res.setHeader("Content-Type", "text/html");
    res.send(rendered);
  } catch (err) {
    res.status(500).send("Server Error: " + (err as Error).message);
  }
});


// 4. Payment Execution & Charge Endpoint
app.post("/api/payments/charge", chargeLimiter, async (req, res) => {
  try {
    const { token, clientIdemKey, scenario, instrument } = req.body;
    if (!token || !clientIdemKey) {
      return res.status(400).json({ error: "Missing token or clientIdemKey" });
    }

    // 1. Verify Checkout Session
    const sessRes = await dbClient.execute({
      sql: `SELECT * FROM checkout_sessions WHERE token = ?`,
      args: [token],
    });
    if (sessRes.rows.length === 0) {
      return res.status(404).json({ error: "INVALID_CHECKOUT_TOKEN" });
    }
    const session = sessRes.rows[0] as unknown as {
      token: string;
      tenant_id: string;
      order_id: string;
      amount_paise: number;
      payment_mode: PaymentMode;
      expires_at_utc: string;
      revoked_at_utc?: string;
    };

    if (Date.parse(session.expires_at_utc) < Date.now()) {
      return res.status(401).json({ error: "TOKEN_EXPIRED" });
    }

    // 2. Deterministic Persisted Idempotency Verification (Canonical JSON key order)
    const payloadHash = computeCanonicalPayloadHash({
      amountPaise: session.amount_paise,
      scenario: scenario || "LOCAL_SUCCESS",
      token,
    });

    const attemptRes = await dbClient.execute({
      sql: `SELECT * FROM payment_attempts WHERE tenant_id = ? AND client_idem_key = ?`,
      args: [session.tenant_id, clientIdemKey],
    });

    if (attemptRes.rows.length > 0) {
      const prior = attemptRes.rows[0] as unknown as {
        payload_hash: string;
        payment_intent_id: string;
        status: string;
      };
      if (prior.payload_hash !== payloadHash) {
        return res.status(409).json({ error: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
      }
      // Return cached / current intent status
      const piRes = await dbClient.execute({
        sql: `SELECT * FROM payment_intents WHERE id = ?`,
        args: [prior.payment_intent_id],
      });
      const pi = piRes.rows[0] as unknown as { status: string; client_visible: string };
      return res.status(200).json({
        idempotent: true,
        knowledgeStatus: pi.status === "SUCCEEDED" ? "RESOLVED_SUCCESS" : pi.status === "FAILED" ? "RESOLVED_FAILED" : "UNRESOLVED_UNKNOWN",
        userMessage: userFacingMessage({ visible: pi.client_visible as any, amountPaise: session.amount_paise }),
      });
    }

    // 3. Create Intent & Attempt Record
    const intentId = `pi_${clientIdemKey.slice(0, 16)}`;
    const attemptId = `att_${Date.now()}_${randomBytes(4).toString("hex")}`;
    const nowMs = Date.now();
    const nowIso = isoUtc(nowMs);

    const proposalId = `prop_${intentId}`;

    await dbClient.batch(
      [
        {
          sql: `INSERT INTO payment_intents
                  (id, client_idem_key, proposal_id, customer_id, tenant_id, order_id, checkout_token, amount_paise, status, client_visible, scenario, created_at_utc)
                VALUES (?, ?, ?, 'cust_demo', ?, ?, ?, ?, 'PROCESSING', 'PROCESSING', ?, ?)
                ON CONFLICT(id) DO NOTHING`,
          args: [intentId, clientIdemKey, proposalId, session.tenant_id, session.order_id, token, session.amount_paise, scenario, nowIso],
        },

        {
          sql: `INSERT INTO payment_attempts
                  (id, payment_intent_id, tenant_id, client_idem_key, payload_hash, attempt_number, status, scenario, started_at_utc)
                VALUES (?, ?, ?, ?, ?, 1, 'IN_FLIGHT', ?, ?)`,
          args: [attemptId, intentId, session.tenant_id, clientIdemKey, payloadHash, scenario, nowIso],
        },
      ],
      "write",
    );

    // 4. Dispatch to Gateway
    const gateway = getGateway(session.payment_mode);
    const chargeResult = await gateway.charge({
      tenantId: session.tenant_id,
      orderId: session.order_id,
      clientIdemKey,
      amountPaise: session.amount_paise,
      scenario,
      instrument,
    });

    // 5. Commit Outcome & Project State
    if (chargeResult.status === "succeeded") {
      await dbClient.batch(
        [
          {
            sql: `INSERT INTO local_settlements
                    (id, payment_intent_id, idem_key, provider_payment_id, amount_paise, currency, settled_at_utc)
                  VALUES (?, ?, ?, ?, ?, 'INR', ?)
                  ON CONFLICT(payment_intent_id) DO NOTHING`,
            args: [`set_${intentId}`, intentId, clientIdemKey, chargeResult.providerPaymentId, session.amount_paise, nowIso],
          },
          {
            sql: `UPDATE payment_intents SET status = 'SUCCEEDED', client_visible = 'SUCCEEDED', resolved_at_utc = ? WHERE id = ?`,
            args: [nowIso, intentId],
          },
          {
            sql: `UPDATE payment_attempts SET status = 'SUCCEEDED', provider_payment_id = ?, completed_at_utc = ? WHERE id = ?`,
            args: [chargeResult.providerPaymentId, nowIso, attemptId],
          },
        ],
        "write",
      );

      const msgEn = userFacingMessage({ visible: "SUCCEEDED", amountPaise: session.amount_paise, locale: "en" });
      const msgHi = userFacingMessage({ visible: "SUCCEEDED", amountPaise: session.amount_paise, locale: "hi" });

      broadcastStatus(token, {
        knowledgeStatus: "RESOLVED_SUCCESS",
        executionState: "SUCCEEDED",
        userMessage: msgEn,
        userMessageHi: msgHi,
      });

      return res.status(200).json({
        knowledgeStatus: "RESOLVED_SUCCESS",
        providerPaymentId: chargeResult.providerPaymentId,
        userMessage: msgEn,
        userMessageHi: msgHi,
      });
    }

    if (chargeResult.status === "failed") {
      await dbClient.batch(
        [
          {
            sql: `UPDATE payment_intents SET status = 'FAILED', client_visible = 'FAILED', resolved_at_utc = ? WHERE id = ?`,
            args: [nowIso, intentId],
          },
          {
            sql: `UPDATE payment_attempts SET status = 'FAILED', provider_payment_id = ?, completed_at_utc = ? WHERE id = ?`,
            args: [chargeResult.providerPaymentId, nowIso, attemptId],
          },
        ],
        "write",
      );

      const msgEn = userFacingMessage({ visible: "FAILED", amountPaise: session.amount_paise, errorCode: chargeResult.errorCode, locale: "en" });
      const msgHi = userFacingMessage({ visible: "FAILED", amountPaise: session.amount_paise, errorCode: chargeResult.errorCode, locale: "hi" });

      broadcastStatus(token, {
        knowledgeStatus: "RESOLVED_FAILED",
        executionState: "FAILED",
        errorCode: chargeResult.errorCode,
        userMessage: msgEn,
        userMessageHi: msgHi,
        advisory: {
          rootCause: chargeResult.errorDescription || "Card declined",
          recommendedAction: "RECOVER_WHATSAPP",
          recoveryProbability: 0.82,
        },
      });

      return res.status(400).json({
        knowledgeStatus: "RESOLVED_FAILED",
        errorCode: chargeResult.errorCode,
        userMessage: msgEn,
        userMessageHi: msgHi,
      });
    }

    // Transport Dropped / Lost Response / Timeout -> Hold in UNRESOLVED_UNKNOWN
    await dbClient.batch(
      [
        {
          sql: `UPDATE payment_intents SET status = 'UNKNOWN', client_visible = 'UNKNOWN', resolved_at_utc = ? WHERE id = ?`,
          args: [nowIso, intentId],
        },
        {
          sql: `UPDATE payment_attempts SET status = 'UNKNOWN', provider_payment_id = ?, completed_at_utc = ? WHERE id = ?`,
          args: [chargeResult.providerPaymentId, nowIso, attemptId],
        },
      ],
      "write",
    );

    const msgEn = userFacingMessage({ visible: "UNKNOWN", amountPaise: session.amount_paise, locale: "en" });
    const msgHi = userFacingMessage({ visible: "UNKNOWN", amountPaise: session.amount_paise, locale: "hi" });

    broadcastStatus(token, {
      knowledgeStatus: "UNRESOLVED_UNKNOWN",
      executionState: "UNKNOWN",
      userMessage: msgEn,
      userMessageHi: msgHi,
    });

    // Schedule active reconciliation check after 2 seconds
    setTimeout(() => {
      reconcilePaymentIntent(dbClient, localGateway, intentId, Date.now()).then((rec) => {
        if (rec.resolved) {
          broadcastStatus(token, {
            knowledgeStatus: rec.knowledgeStatus,
            executionState: rec.knowledgeStatus === "RESOLVED_SUCCESS" ? "SUCCEEDED" : "FAILED",
            userMessage: userFacingMessage({
              visible: rec.knowledgeStatus === "RESOLVED_SUCCESS" ? "SUCCEEDED" : "FAILED",
              amountPaise: session.amount_paise,
            }),
          });
        }
      }).catch(() => {});
    }, 2000);

    return res.status(202).json({
      knowledgeStatus: "UNRESOLVED_UNKNOWN",
      userMessage: msgEn,
      userMessageHi: msgHi,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// 5. Fast-ACK Webhook Ingestion Endpoint
app.post("/api/webhooks/razorpay", webhookLimiter, async (req, res) => {
  const signature = (req.headers["x-razorpay-signature"] as string) || null;
  const rawBody = req.body as Buffer;

  const result = await ingestDomainWebhook({
    client: dbClient,
    rawBody,
    signature,
    webhookSecret: WEBHOOK_SECRET || DEFAULT_LOCAL_WEBHOOK_SECRET,
  });

  return res.status(result.statusCode).json(result);
});

// 6. Live SSE Payment Status Endpoint
app.get("/api/status/:token", async (req, res) => {
  const { token } = req.params;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  if (!sseClients.has(token)) {
    sseClients.set(token, new Set());
  }
  const clientSet = sseClients.get(token)!;
  if (clientSet.size >= MAX_SSE_CONNECTIONS_PER_TOKEN) {
    return res.status(429).end("Too many status connections for this token");
  }

  const sseClient: SSEClient = { res, token, connectedAt: Date.now() };
  clientSet.add(sseClient);

  // Send initial heartbeat
  res.write(`data: ${JSON.stringify({ type: "INIT", status: "CONNECTED" })}\n\n`);

  // Heartbeat timer every 15s
  const heartbeat = setInterval(() => {
    res.write(`: heartbeat\n\n`);
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    clientSet.delete(sseClient);
    if (clientSet.size === 0) sseClients.delete(token);
  });
});

// 7. Merchant Console & Admin Data
app.get("/dashboard", requireAdminAuth, (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(dashboardHtml);
});

app.get("/api/admin/intents", adminLimiter, requireAdminAuth, async (_req, res) => {
  try {
    const intents = await dbClient.execute(`SELECT * FROM payment_intents ORDER BY created_at_utc DESC LIMIT 50`);
    const settlements = await dbClient.execute(`SELECT * FROM local_settlements ORDER BY settled_at_utc DESC LIMIT 50`);
    const proposals = await dbClient.execute(`SELECT * FROM proposals ORDER BY id DESC LIMIT 50`);
    const auditLog = await dbClient.execute(`SELECT * FROM audit_log ORDER BY ts_utc DESC LIMIT 50`);

    res.json({
      intents: intents.rows,
      settlements: settlements.rows,
      proposals: proposals.rows,
      auditLog: auditLog.rows,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/admin/reconcile", adminLimiter, requireAdminAuth, async (_req, res) => {
  try {
    const count = await sweepStuckIntents(dbClient, localGateway, Date.now());
    res.json({ success: true, resolvedCount: count });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Startup & Periodic Sweeper ──────────────────────────────────────
export async function startServer() {
  await runMigrations(dbClient);
  const server = app.listen(PORT, HOST, () => {
    console.log(`\n======================================================`);
    console.log(`  ARBITER Payment Sandbox & Recovery Engine`);
    console.log(`  Running at: http://${HOST}:${PORT}`);
    console.log(`  Default Mode: ${DEFAULT_MODE}`);
    console.log(`  Merchant Console: http://${HOST}:${PORT}/dashboard`);
    console.log(`======================================================\n`);
  });

  // Background Sweeper every 30 seconds
  const sweeperInterval = setInterval(async () => {
    try {
      await sweepStuckIntents(dbClient, localGateway, Date.now());
    } catch {}
  }, 30000);

  return { app, server, sweeperInterval };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  startServer().catch((err) => {
    console.error("Server startup failed:", err);
    process.exit(1);
  });
}
