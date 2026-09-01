# ARBITER — AI Revenue Recovery Engine

**Intelligent payment failure recovery with ML-powered decisions and automated outreach.**

ARBITER detects failed payments via real webhooks, diagnoses root causes via ML, makes EV-optimized recovery decisions, and dispatches personalized outreach — proving measurable revenue recovery vs blind retries.

---

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  Store.html  │────▶│  Payment     │────▶│  Webhook        │
│  Checkout.js │     │  Gateway     │     │  /api/webhooks/ │
└─────────────┘     └──────────────┘     └────────┬────────┘
                                                   │
                     ┌─────────────────────────────┘
                     ▼
        ┌────────────────────────────┐
        │  payment_workflow.ts       │
        │  ┌──────────────────────┐  │
        │  │ 1. Error Extraction  │  │
        │  │ 2. Root-Cause Class  │  │
        │  │ 3. 23-D Feature Vec  │  │
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
| `packages/ml` | 23-D feature extraction, logistic regression scoring, credibility |
| `packages/shared` | Utilities (formatINR, isoUtc, paise) |
| `app/` | Express server, HTML views, payment workflow |

---

## Key Features

- **Real Payment Gateway Integration** — Checkout.js modal, webhook-driven pipeline, test mode
- **ML-Powered Decisions** — 16-dimensional feature vector, calibrated logistic regression, EV optimization
- **Credibility Scoring** — 11-rule composite model detecting suspicious activity before outreach
- **Smart Outreach** — Email (Brevo) + SMS (MSG91) with payday-timed scheduling
- **Webhook Deduplication** — Zero duplicate events from gateway retries
- **Vendor Dashboard** — Real-time SSE feed, suspicious activity queue, approve/reject workflow
- **Immutable Audit Trail** — Every decision logged with SHA-256 hashes
- **493 Tests** — Unit, integration, E2E, concurrency stress, security audit

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
| `RZP_TEST_KEY_ID` | Payment gateway test mode key ID |
| `RZP_TEST_KEY_SECRET` | Payment gateway test mode key secret |
| `RZP_WEBHOOK_SECRET` | Webhook signing secret |
| `BREVO_API_KEY` | Brevo (Sendinblue) API key for email |
| `MSG91_AUTH_KEY` | MSG91 auth key for SMS |

See `.env.example` for the full list.

---

## Demo Flow

### 1. Customer Purchase Flow

1. Open `http://localhost:3000` (Store)
2. Select a product, fill in name/phone/email
3. Checkout.js modal opens
4. In test mode, choose to simulate success or failure
5. On failure, the ML pipeline runs automatically

### 2. ML Pipeline (Automatic)

When a payment fails, the webhook fires and triggers:

1. **Error Extraction** — Payment gateway error envelope parsed
2. **Root-Cause Classification** — 70+ error codes mapped to 5 classes: `SOFT_RETRYABLE`, `HARD_METHOD_DEAD`, `NETWORK_TIMEOUT`, `RISK_FLAGGED`, `UNKNOWN`
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

- **78 test files, 493 tests** — all passing
- E2E payment workflow (store → gateway → webhook → outreach)
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
| `POST` | `/api/orders/create` | Create payment order |
| `POST` | `/api/payments/verify` | Verify payment + HMAC |
| `POST` | `/api/webhooks/razorpay` | Payment webhook (deduplicated) |
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

## Deployment

### Render

1. Push to GitHub
2. Go to [render.com](https://render.com) → New → Blueprint
3. Connect your repo — Render auto-detects `render.yaml`
4. Set environment variables in Render dashboard (secrets are not synced from `render.yaml`):
   - `RZP_TEST_KEY_ID`, `RZP_TEST_KEY_SECRET`, `RZP_WEBHOOK_SECRET`
   - `BREVO_API_KEY`, `MSG91_AUTH_KEY`
   - `ARBITER_DB_PATH` (Turso URL), `ARBITER_DB_TOKEN` (Turso token)
   - `ADMIN_SECRET_KEY`
5. Deploy — build runs `pnpm install + db:migrate`, start runs `pnpm start`

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `ARBITER_DB_PATH` | Turso/libSQL URL or local SQLite path | Yes |
| `ARBITER_DB_TOKEN` | Turso auth token | If using Turso |
| `RZP_TEST_KEY_ID` | Gateway test key ID | Yes |
| `RZP_TEST_KEY_SECRET` | Gateway test key secret | Yes |
| `BREVO_API_KEY` | Brevo transactional email API key | For email outreach |
| `MSG91_AUTH_KEY` | MSG91 SMS API key | For SMS outreach |

---

## What We Tried That Didn't Work

Engineering maturity means publishing negative results. Here's what we tried and measured:

1. **LLM for root-cause diagnosis**: We tested using an LLM to classify failure root causes from error codes. Measured zero delta over simple rule-based classification on synthetic data — same finding as Reflex's公开 admission. The LLM added latency and cost with no accuracy improvement. **Decision: removed from pipeline.**

2. **Rail health signal**: Implemented a simulated payment-rail health score to defer retries during degraded rail periods. Could not measurable impact on recovery timing in controlled batch experiments. The signal was too noisy to be actionable. **Decision: kept as opt-in, not used in default policy.**

3. **Federated learning**: Implemented FedAvg with DP noise across merchant silos. Random silo weights produce random improvement — the simulated local training generates weights that are essentially random, so aggregation adds variance, not signal. **Decision: documented as simulation for demo; removed from production pitch.**

4. **WhatsApp/voice outreach**: Tested WhatsApp (Gupshup) and voice (Twilio) recovery channels. Both require real customer opt-in and DLT template approval in India. Without live merchant data, these channels cannot be demonstrated end-to-end. **Decision: implemented provider abstraction but kept SMS/email as primary channels.**

---

## License

Internal
