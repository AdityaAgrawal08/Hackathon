# Implementation Plan — "Salvage": Closed-Loop Revenue Recovery Agent

> **Razorpay AI Buildathon · Track 03 (AI Revenue Recovery)**
> Solo builder · Part-time (~3–4 hrs/day) · Deadline window: ~Sept 5, 2026
> Stack: TypeScript / Next.js · SQLite · Claude API · Razorpay Test-Mode APIs

---

## Table of Contents

1. [Context: Why This Track](#1-context-why-this-track)
2. [Product Thesis](#2-product-thesis)
3. [Scope Boundaries: What We Are and Are Not Building](#3-scope-boundaries)
4. [Architecture Overview](#4-architecture-overview)
5. [Technology Stack — Every Choice Justified](#5-technology-stack)
6. [Core Design Principle: Intelligence vs. Authority](#6-core-design-principle)
7. [Component Specifications](#7-component-specifications)
8. [Data Model](#8-data-model)
9. [Directory Structure](#9-directory-structure)
10. [Day-by-Day Execution Schedule](#10-day-by-day-execution-schedule)
11. [Evaluation Framework & Honesty Policy](#11-evaluation-framework--honesty-policy)
12. [Demo & Video Plan](#12-demo--video-plan)
13. [Documentation Strategy](#13-documentation-strategy)
14. [Risk Register & Cut Order](#14-risk-register--cut-order)
15. [Security, Privacy & Compliance Notes](#15-security-privacy--compliance-notes)
16. [Panel Preparation: Anticipated Questions](#16-panel-preparation)
17. [Day 0 Setup Checklist](#17-day-0-setup-checklist)
18. [Definition of Done](#18-definition-of-done)

---

## 1. Context: Why This Track

### 1.1 What the Razorpay AI Buildathon actually is

This is not a prize hackathon. It is a **hiring filter** into Razorpay's AI engineering teams
(₹75,000/month internship, 6–12 months, Bangalore). Selection is proof-of-work based:
a public repo that runs, a 5-minute video, architecture documentation, and a panel round.
Their own recruiting copy states what they read instead of resumes:

> "a repo that actually runs, a 5-minute video of it working, what broke at 2 AM, and how you got out."

**Implication:** every decision below optimizes for *demonstrated engineering judgment under
constraint*, not for ambition on paper.

### 1.2 Evidence base for choosing Track 03

Research into Razorpay's current strategy (Sprint 2026 launch event, FTX'26 announcements,
newsroom releases, Inc42/Business Standard coverage) shows five active priorities:

| Razorpay initiative | Evidence | Maps to |
|---|---|---|
| Subscription Recovery Agent (production, voice-led, ElevenLabs partner) | FTX'26 launch, March 2026 | **Track 03 directly** |
| Abandoned Cart Conversion Agent (production, voice-led; Zomato/SuperU partners) | FTX'26 launch | **Track 03 directly** |
| Receivables Agent (invoice follow-up by phone) | Sprint 2026 catalog | **Track 03 directly** |
| Dispute/RTO agents | FTX'26 launch | Track 02 territory |
| UPI Reserve Pay / NPCI agentic pilots (Zomato, Swiggy, Zepto inside ChatGPT/Claude) | Feb–Mar 2026 announcements | Track 01 territory |

Three of Razorpay's four launched production agents **are revenue-recovery agents**. The track
bar ("measured money recovered across a batch, with compliant escalation, stopping rules, and an
audit trail") is structurally identical to how their own Agent Studio products are described
("every money action explainable, bounded and gated").

### 1.3 Why not the other tracks (given a solo, part-time builder)

- **Track 01 (Agentic Commerce)** is the hype magnet — largest submission pool, and its most
  differentiating substance (NPCI's UAP, UPI Reserve Pay/SBMD) is unshipped or RBI-gated and
  therefore unreachable from student test-mode APIs. Most entries will bottom out as thin
  chatbot-plus-checkout mocks.
- **Track 02 (Risk Manager)** demands defensible datasets and a precision/recall evaluation
  harness — excellent fit for an ML-heavy pair, time-expensive for one person.
- **Track 04 (Finance Controller)** is feasible but has the lowest demo ceiling and weakest
  narrative pull for an *AI Builder* internship pitch.
- **Open Track** forfeits the alignment signal of attacking a problem Razorpay explicitly named.

Weighted scoring across feasibility (solo), hiring signal, differentiation, video wow-factor,
and rubric measurability placed Track 03 at 4.55/5 versus 3.05–3.48 for alternatives.

---

## 2. Product Thesis

One sentence, suitable for the README header and the video opening:

> **Salvage catches revenue the moment it starts slipping — it diagnoses WHY a payment failed,
> chooses a bounded and compliant intervention, executes it on Razorpay APIs, and proves its
> value with measured rupees recovered against controlled baselines.**

The product closes one complete loop — detect → diagnose → decide → act → prove — rather than
demonstrating fragments. Judges can verify every claim by running two commands.

### The problem being solved (for the pitch)

Involuntary churn — payments failing silently — is a large, quantifiable leak for Indian
subscription/D2C merchants (failed eNACH/UPI AutPay debits, expired cards, insufficient funds
around salary cycles). Merchants either ignore failures (revenue gone) or blast blind retries
(customer annoyance, issuer penalties, zero recovery on genuinely dead payment methods).
The interesting problem is **triage**: which failures are worth touching, with what intervention,
in what order, and when to stop.

---

## 3. Scope Boundaries

Explicit scope is a survival requirement for a solo part-time build. Everything below is
deliberately excluded, and the exclusion itself is a talking point ("we scoped to finish"):

| In scope | Out of scope (and why) |
|---|---|
| Razorpay **test-mode** integrations only | Live money movement — regulatory + risk; test mode proves the code path |
| Synthetic customer/payment data (seeded, reproducible) | Real PII — privacy surface area for zero judging benefit |
| Simulated message delivery (email/WhatsApp marked `SIMULATED`) | Real SMS/WhatsApp sends — DLT registration, TRAI compliance, cost, irrelevance to logic |
| Single merchant tenant | Multi-tenancy/auth systems — plumbing, not signal |
| Deterministic policy engine + LLM diagnosis | Custom-trained ML models — no dataset exists that would make training honest at this scale |
| Voice follow-up as **stretch goal only** | Live calling — Twilio/ElevenLabs integration is a multi-day detour; a scripted TTS preview suffices if reached |

---

## 4. Architecture Overview

```
                        ┌─────────────────────────────────────────────┐
                        │           NEXT.JS DASHBOARD                 │
                        │  Failed-payments inbox · Customer timelines │
                        │  Policy editor · Metrics (A/B/C) · Batch UI │
                        └───────────────┬─────────────────────────────┘
                                        │ reads/writes
        ┌───────────────────────────────┼──────────────────────────────┐
        ▼                               ▼                              ▼
┌──────────────┐   ┌──────────────────────────┐   ┌───────────────────────────┐
│ INGESTION    │   │ RECOVERY PIPELINE        │   │ BATCH SIMULATOR           │
│ • Webhook rx │──►│ 1 DIAGNOSE (Claude,      │◄──│ • Replays seeded batch    │
│   signed,    │   │   structured output,     │   │   through three arms:     │
│   idempotent │   │   rule fallback)         │   │   A: no intervention      │
│ • Seed-replay│   │ 2 POLICY CHECK (determ.) │   │   B: naive retry-all      │
│   mode       │   │ 3 ACT (bounded executors)│   │   C: Salvage agent        │
└──────────────┘   │ 4 AUDIT (append-only)    │   │ → recovery-rate report    │
                   └───────────┬──────────────┘   └───────────────────────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │ RAZORPAY TEST MODE  │
                    │ orders · payments · │
                    │ subscriptions · UPI │
                    │ payment links ·     │
                    │ saved tokens        │
                    └─────────────────────┘
```

### 4.1 Why this shape

- **Pipeline as four discrete stages** (diagnose/policy/act/audit) rather than one monolithic
  agent loop: each stage is independently testable, and the stage boundaries are exactly where
  guardrails live. Monolithic agent loops are where "the LLM did something weird" stories come
  from; stage boundaries are where they are prevented.
- **Simulator as a first-class component**, not an afterthought: Track 03's bar is *measured*
  recovery. If measurement is bolted on late, it gets cut when time runs short. Building it as
  core architecture guarantees the headline artifact exists.
- **Two ingestion paths** (webhook + seed replay): live webhooks prove production correctness;
  replay mode guarantees the demo never depends on webhook timing luck during recording or the
  panel round.

---

## 5. Technology Stack

Each choice lists the rejected alternative, because the panel may probe them.

### TypeScript / Next.js (App Router) — full-stack framework ✅
**Why:** One language across dashboard, API routes, pipeline, simulator, and seed generator;
shared types end-to-end (a `PaymentEvent` type flows from ingestion to audit unchanged); solo
builders lose the most time at language/tooling seams. Rejected: Python/FastAPI — marginally
nicer for numeric simulation, but our simulation is a parameterized Monte Carlo (trivial in any
language), while the UI + API surface is substantial. Net win: TS.

### SQLite + Drizzle ORM ✅
**Why:** Zero infrastructure — judges clone, `pnpm dev`, and everything works from a file DB.
Drizzle provides typed schemas and migrations without a database server. Rejected: Postgres +
Redis + BullMQ — correct for production scale, pure setup tax for this scope. The concurrency
limitation (single writer) is irrelevant for a single-operator demo and is documented honestly
in ARCHITECTURE.md.

### Official `razorpay` npm SDK (test keys) ✅
**Why:** Money paths must be boring and reliable; the official SDK is maintained against API
changes. Rejected for the critical path: building everything atop the Razorpay MCP server —
architecturally fashionable and strongly on-brand (Razorpay ships an official MCP server, and
their Agent Studio story is MCP-native), but it adds an indirection layer on the exact path
where debugging time hurts most. **Compromise:** the SDK handles all money actions; wiring the
official remote MCP server as a read-only diagnostic Q&A surface ("ask your recovery agent why
payment X failed") is a stretch goal that showcases fluency with their tooling without betting
the deadline on it.

### Claude API with structured outputs (temperature 0, prompt caching) ✅
**Why:** Razorpay's own Agent Studio is built on Anthropic's Claude Agent SDK — using Claude is
strategic alignment, and its JSON-schema-constrained outputs give the determinism the policy
engine upstream requires. Temperature 0 + response caching keeps reruns reproducible and cost
near-zero (~$1–3 total for the whole build). Rejected: local/self-hosted models (setup time),
GPT-class alternatives (no strategic downside, no upside either).

### Rule-based diagnostic fallback ✅
**Why:** If the Claude API is down mid-demo, the recovery loop must still function. Mapping
decline codes to classes via a static table degrades gracefully — and doubles as the required
"one failure handled gracefully" demonstration if it ever triggers live.

### Scheduling via in-process cron (`node-cron`) ✅
**Why:** Retry sequences need delayed execution; a persistent worker process with cron ticks
covers it without Redis queues. Rejected: cloud schedulers/serverless functions — deployment
complexity for zero judging value.

---

## 6. Core Design Principle: Intelligence vs. Authority

This is the single most important architectural statement in the project, and the lead talking
point in both the video and the panel:

> **The LLM proposes; the policy engine disposes.**

Concretely:

```
Claude (intelligence):     classifies failure, hypothesizes root cause,
                           RECOMMENDS an intervention with confidence score

Policy Engine (authority): deterministic, config-driven gate that decides
                           whether/when/how that recommendation may execute

Executors (action):        perform bounded operations, idempotently

Audit Ledger (proof):      append-only record of trigger → diagnosis →
                           policy verdict → action → outcome
```

**Why this matters (and must be said explicitly):**
1. **Boundedness:** Track 03's bar requires stopping rules and compliant escalation. An LLM
   cannot be trusted with money-adjacent authority because its outputs are probabilistic. A
   YAML-configured rule set is auditable line-by-line.
2. **Testability:** the policy engine is pure-function testable — no mocking an LLM to assert
   "attempt #4 within 24h is refused."
3. **Demonstrability:** the strongest 60 seconds of the final video is the policy engine
   *refusing* an out-of-bounds action on camera, with the refusal logged. Refusal-as-feature is
   rare in hackathon entries and precisely matches Razorpay's internal ethos.
4. **Hiring narrative:** this is how Razorpay describes their own agents ("explainable, bounded
   and gated"). Mirroring the principle signals the candidate already thinks in their patterns.

---

## 7. Component Specifications

### 7.1 Seed Data Generator — `packages/seed`

**What:** Generates a synthetic but realistic corpus: ~120 customers, ~400 failed-payment
events, plus enough history (prior successes, subscription age) for diagnosis to reason over.

**Why synthetic-but-realistic:** Real data is unavailable and unethical to fabricate from real
PII; but uniform random data would make diagnosis meaningless (nothing to diagnose *from*).
The middle path is a generative model encoding known Indian payment realities.

**Failure taxonomy encoded (with rationale):**

| Class | Share | Example codes | Recovery physics |
|---|---|---|---|
| `SOFT_RETRYABLE` | ~45% | insufficient funds (UPI/NACH) | Retry succeeds meaningfully often, especially near salary windows (1st/30th); timing matters more than frequency |
| `HARD_METHOD_DEAD` | ~25% | card expired, mandate revoked | Retrying the same method ≈ always fails; only alternate-method intervention helps |
| `NETWORK_TIMEOUT` | ~15% | issuer timeout, gateway timeout | Safe to retry immediately; waiting wastes the window |
| `RISK_FLAGGED` | ~10% | suspected fraud markers | **Never auto-touch** — routes to human review; auto-contact here is liability |
| `UNKNOWN` | ~5% | unmapped codes | Human review; honest "I don't know" beats confident nonsense |

**Why these shares:** they approximate publicly discussed distributions for recurring-debit
failures in India (insufficient funds dominates e-mandate failures). Exact numbers are less
important than the *shape*; the methodology doc states shares as modeling choices.

**Determinism:** fixed RNG seed, committed alongside generated fixtures. Judges re-running the
seed get byte-identical data — reproducibility is a stated Razorpay value ("one cherry-picked
match proves nothing").

**Customer behavior parameters:** each synthetic customer carries `payday_affinity`,
`channel_responsiveness` (email/link click-through tendency), `churn_risk`. These drive the
simulator's recovery probabilities so interventions have *differential* effects — without this,
arm C cannot beat arm A for any reason other than magic.

### 7.2 Ingestion Layer — `app/api/webhooks/razorpay` + replay service

**What:** (a) Webhook endpoint verifying Razorpay signatures (HMAC), persisting events with an
idempotency key (`event.id`) so duplicate deliveries are absorbed; (b) replay service that
feeds seeded events through the identical pipeline entry point.

**Why signature verification even in test mode:** it costs twenty lines and demonstrates trust-
boundary discipline; skipping it invites the easiest possible panel criticism.

**Why idempotency as a first-class concern:** duplicate webhook delivery is a *guaranteed*
production phenomenon, not an edge case. Razorpay redelivers on missed ACKs. An agent that
double-contacts customers because of double-delivered webhooks is worse than no agent — and
this is exactly the kind of "what broke at 2 AM" story the application says they read for.
We handle it *by design* rather than discovering it at 2 AM (then documenting the near-miss
anyway, because the story still teaches).

**Why replay mode is the demo default:** recorded videos and live panels punish timing
dependence. Replay feeds the pipeline synchronously from fixtures; the webhook path remains
available and demonstrated separately for authenticity.

### 7.3 Diagnosis Engine — `packages/core/diagnosis`

**What:** Given a failed payment + customer history, produce a structured verdict:

```jsonc
{
  "failure_class": "SOFT_RETRYABLE",
  "root_cause_hypothesis": "Insufficient funds at debit time; salary credit expected ~28th based on history",
  "recommended_intervention": { "type": "SEQUENCED_RETRY", "params": {"attempts": 2, "first_window_hours": 24} },
  "confidence": 0.82,
  "reasoning_trace": ["3 prior successes, all post-27th", "decline code INSUFFICIENT_FUNDS", ...]
}
```

**Implementation:** Claude API call constrained by a JSON schema (structured output), fed a
compact case file (history summarized deterministically in code first — the LLM reasons over
curated facts, not raw rows). A static rule-table fallback maps obvious codes when the API is
unreachable.

**Design decisions and reasons:**
- **Summarize-before-LLM:** token cost drops ~10x and hallucination surface shrinks because the
  model sees a pre-computed fact sheet rather than raw transaction dumps.
- **Confidence field with consequences:** below threshold (e.g., 0.6) ⇒ forced human-review
  routing regardless of class. This operationalizes humility — the system has a designed path
  for "not sure."
- **Reasoning trace stored, not just the verdict:** the audit trail requirement ("every money
  action explainable") needs the *why*, persisted at decision time — reconstructing rationales
  after the fact is how audits become fiction.
- **Cache keyed on (event content, prompt version):** reruns of the same batch are free and
  identical — reproducibility again.

**Why an LLM here at all (anticipating the panel question "why is this AI?"):** decline-code
tables alone cannot weigh contextual evidence (history patterns, amount anomalies, timing) or
express calibrated uncertainty. The LLM's job is narrow, structured classification with
rationale — not open-ended agency. Narrow scope is what makes it dependable enough to ship.

### 7.4 Policy Engine — `packages/core/policy`

**What:** Pure, synchronous, config-driven evaluator. Input: proposed action + customer state.
Output: `{verdict: ALLOW | REFUSE | DEFER, matched_rules[], effective_params}`.

**Default policy pack (version-controlled YAML):**

```yaml
attempts:
  max_per_customer_per_cycle: 3
  min_interval_hours: 24
channels:
  ladder: [payment_link, reminder_link]   # voice appended only if stretch lands
quiet_hours_ist: "22:00-08:00"
exposure_cap_inr_per_customer: 10000       # beyond this → human review
opt_out: enforce                            # absolute veto, logged
promise_to_pay:                             # commitment pauses the machine
  pause_on_commitment: true
  followup_after_days: 3
hard_stops:
  failed_alternate_methods: 2               # then stop contacting
routing:
  RISK_FLAGGED: human_review                # never automated, ever
  UNKNOWN: human_review
  confidence_below: 0.6 -> human_review
```

**Why config-driven rather than hardcoded:** merchants differ (a B2B SaaS tolerates different
contact cadence than a D2C brand). Externalized policy makes the compliance posture *visible* —
judges read the YAML and immediately see stopping rules, quiet hours, and caps. Hardcoded rules
are invisible until they fail.

**Why refusals are first-class records:** a REFUSE verdict writes to the audit ledger with the
matched rule IDs. The demo moment — flipping a config to violate quiet hours and watching the
engine refuse + log — converts an abstract "guardrails" claim into sixty seconds of observable
behavior. It also satisfies the shared bar across tracks ("show the audit trail and one failure
handled gracefully").

### 7.5 Action Executors — `packages/core/actions`

**What:** Three bounded executors, each idempotent via client-generated keys:

1. **Sequenced retry** — re-attempts via saved token (`initiate_payment`), scheduled per policy
   windows; respects `min_interval_hours` and payday heuristics from diagnosis.
2. **Alternate-method link** — creates a UPI payment link (`create_payment_link_upi`) with
   personalized copy after `HARD_METHOD_DEAD`; delivery marked `SIMULATED`.
3. **Promise-to-pay tracker** — records commitments, pauses sequencing, schedules a single
   follow-up, auto-closes on payment.

**Why executors are thin:** all judgment lives upstream; executors translate ALLOWed intents
into API calls and normalize responses into ledger entries. Thin executors mean fewer places
for money-path bugs — the place where bugs cost the most credibility.

**Why every executor takes an idempotency key:** retries happen (network flakes, process
restarts). Without keys, a retried executor means a customer contacted twice or a payment
initiated twice. With keys, retries converge on the original outcome. This invariant is unit-
tested, not merely intended.

### 7.6 Audit Ledger — `packages/core/audit`

**What:** Append-only table capturing the full causal chain per event:

```
trigger(event_id) → diagnosis(class, confidence, trace, prompt_version)
                  → policy(verdict, matched_rules, config_version)
                  → action(type, executor, provider_request_id, idempotency_key)
                  → outcome(status, provider_response_id, timestamps)
```

**Why append-only:** an audit log that can UPDATE is a suggestion, not a ledger. Corrections
arrive as new entries referencing prior ones. This mirrors financial-system norms — appropriate
given the audience.

**Why config_version and prompt_version are stamped:** six weeks later, "why did it do this?"
is answerable only if we know *which rules and which prompt* were in effect. Version-stamping
turns the ledger from a diary into evidence. Cheap to implement on day one; retrofitting it
later is archaeology.

### 7.7 Batch Simulator & Experiment Harness — `packages/simulator`

**What:** Replays the seeded batch through three arms under identical conditions:

- **Arm A — control:** no intervention. Recovery occurs only via the seeded organic-rate model.
- **Arm B — naive baseline:** blind retry-all ×3 at fixed intervals. No diagnosis, no policy.
- **Arm C — Salvage:** full pipeline (diagnose → policy → act).

**Outputs per arm:** recovery rate (%₹), contacts-per-recovery, wasted attempts (contacts on
method-dead/risky customers), policy refusals, net ₹ after modeling contact-fatigue cost.

**Why arm B exists (this is the subtle one):** against arm A alone, arm C looks good, but a
skeptic asks "so does any automation beat doing nothing?" Arm B answers preemptively: dumb
automation actively burns goodwill on dead methods while missing recoverable soft failures.
C > A *and* C > B on both recovery AND wasted-contact metrics is the actual claim — efficiency,
not just volume. That dual-axis result is the defensible headline.

**How recovery outcomes are decided:** parameterized probability model per (failure class ×
intervention × customer profile), grounded in industry-heuristic ranges (e.g., soft-decline
dunning recovery ~15–30% within window; hard-method retry ~0%; alternate-method link ~5–15%),
with every parameter exposed and cited as an assumption. Monte Carlo over N runs yields ranges,
not fake point-precision.

**Why honest labeling is non-negotiable:** these rates are *modeled*, not field-measured — no
student has production outcome data. Claiming otherwise invites one devastating panel question.
Preemptive framing ("decision framework with illustrative economics; swap in your real rates")
converts the weakness into evidence of intellectual honesty, which the buildathon culture
explicitly rewards.

### 7.8 Dashboard — `app/`

**Views:** failed-payments inbox (class badges + confidence), customer timeline (ledger
rendered human-readable), policy editor (YAML form → validated config bump), metrics page
(A/B/C table + run history), batch runner button.

**Why a dashboard at all (vs CLI-only):** the 5-minute video is judged partly on product sense;
money recovery is inherently visual (watch the inbox triage itself, watch ₹ tick back). Also:
the timeline view *is* the audit-trail deliverable, rendered for humans.

**Deliberate plainness:** big buttons, obvious state, seeded reset. Polish budget goes to the
metrics page and timeline — the two views the camera will linger on — nowhere else.

---

## 8. Data Model

```sql
customers          (id, pseudo_name, phone_fake, email_fake, payday_affinity,
                    channel_responsiveness, churn_risk, opted_out)

payment_events     (id, customer_id, order_id rzp, subscription_id rzp,
                    amount_inr, failure_code, failure_class_hint,
                    source WEBHOOK|SEED, received_at)

diagnoses          (id, event_id, failure_class, root_cause, recommended json,
                    confidence, reasoning_trace, llm_model, prompt_version, created_at)

policy_decisions   (id, event_id, proposed_action json, verdict,
                    matched_rules json, config_version, evaluated_at)

actions            (id, event_id, type, executor, idempotency_key UNIQUE,
                    rzp_request_id, scheduled_for, executed_at, status)

audit_log          (seq AUTOINC PK, ts, event_id, actor PIPELINE|POLICY|EXECUTOR,
                    entry_type TRIGGER|DIAGNOSIS|DECISION|ACTION|OUTCOME|REFUSAL,
                    payload json)                      -- append-only, no UPDATE grants in code

promises_to_pay    (id, customer_id, committed_amount_inr, committed_at,
                    followup_at, resolved_at)

metrics_runs       (id, batch_seed, arm, n_events, recovered_inr, recovery_rate,
                    contacts, wasted_attempts, refusals, params_json, ran_at)

idempotency_keys   (key PK, scope, result_ref, created_at)
```

**Notes:** money stored as integer paise (float rounding in ledgers is a classic self-inflicted
wound); all timestamps UTC with IST conversion applied only at quiet-hours boundaries; foreign
keys cascade-checked in tests.

---

## 9. Directory Structure

```
salvage/
├── README.md                     # GIF, 5-min quickstart, headline A/B/C table
├── ARCHITECTURE.md               # diagrams + every major tradeoff (source: this plan §5–6)
├── docs/
│   ├── policy-model.md           # guardrail philosophy, rule catalogue, change protocol
│   ├── metrics-methodology.md    # arms, probability model, ALL assumptions cited
│   └── what-broke.md             # daily 2 AM log — started Day 1, never skipped
├── app/                          # Next.js: dashboard views + /api/webhooks/razorpay
├── packages/
│   ├── core/                     # diagnosis · policy · actions · audit (pure, tested)
│   ├── simulator/                # arms runner + report generator
│   └── seed/                     # fixture generator (seeded RNG)
├── tests/                        # unit (policy/diagnosis/idempotency) + one e2e replay
├── .env.example                  # RZP_KEY_ID/SECRET (test), ANTHROPIC_API_KEY
└── pnpm-workspace.yaml
```

**Why a monorepo split:** `core` stays import-safe from both the app and the simulator — the
same code path powers the live demo and the measured experiment, which is precisely what makes
the measurements meaningful ("you saw this exact pipeline run; here is what it does across 400
events"). A single-app blob would quietly fork those paths.

---

## 10. Day-by-Day Execution Schedule

~3–4 hrs/day. Each day names its **gate** — the checkable condition that marks it done.

### Day 0 (today, ~45 min) — Accounts & runway
Create Razorpay account → generate **test-mode** keys; create Anthropic console key; locate the
Buildathon Google Form and record the exact deadline; confirm Bangalore relocation feasibility.
*Why first:* blocked credentials stall everything downstream; the deadline determines whether
the schedule compresses.

### Days 1–2 — Skeleton + data spine
Repo scaffold, workspace config, DB migrations, seed generator producing the 400-event
fixture set, ingestion with signature verification + idempotency + replay mode.
*Why data before logic:* every later component consumes this shape; reshaping fixtures on Day 6
would cascade through everything. Gates: `pnpm seed` reproducible byte-for-byte; replay feeds
events into a stub pipeline; duplicate webhook delivery creates exactly one row.

### Days 3–4 — Brainstem: diagnosis + policy
Diagnosis engine (schema-constrained Claude call, fact-sheet precomputation, caching, rule
fallback) and the policy engine (YAML load, all default rules, verdict objects).
*Why these two back-to-back:* diagnosis output is policy input; co-developing surfaces interface
mismatches while they're cheap. Gates: golden-case tests pass for all 5 failure classes;
unit tests prove attempt-cap, interval, quiet-hours, opt-out, and risky-routing refusals fire.

### Days 5–6 — Hands: executors + ledger + first light
Idempotent executors wired to test-mode APIs; audit ledger writing the full chain; minimal
timeline view rendering it.
*Why ledger before dashboard polish:* the ledger IS a deliverable; the dashboard merely renders
it. Gate: end-to-end replay produces complete trigger→outcome chains for a sample batch; a
killed-and-restarted run produces zero duplicate actions (idempotency proof).

### Days 7–8 — Proof: simulator + metrics
Arms runner, probability model with cited parameters, metrics page, headline table.
*Why mid-schedule, not last:* if numbers look wrong (e.g., C barely beats A), there's still
time to fix the model or the pipeline — discovering a weak headline on Day 10 is fatal. Gate:
A/B/C table renders; C > A and C ≥ B on recovery; C strictly best on wasted attempts; ranges
(not fake point estimates) displayed.

### Day 9 — Armor: guardrails demo + edge hardening
The on-camera refusal scenario staged; edge cases swept (duplicate events, LLM-down fallback,
API error normalization, restart mid-batch). **Voice slice only if fully ahead** — it dies here
without ceremony if not. Gate: scripted chaos drill passes: kill server mid-run, restart, ledger
shows no corruption and no double-actions.

### Days 10–11 — Story: docs + video
README/ARCHITECTURE/policy-model/metrics-methodology finalized; `what-broke.md` curated into
its best 3–4 entries; 5-min video scripted, recorded, re-recorded once for quality.
*Why buffer days exist:* recording reliably eats 2× the estimate, and the video is the first
thing reviewers see. Gate: fresh-machine clone → quickstart → demo runs in <5 minutes
(tested on a friend's laptop, not just ours).

---

## 11. Evaluation Framework & Honesty Policy

**Claims we will make (and can defend):**
1. Pipeline completeness: detect→prove loop runs end-to-end on Razorpay test mode. *(Verified
   by anyone in 5 minutes.)*
2. Guardrail integrity: every money-adjacent action passes a deterministic, versioned policy
   gate; refusals are logged and demonstrable. *(Unit-tested + on-camera.)*
3. Relative efficiency: under a transparent, cited probability model, targeted recovery
   dominates both no-action and naive-retry baselines on recovery rate AND contact waste.
*(Methodology doc; framed as modeled, not measured.)*

**Claims we will NOT make:** absolute recovery-rate claims, field-measured lift, ML-model
performance, production readiness of message delivery. Overclaiming is the single fastest way
to lose a technically literate panel.

Every assumption lives in `docs/metrics-methodology.md` with its source and sensitivity range.

---

## 12. Demo & Video Plan (5:00)

| Time | Beat | Purpose |
|---|---|---|
| 0:00–0:40 | The leak: failed-payment stat, silent revenue loss, blind-retry harm | Stakes |
| 0:40–1:00 | One-slide architecture; "LLM proposes, policy disposes" up front | Frame |
| 1:00–2:15 | Live: seed batch → run → inbox triaging, links firing, ledger filling | Working product |
| 2:15–3:15 | A/B/C results table; contacts-per-recovery; wasted-attempt gap | Measured value |
| 3:15–4:00 | Guardrail theater: break quiet hours on purpose → REFUSED + logged; customer timeline close-up | Trust |
| 4:00–4:35 | Design decisions: deterministic authority, version-stamped audit, honest metric framing | Judgment |
| 4:35–5:00 | "What broke at 2 AM" (best real story) + what comes next with real rails | Fit |

Recording rules: rehearse twice, record in one take per segment, screen zoom on ledgers,
no music, captions on.

---

## 13. Documentation Strategy

- `docs/what-broke.md` — **started Day 1, updated daily**: symptom → root cause → fix → time
  lost → lesson. Their recruiting copy literally asks for this; most applicants will fabricate
  theirs at the end. Ours accumulates truth.
- `ARCHITECTURE.md` — distilled from this plan (§4–§8): diagrams, tradeoffs, rejected options.
- `docs/policy-model.md` — rule catalogue with the *reason* each rule exists and how merchants
  would tune it.
- `README.md` — judge-first: GIF, two-command quickstart, headline table, links to deeper docs.

---

## 14. Risk Register & Cut Order

| Risk | L×I | Mitigation |
|---|---|---|
| Test webhooks flaky/timing-dependent during recording | H×M | Replay mode is the default demo path by design |
| Panel attacks metric credibility | M×H | Assumption-labeled model + sensitivity ranges + "swap your rates" framing |
| Scope creep (voice, MCP, polish spirals) | H×H | Hard cut-order below; voice gated behind Day 9 |
| Claude API outage mid-demo | L×M | Rule-table fallback + cached responses; graceful degradation demo ready |
| Duplicate side-effects on crash/retry | M×H | Idempotency keys everywhere, chaos-tested Day 9 |
| Timezone bug silences/awakens contacts wrongly | M×M | UTC storage, IST-only boundary math, unit-tested quiet-hours edges |
| API cost overrun | L×L | Temp-0, prompt caching, fact-sheet compaction, daily spend cap |
| Personal schedule collapse near deadline | M×H | Buffer Days 10–11; cut-order protects core claims first |

**Cut order when behind (sacrifice in this sequence):** voice → arm-B refinement depth →
dashboard polish → policy editor UI (YAML file editing suffices) → …never: audit ledger,
A/B/C table, guardrail-refusal demo.

---

## 15. Security, Privacy & Compliance Notes

- **Test-mode keys only**; `.env` gitignored, `.env.example` documents shape; repo scanned
  before going public (keys in git history = instant disqualification-grade embarrassment).
- **No card/PAN data anywhere** — Razorpay tokenization handles instruments; we store tokens'
  *references* only.
- **All PII synthetic and watermarked** (`*_fake@example.test`) — no ambiguity about provenance.
- **No real outbound communication** — every send path is stubbed and labeled SIMULATED in both
  code and ledger.
- **Webhook signature verification** mandatory; unsigned requests rejected and logged.
- **Compliance acknowledged, not faked:** `policy-model.md` includes a paragraph mapping our
  rules to DND/TRAI consent norms and RBI digital-lending guidance on recovery conduct — we
  simulate sends, so we say exactly that, while demonstrating the consent/opt-out/stopping-rule
  machinery that real deployments would need.

---

## 16. Panel Preparation

Prepared answers, kept sharp:

- **"Why not just use Razorpay's existing recovery agents?"** → Studied and mirrored their
  published patterns deliberately; this project demonstrates readiness to contribute to that
  exact stack (bounded tools, Claude, audit-first), plus adds an evaluation harness pattern
  (arms + honest assumptions) that generalizes.
- **"Your numbers aren't real."** → Correct, and labeled as such everywhere. The framework
  accepts real rates as parameters; the contribution is the closed loop + measurement discipline.
- **"What if the LLM misdiagnoses?"** → Confidence floor routes to human review; even a wrong
  diagnosis cannot exceed policy bounds (caps, quiet hours, attempt limits). Damage from bad
  intelligence is structurally contained.
- **"How does this reach production?"** → Named gaps: real channels + DLT registration,
  multi-tenant isolation, queue-backed scheduling, consent ledger, observability/metrics export.
  Knowing the gap list is the point.
- **"Why SQLite?"** → Judge-runnable in 5 minutes beats production cosplay; migration path to
  Postgres is documented and boring by design.

---

## 17. Day 0 Setup Checklist

- [ ] Razorpay dashboard account → Settings → API Keys → generate **Test** keys → store in password manager
- [ ] Test a `create_payment_link_upi` call via curl to validate keys
- [ ] Anthropic Console account → API key → $5 credit confirmed
- [ ] Locate Buildathon Google Form; record exact deadline + team-size rules
- [ ] Confirm Bangalore relocation viability for Sept start
- [ ] GitHub repo created (**public from commit #1** — a public-build story is itself signal)
- [ ] Node 20+, pnpm installed

---

## 18. Definition of Done

**Project-level done means ALL of:**

1. Fresh clone → `pnpm install && pnpm seed && pnpm dev` → working demo < 5 min on a clean machine.
2. Full trigger→audit chain visible for ≥ 95% of replayed events; exceptions surfaced, never swallowed.
3. A/B/C metrics table rendered with ranges; methodology doc explains every parameter.
4. On-camera guardrail refusal captured in the final video.
5. Chaos drill passed (kill/restart mid-batch → no dupes, no corruption).
6. All four docs complete; `what-broke.md` contains ≥ 5 genuine entries.
7. 5-minute video recorded, captioned, linked from README.
8. Repo public, secrets scanned, `.env.example` accurate.

---

*Maintainer's note: this document is the source of truth for scope. Any addition must name the
cut it replaces. That rule is what turns eleven part-time days into a finished, defensible build.*
