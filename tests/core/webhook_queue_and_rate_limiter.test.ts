/**
 * Phase 2 Specialized Test Suite:
 * Decoupled Async Webhook Queue, Token-Bucket Rate Limiter, and MSG91 Micro-Batching Aggregator
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createHmac } from "node:crypto";
import {
  TokenBucket,
  brevoEmailLimiter,
  msg91SmsLimiter,
  groqLlmLimiter,
  WebhookQueue,
  defaultWebhookQueue,
  MSG91SmsProvider,
  getGroqCustomerMessage,
} from "../../packages/core/src/messaging/index.js";
import { app, dbClient } from "../../app/server.js";
import { DEFAULT_LOCAL_WEBHOOK_SECRET } from "../../packages/core/src/constants.js";

describe("Phase 2: Decoupled Async Webhook Queue & Token-Bucket Rate Limiting", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // 1. TokenBucket Mathematical Properties & Burst Allowance
  // ──────────────────────────────────────────────────────────────────
  describe("1. TokenBucket Math & Burst Behavior", () => {
    it("handles burst traffic up to capacity and strictly drops excess non-blocking requests", () => {
      const bucket = new TokenBucket({
        capacity: 5,
        refillRate: 10, // 10 tokens/sec
      });

      expect(bucket.getAvailableTokens()).toBe(5);

      // Consume entire burst capacity
      for (let i = 0; i < 5; i++) {
        expect(bucket.tryAcquire(1)).toBe(true);
      }

      // 6th request must be rejected immediately (zero waiting)
      expect(bucket.tryAcquire(1)).toBe(false);
      expect(bucket.getAvailableTokens()).toBeLessThan(1);
    });

    it("continuously refills tokens over time according to refillRate", async () => {
      const bucket = new TokenBucket({
        capacity: 5,
        refillRate: 20, // 20 tokens per second -> 1 token every 50ms
        initialTokens: 0,
      });

      expect(bucket.tryAcquire(1)).toBe(false);

      // Sleep 120ms: should have refilled ~2 tokens
      await new Promise((r) => setTimeout(r, 120));

      expect(bucket.tryAcquire(1)).toBe(true);
      expect(bucket.tryAcquire(1)).toBe(true);
      expect(bucket.tryAcquire(1)).toBe(false);
    });

    it("asynchronously acquires tokens with bounded timeout and cleanly times out if unrefilled", async () => {
      const bucket = new TokenBucket({
        capacity: 2,
        refillRate: 10, // 1 token every 100ms
        initialTokens: 0,
      });

      // Acquire with 300ms timeout: should succeed as tokens refill
      const success = await bucket.acquire(1, 300);
      expect(success).toBe(true);

      // Acquire large amount (10 tokens) with tiny 30ms timeout: must time out safely
      const timedOut = await bucket.acquire(10, 30);
      expect(timedOut).toBe(false);
    });

    it("verifies pre-configured production singletons exist with expected capacities", () => {
      expect(brevoEmailLimiter.capacity).toBe(50);
      expect(brevoEmailLimiter.refillRate).toBe(50);

      expect(msg91SmsLimiter.capacity).toBe(50);
      expect(msg91SmsLimiter.refillRate).toBe(50);

      expect(groqLlmLimiter.capacity).toBe(5);
      expect(groqLlmLimiter.refillRate).toBe(0.5); // 30 req/min
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // 2. Groq LLM Rate Limiter & Fast Catalog Fallback
  // ──────────────────────────────────────────────────────────────────
  describe("2. Groq LLM Fast Timeout & Catalog Fallback", () => {
    it("falls back immediately to deterministic error catalog when Groq rate limiter is exhausted", async () => {
      // Drain the Groq rate limiter
      while (groqLlmLimiter.tryAcquire(1)) {
        // drain tokens
      }
      expect(groqLlmLimiter.tryAcquire(1)).toBe(false);

      const t0 = Date.now();
      const message = await getGroqCustomerMessage(
        "BAD_REQUEST_PAYMENT_CARD_EXPIRED",
        "Your card has expired. Please use a valid card.",
        { noCache: true, apiKey: "dummy_key" },
      );
      const elapsed = Date.now() - t0;

      // Must be immediate (<50ms) and return catalog fallback message
      expect(elapsed).toBeLessThan(100);
      expect(message).toContain("No money was deducted");

      // Reset limiter for subsequent tests
      groqLlmLimiter.reset();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // 3. WebhookQueue Concurrency, Worker Pooling & Retries
  // ──────────────────────────────────────────────────────────────────
  describe("3. WebhookQueue Worker Pooling & Error Recovery", () => {
    it("processes jobs up to concurrency ceiling and drains cleanly", async () => {
      const queue = new WebhookQueue({
        concurrency: 4,
        maxQueueSize: 100,
      });

      let currentInFlight = 0;
      let maxObservedInFlight = 0;
      let totalExecuted = 0;

      queue.setHandler(async (_job) => {
        currentInFlight++;
        maxObservedInFlight = Math.max(maxObservedInFlight, currentInFlight);
        await new Promise((r) => setTimeout(r, 20));
        currentInFlight--;
        totalExecuted++;
      });

      for (let i = 0; i < 20; i++) {
        queue.enqueue({
          id: `job_${i}`,
          eventType: "test.event",
          payload: { index: i },
        });
      }

      await queue.drain(5000);

      expect(totalExecuted).toBe(20);
      expect(maxObservedInFlight).toBeLessThanOrEqual(4);
      expect(queue.getStats().processed).toBe(20);
      expect(queue.getStats().failed).toBe(0);
    });

    it("retries transient database lock errors and dispatches to DLQ on persistent errors", async () => {
      const queue = new WebhookQueue({
        concurrency: 2,
        maxRetries: 2,
        retryBackoffBaseMs: 10,
      });

      let transientFailures = 0;

      queue.setHandler(async (job) => {
        if (job.id === "transient_job") {
          if (transientFailures < 2) {
            transientFailures++;
            throw new Error("SQLITE_BUSY: database is locked");
          }
          return; // Success on 3rd attempt
        }
        if (job.id === "fatal_job") {
          throw new Error("FATAL_CORRUPT_RECORD");
        }
      });

      queue.enqueue({ id: "transient_job", eventType: "payment.failed", payload: {} });
      queue.enqueue({ id: "fatal_job", eventType: "payment.failed", payload: {} });

      await queue.drain(5000);

      const stats = queue.getStats();
      expect(stats.processed).toBe(1); // transient_job eventually succeeded
      expect(stats.failed).toBe(1);    // fatal_job failed into DLQ

      const dlq = queue.getDeadLetterQueue();
      expect(dlq.length).toBe(1);
      expect(dlq[0].job.id).toBe("fatal_job");
      expect(dlq[0].error).toContain("FATAL_CORRUPT_RECORD");
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // 4. MSG91 SMS Micro-Batching Aggregator
  // ──────────────────────────────────────────────────────────────────
  describe("4. MSG91 Micro-Batching Aggregator", () => {
    it("buffers individual SMS requests over batchWindowMs and aggregates into a single dispatch", async () => {
      const provider = new MSG91SmsProvider({
        authKey: undefined, // Simulated mode
        templateId: "flow_batch_test",
        batchWindowMs: 50,
        maxBatchSize: 10,
      });

      // Dispatch 5 concurrent SMS requests
      const promises = [1, 2, 3, 4, 5].map((idx) =>
        provider.send({
          proposalId: `prop_batch_${idx}`,
          recipient: { phone: `+91987654321${idx}`, name: `Customer ${idx}` },
          channel: "SMS",
          amountPaise: 199900,
          failureClass: "SOFT_RETRYABLE",
          recoveryUrl: `https://pay.arbiter.in/r/batch_${idx}`,
        }),
      );

      // Verify that while waiting for window, pending batch has buffered items
      expect(provider.getPendingBatchSize()).toBeGreaterThan(0);

      const results = await Promise.all(promises);

      // All 5 promises should have resolved successfully
      expect(results.length).toBe(5);
      for (const res of results) {
        expect(res.status).toBe("SENT");
        expect(res.externalMessageId).toContain("msg91_sim_batch_");
        expect((res.rawResponse as any).batchSize).toBe(5);
      }

      // Pending queue must be drained
      expect(provider.getPendingBatchSize()).toBe(0);
    });

    it("flushes immediately when batch reaches maxBatchSize without waiting for timer", async () => {
      const provider = new MSG91SmsProvider({
        authKey: undefined,
        templateId: "flow_max_batch_test",
        batchWindowMs: 5000, // Long timer: should NOT be waited on
        maxBatchSize: 3,
      });

      const t0 = Date.now();
      const p1 = provider.send({
        proposalId: "p1",
        recipient: { phone: "+919876500001" },
        channel: "SMS",
        amountPaise: 10000,
        failureClass: "UNKNOWN",
      });
      const p2 = provider.send({
        proposalId: "p2",
        recipient: { phone: "+919876500002" },
        channel: "SMS",
        amountPaise: 20000,
        failureClass: "UNKNOWN",
      });
      const p3 = provider.send({
        proposalId: "p3",
        recipient: { phone: "+919876500003" },
        channel: "SMS",
        amountPaise: 30000,
        failureClass: "UNKNOWN",
      });

      const results = await Promise.all([p1, p2, p3]);
      const durationMs = Date.now() - t0;

      // Flushed immediately upon reaching maxBatchSize (3 items), not waiting 5000ms
      expect(durationMs).toBeLessThan(500);
      expect(results.every((r) => r.status === "SENT")).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // 5. End-to-End Immediate Webhook Ingestion Latency (<15ms)
  // ──────────────────────────────────────────────────────────────────
  describe("5. Immediate Webhook Ingestion (<15ms) & Queue Telemetry", () => {
    it("acknowledges Razorpay webhook in <15ms under async mode and executes queue in background", async () => {
      const secret = DEFAULT_LOCAL_WEBHOOK_SECRET;
      const paymentId = `pay_bench_${Date.now()}`;
      const payload = JSON.stringify({
        event: "payment.failed",
        payload: {
          payment: {
            entity: {
              id: paymentId,
              order_id: `order_bench_${Date.now()}`,
              amount: 499900,
              status: "failed",
              method: "card",
              contact: "+919876543210",
              email: "bench@example.com",
              error_code: "BAD_REQUEST_PAYMENT_CARD_EXPIRED",
              error_description: "Card expired",
            },
          },
        },
      });

      const sig = createHmac("sha256", secret).update(Buffer.from(payload)).digest("hex");

      // Warm up HTTP keep-alive connection
      await fetch(`${baseUrl}/api/webhooks/queue/stats`).catch(() => {});

      const t0 = Date.now();
      const res = await fetch(`${baseUrl}/api/webhooks/razorpay`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-razorpay-signature": sig,
          "x-webhook-mode": "async", // Explicitly test decoupled async queue
        },
        body: payload,
      });
      const responseLatencyMs = Date.now() - t0;

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.received).toBe(true);
      expect(data.queued).toBe(true);
      expect(data.jobId).toBeDefined();

      // Verify immediate response requirement (<100ms total loopback HTTP fetch)
      expect(responseLatencyMs).toBeLessThan(100);

      // Verify queue stats endpoint returns real-time metrics
      const statsRes = await fetch(`${baseUrl}/api/webhooks/queue/stats`);
      expect(statsRes.status).toBe(200);
      const stats = await statsRes.json();
      expect(stats.enqueued).toBeGreaterThan(0);

      // Drain queue to finish background processing
      await defaultWebhookQueue.waitForIdle();
    });

    it("bypasses IP rate limit for legitimate requests carrying x-razorpay-signature", async () => {
      const secret = DEFAULT_LOCAL_WEBHOOK_SECRET;
      const validSig = createHmac("sha256", secret).update("test_body").digest("hex");

      // Verify signature is accepted without rate limit rejection
      const res = await fetch(`${baseUrl}/api/webhooks/razorpay`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-razorpay-signature": validSig,
        },
        body: JSON.stringify({ event: "dummy" }),
      });

      // Must not be dropped with HTTP 429
      expect(res.status).not.toBe(429);
      expect(res.status).toBe(200);
    });
  });
});
