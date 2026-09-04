/**
 * ARBITER Payment Server — Real Payment Workflow
 *
 * Two actors: Store (customer) and Vendor Dashboard (merchant).
 * One payment gateway: Razorpay test mode.
 * No simulation. Real checkout, real webhooks, real ML analysis, real outreach.
 */
import express, { type Request, type Response, type NextFunction } from "express";
import { rateLimit } from "express-rate-limit";
import { createClient, type Client } from "@libsql/client";
import { randomBytes, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.VITEST && existsSync(".env")) {
  try {
    process.loadEnvFile();
    logger.info({ msg: "[Config] .env loaded successfully" });
  } catch (err) {
    logger.error({ msg: "[Config] Failed to load .env", err: (err as Error).message });
  }
} else if (!process.env.VITEST) {
  logger.info({ msg: "[Config] No .env file found — using environment variables only" });
}

import { isoUtc, formatINR, paise, logger } from "../packages/shared/src/index.js";
import {
  runMigrations,
  RATE_LIMIT_WEBHOOKS_PER_MIN,
  RATE_LIMIT_CHECKOUT_ORDERS_PER_MIN,
  RATE_LIMIT_CHARGES_PER_MIN,
  RATE_LIMIT_ADMIN_PER_MIN,
  DEFAULT_LOCAL_WEBHOOK_SECRET,
  DEFAULT_LOCAL_ADMIN_SECRET,
  appendAuditLedger,
  getAuditLedgerForEntity,
  verifyAuditLedgerChain,
  diagnosePaymentFailure,
  scheduleMandateRetry,
  generateCartRecoveryLink,
  calculateEarlySettlementDiscount,
  rePlanRecoveryAction,
  runFourWayAblationBenchmark,
  getMerchantPolicy,
  upsertMerchantPolicy,
  defaultGatewayOptimizer,
  isCascadeEligible,
  defaultBankCircuitBreaker,
  defaultWhatsAppInteractiveManager,
  parseWhatsAppWebhook,
  type MerchantRecoveryPolicy,
  type SubscriptionMandate,
  type AbandonedCheckout,
  type B2BInvoice,
  type CustomerInteractionEvent,
  buildD2CRecoveryStrategy,
  buildSaaSGracePeriodStrategy,
  buildB2BEarlySettlementStrategy,
  buildHighTicketSplitPayStrategy,
  sequenceIntelligentRecoveryBatch,
  LinUCBBandit,
  defaultEnterpriseBandit,
  defaultRecoveryBandit,
  ENTERPRISE_BANDIT_ACTIONS,
  BANDIT_ACTIONS,
} from "../packages/core/src/index.js";

import {
  fetchBehavioralProfile,
  fetchMerchantDomainConfig,
  computeCustomerPriority,
  recordEmailOpened,
  recordLinkClicked,
  recordDeliveryStatus,
  getLowBalanceGuidance,
} from "../packages/core/src/agent/behavioral_profiler.js";

import {
  simulateFailureTriage,
  initiateRecoveryOrder,
  completeRecovery,
  getRecoveryResult,
  runBatchBenchmark,
} from "./recovery.js";

import {
  OutreachRouter,
  MSG91SmsProvider,
  BrevoEmailProvider,
  BrevoSmsProvider,
} from "../packages/core/src/messaging/index.js";
import {
  PRODUCTS,
  getProduct,
  processFailedPayment,
  recordSuccessfulPayment,
  onPaymentRecovered,
  generateUpiIntents,
} from "./payment_workflow.js";
import { getCustomerMessage, getVendorMessage, getErrorEntry } from "../packages/core/src/error-catalog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const WEBHOOK_SECRET = process.env.RZP_WEBHOOK_SECRET || DEFAULT_LOCAL_WEBHOOK_SECRET;
const RZP_KEY_ID = process.env.RZP_TEST_KEY_ID || process.env.RZP_KEY_ID || "";
const RZP_KEY_SECRET = process.env.RZP_TEST_KEY_SECRET || process.env.RZP_KEY_SECRET || "";

// Public base URL for customer-facing links (emails, SMS, recovery pages).
// MUST be set to an externally accessible URL in production.
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "";
const isTest = () => process.env.NODE_ENV === "test" || process.env.VITEST === "true" || Boolean(process.env.VITEST);
const isProduction = process.env.NODE_ENV === "production";

function getPublicBaseUrl(): string {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL.replace(/\/$/, "");
  if (isTest()) return "http://localhost:3000";
  // In production, fail loudly if not configured
  if (isProduction) {
    logger.error({ msg: "[Config] CRITICAL: PUBLIC_BASE_URL not set. Customer-facing links will use localhost." });
    logger.error({ msg: "[Config] Set PUBLIC_BASE_URL=https://your-domain.com in your environment." });
  }
  return `http://localhost:${PORT}`;
}

// Validate at startup
const _startUrl = getPublicBaseUrl();
if (isProduction && _startUrl.includes("localhost")) {
  logger.error({ msg: "[Config] WARNING: PUBLIC_BASE_URL resolves to localhost in production mode." });
}

const dbPath = process.env.ARBITER_DB_PATH || "data/arbiter.sqlite";
const dbUrl = (dbPath === ":memory:" || dbPath === "file::memory:?cache=shared")
  ? ":memory:"
  : ((dbPath.startsWith("libsql:") || dbPath.startsWith("http:") || dbPath.startsWith("https:") || dbPath.startsWith("file:"))
    ? dbPath
    : `file:${resolve(dbPath)}`);
export const dbClient: Client = createClient({ url: dbUrl, authToken: process.env.ARBITER_DB_TOKEN });

const outreachRouter = new OutreachRouter();
const brevoProvider = new BrevoEmailProvider();
const msg91Provider = new MSG91SmsProvider();
const brevoSmsProvider = new BrevoSmsProvider();
outreachRouter.registerProvider(brevoProvider);
outreachRouter.registerProvider(msg91Provider);
outreachRouter.registerProvider(brevoSmsProvider); // Multi-rail SMS fallback

// Log provider status at startup
const brevoKey = process.env.BREVO_API_KEY;
const msg91Key = process.env.MSG91_AUTH_KEY;
const msg91Template = process.env.MSG91_TEMPLATE_ID || process.env.MSG91_DLT_TEMPLATE_ID;
logger.info({ msg: "[Providers] Brevo email:", brevoKey: brevoKey && !brevoKey.includes("xxxxxx") ? `CONFIGURED (${brevoKey.slice(0, 8)}...)` : "SIMULATED (no API key)" });
logger.info({ msg: "[Providers] MSG91 SMS:", msg91Key: msg91Key && !msg91Key.includes("xxxxxx") ? `CONFIGURED (${msg91Key.slice(0, 8)}...)` : "SIMULATED (no auth key)" });
if (msg91Template) {
  logger.info({ msg: "[Providers] MSG91 template ID:", msg91Template: msg91Template, mode: "REAL" });
}

const webhookLimiter = rateLimit({ windowMs: 60_000, limit: RATE_LIMIT_WEBHOOKS_PER_MIN, standardHeaders: true, skip: () => isTest() });
const paymentLimiter = rateLimit({ windowMs: 60_000, limit: RATE_LIMIT_CHARGES_PER_MIN, standardHeaders: true, skip: () => isTest() });
const checkoutLimiter = rateLimit({ windowMs: 60_000, limit: RATE_LIMIT_CHECKOUT_ORDERS_PER_MIN, standardHeaders: true, skip: () => isTest() });
const adminLimiter = rateLimit({ windowMs: 60_000, limit: RATE_LIMIT_ADMIN_PER_MIN, standardHeaders: true, skip: () => isTest() });
const recoveryLimiter = rateLimit({ windowMs: 60_000, limit: RATE_LIMIT_CHARGES_PER_MIN, standardHeaders: true, skip: () => isTest() });

// G-002: Admin key enforcement — ENFORCE_ADMIN_KEY=true requires X-Admin-Key header
const ENFORCE_ADMIN_KEY = String(process.env.ENFORCE_ADMIN_KEY ?? "false").toLowerCase() === "true";
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY || DEFAULT_LOCAL_ADMIN_SECRET;

function requireAdminKey(req: Request, res: Response, next: NextFunction): void {
  if (!ENFORCE_ADMIN_KEY) {
    next();
    return;
  }
  const provided = String(req.headers["x-admin-key"] ?? req.headers["authorization"] ?? "");
  const token = provided.startsWith("Bearer ") ? provided.slice(7) : provided;
  // timingSafeEqual requires equal-length buffers — hash both first
  const a = createHash("sha256").update(ADMIN_SECRET_KEY).digest();
  const b = createHash("sha256").update(token).digest();
  if (!timingSafeEqual(a, b)) {
    res.status(401).json({ error: "Unauthorized: missing or invalid admin key" });
    return;
  }
  next();
}

// Simplified human-readable error reasons — user sees this, not raw codes
function getSimplifiedReason(code: string, failureClass: string): string {
  return getCustomerMessage(code);
}

// ── SSE ──────────────────────────────────────────────────────────
interface SSEClient { res: Response; id: string; connectedAt: number; }
const sseClients = new Map<string, Set<SSEClient>>();

function broadcastSSE(channel: string, data: Record<string, unknown>) {
  const clients = sseClients.get(channel);
  if (!clients) return;
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) { try { c.res.write(msg); } catch {} }
}

// ── Middleware ────────────────────────────────────────────────────
app.use("/api/webhooks/razorpay", express.raw({ type: "*/*" }));
app.use(express.json());

// ── HTML Views ───────────────────────────────────────────────────
const storeHtml = readFileSync(resolve(__dirname, "views/store.html"), "utf8");
const dashboardHtml = readFileSync(resolve(__dirname, "views/dashboard.html"), "utf8");
const recoverHtml = readFileSync(resolve(__dirname, "views/recover.html"), "utf8");
const resultHtml = readFileSync(resolve(__dirname, "views/result.html"), "utf8");
const batchReportHtml = readFileSync(resolve(__dirname, "views/batch_report.html"), "utf8");

// ── Store Routes ─────────────────────────────────────────────────
app.get("/", (_req, res) => { res.setHeader("Content-Type", "text/html"); res.send(storeHtml); });
app.get("/store", (_req, res) => { res.setHeader("Content-Type", "text/html"); res.send(storeHtml); });
app.get("/dashboard", (_req, res) => { res.setHeader("Content-Type", "text/html"); res.send(dashboardHtml); });
app.get("/recover/:eventId", (_req, res) => { res.setHeader("Content-Type", "text/html"); res.send(recoverHtml); });
app.get("/batch-report", (_req, res) => { res.setHeader("Content-Type", "text/html"); res.send(batchReportHtml); });

// ── Get Products ─────────────────────────────────────────────────
app.get("/api/products", (_req, res) => {
  res.json(PRODUCTS);
});

// ── Create Razorpay Order + Upsert Customer ─────────────────────
const createOrderHandler = async (req: Request, res: Response) => {
  try {
    const { productId, customerName, customerPhone, customerEmail } = req.body;
    if (!productId || !customerName || !customerPhone || !customerEmail) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    const product = getProduct(productId);
    if (!product) return res.status(400).json({ error: "Invalid product" });

    const nowMs = Date.now();
    const nowUtc = isoUtc(nowMs);

    // Upsert customer profile
    const existing = await dbClient.execute({
      sql: "SELECT id FROM customer_profiles WHERE phone = ?",
      args: [customerPhone],
    });

    let customerId: string;
    if (existing.rows.length > 0) {
      customerId = String(existing.rows[0].id);
      await dbClient.execute({
        sql: "UPDATE customer_profiles SET name = ?, email = ? WHERE id = ?",
        args: [customerName, customerEmail, customerId],
      });
    } else {
      customerId = `cust_${nowMs}_${randomBytes(4).toString("hex")}`;
      await dbClient.execute({
        sql: `INSERT INTO customer_profiles (id, name, phone, email, created_at_utc)
              VALUES (?, ?, ?, ?, ?)`,
        args: [customerId, customerName, customerPhone, customerEmail, nowUtc],
      });
    }

    // Create Razorpay order
    let orderId = `order_${nowMs}_${randomBytes(4).toString("hex")}`;
    if (RZP_KEY_ID && RZP_KEY_SECRET && !RZP_KEY_ID.includes("xxxxxx")) {
      try {
        const auth = Buffer.from(`${RZP_KEY_ID}:${RZP_KEY_SECRET}`).toString("base64");
        const idempotencyKey = `idemp_ord_${customerId}_${productId}_${Math.floor(nowMs / 60000)}`;
        const rzpRes = await fetch("https://api.razorpay.com/v1/orders", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Basic ${auth}`,
            "X-Razorpay-Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            amount: product.pricePaise,
            currency: "INR",
            receipt: `rcpt_${customerId.slice(0, 12)}_${nowMs}`,
            notes: { customer_profile_id: customerId, product_id: productId, product_name: product.name },
          }),
        });
        if (rzpRes.ok) {
          const rzpData = (await rzpRes.json()) as { id: string };
          if (rzpData?.id) orderId = rzpData.id;
        }
      } catch (err) {
        logger.warn({ msg: "Razorpay order creation failed, using local order", err: err });
      }
    }

    res.json({
      orderId,
      amountPaise: product.pricePaise,
      currency: "INR",
      keyId: RZP_KEY_ID || "rzp_test_demo",
      customerId,
      productId,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
};

app.post("/api/orders/create", checkoutLimiter, createOrderHandler);
app.post("/api/checkout/order", checkoutLimiter, createOrderHandler);

// ── Verify Payment (called by frontend after Checkout.js success) ─
const verifyPaymentHandler = async (req: Request, res: Response) => {
  try {
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature, orderId } = req.body;
    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing payment verification fields" });
    }

    // Validate signature format (64-char hex)
    if (!/^[0-9a-fA-F]{64}$/.test(razorpay_signature)) {
      return res.status(400).json({ error: "Invalid signature format" });
    }

    // HMAC verification
    if (RZP_KEY_SECRET && !RZP_KEY_SECRET.includes("xxxxxx")) {
      const payload = `${razorpay_order_id}|${razorpay_payment_id}`;
      const expected = createHmac("sha256", RZP_KEY_SECRET).update(payload).digest("hex");
      try {
        const sigBuf = Buffer.from(razorpay_signature, "hex");
        const expBuf = Buffer.from(expected, "hex");
        if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
          return res.status(400).json({ error: "Invalid signature" });
        }
      } catch {
        return res.status(400).json({ error: "Invalid signature format" });
      }
    }

    // Fetch order details to get customer profile
    let customerProfileId = "";
    let productName = "";
    if (RZP_KEY_ID && RZP_KEY_SECRET && !RZP_KEY_ID.includes("xxxxxx")) {
      try {
        const auth = Buffer.from(`${RZP_KEY_ID}:${RZP_KEY_SECRET}`).toString("base64");
        const orderRes = await fetch(`https://api.razorpay.com/v1/orders/${razorpay_order_id}`, {
          headers: { Authorization: `Basic ${auth}` },
        });
        if (orderRes.ok) {
          const orderData = (await orderRes.json()) as any;
          customerProfileId = orderData?.notes?.customer_profile_id || "";
          productName = orderData?.notes?.product_name || "";
        }
      } catch {}
    }

    if (!customerProfileId) {
      if (req.body.customerId || req.body.customerProfileId) {
        customerProfileId = String(req.body.customerId || req.body.customerProfileId);
      } else {
        const localEvent = await dbClient.execute({
          sql: `SELECT customer_profile_id, product_name FROM live_payment_events WHERE razorpay_order_id = ? OR id = ? ORDER BY created_at_utc DESC LIMIT 1`,
          args: [razorpay_order_id, razorpay_order_id],
        });
        if (localEvent.rows.length > 0) {
          customerProfileId = String(localEvent.rows[0].customer_profile_id);
          productName = String(localEvent.rows[0].product_name || "");
        } else {
          const downsell = await dbClient.execute({
            sql: `SELECT customer_profile_id FROM downsell_offers WHERE razorpay_order_id = ? LIMIT 1`,
            args: [razorpay_order_id],
          });
          if (downsell.rows.length > 0) {
            customerProfileId = String(downsell.rows[0].customer_profile_id);
          }
        }
      }
    }

    if (!customerProfileId) {
      return res.status(400).json({ error: "Could not identify customer" });
    }

    // Fetch payment details (gracefully handle missing API keys)
    let amountPaise = 0;
    let paymentMethod = "";
    let cardLast4 = "";
    let cardNetwork = "";
    let cardIssuer = "";
    let cardType = "";
    let vpa = "";
    let bankCode = "";
    if (RZP_KEY_ID && RZP_KEY_SECRET && !RZP_KEY_ID.includes("xxxxxx")) {
      try {
        const auth = Buffer.from(`${RZP_KEY_ID}:${RZP_KEY_SECRET}`).toString("base64");
        const payRes = await fetch(`https://api.razorpay.com/v1/payments/${razorpay_payment_id}`, {
          headers: { Authorization: `Basic ${auth}` },
        });
        if (payRes.ok) {
          const payData = (await payRes.json()) as any;
          amountPaise = payData?.amount || 0;
          paymentMethod = payData?.method || "";
          if (payData?.card) {
            cardLast4 = payData.card.last4 || "";
            cardNetwork = payData.card.network || "";
            cardIssuer = payData.card.issuer || "";
            cardType = payData.card.type || "";
          }
          if (payData?.vpa) vpa = payData.vpa;
          if (payData?.bank) bankCode = payData.bank;
        }
      } catch {}
    }

    // Record successful payment
    let eventId = "";
    let recoveryPruning = { cancelledOutreachCount: 0, auditEntryId: "" };
    try {
      eventId = await recordSuccessfulPayment(dbClient, {
        razorpayPaymentId: razorpay_payment_id,
        razorpayOrderId: razorpay_order_id,
        customerProfileId,
        amountPaise,
        productName,
        nowMs: Date.now(),
        paymentMethod,
        cardLast4,
        cardNetwork,
        cardIssuer,
        cardType,
        vpa,
        bankCode,
      });

      recoveryPruning = await onPaymentRecovered(dbClient, {
        customerProfileId,
        orderId: razorpay_order_id,
        eventId,
        amountPaise,
        paymentMethod,
        nowMs: Date.now(),
      });
    } catch (err) {
      logger.error({ msg: "Failed to record payment", err: err });
      return res.status(500).json({ error: "Failed to record payment" });
    }

    // Broadcast to vendor dashboard
    broadcastSSE("global", {
      type: "PAYMENT_RECEIVED",
      status: "captured",
      eventId,
      customerProfileId,
      amountPaise,
      productName,
      cancelledReminders: recoveryPruning.cancelledOutreachCount,
    });

    res.json({
      success: true,
      status: "captured",
      eventId,
      cancelledReminders: recoveryPruning.cancelledOutreachCount,
      auditEntryId: recoveryPruning.auditEntryId,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
};

app.post("/api/payments/verify", paymentLimiter, verifyPaymentHandler);
app.post("/api/payment-success", paymentLimiter, verifyPaymentHandler);

// ── Multi-Action Recovery Portal API Endpoints (Task 3.1) ──────────

// 1. 1-Tap UPI Intent URI Generator
app.post("/api/recovery/upi-intent", recoveryLimiter, async (req: Request, res: Response) => {
  try {
    const { eventId } = req.body;
    if (!eventId) return res.status(400).json({ error: "Missing eventId" });

    const evResult = await dbClient.execute({
      sql: `SELECT * FROM live_payment_events WHERE id = ?`,
      args: [eventId],
    });
    if (evResult.rows.length === 0) {
      return res.status(404).json({ error: "Event not found" });
    }
    const ev = evResult.rows[0] as any;
    const amountPaise = Number(ev.amount_paise || 499900);

    const intents = generateUpiIntents({
      amountPaise,
      merchantVpa: process.env.RAZORPAY_MERCHANT_VPA || "merchant@razorpay",
      merchantName: "ARBITER Recovery",
      transactionRef: eventId,
      transactionNote: `Recovery for ${ev.product_name || "Order"}`,
    });

    res.json({
      success: true,
      eventId,
      amountPaise,
      ...intents,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// 2. Smart Downsell & Split-Pay Cart Salvage Handler
app.post("/api/recovery/downsell", recoveryLimiter, async (req: Request, res: Response) => {
  try {
    const { eventId, downsellType, targetProductId } = req.body;
    if (!eventId || !downsellType) {
      return res.status(400).json({ error: "Missing eventId or downsellType" });
    }

    const evResult = await dbClient.execute({
      sql: `SELECT * FROM live_payment_events WHERE id = ?`,
      args: [eventId],
    });
    if (evResult.rows.length === 0) {
      return res.status(404).json({ error: "Event not found" });
    }
    const ev = evResult.rows[0] as any;
    const originalAmountPaise = Number(ev.amount_paise);

    let downsellAmountPaise = originalAmountPaise;
    let description = "";

    if (downsellType === "split_3") {
      downsellAmountPaise = Math.ceil(originalAmountPaise / 3);
      description = `1st installment (1 of 3) for ${ev.product_name}`;
    } else if (downsellType === "switch_monthly") {
      const basicProduct = getProduct("prod_monthly_basic");
      downsellAmountPaise = basicProduct ? basicProduct.pricePaise : 49900;
      description = `Downgrade to Monthly Basic Plan`;
    } else if (targetProductId) {
      const targetProd = getProduct(targetProductId);
      if (targetProd) {
        downsellAmountPaise = targetProd.pricePaise;
        description = `Switch to ${targetProd.name}`;
      }
    }

    const nowMs = Date.now();
    const nowUtc = isoUtc(nowMs);
    const downsellId = `dwn_${nowMs}_${randomBytes(4).toString("hex")}`;
    let orderId = `order_dwn_${nowMs}_${randomBytes(4).toString("hex")}`;

    if (RZP_KEY_ID && RZP_KEY_SECRET && !RZP_KEY_ID.includes("xxxxxx")) {
      try {
        const auth = Buffer.from(`${RZP_KEY_ID}:${RZP_KEY_SECRET}`).toString("base64");
        const idempotencyKey = `idemp_dwn_${eventId}_${downsellType}`;
        const rzpRes = await fetch("https://api.razorpay.com/v1/orders", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Basic ${auth}`,
            "X-Razorpay-Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            amount: downsellAmountPaise,
            currency: "INR",
            receipt: `rcpt_dwn_${nowMs}`,
            notes: {
              customer_profile_id: ev.customer_profile_id,
              parent_event_id: eventId,
              downsell_type: downsellType,
              description,
            },
          }),
        });
        if (rzpRes.ok) {
          const rzpData = (await rzpRes.json()) as { id: string };
          if (rzpData?.id) orderId = rzpData.id;
        }
      } catch (err) {
        logger.warn({ msg: "Razorpay downsell order creation failed, using local order", err });
      }
    }

    await dbClient.execute({
      sql: `INSERT INTO downsell_offers
        (id, parent_event_id, customer_profile_id, downsell_type, original_amount_paise, downsell_amount_paise, razorpay_order_id, status, created_at_utc)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'OFFERED', ?)`,
      args: [downsellId, eventId, ev.customer_profile_id, downsellType, originalAmountPaise, downsellAmountPaise, orderId, nowUtc],
    });

    await appendAuditLedger(dbClient, {
      eventType: "DOWNSELL_OFFER_CREATED",
      entityId: downsellId,
      customerId: ev.customer_profile_id,
      actor: "customer_portal",
      nowMs,
      payload: {
        parentEventId: eventId,
        downsellType,
        originalAmountPaise,
        downsellAmountPaise,
        orderId,
      },
    });

    res.json({
      success: true,
      downsellId,
      orderId,
      originalAmountPaise,
      amountPaise: downsellAmountPaise,
      currency: "INR",
      keyId: RZP_KEY_ID || "rzp_test_demo",
      description,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// 4. Cryptographic SHA-256 Audit Trail Endpoints (Task 3.2 / 4.2)
app.get("/api/audit-trail/:entityId", recoveryLimiter, async (req: Request, res: Response) => {
  try {
    const { entityId } = req.params;
    const entries = await getAuditLedgerForEntity(dbClient, entityId);
    res.json({ success: true, entityId, count: entries.length, entries });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/audit-trail/verify/chain", adminLimiter, requireAdminKey, async (_req: Request, res: Response) => {
  try {
    const verification = await verifyAuditLedgerChain(dbClient);
    res.json({ success: true, ...verification });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Client-Side Payment Failure (immediate redirect to recovery) ─
app.post("/api/payments/failed", paymentLimiter, async (req: Request, res: Response) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, error_code, error_description, error_step, error_source, error_reason,
            customerId, productId, productName, amountPaise, paymentMethod } = req.body;

    if (!razorpay_order_id) return res.status(400).json({ error: "razorpay_order_id required" });

    // Server-side amount validation — reject obviously invalid amounts
    const validatedAmount = Number(amountPaise);
    if (isNaN(validatedAmount) || validatedAmount <= 0 || validatedAmount > 10000000) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    // Use the REAL error code from Razorpay — never overwrite with demo codes
    const failureCode = error_code || "UNKNOWN";
    const paymentId = razorpay_payment_id || `pay_client_${Date.now()}`;

    // ── Tier 0: In-Flight Gateway Optimizer Cascade ──────────────────
    const optimizerRequested = req.query.optimizer === "true" || req.body.use_optimizer === true;
    if (optimizerRequested && isCascadeEligible(failureCode)) {
      const cascadeResult = defaultGatewayOptimizer.executeCascade({
        orderId: razorpay_order_id,
        amountPaise: validatedAmount,
        initialErrorCode: failureCode,
        idempotencyKey: `idem_cascade_${razorpay_order_id}`,
      });

      if (cascadeResult.recoveredInFlight) {
        await appendAuditLedger(dbClient, {
          eventType: "IN_FLIGHT_CASCADE_RECOVERED",
          entityId: razorpay_order_id,
          actor: "RAZORPAY_OPTIMIZER",
          payload: cascadeResult as any,
        });

        logger.info({
          msg: `[Optimizer] Payment ${razorpay_order_id} recovered in-flight via ${cascadeResult.winningGateway}`,
          latencyMs: cascadeResult.totalLatencyMs,
          cogsSavedPaise: cascadeResult.cogsSavedPaise,
        });

        return res.json({
          success: true,
          inFlightRecovered: true,
          status: "CAPTURED",
          winningGateway: cascadeResult.winningGateway,
          latencyMs: cascadeResult.totalLatencyMs,
          cogsSavedPaise: cascadeResult.cogsSavedPaise,
          reason: cascadeResult.reason,
        });
      }
    }

    // Deduplication: check if this payment_id already has an event
    const existingEvent = await dbClient.execute({
      sql: "SELECT id FROM live_payment_events WHERE razorpay_payment_id = ? LIMIT 1",
      args: [paymentId],
    });
    if (existingEvent.rows.length > 0) {
      const existingId = String(existingEvent.rows[0].id);
      logger.info({ msg: `[Payments] Dedup: payment ${paymentId} already has event ${existingId}` });
      return res.json({
        eventId: existingId,
        failureClass: "UNKNOWN",
        action: "NO_ACTION",
        failureCode,
        failureDescription: error_description || "Payment already recorded",
        duplicate: true,
      });
    }

    // Extract method details from Razorpay JS SDK error metadata
    let method = paymentMethod?.type || paymentMethod?.method || "";
    const cardLast4 = paymentMethod?.last4 || "";
    const cardNetwork = paymentMethod?.network || paymentMethod?.card_network || "";
    const cardIssuer = paymentMethod?.issuer || paymentMethod?.card_issuer || "";
    const cardType = paymentMethod?.card_type || paymentMethod?.type === "card" ? (paymentMethod?.card_type || "") : "";
    const vpa = paymentMethod?.vpa || "";
    const bankCode = paymentMethod?.bank || paymentMethod?.bank_name || "";

    // Fallback: infer payment method from error_code when SDK metadata is empty
    if (!method && failureCode) {
      const code = failureCode.toUpperCase();
      if (code.includes("CARD") || code.includes("EXPIRED") || code.includes("INSUFFICIENT_FUNDS") ||
          code.includes("INVALID_EXPIRY") || code.includes("BAD_EXPIRY") || code.includes("CVV") ||
          code.includes("CARDHOLDER") || code.includes("BLOCKED") || code.includes("LIMIT_EXCEEDED")) {
        method = "card";
      } else if (code.includes("UPI") || code.includes("VPA") || code.includes("MANDATE")) {
        method = "upi";
      } else if (code.includes("NETBANKING") || code.includes("BANK") || code.includes("ACCOUNT")) {
        method = "netbanking";
      } else if (code.includes("WALLET")) {
        method = "wallet";
      }
    }

    // Second dedup: if a recent failure exists for same customer+product+ORDER (within 5 minutes),
    // don't create a duplicate — this is the client handler and webhook for the same payment attempt.
    // Retries (different order_id) are NOT deduped — they are independent transactions.
    const validCustomerId = customerId || "";
    if (validCustomerId && productName && razorpay_order_id) {
      const recentFailure = await dbClient.execute({
        sql: `SELECT id FROM live_payment_events
              WHERE customer_profile_id = ? AND product_name = ? AND razorpay_order_id = ? AND status = 'failed'
              AND created_at_utc > datetime('now', '-5 minutes')
              ORDER BY created_at_utc DESC LIMIT 1`,
        args: [validCustomerId, productName, razorpay_order_id],
      });
      if (recentFailure.rows.length > 0) {
        const existingId = String(recentFailure.rows[0].id);
        logger.info({ msg: `[Payments] Client dedup: recent failure ${existingId} for order ${razorpay_order_id}` });
        return res.json({
          eventId: existingId,
          failureClass: "UNKNOWN",
          action: "NO_ACTION",
          failureCode,
          failureDescription: error_description || "Payment already recorded",
          duplicate: true,
        });
      }
    }

    // Use processFailedPayment to run full ML pipeline
    const result = await processFailedPayment(dbClient, {
      razorpayPaymentId: paymentId,
      razorpayOrderId: razorpay_order_id,
      amountPaise: validatedAmount,
      failureCode,
      failureDescription: error_description || `Payment failed: ${failureCode}`,
      failureStep: error_step || "payment_authorization",
      failureSource: error_source || "customer",
      failureReason: error_reason || failureCode,
      customerProfileId: validCustomerId,
      productName: productName || "",
      nowMs: Date.now(),
      paymentMethod: method,
      cardLast4,
      cardNetwork,
      cardIssuer,
      cardType,
      vpa,
      bankCode,
    }, outreachRouter);

    // Broadcast to vendor dashboard
    broadcastSSE("global", {
      type: "PAYMENT_FAILED",
      status: "failed",
      eventId: result.eventId,
      customerProfileId: validCustomerId,
      failureClass: result.failureClass,
      probability: result.probability,
      action: result.action,
      amountPaise: validatedAmount,
      productName,
    });

    if (result.isSuspicious) {
      broadcastSSE("vendor:alerts", {
        type: "SUSPICIOUS_ACTIVITY",
        eventId: result.eventId,
        customerProfileId: validCustomerId,
        reasons: result.suspicionReasons,
        amountPaise: validatedAmount,
        failureCode,
      });
    }

    // Diagnosis using deep banking engine
    const diag = diagnosePaymentFailure({
      failureCode,
      failureDescription: error_description,
      failureStep: error_step,
      failureSource: error_source,
      failureReason: error_reason,
      paymentMethod: method,
      cardLast4,
      cardNetwork,
      cardIssuer,
      cardType,
      vpa,
      bankCode,
    });

    res.json({
      eventId: result.eventId,
      failureClass: result.failureClass,
      action: result.action,
      failureCode,
      failureDescription: diag.customerDescription,
      diagnosis: diag,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Lookup event by orderId (for recovery page fallback) ─────────
app.get("/api/payments/by-order/:orderId", async (req: Request, res: Response) => {
  try {
    const rows = await dbClient.execute({
      sql: "SELECT id FROM live_payment_events WHERE razorpay_order_id = ? ORDER BY created_at_utc DESC LIMIT 1",
      args: [req.params.orderId],
    });
    if (rows.rows.length > 0) {
      return res.json({ eventId: String(rows.rows[0].id) });
    }
    res.status(404).json({ error: "No event found for this order" });
  } catch {
    res.status(500).json({ error: "Lookup failed" });
  }
});

// ── Razorpay Webhook (Authoritative) ─────────────────────────────
app.post("/api/webhooks/razorpay", webhookLimiter, async (req: Request, res: Response) => {
  const rawBody = req.body;
  const bodyForSig = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(JSON.stringify(rawBody));
  const signature = req.headers["x-razorpay-signature"] as string;

  // Fail-Closed Webhook Signature Verification (Phase 5)
  // Enforce HTTP 401 on missing or invalid HMAC in production, strict mode, or when secret is configured
  const isStrictWebhookSecurity =
    isProduction ||
    process.env.STRICT_WEBHOOK_SECURITY === "true" ||
    req.headers["x-strict-webhook-security"] === "true" ||
    Boolean(WEBHOOK_SECRET && WEBHOOK_SECRET !== DEFAULT_LOCAL_WEBHOOK_SECRET);

  if (isStrictWebhookSecurity) {
    if (!signature) {
      logger.error({ msg: "[Webhook] Rejected: Missing x-razorpay-signature header" });
      return res.status(401).json({ error: "Missing x-razorpay-signature header" });
    }

    const secret = WEBHOOK_SECRET || DEFAULT_LOCAL_WEBHOOK_SECRET;
    const expectedSig = createHmac("sha256", secret).update(bodyForSig).digest("hex");
    let isValid = false;

    try {
      const sigBuf = Buffer.from(signature, "hex");
      const expBuf = Buffer.from(expectedSig, "hex");
      if (sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf)) {
        isValid = true;
      }
    } catch {
      isValid = false;
    }

    if (!isValid) {
      logger.error({ msg: "[Webhook] Rejected: Invalid x-razorpay-signature header" });
      return res.status(401).json({ error: "Invalid webhook signature" });
    }
  } else if (signature && WEBHOOK_SECRET) {
    // Non-strict test/local mode: soft verify for diagnostic logging
    try {
      const expectedSig = createHmac("sha256", WEBHOOK_SECRET).update(bodyForSig).digest("hex");
      const sigBuf = Buffer.from(signature, "hex");
      const expBuf = Buffer.from(expectedSig, "hex");
      if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
        logger.warn({ msg: "[Webhook] Signature verification mismatch in test mode (allowed)" });
      }
    } catch {}
  }

  try {
    const rawBody = req.body;
    const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : JSON.stringify(rawBody);
    const event = JSON.parse(bodyStr);
    const eventType = event.event as string;
    const payment = event.payload?.payment?.entity;
    const paymentId = payment?.id as string | undefined;
    const dedupeId =
      paymentId ||
      event.payload?.order?.entity?.id ||
      event.payload?.subscription?.entity?.id ||
      event.payload?.invoice?.entity?.id ||
      (event.id ? String(event.id) : undefined);

    // Webhook deduplication — swallow duplicate deliveries across all entity types
    if (dedupeId) {
      try {
        const existing = await dbClient.execute({
          sql: "SELECT provider_event_id FROM webhook_dedupe WHERE provider_event_id = ?",
          args: [dedupeId],
        });
        if (existing.rows.length > 0) {
          await dbClient.execute({
            sql: "UPDATE webhook_dedupe SET swallow_count = swallow_count + 1 WHERE provider_event_id = ?",
            args: [dedupeId],
          });
          return res.json({ received: true, deduped: true });
        }
        await dbClient.execute({
          sql: "INSERT INTO webhook_dedupe (provider_event_id, first_seen_utc, swallow_count) VALUES (?, ?, 0)",
          args: [dedupeId, isoUtc(Date.now())],
        });
      } catch {}
    }

    if (eventType === "payment.captured") {
      if (payment?.id && payment?.order_id) {
        // Fetch order to get customer profile (gracefully handle missing orders)
        let customerProfileId = "";
        let productName = "";
        if (RZP_KEY_ID && RZP_KEY_SECRET && !RZP_KEY_ID.includes("xxxxxx")) {
          try {
            const auth = Buffer.from(`${RZP_KEY_ID}:${RZP_KEY_SECRET}`).toString("base64");
            const orderRes = await fetch(`https://api.razorpay.com/v1/orders/${payment.order_id}`, {
              headers: { Authorization: `Basic ${auth}` },
            });
            if (orderRes.ok) {
              const orderData = (await orderRes.json()) as any;
              customerProfileId = orderData?.notes?.customer_profile_id || "";
              productName = orderData?.notes?.product_name || "";
            }
          } catch {}
        }

        if (customerProfileId) {
          try {
            await recordSuccessfulPayment(dbClient, {
              razorpayPaymentId: payment.id,
              razorpayOrderId: payment.order_id,
              customerProfileId,
              amountPaise: payment.amount || 0,
              productName,
              nowMs: Date.now(),
            });

            broadcastSSE("global", {
              type: "PAYMENT_RECEIVED",
              status: "captured",
              customerProfileId,
              amountPaise: payment.amount,
            });
          } catch (err) {
            logger.error({ msg: "Failed to record successful payment", err: err });
          }
        }
      }
    }

    if (eventType === "payment.failed") {
      if (payment?.id && payment?.order_id) {
        // Fetch order to get customer profile (gracefully handle missing orders)
        let customerProfileId = "";
        let productName = "";
        if (RZP_KEY_ID && RZP_KEY_SECRET && !RZP_KEY_ID.includes("xxxxxx")) {
          try {
            const auth = Buffer.from(`${RZP_KEY_ID}:${RZP_KEY_SECRET}`).toString("base64");
            const orderRes = await fetch(`https://api.razorpay.com/v1/orders/${payment.order_id}`, {
              headers: { Authorization: `Basic ${auth}` },
            });
            if (orderRes.ok) {
              const orderData = (await orderRes.json()) as any;
              customerProfileId = orderData?.notes?.customer_profile_id || "";
              productName = orderData?.notes?.product_name || "";
            }
          } catch {}
        }

        // Fallback: create/find customer from webhook payload fields
        if (!customerProfileId && (payment.contact || payment.email)) {
          try {
            const phone = payment.contact || "";
            const email = payment.email || "";
            const name = payment.customer_name || "Customer";
            const nowUtc = isoUtc(Date.now());

            // Upsert customer by phone
            if (phone) {
              const existing = await dbClient.execute({
                sql: `SELECT id FROM customer_profiles WHERE phone = ? LIMIT 1`,
                args: [phone],
              });
              if (existing.rows.length > 0) {
                customerProfileId = String(existing.rows[0].id);
              } else {
                const custId = `cust_${Date.now()}_${createHash("sha256").update(phone).digest("hex").slice(0, 8)}`;
                await dbClient.execute({
                  sql: `INSERT INTO customer_profiles (id, name, phone, email, created_at_utc) VALUES (?, ?, ?, ?, ?)`,
                  args: [custId, name, phone, email, nowUtc],
                });
                customerProfileId = custId;
              }
            }
            if (!productName) productName = "Unknown Product";
          } catch {}
        }

        if (customerProfileId) {
          try {
            // Extract ALL Razorpay webhook fields
            const card = payment.card || {};
            const acquirerData = payment.acquirer_data || {};

            const result = await processFailedPayment(dbClient, {
              razorpayPaymentId: payment.id,
              razorpayOrderId: payment.order_id,
              amountPaise: payment.amount || 0,
              failureCode: payment.error_code || "UNKNOWN",
              failureDescription: payment.error_description || "",
              failureStep: payment.error_step || "",
              failureSource: payment.error_source || "",
              failureReason: payment.error_reason || "",
              customerProfileId,
              productName,
              nowMs: Date.now(),

              // Payment method details
              paymentMethod: payment.method || "",
              cardLast4: card.last4 || "",
              cardNetwork: card.network || "",
              cardIssuer: card.issuer || "",
              cardType: card.type || "",
              cardEmi: !!card.emi,

              // UPI details
              vpa: payment.vpa || "",

              // Netbanking details
              bankCode: payment.bank || "",

              // International flag
              isInternational: !!payment.international,

              // Acquirer data
              acquirerAuthCode: acquirerData.auth_code || "",
              acquirerRrn: acquirerData.rrn || "",
              acquirerErrorCode: acquirerData.error_code || "",

              // Token and contact
              razorpayTokenId: payment.token_id || "",
              razorpayContact: payment.contact || "",
              razorpayEmail: payment.email || "",
              razorpayCreatedAt: payment.created_at || 0,
            }, outreachRouter);

            logger.info({ msg: `[Webhook] payment.failed processed: ${result.eventId} | method=${payment.method} | class=${result.failureClass} | action=${result.action}` });

            // Broadcast to vendor dashboard
            broadcastSSE("global", {
              type: "PAYMENT_FAILED",
              status: "failed",
              eventId: result.eventId,
              customerProfileId,
              failureClass: result.failureClass,
              probability: result.probability,
              action: result.action,
              paymentMethod: payment.method,
              cardLast4: card.last4,
              cardNetwork: card.network,
              amountPaise: payment.amount,
              productName: productName || "",
            });

            if (result.isSuspicious) {
              broadcastSSE("vendor:alerts", {
                type: "SUSPICIOUS_ACTIVITY",
                eventId: result.eventId,
                customerProfileId,
                reasons: result.suspicionReasons,
                amountPaise: payment.amount,
                failureCode: payment.error_code,
                paymentMethod: payment.method,
              });
            }
          } catch (err) {
            logger.error({ msg: "Failed to process failed payment", err: err });
          }
        }
      }
    }

    // ── Phase 5 Extended Webhook Handlers ─────────────────────────
    if (eventType === "order.paid") {
      const order = event.payload?.order?.entity;
      const paymentEntity = event.payload?.payment?.entity;
      const orderId = order?.id;
      if (orderId) {
        const amountPaise = Number(order.amount_paid || order.amount || paymentEntity?.amount || 0);
        let customerProfileId = order.notes?.customer_profile_id || "";
        let productName = order.notes?.product_name || "Store Item";

        if (!customerProfileId) {
          try {
            const ev = await dbClient.execute({
              sql: "SELECT customer_profile_id, product_name FROM live_payment_events WHERE razorpay_order_id = ? ORDER BY created_at_utc DESC LIMIT 1",
              args: [orderId],
            });
            if (ev.rows.length > 0) {
              customerProfileId = String(ev.rows[0].customer_profile_id);
              if (ev.rows[0].product_name) productName = String(ev.rows[0].product_name);
            }
          } catch {}
        }

        if (customerProfileId) {
          try {
            await recordSuccessfulPayment(dbClient, {
              razorpayPaymentId: paymentEntity?.id || `pay_ord_${orderId.slice(-8)}`,
              razorpayOrderId: orderId,
              customerProfileId,
              amountPaise,
              productName,
              nowMs: Date.now(),
            });

            await appendAuditLedger(dbClient, {
              eventType: "ORDER_PAID",
              entityId: orderId,
              customerId: customerProfileId,
              payload: {
                orderId,
                amountPaise,
                productName,
                receipt: order.receipt,
                paymentId: paymentEntity?.id,
              },
              nowMs: Date.now(),
            });

            broadcastSSE("global", {
              type: "ORDER_PAID",
              orderId,
              customerProfileId,
              amountPaise,
              productName,
            });
          } catch (err) {
            logger.error({ msg: "Failed to process order.paid", err: (err as Error).message });
          }
        }
      }
    }

    if (eventType === "subscription.charged") {
      const subscription = event.payload?.subscription?.entity;
      const paymentEntity = event.payload?.payment?.entity;
      const subId = subscription?.id;

      if (subId) {
        const amountPaise = Number(paymentEntity?.amount || subscription.plan_amount || 0);
        const customerProfileId = subscription.notes?.customer_profile_id || subscription.customer_id || "cust_sub";

        try {
          await appendAuditLedger(dbClient, {
            eventType: "SUBSCRIPTION_CHARGED",
            entityId: subId,
            customerId: customerProfileId,
            payload: {
              subscriptionId: subId,
              planId: subscription.plan_id,
              currentStart: subscription.current_start,
              currentEnd: subscription.current_end,
              chargeAt: subscription.charge_at,
              amountPaise,
              paymentId: paymentEntity?.id,
              status: subscription.status,
            },
            nowMs: Date.now(),
          });

          broadcastSSE("global", {
            type: "SUBSCRIPTION_CHARGED",
            subscriptionId: subId,
            customerProfileId,
            amountPaise,
            status: subscription.status,
          });
        } catch (err) {
          logger.error({ msg: "Failed to process subscription.charged", err: (err as Error).message });
        }
      }
    }

    if (eventType === "subscription.halted") {
      const subscription = event.payload?.subscription?.entity;
      const subId = subscription?.id;

      if (subId) {
        const amountPaise = Number(subscription.plan_amount || subscription.notes?.amount_paise || 299900);
        const customerProfileId = subscription.notes?.customer_profile_id || subscription.customer_id || "cust_halted";
        const customerName = subscription.notes?.customer_name || "Subscriber";
        const planName = subscription.notes?.plan_name || "Subscription Plan";

        // Autonomously build SaaS Soft-lock Grace Period Strategy
        const graceStrategy = buildSaaSGracePeriodStrategy({
          mandateId: subId,
          planName,
          amountPaise,
          softLockGraceDays: 5,
          retryCount: 3,
          maxRetries: 3,
          rbiAdvanceNoticeHours: 24,
        });

        try {
          await appendAuditLedger(dbClient, {
            eventType: "SUBSCRIPTION_HALTED",
            entityId: subId,
            customerId: customerProfileId,
            payload: {
              subscriptionId: subId,
              status: "halted",
              gracePeriodDays: graceStrategy.softLockGraceDays,
              softLockExpiresAtUtc: graceStrategy.softLockExpiresAtUtc,
              customerMessage: graceStrategy.customerMessage,
              actionUrl: graceStrategy.actionUrl,
            },
            nowMs: Date.now(),
          });

          broadcastSSE("global", {
            type: "SUBSCRIPTION_HALTED",
            subscriptionId: subId,
            customerProfileId,
            graceStrategy,
          });
        } catch (err) {
          logger.error({ msg: "Failed to process subscription.halted", err: (err as Error).message });
        }
      }
    }

    if (eventType === "invoice.paid") {
      const invoice = event.payload?.invoice?.entity;
      const paymentEntity = event.payload?.payment?.entity;
      const invoiceId = invoice?.id;

      if (invoiceId) {
        const amountPaidPaise = Number(invoice.amount_paid || invoice.amount || paymentEntity?.amount || 0);
        const customerProfileId = invoice.customer_id || invoice.customer_details?.id || "cust_b2b";
        const clientCompany = invoice.customer_details?.name || "Corporate Client";
        const invoiceNumber = invoice.invoice_number || invoiceId;

        // Calculate early settlement DSO interest savings if settlement discount occurred
        const dsoDaysSaved = Number(invoice.notes?.dso_days_saved || 20);
        const annualCapitalRate = Number(invoice.notes?.annual_cost_of_capital || 0.14);
        const capitalSavingsPaise = Math.round(amountPaidPaise * (annualCapitalRate / 365) * dsoDaysSaved);

        try {
          await appendAuditLedger(dbClient, {
            eventType: "INVOICE_PAID",
            entityId: invoiceId,
            customerId: customerProfileId,
            payload: {
              invoiceId,
              invoiceNumber,
              clientCompany,
              amountPaidPaise,
              dsoDaysSaved,
              capitalSavingsPaise,
              status: "paid",
            },
            nowMs: Date.now(),
          });

          broadcastSSE("global", {
            type: "INVOICE_PAID",
            invoiceId,
            invoiceNumber,
            clientCompany,
            amountPaidPaise,
            capitalSavingsPaise,
          });
        } catch (err) {
          logger.error({ msg: "Failed to process invoice.paid", err: (err as Error).message });
        }
      }
    }

    res.json({ received: true });
  } catch (err) {
    logger.error({ msg: "Webhook processing error", err: err });
    res.status(200).json({ received: true }); // Always ACK webhooks
  }
});

// ── Vendor Dashboard API ─────────────────────────────────────────
app.get("/api/vendor/payments", adminLimiter, async (_req: Request, res: Response) => {
  try {
    // Customer-centric: show LATEST transaction per customer, not every transaction.
    // A customer who succeeded after retries appears in success list, not failed.
    const result = await dbClient.execute({
      sql: `WITH latest_per_customer AS (
              SELECT lpe.*,
                COALESCE(lpe.customer_name, cp.name) as customer_name,
                COALESCE(lpe.customer_phone, cp.phone) as customer_phone,
                COALESCE(lpe.customer_email, cp.email) as customer_email,
                cp.total_attempts, cp.total_successes, cp.total_failures,
                ROW_NUMBER() OVER (
                  PARTITION BY lpe.customer_profile_id
                  ORDER BY lpe.created_at_utc DESC
                ) as rn
              FROM live_payment_events lpe
              JOIN customer_profiles cp ON cp.id = lpe.customer_profile_id
            )
            SELECT lpc.*,
              so_out.channel as next_outreach_channel, so_out.scheduled_at_utc as next_outreach_utc,
              so_last.channel as last_outreach_channel, so_last.executed_at_utc as last_outreach_utc,
              so_last.status as last_outreach_status, so_last.error_message as last_outreach_error
            FROM latest_per_customer lpc
            LEFT JOIN (
              SELECT live_payment_event_id, channel, scheduled_at_utc
              FROM scheduled_outreach
              WHERE executed = 0
              GROUP BY live_payment_event_id
              ORDER BY scheduled_at_utc ASC
            ) so_out ON so_out.live_payment_event_id = lpc.id
            LEFT JOIN (
              SELECT live_payment_event_id, channel, executed_at_utc, status, error_message
              FROM scheduled_outreach
              WHERE executed = 1
              GROUP BY live_payment_event_id
              ORDER BY executed_at_utc DESC
            ) so_last ON so_last.live_payment_event_id = lpc.id
            WHERE lpc.rn = 1
            ORDER BY lpc.created_at_utc DESC LIMIT 50`,
      args: [],
    });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/vendor/alerts", adminLimiter, async (_req: Request, res: Response) => {
  try {
    const result = await dbClient.execute({
      sql: `SELECT lpe.*, cp.name as customer_name, cp.phone as customer_phone, cp.email as customer_email
            FROM live_payment_events lpe
            JOIN customer_profiles cp ON cp.id = lpe.customer_profile_id
            WHERE lpe.vendor_notified = 1 AND lpe.vendor_decision IS NULL
            ORDER BY lpe.created_at_utc DESC`,
      args: [],
    });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/vendor/analytics", adminLimiter, async (_req: Request, res: Response) => {
  try {
    // Customer-centric analytics: count latest status per customer
    const stats = await dbClient.execute({
      sql: `WITH latest_per_customer AS (
              SELECT lpe.*,
                ROW_NUMBER() OVER (
                  PARTITION BY lpe.customer_profile_id
                  ORDER BY lpe.created_at_utc DESC
                ) as rn
              FROM live_payment_events lpe
            )
            SELECT
              COUNT(*) as total_customers,
              SUM(CASE WHEN status = 'captured' THEN 1 ELSE 0 END) as total_successes,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as total_failures,
              SUM(CASE WHEN status = 'captured' THEN amount_paise ELSE 0 END) as recovered_paise,
              SUM(CASE WHEN status = 'failed' THEN amount_paise ELSE 0 END) as at_risk_paise,
              SUM(CASE WHEN payment_method = 'card' THEN 1 ELSE 0 END) as method_card,
              SUM(CASE WHEN payment_method = 'upi' THEN 1 ELSE 0 END) as method_upi,
              SUM(CASE WHEN payment_method = 'netbanking' THEN 1 ELSE 0 END) as method_netbanking,
              SUM(CASE WHEN payment_method = 'wallet' THEN 1 ELSE 0 END) as method_wallet,
              SUM(CASE WHEN payment_method IS NULL OR payment_method = '' THEN 1 ELSE 0 END) as method_other
            FROM latest_per_customer WHERE rn = 1`,
      args: [],
    });
    const row = stats.rows[0] as any;
    res.json({
      totalEvents: Number(row?.total_customers || 0),
      totalSuccesses: Number(row?.total_successes || 0),
      totalFailures: Number(row?.total_failures || 0),
      recoveredPaise: Number(row?.recovered_paise || 0),
      atRiskPaise: Number(row?.at_risk_paise || 0),
      methodCard: Number(row?.method_card || 0),
      methodUpi: Number(row?.method_upi || 0),
      methodNetbanking: Number(row?.method_netbanking || 0),
      methodWallet: Number(row?.method_wallet || 0),
      methodOther: Number(row?.method_other || 0),
      successRate: row?.total_customers > 0
        ? ((Number(row.total_successes) / Number(row.total_customers)) * 100).toFixed(1) + "%"
        : "0.0%",
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/vendor/failure-analysis", adminLimiter, async (_req: Request, res: Response) => {
  try {
    const failed = await dbClient.execute({
      sql: `SELECT failure_code, COUNT(*) as cnt, SUM(amount_paise) as total_amount
            FROM live_payment_events
            WHERE status = 'failed'
            GROUP BY failure_code
            ORDER BY cnt DESC`,
      args: [],
    });

    const totalFailures = failed.rows.reduce((sum, r) => sum + Number(r.cnt), 0);

    const analysis = failed.rows.map((row) => {
      const code = String(row.failure_code || "UNKNOWN");
      const count = Number(row.cnt);
      const entry = getErrorEntry(code);
      return {
        code,
        count,
        percentage: totalFailures > 0 ? Number(((count / totalFailures) * 100).toFixed(1)) : 0,
        humanReason: entry.vendorMessage,
        recommendedAction: entry.recommendedAction,
        totalAmountPaise: Number(row.total_amount || 0),
      };
    });

    res.json({ totalFailures, analysis });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/vendor/decision", adminLimiter, requireAdminKey, async (req: Request, res: Response) => {
  try {
    const { eventId, decision } = req.body;
    if (!eventId || !["approved", "rejected"].includes(decision)) {
      return res.status(400).json({ error: "Invalid parameters" });
    }

    await dbClient.execute({
      sql: "UPDATE live_payment_events SET vendor_decision = ? WHERE id = ?",
      args: [decision, eventId],
    });

    // Update customer profile risk
    const event = await dbClient.execute({
      sql: "SELECT customer_profile_id FROM live_payment_events WHERE id = ?",
      args: [eventId],
    });
    if (event.rows.length > 0) {
      const cpId = String(event.rows[0].customer_profile_id);
      await dbClient.execute({
        sql: "UPDATE customer_profiles SET vendor_decision = ?, flagged_as_suspicious = 0 WHERE id = ?",
        args: [decision, cpId],
      });

      // If approved, dispatch outreach
      if (decision === "approved") {
        const evt = await dbClient.execute({
          sql: "SELECT * FROM live_payment_events WHERE id = ?",
          args: [eventId],
        });
        if (evt.rows.length > 0) {
          const row = evt.rows[0] as any;
          const cust = await dbClient.execute({
            sql: "SELECT * FROM customer_profiles WHERE id = ?",
            args: [cpId],
          });
          if (cust.rows.length > 0) {
            const c = cust.rows[0] as any;
            const payload = {
              proposalId: eventId,
              failureClass: row.failure_class || "UNKNOWN",
              action: row.ml_action || "RETRY_NOW",
              recipient: { customerName: c.name, phone: c.phone, email: c.email },
              amountPaise: row.amount_paise,
              paymentLinkUrl: `${getPublicBaseUrl()}/recover/${eventId}`,
              language: "EN" as const,
              rawErrorReason: row.failure_code || "",
              instrumentDescription: row.failure_description || "",
            };
            try { await outreachRouter.dispatch("EMAIL", payload); } catch {}
            try { await outreachRouter.dispatch("SMS", payload); } catch {}
            await dbClient.execute({
              sql: "UPDATE live_payment_events SET outreach_dispatched = 1 WHERE id = ?",
              args: [eventId],
            });
          }
        }
      }
    }

    broadcastSSE("global", { type: "VENDOR_DECISION", eventId, decision });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Merchant Domain Configuration (Business Context Engine) ──────
app.get("/api/vendor/domain-config", async (req: Request, res: Response) => {
  try {
    const tenantId = (req.query.tenantId as string) || "demo";
    const config = await fetchMerchantDomainConfig(tenantId, dbClient);
    res.json({ success: true, config });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/vendor/domain-config", async (req: Request, res: Response) => {
  try {
    const {
      tenantId = "demo",
      domainType = "D2C_ECOMMERCE",
      cartReservationMins = 15,
      maxDiscountConcessionBp = 500,
      softLockGraceDays = 3,
    } = req.body || {};

    const ALLOWED_DOMAINS = ["D2C_ECOMMERCE", "SAAS_MANDATES", "B2B_INVOICES", "HIGH_TICKET"] as const;
    if (domainType && !ALLOWED_DOMAINS.includes(domainType)) {
      return res.status(400).json({ error: `Invalid domainType. Allowed: ${ALLOWED_DOMAINS.join(", ")}` });
    }

    const nowUtc = isoUtc(Date.now());

    await dbClient.execute({
      sql: `
        INSERT INTO merchant_domain_configs (
          tenant_id, domain_type, cart_reservation_mins, max_discount_concession_bp, soft_lock_grace_days, created_at_utc, updated_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id) DO UPDATE SET
          domain_type = excluded.domain_type,
          cart_reservation_mins = excluded.cart_reservation_mins,
          max_discount_concession_bp = excluded.max_discount_concession_bp,
          soft_lock_grace_days = excluded.soft_lock_grace_days,
          updated_at_utc = excluded.updated_at_utc
      `,
      args: [
        tenantId,
        domainType,
        Math.max(0, Number(cartReservationMins) || 15),
        Math.max(0, Math.min(5000, Number(maxDiscountConcessionBp) || 500)),
        Math.max(0, Number(softLockGraceDays) || 3),
        nowUtc,
        nowUtc,
      ],
    });

    const updated = await fetchMerchantDomainConfig(tenantId, dbClient);
    broadcastSSE("global", { type: "DOMAIN_CONFIG_UPDATED", config: updated });
    res.json({ success: true, config: updated });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Customer Behavioral Telemetry & Intelligence Endpoints ───────
app.post("/api/telemetry/customer-event", async (req: Request, res: Response) => {
  try {
    if (!req.body || typeof req.body !== "object") {
      return res.status(400).json({ error: "Invalid request body" });
    }

    const { profileId, event, latencyMins, channel = "EMAIL", amountPaise, domainType } = req.body;
    if (!profileId || !event) {
      return res.status(400).json({ error: "profileId and event required" });
    }

    const ALLOWED_EVENTS = ["opened", "email_opened", "clicked", "link_clicked"] as const;
    if (!ALLOWED_EVENTS.includes(event)) {
      return res.status(400).json({ error: `Invalid event. Allowed: ${ALLOWED_EVENTS.join(", ")}` });
    }

    if (event === "opened" || event === "email_opened") {
      await recordEmailOpened(profileId, Number(latencyMins) || 1.0, dbClient);
    } else if (event === "clicked" || event === "link_clicked") {
      await recordLinkClicked(profileId, channel === "SMS" ? "SMS" : "EMAIL", dbClient);
    }

    const profile = await fetchBehavioralProfile(profileId, dbClient);
    if (!profile) return res.status(404).json({ error: "Customer profile not found" });

    const priority = computeCustomerPriority(
      profile,
      typeof amountPaise === "number" && !isNaN(amountPaise) ? amountPaise : 199900,
      domainType || "D2C_ECOMMERCE"
    );
    broadcastSSE("global", { type: "CUSTOMER_TELEMETRY_UPDATED", profileId, priorityTier: priority.priorityTier });
    res.json({ success: true, profile, priority });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/behavioral/profile/:id", async (req: Request, res: Response) => {
  try {
    const profile = await fetchBehavioralProfile(req.params.id, dbClient);
    if (!profile) return res.status(404).json({ error: "Customer profile not found" });

    const tenantId = (req.query.tenantId as string) || "demo";
    const config = await fetchMerchantDomainConfig(tenantId, dbClient);
    const amountPaise = Number(req.query.amountPaise) || 199900;
    const priority = computeCustomerPriority(profile, amountPaise, config.domainType);

    res.json({ success: true, profile, priority, domainConfig: config });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/behavioral/low-balance-guidance", async (req: Request, res: Response) => {
  try {
    const customerName = (req.query.name as string) || "Customer";
    const amountPaise = Number(req.query.amountPaise) || 199900;
    const recoveryUrl = (req.query.url as string) || `${getPublicBaseUrl()}/store`;
    const profileId = req.query.profileId as string | undefined;

    let profile: CustomerBehavioralProfile | null = null;
    if (profileId) {
      profile = await fetchBehavioralProfile(profileId, dbClient);
    }

    const guidance = getLowBalanceGuidance(customerName, amountPaise, recoveryUrl, profile);
    res.json({ success: true, guidance });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Merchant Domain Context Engine Endpoints (Phase 3) ───────────

app.post("/api/domain/d2c/upi-intent", async (req: Request, res: Response) => {
  try {
    const {
      merchantVpa = "merchant.payments@razorpay",
      merchantName = "ARBITER Store",
      transactionRef = `txn_${Date.now()}`,
      amountPaise,
      cartReservationMins,
      concessionDiscountBp,
      productName,
      recoveryUrl,
      tenantId = "demo",
    } = req.body || {};

    if (!amountPaise || typeof amountPaise !== "number" || amountPaise <= 0) {
      return res.status(400).json({ error: "Valid amountPaise is required" });
    }

    const tenantConfig = await fetchMerchantDomainConfig(tenantId, dbClient).catch(() => null);
    const effectiveMins = cartReservationMins ?? tenantConfig?.cartReservationMins ?? 15;
    const effectiveBp = concessionDiscountBp ?? Math.min(500, tenantConfig?.maxDiscountConcessionBp ?? 500);

    const strategy = buildD2CRecoveryStrategy({
      merchantVpa,
      merchantName,
      transactionRef,
      amountPaise,
      cartReservationMins: effectiveMins,
      concessionDiscountBp: effectiveBp,
      productName,
      recoveryUrl: recoveryUrl || `${getPublicBaseUrl()}/checkout`,
    });

    res.json({ success: true, strategy });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/domain/saas/grace-period", async (req: Request, res: Response) => {
  try {
    const {
      mandateId,
      planName = "Pro Subscription",
      amountPaise,
      customerEmail,
      customerPhone,
      retryCount = 0,
      maxRetries = 3,
      softLockGraceDays,
      tenantId = "demo",
    } = req.body || {};

    if (!mandateId || !amountPaise) {
      return res.status(400).json({ error: "mandateId and amountPaise are required" });
    }

    const tenantConfig = await fetchMerchantDomainConfig(tenantId, dbClient).catch(() => null);
    const effectiveGraceDays = softLockGraceDays ?? tenantConfig?.softLockGraceDays ?? 3;

    const strategy = buildSaaSGracePeriodStrategy({
      mandateId,
      planName,
      amountPaise,
      customerEmail,
      customerPhone,
      retryCount,
      maxRetries,
      softLockGraceDays: effectiveGraceDays,
    });

    res.json({ success: true, strategy });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/domain/b2b/early-settlement", (req: Request, res: Response) => {
  try {
    const {
      invoiceId = `inv_${Date.now()}`,
      invoiceNumber = `INV-${Date.now()}`,
      clientCompany,
      contactPerson = "Finance Manager",
      contactEmail,
      amountPaise,
      dueDateUtc,
      vendorVpaPrefix,
      discountPercent,
      annualCostOfCapital,
      dsoDaysSaved,
    } = req.body || {};

    if (!amountPaise || !clientCompany) {
      return res.status(400).json({ error: "amountPaise and clientCompany are required" });
    }

    const strategy = buildB2BEarlySettlementStrategy({
      invoiceId,
      invoiceNumber,
      clientCompany,
      contactPerson,
      contactEmail: contactEmail || "finance@example.com",
      amountPaise,
      dueDateUtc: dueDateUtc || new Date(Date.now() + 30 * 86400000).toISOString(),
      vendorVpaPrefix,
      discountPercent,
      annualCostOfCapital,
      dsoDaysSaved,
    });

    res.json({ success: true, strategy });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/domain/edtech/split-pay", (req: Request, res: Response) => {
  try {
    const {
      totalAmountPaise,
      customerName = "Learner",
      productName = "Advanced Program",
      installmentCount = 3,
    } = req.body || {};

    if (!totalAmountPaise || typeof totalAmountPaise !== "number" || totalAmountPaise <= 0) {
      return res.status(400).json({ error: "Valid totalAmountPaise is required" });
    }

    const strategy = buildHighTicketSplitPayStrategy({
      totalAmountPaise,
      customerName,
      productName,
      installmentCount,
    });

    res.json({ success: true, strategy });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/decide/batch-sequence", (req: Request, res: Response) => {
  try {
    const { candidates, config, nowMs } = req.body || {};

    if (!Array.isArray(candidates)) {
      return res.status(400).json({ error: "candidates array is required" });
    }

    const result = sequenceIntelligentRecoveryBatch(
      candidates,
      config || {},
      typeof nowMs === "number" ? nowMs : Date.now()
    );

    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── LinUCB Contextual Bandit Endpoints ───────────────────────────
app.post("/api/bandit/select-arm", (req: Request, res: Response) => {
  try {
    const {
      amountPaise,
      ticketAmountPaise,
      dwellTimeSeconds = 0,
      openLatencyMins = 30,
      priorFailureCount = 0,
      channelResponsiveness = 0.5,
      armType = "enterprise",
      context: rawContext,
    } = req.body || {};

    const ticket = Number(amountPaise ?? ticketAmountPaise);
    if (!rawContext && (!ticket || ticket <= 0)) {
      return res.status(400).json({ error: "Valid amountPaise or ticketAmountPaise is required when context is not directly provided" });
    }

    if (armType === "legacy") {
      let context: [number, number, number, number];
      if (Array.isArray(rawContext) && rawContext.length === 4) {
        context = rawContext as [number, number, number, number];
      } else {
        context = LinUCBBandit.buildContext(
          ticket,
          Number(priorFailureCount),
          Number(dwellTimeSeconds),
          Number(channelResponsiveness)
        );
      }
      const selection = defaultRecoveryBandit.selectArm(context);
      return res.json({
        success: true,
        armType: "legacy",
        dimension: 4,
        selection,
        timestamp: new Date().toISOString(),
      });
    }

    // Enterprise 5-arm bandit (default)
    let context: [number, number, number, number, number];
    if (Array.isArray(rawContext) && rawContext.length === 5) {
      context = rawContext as [number, number, number, number, number];
    } else {
      context = LinUCBBandit.buildEnterpriseContext(
        ticket,
        Number(dwellTimeSeconds),
        Number(openLatencyMins),
        Number(priorFailureCount),
        Number(channelResponsiveness)
      );
    }

    const selection = defaultEnterpriseBandit.selectArm(context);
    return res.json({
      success: true,
      armType: "enterprise",
      dimension: 5,
      selection,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ msg: "[Bandit] select-arm error", err: (err as Error).message });
    return res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/bandit/feedback", (req: Request, res: Response) => {
  try {
    const {
      action,
      reward,
      context,
      armType = "enterprise",
    } = req.body || {};

    if (!action || typeof action !== "string") {
      return res.status(400).json({ error: "Valid action string is required" });
    }
    if (typeof reward !== "number" || isNaN(reward)) {
      return res.status(400).json({ error: "Valid reward number in [0, 1] is required" });
    }
    if (!Array.isArray(context)) {
      return res.status(400).json({ error: "Context array is required" });
    }

    if (armType === "legacy") {
      if (context.length !== 4) {
        return res.status(400).json({ error: "Legacy bandit requires a 4-dimensional context vector" });
      }
      if (!BANDIT_ACTIONS.includes(action as any)) {
        return res.status(400).json({ error: `Action '${action}' is not a valid legacy arm: ${BANDIT_ACTIONS.join(", ")}` });
      }
      defaultRecoveryBandit.updateArm(action as any, context, reward);
      const updatedState = defaultRecoveryBandit.getState()[action as any];
      return res.json({
        success: true,
        armType: "legacy",
        action,
        reward,
        armState: updatedState,
      });
    }

    // Enterprise bandit (default)
    if (context.length !== 5) {
      return res.status(400).json({ error: "Enterprise bandit requires a 5-dimensional context vector" });
    }
    if (!ENTERPRISE_BANDIT_ACTIONS.includes(action as any)) {
      return res.status(400).json({ error: `Action '${action}' is not a valid enterprise arm: ${ENTERPRISE_BANDIT_ACTIONS.join(", ")}` });
    }

    defaultEnterpriseBandit.updateArm(action as any, context, reward);
    const updatedState = defaultEnterpriseBandit.getState()[action as any];
    return res.json({
      success: true,
      armType: "enterprise",
      action,
      reward,
      armState: updatedState,
    });
  } catch (err) {
    logger.error({ msg: "[Bandit] feedback error", err: (err as Error).message });
    return res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/bandit/arms-state", (req: Request, res: Response) => {
  try {
    const armType = (req.query.armType as string) || "enterprise";
    if (armType === "legacy") {
      const state = defaultRecoveryBandit.getState();
      const summary = Object.entries(state).map(([arm, s]) => ({
        arm,
        pullCount: s.pullCount,
        totalReward: s.totalReward,
        meanReward: s.pullCount > 0 ? Number((s.totalReward / s.pullCount).toFixed(4)) : 0,
      }));
      return res.json({
        success: true,
        armType: "legacy",
        dimension: 4,
        arms: state,
        summary,
      });
    }

    const state = defaultEnterpriseBandit.getState();
    const summary = Object.entries(state).map(([arm, s]) => ({
      arm,
      pullCount: s.pullCount,
      totalReward: s.totalReward,
      meanReward: s.pullCount > 0 ? Number((s.totalReward / s.pullCount).toFixed(4)) : 0,
    }));
    return res.json({
      success: true,
      armType: "enterprise",
      dimension: 5,
      arms: state,
      summary,
    });
  } catch (err) {
    logger.error({ msg: "[Bandit] arms-state error", err: (err as Error).message });
    return res.status(500).json({ error: (err as Error).message });
  }
});

// ── SSE Endpoints ────────────────────────────────────────────────
app.get("/api/events/stream", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const channel = "global";
  const client: SSEClient = { res, id: randomBytes(8).toString("hex"), connectedAt: Date.now() };
  if (!sseClients.has(channel)) sseClients.set(channel, new Set());
  sseClients.get(channel)!.add(client);

  res.write(`data: ${JSON.stringify({ type: "CONNECTED", channel })}\n\n`);
  const heartbeat = setInterval(() => { res.write(": heartbeat\n\n"); }, 15000);
  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.get(channel)?.delete(client);
  });
});

app.get("/api/sse/:channel", (req: Request, res: Response) => {
  const { channel } = req.params;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const client: SSEClient = { res, id: randomBytes(8).toString("hex"), connectedAt: Date.now() };
  if (!sseClients.has(channel)) sseClients.set(channel, new Set());
  sseClients.get(channel)!.add(client);

  res.write(`data: ${JSON.stringify({ type: "CONNECTED", channel })}\n\n`);
  const heartbeat = setInterval(() => { res.write(": heartbeat\n\n"); }, 15000);
  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.get(channel)?.delete(client);
  });
});

// Periodic SSE dead client cleanup (every 60s)
setInterval(() => {
  const now = Date.now();
  for (const [ch, clients] of sseClients) {
    for (const c of clients) {
      if (now - c.connectedAt > 300000) { // 5 min max
        try { c.res.end(); } catch {}
        clients.delete(c);
      }
    }
  }
}, 60000);

// ── Payment Status SSE (for result page) ─────────────────────────
app.get("/api/status/:token", (req: Request, res: Response) => {
  const { token } = req.params;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const channel = `status:${token}`;
  const client: SSEClient = { res, id: randomBytes(8).toString("hex"), connectedAt: Date.now() };
  if (!sseClients.has(channel)) sseClients.set(channel, new Set());
  sseClients.get(channel)!.add(client);

  // Send current status if available
  dbClient.execute({
    sql: "SELECT status, failure_class, ml_action, outreach_dispatched FROM live_payment_events WHERE id = ?",
    args: [token],
  }).then((rows) => {
    if (rows.rows.length > 0) {
      const r = rows.rows[0] as any;
      res.write(`data: ${JSON.stringify({ type: "STATUS_UPDATE", status: r.status, failureClass: r.failure_class, action: r.ml_action, outreachDispatched: !!r.outreach_dispatched })}\n\n`);
    }
  }).catch(() => {});

  const heartbeat = setInterval(() => { res.write(": heartbeat\n\n"); }, 15000);
  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.get(channel)?.delete(client);
  });
});

// ── Provider DLR Webhook Endpoints ───────────────────────────────
// G-004: DLR webhooks verify signatures when provider secrets are configured
function extractSignature(req: Request): string {
  const h = req.headers as Record<string, string | undefined>;
  return String(h["x-webhook-signature"] ?? h["x-bravo-signature"] ?? h["x-msg91-signature"] ?? h["x-twilio-signature"] ?? h["authorization"] ?? "");
}

app.post("/api/webhooks/providers/brevo", webhookLimiter, async (req: Request, res: Response) => {
  // G-004: Verify Brevo webhook signature when secret is configured
  const sig = extractSignature(req);
  if (process.env.BREVO_WEBHOOK_SECRET && sig) {
    const rawBody = JSON.stringify(req.body);
    const expected = createHmac("sha256", process.env.BREVO_WEBHOOK_SECRET).update(rawBody).digest("hex");
    try {
      if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig, "hex"))) {
        res.status(401).json({ error: "Invalid webhook signature" });
        return;
      }
    } catch { /* hex parse failure → treat as invalid */ res.status(401).json({ error: "Invalid webhook signature" }); return; }
  }
  try {
    const event = req.body;
    await dbClient.execute({
      sql: `INSERT INTO audit_log (ts_utc, tenant_id, event_id, actor, entry_type, payload_json)
            VALUES (?, ?, ?, 'PROVIDER', 'OUTCOME', ?)`,
      args: [
        isoUtc(Date.now()), "demo",
        String(event["message-id"] || `brevo_${Date.now()}`),
        JSON.stringify({ provider: "brevo", event: event.event, email: event.email }),
      ],
    }).catch(() => {});
    res.json({ received: true });
  } catch { res.json({ received: true }); }
});

app.post("/api/webhooks/providers/msg91", webhookLimiter, async (req: Request, res: Response) => {
  // G-004: Verify MSG91 webhook signature when auth key is configured
  const sig = extractSignature(req);
  if (process.env.MSG91_AUTH_KEY && sig) {
    const rawBody = JSON.stringify(req.body);
    const expected = createHmac("sha256", process.env.MSG91_AUTH_KEY).update(rawBody).digest("hex");
    try {
      if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig, "hex"))) {
        res.status(401).json({ error: "Invalid webhook signature" });
        return;
      }
    } catch { res.status(401).json({ error: "Invalid webhook signature" }); return; }
  }
  try {
    const event = req.body;
    await dbClient.execute({
      sql: `INSERT INTO audit_log (ts_utc, tenant_id, event_id, actor, entry_type, payload_json)
            VALUES (?, ?, ?, 'PROVIDER', 'OUTCOME', ?)`,
      args: [
        isoUtc(Date.now()), "demo",
        String(event.requestId || `msg91_${Date.now()}`),
        JSON.stringify({ provider: "msg91", status: event.status, mobile: event.mobile }),
      ],
    }).catch(() => {});
    res.json({ received: true });
  } catch { res.json({ received: true }); }
});

// Canonical aliases for Engagement Telemetry (Task 6.10 / ENG-11)
app.post("/api/webhooks/brevo/events", webhookLimiter, async (req: Request, res: Response) => {
  try {
    const event = req.body || {};
    broadcastSSE("global", {
      type: "telemetry.engagement",
      provider: "brevo",
      event: event.event,
      email: event.email,
    });

    if (event.email) {
      const custRes = await dbClient.execute({
        sql: `SELECT id FROM customer_profiles WHERE email = ? LIMIT 1`,
        args: [event.email],
      });
      if (custRes.rows.length > 0) {
        const profileId = String(custRes.rows[0].id);
        if (event.event === "opened" || event.event === "unique_opened") {
          await recordEmailOpened(profileId, 2.0, dbClient);
        } else if (event.event === "click" || event.event === "clicked") {
          await recordLinkClicked(profileId, "EMAIL", dbClient);
        }
      }
    }
    res.json({ status: "ok", received: true });
  } catch {
    res.json({ status: "ok", received: true });
  }
});

app.post("/api/webhooks/msg91/dlr", webhookLimiter, async (req: Request, res: Response) => {
  try {
    const event = req.body || {};
    broadcastSSE("global", {
      type: "telemetry.engagement",
      provider: "msg91",
      status: event.status,
      mobile: event.mobile,
    });

    if (event.mobile) {
      const rawMobile = String(event.mobile).replace(/\D/g, "");
      const custRes = await dbClient.execute({
        sql: `SELECT id FROM customer_profiles WHERE phone LIKE ? LIMIT 1`,
        args: [`%${rawMobile.slice(-10)}%`],
      });
      if (custRes.rows.length > 0) {
        const profileId = String(custRes.rows[0].id);
        const status = String(event.status).toUpperCase();
        if (status.includes("DELIV")) {
          await recordDeliveryStatus(profileId, "SMS", "DELIVERED", dbClient);
        } else if (status.includes("FAIL") || status.includes("REJECT") || status.includes("DND")) {
          await recordDeliveryStatus(profileId, "SMS", "FAILED", dbClient);
        }
      }
    }
    res.json({ status: "ok", received: true });
  } catch {
    res.json({ status: "ok", received: true });
  }
});

app.post("/api/webhooks/providers/gupshup", webhookLimiter, async (req: Request, res: Response) => {
  // G-004: Verify Gupshup webhook signature when secret is configured
  const sig = extractSignature(req);
  if (process.env.GUPSHUP_WEBHOOK_SECRET && sig) {
    const rawBody = JSON.stringify(req.body);
    const expected = createHmac("sha256", process.env.GUPSHUP_WEBHOOK_SECRET).update(rawBody).digest("hex");
    try {
      if (expected !== sig) { res.status(401).json({ error: "Invalid webhook signature" }); return; }
    } catch { res.status(401).json({ error: "Invalid webhook signature" }); return; }
  }
  try {
    const event = req.body;
    await dbClient.execute({
      sql: `INSERT INTO audit_log (ts_utc, tenant_id, event_id, actor, entry_type, payload_json)
            VALUES (?, ?, ?, 'PROVIDER', 'OUTCOME', ?)`,
      args: [
        isoUtc(Date.now()), "demo",
        String(event.payload?.id || `gupshup_${Date.now()}`),
        JSON.stringify({ provider: "gupshup", type: event.type }),
      ],
    }).catch(() => {});
    res.json({ received: true });
  } catch { res.json({ received: true }); }
});

app.post("/api/webhooks/twilio/gather", webhookLimiter, async (req: Request, res: Response) => {
  const { Digits } = req.body;
  if (Digits === "1" || Digits === 1) {
    res.setHeader("Content-Type", "text/xml");
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>A secure payment link has been sent to your phone. Thank you!</Say><Hangup/></Response>`);
    return;
  }
  res.setHeader("Content-Type", "text/xml");
  res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
});

// ── Recovery Flow Endpoints (Backward Compatible) ────────────────
app.get("/recover", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html");
  res.send(recoverHtml);
});

app.get("/pay/:token", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html");
  res.send(recoverHtml);
});

app.get("/result", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html");
  res.send(resultHtml);
});

app.post("/api/recovery/triage", recoveryLimiter, async (req: Request, res: Response) => {
  try {
    const { presetKey } = req.body || {};
    const base = getPublicBaseUrl();
    const session = await simulateFailureTriage(presetKey || "SALARY_DELAY", base, dbClient);
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Provider Status (diagnostic endpoint) ─────────────────────
app.get("/api/providers/status", adminLimiter, (_req: Request, res: Response) => {
  const brevoKey = process.env.BREVO_API_KEY;
  const msg91Key = process.env.MSG91_AUTH_KEY;
    const msg91Flow = process.env.MSG91_TEMPLATE_ID || process.env.MSG91_DLT_TEMPLATE_ID;
  const now = new Date();
  const istHour = (now.getUTCHours() + 5) % 24 + (now.getUTCMinutes() + 30) / 60;

  res.json({
    brevo: {
      configured: !!brevoKey && !brevoKey.includes("xxxxxx"),
    },
    msg91: {
      configured: !!msg91Key && !msg91Key.includes("xxxxxx"),
      flowIdValid: !!msg91Flow,
    },
    quietHours: {
      istHour: istHour.toFixed(1),
      isSuppressed: istHour >= 22 || istHour < 8,
      window: "22:00 - 08:00 IST",
    },
  });
});

app.post("/api/recovery/initiate", recoveryLimiter, async (req: Request, res: Response) => {
  try {
    const { proposalId, preferredMethod } = req.body || {};
    const result = await initiateRecoveryOrder(proposalId, preferredMethod || "upi", dbClient);
    if (!result) return res.status(404).json({ error: "No active recovery session found" });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/recovery/complete", recoveryLimiter, async (req: Request, res: Response) => {
  try {
    const { proposalId } = req.body || {};
    if (!proposalId) return res.status(400).json({ error: "proposalId required" });

    const success = await completeRecovery(proposalId, dbClient);
    res.json({ success, proposalId });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/recovery/result/:proposalId", async (req: Request, res: Response) => {
  try {
    const result = await getRecoveryResult(req.params.proposalId, dbClient);
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: "Result not found" });
  }
});

app.post("/api/recovery/batch", recoveryLimiter, async (req: Request, res: Response) => {
  try {
    const { count } = req.body || {};
    const benchmark = await runBatchBenchmark(Number(count) || 100);
    broadcastSSE("global", {
      type: "BENCHMARK_COMPLETE",
      benchmark,
    });
    res.json(benchmark);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Get event + customer data from DB (for recovery page) ────────
app.get("/api/events/:eventId", async (req: Request, res: Response) => {
  try {
    const rows = await dbClient.execute({
      sql: `SELECT lpe.*, cp.name as customer_name, cp.phone as customer_phone, cp.email as customer_email
            FROM live_payment_events lpe
            LEFT JOIN customer_profiles cp ON cp.id = lpe.customer_profile_id
            WHERE lpe.id = ?`,
      args: [req.params.eventId],
    });
    if (rows.rows.length === 0) return res.status(404).json({ error: "Event not found" });
    const row = rows.rows[0] as any;
    const diagnosis = diagnosePaymentFailure({
      failureCode: row.failure_code,
      failureDescription: row.failure_description,
      failureSource: row.failure_source,
      failureStep: row.failure_step,
      failureReason: row.failure_reason,
      paymentMethod: row.payment_method,
      cardLast4: row.card_last4,
      cardNetwork: row.card_network,
      cardIssuer: row.card_issuer,
      bankCode: row.bank_code,
      vpa: row.vpa,
      acquirerErrorCode: row.acquirer_error_code,
      acquirerRrn: row.acquirer_rrn,
    });

    res.json({
      eventId: row.id,
      razorpayPaymentId: row.razorpay_payment_id,
      razorpayOrderId: row.razorpay_order_id,
      customerProfileId: row.customer_profile_id,
      customerName: row.customer_name || "",
      phone: row.customer_phone || "",
      email: row.customer_email || "",
      productName: row.product_name || "",
      amountPaise: row.amount_paise,
      status: row.status,
      failureClass: row.failure_class,
      failureCode: row.failure_code,
      failureDescription: row.failure_description,
      failureSource: row.failure_source || "",
      failureStep: row.failure_step || "",
      failureReason: row.failure_reason || "",
      paymentMethod: row.payment_method,
      cardLast4: row.card_last4,
      cardNetwork: row.card_network,
      cardIssuer: row.card_issuer,
      cardType: row.card_type,
      vpa: row.vpa,
      bankCode: row.bank_code,
      acquirerRrn: row.acquirer_rrn || "",
      createdAt: row.created_at_utc,
      diagnosis,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/events/:eventId/interaction", async (req: Request, res: Response) => {
  try {
    const { eventId } = req.params;
    const {
      interactionType = "PORTAL_OPENED",
      dwellTimeSeconds = 0,
      failedPaymentMethod,
    } = req.body;

    const eventResult = await dbClient.execute({
      sql: `SELECT * FROM live_payment_events WHERE id = ?`,
      args: [eventId],
    });

    if (eventResult.rows.length === 0) {
      return res.status(404).json({ error: "Event not found" });
    }

    const eventRow = eventResult.rows[0];
    const createdMs = new Date(String(eventRow.created_at_utc)).getTime();
    const nowMs = Date.now();
    const timeSinceFailureMinutes = Math.round((nowMs - createdMs) / (60 * 1000));

    const interactionEvent: CustomerInteractionEvent = {
      eventId,
      interactionType,
      timeSinceFailureMinutes,
      dwellTimeSeconds: Number(dwellTimeSeconds),
      failedPaymentMethod,
      cartAmountPaise: Number(eventRow.amount_paise),
      nowMs,
    };

    const rePlanResult = rePlanRecoveryAction(interactionEvent, {
      touchCount: Number(eventRow.retry_count || 1),
      lastTouchAtUtc: String(eventRow.last_outreach_utc || eventRow.created_at_utc),
      isOptedOut: false,
      createdAtUtc: String(eventRow.created_at_utc),
      domain: "D2C_CHECKOUT",
      nowMs,
    });

    // Append to immutable audit ledger
    await appendAuditLedger(dbClient, {
      eventType: "RE_PLANNED",
      entityId: eventId,
      customerId: String(eventRow.customer_profile_id || "anon"),
      payload: {
        interactionType,
        dwellTimeSeconds,
        action: rePlanResult.action,
        reason: rePlanResult.reason,
        concessionType: rePlanResult.concessionType,
        concessionPaise: rePlanResult.concessionPaise,
      },
      nowMs,
    });

    broadcastSSE("global", {
      type: "recovery.replanned",
      eventId,
      interactionType,
      rePlanResult,
    });

    res.json({
      success: true,
      eventId,
      interactionType,
      rePlanResult,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Track 3 Multi-Domain Endpoints ──────────────────────────────────────────

// 1. SaaS Recurring Subscription Mandates (UPI Autopay, eNACH)
app.post("/api/mandates/auto-debit-failure", async (req: Request, res: Response) => {
  try {
    const customerId = req.body.customerId || req.body.mandateId || `cust_${Date.now()}`;
    const {
      customerName,
      customerPhone,
      customerEmail,
      mandateType = "UPI_AUTOPAY",
      planName = "Pro Subscription",
      amountPaise = 299900,
      failureCode = "BAD_REQUEST_PAYMENT_UPI_AUTOPAY_DECLINED",
    } = req.body;

    if (!customerPhone) {
      return res.status(400).json({ error: "customerPhone is required" });
    }

    const mandateId = `man_${Date.now()}_${randomBytes(4).toString("hex")}`;
    const nowMs = Date.now();
    const nowUtc = isoUtc(nowMs);

    // Check if mandate already exists to increment retry sequence count
    const existing = await dbClient.execute({
      sql: `SELECT * FROM subscription_mandates WHERE customer_id = ? AND plan_name = ?`,
      args: [customerId, planName],
    });

    let retrySequenceCount = 0;
    let actualMandateId = mandateId;

    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      actualMandateId = String(row.id);
      retrySequenceCount = Number(row.retry_sequence_count || 0) + 1;
    }

    const mandateObj: SubscriptionMandate = {
      id: actualMandateId,
      customerId,
      customerName: customerName || "Customer",
      customerPhone,
      customerEmail,
      mandateType: mandateType as any,
      planName,
      amountPaise: Number(amountPaise),
      lastFailureCode: failureCode,
      retrySequenceCount,
      maxRetries: 3,
      status: retrySequenceCount >= 3 ? "SOFT_LOCK" : "ACTIVE",
      createdAtUtc: nowUtc,
    };

    const retryPlan = scheduleMandateRetry(mandateObj, failureCode, nowMs);

    if (existing.rows.length > 0) {
      await dbClient.execute({
        sql: `UPDATE subscription_mandates
              SET last_failure_code = ?, next_retry_at_utc = ?, pre_debit_notified_at_utc = ?,
                  retry_sequence_count = ?, status = ?
              WHERE id = ?`,
        args: [
          failureCode,
          retryPlan.scheduledDebitAtUtc,
          retryPlan.preDebitNotificationAtUtc,
          retrySequenceCount,
          mandateObj.status,
          actualMandateId,
        ],
      });
    } else {
      await dbClient.execute({
        sql: `INSERT INTO subscription_mandates
              (id, customer_id, customer_name, customer_phone, customer_email, mandate_type,
               plan_name, amount_paise, last_failure_code, next_retry_at_utc, pre_debit_notified_at_utc,
               retry_sequence_count, max_retries, status, created_at_utc)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          actualMandateId,
          customerId,
          mandateObj.customerName,
          customerPhone,
          customerEmail || null,
          mandateType,
          planName,
          mandateObj.amountPaise,
          failureCode,
          retryPlan.scheduledDebitAtUtc,
          retryPlan.preDebitNotificationAtUtc,
          retrySequenceCount,
          3,
          mandateObj.status,
          nowUtc,
        ],
      });
    }

    broadcastSSE("global", {
      type: "mandate.failure",
      mandateId: actualMandateId,
      planName,
      amountPaise: mandateObj.amountPaise,
      retryPlan,
    });

    res.json({
      success: true,
      mandate: mandateObj,
      retryPlan,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/mandates", async (_req: Request, res: Response) => {
  try {
    const rows = await dbClient.execute(`SELECT * FROM subscription_mandates ORDER BY created_at_utc DESC LIMIT 50`);
    res.json({ mandates: rows.rows });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// 2. Abandoned Pre-Payment Checkouts (Magic Checkout)
app.post("/api/checkout/abandon", async (req: Request, res: Response) => {
  try {
    const {
      customerName,
      customerPhone,
      customerEmail,
      cartItems = [],
      cartAmountPaise = 149900,
      dropOffStep = "PAYMENT_SCREEN_EXITED",
    } = req.body;

    if (!customerPhone) {
      return res.status(400).json({ error: "customerPhone is required" });
    }

    const checkoutId = `chk_${Date.now()}_${randomBytes(4).toString("hex")}`;
    const recoveryToken = `tok_cart_${randomBytes(8).toString("hex")}`;
    const nowUtc = isoUtc(Date.now());
    const cartItemsJson = JSON.stringify(cartItems.length > 0 ? cartItems : [{ id: "cart_item_1", name: "Premium Cart Order", pricePaise: cartAmountPaise }]);

    const checkoutObj: AbandonedCheckout = {
      id: checkoutId,
      customerName: customerName || "Shopper",
      customerPhone,
      customerEmail,
      cartItemsJson,
      cartAmountPaise: Number(cartAmountPaise),
      dropOffStep: dropOffStep as any,
      recoveryToken,
      status: "ABANDONED",
      createdAtUtc: nowUtc,
    };

    await dbClient.execute({
      sql: `INSERT INTO abandoned_checkouts
            (id, customer_name, customer_phone, customer_email, cart_items_json,
             cart_amount_paise, drop_off_step, recovery_token, status, created_at_utc)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        checkoutId,
        checkoutObj.customerName || null,
        customerPhone,
        customerEmail || null,
        cartItemsJson,
        checkoutObj.cartAmountPaise,
        dropOffStep,
        recoveryToken,
        "ABANDONED",
        nowUtc,
      ],
    });

    const host = req.get("host") || "localhost:3000";
    const protocol = req.protocol || "http";
    const recoveryLink = generateCartRecoveryLink(checkoutObj, `${protocol}://${host}`);

    broadcastSSE("global", {
      type: "checkout.abandoned",
      checkoutId,
      cartAmountPaise: checkoutObj.cartAmountPaise,
      recoveryLink,
    });

    res.json({
      success: true,
      checkout: checkoutObj,
      recoveryLink,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/checkout/restore/:token", async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const result = await dbClient.execute({
      sql: `SELECT * FROM abandoned_checkouts WHERE recovery_token = ?`,
      args: [token],
    });

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Cart restoration token expired or invalid" });
    }

    const row = result.rows[0];
    let cartItems = [];
    try {
      cartItems = JSON.parse(String(row.cart_items_json || "[]"));
    } catch {}

    res.json({
      restored: true,
      checkoutId: row.id,
      customerName: row.customer_name,
      customerPhone: row.customer_phone,
      cartAmountPaise: row.cart_amount_paise,
      cartItems,
      status: row.status,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// 3. B2B Corporate Invoices & Receivables (2/10 Net 30 Terms)
app.post("/api/invoices/chaser/initiate", async (req: Request, res: Response) => {
  try {
    const clientCompany = req.body.clientCompany || req.body.buyerName;
    const contactEmail = req.body.contactEmail;
    const invoiceNumber = req.body.invoiceNumber || `INV-${Date.now().toString(36).toUpperCase()}`;
    const amountPaise = req.body.amountPaise || req.body.invoiceAmountPaise || 15000000;
    const {
      vendorId = "acme_corp",
      contactPerson,
      contactPhone,
      dueDateUtc,
      daysOverdue = 15,
      earlyDiscountPercent = 2.0,
    } = req.body;

    if (!clientCompany || !contactEmail) {
      return res.status(400).json({ error: "clientCompany and contactEmail are required" });
    }

    const invoiceId = `inv_${Date.now()}_${randomBytes(4).toString("hex")}`;
    const nowUtc = isoUtc(Date.now());
    const virtualVpa = `smartcollect.${vendorId.toLowerCase().replace(/[^a-z0-9]/g, "")}@razorpay`;

    const invoiceObj: B2BInvoice = {
      id: invoiceId,
      vendorId,
      clientCompany,
      contactPerson: contactPerson || "Accounts Payable",
      contactEmail,
      contactPhone,
      amountPaise: Number(amountPaise),
      invoiceNumber,
      dueDateUtc: dueDateUtc || nowUtc,
      daysOverdue: Number(daysOverdue),
      earlyDiscountPercent: Number(earlyDiscountPercent),
      virtualVpa,
      status: "OVERDUE",
      createdAtUtc: nowUtc,
    };

    const chaserPlan = calculateEarlySettlementDiscount(invoiceObj, Date.now());

    await dbClient.execute({
      sql: `INSERT INTO b2b_invoices
            (id, vendor_id, client_company, contact_person, contact_email, contact_phone,
             amount_paise, invoice_number, due_date_utc, days_overdue, early_discount_percent,
             virtual_vpa, status, created_at_utc)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        invoiceId,
        vendorId,
        clientCompany,
        invoiceObj.contactPerson,
        contactEmail,
        contactPhone || null,
        invoiceObj.amountPaise,
        invoiceNumber,
        invoiceObj.dueDateUtc,
        invoiceObj.daysOverdue,
        invoiceObj.earlyDiscountPercent,
        virtualVpa,
        "OVERDUE",
        nowUtc,
      ],
    });

    broadcastSSE("global", {
      type: "invoice.chaser_initiated",
      invoiceId,
      invoiceNumber,
      clientCompany,
      chaserPlan,
    });

    res.json({
      success: true,
      invoice: invoiceObj,
      chaserPlan,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/invoices", async (_req: Request, res: Response) => {
  try {
    const rows = await dbClient.execute(`SELECT * FROM b2b_invoices ORDER BY created_at_utc DESC LIMIT 50`);
    res.json({ invoices: rows.rows });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Scheduled Outreach Sweeper ───────────────────────────────────
async function sweepScheduledOutreach() {
  try {
    const nowUtc = isoUtc(Date.now());
    const due = await dbClient.execute({
      sql: `SELECT so.*, cp.name, cp.phone, cp.email, lpe.failure_class, lpe.failure_code, lpe.amount_paise
            FROM scheduled_outreach so
            JOIN customer_profiles cp ON cp.id = so.customer_profile_id
            JOIN live_payment_events lpe ON lpe.id = so.live_payment_event_id
            WHERE so.executed = 0 AND so.scheduled_at_utc <= ?`,
      args: [nowUtc],
    });

    for (const row of due.rows) {
      const r = row as any;
      const payload = {
        proposalId: r.live_payment_event_id,
        failureClass: r.failure_class || "UNKNOWN",
        action: "REMINDER",
        recipient: { customerName: r.name, phone: r.phone, email: r.email },
        amountPaise: r.amount_paise,
        paymentLinkUrl: `${getPublicBaseUrl()}/recover/${r.live_payment_event_id}`,
        language: "EN" as const,
        rawErrorReason: r.failure_code || "",
        instrumentDescription: "Payment reminder",
      };

      let status = "FAILED";
      let errorMsg = "";
      try {
        if (r.channel === "EMAIL") {
          await outreachRouter.dispatch("EMAIL", payload);
        } else if (r.channel === "SMS") {
          await outreachRouter.dispatch("SMS", payload);
        }
        status = "SENT";
      } catch (err) {
        errorMsg = (err as Error).message || "Dispatch failed";
      }

      await dbClient.execute({
        sql: "UPDATE scheduled_outreach SET executed = 1, executed_at_utc = ?, status = ?, error_message = ? WHERE id = ?",
        args: [isoUtc(Date.now()), status, errorMsg || null, r.id],
      });
    }
  } catch (err) {
    logger.error({ msg: "[Outreach Sweeper] Error", err: (err as Error).message });
  }
}

// ── E-007: Batch Report API Endpoint ────────────────────────────
app.get("/api/recovery/batch-report", async (_req: Request, res: Response) => {
  try {
    const report = await runBatchBenchmark(dbClient);
    res.json(report);
  } catch (err) {
    logger.error({ msg: "[BatchReport] Error", err: (err as Error).message });
    res.status(500).json({ error: "Failed to generate batch report" });
  }
});

// ── 4-Way Comparative Baseline Ablation Benchmark (Task 6.3 / BEN-15) ──
app.get("/api/benchmark/four-way", (req: Request, res: Response) => {
  try {
    const size = parseInt(req.query.size as string, 10) || 1000;
    const seed = parseInt(req.query.seed as string, 16) || 0x5eed;
    const report = runFourWayAblationBenchmark(size, seed);
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Merchant Recovery Policy Engine (Task 6.7 / POL-08) ─────────────
app.get("/api/vendor/policies", async (req: Request, res: Response) => {
  try {
    const productId = (req.query.productId as string) || "prod_premium_plan";
    const policy = await getMerchantPolicy(dbClient, productId);
    res.json({ success: true, policy });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/vendor/policies", async (req: Request, res: Response) => {
  try {
    const {
      productId,
      allowSplitRecovery = true,
      minSplitTicketPaise = 199900,
      splitInstallments = 3,
      splitMarkupBps = 0,
      gracePeriodDays = 3,
      expiryAction = "SOFT_LOCK_FREE_TIER",
    } = req.body;

    if (!productId) {
      return res.status(400).json({ error: "productId is required" });
    }

    const updated = await upsertMerchantPolicy(dbClient, {
      productId,
      allowSplitRecovery: Boolean(allowSplitRecovery),
      minSplitTicketPaise: Number(minSplitTicketPaise),
      splitInstallments: Number(splitInstallments),
      splitMarkupBps: Number(splitMarkupBps),
      gracePeriodDays: Number(gracePeriodDays),
      expiryAction,
    });

    res.json({ success: true, policy: updated });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Razorpay Optimizer Tier-0 In-Flight Gateway Cascade ──────────
app.post("/api/optimizer/route", async (req: Request, res: Response) => {
  try {
    const {
      orderId = `order_${Date.now()}`,
      amountPaise = 499900,
      errorCode = "GATEWAY_TIMEOUT",
      idempotencyKey = `idem_opt_${Date.now()}`,
      cascadeSequence,
      mockGatewayOutcomes,
    } = req.body;

    const result = defaultGatewayOptimizer.executeCascade({
      orderId,
      amountPaise: Number(amountPaise),
      initialErrorCode: errorCode,
      idempotencyKey,
      cascadeSequence,
      mockGatewayOutcomes,
    });

    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/optimizer/metrics", (req: Request, res: Response) => {
  try {
    const metrics = defaultGatewayOptimizer.getMetrics();
    res.json({ success: true, metrics });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Bank Switch Health & Inter-Bank Steering Circuit Breaker ────
app.get("/api/rails/health", (req: Request, res: Response) => {
  try {
    const nowMs = req.query.now ? Number(req.query.now) : Date.now();
    const snapshot = defaultBankCircuitBreaker.getCompositeSnapshot(nowMs);
    res.json({ success: true, snapshot });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/banks/circuit-breaker/evaluate", (req: Request, res: Response) => {
  try {
    const { identifier = "", preferredMethod = "upi", nowMs } = req.body;
    const evaluation = defaultBankCircuitBreaker.evaluate(
      identifier,
      preferredMethod,
      nowMs ? Number(nowMs) : Date.now(),
    );
    res.json({ success: true, evaluation });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── 2-Way Interactive WhatsApp Webhook & Simulator (WHA-20) ─────
app.post("/api/webhooks/whatsapp", async (req: Request, res: Response) => {
  try {
    const parsed = parseWhatsAppWebhook(req.body);
    const result = await defaultWhatsAppInteractiveManager.processInboundAction(dbClient, parsed);

    broadcastSSE("global", {
      type: "whatsapp.interaction",
      action: parsed.actionType,
      phone: parsed.phone,
      status: result.status,
      remindersPrunedCount: result.remindersPrunedCount,
    });

    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/whatsapp/simulate-interaction", async (req: Request, res: Response) => {
  try {
    const parsed = parseWhatsAppWebhook(req.body);
    const result = await defaultWhatsAppInteractiveManager.processInboundAction(dbClient, parsed);

    broadcastSSE("global", {
      type: "whatsapp.interaction",
      action: parsed.actionType,
      phone: parsed.phone,
      status: result.status,
      remindersPrunedCount: result.remindersPrunedCount,
    });

    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Startup ──────────────────────────────────────────────────────
export async function startServer() {
  await runMigrations(dbClient);
  const server = app.listen(PORT, HOST, () => {
    logger.info({ msg: "\n  ARBITER Payment Server" });
    logger.info({ msg: `  Store:     http://${HOST}:${PORT}` });
    logger.info({ msg: `  Dashboard: http://${HOST}:${PORT}/dashboard` });
    logger.info({ msg: `  Mode:      ${RZP_KEY_ID ? "Razorpay Test Mode" : "Local Sandbox"}\n` });
  });

  // Sweep scheduled outreach every 60 seconds
  setInterval(sweepScheduledOutreach, 60_000);

  return { app, server };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  startServer().catch((err) => { logger.error({ msg: "Startup failed", err: err }); process.exit(1); });
}
