# ARBITER: Mathematical & Algorithmic Specification

This document provides the formal mathematical formulations, reinforcement learning algorithms, statistical proofs, and cryptographic verification specifications powering **ARBITER** (Razorpay AI Buildathon 2026 — Track 03: AI Revenue Recovery).

---

## 1. Expected Value (EV) Decision Formulation

Every payment failure evaluated by ARBITER is treated as an economic optimization problem. For an incoming payment failure event $x$ and candidate intervention action $a \in \mathcal{A}$, the expected net recovery value $\text{EV}(a \mid x)$ in paise (where $1\text{ INR} = 100\text{ paise}$) is defined as:

$$\text{EV}(a \mid x) = \mathbb{P}(\text{Recovery} \mid x, a) \cdot \text{TicketPaise}(x) - \text{COGS}(a) + \Delta \text{MDR}(x, a)$$

### Component Definitions

1. **Recovery Probability $\mathbb{P}(\text{Recovery} \mid x, a) \in [0, 1]$**:
   The calibrated probability that intervention $a$ recovers the transaction, inferred jointly by the 22-dimensional logistic feature scorer and the upper confidence bound of the contextual bandit.

2. **Gross Ticket Value $\text{TicketPaise}(x)$**:
   The gross transaction amount at risk in paise.

3. **Cost of Goods Sold $\text{COGS}(a)$**:
   The marginal provider communication cost incurred to dispatch the action:
   $$\text{COGS}(\text{SMS}) = \text{₹}0.18 \quad (18\text{ paise})$$
   $$\text{COGS}(\text{EMAIL}) = \text{₹}0.02 \quad (2\text{ paise})$$
   $$\text{COGS}(\text{IN-FLIGHT}) = \text{₹}0.00 \quad (0\text{ paise})$$

4. **Payment Rail Fee Arbitrage $\Delta \text{MDR}(x, a)$**:
   When ARBITER converts an expensive credit card transaction ($1.95\%$ MDR) into a zero-fee UPI recovery link ($0.00\%$ MDR for P2M transactions under ₹2,000, or capped Interchange):
   $$\Delta \text{MDR}(x, \text{UPI}) = \text{TicketPaise}(x) \times 0.0195$$

### Optimization & Execution Criteria
An action $a^*$ is approved for automated dispatch if and only if:

$$a^* = \arg\max_{a \in \mathcal{A}} \text{EV}(a \mid x)$$

$$\text{subject to} \quad \text{EV}(a^* \mid x) > 0 \quad \land \quad a^* \notin \text{SuppressedByStoppingRules}(x)$$

If all candidate actions yield $\text{EV} \le 0$ or are suppressed by safety bounds, the engine defaults to **Fail-Closed Isolation** (no outreach dispatched, zero wasted merchant capital).

---

## 2. LinUCB Contextual Bandit with Rank-1 Online Updating

To navigate the exploration-vs-exploitation tradeoff across recovery channels, ARBITER implements the **Linear Upper Confidence Bound (LinUCB)** algorithm with disjoint linear models.

### Context Representation
For each transaction, a $d$-dimensional feature vector $x_t \in \mathbb{R}^d$ ($d = 5$) is synthesized:
1. Normalized Ticket Amount: $x^{(1)} = \min(1.0, \text{Amount} / 25000)$
2. Failure Class Severity: $x^{(2)} \in \{0.1 \text{ (Soft)}, 0.5 \text{ (Network)}, 0.9 \text{ (Hard)}\}$
3. Customer Response Velocity: $x^{(3)} \in [0, 1]$ (historical response rate)
4. Bank Switch Health Index: $x^{(4)} \in [0, 1]$ (real-time rolling success rate)
5. Payday Proximity Flag: $x^{(5)} \in \{0, 1\}$ (calendar day $\in [28, 31] \cup [1, 5]$)

### Arm Action Space $\mathcal{A}$
* $\text{Arm } 0$: `IN_FLIGHT_OPTIMIZER` (Instant gateway re-route)
* $\text{Arm } 1$: `SMS_1TAP_UPI` (DLT SMS with 1-Tap UPI Intent)
* $\text{Arm } 2$: `EMAIL_RECOVERY_LINK` (Transactional Email with Payment Link)
* $\text{Arm } 3$: `B2B_EARLY_DISCOUNT` (2/10 Net 30 Cash Settlement Term)

### Mathematical Mechanics
For each arm $a \in \mathcal{A}$:
* $A_a \in \mathbb{R}^{d \times d}$: Regularized covariance matrix, initialized to the identity matrix $I_d$.
* $b_a \in \mathbb{R}^d$: Cumulative response reward vector, initialized to $\mathbf{0}_d$.

#### Parameter Estimation
The ridge regression coefficient vector $\hat{\theta}_a$ is given in closed form by:

$$\hat{\theta}_a = A_a^{-1} b_a$$

#### Upper Confidence Bound Selection Rule
At each decision step, ARBITER selects the arm maximizing the upper confidence bound:

$$a_t = \arg\max_{a \in \mathcal{A}} \left( x_t^T \hat{\theta}_a + \alpha \sqrt{x_t^T A_a^{-1} x_t} \right)$$

Where $\alpha = 0.20$ governs the exploration variance boundary.

#### Online Rank-1 Sherman-Morrison Updating
Upon observing recovery outcome reward $r_t \in \{0, 1\}$, the inverse covariance matrix $A_a^{-1}$ is updated in $O(d^2)$ time using the **Sherman-Morrison formula**, eliminating expensive matrix inversions ($O(d^3)$):

$$A_{a, \text{new}}^{-1} = A_a^{-1} - \frac{A_a^{-1} x_t x_t^T A_a^{-1}}{1 + x_t^T A_a^{-1} x_t}$$

$$b_{a, \text{new}} = b_a + r_t \cdot x_t$$

---

## 3. 22-Dimensional Structural Scoring Model

ARBITER vectorizes failure payloads into a standardized 22-dimensional feature representation $\mathbf{z} \in \mathbb{R}^{22}$:

$$\mathbb{P}(\text{Success} \mid \mathbf{z}) = \sigma \left( \mathbf{w}^T \mathbf{z} + \beta \right) = \frac{1}{1 + \exp\left( - \left( \sum_{j=1}^{22} w_j z_j + \beta \right) \right)}$$

### Feature Mapping & Calibrated Coefficients

| Index | Feature Key | Category | Weight ($w_j$) | Business Rationale |
| :---: | :--- | :--- | :---: | :--- |
| $z_1$ | `f_class_soft` | Failure Class | $+1.45$ | High recovery probability (OTP delay, minor friction) |
| $z_2$ | `f_class_hard` | Failure Class | $-2.80$ | Dead credentials; automated recovery suppressed |
| $z_3$ | `f_class_network`| Failure Class | $+0.65$ | Temporary bank switch downtime; recover after circuit clears |
| $z_4$ | `f_class_risk` | Failure Class | $-3.50$ | Fraud/risk alert; immediate fail-closed quarantine |
| $z_5$ | `near_payday` | Behavioral | $+0.85$ | Increased customer liquidity during 1st-5th of month |
| $z_6$ | `amount_z` | Economics | $-0.45$ | Larger ticket sizes exhibit higher customer hesitation |
| $z_7$ | `prior_success_norm` | Reputation | $+1.10$ | Past captured orders strongly predict future capture |
| $z_8$ | `prior_failure_norm` | Reputation | $-0.75$ | Habitual drop-offs reduce recovery expectation |
| $z_9$ | `is_upi` | Payment Rail | $+1.20$ | UPI Intent provides lowest friction checkout flow |
| $z_{10}$ | `is_card` | Payment Rail | $-0.30$ | Card 3D Secure requires high cognitive effort |
| $z_{11}$ | `issuer_health` | Rail Telemetry | $+1.50$ | Real-time health index of the issuing bank switch |

---

## 4. Priority Queue & Exponential Engagement Decay

In batch and high-concurrency environments, outbound recovery interventions are prioritized via a dynamic queue governed by exponential engagement decay:

$$\text{Priority}(x, t) = \text{EV}(x) \cdot \exp\left( -\lambda \cdot \Delta t \right) \cdot \mu_{\text{domain}}$$

Where:
* $\Delta t$ is the elapsed time in minutes since the payment failure occurred.
* $\lambda = 0.015$ is the decay parameter ($\text{half-life} \approx 46.2\text{ minutes}$).
* $\mu_{\text{domain}}$ is the domain urgency multiplier:
  * $\mu_{\text{D2C}} = 1.20$ (High cart abandonment perishability)
  * $\mu_{\text{SaaS}} = 1.00$ (Standard recurring subscription window)
  * $\mu_{\text{B2B}} = 0.85$ (Corporate procurement cycle)

---

## 5. Cryptographic SHA-256 Tamper-Evident Audit Ledger

Every transaction state transition, action dispatch, and payment capture produces an immutable ledger entry chained cryptographically via SHA-256:

$$H_0 = \text{"GENESIS"}$$

$$H_i = \text{SHA256}\Big( H_{i-1} \parallel \text{EntryID}_i \parallel \text{EventType}_i \parallel \text{EntityID}_i \parallel \text{Actor}_i \parallel \text{PayloadJSON}_i \parallel \text{TimestampUTC}_i \Big)$$

### Verification Property
The integrity of the entire audit history is verified in $O(N)$ sequential operations:

$$\forall i \in \{1, 2, \dots, N\}: \quad H_i \stackrel{?}{=} \text{SHA256}\Big( H_{i-1} \parallel \text{Data}_i \Big)$$

If any record or timestamp in the database is modified or deleted, the equality fails at block $i$ ($H_{i-1} \neq \text{prevHash}_i$), providing cryptographic proof of tampering.

---

## 6. B2B Working Capital & Days Sales Outstanding (DSO) Formula

For B2B invoices and corporate receivables, early recovery compresses the cash conversion cycle:

$$\Delta \text{CostOfDebt} = \text{InvoiceAmount} \cdot \left( \frac{\text{DSO}_{\text{standard}} - \text{DSO}_{\text{early}}}{365} \right) \cdot r_{\text{borrowing}}$$

### Standard Corporate Parameters
* $\text{DSO}_{\text{standard}} = 42\text{ days}$
* $\text{DSO}_{\text{early}} = 8\text{ days}$ ($\Delta \text{DSO} = 34\text{ days}$)
* $r_{\text{borrowing}} = 14.0\%\text{ per annum}$ (Standard working capital loan rate in India)

$$\text{Annualized Savings per ₹10,00,000 Invoiced} = 10,00,000 \times \left(\frac{34}{365}\right) \times 0.14 = \text{₹}13,041$$

---

## 7. Non-Parametric Bootstrap Confidence Intervals

To guarantee statistical significance when measuring batch recovery lift, ARBITER computes 95% empirical bootstrap confidence intervals:

Given $N$ observed recovery outcomes $\{r_1, r_2, \dots, r_N\}$, we draw $B = 200$ resamples with replacement:

$$\bar{\theta}^{(b)} = \frac{1}{N} \sum_{i=1}^N r_i^{*(b)}, \quad b \in \{1, \dots, B\}$$

$$\text{CI}_{95\%} = \Big[ \text{Quantile}_{0.025}\big(\{\bar{\theta}^{(b)}\}\big), \quad \text{Quantile}_{0.975}\big(\{\bar{\theta}^{(b)}\}\big) \Big]$$

This proves that measured recovery gains are statistically robust and not artefacts of sample variance.
