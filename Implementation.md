# ARBITER — Hackathon Win Strategy & Implementation Plan

> Competitive / research analysis for the Razorpay AI Buildathon, Track 3 (AI Revenue Recovery).
> Written against the shipped code in `packages/core/src/*` and `packages/ml/src/*`.
> Research sources cited inline.

---

## 1. Blunt Assessment: Can we win Track 3 as-is?

**Short answer: No — not as a *winner*, but yes as a *strong finalist*.** As shipped, ARBITER is a genuinely well-engineered, *auditable* recovery engine, but it is undifferentiated on the single thing judges will reward most: **real recovered money through a real Razorpay surface.**

### What we actually have (strengths)
- A clean closed loop: `webhook/replay → features → score → EV decide → envelope/HITL → deterministic execute → audit`. (`packages/ml/src/pipeline.ts`, `packages/core/src/decide/engine.ts`, `packages/core/src/executor/index.ts`.)
- Integer-paise invariants, injectable clocks, append-only `audit_log`, fail-closed envelope + policy parsing. This is *better engineering hygiene* than most hackathon entries and directly satisfies the brief's "compliant escalation, stopping rules, audit trail." (`packages/core/src/db/schema.ts`, `envelope.ts`, `policy.ts`.)
- A measured-batch report that partitions at-risk revenue into recovered / escalated / stopped (`packages/ml/src/recovery.ts`, proven by `tests/ml/recovery.test.ts`). This literally answers the judging bar.

### Why it is *not* a winner as-is (weak spots)
1. **Execution is simulated.** `deterministicOutcome()` in `executor/index.ts` decides SUCCEEDED/FAILED by looking up a hand-authored multiplier table (`catalog.ts:67`). We never call a real Razorpay API. A judge who asks "show me a real recovered payment" gets a stub. This is the #1 gap.
2. **Data is synthetic.** `packages/seed` generates the corpus; the "measured recovery" is self-fulfilling — it is a function of our own assumed multipliers, not observed outcomes. The control-vs-pipeline lift in `metrics_runs` is produced by our own generator. Honest framing: it is a *simulation*, not a *measurement*.
3. **The "agent" is non-authoritative by design.** Decisioning is an EV model + rules, not an LLM agent. That is actually a *correct* engineering choice (determinism, auditability, no hallucination on the money path) — but it conflicts with the hackathon's "agent" narrative and with Razorpay's own Agent Studio story (see §2). Our `narrative.ts` "Claude case brief" is decorative and explicitly off the money path.
4. **We overlap incumbents squarely.** Razorpay *already ships* Failed Payment Recovery (multichannel WhatsApp/Email/SMS payment links, "recover up to 20%") and Intelligent Payment Retry. Stripe/Adyen/GoCardless/Chargebee/Recurly all ship retry/dunning. Our core loop is a competent re-implementation of what they already do, plus the real integration.


---

## 2. What Wins a Razorpay Hackathon (research-backed)

### 2.1 How the Buildathon is actually judged
- It is a **hiring funnel**, not a pitch contest: "Judged on architecture, code quality, and your ability to explain your build." A complete, working, narrower-scope project beats an ambitious incomplete one. (Source: velonx.in/blog/razorpay-ai-buildathon-2026 — notes student-only, "Build. Show. Get hired.", rewards architecture + repo quality.)
- A competing team's strategy doc states plainly: **"The judges are Razorpay engineers/PMs conducting a hiring evaluation, not investors judging a pitch competition."** (Source: github.com/Avila-Princy-M01/Duebot-AI/blob/main/docs/razorpay-buildathon-strategy.md.)
- Practical wins: clear README, documented setup, a 5-minute rehearsed pitch, and "finish a real project in a narrow scope."

### 2.2 What Razorpay's own surface already covers (so don't re-build it)
Razorpay has been aggressively shipping exactly the Track-3 problem space in 2025–2026:
- **Failed Payment Recovery** (blog Feb 2024, updated 2025): auto-sends personalized **payment links via WhatsApp/Email/SMS** on failure; claims "recover up to 20% of failed payments." (razorpay.com/blog/razorpay-failed-payment-recovery)
- **Intelligent Payment Retry** (Feb 2024): "groundbreaking" retry handling. (razorpay.com/blog/razorpay-intelligent-payment-retry)
- **Optimizer** (payment-orchestration / smart router, gateway-agnostic, random-forest over 1Bn transactions). Routes *new* transactions across PSPs for success rate. (razorpay.com/optimizer-intelligent-payments-routing)
- **UPI Autopay**: "8% more debit collections with intelligent retries," pre-debit notifications, renewal shield, ₹1 mandates. (razorpay.com/upi-autopay)
- **Third Watch** (risk/fraud), **Smart Collect** (NEFT/RTGS/IMPS/UPI collection identifiers), **Payment Links**, **Route**, **Instant Settlements**.
- **Agent Studio** (launched FTX 2026, built on **Anthropic Claude Agent SDK**): "AI agents that automatically detect problems and take action… recover failed subscription payments, resolve disputes, forecast cash flows." (razorpay.com/agent-studio). Razorpay has explicitly said its agents "recover abandoned carts, resolve payment disputes, handle failed subscriptions and forecast cash flows." (outlookbusiness.com — razorpay-using-ai-agents)

**Implication:** A vanilla "retry failed payments with an LLM" entry directly competes with Razorpay's own roadmap and will read as redundant to Razorpay PM-judges. The winning angle is to show something **adjacent or orthogonal** to what Optimizer/Agent Studio do — specifically: (a) the *provable governance* layer (audit, guardrails, measured control-vs-pipeline) that Agent Studio's no-code agents lack, and (b) the novel recovery vectors in §4 that no PSP ships.

### 2.3 What "wow" looks like for this specific judge
- **Real Razorpay touch** (even sandboxed): a Payment Link / UPI Autopay retry API call that actually goes out, with the request ref in the audit log.
- **A hard number with provenance**: "We recovered ₹X of ₹Y at-risk across N events, with Z human escalations, and here is the audit trail + control-arm comparison" — our `recover.ts` already prints this; we just need it to be *real-ish*.
- **India-specificity**: UPI/NACH mandate nuance, payday-aligned retries, Hinglish/regional recovery, rail-health awareness. Generic SaaS dunning does not have this.
- **Defensibility / moat narrative**: federated merchant intelligence, cross-PSP recovery, regulatory auto-escalation — things a single PSP structurally *can't* do.

---

## 3. Competitive Landscape (who does what, and the gaps)

| Player | Ships | Gap vs ARBITER's ambition |
|---|---|---|
| **Razorpay Failed Payment Recovery** | Multichannel payment-link nudges on failure ("up to 20%"). | No EV optimization, no per-failure-class diagnosis, no policy-bounded autonomy envelope, no cross-PSP, no LTV awareness. Our *governance + triage* layer is the differentiator. |
| **Razorpay Intelligent Payment Retry / UPI Autopay retries** | Smart retry timing, pre-debit notifications. | Single-rail (Razorpay only). No "recover via a *different* rail/PSP." No measured control-arm. |
| **Razorpay Optimizer** | Gateway-agnostic *routing of new* transactions via random forest. | Routes **new** auths, not **post-failure recovery** across rails. Does not run an autonomous recovery *agent* with HITL + audit. |
| **Razorpay Agent Studio** | No-code Claude-SDK agents for recovery, disputes, forecasting. | No deep guardrails/audit/measurement; no cross-merchant learning; no regulatory auto-escalation. Our edge = provable governance + novel vectors. |
| **Stripe Smart Retries** | ML retry *timing*; ~38% recovery per some benchmarks; free. (docs.stripe.com/billing/revenue-recovery/smart-retries) | Retry-only, no comms, no customization, black box. Stripe *Orchestration* does cross-processor retries — but engineer-configured, not an autonomous recovery agent. (docs.stripe.com/payments/orchestration/retries) |
| **Stripe Adaptive Acceptance** | Real-time retry of falsely declined txns; "$6B recovered 2024." | False-decline recovery, not failure-class triage + governance. |
| **Adyen / Uplift** | AI optimization of full funnel using global data. | Enterprise, global; not India UPI/mandate-specific; no merchant-level governance agent. |
| **GoCardless** | Direct-debit focus, ~2.2% failure vs 10–15% cards. | Bank-debit only; no card/UPI recovery; no intelligent agent. |
| **Chargebee / Recurly dunning** | Email/SMS sequences, account updater, per-code recovery; 60–80% recovery. (recovamrr.com/blog/stripe-smart-retries-vs-dunning) | Strong on comms; weak on *cross-PSP rail switching*, *federated intelligence*, *real-time rail-health*, *LTV-aware EV*. |
| **Churnkey** | Full retention; ~70% recovery on $3B volume. | SaaS-segmented; not India/PSP-agnostic; no audit-governance layer. |
| **Rely / Rezoki / StayPaid** | AI email + **voice** + ML retries, 5-min Stripe webhook setup. | Voice dunning exists as *comms*; none integrate failure-class diagnosis + EV + policy + audit into one agent. |
| **Gupshup / JustCall / Caller Digital / CallMissed** | Multilingual **Hinglish/regional voice + WhatsApp** dunning; 22 Indian languages, code-switching. (callmissed.com, gupshup.ai/whatsapp-api) | Pure communications channels. They are *instruments*, not the *brain*. The integration of voice/WhatsApp into a governed, failure-aware, EV-optimized agent is open. |
| **Payment orchestrators (Primer, Gr4vy, Spreedly)** | Cross-PSP failover/routing, idempotency, network-token retry. (gr4vy.com/posts/payment-retry-logic-explained) | They route *new* attempts across PSPs; they do **not** autonomously decide *post-failure* to recover a Razorpay failure via a secondary rail as a policy-bounded agent. |

**The pattern:** incumbents own (a) retry timing, (b) dunning comms, (c) new-txn routing. Nobody owns a **governed, cross-PSP, merchant-intelligence-augmented recovery agent** with a real audit trail. That is the white space.

---

## 4. Novel Angles No Payment Company Has (the moat)

Each is stress-tested for "does anyone already do this?" and mapped to existing modules.

### 4.1 Cross-PSP / cross-rail recovery orchestration
- **What:** When a Razorpay payment fails (e.g., UPI Autopay mandate declined), ARBITER can recover it by retrying through a *different rail the merchant also owns* — a Razorpay Payment Link over cards, a Smart Collect bank transfer, or a secondary PSP wired via Optimizer.
- **Why novel:** Optimizer and Stripe Orchestration route *new* auths; they do not autonomously recover a *failed* Razorpay charge via a different rail as a policy-bounded agent. Primer/Gr4vy own the plumbing but not the recovery *decisioning*.
- **Why incumbents can't easily copy:** A PSP won't preferentially route *away* from itself; a neutral recovery agent can. Defensibility = multi-PSP integrations + Optimizer partnership narrative.
- **Impl sketch:** Add `RECOVER_VIA_RAIL` action in `catalog.ts`; new failureClass→rail mapping; executor stub in `executor/index.ts` that calls Optimizer/secondary PSP with the deterministic `rzpRequestRef`. Reuse `idempotencyKey` logic to prevent double-charge (mirrors orchestrator best practice: paymentbrief.com/articles/psp-acquirer-outage-failover-runbook).

### 4.2 Privacy-preserving federated merchant intelligence
- **What:** Per-merchant recovery models trained locally; only gradient/parameter updates (with differential privacy + secure aggregation) are shared to a global model. Collective failure-pattern learning **without** moving PII or competitor-sensitive data.
- **Why novel (for recovery):** Federated learning is real for **fraud** (NVIDIA FLARE multi-institution study 2026, AUROC 0.903 vs 0.925 centralized; JP Morgan, RBC, BNY, Mastercard, Stripe integrating FL — arxiv.org/html/2603.13617, eureka.patsnap.com). But applying FL to **recovery response modeling across merchants** is essentially unaddressed.
- **Why incumbents can't easily copy:** A single PSP mixing merchant data raises competitive/regulatory friction; a neutral federated layer is structurally cleaner. Defensibility = data network effect.
- **Impl sketch:** Leverage existing `modelVersions` + frozen `features`. Add `packages/ml/src/federation.ts` that averages per-merchant artifact weights (FedAvg) with DP noise; `registry.ts` gains a `promoteFederated()` path. Simulate 3–4 merchant silos in the demo.

### 4.3 Regulatory / compliance auto-escalation (RBI/DPCI/DPDP-aware)
- **What:** Recovery that adapts to NPCI autopay rules (e.g., ₹15k e-mandate additional-factor-auth ceiling, pre-debit notification windows, retry-count ceilings), DPDP-2023 consent ("free, specific, informed, unambiguous"), and TRAI DLT for comms.
- **Why novel:** Generic dunning tools (Churnkey/Recurly) are US/EU-centric; none encode **Indian mandate/autopay regulation** as live constraints on a recovery agent. This is a hard moat for foreign PSPs.
- **Impl sketch:** Extend `policy.ts` / `envelope.ts` with `regulatory_profile` (jurisdiction, mandate_type, dpdp_consent_status). Add rules like `AUTOPAY_RETRY_CEILING`, `PRE_DEBIT_NOTICE`, `CONSENT_LAPSED`. Maps cleanly onto the existing fail-closed constraint engine.

### 4.4 LTV-aware recovery (stop chasing ₹49 like a whale)
- **What:** EV formula discounts recovery cost by predicted lifetime value and churn risk — a ₹49 customer with high churn risk is not worth a ₹50 human-review touch; a whale on a soft decline gets aggressive multi-touch.
- **Why novel:** Churnkey/Recurly segment by plan/ARR but do not fold **predicted LTV into the per-event recovery EV**. This is a small, high-impact change to our existing EV math.
- **Impl sketch:** Add `ltv_paise` + `churn_risk` features in `features.ts`; change `EV = P(recovery|action)×amount×ltv_weight − contactCost` in `engine.ts`. Easy, demo-friendly, immediately differentiates from flat-EV incumbents.

### 4.5 Real-time payment-rail health / alternative-data signals
- **What:** Time retries to **UPI/IMPS/NEFT outage windows** and bank-health signals (e.g., "customer's bank currently in UPI degradation — delay retry"). Uses SIM/network/device/location signals *only as recovery-timing features*, not credit scoring.
- **Why novel:** Razorpay Optimizer has provider *health scores* for routing new txns; nobody uses **live rail-health as a recovery-timing signal** for failed payments. Highly India-specific (UPI outages are routine) → strong "wow" + local relevance.
- **Impl sketch:** Add `rail_health` feature in `features.ts`; `window.ts` (`nextPaydayWindowMs`) gains a `nextRailHealthyWindowMs`. Could ingest an NPCI/UPI status feed (or simulate) in `ingest/`.

### 4.6 Audited multilingual (Hinglish / regional) voice + WhatsApp recovery
- **Caveat (honest):** Voice/WhatsApp dunning itself is **not** novel — Gupshup, JustCall, Caller Digital, CallMissed, Rezoki already do Hinglish/22-language voice recovery with 14% cart-recovery anecdotes. (callmissed.com, gupshup.ai/whatsapp-api)
- **The novel twist:** Those are *instruments*. ARBITER's moat is making voice/WhatsApp **one channel of a governed, failure-class-diagnosed, EV-optimized, audit-logged agent**. The differentiator is the *brain*, not the *voice*.
- **Impl sketch:** Add `RECOVER_VOICE_HI` / `RECOVER_WHATSAPP` actions in `catalog.ts`; executor emits a real Gupshup/WhatsApp Business API payload (template in Hinglish with `{{1}}` personalization) — reuse `action_json` + `rzpRequestRef`. Combine with §4.5 rail-health for "call only when network healthy."

### 4.7 Promise-to-pay + behavioral nudge tracking
- **What:** Capture a customer's "I'll pay on the 5th" commitment; track fulfillment; nudge before the promised date; feed promise-keeping into the recovery model. Common in NBFC collections (Caller Digital does EMI nudges) but not wired into a governed recovery agent.
- **Impl sketch:** New `promise_to_pay` table + `PROMISE_TO_PAY` action; `pipeline.ts` closes the loop; feeds a `promise_kept_rate` feature.

### 4.8 Escrow / partial-recovery for B2B receivables
- **What:** For overdue B2B invoices, propose a partial-amount recovery via Razorpay Smart Collect / escrow when full recovery is unlikely.
- **Why novel:** Dunning tools target subscriptions, not partial B2B recovery; Razorpay Smart Collect 2.0 (UPI IDs, instant settlement) is the natural rail. (razorpay.com/docs/payments/smart-collect/)
- **Impl sketch:** `ALTERNATE_UPI_LINK` generalized to `PARTIAL_COLLECT`; executor builds a Smart Collect identifier.

**Critique summary:** §4.1, §4.2, §4.3 are the defensible moats (structurally hard for a single PSP). §4.4, §4.5, §4.6 are high-wow, low-effort differentiators. §4.7, §4.8 are nice-to-haves. Do **not** claim "voice recovery" as novel (it isn't) — claim the *governed multimodal orchestration* as novel.

---

## 5. Beyond Track 3 (adjacent high-leverage bets)

The user explicitly said do not limit to Track 3. Highest-leverage adjacent problems we can bolt on using existing modules:

1. **Merchant cash-flow forecasting from recovery signals.** Our `recovery.ts` already produces `recoveredPaise`/`escalatedPaise` per batch; projecting *expected recovered cash* over the next N days is a one-step extension and directly mirrors Razorpay Agent Studio's "forecast cash flows" claim — but ours is *recovery-driven* and auditable. Reuses `metrics_runs`, `drift_checks`. **High leverage: competes on Razorpay's own turf with a sharper, governance-backed version.**

2. **Checkout / pre-payment conversion (involuntary churn *prevention*).** Use `features.ts` + `decide/engine.ts` logic at *checkout* to pick the best rail/method *before* failure (essentially Optimizer's job but merchant-controlled and explainable). Reuses the entire decision engine; just feeds it pre-auth signals. **High leverage: expands TAM beyond recovery to top-of-funnel.**

3. **Inclusivity / rural payment success.** Our brief mentioned a "rurality" signal; the shipped 11 features (`features.ts:16`) dropped it. Re-adding rural/low-connectivity features (extended timeouts, offline-capable initiation, regional-language recovery) is both a strong India-narrative *and* a defensible differentiator vs generic global tools. (Razorpay itself publishes rural success-rate guidance: razorpay.com/blog/payment-success-rate-optimization-india.) **Medium leverage but high "wow" for India judges.**

Other candidates (lower priority): fraud/pre-auth insight feedback (RISK_FLAGGED → Third Watch), settlement/refund intelligence.

**Pick the top 2–3:** cash-flow forecasting (#1) + rural/inclusive success (#3) + cross-PSP recovery (#4.1) give the best "we cover more of Razorpay's agenda than Razorpay's own Agent Studio, with proof" story.

---

## 6. Prioritized Implementation Roadmap

Ordered by win-probability impact. Each item lists effort (S/M/L) and target module.

### Tier A — "Must-have for demo wow" (do this week)
1. **Real Razorpay touch (sandbox/dry-run).** Replace pure `deterministicOutcome()` simulation in `executor/index.ts` with an opt-in `REAL_EXECUTION` mode that constructs and (in dry-run) prints a **real Razorpay Payment Link / UPI Autopay retry API payload** + idempotency key; in live mode signs and sends via Razorpay SDK. *Effort: M.* Modules: `executor/index.ts`, new `packages/core/src/executor/razorpay.ts`.
2. **Honest measurement mode.** Stop presenting synthetic multiplier outcomes as "measured recovery." Add a `held_out_calibration` path: train on seed, evaluate on a *separate* held-out seed slice, report control-vs-pipeline lift with confidence intervals in `recover.ts`. Reuses `metrics.ts`, `metrics_runs`. *Effort: S.* Modules: `recover.ts`, `metrics.ts`.
3. **LTV-aware EV (§4.4).** Add `ltv_paise` + `churn_risk` to `features.ts`; modify `engine.ts` EV formula. *Effort: S.* Highest wow-per-effort.
4. **Rail-health / payday-aware timing (§4.5 lite).** Add a `rail_health` toggle feature + a simulated UPI-outage feed in `ingest/`; wire into `window.ts`. *Effort: M.*
5. **Demo polish.** A one-page live report (extend `recover.ts` output or a tiny web UI) showing recovered ₹, escalations, audit-trail count, and the control-arm comparison. *Effort: S.*

### Tier B — "Differentiation moat" (next 1–2 weeks)
6. **Cross-PSP recovery (§4.1).** `RECOVER_VIA_RAIL` action + Optimizer/secondary-PSP executor stub. *Effort: M–L.* Modules: `catalog.ts`, `executor/`.
7. **Federated merchant intelligence sim (§4.2).** `packages/ml/src/federation.ts` FedAvg over 3–4 simulated merchant silos with DP noise; `registry.ts` promotion path. *Effort: M.* Pure differentiator, no external dependency.
8. **Regulatory auto-escalation (§4.3).** `regulatory_profile` + new constraint rules in `policy.ts`/`envelope.ts`. *Effort: M.*
9. **Audited multilingual recovery (§4.6).** `RECOVER_WHATSAPP`/`RECOVER_VOICE_HI` actions emitting Gupshup/WhatsApp payloads; frame as one channel of the governed brain. *Effort: M.*

### Tier C — Stretch / adjacent (Beyond Track 3)
10. **Cash-flow forecasting from recovery (§5.1).** Projection module over `metrics_runs`. *Effort: M.*
11. **Rural/inclusive success features (§5.3).** Re-add `rurality`/low-connectivity features. *Effort: S–M.*
12. **Checkout-conversion reuse (§5.2).** Feed decision engine pre-auth. *Effort: L.*

**Effort key:** S = <1 day, M = 1–3 days, L = >3 days (single engineer).

---

## 7. Concrete Next Steps (the 3 things to build this week)

1. **Wire a real (dry-run) Razorpay execution path.** Make `executor/index.ts` emit an actual Razorpay Payment Link / UPI Autopay retry request object + `rzpRequestRef`, so the demo shows a genuine Razorpay touch with full audit provenance. This single change moves us from "simulation" to "credible prototype" and is the highest-leverage fix for the weakest spot in §1.

2. **Add LTV-aware EV + honest control-arm reporting.** Two small changes — `ltv_paise`/`churn_risk` features into `features.ts` and the EV formula in `engine.ts`, plus a held-out calibration report in `recover.ts` — give us a differentiated, defensible "we optimize for lifetime value, and here is measured lift vs a do-nothing control" story.

3. **Stand up one moat demo: federated merchant intelligence OR cross-PSP recovery.** Build the Federated module (`federation.ts` over simulated merchant silos) *or* the `RECOVER_VIA_RAIL` action. Either gives the pitch a "here's what no PSP ships" headline that survives Razorpay PM scrutiny. Prefer **cross-PSP recovery** if Optimizer/secondary-PSP access is available; prefer **federated** if it isn't (zero external dependency, pure differentiator).

---

### Sources (abridged)
- Razorpay Buildathon / judging context: razorpay.com/buildathon , velonx.in/blog/razorpay-ai-buildathon-2026 , github.com/Avila-Princy-M01/Duebot-AI/blob/main/docs/razorpay-buildathon-strategy.md
- Razorpay products: Failed Payment Recovery (razorpay.com/blog/razorpay-failed-payment-recovery), Intelligent Payment Retry, Optimizer (razorpay.com/optimizer-intelligent-payments-routing), UPI Autopay (razorpay.com/upi-autopay), Agent Studio (razorpay.com/agent-studio), Smart Collect docs
- Stripe: Smart Retries (docs.stripe.com/billing/revenue-recovery/smart-retries), Cross-processor Orchestration retries (docs.stripe.com/payments/orchestration/retries), Adaptive Acceptance
- Dunning benchmarks: recovamrr.com/blog/stripe-smart-retries-vs-dunning , churntools.com/blog/best-dunning-tools-comparison , staypaid.io/blog , rezoki.com/compare
- Orchestration: gr4vy.com/posts/payment-retry-logic-explained , primer.io/blog , paymentbrief.com (Spreedly/Primer/Gr4vy, failover runbook)
- Federated FL for payments/fraud: arxiv.org/html/2603.13617 (NVIDIA FLARE), arxiv.org/html/2405.08299 , eureka.patsnap.com , researchgate federated fraud studies
- India multilingual voice/WhatsApp dunning: callmissed.com , gupshup.ai/whatsapp-api , whatsboost.in , caller.digital , truefan.ai
- Razorpay Agent Studio / Sprint 2026 coverage: outlookbusiness.com , medianama.com (Sarvam/voice agent, MeitY HITL), analyticsindiamag.com , cognitute.org case study

---

## 8. Brutal Assessment Updated: Competitor Intelligence (August 2026)

### 8.1 What the actual competition looks like (Track 3 peers)

| Project | Architecture | Key Differentiator | Honest Gap vs ARBITER |
|---|---|---|---|
| **Reflex** (abhinav-phi) | FastAPI + React + PostgreSQL, live on Vercel/Railway | Pre-registered eval (git-tagged before results), hash-chained ledger, rules-first + LLM tail, **real Razorpay test-mode webhook integration**, degraded mode, kill-switch measured at 25ms | **+10.05pp** vs tuned-naive (missed +15pp gate); LLM tail measured **zero delta** under real provider; audit ledger is tamper-evident not tamper-proof; no cross-PSP, no federated, no LTV-aware EV |
| **Recoup** (Shikari-ai) | Zero-dep Python, 448 tests, 44/44 mutations caught | **Churn-priced EV** (`P(churn)×LTV`), promise-to-pay loop, voice dispatch protocol, shadow mode (legacy action returned, agent logged), RBI pre-debit notice sequenced as guardrail, **30/30 held-out seeds positive**, AUC 0.777 = 93% of oracle ceiling | Outcomes simulated; issuer-health monitor contributed **zero lift** (detected 0/60 outages); below ~300 receivables rulebook wins; no cross-PSP, no federated, no LTV as feature (only churn cost) |
| **HappyGarg8o** | Streamlit + Supabase, 56 tests, zero-cred run | 7-rule explainable engine, **TRAI-aligned 9am–9pm voice window**, `DRY_RUN` default true with `simulated: true` stamping, dual stopping-rule check (decide + execute) | No ML at all (pure rules); auto-retry is stub; no Razorpay webhook listener; no cross-PSP, no federated, no audit ledger |
| **RecoverAI** (AdithyaAbburi) | FastAPI + Streamlit + Ollama (DeepSeek-Coder local) | **ERV optimizer** (math-max net recovery), local LLM diagnosis, deterministic policy guardrails (`MAX_ATTEMPTS=2`, ≥₹25k → manual), SQLite WAL audit | 1,000 txn eval but `--llm-limit 2` (rest fallback); no held-out seeds reported; no cross-PSP, no federated, no rail-health, no promise-to-pay |

### 8.2 Updated verdict: Can ARBITER win *as-is*?

**No — and the bar is higher than §1 assessed.** Three of four public Track-3 entries already demonstrate:
- Real Razorpay test-mode integration (Reflex: live webhook ingestion, HMAC-verified)
- Pre-registered / held-out evaluation with honest gate reporting (Reflex, Recoup)
- Churn-priced EV + promise-to-pay + voice as a *protocol* not a stub (Recoup)
- TRAI-aligned stopping rules + dual-check execution (HappyGarg8o)
- Local LLM diagnosis behind a circuit breaker (RecoverAI, Reflex)

**ARBITER's remaining unique assets** (still defensible if we ship them *this week*):
1. **Cross-PSP post-failure recovery** — *zero* competitor has this (Optimizer routes new txns; orchestrators route new attempts; none autonomously recover a failed Razorpay charge via a different rail as a policy-bounded agent)
2. **Federated merchant intelligence for recovery** — FL exists for fraud (NVIDIA FLARE, JPMorgan, Stripe), **not for recovery response modeling** (Recoup's model is single-merchant)
3. **RBI/DPDP-aware constraint engine** — Recoup encodes RBI pre-debit notice as *one* guardrail; ARBITER's `policy.ts`/`envelope.ts` is a *general* fail-closed constraint framework that can encode NPCI retry ceilings, DPDP consent, TRAI DLT, AFA thresholds as *data*
4. **Governed multimodal orchestration** — competitors have voice/WhatsApp as *channels*; ARBITER has them as *EV-ranked actions inside a guardrailed envelope with hash-chained audit*

**The gap to close *this week*:** Real Razorpay touch (dry-run Payment Link/UPI Autopay payload + `rzpRequestRef` in audit log) + LTV-aware EV + one moat demo (cross-PSP **or** federated). Without these, we are a well-engineered "also-ran" against Reflex/Recoup.

---

## 9. What Wins Razorpay Hackathon 2026: Judging Criteria & Engineer/PM Preferences

### 9.1 Official evaluation criteria (from Razorpay career page & Buildathon page)

| Criterion | Weight | What it means for Track 3 |
|---|---|---|
| **Problem Taste** | High | Did you identify a *real* revenue-leak problem with financial significance? (Not "retry failed payments" — that's solved. "Cross-PSP recovery when primary rail fails" = taste.) |
| **Build Quality** | High | Code structure, repo organization, execution stability, architectural robustness. 264 tests passing + typecheck clean = table stakes. Mutation testing (Recoup: 44/44 caught) = signal. |
| **AI Judgment** | High | "Whether AI tools, LLMs, or agents were applied *appropriately* instead of forcing unnecessary tech stacks." (Source: coursejoiner.com, cloudsutra.in) **Rules-first + LLM-tail** (Reflex) or **LLM for diagnosis only, never guardrails** (Recoup, RecoverAI) = correct judgment. Pure LLM agent = negative signal. |
| **Failure Recovery** | High | "How the applicant identified system failures at runtime and engineered graceful fallbacks." Degraded mode (Reflex), circuit breaker (RecoverAI), shadow mode (Recoup), kill-switch with measured drain (Reflex: 25ms) = winning patterns. |

### 9.2 What Razorpay engineers/PMs *actually* reward (synthesized from FTX 2026 launches, Agent Studio blogs, hiring posts)

| Preference | Evidence | ARBITER Action |
|---|---|---|
| **Governance > Autonomy** | Agent Studio principles blog: "Compliance boundaries — the action must be within regulatory and policy limits", "Amount validation — payment amounts verified against merchant config", "PII handling — processed per consent framework" (razorpay.com/blog/razorpay-agent-studio-principles-guardrails-and-merchant-control) | Our `envelope.ts` + `policy.ts` fail-closed constraint engine **is** this. Demo it. |
| **Measured recovery with provenance** | Buildathon brief: "Show measured money recovered across a batch, with compliant escalation, stopping rules, and an audit trail." (razorpay.com/buildathon) | `recover.ts` prints this; make the numbers *held-out* not synthetic. |
| **India-specific depth** | UPI Autopay interoperability (multi-gateway routing), NPCI 15k/1L limits, pre-debit notice, TRAI quiet hours, DPDP consent, payday-aligned retries (razorpay.com/blog/upi-autopay-with-intelligent-revenue-protect, razorpay.com/blog/master-recurring-payments-upi-autopay-guide) | §4.3 regulatory profile + §4.5 rail-health + payday window = our moat. |
| **Agent Studio adjacency, not collision** | Agent Studio = no-code marketplace (Subscription Recovery, Cart Abandonment, Dispute Responder, Cashflow Forecaster). Judges know this product. | Position ARBITER as the **governance layer** Agent Studio agents *lack*: provable audit, cross-merchant learning, cross-PSP recovery, regulatory auto-escalation. |
| **Real Razorpay APIs (even sandbox)** | Reflex uses Razorpay test-mode webhooks + Payment Links. Recoup ingests real webhook payloads. HappyGarg8o stubs Payment Links. | **Non-negotiable:** `executor/razorpay.ts` emitting real Payment Link / UPI Autopay retry request objects. |
| **Honesty about simulation** | Reflex: "Headline actuals [SIMULATED]", "G1 gate NOT met (+10.05 < +15)". Recoup: "Outcomes are simulated. The comparison is the claim." | Our `recover.ts` must label `SIMULATED` prominently and report held-out CI. |

### 9.3 The "hiring funnel" reality

- **No resume screening, no aptitude test, no GD.** Panel interview = defend your architecture decisions. (linkedin.com/posts/razorpay-careers, cloudsutra.in)
- **5-minute pitch video + public repo + architecture docs** = submission packet. (fresherjobinfo.in)
- **Internship = ₹75k/month, Bangalore, 6 or 12 months, students only.** Judges = future hiring managers. They want to see: *can this person ship production-grade fintech code with correct priorities?*

**Winning pitch structure (inferred from Reflex/Recoup READMEs):**
1. Problem thesis (1 slide): "Failed payments are a decision under constraints, not a cron job."
2. Architecture diagram (1 slide): Pulse → Brain → Shield → Hands → Ledger → Proof
3. **Live demo** (2 min): Real Razorpay dry-run payload → audit log → control-arm comparison
4. **Honest numbers** (1 min): "Held-out: +X pp vs rulebook, CI [a,b], cost/₹100 = Y, violations = 0"
5. **Moat** (30s): "Cross-PSP recovery + Federated learning + RBI-aware constraints — things a single PSP structurally cannot ship."
6. **What broke & fixed** (30s): Shows engineering maturity.

---

## 10. Razorpay's Current Product Surface (Deep Dive): What They Actually Ship for Recovery

### 10.1 Failed Payment Recovery (launched Feb 2024, active 2025)
- **What:** Auto-sends personalized payment links via **WhatsApp, Email, SMS** on failure.
- **Claim:** "Recover up to 20% of failed payments." 94% businesses find it relevant; 63% already use retargeting.
- **Gap vs ARBITER:** No EV optimization, no per-failure-class diagnosis, no policy-bounded autonomy, no cross-PSP, no LTV awareness, no measured control-arm.

### 10.2 Intelligent Payment Retry (Feb 2024)
- **What:** Smart retry timing for failed recurring payments.
- **Gap:** Single-rail (Razorpay only). No cross-rail recovery. No measured control-arm.

### 10.3 UPI Autopay v2 — Intelligent Revenue-Protect (launched FTX 2026, blog Mar 2026)
| Layer | Capability | Source |
|---|---|---|
| **Intelligent Retry Engine (beta)** | Merchant-configurable retry strategies: cadence, templates, custom logic. Retries timed to salary credits (1st–7th). | razorpay.com/blog/upi-autopay-with-intelligent-revenue-protect |
| **WhatsApp-led Retention** | Branded recovery links on WhatsApp for: registration drop-off, mandate cancellation win-back, failed debit recovery (payment link). | Same |
| **Mandate Interoperability (beta)** | Execute mandates registered on *other platforms* via Razorpay APB Switch. Multi-gateway routing, **recover up to 5% more debits**. No re-registration. | razorpay.com/blog/upi-autopay-interoperability |
| **Banking Switch Monitoring** | Continuous monitoring of banking switches; dynamic reroute on latency/downtime. **99.99% availability** for mandate execution. | Same |
| **2026 NPCI Guidelines** | ₹15k standard / ₹1L enhanced (SIP, insurance, credit bills) AFA ceiling. **Off-peak execution windows** (mid-day/late night). **1 original + 3 retries** max cap. 24h pre-debit notice mandatory. | razorpay.com/blog/master-recurring-payments-upi-autopay-guide |

**Critical insight:** UPI Autopay v2 **already does cross-gateway routing for mandates** (Interoperability) and **WhatsApp recovery links**. But: it's *mandate-scoped*, not a general post-failure recovery agent; it doesn't do EV optimization across rails; it doesn't have a governance envelope; it doesn't learn across merchants.

### 10.4 Optimizer (AI-Powered Payments Infinity Router)
- **What:** Gateway-agnostic routing for **new transactions**. Random forest over **1B+ transactions**. DIY dashboard for manual rules + Smart Router (auto). Claims **5% uplift → 10% revenue increase**.
- **Gap:** Routes **new auths**, not **post-failure recovery**. No autonomous agent, no HITL, no audit trail for recovery decisions.

### 10.5 Agent Studio (FTX 2026, built on Anthropic Claude Agent SDK)
| Agent | Function | Partners |
|---|---|---|
| **Subscription Recovery Agent** | Analyzes failed subscription payments, applies smarter retry logic, triggers targeted nudges. **Voice-led** (ElevenLabs). | ElevenLabs |
| **Abandoned Cart Conversion Agent** | Voice-led follow-up on checkout drop-off, understands why, sends payment link with discount. | Nugget (Zomato), SuperU |
| **Dispute Responder Agent** | Gathers evidence from Razorpay/Shopify/Shiprocket, scores win probability, submits response or draft. | — |
| **Cashflow Forecaster Agent** | Predicts cashflow patterns, identifies liquidity gaps. | — |
| **No-code Agent Builder** | Describe task in plain English, choose systems, set rules. Instant creation. | — |

**Integrations:** Shopify, Shiprocket, WhatsApp, ElevenLabs, Slack, Tally, QuickBooks.
**Platform layer:** Agentic Experience Platform = Agentic Onboarding (5 min), Agentic Dashboard (NL query: "reconcile this bank statement"), Agentic Integration (Claude Code, Replit, Emergent).

**ARBITER positioning:** Agent Studio agents are **no-code, merchant-deployed, single-merchant, no deep guardrails/audit, no cross-merchant learning, no cross-PSP recovery, no regulatory auto-escalation**. ARBITER = the **governance + intelligence layer** that makes agents auditable, measurable, and collectively intelligent.

### 10.6 Third Watch (Risk/Fraud)
- Real-time fraud detection, risk scoring. **Not a recovery product** — but ARBITER's `RISK_FLAGGED` failure class should *consume* Third Watch signals (fraud → `manual_review` guardrail).

### 10.7 Smart Collect 2.0
- NEFT/RTGS/IMPS/UPI collection identifiers. Instant settlement. UPI IDs for B2B receivables.
- **ARBITER hook:** `PARTIAL_COLLECT` / `ALTERNATE_UPI_LINK` action for B2B escrow/partial recovery (§4.8).

### 10.8 Summary: What Razorpay *doesn't* ship (our white space)

| Capability | Razorpay Status | ARBITER Opportunity |
|---|---|---|
| Cross-PSP post-failure recovery (failed Razorpay → retry via different rail/PSP) | ❌ Optimizer routes new; Interoperability routes mandate *executions* | ✅ **Core moat** (§4.1) |
| Federated recovery learning across merchants | ❌ Single-merchant models only | ✅ **Core moat** (§4.2) |
| RBI/DPDP/NPCI constraints as live, data-driven guardrails | ❌ Hardcoded in UPI Autopay stack | ✅ **Core moat** (§4.3) |
| LTV-aware per-event recovery EV | ❌ Segment by plan only | ✅ **Quick win** (§4.4) |
| Real-time rail-health for recovery timing | ❌ Optimizer has for *routing new* | ✅ **Quick win** (§4.5) |
| Governed multimodal (voice/WhatsApp) orchestration | ❌ Voice is a channel in Agent Studio | ✅ **Differentiator** (§4.6) |
| Promise-to-pay loop in recovery agent | ❌ NBFC-only (Caller Digital) | ✅ **Adjacent** (§4.7) |
| B2B partial recovery via Smart Collect | ❌ Dunning tools = subscriptions | ✅ **Adjacent** (§4.8) |
| Recovery-driven cash-flow forecasting | ❌ Agent Studio has generic forecaster | ✅ **Beyond Track 3** (§5.1) |

---

## 11. Novel Angles Stress-Tested (Updated with Competitive Intelligence)

| Angle | Novelty Verdict | Competitor Coverage | ARBITER Implementation Status | Effort to Ship |
|---|---|---|---|---|
| **Cross-PSP post-failure recovery** | ✅ **True moat** — no PSP, orchestrator, or Agent Studio agent does this | Reflex: Razorpay test-mode only. Recoup: single-rail. HappyGarg: stub. RecoverAI: simulator only. | `catalog.ts` has `RECOVER_VIA_RAIL` stub; `executor/` needs Optimizer/secondary-PSP client | M (1–3 days) |
| **Federated merchant intelligence (recovery)** | ✅ **True moat** — FL for fraud exists (NVIDIA FLARE 2026, JPMorgan, Stripe); **zero for recovery** | All competitors: single-merchant models only. Recoup: AUC 0.777 single-merchant. | `packages/ml/src/federation.ts` (new); `registry.ts` promotion path | M (1–3 days) |
| **RBI/DPDP-aware constraint engine** | ✅ **Hard moat for foreign PSPs** — generic tools are US/EU-centric | Recoup: RBI pre-debit notice as *one* guardrail. Others: none. | `policy.ts`/`envelope.ts` framework exists; needs `regulatory_profile` + NPCI/DPDP/TRAI rules | M (1–3 days) |
| **LTV-aware EV (per-event)** | ✅ **Differentiator** — Churnkey/Recurly segment by plan; none fold predicted LTV into per-event EV | Recoup: `P(churn)×LTV` as *cost*, not EV weight. Others: no LTV. | `features.ts` + `engine.ts` — 2-file change | S (<1 day) |
| **Real-time rail-health for recovery timing** | ✅ **India-specific wow** — Optimizer has for routing new; none for recovery timing | None. | `features.ts` + `window.ts` + simulated feed in `ingest/` | M (1–3 days) |
| **Governed multimodal orchestration** | ⚠️ **Channel = not novel** (Gupshup, Caller Digital, CallMissed, Rezoki). **Brain = novel** | HappyGarg: 3-tier rules + voice. Reflex: LLM Hinglish phrasing. Recoup: voice protocol. | `catalog.ts` actions + executor payloads; frame as *EV-ranked channel inside guardrails* | M (1–3 days) |
| **Promise-to-pay loop** | ⚠️ Exists in NBFC collections (Caller Digital) | Recoup: **has this** (promise_to_pay table, model feature, hold-off logic) | Not started | M (1–3 days) |
| **B2B partial recovery / escrow** | ⚠️ Smart Collect 2.0 is the rail; dunning tools don't target B2B partial | None | `catalog.ts` generalization + Smart Collect executor | M–L |
| **Recovery-driven cash-flow forecasting** | ⚠️ Agent Studio has generic forecaster | RecoverAI: mentions forecasting. Agent Studio: Cashflow Forecaster Agent. | `metrics_runs` projection module | M |

**Stress-test conclusions:**
1. **Cross-PSP + Federated + RBI-aware** = the three *defensible* moats (structurally impossible for a single PSP to replicate).
2. **LTV-aware EV + Rail-health** = highest wow/effort (S/M), immediately demo-able.
3. **Voice/WhatsApp** = do not claim novelty. Claim **governed multimodal orchestration** (EV-ranked, guardrailed, audited).
4. **Promise-to-pay** = Recoup already has a strong implementation. If we add it, differentiate via **governed loop + audit trail + model feature**.

---

## 12. This Week's Winning Moves: 2-3 Concrete Additions with File Paths + Effort

### Move 1: Real Razorpay Dry-Run Execution Path (MUST — unblocks "real touch" criterion)
**Effort:** M (1–3 days) | **Files:**
- `packages/core/src/executor/index.ts` — add `REAL_EXECUTION` mode flag; replace `deterministicOutcome()` with dry-run payload construction
- `packages/core/src/executor/razorpay.ts` (new) — Razorpay Payment Link + UPI Autopay retry request builders:
  - `createPaymentLinkRetry(failedPayment, idempotencyKey) → { url, reference, payload }`
  - `createUPIAutopayRetry(mandateId, amount, idempotencyKey) → { tokenId, orderId, payload }`
- `packages/core/src/db/schema.ts` — add `rzp_request_ref`, `rzp_payload_json` columns to `audit_log` / `interventions`
- `packages/core/src/decide/engine.ts` — pass `rzpRequestRef` through envelope → executor → audit

**Acceptance criteria:** `recover.ts --dry-run` prints a valid Razorpay Payment Link create request JSON + `rzpRequestRef` that appears in the audit log. Judge can verify: "This is a real API call structure."

### Move 2: LTV-Aware EV + Honest Held-Out Calibration (MUST — highest wow/effort)
**Effort:** S (<1 day each) | **Files:**
- `packages/ml/src/features.ts` — add `ltv_paise: number`, `churn_risk: number` (0–1) to feature vector; derive from `customer.ltv_estimate_paise` + `customer.churn_score` in seed
- `packages/core/src/decide/engine.ts` — modify EV: `EV = P(recovery|action) × amount_paise × ltv_weight(churn_risk) − contact_cost_paise`; `ltv_weight = 1 / (1 + churn_risk * 4)` (tunable)
- `packages/ml/src/recover.ts` — add `--held-out-seed` flag: train on seed A, evaluate on seed B; print control-vs-pipeline lift with **bootstrap 95% CI**; label all output `[SIMULATED]`

**Acceptance criteria:** `recover.ts --held-out-seed 1337` prints: `CONTROL: 12.3% recovery | PIPELINE: 24.7% recovery | INCREMENTAL: +12.4pp CI[+9.1, +15.8] | Cost/₹100: ₹3.2 | Violations: 0 [SIMULATED]`

### Move 3: Cross-PSP Recovery Moat Demo (SHOULD — "what no PSP ships" headline)
**Effort:** M (2–3 days) | **Files:**
- `packages/core/src/catalog.ts` — add `RECOVER_VIA_RAIL` action with `target_rail: 'card_payment_link' | 'smart_collect_upi' | 'secondary_psp_optimizer'`
- `packages/core/src/executor/razorpay.ts` — add `executeCrossPSPRecovery(action, envelope)` stub that:
  - Builds Optimizer Smart Router payload OR secondary PSP Payment Link
  - Emits `rzpRequestRef` with `cross_psp: true` flag
  - Records `rail_switched_from`, `rail_switched_to` in audit
- `packages/core/src/decide/engine.ts` — failureClass→rail mapping: `UPI_MANDATE_DECLINED → card_payment_link`, `CARD_EXPIRED → smart_collect_upi`, `ISSUER_DOWN → secondary_psp_optimizer`
- `packages/seed/generator.ts` — add `secondary_rails` to merchant config (simulated)

**Acceptance criteria:** Demo script shows: "UPI Autopay mandate failed (insufficient funds) → ARBITER chose `RECOVER_VIA_RAIL` → card Payment Link created → `rzpRequestRef: cross_psp_abc123` logged → audit trail shows rail switch."

### Move 4 (Alternative if cross-PSP blocked): Federated Merchant Intelligence Sim (SHOULD)
**Effort:** M (2–3 days) | **Files:**
- `packages/ml/src/federation.ts` (new) — FedAvg over 3–4 simulated merchant silos:
  - `trainLocal(merchantId, localData) → modelWeights`
  - `aggregate(weights[], dpNoiseSigma) → globalWeights` (Gaussian DP noise)
  - `evaluateGlobal(heldOutPerMerchant) → perMerchantAUC, globalAUC`
- `packages/ml/src/registry.ts` — add `promoteFederated(globalWeights, metrics)` that gates promotion on `globalAUC > localAUC + threshold`
- `packages/seed/generator.ts` — generate 4 merchant corpora with distinct failure distributions (B2C SaaS, D2C subscription, B2B invoicing, EdTech)
- `packages/ml/src/recover.ts` — add `--federated-demo` flag printing per-merchant lift vs local-only

**Acceptance criteria:** `recover.ts --federated-demo` prints: `Merchant A (local AUC 0.71 → fed 0.76) | Merchant B (0.68 → 0.73) | Merchant C (0.74 → 0.77) | Merchant D (0.69 → 0.72) | Global: 0.745 [SIMULATED]`

---

### Priority Order for This Week (Sequential)

| Day | Move | Rationale |
|---|---|---|
| Mon–Tue | **Move 1** (Real Razorpay dry-run) | Unblocks "real touch" — highest judge signal |
| Wed | **Move 2** (LTV-aware EV + held-out calibration) | S effort, massive differentiation vs flat-EV incumbents |
| Thu–Fri | **Move 3** (Cross-PSP) **OR** **Move 4** (Federated) | Pick one moat demo. Cross-PSP if Optimizer access; Federated if zero external deps. Both are "what no PSP ships." |

### Stretch (if time): Regulatory Profile + Rail-Health (Move 5+6 combined)
- `policy.ts`: add `regulatory_profile` enum + `AUTOPAY_RETRY_CEILING=3`, `PRE_DEBIT_NOTICE_HOURS=24`, `AFA_CEILING_PAISE=150000`
- `features.ts`: add `rail_health_score` (0–1), `next_rail_healthy_window_ms`
- `window.ts`: `nextRecoveryWindowMs()` prefers `nextRailHealthyWindowMs` > `nextPaydayWindowMs`

---

### Sources (Updated)

- **Razorpay Buildathon 2026 criteria:** razorpay.com/buildathon, velonx.in/blog/razorpay-ai-buildathon-2026, coursejoiner.com/internship/razorpay-ai-builder-internship-2026, cloudsutra.in/jobs/razorpay-hiring-ai-builder-intern-in-bangalore, linkedin.com/posts/razorpay-careers_razorpaybuildathon-aiinterns-hiring-activity-7497899727838076929
- **Razorpay Agent Studio (FTX 2026):** razorpay.com/newsroom/razorpay-launches-the-worlds-first-ai-native-agent-studio-for-payments-at-ftx26-powered-by-anthropics-claude, razorpay.com/blog/agent-studio-ai-agents-by-razorpay, razorpay.com/blog/razorpay-agent-studio-principles-guardrails-and-merchant-control, thehindubusinessline.com, techcircle.in, moneycontrol.com, thepaypers.com
- **UPI Autopay v2 / Intelligent Revenue-Protect:** razorpay.com/blog/upi-autopay-with-intelligent-revenue-protect, razorpay.com/blog/upi-autopay-interoperability, razorpay.com/blog/master-recurring-payments-upi-autopay-guide, razorpay.com/upi-autopay
- **Optimizer:** razorpay.com/optimizer-intelligent-payments-routing
- **Failed Payment Recovery:** razorpay.com/blog/razorpay-failed-payment-recovery
- **Competitor Track-3 repos:** github.com/abhinav-phi/reflex, github.com/Shikari-ai/recoup, github.com/HappyGarg8o/ai-revenue-recovery, github.com/AdithyaAbburi/RecoverAI
- **Federated Learning for Fraud (2026):** arxiv.org/html/2603.13617 (NVIDIA FLARE), eureka.patsnap.com
- **India Voice/WA Dunning:** callmissed.com, gupshup.ai/whatsapp-api, caller.digital, whatsboost.in
- **Payment Orchestration Cross-PSP:** gr4vy.com/posts/payment-retry-logic-explained, paymentbrief.com, primer.io/blog

---

## 13. Critical Bugs & Architectural Weaknesses (50 Issues)

*Identified via strict critical review of the current `feat/track3-differentiation` branch implementation.*

### 13.1 Correctness & Data Integrity Bugs

| # | Issue | File/Location | Root Cause | Impact | Fix |
|---|-------|---------------|------------|--------|-----|
| 1 | **LTV normalization constant 100× too high** | `features.ts:19` (`LTV_NORM_PAISE = 5_00_00_000`) vs realistic max LTV (~₹1L = 10_00_000) | Proxy LTV = `priorSuccessCount × 50_000`; for 100 successes = 50L paise >> 50L norm constant | `ltv_paise_norm` ≈ 0 for nearly all customers → LTV weight ineffective | Set `LTV_NORM_PAISE = 10_00_000` or compute percentile-based |
| 2 | **Control arm uses untrained heuristic model** | `recovery.ts:148` uses `result.probability` from heuristic (weights=0.08, bias=-1.2) | Model has no predictive validity; control arm reflects random noise | "Incremental lift" meaningless — compares pipeline vs random noise | Use historical recovery rate per failure class, or label as `[SIMULATED]` |
| 3 | **`deriveLtvSignals` silent NaN on invalid `joinedAtUtc`** | `features.ts:74-78` only validates `occurredAtUtc`, not `joinedAtUtc` | `Date.parse(invalid)` → `NaN` → tenureNorm=`0` → churn inflated | Silent data corruption | Validate both dates; throw or default tenureNorm=0 explicitly |
| 4 | **Churn formula uses arbitrary uncalibrated coefficients** | `features.ts:79`: `0.6, 0.4, 0.25` magic numbers | No calibration, no reference, no sensitivity analysis | LTV weight meaningless; high-LTV customers may be penalized | Expose as configurable constants with docs, or remove until calibrated |
| 5 | **Control arm probability source is model prediction — circular** | `recovery.ts:148` uses same model for control and treatment | Model overconfidence → control overestimates natural recovery → lift underestimated | Incremental lift biased by model calibration error | Use historical recovery rate per failure class from production data |
| 6 | **`controlOutcome` modulo bias** | `recovery.ts:30`: `hashSeed(...) % 10_000` | FNV-1a modulo 10000 not uniform | Minor but measurable distribution bias | Use rejection sampling or floating-point scaling |
| 7 | **`incrementalRecoveredPaise` negative labeled as "lift"** | `recovery.ts:218`, CLI reports `-₹7,935.00 (-28.7%)` as "INCREMENTAL lift" | `incremental = recovered - control` can be negative | Misleading terminology | Rename to `incrementalRecoveredPaise` (can be negative); label in CLI |
| 8 | **`recoverBatch` double-counts auditTrailCount** | `recovery.ts:167`: assumes exactly 2 entries (DECISION + DIAGNOSIS) | Pipeline may write TRIGGER/ALARM entries; throws before audit = wrong count | Audit trail count inaccurate | Query actual `audit_log` count per event after processing |
| 9 | **`recoverBatch` conflates intermediate vs terminal states** | `recovery.ts:173,195,203`: `AWAITING_APPROVAL` → `escalatedPaise`, later may succeed/fail | Report treats intermediate state as final outcome | Overcounts "escalated"; incremental lift ignores future recovery of escalated | Track final outcomes only, or clearly label intermediate vs terminal |
| 10 | **Federated DP noise uses `Math.random()` — non-deterministic** | `federation.ts:35-36` | Box-Muller with `Math.random()` breaks reproducibility | Cannot reproduce federated model; audit trail meaningless; tests flaky | Use seeded RNG (`mulberry32` with `hashSeed("dp-noise-" + siloId + round)`) |
| 11 | **Federated `trainedAtUtc` uses `Date.now()` — non-reproducible** | `federation.ts:97,115` | Same code run twice → different timestamps → different model IDs | Demo not reproducible; audit trail broken | Accept injected `nowMs` parameter like other modules |
| 12 | **Federated DP noise adds same noise to all weights + bias** | `federation.ts:68-69` | Bias typically smaller than weights; same absolute noise destroys bias signal | Model structure corrupted unnecessarily | Scale noise per parameter magnitude; use Gaussian mechanism with sensitivity analysis |
| 13 | **Razorpay dry-run provider ignores catalog multipliers** | `razorpay.ts:110-114` `mockOutcome` only checks `HUMAN_REVIEW` | Ignores `failureClass` and `multiplierFor`; `HARD_METHOD_DECLINED + RETRY_NOW` (mult=0) returns SUCCEEDED | Dry-run shows success for actions that would fail | Use shared `deterministicOutcome` logic |
| 14 | **Razorpay provider hardcodes customer contact info** | `razorpay.ts:27,83` | `contact: "+919999999999", email: "customer@example.com"` | Security risk if live mode enabled; dry-run logs misleading | Fetch actual customer contact from DB using `ctx.customerId` |
| 15 | **Razorpay provider `IS_LIVE` throws — no graceful fallback** | `razorpay.ts:123-127` | Accidental `REAL_EXECUTION_MODE=live` crashes entire batch | Production outage risk | Log warning, fall back to simulation, set `dryRunPayload` with note |
| 16 | **Simulation vs Razorpay provider inconsistent outcome logic** | `simulation.ts` vs `razorpay.ts:110-114` | Simulation uses multipliers; Razorpay ignores them | Inconsistent behavior between providers | Share `deterministicOutcome` logic |
| 17 | **Idempotency key excludes `nowMs` — reconciliation fails** | `executor/index.ts:51-59` | Same proposal executed twice with different `nowMs` → same key → UNIQUE constraint fail | Stuck executions cannot be retried | Include execution attempt number in idempotency key |
| 18 | **`editProposal` breaks after feature count change (11→13)** | `pipeline.ts:402-406` | `frozenValues` length 11 vs `recomputed.values` length 13 → `MISSING_FEATURES` | All existing proposals become uneditable | Migrate frozen features or version feature vectors |
| 19 | **`promoteFederatedModel` missing audit trail** | `federation.ts:128` comment says "writes audit trail" but only calls `saveModel` | Missing federation provenance in audit log | Audit trail incomplete | Write `audit_log` entry with `entry_type: "FEDERATION"` |
| 20 | **`recover.ts` generates new model every run — non-deterministic ID** | `recover.ts:61-65` `trainedAtUtc: isoUtc(nowMs)` | Different runs → different model IDs | Non-reproducible demos | Use fixed `trainedAtUtc` for demo or deterministic ID from corpus hash |

### 13.2 Architectural Weaknesses

| # | Weakness | Location | Root Cause | Impact | Improvement |
|---|----------|----------|------------|--------|-------------|
| 21 | **Tight coupling: Engine imports feature constants** | `engine.ts` duplicates `LTV_NORM_PAISE`, `CHURN_BP_MAX` | Engine should receive normalized features only | Divergence risk when constants change | Export shared constants from `features.ts`; engine uses normalized features |
| 22 | **Provider pattern leaks into executor** | `executor/index.ts` calls `getProvider()` internally | Hard to test; provider not injectable | Cannot swap provider for testing | Pass provider as dependency; resolve at batch level |
| 23 | **Control arm logic embedded in recovery module** | `recovery.ts` lines 25-32 | Should be separate `ControlArm` module with pluggable baselines | Cannot swap baseline strategy (historical vs model vs random) | Extract `ControlArm` interface with `HistoricalBaseline`, `ModelBaseline`, `RandomBaseline` |
| 24 | **Federation logic in ML package** | `packages/ml/src/federation.ts` | ML package shouldn't know about federated training | Violates separation of concerns | Move to separate `packages/federation/` package |
| 25 | **Demo CLIs mixed with core logic** | `recover.ts`, `federate.ts` in `src/` | Pollutes package exports; not composable | Poor DX; cannot iterate on recovery without re-running corpus gen | Move to `packages/ml/cli/`; separate into composable functions |
| 26 | **No configuration system** | Magic numbers everywhere (churn coeffs, LTV norm, DP noise scale) | Hardcoded values scattered | Cannot tune without code changes; poor auditability | Add config file (`config.yaml`) / env-driven; centralize constants |
| 27 | **Feature engineering coupled to decision engine** | `pipeline.ts` passes raw `ltvPaise`/`churnRiskBp` to engine | Engine re-normalizes with duplicated constants | Two normalization paths for same concept | Engine should consume normalized features directly from feature vector |
| 28 | **Demo CLIs use `Date.now()` — non-reproducible** | `recover.ts:20`, `federate.ts:8` | No injected clock in CLI entry points | Demos not reproducible; cannot compare runs | Add `--seed`/`--now` CLI flags for injected clock |
| 29 | **`exactOptionalPropertyTypes` not enforced** | `tsconfig.json` missing | Optional properties accessed without checks | Runtime undefined errors | Enable `exactOptionalPropertyTypes`; audit all optional accesses |
| 30 | **Missing integration tests for end-to-end flows** | No `tests/integration/` | Unit tests pass but integration unverified | E2E correctness not verified | Add `tests/integration/e2e_recovery.test.ts` |
| 31 | **No test for `recoverBatch` with `REAL_EXECUTION_MODE=dry-run`** | Tests use default simulation | Dry-run provider behavior untested | Razorpay payload structure unverified | Add test with `REAL_EXECUTION_MODE=dry-run` verifying `dryRunPayload` in audit |
| 32 | **Federation test uses `Math.random()` — flaky** | `federation.test.ts:33-36` | Probabilistic assertion | Spuriously passes/fails | Mock `Math.random` or use deterministic RNG in test |
| 33 | **Federation test doesn't verify DP noise actually added** | `federation.test.ts:45-53` | Only checks dimensions | DP noise could be zero and test passes | Assert weights differ from no-noise baseline |
| 34 | **LTV test doesn't verify decision change** | `decide.test.ts:180-210` | Tests `ltvWeight` function but not `decide()` action flip | Doesn't verify feature actually changes behavior | Add test where LTV weight flips chosen action |
| 35 | **Features test uses hardcoded indices** | `features.test.ts:157,160` | `values[11]`, `values[12]` assume feature order | Breaks silently if feature order changes | Use `FEATURE_NAMES.indexOf("ltv_paise_norm")` |
| 36 | **`recover.ts` monolithic — no separation of concerns** | `recover.ts:19-93` | Corpus gen → replay → train → recover in one script | Cannot iterate on recovery without re-running corpus | Separate into composable functions; add CLI subcommands |
| 37 | **`recover.ts` no cleanup of DB connection** | No `client.close()` | libsql may not cleanup immediately | Resource leak in long-running processes | Add `finally { client.close() }` |
| 38 | **`federate.ts` no round-trip verification** | `federate.ts:35-45` | Promotes model but doesn't load back | No sanity check federation worked | Load via `getIncumbent` and verify weights |
| 39 | **Razorpay dry-run logs unstructured** | `razorpay.ts:131-132` `console.log(JSON.stringify(...))` | Pollutes stdout; hard to parse | Hard to parse programmatically | Use structured logging (JSON lines) or separate file/stream |
| 39 | **Provider names not exported for testing** | `providers/index.ts` | `simulationProvider`, `razorpayProvider` not exported | Cannot unit test providers directly | Export both |
| 40 | **`razorpayProvider` name includes mode** | `razorpay.ts:117`: `name: razorpay-${MODE}` | Audit queries by provider name break across modes | Inconsistent audit trail | Fixed name `"razorpay"`; mode in metadata |
| 41 | **`simulateFederatedTraining` same timestamp for all silos** | `federation.ts:97` | All silos get `isoUtc(Date.now())` | Unrealistic simulation | Add small offset per silo |
| 42 | **`hashSeed`/`mulberry32` duplicated in federation** | `federation.ts:133-151` | Already in `@arbiter/shared` | Code duplication | Import from `@arbiter/shared` |
| 43 | **`deriveLtvSignals` exported but internal only** | `features.ts:65` | Leaks implementation detail | API surface pollution | Remove `export`; compute in `computeFeatures` |
| 44 | **`ltvPaise` in `ComputedFeatures.raw` is raw; feature normalized** | `features.ts:257` vs `features.ts:242` | Two scales for same concept | Confusion; engine uses raw with own constant | Engine should use normalized feature directly |
| 45 | **`recovery.ts` `controlOutcome` no confidence intervals** | `recovery.ts:218` | Point estimate only | Cannot distinguish real lift from noise | Add bootstrap CI or binomial proportion CI |
| 46 | **`recover.ts` envelope set AFTER replay** | `recover.ts:37-50` after `replayCorpus` | Confusing order; works but unclear | Minor confusion | Set envelope in `ensureTenant` or before replay |
| 47 | **`recover.ts` corpus hardcoded** | `recover.ts:26`: `customerCount: 60, targetEvents: 230` | No CLI args for batch size | Cannot test targeted recovery | Add CLI args for event IDs, batch size, corpus type |
| 48 | **`recover.ts` `--dry-run-real` flag missing** | Must set `REAL_EXECUTION_MODE=dry-run` env manually | Key feature invisible to default users | Poor DX | Add CLI flag `--dry-run-real` |
| 49 | **`federation.ts` `SiloReport` `trainedAtUtc` unused** | `federation.ts:29` | Set but never read | Dead code | Remove or use in audit trail |
| 50 | **Missing `package.json` exports for providers** | `packages/core/package.json` | Provider types not exported | External consumers cannot compose custom providers | Add `"./executor/providers"` export |

---

## 14. Additional Winning Features: Research-Backed Additions

*Based on competitive intelligence (§8–11), Razorpay product gaps (§10), and judging criteria (§9). Each feature is stress-tested against competitors (Reflex, Recoup, HappyGarg8o, RecoverAI) and Razorpay's own products (Optimizer, Agent Studio, UPI Autopay v2).*

### 14.1 RBI/DPDP/NPCI Regulatory Auto-Escalation Engine (§4.3) — **TRUE MOAT**

| Aspect | Details |
|--------|---------|
| **What** | Recovery engine that encodes NPCI/DPDP/TRAI regulations as *live, data-driven guardrails* in the `policy.ts`/`envelope.ts` fail-closed constraint framework. Not hardcoded — configurable per-merchant `regulatory_profile`. |
| **Why novel** | Generic dunning tools (Churnkey, Recurly, Stripe) are US/EU-centric. Recoup encodes RBI pre-debit notice as *one* guardrail. Razorpay UPI Autopay v2 hardcodes NPCI rules. **No one exposes regulatory constraints as a programmable, merchant-configurable policy layer with audit provenance.** |
| **Razorpay gap** | UPI Autopay v2 has NPCI rules baked in (₹15k/₹1L AFA ceiling, 1+3 retry cap, 24h pre-debit notice, off-peak windows). But merchants cannot *customize* or *audit* them. Agent Studio agents have no regulatory constraint engine. |
| **Key rules to encode** | `AUTOPAY_RETRY_CEILING=3` (NPCI 1+3), `PRE_DEBIT_NOTICE_HOURS=24`, `AFA_CEILING_PAISE=150000` (standard) / `10000000` (enhanced), `DPDP_CONSENT_REQUIRED=true`, `TRAI_DLT_TEMPLATE_ID`, `QUIET_HOURS_START=2100`, `QUIET_HOURS_END=0900` (IST). |
| **Impl sketch** | `policy.ts`: add `regulatory_profile` enum + new `RuleId`s (`AUTOPAY_RETRY_CEILING`, `PRE_DEBIT_NOTICE`, `AFA_CEILING`, `DPDP_CONSENT`, `TRAI_DLT`). `envelope.ts`: evaluate regulatory rules before eligibility. `generator.ts`: per-merchant `regulatory_profile` in seed. `recover.ts`: `--regulatory-demo` flag prints rule violations prevented. |
| **Demo criteria** | "Merchant with `regulatory_profile=upi_autopay` attempts 4th retry → refused by `AUTOPAY_RETRY_CEILING` → audit log shows `RULE_VIOLATED: AUTOPAY_RETRY_CEILING` with NPCI clause reference." |
| **Judge points** | **Problem Taste** (real regulatory pain), **India-specific depth**, **Governance > Autonomy** (Agent Studio principle), **Failure Recovery** (degraded mode: if regulation changes, update config not code). |
| **Effort** | M (2–3 days): `policy.ts`, `envelope.ts`, `generator.ts`, `recover.ts` flag. |

### 14.2 Real-Time Rail-Health for Recovery Timing (§4.5) — **HIGH WOW/EFFORT**

| Aspect | Details |
|--------|---------|
| **What** | Time recovery retries to **UPI/IMPS/NEFT outage windows** and bank-health signals. Uses simulated NPCI/UPI status feed + bank health scores to pick `nextRecoveryWindowMs` that avoids degraded rails. |
| **Why novel** | Razorpay Optimizer has provider health scores for *routing new transactions*. **No one uses live rail-health as a recovery-timing signal for failed payments.** UPI outages are routine in India → strong local relevance. |
| **Razorpay gap** | Optimizer routes *new* auths around degraded providers. Failed payment recovery still retries on fixed schedules (payday, fixed intervals) ignoring real-time rail health. |
| **Signals to ingest** | NPCI UPI status API (or simulated), bank-level success rate (last 1h), IMPS/NEFT uptime, Razorpay Optimizer health scores (if API access). |
| **Impl sketch** | `features.ts`: add `rail_health_score` (0–1), `bank_health_score` (0–1). `window.ts`: `nextRecoveryWindowMs()` prefers `nextRailHealthyWindowMs` > `nextPaydayWindowMs`. `ingest/rail_health.ts`: simulated feed (cron) or NPCI webhook. `catalog.ts`: `RAIL_HEALTH_WAIT` action (wait for healthy window). `engine.ts`: `RAIL_HEALTH_WAIT` EV = `P(recovery\|healthy) × amount × health_score − wait_cost`. |
| **Demo criteria** | "UPI degraded (health=0.2) → ARBITER chooses `RAIL_HEALTH_WAIT` → schedules retry at next healthy window (health>0.8) → avoids failed retry → audit shows rail-health gate." |
| **Judge points** | **India-specific depth** (UPI outages are real), **Failure Recovery** (degraded mode: if rail health unavailable, fallback to payday window), **Problem Taste** (timing matters more than retry count). |
| **Effort** | M (2–3 days): `features.ts`, `window.ts`, `ingest/rail_health.ts`, `catalog.ts`, `engine.ts`. |

### 14.3 Promise-to-Pay Behavioral Loop (§4.7) — **DIFFERENTIATE VS RECOUP**

| Aspect | Details |
|--------|---------|
| **What** | Capture customer's "I'll pay on the 5th" commitment; track fulfillment; nudge before promised date; feed promise-keeping rate into recovery model. Recoup has this — **differentiate via governed loop + audit trail + model feature**. |
| **Why novel** | Recoup has promise-to-pay table + hold-off logic. **No one wraps it in a governed, EV-ranked, audit-logged action with model feedback loop.** |
| **Razorpay gap** | Agent Studio Subscription Recovery Agent does voice nudges but no promise tracking. NBFC tools (Caller Digital) do EMI nudges but no governance envelope. |
| **Impl sketch** | `catalog.ts`: add `PROMISE_TO_PAY` action (contact, zero cost). `schema.ts`: `promise_to_pay` table (`customer_id`, `promised_at_utc`, `amount_paise`, `status: PENDING/KEPT/BROKEN`, `created_at_utc`). `pipeline.ts`: on `PROMISE_TO_PAY` chosen → insert promise row. `recovery.ts`: `PROMISE_TO_PAY` → `AWAITING_PROMISE` state. `reconcile_promises.ts`: cron checks `promised_at_utc` passed → if paid → `KEPT` + feed `promise_kept_rate` feature; if not → escalate. `features.ts`: add `promise_kept_rate` feature. |
| **Demo criteria** | "Customer promises 'I'll pay Friday' → ARBITER logs promise → sends WhatsApp nudge Thursday → Friday paid → `promise_kept_rate` improves → next recovery EV increases for this customer." |
| **Judge points** | **AI Judgment** (rules-first: promise is a constraint; LLM-tail: parse voice/WhatsApp for promise date), **Failure Recovery** (promise broken → auto-escalate), **Governance** (audit trail of promise lifecycle). |
| **Effort** | M (2–3 days): `catalog.ts`, `schema.ts`, `pipeline.ts`, `features.ts`, `recovery.ts`, `reconcile_promises.ts` (new). |

### 14.4 B2B Partial Recovery via Smart Collect (§4.8) — **ADJACENT HIGH LEVERAGE**

| Aspect | Details |
|--------|---------|
| **What** | For overdue B2B invoices, propose partial-amount recovery via Razorpay Smart Collect / escrow when full recovery unlikely. Generalizes `ALTERNATE_UPI_LINK` to `PARTIAL_COLLECT`. |
| **Why novel** | Dunning tools target subscriptions, not partial B2B recovery. Razorpay Smart Collect 2.0 (UPI IDs, instant settlement) is the natural rail. No dunning tool integrates partial collection as an EV-ranked action. |
| **Razorpay gap** | Smart Collect 2.0 exists (UPI IDs, instant settlement). But no recovery agent uses it for partial B2B recovery. |
| **Impl sketch** | `catalog.ts`: add `PARTIAL_COLLECT` action with `min_partial_pct=25`, `max_partial_pct=75`. `executor/razorpay.ts`: `createSmartCollectPartial(invoice, amount_pct)` builds Smart Collect UPI ID + amount. `engine.ts`: EV = `P(recovery\|partial) × partial_amount − cost`. `policy.ts`: rule `MIN_PARTIAL_RECOVERY_PCT`. `generator.ts`: B2B merchant corpus with invoice amounts. |
| **Demo criteria** | "₹10L B2B invoice overdue 90 days → ARBITER chooses `PARTIAL_COLLECT` (50%) → Smart Collect UPI ID generated → customer pays ₹5L → audit shows partial recovery with Smart Collect ref." |
| **Judge points** | **Problem Taste** (B2B receivables are huge in India), **Razorpay adjacency** (Smart Collect integration), **Governance** (partial amount capped by policy). |
| **Effort** | M (2–3 days): `catalog.ts`, `executor/razorpay.ts`, `schema.ts`, `generator.ts`. |

### 14.5 Recovery-Driven Cash-Flow Forecasting (§5.1) — **BEYOND TRACK 3, COMPETES WITH AGENT STUDIO**

| Aspect | Details |
|--------|---------|
| **What** | Project expected recovered cash over next N days from batch recovery signals. Mirrors Agent Studio's "Cashflow Forecaster Agent" but *recovery-driven* and *auditable*. |
| **Why novel** | Agent Studio has generic Cashflow Forecaster Agent. **ARBITER's version is recovery-driven, uses actual batch signals (recovered/escalated/stopped), and has audit provenance.** |
| **Razorpay gap** | Agent Studio Cashflow Forecaster Agent is generic. ARBITER can say: "We forecast cash flow *from recovery decisions you can audit*." |
| **Impl sketch** | `metrics.ts`: `forecastCashflow(recoveryReport[], horizonDays)` → projects `expectedRecoveredPaise/day` using recovery rate per failure class + escalation resolution rate + historical promise-keeping. `recover.ts`: `--forecast` flag prints 30-day projection with confidence intervals. `dashboard/` (optional): tiny web UI with forecast chart. |
| **Demo criteria** | "Next 30 days: ₹2.3L expected recovery (CI [₹1.8L, ₹2.8L]) → 12 escalations expected to resolve → 3 promises due → cash-flow forecast with provenance." |
| **Judge points** | **Agent Studio adjacency not collision** (we do recovery-driven forecasting), **Measured recovery with provenance**, **Build Quality** (projection from actual batch signals). |
| **Effort** | M (2–3 days): `metrics.ts`, `recover.ts` flag, optional `dashboard/`. |

### 14.6 Checkout Conversion / Pre-Auth Optimization (§5.2) — **EXPANDS TAM**

| Aspect | Details |
|--------|---------|
| **What** | Reuse decision engine (`features.ts` + `engine.ts`) at *checkout* to pick best rail/method *before* failure. Essentially Optimizer's job but merchant-controlled, explainable, with governance envelope. |
| **Why novel** | Optimizer routes new auths via random forest (black box). ARBITER would be **merchant-controlled, explainable, with per-merchant policy envelope**. |
| **Razorpay gap** | Optimizer = gateway-agnostic routing for *new* transactions. No merchant-controlled, explainable checkout optimizer. |
| **Impl sketch** | `features.ts`: add `checkout_features` (cart value, customer tier, device, location, time). `engine.ts`: `checkoutDecide(input)` → returns recommended rail (UPI Autopay, Card, NetBanking, Wallet). `policy.ts`: `checkout_envelope` (rail preferences, cost caps). `api/checkout_optimizer.ts`: HTTP endpoint for checkout integration. |
| **Demo criteria** | "Checkout: ₹5,000 cart, premium customer → ARBITER recommends UPI Autopay (high success, low cost) → merchant accepts → payment succeeds → audit shows checkout decision." |
| **Judge points** | **TAM expansion** (top-of-funnel), **Agent Studio adjacency** (we do checkout optimization with governance), **Build Quality** (reuse existing engine). |
| **Effort** | L (4–5 days): new features, new engine path, API endpoint, demo integration. |

### 14.7 Rural/Inclusive Payment Success (§5.3) — **HIGH "WOW" FOR INDIA JUDGES**

| Aspect | Details |
|--------|---------|
| **What** | Low-connectivity features: extended timeouts, offline-capable initiation, regional-language recovery, extended retry windows for low-bandwidth areas. Re-add "rurality" signal dropped from original 11 features. |
| **Why novel** | Razorpay publishes rural success-rate guidance but no recovery tool has explicit rural/inclusive features. Generic global tools assume reliable connectivity. |
| **Razorpay gap** | Razorpay blog publishes rural success-rate guidance. No recovery product has rural-specific logic. |
| **Impl sketch** | `features.ts`: add `rurality_score` (0–1 from pincode/device/network), `extended_timeout_ok`, `offline_retry_ok`. `window.ts`: `nextRuralRecoveryWindowMs()` extends window for high rurality. `catalog.ts`: `RECOVER_VOICE_REGIONAL` action (Hinglish/Tamil/Telugu/etc. via Gupshup). `policy.ts`: `rural_envelope` (extended caps). `generator.ts`: rural customer corpus. |
| **Demo criteria** | "Rural customer (rurality=0.8) → ARBITER extends retry window 3× → uses regional voice → succeeds where standard retry fails." |
| **Judge points** | **India-specific depth** (Razorpay cares), **Inclusivity narrative**, **Problem Taste** (real underserved segment). |
| **Effort** | M (2–3 days): features, window, catalog, generator. |

### 14.8 Cross-PSP Recovery with Optimizer Integration (§4.1) — **CORE MOAT**

| Aspect | Details |
|--------|---------|
| **What** | When Razorpay payment fails (UPI mandate declined, card expired), ARBITER recovers via *different rail the merchant also owns*: Razorpay Payment Link (cards), Smart Collect (bank transfer), or secondary PSP via Optimizer. |
| **Why novel** | Optimizer routes *new* auths; Stripe Orchestration routes *new* retries. **No one autonomously recovers a *failed Razorpay charge* via a different rail as a policy-bounded agent with audit.** |
| **Razorpay gap** | Optimizer = new-txn routing. UPI Autopay interoperability = mandate execution routing. **No cross-rail post-failure recovery agent.** |
| **Impl sketch** | `catalog.ts`: `RECOVER_VIA_RAIL` action with `target_rail: 'razorpay_payment_link' \| 'smart_collect_upi' \| 'optimizer_secondary_psp'`. `executor/razorpay.ts`: `executeCrossPSPRecovery()` builds payload for target rail. `engine.ts`: failureClass→rail mapping (`UPI_MANDATE_DECLINED → payment_link`, `CARD_EXPIRED → smart_collect_upi`, `ISSUER_DOWN → optimizer_secondary_psp`). `generator.ts`: `secondary_rails` per merchant config. `recover.ts`: `--cross-psp-demo` flag. |
| **Demo criteria** | "UPI Autopay mandate failed (insufficient funds) → ARBITER chooses `RECOVER_VIA_RAIL` → Razorpay Payment Link created → `rzpRequestRef: cross_psp_abc123` logged → audit shows rail switch `upi_autopay → payment_link`." |
| **Judge points** | **Core moat** (structurally impossible for single PSP), **Problem Taste** (real revenue leak when primary rail fails), **Agent Studio adjacency** (we do cross-PSP; they don't). |
| **Effort** | M (2–3 days): `catalog.ts`, `executor/razorpay.ts`, `engine.ts`, `generator.ts`. |

### 14.9 Multi-Merchant Federated Demo with Real Eval — **FEDERATED MOAT PROOF**

| Aspect | Details |
|--------|---------|
| **What** | Simulate 4 merchant silos (B2C SaaS, D2C subscription, B2B invoicing, EdTech) with distinct failure distributions. FedAvg + DP noise → global model. Evaluate per-merchant AUC lift vs local-only on held-out data. |
| **Why novel** | FL exists for fraud (NVIDIA FLARE 2026, JPMorgan, Stripe). **Zero for recovery response modeling.** Recoup is single-merchant only. |
| **Razorpay gap** | Agent Studio = single-merchant. No cross-merchant learning. |
| **Impl sketch** | `federation.ts`: `trainLocal(merchantId, localData)`, `aggregate(weights[], dpNoiseSigma)`, `evaluateGlobal(heldOutPerMerchant)`. `registry.ts`: `promoteFederated()` gates on `globalAUC > localAUC + threshold`. `generator.ts`: 4 merchant corpora with distinct failure distributions. `recover.ts`: `--federated-demo` flag. |
| **Demo criteria** | `Merchant A (local AUC 0.71 → fed 0.76) \| Merchant B (0.68 → 0.73) \| Merchant C (0.74 → 0.77) \| Merchant D (0.69 → 0.72) \| Global: 0.745 [SIMULATED]`. |
| **Judge points** | **Core moat** (FL for fraud exists, not recovery), **Data network effect**, **Privacy-preserving** (DP noise). |
| **Effort** | M (2–3 days): `federation.ts`, `registry.ts`, `generator.ts`, `recover.ts` flag. |

### 14.10 Voice/WhatsApp as Governed Channel (§4.6) — **ORCHESTRATION MOAT**

| Aspect | Details |
|--------|---------|
| **What** | Voice/WhatsApp as *EV-ranked actions inside a guardrailed envelope with hash-chained audit*. Not channel novelty (Gupshup, Caller Digital, CallMissed exist) — claim **governed multimodal orchestration brain**. |
| **Why novel** | Competitors have voice/WhatsApp as *channels*. ARBITER has them as *EV-ranked actions inside a guardrailed envelope with hash-chained audit*. |
| **Razorpay gap** | Agent Studio: voice is a channel (ElevenLabs). No governance envelope for multimodal. |
| **Impl sketch** | `catalog.ts`: `RECOVER_VOICE_HI`, `RECOVER_VOICE_REGIONAL`, `RECOVER_WHATSAPP` actions. `executor/razorpay.ts`: `buildVoicePayload()`, `buildWhatsAppPayload()` with Gupshup/WhatsApp Business API templates (Hinglish/Tamil/Telugu `{{1}}` personalization). `engine.ts`: voice cost higher → only chosen if EV justifies. `policy.ts`: `voice_envelope` (max attempts, quiet hours, consent). |
| **Demo criteria** | "High-LTV customer, soft decline → ARBITER chooses `RECOVER_WHATSAPP` (EV > SMS) → Gupshup template with `{{1}}` personalization sent → audit shows channel choice rationale + payload." |
| **Judge points** | **Governed multimodal orchestration** (Agent Studio principle), **AI Judgment** (rules-first: voice only if EV justifies; LLM-tail: generate template), **India-specific** (Hinglish/regional). |
| **Effort** | M (2–3 days): `catalog.ts`, `executor/razorpay.ts`, `engine.ts`, `policy.ts`. |

---

## 15. Updated This Week's Winning Moves: Bug Fixes + New Features Priority Matrix

| Priority | Move | Type | Files | Effort | Rationale |
|----------|------|------|-------|--------|-----------|
| **P0** | Fix LTV normalization constant (Bug #1) | Bug | `features.ts:19` | <1 hr | Unblocks LTV-aware EV — currently ineffective |
| **P0** | Fix control arm baseline (Bug #2) | Bug | `recovery.ts:148` | <1 hr | Invalidates "honest measurement" claim |
| **P0** | Fix federated DP noise determinism (Bug #10,11) | Bug | `federation.ts:35,97` | <1 hr | Breaks reproducibility; audit trail broken |
| **P0** | Fix Razorpay dry-run ignores multipliers (Bug #13) | Bug | `razorpay.ts:110` | <1 hr | Dry-run shows success for failing actions |
| **P0** | Fix `editProposal` breaks after feature change (Bug #18) | Bug | `pipeline.ts:402` | 2–4 hrs | All existing proposals uneditable |
| **P0** | Enable `exactOptionalPropertyTypes` (Bug #29) | Bug | `tsconfig.json` | 1–2 hrs | Catches undefined accesses |
| **P1** | Real Razorpay dry-run executor (Move 1) | Feature | `executor/razorpay.ts`, `engine.ts`, `schema.ts` | 2–3 days | **Unblocks "real touch" — highest judge signal** |
| **P1** | LTV-aware EV + held-out calibration (Move 2) | Feature | `features.ts`, `engine.ts`, `recover.ts` | 1 day | **Highest wow/effort** — differentiates from flat-EV incumbents |
| **P1** | Cross-PSP recovery demo (Move 3) OR Federated demo (Move 4) | Feature | `catalog.ts`, `executor/razorpay.ts`, `federation.ts` | 2–3 days | **Core moat** — "what no PSP ships" headline |
| **P2** | RBI/DPDP auto-escalation (14.1) | Feature | `policy.ts`, `envelope.ts`, `generator.ts` | 2–3 days | True moat — structurally impossible for foreign PSPs |
| **P2** | Rail-health timing (14.2) | Feature | `features.ts`, `window.ts`, `ingest/rail_health.ts` | 2–3 days | High wow/effort — India-specific |
| **P2** | Promise-to-pay loop (14.3) | Feature | `catalog.ts`, `schema.ts`, `pipeline.ts` | 2–3 days | Differentiate vs Recoup |
| **P3** | B2B partial recovery (14.4) | Feature | `catalog.ts`, `executor/razorpay.ts` | 2–3 days | Smart Collect integration |
| **P3** | Recovery-driven cash-flow forecasting (14.5) | Feature | `metrics.ts`, `recover.ts` | 2–3 days | Competes with Agent Studio |
| **P3** | Rural/inclusive features (14.7) | Feature | `features.ts`, `window.ts`, `catalog.ts` | 2–3 days | High "wow" for India judges |
| **P3** | Voice/WhatsApp governed orchestration (14.10) | Feature | `catalog.ts`, `executor/razorpay.ts` | 2–3 days | Governed multimodal brain |

### Execution Order (Sequential)

| Day | Focus | Deliverable |
|-----|-------|-------------|
| **Mon AM** | P0 Bugs 1–6 | LTV norm fixed, control arm uses historical baseline, fed deterministic, razorpay uses multipliers |
| **Mon PM** | P0 Bugs 7–10, 29 | `editProposal` migration, `exactOptionalPropertyTypes`, type fixes |
| **Tue** | **Move 1: Real Razorpay Dry-Run** | `executor/razorpay.ts` + `schema.ts` + `engine.ts` wiring → `pnpm recover --dry-run-real` prints valid Payment Link payload + `rzpRequestRef` in audit |
| **Wed** | **Move 2: LTV-EV + Held-Out Calibration** | LTV features + `recover.ts --held-out-seed` → honest lift with CI |
| **Thu** | **Move 3: Cross-PSP Recovery** OR **Move 4: Federated Demo** | Pick one moat demo; `pnpm recover --cross-psp-demo` OR `--federated-demo` |
| **Fri** | **P1/P2 Polish + Demo Prep** | RBI auto-escalation (14.1) or Rail-health (14.2) if time; demo rehearsal; pitch deck |

### Stretch (If Time Permits)

- Promise-to-pay loop (14.3) — differentiates vs Recoup
- Rail-health timing (14.2) — high wow, India-specific
- Recovery-driven cash-flow forecasting (14.5) — competes with Agent Studio
- Rural/inclusive features (14.7) — high "wow" for India judges

---

## 16. Sources (Extended)

- **Razorpay Buildathon 2026 criteria:** razorpay.com/buildathon, velonx.in/blog/razorpay-ai-buildathon-2026, coursejoiner.com/internship/razorpay-ai-builder-internship-2026, cloudsutra.in/jobs/razorpay-hiring-ai-builder-intern-in-bangalore, linkedin.com/posts/razorpay-careers_razorpaybuildathon-aiinterns-hiring-activity-7497899727838076929
- **Razorpay Agent Studio (FTX 2026):** razorpay.com/newsroom/razorpay-launches-the-worlds-first-ai-native-agent-studio-for-payments-at-ftx26-powered-by-anthropics-claude, razorpay.com/blog/agent-studio-ai-agents-by-razorpay, razorpay.com/blog/razorpay-agent-studio-principles-guardrails-and-merchant-control, thehindubusinessline.com, techcircle.in, moneycontrol.com, thepaypers.com
- **UPI Autopay v2 / Intelligent Revenue-Protect:** razorpay.com/blog/upi-autopay-with-intelligent-revenue-protect, razorpay.com/blog/upi-autopay-interoperability, razorpay.com/blog/master-recurring-payments-upi-autopay-guide, razorpay.com/upi-autopay
- **Optimizer:** razorpay.com/optimizer-intelligent-payments-routing
- **Failed Payment Recovery:** razorpay.com/blog/razorpay-failed-payment-recovery
- **Competitor Track-3 repos:** github.com/abhinav-phi/reflex, github.com/Shikari-ai/recoup, github.com/HappyGarg8o/ai-revenue-recovery, github.com/AdithyaAbburi/RecoverAI
- **Federated Learning for Fraud (2026):** arxiv.org/html/2603.13617 (NVIDIA FLARE), eureka.patsnap.com
- **India Voice/WA Dunning:** callmissed.com, gupshup.ai/whatsapp-api, caller.digital, whatsboost.in
- **Payment Orchestration Cross-PSP:** gr4vy.com/posts/payment-retry-logic-explained, paymentbrief.com, primer.io/blog
- **NPCI Guidelines 2026:** razorpay.com/blog/master-recurring-payments-upi-autopay-guide
- **Smart Collect 2.0:** razorpay.com/docs/payments/smart-collect/
- **DPDP Act 2023:** meity.gov.in/dpdp-act-2023
- **TRAI DLT Regulations:** trai.gov.in/dlt-regulations

---

## 17. Novel Angles — Implementation Status (SHIPPED IN CODE)

> Branch `feat/track3-novel-angles` (built on top of `feat/track3-differentiation`).
> All eight §4 angles are now **real, tested code**, not sketches. `pnpm verify`
> (typecheck + full suite) is green — **313 tests passing** across 41 files.

| § | Angle | Status | Where it lives | Commit |
|---|-------|--------|----------------|--------|
| 4.1 | Cross-PSP / cross-rail recovery | ✅ | `catalog.ts` (`RECOVER_VIA_RAIL`, `railForFailureClass`), `executor/razorpay.ts` (`buildCrossPspPayload` → Optimizer `optimizer_secondary_psp`), `engine.ts` (immediate), `tests/core/cross_psp.test.ts` | `8771926` |
| 4.2 | Privacy-preserving federated intelligence | ✅ | `federation.ts` (seeded `Rng` DP noise, fixed `FEDERATION_EPOCH_MS`), `registry.ts` (`promoteFederated` → INCUMBENT + audit `OUTCOME`), `federate.ts` (multi-silo demo), `tests/ml/federation.test.ts` | `ac09143` |
| 4.3 | Regulatory / compliance auto-escalation | ✅ | `policy.ts` (`regulatory_profile`, `CONSENT_LAPSED`/`AUTOPAY_RETRY_CEILING`/`PRE_DEBIT_NOTICE`, hard refusals in `evaluateConstraints`), `config/policy.yaml`, `tests/core/regulatory.test.ts` | `6e085dd` |
| 4.4 | LTV-aware recovery | ✅ | `shared/ltv.ts` (`LTV_NORM_PAISE = ₹25,000`), `features.ts` + `engine.ts` (`ltvWeight`), `tests/core/decide.test.ts` | `3efa661` |
| 4.5 | Real-time rail-health | ✅ | `ingest/rail_health.ts` (`simulatedRailHealth`, `RailHealth`), `window.ts` (`nextRailHealthyWindowMs`, `RAIL_DEPENDENT_ACTIONS`), `engine.ts` (`railHealthScore` + `scheduleWithRailHealth`), `pipeline.ts`, `tests/core/rail_health.test.ts` | `df83e63` |
| 4.6 | Audited multilingual voice + WhatsApp | ✅ | `catalog.ts` (`RECOVER_VOICE_HI`, `RECOVER_WHATSAPP`), `executor/razorpay.ts` (`buildVoicePayload`, `buildWhatsAppPayload` — Gupshup Hinglish `{{1}}`), rail-gated, `tests/core/voice_whatsapp.test.ts` | `a961421` |
| 4.7 | Promise-to-pay behavioral loop | ✅ | `db/schema.ts` + migration `0004` (`promise_to_pay`), `promise_store.ts` (`recordPromiseToPay`/`reconcilePromises`/`markPromiseKept`/`queryPromiseKeptRate`), `features.ts` (`promise_kept_rate`), `pipeline.ts` (records on `PROMISE_TO_PAY`), `tests/ml/promise.test.ts` | `631f244` |
| 4.8 | B2B partial-collect (Smart Collect) | ✅ | `catalog.ts` (`PARTIAL_COLLECT`, `PARTIAL_COLLECT_FRACTION = 0.3`), `executor/razorpay.ts` (`buildSmartCollectPayload` → `smart_collect_upi`, deterministic VPA), `tests/core/partial_collect.test.ts` | `f12d1c6` |

### Why this wins the moat (one-liners)
- **4.1** A neutral agent can switch rails for a merchant that owns several PSPs — something a single PSP's own retry product structurally cannot do.
- **4.2** Federated, DP-noise-protected merchant intelligence with a real promotion trail — no competitor ships cross-merchant learning.
- **4.3** Fail-closed RBI/NPCI/DPDP/TRAI rules live in the policy engine, independent of the merchant envelope, so a merchant **cannot** toggle them off.
- **4.4** Stops chasing a ₹49 failure like a ₹5L whale — LTV-weighted EV, realistic norm.
- **4.5** Defers rail-dependent recovery off UPI evening peaks using a deterministic rail-health signal (kept out of the frozen feature vector).
- **4.6** Voice/WhatsApp as **EV-ranked, envelope-governed, audited** actions with Hinglish personalization — not just channels.
- **4.7** Records a customer's promise-to-pay and learns the kept-rate — goodwill no single PSP models.
- **4.8** Proposes a partial first installment on a large B2B invoice via a deterministic Smart Collect identifier — a single PSP only asks full-or-nothing.

## 18. Payment-Trial Sandbox (mock, no real money / network)

> Validates the **recovery-collection payment workflow** end-to-end against 20
> production-like failure/recovery scenarios in a fully sandboxed, in-memory
> SQLite database. The "provider" is `MockRazorpayProvider` — a deterministic
> script keyed by scenario id, **no network, no real gateway, no real money**.

### What it proves (the brief's "realistic payment-trial environment")
- **Double-charge safety** — the central hazard ("provider charged but the
  response was lost") is exercised by `success_lost_response` and the
  `duplicate_request` / `multiple_submits` / `idempotency_repeat` / `concurrent_attempts`
  scenarios. A retry (or concurrent request) with the same client idempotency
  key **always** resolves to the *same* charge — never a second one.
- **Idempotency registry** — `payment_intents(client_idem_key UNIQUE)` +
  `executePaymentIntent` / `reconcileIntent`. Checked *before* any proposal-state
  assertion, so a retry arriving after the proposal moved to `EXECUTING` still
  short-circuits.
- **Lost-response UX** — when the provider charged but the response never
  reached the client (`delivered=false`), the intent is `SUCCEEDED` server-side
  (balance debited once) but `clientVisible=UNKNOWN`; the retry is idempotent and
  the customer is told to wait for confirmation, never "success" prematurely.
- **Uncertain outcomes never terminate early** — timeouts/unavailable/network-down/
  server-error/client-disconnect leave the intent `UNKNOWN` and the proposal
  `EXECUTING`; a later `reconcileIntent` (provider webhook) settles it exactly
  once (idempotent debit).
- **Safe user messages** — every client-visible message is derived only from a
  safe `errorCode` + failure class; no stack traces, raw codes, or internals leak.
- **Audit + notifications** — each attempt writes an `audit_log` row and a
  channel-appropriate `notifications` row.

### Package layout (`packages/trial`)
| File | Role |
|------|------|
| `src/provider.ts` | `MockRazorpayProvider` + `PROVIDER_SCRIPT` (per-scenario deterministic outcomes; stateful for duplicate replays) |
| `src/scenarios.ts` | `SCENARIOS` — 20 scenarios (id/title/failureClass/action/pattern) |
| `src/orchestrator.ts` | `runTrial(client, scenario, provider, nowMs)` → `TrialReport` (request, provider response, backend decision, final state, DB, user message, notification, idempotency, retry) |
| `src/userMessage.ts` | `userFacingMessage` (en/hi, safe) + `channelForAction` |
| `src/run.ts` | `pnpm trial` CLI — prints the per-scenario table + detail |
| `tests/payment_trial.test.ts` | 7 tests, 20 scenarios — no double charge, idempotent, lost-response UNKNOWN, safe messages, notifications, concurrent |

### Run it
```bash
pnpm trial          # live sandbox report (no real money/network)
pnpm verify         # typecheck + full suite (now 320 tests, +7 trial)
```

### Core fix delivered by the sandbox
The sandbox surfaced (and we fixed) the correct ordering of the double-charge
guard: idempotency lookup must happen **before** the proposal-state assertion,
and a `client_visible` column preserves the lost-response "UNKNOWN" across
idempotent replays. See `packages/core/src/executor/payment_intent.ts`.


