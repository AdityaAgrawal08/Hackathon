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
4. **We overlap incumbents squarely.** Razorpay *already ships* Failed Payment Recovery (multichannel WhatsApp/Email/SMS payment links, "recover up to 20%") and Intelligent Payment Retry. Stripe/Adyen/GoCardless/Chargebee/Recurly all ship retry/dunning. Our core loop is a competent re-implementation of what they already do, minus the real integration.

### Verdict
We will score well on **engineering quality, completeness, and the audit/guardrail story** — exactly what the Razorpay *hiring* eval rewards (the Buildathon is a ₹75k/month internship funnel; judges are Razorpay engineers/PMs, not VCs). But to *win* we must add one or two things incumbents demonstrably do **not** do, and we must close the "simulated execution" gap enough to demonstrate a real Razorpay touch.

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
