# ARBITER

> **Autonomous AI-Driven Revenue Recovery & Dynamic Liquidity Decision Engine**  
> *Razorpay AI Buildathon 2026 — Track 03: AI Revenue Recovery*

---

## 1. The Problem & Inspiration

### The Problem Statement
In Indian digital commerce, payment failures are not anomalies; they are systemic. Across Unified Payments Interface (UPI), Credit/Debit Cards, Netbanking, and Recurring Mandates (eNACH/UPI Autopay), **15% to 30% of checkout attempts fail** before reaching captured status.

Payment failures typically manifest across three systemic vectors:
1. **User Actionable Friction**: Incorrect UPI PINs on PhonePe/Google Pay, session drops at 3D Secure OTP verification screens, or temporary account balance deficits.
2. **Technical & Issuer Congestion**: Sudden bank switch degradation (e.g., core banking switch maintenance at HDFC, ICICI, SBI), gateway timeouts, and NPCI network throttle limits.
3. **Permanent Method Invalidation**: Expired cards, closed bank accounts, international card restrictions on domestic merchant accounts, and cancelled recurring mandates.

When a payment drops, current industry approaches fail:
* **Naive Blind Retries**: Firing background retries against an exhausted card or expired OTP produces consecutive gateway error codes, consumes payment aggregator API quotas, and incurs acquirer decline fees without recovering revenue.
* **Uncoordinated Dunning Spam**: Firing rigid multi-channel blast sequences (SMS, WhatsApp, Email) regardless of whether the failure was an expired card or an issuer outage alienates customers, violates TRAI anti-harassment regulations, and burns messaging cost of goods sold (COGS).
* **High Working Capital Drag (High DSO)**: In SaaS subscriptions and B2B corporate commerce, delayed accounts receivable and mandate rejections directly inflate Days Sales Outstanding (DSO), forcing merchants into expensive short-term working capital debt.

### Inspiration & The Track 03 Bar
The stated bar for **Razorpay AI Buildathon Track 03 (AI Revenue Recovery)** requires:
> *"Show measured money recovered across a batch, with compliant escalation, stopping rules, and an audit trail."*

ARBITER was engineered from first principles to transform payment recovery from a blind batch script into a mathematically grounded, closed-loop decision engine. Instead of treating payment failure as a terminal loss, ARBITER acts as an autonomous financial router that computes optimal interventions, enforces regulatory safety bounds, and preserves net operating margin.

---

## 2. The Solution

ARBITER is an autonomous, approval-gated decision engine designed to operate directly atop Razorpay's payments infrastructure. It unifies real-time checkout telemetry, online contextual bandit reinforcement learning, and a cryptographically verifiable state machine.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                   ARBITER ARCHITECTURE                                 │
└────────────────────────────────────────────────────────────────────────────────────────┘

    [Payment Event Stream] ──────► [22-D Feature Vectorizer]
     (Razorpay Webhooks,            (Failure Taxonomy, Ticket Value,
      Checkout Failures)             Customer LTV, Issuer Health, Payday)
                                             │
                                             ▼
                                 [LinUCB Contextual Bandit]
                                 (Expected Value [EV] Maximizer)
                                             │
                                             ▼
     [Finite State Machine] ◄─── [Strict Regulatory Guardrails]
      - Terminal Success          - TRAI 09:00 - 21:00 IST Quiet Hours
      - Hard Method Dead          - DPDP Act 2023 Identity Anonymization
      - Max Retries Clamping      - RBI 24h Advance Notice Mandates
                                             │
                                             ▼
                                [Targeted Action Execution]
                                 ├── Tier 0: In-Flight Gateway Optimizer
                                 ├── Tier 1: 1-Tap UPI Intent Link (0% MDR)
                                 ├── Tier 2: DLT-Paced SMS / Transactional Email
                                 └── Tier 3: B2B Dynamic Invoice Cash Terms
                                             │
                                             ▼
                             [SHA-256 Tamper-Evident Ledger]
                             (Cryptographic Audit Chaining H_i)
```

ARBITER operates across three distinct business verticals:
1. **D2C E-Commerce & Retail**: Recovers high-intent consumer checkout drop-offs via instant 1-Tap UPI deep links, recovering gross merchandise value (GMV) while bypassing expensive credit card merchant discount rates (MDR arbitrage).
2. **SaaS & Subscription Mandates**: Eliminates involuntary subscriber churn by adhering strictly to the Reserve Bank of India (RBI) 24-hour advance pre-debit notification invariant and scheduling recurring retries at 06:30 AM IST to capitalize on morning liquidity windows.
3. **B2B Receivables & Invoicing**: Employs dynamic 2/10 Net 30 early settlement incentives, compressing Days Sales Outstanding (DSO) and unlocking trapped corporate working capital.

---

## 3. Key Features

* **Closed-Form LinUCB Contextual Bandit**: Selects the optimal recovery arm per transaction using real-time ridge regression with online rank-1 Sherman-Morrison matrix updates.
* **Expected Value (EV) Decision Engine**: Maximizes expected recovered revenue minus channel dispatch costs (COGS) and fee arbitrage, preventing negative-ROI interventions.
* **Tier-0 In-Flight Gateway Optimizer**: Intercepts gateway timeouts and routes to secondary acquirers within sub-second thresholds (<980ms) without customer-facing friction.
* **Fail-Closed Finite State Machine**: Enforces non-negotiable stopping rules: `TERMINAL_SUCCESS`, `HARD_METHOD_DEAD`, `MAX_RETRIES_REACHED`, and `CUSTOMER_OPT_OUT`.
* **TRAI Quiet-Hour Engine**: Automatically buffers outreach between 21:00 and 09:00 IST, preventing telemarketing violations under Telecom Commercial Communications Customer Preference Regulations (TCCCPR).
* **DPDP Act 2023 Compliance**: Zero plain-text personally identifiable information (PII) is stored or logged. Customer credentials are authenticated using salted SHA-256 HMAC tokens.
* **Tamper-Evident SHA-256 Hash Chain**: Every state transition, action dispatch, and payment capture is recorded into an append-only cryptographic ledger where each block references the SHA-256 digest of the predecessor.
* **Longitudinal Behavioral Memory**: Tracks customer payment habits over time, prioritizing high-value recovery candidates via exponential time-decay prioritization.
* **Production CSV Batch Ingestion & 4-Tier Ablation**: Parses real Razorpay failure exports and evaluates performance across Natural Control, Blind Retries, Static 7-Rules, and ARBITER with 95% bootstrap confidence intervals.

---

## 4. Tech Stack

| Layer | Technologies |
| :--- | :--- |
| **Runtime & Language** | Node.js 22+ (LTS), TypeScript 5.9, Express 5 |
| **Database & Persistence** | Libsql / SQLite (ACID compliant, zero-latency embedded mode, monotonic chronological indexing) |
| **Payment Integration** | Razorpay Node.js SDK, Razorpay Optimizer, Razorpay Payment Links, Smart Collect (Virtual VPAs) |
| **Outreach Providers** | MSG91 Flow API v5 (DLT-compliant Indian SMS), Brevo Transactional Email API |
| **AI / Machine Learning** | Closed-form LinUCB Contextual Bandit, 22-D Logistic Regression, Seed-locked PRNG, Bootstrap Resampling |
| **Cryptographic Security** | Node.js `crypto` (HMAC SHA-256, timingSafeEqual, PII-blind credential identifiers) |
| **Front-End Architecture** | Vanilla HTML5 / CSS3 / ES6, Chart.js 4, QRCode.js (zero heavy UI framework overhead) |
| **Test Engineering** | Vitest 3.2, 149 test suites, 959 deterministic automated test cases |

---

## 5. Comprehensive Documentation

### Mathematical Formulations & Decision Theory

#### 1. Expected Value (EV) Objective Function
For each failed payment event $x$ and candidate action $a \in \mathcal{A}$, the expected net recovery value is defined as:

$$\text{EV}(a \mid x) = \mathbb{P}(\text{Recovery} \mid x, a) \cdot \text{TicketPaise} - \text{COGS}(a) + \Delta \text{MDR}(x, a)$$

Where:
* $\mathbb{P}(\text{Recovery} \mid x, a)$ is the calibrated recovery probability estimated by the statistical inference engine.
* $\text{TicketPaise}$ is the gross value of the failed transaction in paise (1 INR = 100 paise).
* $\text{COGS}(a)$ is the direct communication cost of dispatching action $a$:
  $$\text{COGS}(\text{SMS}) = \text{₹}0.18, \quad \text{COGS}(\text{EMAIL}) = \text{₹}0.02, \quad \text{COGS}(\text{IN\_FLIGHT}) = \text{₹}0.00$$
* $\Delta \text{MDR}(x, a)$ represents merchant discount rate arbitrage achieved by converting high-cost payment rails (e.g., Credit Cards at 1.95%) to zero-MDR 1-Tap UPI:
  $$\Delta \text{MDR}(x, \text{UPI}) = \text{TicketPaise} \times 0.0195$$

An action $a$ is approved for execution if and only if:

$$\text{EV}(a \mid x) > 0 \quad \land \quad a \notin \text{SuppressedByStoppingRules}(x)$$

---

#### 2. LinUCB Contextual Bandit (Ridge Regression & Rank-1 Updating)
ARBITER balances exploration of novel recovery interventions with exploitation of historically optimal channels using the Linear Upper Confidence Bound (LinUCB) algorithm.

For each action arm $a$, we assume expected reward is linear in context vector $x \in \mathbb{R}^d$:

$$\mathbb{E}[r_{t,a} \mid x_{t}] = x_{t}^T \theta_a^*$$

Where:
* $d = 5$ (Normalized amount, failure class severity, prior customer response velocity, issuer health score, and payday proximity).
* $A_a = D_a^T D_a + I_d$ is the $d \times d$ covariance ridge regression matrix (initialized to the identity matrix $I_d$).
* $b_a = D_a^T r_a \in \mathbb{R}^d$ is the cumulative reward vector.

##### Closed-Form Parameter Estimation:
The ridge regression coefficient vector $\hat{\theta}_a$ is given by:

$$\hat{\theta}_a = A_a^{-1} b_a$$

##### Upper Confidence Bound Selection Rule:
At each failure event, the arm $a^*$ that maximizes the upper confidence bound is chosen:

$$a^* = \arg\max_{a \in \mathcal{A}} \left( x^T \hat{\theta}_a + \alpha \sqrt{x^T A_a^{-1} x} \right)$$

Where $\alpha > 0$ controls the exploration-exploitation tradeoff parameter ($\alpha = 0.20$ default).

##### Online Rank-1 Sherman-Morrison Updating:
To maintain real-time sub-millisecond execution without expensive matrix inversion ($O(d^3)$), ARBITER updates the inverse covariance matrix $A_a^{-1}$ in $O(d^2)$ time upon receiving feedback reward $r \in \{0, 1\}$:

$$A_{a,\text{new}}^{-1} = A_a^{-1} - \frac{A_a^{-1} x x^T A_a^{-1}}{1 + x^T A_a^{-1} x}$$

$$b_{a,\text{new}} = b_a + r \cdot x$$

---

#### 3. 22-Dimensional Structural Scoring Model
ARBITER extracts a normalized 22-dimensional feature vector $x \in \mathbb{R}^{22}$ from incoming payment failure payloads:

$$\hat{y} = \sigma \left( \sum_{i=1}^{22} w_i \left( \frac{x_i - \mu_i}{\sigma_i} \right) + \beta \right) = \frac{1}{1 + \exp\left( - \left( w^T \hat{x} + \beta \right) \right)}$$

The feature space spans:
* **Failure Classification (One-Hot)**: `f_class_soft`, `f_class_hard`, `f_class_network`, `f_class_risk`.
* **Behavioral & Temporal**: `near_payday`, `payday_confidence`, `amount_z`, `prior_success_norm`, `prior_failure_norm`, `channel_responsiveness`, `tenure_norm`, `ltv_paise_norm`, `churn_risk_norm`, `days_since_last_attempt_norm`, `high_value_tier`.
* **Payment Method Rails**: `is_card`, `is_upi`, `is_netbanking`, `is_wallet`, `is_emi`, `is_debit_card`, `is_international`.

For severe fraud or high-risk flags (`f_class_risk`), the weight vector imposes a decisive negative coefficient ($w_{\text{risk}} = -3.50$), suppressing automated recovery outreach to $\mathbb{P} < 0.05$ and triggering fail-closed isolation.

---

#### 4. Priority Queue & Exponential Engagement Decay
In high-throughput environments, outbound recovery dispatches are scheduled via a priority queue that decays over time. The urgency of customer re-engagement decreases exponentially as the cart or checkout session goes cold:

$$\text{Priority}(x, t) = \text{EV}(x) \cdot \exp\left( -\lambda \cdot \Delta t \right) \cdot \mu_{\text{domain}}$$

Where:
* $\Delta t$ is the elapsed time in minutes since the initial payment failure.
* $\lambda$ is the half-life decay parameter ($\lambda = 0.015$, corresponding to an engagement half-life of ~46 minutes).
* $\mu_{\text{domain}}$ is the domain urgency multiplier:
  $$\mu_{\text{D2C}} = 1.20, \quad \mu_{\text{SaaS}} = 1.00, \quad \mu_{\text{B2B}} = 0.85$$

---

#### 5. Cryptographic SHA-256 Tamper-Evident Audit Ledger
To guarantee full regulatory accountability and satisfy bank audit requirements, every lifecycle action produces an immutable block chained cryptographically:

$$H_0 = \text{"GENESIS"}$$

$$H_i = \text{SHA256}\Big( H_{i-1} \parallel \text{EntryID}_i \parallel \text{EventType}_i \parallel \text{EntityID}_i \parallel \text{Actor}_i \parallel \text{PayloadJSON}_i \parallel \text{CreatedAtUTC}_i \Big)$$

Ledger verification proceeds sequentially:
$$\forall i \ge 1, \quad H_i \stackrel{?}{=} \text{SHA256}\Big( H_{i-1} \parallel \text{EntryData}_i \Big)$$

If any single record, timestamp, or payload is modified in the database, the hash chain breaks from that entry forward ($H_k \neq \text{prev\_hash}_{k+1}$), immediately alerting operators.

---

#### 6. B2B Working Capital & DSO Reduction
For corporate accounts receivable, early cash settlement reduces financing costs. The working capital savings achieved by accelerating Days Sales Outstanding (DSO) are computed as:

$$\Delta \text{CostOfDebt} = \text{InvoiceAmount} \cdot \left( \frac{\Delta \text{DSO}}{365} \right) \cdot r_{\text{borrowing}}$$

Where:
* $\Delta \text{DSO} = \text{DSO}_{\text{standard}} - \text{DSO}_{\text{early}}$ (typically $42 \text{ days} - 8 \text{ days} = 34 \text{ days}$).
* $r_{\text{borrowing}}$ is the merchant's annualized short-term borrowing rate (assumed at 14.0% p.a.).

---

#### 7. Non-Circular Empirical Bootstrap Confidence Intervals
When benchmarking recovery lift across batch data, ARBITER calculates 95% confidence intervals using non-parametric bootstrap resampling:

For $B = 200$ resamples of size $N$:
$$\bar{\theta}^{(b)} = \frac{1}{N} \sum_{i=1}^N r_i^{*(b)}$$

$$\text{CI}_{95\%} = \Big[ \text{Quantile}_{0.025}\big(\{\bar{\theta}^{(b)}\}\big), \quad \text{Quantile}_{0.975}\big(\{\bar{\theta}^{(b)}\}\big) \Big]$$

This ensures that reported recovery rates are accompanied by rigorous statistical confidence bounds.

---

## 6. Verification & Getting Started

### Prerequisites
* Node.js $\ge 22.0.0$
* pnpm $\ge 10.0.0$

### Installation
```bash
git clone https://github.com/AdityaAgrawal08/Razorpay-Hackathon.git
cd Razorpay-Hackathon
pnpm install
```

### Environment Configuration
Copy the example environment configuration:
```bash
cp .env.example .env
```
Key configuration parameters:
* `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`: Razorpay API test-mode credentials.
* `MSG91_AUTH_KEY`, `MSG91_FLOW_ID`: MSG91 Flow API configuration for Indian SMS delivery.
* `BREVO_API_KEY`: Brevo Transactional Email credentials.
* `PORT`: Application server port (default `3000`).

### Running the System
```bash
# Start the production server
pnpm start

# Run the live interactive terminal demo
pnpm demo

# Execute real batch recovery measurement script
npx tsx scripts/run_real_batch_recovery.ts
```

### Accessing Interfaces
* **Customer Storefront**: `http://localhost:3000/store`
* **Merchant Command Center**: `http://localhost:3000/dashboard`
* **Customer 1-Tap Recovery Portal**: `http://localhost:3000/recover/:eventId`

---

## 7. License & Compliance Statement
This project is developed exclusively for the **Razorpay AI Buildathon 2026**.  
Engineered in compliance with RBI Digital Payment Guidelines, NPCI UPI Procedural Guidelines, TRAI TCCCPR Regulations, and the Digital Personal Data Protection (DPDP) Act 2023.
