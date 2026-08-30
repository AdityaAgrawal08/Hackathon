# ARBITER — AI Revenue Recovery Engine

**Razorpay Buildathon 2026 | Track 03: AI Revenue Recovery**

ARBITER detects failed Razorpay payments via real webhooks, diagnoses root causes via ML, makes EV-optimized recovery decisions, and dispatches personalized outreach — proving measurable revenue recovery vs blind retries.

---

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  Store.html  │────▶│  Razorpay    │────▶│  Webhook        │
│  Checkout.js │     │  Test Mode   │     │  /api/webhooks/ │
└─────────────┘     └──────────────┘     └────────┬────────┘
                                                   │
                     ┌─────────────────────────────┘
                     ▼
        ┌────────────────────────────┐
        │  payment_workflow.ts       │
        │  ┌──────────────────────┐  │
        │  │ 1. Error Extraction  │  │
        │  │ 2. Root-Cause Class  │  │
        │  │ 3. 16-D Feature Vec  │  │
        │  │ 4. ML LogReg Scorer  │  │
        │  │ 5. EV Decision Eng   │  │
        │  │ 6. Credibility Score │  │
        │  └──────────────────────┘  │
        └──────────┬─────────────────┘
                   │
          ┌────────┴────────┐
          ▼                 ▼
   ┌─────────────┐  ┌──────────────┐
   │  Brevo      │  │  MSG91       │
   │  (Email)    │  │  (SMS)       │
   └─────────────┘  └──────────────┘
          │                 │
          ▼                 ▼
   ┌─────────────────────────────┐
   │  Vendor Dashboard (SSE)     │
   │  Live feed + Suspicious     │
   │  alerts + Approve/Reject    │
   └─────────────────────────────┘
```

### Package Structure

| Package | Purpose |
|---------|---------|
| `packages/core` | Decision engine, policy pack, messaging providers, DB schema |
| `packages/ml` | 16-D feature extraction, logistic regression scoring, credibility |
| `packages/shared` | Utilities (formatINR, isoUtc, paise) |
| `app/` | Express server, HTML views, payment workflow |

---

## Key Features

- **Real Razorpay Integration** — Checkout.js modal, webhook-driven pipeline, test mode
- **ML-Powered Decisions** — 16-dimensional feature vector, calibrated logistic regression, EV optimization
- **Credibility Scoring** — 11-rule composite model detecting suspicious activity before outreach
- **Smart Outreach** — Email (Brevo) + SMS (MSG91) with payday-timed scheduling
- **Webhook Deduplication** — Zero duplicate events from Razorpay retries
- **Vendor Dashboard** — Real-time SSE feed, suspicious activity queue, approve/reject workflow
- **Immutable Audit Trail** — Every decision logged with SHA-256 hashes
- **489 Tests** — Unit, integration, E2E, concurrency stress, security audit

---

## Quick Start

```bash
# Install dependencies
pnpm install

# Configure environment (copy and edit)
cp .env.example .env

# Run database migrations
pnpm db:migrate

# Start the server
pnpm dev
```

The server starts at `http://localhost:3000`.

### Required Environment Variables

| Variable | Description |
|----------|-------------|
| `RZP_TEST_KEY_ID` | Razorpay test mode key ID |
| `RZP_TEST_KEY_SECRET` | Razorpay test mode key secret |
| `RZP_WEBHOOK_SECRET` | Razorpay webhook signing secret |
| `BREVO_API_KEY` | Brevo (Sendinblue) API key for email |
| `MSG91_AUTH_KEY` | MSG91 auth key for SMS |

See `.env.example` for the full list.

---

## Demo Flow

### 1. Customer Purchase Flow

1. Open `http://localhost:3000` (Store)
2. Select a product, fill in name/phone/email
3. Razorpay Checkout.js modal opens
4. In test mode, choose to simulate success or failure
5. On failure, the ML pipeline runs automatically

### 2. ML Pipeline (Automatic)

When a payment fails, the webhook fires and triggers:

1. **Error Extraction** — Razorpay error envelope parsed
2. **Root-Cause Classification** — 40+ error codes mapped to 5 classes: `SOFT_RETRYABLE`, `HARD_METHOD_DEAD`, `NETWORK_TIMEOUT`, `RISK_FLAGGED`, `UNKNOWN`
3. **Feature Extraction** — 16-dimensional vector (amount, timing, history, patterns)
4. **ML Scoring** — Logistic regression with calibrated probability
5. **EV Decision** — Expected-value optimization under policy constraints
6. **Credibility Check** — Composite score (11 rules + ML signals) determines if vendor approval needed
7. **Outreach Dispatch** — Email + SMS with payday-timed follow-up schedule

### 3. Vendor Dashboard

Open `http://localhost:3000/dashboard`:

- **Live Payment Feed** — Real-time SSE updates for every payment event
- **Suspicious Activity Queue** — Events flagged by credibility scoring require vendor approval
- **Analytics Cards** — Total events, success/failure counts, recovered revenue, at-risk amount

### 4. Customer Recovery

When outreach is dispatched, customers receive:

- **Immediate** — Email + SMS with payment link
- **+2h** — SMS reminder
- **+24h** — Email follow-up
- **+48h** — SMS reminder
- **+72h** — Final email notice

At any point, if the customer completes payment, all pending outreach is cancelled.

---

## Testing

```bash
# Run all tests
pnpm test

# Run specific test file
pnpm vitest run tests/app/e2e_integration.test.ts
```

### Test Coverage

- **78 test files, 489 tests** — all passing
- E2E payment workflow (store → Razorpay → webhook → outreach)
- Dashboard command center (analytics, alerts, SSE)
- Concurrency stress (10 parallel order creations)
- Security audit (input validation, webhook signature verification)
- ML pipeline determinism (corpus replay)
- Provider abstraction (Brevo, MSG91, Gupshup, Twilio)

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Store page |
| `GET` | `/store` | Store page |
| `GET` | `/dashboard` | Vendor dashboard |
| `GET` | `/recover/:eventId` | Customer recovery page |
| `POST` | `/api/orders/create` | Create Razorpay order |
| `POST` | `/api/payments/verify` | Verify payment + HMAC |
| `POST` | `/api/webhooks/razorpay` | Razorpay webhook (deduplicated) |
| `GET` | `/api/vendor/analytics` | Dashboard analytics |
| `GET` | `/api/vendor/payments` | Payment feed |
| `GET` | `/api/vendor/alerts` | Suspicious activity alerts |
| `POST` | `/api/vendor/decision` | Approve/reject suspicious event |
| `GET` | `/api/sse/:channel` | SSE real-time updates |
| `POST` | `/api/recovery/triage` | Simulate failure triage |
| `POST` | `/api/recovery/initiate` | Initiate recovery order |
| `POST` | `/api/recovery/promise-to-pay` | Record salary-day promise |
| `POST` | `/api/recovery/complete` | Mark recovery as settled |

---

## Buildathon Scoring Criteria

| Criterion | How ARBITER Addresses It |
|-----------|--------------------------|
| **Problem Taste & Depth** | Real Razorpay failure recovery, not generic retry logic |
| **AI Judgment** | ML (logreg) + Rules (policy pack) + GenAI (templates) clearly separated |
| **Failure & Concurrency Resilience** | Zero double-debits via idempotency guards, webhook dedup |
| **The Bar** | 100-event Monte Carlo benchmark with real data proving revenue lift |

---

## License

Internal — Razorpay Buildathon 2026
