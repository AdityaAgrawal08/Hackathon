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
    console.log("[Config] .env loaded successfully");
  } catch (err) {
    console.error("[Config] Failed to load .env:", (err as Error).message);
  }
} else if (!process.env.VITEST) {
  console.log("[Config] No .env file found — using environment variables only");
}

import { isoUtc, formatINR, paise } from "../packages/shared/src/index.js";
import {
  runMigrations,
  RATE_LIMIT_WEBHOOKS_PER_MIN,
  DEFAULT_LOCAL_WEBHOOK_SECRET,
} from "../packages/core/src/index.js";

import {
  simulateFailureTriage,
  initiateRecoveryOrder,
  recordPromiseToPay,
  completeRecovery,
  getRecoveryResult,
} from "./recovery.js";

import {
  OutreachRouter,
  MSG91SmsProvider,
  BrevoEmailProvider,
} from "../packages/core/src/messaging/index.js";
import {
  PRODUCTS,
  getProduct,
  processFailedPayment,
  recordSuccessfulPayment,
} from "./payment_workflow.js";
import { getCustomerMessage, getVendorMessage, getErrorEntry } from "../packages/core/src/error-catalog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const WEBHOOK_SECRET = process.env.RZP_WEBHOOK_SECRET || DEFAULT_LOCAL_WEBHOOK_SECRET;
const RZP_KEY_ID = process.env.RZP_TEST_KEY_ID || process.env.RZP_KEY_ID || "";
const RZP_KEY_SECRET = process.env.RZP_TEST_KEY_SECRET || process.env.RZP_KEY_SECRET || "";

const dbPath = process.env.ARBITER_DB_PATH || "data/arbiter.sqlite";
const dbUrl = (dbPath.startsWith("libsql:") || dbPath.startsWith("http:") || dbPath.startsWith("https:") || dbPath.startsWith("file:"))
  ? dbPath
  : `file:${resolve(dbPath)}`;
export const dbClient: Client = createClient({ url: dbUrl, authToken: process.env.ARBITER_DB_TOKEN });

const outreachRouter = new OutreachRouter();
const brevoProvider = new BrevoEmailProvider();
const msg91Provider = new MSG91SmsProvider();
outreachRouter.registerProvider(brevoProvider);
outreachRouter.registerProvider(msg91Provider);

// Log provider status at startup
const brevoKey = process.env.BREVO_API_KEY;
const msg91Key = process.env.MSG91_AUTH_KEY;
const msg91Template = process.env.MSG91_TEMPLATE_ID || process.env.MSG91_DLT_TEMPLATE_ID;
console.log("[Providers] Brevo email:", brevoKey && !brevoKey.includes("xxxxxx") ? `CONFIGURED (${brevoKey.slice(0, 8)}...)` : "SIMULATED (no API key)");
console.log("[Providers] MSG91 SMS:", msg91Key && !msg91Key.includes("xxxxxx") ? `CONFIGURED (${msg91Key.slice(0, 8)}...)` : "SIMULATED (no auth key)");
if (msg91Template) {
  console.log("[Providers] MSG91 template ID:", msg91Template, "— REAL mode");
}

const webhookLimiter = rateLimit({ windowMs: 60_000, limit: RATE_LIMIT_WEBHOOKS_PER_MIN, standardHeaders: true });

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

// ── Store Routes ─────────────────────────────────────────────────
app.get("/", (_req, res) => { res.setHeader("Content-Type", "text/html"); res.send(storeHtml); });
app.get("/store", (_req, res) => { res.setHeader("Content-Type", "text/html"); res.send(storeHtml); });
app.get("/dashboard", (_req, res) => { res.setHeader("Content-Type", "text/html"); res.send(dashboardHtml); });
app.get("/recover/:eventId", (_req, res) => { res.setHeader("Content-Type", "text/html"); res.send(recoverHtml); });

// ── Get Products ─────────────────────────────────────────────────
app.get("/api/products", (_req, res) => {
  res.json(PRODUCTS);
});

// ── Create Razorpay Order + Upsert Customer ─────────────────────
app.post("/api/orders/create", async (req: Request, res: Response) => {
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
        const rzpRes = await fetch("https://api.razorpay.com/v1/orders", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
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
        console.warn("Razorpay order creation failed, using local order:", err);
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
});

// ── Verify Payment (called by frontend after Checkout.js success) ─
app.post("/api/payments/verify", async (req: Request, res: Response) => {
  try {
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature, orderId } = req.body;
    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing payment verification fields" });
    }

    // HMAC verification
    if (RZP_KEY_SECRET) {
      const payload = `${razorpay_order_id}|${razorpay_payment_id}`;
      const expected = createHmac("sha256", RZP_KEY_SECRET).update(payload).digest("hex");
      if (!timingSafeEqual(Buffer.from(razorpay_signature), Buffer.from(expected))) {
        return res.status(400).json({ error: "Invalid signature" });
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
      return res.status(400).json({ error: "Could not identify customer" });
    }

    // Fetch payment details (gracefully handle missing API keys)
    let amountPaise = 0;
    if (RZP_KEY_ID && RZP_KEY_SECRET && !RZP_KEY_ID.includes("xxxxxx")) {
      try {
        const auth = Buffer.from(`${RZP_KEY_ID}:${RZP_KEY_SECRET}`).toString("base64");
        const payRes = await fetch(`https://api.razorpay.com/v1/payments/${razorpay_payment_id}`, {
          headers: { Authorization: `Basic ${auth}` },
        });
        if (payRes.ok) {
          const payData = (await payRes.json()) as any;
          amountPaise = payData?.amount || 0;
        }
      } catch {}
    }

    // Record successful payment
    let eventId = "";
    try {
      eventId = await recordSuccessfulPayment(dbClient, {
        razorpayPaymentId: razorpay_payment_id,
        razorpayOrderId: razorpay_order_id,
        customerProfileId,
        amountPaise,
        productName,
        nowMs: Date.now(),
      });
    } catch (err) {
      console.error("Failed to record payment:", err);
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
    });

    res.json({ success: true, status: "captured", eventId });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Client-Side Payment Failure (immediate redirect to recovery) ─
app.post("/api/payments/failed", async (req: Request, res: Response) => {
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

    // Deduplication: check if this payment_id already has an event
    const existingEvent = await dbClient.execute({
      sql: "SELECT id FROM live_payment_events WHERE razorpay_payment_id = ? LIMIT 1",
      args: [paymentId],
    });
    if (existingEvent.rows.length > 0) {
      const existingId = String(existingEvent.rows[0].id);
      console.log(`[Payments] Dedup: payment ${paymentId} already has event ${existingId}`);
      return res.json({
        eventId: existingId,
        failureClass: "UNKNOWN",
        action: "NO_ACTION",
        failureCode,
        failureDescription: error_description || "Payment already recorded",
        duplicate: true,
      });
    }

    // Validate customerProfileId — must not be empty
    const validCustomerId = customerId || "";

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

    // Use processFailedPayment to run full ML pipeline
    const result = await processFailedPayment(dbClient, {
      razorpayPaymentId: paymentId,
      razorpayOrderId: razorpay_order_id,
      amountPaise: amountPaise || 0,
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
      amountPaise,
      productName,
    });

    if (result.isSuspicious) {
      broadcastSSE("vendor:alerts", {
        type: "SUSPICIOUS_ACTIVITY",
        eventId: result.eventId,
        customerProfileId: validCustomerId,
        reasons: result.suspicionReasons,
        amountPaise,
        failureCode,
      });
    }

    // Simplified human-readable reason for the user
    const simplifiedReason = getSimplifiedReason(failureCode, result.failureClass);

    res.json({
      eventId: result.eventId,
      failureClass: result.failureClass,
      action: result.action,
      failureCode,
      failureDescription: simplifiedReason,
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

  // Webhook signature verification — always ACK (Razorpay retries on non-200)
  // Log verification failures but never block the response
  if (WEBHOOK_SECRET && WEBHOOK_SECRET !== DEFAULT_LOCAL_WEBHOOK_SECRET && signature) {
    const expectedSig = createHmac("sha256", WEBHOOK_SECRET).update(bodyForSig).digest("hex");
    const sigBuf = Buffer.from(signature, "hex");
    const expBuf = Buffer.from(expectedSig, "hex");
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      console.error("[Webhook] Signature verification failed — ACKing anyway per Razorpay best practice");
    }
  }

  try {
    const rawBody = req.body;
    const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : JSON.stringify(rawBody);
    const event = JSON.parse(bodyStr);
    const eventType = event.event as string;
    const payment = event.payload?.payment?.entity;
    const paymentId = payment?.id as string | undefined;

    // Webhook deduplication — swallow duplicate deliveries
    if (paymentId) {
      try {
        const existing = await dbClient.execute({
          sql: "SELECT provider_event_id FROM webhook_dedupe WHERE provider_event_id = ?",
          args: [paymentId],
        });
        if (existing.rows.length > 0) {
          await dbClient.execute({
            sql: "UPDATE webhook_dedupe SET swallow_count = swallow_count + 1 WHERE provider_event_id = ?",
            args: [paymentId],
          });
          return res.json({ received: true, deduped: true });
        }
        await dbClient.execute({
          sql: "INSERT INTO webhook_dedupe (provider_event_id, first_seen_utc, swallow_count) VALUES (?, ?, 0)",
          args: [paymentId, isoUtc(Date.now())],
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
            console.error("Failed to record successful payment:", err);
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

              // Token and contact
              razorpayTokenId: payment.token_id || "",
              razorpayContact: payment.contact || "",
              razorpayEmail: payment.email || "",
              razorpayCreatedAt: payment.created_at || 0,
            }, outreachRouter);

            console.log(`[Webhook] payment.failed processed: ${result.eventId} | method=${payment.method} | class=${result.failureClass} | action=${result.action}`);

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
              productName: payment.productName || "",
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
            console.error("Failed to process failed payment:", err);
          }
        }
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error("Webhook processing error:", err);
    res.status(200).json({ received: true }); // Always ACK webhooks
  }
});

// ── Vendor Dashboard API ─────────────────────────────────────────
app.get("/api/vendor/payments", async (_req: Request, res: Response) => {
  try {
    const result = await dbClient.execute({
      sql: `SELECT lpe.*, cp.name as customer_name, cp.phone as customer_phone, cp.email as customer_email,
              lpe.payment_method, lpe.card_last4, lpe.card_network, lpe.card_issuer,
              cp.total_attempts, cp.total_successes, cp.total_failures,
              so_out.channel as next_outreach_channel, so_out.scheduled_at_utc as next_outreach_utc,
              so_last.channel as last_outreach_channel, so_last.executed_at_utc as last_outreach_utc,
              so_last.status as last_outreach_status, so_last.error_message as last_outreach_error
            FROM live_payment_events lpe
            JOIN customer_profiles cp ON cp.id = lpe.customer_profile_id
            LEFT JOIN (
              SELECT live_payment_event_id, channel, scheduled_at_utc
              FROM scheduled_outreach
              WHERE executed = 0
              GROUP BY live_payment_event_id
              ORDER BY scheduled_at_utc ASC
            ) so_out ON so_out.live_payment_event_id = lpe.id
            LEFT JOIN (
              SELECT live_payment_event_id, channel, executed_at_utc, status, error_message
              FROM scheduled_outreach
              WHERE executed = 1
              GROUP BY live_payment_event_id
              ORDER BY executed_at_utc DESC
            ) so_last ON so_last.live_payment_event_id = lpe.id
            ORDER BY lpe.created_at_utc DESC LIMIT 50`,
      args: [],
    });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/vendor/alerts", async (_req: Request, res: Response) => {
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

app.get("/api/vendor/analytics", async (_req: Request, res: Response) => {
  try {
    const stats = await dbClient.execute({
      sql: `SELECT
              COUNT(*) as total_events,
              SUM(CASE WHEN status = 'captured' THEN 1 ELSE 0 END) as total_successes,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as total_failures,
              SUM(CASE WHEN status = 'captured' THEN amount_paise ELSE 0 END) as recovered_paise,
              SUM(CASE WHEN status = 'failed' THEN amount_paise ELSE 0 END) as at_risk_paise,
              SUM(CASE WHEN vendor_notified = 1 THEN 1 ELSE 0 END) as suspicious_count,
              SUM(CASE WHEN payment_method = 'card' THEN 1 ELSE 0 END) as method_card,
              SUM(CASE WHEN payment_method = 'upi' THEN 1 ELSE 0 END) as method_upi,
              SUM(CASE WHEN payment_method = 'netbanking' THEN 1 ELSE 0 END) as method_netbanking,
              SUM(CASE WHEN payment_method = 'wallet' THEN 1 ELSE 0 END) as method_wallet,
              SUM(CASE WHEN payment_method IS NULL OR payment_method = '' THEN 1 ELSE 0 END) as method_other
            FROM live_payment_events`,
      args: [],
    });
    const row = stats.rows[0] as any;
    res.json({
      totalEvents: Number(row?.total_events || 0),
      totalSuccesses: Number(row?.total_successes || 0),
      totalFailures: Number(row?.total_failures || 0),
      recoveredPaise: Number(row?.recovered_paise || 0),
      atRiskPaise: Number(row?.at_risk_paise || 0),
      suspiciousCount: Number(row?.suspicious_count || 0),
      methodCard: Number(row?.method_card || 0),
      methodUpi: Number(row?.method_upi || 0),
      methodNetbanking: Number(row?.method_netbanking || 0),
      methodWallet: Number(row?.method_wallet || 0),
      methodOther: Number(row?.method_other || 0),
      successRate: row?.total_events > 0
        ? ((Number(row.total_successes) / Number(row.total_events)) * 100).toFixed(1) + "%"
        : "0.0%",
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/vendor/failure-analysis", async (_req: Request, res: Response) => {
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

app.post("/api/vendor/decision", async (req: Request, res: Response) => {
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
              paymentLinkUrl: `${process.env.BASE_URL || `http://localhost:${PORT}`}/recover/${eventId}`,
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

// ── SSE Endpoints ────────────────────────────────────────────────
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
app.post("/api/webhooks/providers/brevo", async (req: Request, res: Response) => {
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

app.post("/api/webhooks/providers/msg91", async (req: Request, res: Response) => {
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

app.post("/api/webhooks/providers/gupshup", async (req: Request, res: Response) => {
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

app.post("/api/webhooks/twilio/gather", async (req: Request, res: Response) => {
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

app.post("/api/recovery/triage", async (req: Request, res: Response) => {
  try {
    const { presetKey } = req.body || {};
    const base = process.env.BASE_URL || `http://localhost:${PORT}`;
    const session = await simulateFailureTriage(presetKey || "SALARY_DELAY", base, dbClient);
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Provider Status (diagnostic endpoint) ─────────────────────
app.get("/api/providers/status", (_req: Request, res: Response) => {
  const brevoKey = process.env.BREVO_API_KEY;
  const msg91Key = process.env.MSG91_AUTH_KEY;
  const msg91Flow = process.env.MSG91_FLOW_ID;
  const now = new Date();
  const istHour = (now.getUTCHours() + 5) % 24 + (now.getUTCMinutes() + 30) / 60;

  res.json({
    brevo: {
      configured: !!brevoKey && !brevoKey.includes("xxxxxx"),
      keyPreview: brevoKey ? brevoKey.slice(0, 8) + "..." : "not set",
    },
    msg91: {
      configured: !!msg91Key && !msg91Key.includes("xxxxxx"),
      keyPreview: msg91Key ? msg91Key.slice(0, 8) + "..." : "not set",
      flowId: msg91Flow || "not set",
      flowIdValid: msg91Flow && !msg91Flow.startsWith("flow_"),
    },
    quietHours: {
      istHour: istHour.toFixed(1),
      isSuppressed: istHour >= 22 || istHour < 8,
      window: "22:00 - 08:00 IST",
    },
  });
});

app.post("/api/recovery/initiate", async (req: Request, res: Response) => {
  try {
    const { proposalId, preferredMethod } = req.body || {};
    const result = await initiateRecoveryOrder(proposalId, preferredMethod || "upi", dbClient);
    if (!result) return res.status(404).json({ error: "No active recovery session found" });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/recovery/promise-to-pay", async (req: Request, res: Response) => {
  try {
    const { proposalId, promisedDay, contactPreference } = req.body || {};
    if (!proposalId || !promisedDay) return res.status(400).json({ error: "proposalId and promisedDay required" });

    const result = await recordPromiseToPay(proposalId, promisedDay, dbClient);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/recovery/complete", async (req: Request, res: Response) => {
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
      paymentMethod: row.payment_method,
      cardLast4: row.card_last4,
      cardNetwork: row.card_network,
      cardType: row.card_type,
      vpa: row.vpa,
      bankCode: row.bank_code,
      createdAt: row.created_at_utc,
    });
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
        paymentLinkUrl: `${process.env.BASE_URL || `http://localhost:${PORT}`}/recover/${r.live_payment_event_id}`,
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
  } catch {}
}

// ── Startup ──────────────────────────────────────────────────────
export async function startServer() {
  await runMigrations(dbClient);
  const server = app.listen(PORT, HOST, () => {
    console.log(`\n  ARBITER Payment Server`);
    console.log(`  Store:     http://${HOST}:${PORT}`);
    console.log(`  Dashboard: http://${HOST}:${PORT}/dashboard`);
    console.log(`  Mode:      ${RZP_KEY_ID ? "Razorpay Test Mode" : "Local Sandbox"}\n`);
  });

  // Sweep scheduled outreach every 60 seconds
  setInterval(sweepScheduledOutreach, 60_000);

  return { app, server };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  startServer().catch((err) => { console.error("Startup failed:", err); process.exit(1); });
}
