# RazorPay Buildathon 2026 — Track 03 Master Implementation Plan
## Comprehensive System Audit, Gap Resolutions, and Winning Strategy Blueprint

> **Notice:** This document is the authoritative master plan created from the 4-subagent deep architectural audit. It outlines every identified issue, exact resolution steps, verification commands, and strategic improvements needed for ARBITER to secure the winning spot in **Track 03: AI Revenue Recovery**.

---

## Executive Summary & Audit Matrix

| System Area | Audit Finding / Issue | Target Resolution | Verification Test Command |
| :--- | :--- | :--- | :--- |
| **1. LinUCB Contextual Bandit** | Bandit model ($A, b$ matrices) is ephemeral in RAM and decoupled from `processFailedPayment` checkout flow. `updateArm()` is never called upon recovery success. | Persist $A, b$ matrices to SQLite table `bandit_state`. Invoke `selectArm()` in checkout flow and `updateArm(action, context, 1.0)` in recovery handler. | `npx vitest run tests/core/enterprise_adapter_and_trainer.test.ts tests/core/contextual_bandit.test.ts` |
| **2. Communication Concurrency & Messaging** | Brevo, MSG91, and Groq are called synchronously inline inside HTTP request handlers. Outbound rate limiting is missing. Webhook limiter drops events at >200 req/min. | Decouple webhooks with immediate `200 OK` (<15ms). Implement in-memory queue + token bucket rate limiter. Support MSG91 multi-recipient micro-batching. | `npx vitest run tests/app/dlr_webhooks.test.ts tests/core/msg91_resilience.test.ts` |
| **3. Database & Dashboard Scalability** | `app/server.ts` omits `PRAGMA busy_timeout` (causes `SQLITE_BUSY`). `/api/vendor/analytics` scans all rows on every call. `GET /api/vendor/payments` has unpaginated `ROW_NUMBER()` scan. | Apply WAL mode & `busy_timeout=5000`. Create `vendor_metrics_summary` table for $O(1)$ analytics. Add index and cursor pagination to payments feed. | `npx vitest run tests/app/dashboard_command_center.test.ts tests/core/transaction_isolation.test.ts` |
| **4. Priority Queue & Re-Planning Daemon** | Priority queue batch sequencer (`batch_sequencer.ts`) is only called for the UI telemetry endpoint. `sweepScheduledOutreach` is a static FIFO query. | Upgrade `sweepScheduledOutreach` daemon to use EV sequencing, TRAI quiet hours (21:00–09:00 IST), and micro-batch pacing. Connect portal interaction beacon to re-planning agent. | `npx vitest run tests/core/batch_sequencer.test.ts tests/core/quiet_hours_ist.test.ts` |
| **5. Buildathon Rubric Alignment & Multi-Domain UI** | Dashboard hidden tabs masked coverage of SaaS Mandates, B2B Invoices, and Optimizer Cascading. Pitch lacks explicit rubric traceability table. | Un-hide all 5 domain cockpits on dashboard. Add Track 03 Bar Traceability Table to `README.md`. Feature negative results (`docs/negative-results.md`) in pitch. | `npx vitest run tests/app/dashboard_multi_domain.test.ts tests/app/dashboard_telemetry_and_cfo_benchmark.test.ts && pnpm test` |

---

## Detailed Action Plan by Component

### Phase 1: LinUCB Contextual Bandit Persistence & Live RL Loop

#### 1.1 Issue Analysis
- `LinUCBBandit` in `packages/core/src/agent/contextual_bandit.ts` implements exact Gauss-Jordan 4×4 & 5×5 matrix inversion.
- **Defects**:
  1. Matrices $A$ and vector $b$ are stored in volatile JavaScript RAM variables. Server restart resets all weights.
  2. `processFailedPayment` (`app/payment_workflow.ts:221`) calls `decide()`, bypassing `LinUCBBandit.selectArm()`.
  3. `onPaymentRecovered` (`app/payment_workflow.ts:878`) never calls `updateArm()`, leaving the online learning loop open.

#### 1.2 Resolution Steps
1. **Database Persistence (`packages/core/src/db/migrations/0024_bandit_state.sql` & `packages/core/src/db/schema.ts`)**:
   - Create table `bandit_state`:
     ```sql
     CREATE TABLE IF NOT EXISTS bandit_state (
       arm_type TEXT NOT NULL,
       action TEXT NOT NULL,
       dimension INTEGER NOT NULL,
       matrix_a_json TEXT NOT NULL,
       vector_b_json TEXT NOT NULL,
       pull_count INTEGER NOT NULL DEFAULT 0,
       total_reward REAL NOT NULL DEFAULT 0.0,
       updated_at_utc TEXT NOT NULL,
       PRIMARY KEY (arm_type, action)
     );
     ```
   - Add `loadFromDb(client)` and `saveToDb(client)` to `LinUCBBandit`. On `app/server.ts` startup, hydrate `defaultEnterpriseBandit`.
2. **Live Checkout Selection (`app/payment_workflow.ts`)**:
   - In `processFailedPayment`, construct 5-D context vector: `[1.0, log(amount), dwellTime, openLatency, successRate]`.
   - Call `defaultEnterpriseBandit.selectArm(context)`.
   - Store chosen action and context in `live_payment_events` (`bandit_action`, `bandit_context_json`).
3. **Reward Feedback Loop (`app/payment_workflow.ts` & `app/recovery.ts`)**:
   - In `recordSuccessfulPayment` / `onPaymentRecovered`, retrieve `bandit_action` and `bandit_context_json`.
   - Calculate reward $r = 1.0$ (or net margin reward).
   - Call `defaultEnterpriseBandit.updateArm(action, context, reward)` and persist to `bandit_state`.

#### 1.3 Verification Test
```bash
npx vitest run tests/core/enterprise_adapter_and_trainer.test.ts tests/core/contextual_bandit.test.ts
```

---

### Phase 2: Decoupled Async Queue & Token-Bucket Rate Limiter

#### 2.1 Issue Analysis
- Razorpay webhook handler `POST /api/webhooks/razorpay` (`app/server.ts:853`) and `POST /api/payments/failed` call Brevo Email, MSG91 SMS, and Groq LLM **synchronously and inline** inside the HTTP request.
- Razorpay has a 5-second webhook timeout. Under a burst of 1,000 requests, socket exhaustion (`EMFILE`) occurs and inbound rate limiter (`app/server.ts:160`) drops 80% of webhooks with HTTP 429.

#### 2.2 Resolution Steps
1. **Immediate Webhook Acknowledgment (<15ms)**:
   - In `POST /api/webhooks/razorpay`, verify HMAC SHA-256 signature, enqueue the raw payload to an in-memory queue (`webhook_queue`), and respond `200 OK { "received": true }` immediately.
   - Exempt verified Razorpay webhooks from the 200/min rate limiter.
2. **Token-Bucket Outbound Rate Limiter (`packages/core/src/messaging/rate_limiter.ts`)**:
   - Implement leaky bucket / token bucket wrappers:
     - Brevo Email: max 50 req/sec.
     - MSG91 SMS: max 50 req/sec.
     - Groq LLM: max 30 req/min with 300ms timeout fallback to local catalog.
3. **MSG91 Micro-Batching Aggregator**:
   - In `MSG91SmsProvider`, buffer outgoing SMS dispatches over a 250ms window into batches of up to 50 recipients in a single HTTP POST request to `/v5/flow`.

#### 2.3 Verification Test
```bash
npx vitest run tests/app/dlr_webhooks.test.ts tests/core/msg91_resilience.test.ts
```

---

### Phase 3: SQLite Concurrency Pragmas & $O(1)$ Metrics Summary

#### 3.1 Issue Analysis
- `app/server.ts:140` creates a raw `@libsql/client` without setting `PRAGMA busy_timeout` (defaults to 0ms). Concurrent writes immediately fail with `SQLITE_BUSY`.
- `/api/vendor/analytics` runs an $O(N)$ full table scan with 10 conditional sums on every call.
- `/api/vendor/payments` runs `ROW_NUMBER() OVER (PARTITION BY ...)` across all historical events without cursor pagination.

#### 3.2 Resolution Steps
1. **Database Pragmas (`app/server.ts`)**:
   - Initialize `dbClient` using `openDb()` or execute:
     ```sql
     PRAGMA journal_mode = WAL;
     PRAGMA busy_timeout = 5000;
     PRAGMA synchronous = NORMAL;
     PRAGMA foreign_keys = ON;
     ```
2. **Atomic Metrics Rollup Table (`vendor_metrics_summary`)**:
   - Create table `vendor_metrics_summary` holding running totals (`total_events`, `total_successes`, `total_failures`, `recovered_paise`, `at_risk_paise`, method breakdown).
   - Atomically increment/decrement counters when payment events change status.
   - `/api/vendor/analytics` returns this single row in <1ms.
3. **Indexes & Keyset Pagination**:
   - Add composite indexes:
     ```sql
     CREATE INDEX IF NOT EXISTS idx_lpe_cust_created ON live_payment_events(customer_profile_id, created_at_utc DESC);
     CREATE INDEX IF NOT EXISTS idx_lpe_alerts ON live_payment_events(vendor_notified, vendor_decision, created_at_utc DESC);
     ```
   - Update `/api/vendor/payments` to accept `limit` (default 50) and `cursor` (created_at_utc timestamp + ID).

#### 3.3 Verification Test
```bash
npx vitest run tests/app/dashboard_command_center.test.ts tests/core/transaction_isolation.test.ts
```

---

### Phase 4: Dynamic Priority Queue Sweeper Daemon & Active Re-Planning

#### 4.1 Issue Analysis
- Priority queue batch sequencer (`sequenceIntelligentRecoveryBatch`) in `packages/core/src/decide/batch_sequencer.ts` is only called for the read-only dashboard API (`/api/decide/priority-queue`).
- Background sweeper `sweepScheduledOutreach` (`app/server.ts:2793`) is a simple FIFO query.
- Portal interaction beacon `/api/events/:eventId/interaction` is not called by frontend.

#### 4.2 Resolution Steps
1. **Intelligent Sweeper Daemon**:
   - Update `sweepScheduledOutreach` to fetch all due outreach items (`scheduled_at_utc <= NOW`), convert to `IntelligentBatchCandidate[]`, run `sequenceIntelligentRecoveryBatch`, and dispatch according to micro-batch pacing and TRAI quiet hours (21:00–09:00 IST).
2. **Customer Portal Telemetry & Re-Planning**:
   - Instrument `app/views/recover.html` to post dwell time and option hover beacons to `/api/events/:eventId/interaction`.
   - Connect `rePlanRecoveryAction` (`packages/core/src/agent/recovery_agent.ts`) to dynamically adjust recovery action (e.g. switch channel from SMS to Email, or present 3-installment downsell).

#### 4.3 Verification Test
```bash
npx vitest run tests/core/batch_sequencer.test.ts tests/core/quiet_hours_ist.test.ts
```

---

### Phase 5: Buildathon Rubric Alignment & Multi-Domain UI Integration

#### 5.1 Issue Analysis
- The dashboard tabs for SaaS Mandates, B2B Invoices, Optimizer Bank Matrix, and Recovery Analytics were hidden during past cleanup, masking ARBITER's coverage of 4 out of 7 Track 03 problem directions.
- Pitch and documentation lack a direct "Rubric Traceability Table".

#### 5.2 Resolution Steps
1. **Multi-Domain Dashboard UI (`app/views/dashboard.html`)**:
   - Restore visible navigation for all 5 enterprise cockpits:
     - 🛒 **D2C Operations & Telemetry** (Live payment failures & 1-tap recovery links)
     - ⚡ **SaaS Mandates** (UPI Autopay / eNACH recurring retries with RBI 24h pre-debit notice proof)
     - 🏢 **B2B Receivables** (Corporate invoicing with 2/10 Net 30 early settlement & Smart Collect Virtual VPAs)
     - 🌐 **Optimizer & Bank Matrix** (Tier-0 in-flight acquirer cascading <1.8s)
     - 📊 **Recovery Analytics & Benchmark** (4-Arm randomized trial with bootstrap 95% CIs)
2. **README Rubric Traceability Table**:
   - Add explicit table mapping official Track 03 criteria ("The Bar", "The Edge", stopping rules, audit trail) directly to code files and passing tests.
3. **Negative Results Presentation**:
   - Emphasize `docs/negative-results.md` in pitch materials, explaining why deterministic catalogs + EV bandits beat non-deterministic LLMs on the critical money path.

#### 5.3 Verification Test
```bash
npx vitest run tests/app/dashboard_multi_domain.test.ts tests/app/dashboard_telemetry_and_cfo_benchmark.test.ts && pnpm -r typecheck && pnpm test
```

---

## Final Monorepo Verification Benchmark
Upon completing all phases, run:
```bash
pnpm -r typecheck
pnpm test
```
**Expected Target:** 100% passing across all 133+ test files (844+ tests, 0 failures), zero TypeScript errors, and zero SQLite busy lock contention.
