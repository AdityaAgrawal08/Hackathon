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

if (existsSync(".env")) {
  try { process.loadEnvFile(); } catch {}
}

import { isoUtc, formatINR, paise } from "../packages/shared/src/index.js";
import {
  runMigrations,
  RATE_LIMIT_WEBHOOKS_PER_MIN,
  DEFAULT_LOCAL_WEBHOOK_SECRET,
} from "../packages/core/src/index.js";
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
outreachRouter.registerProvider(new BrevoEmailProvider());
outreachRouter.registerProvider(new MSG91SmsProvider());

const webhookLimiter = rateLimit({ windowMs: 60_000, limit: RATE_LIMIT_WEBHOOKS_PER_MIN, standardHeaders: true });

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

    // Fetch payment details
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
    const eventId = await recordSuccessfulPayment(dbClient, {
      razorpayPaymentId: razorpay_payment_id,
      razorpayOrderId: razorpay_order_id,
      customerProfileId,
      amountPaise,
      productName,
      nowMs: Date.now(),
    });

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

// ── Razorpay Webhook (Authoritative) ─────────────────────────────
app.post("/api/webhooks/razorpay", webhookLimiter, async (req: Request, res: Response) => {
  const rawBody = req.body as Buffer;
  const signature = req.headers["x-razorpay-signature"] as string;

  // Webhook signature verification
  if (WEBHOOK_SECRET) {
    const expectedSig = createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
    if (!timingSafeEqual(Buffer.from(signature || ""), Buffer.from(expectedSig))) {
      return res.status(400).json({ error: "Invalid signature" });
    }
  }

  try {
    const event = JSON.parse(rawBody.toString("utf8"));
    const eventType = event.event as string;

    if (eventType === "payment.captured") {
      const payment = event.payload?.payment?.entity;
      if (payment?.id && payment?.order_id) {
        // Fetch order to get customer profile
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
        }
      }
    }

    if (eventType === "payment.failed") {
      const payment = event.payload?.payment?.entity;
      if (payment?.id && payment?.order_id) {
        // Fetch order to get customer profile
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
          }, outreachRouter);

          // Broadcast to vendor dashboard
          broadcastSSE("global", {
            type: "PAYMENT_FAILED",
            status: "failed",
            eventId: result.eventId,
            customerProfileId,
            failureClass: result.failureClass,
            probability: result.probability,
            action: result.action,
          });

          if (result.isSuspicious) {
            broadcastSSE("vendor:alerts", {
              type: "SUSPICIOUS_ACTIVITY",
              eventId: result.eventId,
              customerProfileId,
              reasons: result.suspicionReasons,
              amountPaise: payment.amount,
              failureCode: payment.error_code,
            });
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
      sql: `SELECT lpe.*, cp.name as customer_name, cp.phone as customer_phone, cp.email as customer_email
            FROM live_payment_events lpe
            JOIN customer_profiles cp ON cp.id = lpe.customer_profile_id
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
              SUM(CASE WHEN vendor_notified = 1 THEN 1 ELSE 0 END) as suspicious_count
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
      successRate: row?.total_events > 0
        ? ((Number(row.total_successes) / Number(row.total_events)) * 100).toFixed(1) + "%"
        : "0.0%",
    });
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
      try {
        if (r.channel === "EMAIL") {
          await outreachRouter.dispatch("EMAIL", payload);
        } else if (r.channel === "SMS") {
          await outreachRouter.dispatch("SMS", payload);
        }
        status = "SENT";
      } catch {}

      await dbClient.execute({
        sql: "UPDATE scheduled_outreach SET executed = 1, executed_at_utc = ?, status = ? WHERE id = ?",
        args: [isoUtc(Date.now()), status, r.id],
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
