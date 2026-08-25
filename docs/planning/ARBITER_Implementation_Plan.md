# ARBITER — Foolproof Implementation Plan

> **Razorpay AI Buildathon · Track 03 (AI Revenue Recovery) · Confirmed-bar-aligned**
> Positioning: *"Everyone automates the retry. Nobody ships the accountability."*
> Solo builder · Part-time (~3–4 hrs/day, ~11 days) · TypeScript end-to-end

---

## Table of Contents

0. [What We Are Building](#0-what-we-are-building)
1. [Non-Negotiable Invariants](#1-non-negotiable-invariants)
2. [Architecture Reference](#2-architecture-reference)
3. [Determinism Contract](#3-determinism-contract)
4. [Tech Stack & Locked Decisions](#4-tech-stack--locked-decisions)
5. [Phase P0 — Credentials & Environment](#phase-p0--credentials--environment-day-0)
6. [Phase P1 — Scaffold, Schema v2, Two-Corpus Seed](#phase-p1--scaffold-schema-v2-two-corpus-seed-days-12)
7. [Phase P2 — Feature Pipeline + ML Core](#phase-p2--feature-pipeline--ml-core-day-3)
8. [Phase P3 — Decision Engine (EV Optimizer)](#phase-p3--decision-engine-ev-optimizer-day-4)
9. [Phase P4 — Approval Workflow (HITL)](#phase-p4--approval-workflow-hitl-day-5)
10. [Phase P5 — Executors & the Determinism Barrier](#phase-p5--executors--the-determinism-barrier-day-6)
11. [Phase P6 — Dashboard: Approval Queue](#phase-p6--dashboard-approval-queue-day-7)
12. [Phase P7 — Measurement Harness](#phase-p7--measurement-harness-day-8)
13. [Phase P8 — Learn Loop: Retrain + Drift Controller](#phase-p8--learn-loop-retrain--drift-controller-tier-2-days-910)
14. [Phase P9 — Chaos & Resilience Drill](#phase-p9--chaos--resilience-drill-day-9)
15. [Phase P10 — Docs, Video, Submission](#phase-p10--docs-video-submission-days-1011)
16. [Master Bug Taxonomy](#16-master-bug-taxonomy)
17. [Testing Strategy](#17-testing-strategy)
18. [Risk Register, Cut Order, Never-Cut List](#18-risk-register-cut-order-never-cut-list)
19. [Security & Compliance Notes](#19-security--compliance-notes)
20. [Panel Defense Script](#20-panel-defense-script)
21. [Project Definition of Done](#21-project-definition-of-done)

---

## 0. What We Are Building

**ARBITER** is an approval-gated Revenue Recovery Decision Engine for merchants suffering
silent revenue leakage from failed subscription/recurring payments.

Six-stage closed loop:

```
PREDICT ──► DECIDE ──► PROPOSE ──► APPROVE ─╢ DETERMINISM BARRIER ╟──► EXECUTE ──► LEARN
```

| Stage | What it does | Technology |
|---|---|---|
| PREDICT | P(recovery), best retry window, per-customer features | Pure-TS logistic regression + Claude narrative layer |
| DECIDE | Picks argmax expected-value intervention within compliance constraints | Deterministic optimizer |
| PROPOSE | Human-readable explanation packet per action | GenAI narrative (temp 0) over model output |
| APPROVE | Human signature per rupee; batch approve; autonomy dial | State machine + queue UI |
| EXECUTE | Idempotent, once-only, verify-before-act | Razorpay test APIs |
| LEARN | Nightly retrain → new immutable model versions; drift contracts autonomy | Scheduled job |

**Why it wins:** the recovery loop itself is commodity (Stripe Smart Retries exists). The
governance layer — plain-English-bounded authority, human signatures, provenance-stamped
ledger, self-contracting autonomy — is what Razorpay's Agent Studio marketplace, NPCI's UAP,
and MeitY's proposed human-check rules are all converging toward. We demo the frontier
through a familiar skin.

**Grading-bar traceability (confirmed verbatim on live buildathon page):**

| Bar phrase | Satisfying artifact |
|---|---|
| "measured money recovered across a batch" | P7 arms + uplift tables |
| "compliant escalation" | P3 constraint set + P8 autonomy controller |
| "stopping rules" | P3 policy constraints + refusal records |
| "an audit trail" | P5/P10 provenance-stamped append-only ledger |

---

## 1. Non-Negotiable Invariants

Violating any of these is a Critical bug regardless of phase:

1. **I-1 No unapproved money action.** Every executor call is preceded by an in-code assert
   that the proposal state is `APPROVED` (or matches the versioned auto-approve envelope).
2. **I-2 Once-only execution.** One proposal ⇒ at most one side-effecting API call, ever,
   including across crashes and restarts.
3. **I-3 Byte-determinism.** Same inputs + same model/policy versions ⇒ identical proposal.
   No sampling anywhere in the money path.
4. **I-4 Append-only ledger.** Corrections are new rows referencing old ones. Never UPDATE/DELETE.
5. **I-5 Integer paise only.** No floats touch amounts, probabilities are floats but amounts never are.
6. **I-6 UTC everywhere.** IST conversions happen in exactly one utility function.
7. **I-7 Fail closed.** Any validation error, missing config, unknown failure class ⇒ route to
   human review. Never guess with money.
8. **I-8 Synthetic data watermark.** All PII is fake (`*@example.test`) and labeled SIMULATED sends.

---

## 2. Architecture Reference

```
┌────────────────────────────────────────────────────────────────────────────┐
│                            ARBITER PLATFORM                                │
│                                                                            │
│  INGESTION          PREDICT          DECIDE         PROPOSE               │
│  • signed webhooks  • feature pipe   • EV argmax    • explanation packet  │
│  • idempotency      • logreg vN      • constraint   • case brief (Claude, │
│  • replay mode      • confidence       filter         temp 0, cached)     │
│    (primary demo)     + fallback     • ranking            │                 │
│        │                │                │              ▼                 │
│        ▼                ▼                ▼        ┌─────────────┐         │
│   payment_events   scores+attribs  ranked props │APPROVAL QUEUE│        │
│                                                 │ approve/edit/│        │
│        ┌────────────────────────────────────────┘reject/batch │        │
│        ▼                                                       ▼         │
│  ╔══════════════ DETERMINISM BARRIER (state=APPROVED) ══════════════╗    │
│  ║  EXECUTE: verify-before-act · once-only keys · Razorpay test APIs ║    │
│  ╚═══════════════════════════════┬═══════════════════════════════════╝    │
│                                  ▼                                        │
│                     AUDIT LEDGER (append-only, provenance-stamped)        │
│                                  │                                        │
│        LEARN ◄───────────────────┘                                        │
│   nightly retrain → model_versions(N+1)                                   │
│   drift check: predicted vs realized → autonomy envelope CONTRACTS        │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Determinism Contract

Printed verbatim in README; enforced in code:

1. Same event content + same `model_version` + same `policy_version` ⇒ byte-identical proposal.
   Inference = fixed weights × integer-derived features. No sampling, no clocks inside computation.
2. Model artifacts are **immutable**: `model_versions(id, weights_json, sha256, trained_at, dataset_sha)`.
   Retraining publishes `vN+1`; in-flight and historical decisions keep referencing `vN`.
3. GenAI never computes monetary figures. It narrates pre-computed numbers and is called at
   temperature 0 with prompt-version pinning; its output is stored but never feeds execution logic.
4. Execution requires proposal state `APPROVED`, or inclusion in the current versioned
   auto-approve envelope. Both paths stamp full provenance.
5. Every state transition is ledgered with actor, timestamps (UTC), and version stamps.

---

## 4. Tech Stack & Locked Decisions

| Concern | Choice | Rejected alternative & why |
|---|---|---|
| Language/framework | TypeScript monorepo, Next.js App Router | Python sidecar: second runtime + serialization seam for zero benefit at this model size |
| ML core | Hand-rolled logistic regression (~150 lines: batch gradient descent, L2, fixed zero-init) | scikit/TF.js: deps + nondeterminism risk; our model must be auditable line-by-line |
| DB | SQLite (WAL mode) + Drizzle ORM | Postgres/Redis: infra tax; concurrency irrelevant solo |
| Payments | Official `razorpay` npm SDK, test keys only | MCP-on-money-path: extra indirection on highest-risk path (MCP stays optional read-only surface) |
| GenAI | Claude API, structured outputs, temperature 0, prompt cache | — |
| Scheduler | node-cron in-process, single-instance lock file | BullMQ/Redis: infra tax |
| Validation | Zod schemas shared across pipeline stages | Hand-rolled parsers: silent coercion bugs |

---

# Phase P0 — Credentials & Environment (Day 0)

## Do this
1. Razorpay Dashboard → Settings → API Keys → generate **Test Mode** keys. Store in password manager.
2. Smoke-test: `curl -u key:secret https://api.razorpay.com/v1/payment_links/upi -d '{"amount":100,"currency":"INR"}' …` expect 200.
3. Anthropic console → API key → confirm ≥$5 credit.
4. Open the Buildathon Google Form → **record exact deadline + team-size rules in this doc** (third-party listings say ~Sept 5 — trust only the form).
5. Create public GitHub repo now (public-from-commit-#1 is itself signal). Add `.gitignore` (`.env*`, `node_modules`, `*.sqlite*`) **before first commit**.

## Bugs that occur here

| # | Symptom | Root cause | Fix | Prevention |
|---|---|---|---|---|
| P0-B1 | 401 from Razorpay despite "correct" keys | Live keys used against test namespace or vice versa; keys rotated while `.env` cached | Regenerate test keys, re-export shell, restart dev server | Name env vars `RZP_TEST_KEY_ID` explicitly |
| P0-B2 | UPI link creation returns HTML/error page | Hitting wrong base URL for endpoint variant | Use SDK method `paymentLink.create({upi_link:true})` rather than hand-rolled curl path | Prefer SDK smoke-test over curl |
| P0-B3 | Claude 401/`insufficient_credits` | Key created without credit, or org-level block | Add credit; verify with a 1-token call | Budget alert set in console |
| P0-B4 | Secrets committed in first push | `.gitignore` added after commit | Rotate BOTH keys immediately; rewrite history (`git rm --cached`, amend) or delete repo if 0 stars | Commit `.gitignore` as literally the first file |
| P0-B5 | Deadline discovered to be earlier than assumed mid-build | Third-party listing trusted | Check form Day 0; compress Tier list accordingly | Record deadline in Amendment Log |

**Gate:** test-mode UPI link created via SDK · Claude call returns · deadline recorded · repo public with clean history.

---

# Phase P1 — Scaffold, Schema v2, Two-Corpus Seed (Days 1–2)

## Do this

**Scaffold:** pnpm workspace: `app/` (Next.js), `packages/core` (domain), `packages/ml`,
`packages/simulator`, `packages/seed`, `tests/`. Enable SQLite WAL. Install zod.

**Schema v2 (core tables):**

```sql
tenants(id, name, autonomy_envelope_json, policy_version)
customers(id, tenant_id, pseudo_name, phone_fake, email_fake, payday_pattern_json,
          channel_responsiveness, opted_out, joined_at)
payment_events(id, tenant_id, customer_id, rzp_payment_id, subscription_id,
               amount_paise, failure_code, source WEBHOOK|SEED|TRAINING,
               true_outcome_seed REAL, occurred_at_utc)
features(id, event_id, vector_json, feature_version)          -- computed, frozen
model_versions(id, semver, weights_json, sha256, dataset_sha256, metrics_json, trained_at)
proposals(id, event_id, model_version_id, policy_version, action json,
          ev_paise, confidence, attributions_json, narrative,
          state PROPOSED|AWAITING_APPROVAL|AUTO_APPROVED|APPROVED|EDITED|REJECTED|
                EXECUTING|EXECUTED|FAILED|CANCELLED,
          state_version INT, created_at)
approval_records(id, proposal_id, actor, decision, note, decided_at)
actions(id, proposal_id, idempotency_key UNIQUE, rzp_request_ref, executed_at, outcome)
audit_log(seq PK AUTOINC, ts_utc, tenant_id, event_id, actor, entry_type, payload_json)
drift_checks(id, window_start, window_end, predicted_rate REAL, realized_rate REAL,
             verdict OK|CONTRACTED, envelope_before_json, envelope_after_json)
metrics_runs(id, arm CONTROL|PIPELINE, mc_iter, recovered_paise, contacts, wasted, ran_at)
idempotency_keys(key PK, scope, result_ref, created_at)
```

**Two-corpus seed (`packages/seed`):**
- *Training corpus:* ~5,000 events / ~1,200 customers, `source=TRAINING`, carries
  `true_outcome_seed` (the generator's known ground-truth probability) for supervised labels.
- *Demo corpus:* ~60 customers × ~4 events ≈ 220–240 events, `source=SEED`, no truth leaked.
- Failure taxonomy: `SOFT_RETRYABLE 45% · HARD_METHOD_DEAD 25% · NETWORK_TIMEOUT 15% ·
  RISK_FLAGGED 10% · UNKNOWN 5%` (±5pp tolerance).
- Seeded RNG: implement a small xorshift/mulberry32 PRNG — **never `Math.random()`**.

## Bugs that occur here

| # | Symptom | Root cause | Fix | Prevention |
|---|---|---|---|---|
| P1-B1 | Seed differs between runs | `Math.random()`, object key order feeding hashes, or Date.now() inside generator | Own PRNG (mulberry32) seeded once; sort keys canonically before any hash; freeze clock via injected `now()` param | Generator takes `{rng, now}` — pure function |
| P1-B2 | Class-share assertion randomly fails | Exact equality asserted on sampled shares | Assert ±5pp bands per class (F5 amendment) | Chi-square mindset from day one |
| P1-B3 | Amounts show ₹499.30000000004 | Float math on money | Store integer paise; convert to ₹ only at render (`formatPaise()`) | ESLint ban on arithmetic ops outside `money.ts` |
| P1-B4 | Quiet hours trigger at wrong hour | Local timezone used; DST-less IST assumed = UTC+5:30 but machine is UTC/other | Single `toIstMinuteOfDay(ts)` util; unit tests at 21:59/22:00/07:59/08:00 IST | I-6 invariant |
| P1-B5 | Migration applies twice / drift errors | Schema edited without generating new migration; two migration dirs | `drizzle-kit generate` per change; CI check: fresh migrate == migrated db schema | Never hand-edit SQL files |
| P1-B6 | `SQLITE_BUSY: database is locked` | Concurrent writers (webhook handler + cron tick) | WAL mode + busy_timeout=5000 + serialize writes through one module | Single-writer discipline |
| P1-B7 | Webhook signature check fails though payload looks right | Next.js body parser consumed body; HMAC computed on re-serialized JSON ≠ raw bytes | Route handler: `await req.text()` FIRST, HMAC over that raw string, then `JSON.parse` separately | Keep a pinned passing fixture test |
| P1-B8 | Duplicate webhook creates duplicate event | No unique constraint on provider event id | Unique index on `rzp_event_id`; insert-or-ignore + ledger note on swallow | Idempotency table pattern reused everywhere |
| P1-B9 | Training corpus leaks into demo metrics | Shared customers between corpora | Generators draw disjoint ID ranges; test asserts zero overlap | Corpus isolation invariant |
| P1-B10 | Next.js hydration errors later traced to seed-time dates | Server/client render locale/timezone differences | Always render ISO strings from DB; format in one client util | — |

**Gate:** `pnpm seed` byte-identical twice (hash fixtures) · share assertion passes with bands ·
duplicate-webhook test → exactly 1 row · unsigned webhook rejected+logged · migrations clean on fresh DB.

---

# Phase P2 — Feature Pipeline + ML Core (Day 3)

## Do this

**Feature computation (`packages/core/features.ts`)** — pure function, versioned `feature_version`:
`failure_class_onehot(5) · decline_code_group(6) · amount_z_vs_customer_median ·
days_since_last_success · prior_success_count · prior_failure_count ·
inferred_payday_proximity · tenure_days · channel_responsiveness_prior`
→ stored frozen in `features` table. Missing-history ⇒ explicit sentinel values (documented),
never NaN.

**Payday inference:** histogram of successful-payment day-of-month from history;
peak window ±2 days ⇒ `payday_proximity ∈ [0..1]`. Fewer than 3 successes ⇒ `unknown` sentinel.

**Logistic regression (`packages/ml/logreg.ts`)**:
- Batch gradient descent + L2 (λ=0.01), lr decay, fixed 2,000 epochs, **zero-init weights**,
  plain sequential loops (no parallel reductions — bit-determinism).
- Train on TRAINING corpus, split **by customer** (70/30). Labels = whether seeded outcome was recovery.
- Report on holdout: **AUC**, **Brier score**, **calibration curve (10 bins)**, per-class recall.
- Export `model_versions` row: weights JSON + sha256 + dataset sha + metrics JSON.

**Narrative layer:** Claude temp-0 call turning score+attributions into the case-brief sentence.
Cached by (event hash, prompt_version). Fallback template when API down.

## Bugs that occur here

| # | Symptom | Root cause | Fix | Prevention |
|---|---|---|---|---|
| P2-B1 | AUC ≈ 0.95 then collapses on real-ish data | **Target leakage**: split by EVENT not CUSTOMER; same customer's sibling rows teach the answer | Split keys = customer IDs only; assert disjoint sets in test | Leakage checklist in methodology doc |
| P2-B2 | Suspiciously perfect model | Feature uses post-outcome info (e.g., "days_until_recovery") | Features may use only info available AT decision time; review each feature against timeline | Feature audit table in docs |
| P2-B3 | Training loss oscillates/diverges | lr too high; unscaled features | Standardize features (store μ/σ in model artifact!); lr schedule with decay; grad clip | μ/σ MUST ship inside weights JSON or inference silently breaks |
| P2-B4 | `sigmoid` returns Infinity/NaN | exponent overflow for large negative z | `sigmoid(z)=z>=0?1/(1+e^-z):e^z/(1+e^z)` stable form | Property test: finite outputs for z∈[-50,50] |
| P2-B5 | Two trainings of same data differ in last decimal | Floating-point reduction order (array methods w/ internal optimization), Math.exp variance | Sequential for-loops, fixed epoch count, zero-init; assert weight-sha equal across runs | Determinism smoke test in CI |
| P2-B6 | Great offline, garbage online | Calibration computed on train set | All reported metrics on holdout only | — |
| P2-B7 | New customer crashes inference | Missing history → undefined feature | Sentinels (-1 coded, documented) + `Number.isFinite` guard before dot product | Fail-closed I-7: sentinel path forces lower confidence |
| P2-B8 | Retrain silently changes old decisions' meaning | Mutated weights in place | Immutable `model_versions`; inference resolves version by id | I-3/I-4 |
| P2-B9 | Narrative says "guaranteed recovery" | Unconstrained generation | Prompt forbids promises; validator regex strips/flags absolute claims; validator output stored | Compliance copy pass |
| P2-B10 | Claude latency stalls pipeline (5s/event × 240) | Narrative generated inline synchronously | Narratives generated async/lazily for queue view; pipeline depends only on numeric score | Demo path never blocks on LLM |

**Gate:** holdout AUC ≥ 0.75 & calibration monotone-ish (report actuals honestly) ·
retrain-twice sha-equal test · leakage assertions green · narrative validator strips promise-claims.

---

# Phase P3 — Decision Engine (EV Optimizer) (Day 4)

## Do this

Intervention catalog with cost model:
`RETRY_NOW · RETRY_PAYDAY(+window) · ALTERNATE_UPI_LINK · REMINDER_LINK · HUMAN_REVIEW · NO_ACTION`

Per proposal:
```
EV(action) = P(recovery | features, action) × amount_paise − CONTACT_COST_PAISE
```
P per action comes from the model's calibrated score mapped through a documented
action-conditioned adjustment table (methodology doc cites each multiplier as assumption).

Constraint filter (policy YAML v2): attempt caps · interval · quiet hours · opt-out ·
exposure cap · risky/unknown ⇒ HUMAN_REVIEW only · confidence floor.
Output: ranked feasible actions; tie-break = catalog order (stable). If none feasible ⇒
mandatory `NO_ACTION` proposal with reason string — engine never throws on empty set.
Attributions: exact logreg contributions `(w_i × x_i)` sorted by |value|, top-5 kept.

## Bugs that occur here

| # | Symptom | Root cause | Fix | Prevention |
|---|---|---|---|---|
| P3-B1 | EVs astronomically wrong (₹49,900 for ₹499 payment) | Probability treated as percent OR rupee/paise mixed | One money util; property test: `EV ≤ amount_paise` always | Type-newtype `Paise` prevents mixing |
| P3-B2 | Different action chosen across runs for identical input | Tie broken by Map/object insertion order or sort instability | Stable comparator + explicit catalog-index tie-break | Golden-case test pins chosen action |
| P3-B3 | Constraint conflict silently allows bad action | Rules evaluated short-circuit, last-writer wins | Collect ALL violated rules; allow iff violation set empty; attach full set to refusal | Refusal records list every matched rule |
| P3-B4 | Crash on fully-constrained customer | `feasible[0]` on empty array | Mandatory NO_ACTION fallback proposal | Property test: total function, never throws |
| P3-B5 | NaN EV for new customers | Sentinel features fine, but adjustment-table lookup misses class×action cell | Total lookup with documented default multiplier | Table completeness test |
| P3-B6 | Optimizer picks HUMAN_REVIEW to dodge EV math (it has cost 0?) | Cost model incomplete | HUMAN_REVIEW carries explicit labor-cost constant; NO_ACTION carries churn-risk cost | Costs documented, non-zero, cited |
| P3-B7 | Policy YAML typo silently disables a rule | Loose parser ignores unknown keys | Zod strict schema; unknown key ⇒ boot error; config_version bump required | Fail-closed config loading |

**Gate:** golden cases: soft→RETRY_PAYDAY wins · dead-card→retry scored below alt-link ·
risky→only HUMAN_REVIEW feasible · empty-feasible → NO_ACTION proposal exists ·
tie-break deterministic across 100 runs.

---

# Phase P4 — Approval Workflow (HITL) (Day 5)

## Do this

State machine:
```
PROPOSED → AWAITING_APPROVAL → {APPROVED | EDITED | REJECTED}
AUTO_APPROVED (envelope hit) ─┘
APPROVED/AUTO_APPROVED → EXECUTING → EXECUTED | FAILED
any pre-execution state → CANCELLED (customer paid elsewhere / stale)
```
- `state_version` int column: optimistic locking (`UPDATE … WHERE state_version=?`) kills
  double-click double-transitions.
- **Auto-approve envelope** (versioned, per tenant): `{class:SOFT_RETRYABLE, attempt≤2,
  amount≤X_paise, channel∈{LINK}, quiet_hours_ok}` ⇒ straight to `AUTO_APPROVED`.
- Batch approve UI groups by (class × action), EV-descending.
- Pre-execute revalidation hook point defined now (used in P5): before crossing the barrier,
  re-fetch payment status; if paid elsewhere ⇒ auto-CANCELLED with ledger note.
- Approval records: actor label (honest demo value `merchant@demo`), decision, note, UTC ts.

## Bugs that occur here

| # | Symptom | Root cause | Fix | Prevention |
|---|---|---|---|---|
| P4-B1 | Double-click approves twice / fires two executions | No transition guard | Optimistic-lock UPDATE; second write affects 0 rows ⇒ treat as no-op | State-machine unit tests incl. races |
| P4-B2 | Illegal jump EXECUTED→APPROVED reachable via crafted request | Endpoint trusts client state | All transitions server-side via single `transition()` fn with allowed-map | No client-sent state accepted, ever |
| P4-B3 | Envelope typo auto-approves EVERYTHING (or nothing) | Loose envelope parse; default-open semantics | Strict schema + **fail-closed**: unparsable envelope ⇒ zero auto-approvals + alarm row | Config boot test asserts deny-by-default |
| P4-B4 | Batch approve half-applies | One transaction around whole batch; crash mid-way leaves mystery state | Per-proposal transactions; batch record tracks per-item result | Idempotent batch endpoint |
| P4-B5 | Approved proposal executes although customer already paid via other channel | Stale approval | Pre-execute revalidation: fetch payment; if succeeded elsewhere ⇒ CANCELLED + note | Hook mandated in P5 entry |
| P4-B6 | Edited amount bypasses envelope cap | Edit applied post-envelope check | Edits re-run FULL decide+envelope pipeline as new proposal version | Edits never mutate original row |
| P4-B7 | REJECTED proposals resurrect via replay | Replay re-proposes same event idempotently-keyed | Proposal dedupe key (event_id + model_version + policy_version); rejection cached | Replay respects human decisions |
| P4-B8 | Queue shows items in random order / pagination dupes | Non-deterministic ORDER BY ties | Order by (EV desc, id asc) always | — |

**Gate:** state-transition property tests (all illegal jumps rejected) · race test (parallel
approve ⇒ exactly one effect) · fail-closed envelope test · edit-recycles-through-decide test.

---

# Phase P5 — Executors & the Determinism Barrier (Day 6)

## Do this

Three executors, all thin, all idempotent:
1. `sequenced_retry` — tokenized `initiate_payment`; scheduled per decided window.
2. `alternate_upi_link` — `paymentLink.create({upi_link:true})`, personalized SIMULATED delivery.
3. `reminder_link` / `promise_to_pay` tracker (commitment pauses sequence; single follow-up).

**Barrier entry sequence (the most important function in the codebase):**
```
execute(proposal):
  assert state ∈ {APPROVED, AUTO_APPROVED}          // I-1, defense-in-depth
  idem_key = sha256(proposal_id|model_ver|policy_ver|attempt_no)
  insert idempotency_keys(key=idem_key) or return existing ref   // I-2 claim BEFORE network
  revalidate: fetch payment status → paid-elsewhere? ⇒ CANCELLED
  mark EXECUTING
  call Razorpay SDK (timeout, 2 retries w/ backoff, SAME idem key)
  reconcile outcome: fetch final status; write action row + ledger OUTCOME
  on irrecoverable error ⇒ FAILED + ledger (never fabricate success)
```
Ambiguous-status handling: if call times out ⇒ **fetch status, don't blind-retry**;
authorized-not-captured ⇒ capture; failed-after-debit ⇒ flag refund-review (out of scope,
logged honestly).

## Bugs that occur here

| # | Symptom | Root cause | Fix | Prevention |
|---|---|---|---|---|
| P5-B1 | Unapproved proposal executes via replay/cron path | Second code path skipped barrier | Barrier lives INSIDE `execute()`; integration test calls every entrypoint with PROPOSED fixture ⇒ all refuse | Defense-in-depth assert |
| P5-B2 | Double charge after crash-mid-API-call | Idem key generated AFTER network call, or in-memory only | Persist idem key claim BEFORE call; restart recovery scans unresolved EXECUTING rows and reconciles via status fetch | Recovery sweep job |
| P5-B3 | Retry storm on Razorpay 5xx | Naive retry loop | Max 2 retries, exp backoff + jitter(seeded!), then FAILED; circuit-breaker counter per executor (stretch) | Backoff constants in config |
| P5-B4 | Timeout ⇒ we mark FAILED though debit actually succeeded | Assumed timeout=failure | NEVER infer: fetch status on timeout; only terminal states recorded as such | "Never invent outcomes" rule |
| P5-B5 | Authorized-but-not-captured money lost | No capture branch | Capture-if-authorized branch in reconcile | Status matrix test (auth/captured/failed/refunded) |
| P5-B6 | Ledger has ACTION but no OUTCOME forever | Process died between two writes | Outcome reconciler sweeps EXECUTING older than X min | Sweep tested in chaos drill |
| P5-B7 | Quiet-hours check passes at 22:00:30 boundary off-by-one | Comparison `< start` vs `<=` | Centralized util + boundary unit tests | I-6 |
| P5-B8 | Same customer contacted twice via two proposals racing | Two events, two proposals, no per-customer mutex | Per-customer open-proposal uniqueness (partial index on active states) | DB-enforced, not app-enforced |

**Gate:** kill-server-mid-execute drill → restart → zero double charges, zero orphan EXECUTING
after sweep · barrier refuses PROPOSED at every entrypoint · timeout-with-success reconciles correctly.

---

# Phase P6 — Dashboard: Approval Queue (Day 7)

Views: **Queue** (grouped batches, EV-desc) · **Proposal detail** (narrative, attributions,
policy verdicts, exact payload preview) · **Customer timeline** (ledger rendered verbatim) ·
**Metrics** (P7 outputs) · **Runs** (batch triggers, seed reset).

## Bugs that occur here

| # | Symptom | Root cause | Fix | Prevention |
|---|---|---|---|---|
| P6-B1 | Timeline "missing" entries vs DB | Separate UI state built from multiple queries dropped REFUSAL rows | Timeline = single ledger query, rendered 1:1; add "ledger parity" test comparing counts | UI is a lens, not a store |
| P6-B2 | Approve button optimistic-marks before server ack | Client-side state update first | Await response; disable button in-flight; error toast on reject | — |
| P6-B3 | Stale queue after background cron moved items | Polling absent | 10s SWR-style poll on queue page only | — |
| P6-B4 | ₹ formatting inconsistent (some show paise) | Ad-hoc division | Only `formatPaise()` allowed | Lint rule |
| P6-B5 | Dev server serves stale worker code | tsx watch misses package change | Restart script composes all processes; document in quickstart | — |
| P6-B6 | Demo reset wipes approvals mid-video | Reset button too powerful | Reset requires typed confirmation; video uses fresh DB file instead | Two DB profiles: demo/present |

**Gate:** ledger-parity test green · queue reflects AUTO_APPROVED vs AWAITING correctly ·
fresh clone boots to populated queue via documented commands.

---

# Phase P7 — Measurement Harness (Day 8)

Arms on identical demo corpus: **CONTROL** (no intervention; organic-rate model) vs
**PIPELINE** (predict→decide→auto/envelope-approved execute, approvals auto-stamped by
simulated merchant for batch run). ≥100 MC iterations/arm; independent per-iteration seeds
derived from master seed. Outputs: recovered ₹ ranges, recovery rate, contacts-per-recovery,
wasted attempts, refusal counts, **calibration curve**, **uplift table by failure-class×action**
(min segment n=20 else fold into OTHER).

## Bugs that occur here

| # | Symptom | Root cause | Fix | Prevention |
|---|---|---|---|---|
| P7-B1 | Arms compared on different event mixes | Arms regenerate data separately | One frozen corpus replayed through both | Fixture-hash assert in runner |
| P7-B2 | MC iterations secretly correlated | Same sub-seed reused | `seed_i = hash(master,i)` verified distinct | Distinctness test |
| P7-B3 | PIPELINE wins because simulator favors it | Organic-rate model double-counts interventions | Control path literally cannot see proposals; code-review the seam | Architectural separation |
| P7-B4 | Point estimates quoted without ranges | Aggregation drops iteration dimension | Report P10/P50/P90 per metric | Report generator enforces |
| P7-B5 | Uplift cells with n<3 look significant | Small-sample noise | Min-segment folding rule | — |
| P7-B6 | Calibration looks perfect (too perfect) | Evaluated on training distribution | Calibration on holdout corpus slice only | Mirrors P2 gate |
| P7-B7 | Contact costs omitted → pipeline "wins" by spamming | Cost model unused in report | Contacts-per-recovery + fatigue-adjusted net ₹ reported beside gross | Honesty section mandates |

**Gate:** report renders ranges · PIPELINE > CONTROL on recovered ₹ AND wasted attempts ·
calibration chart present · every parameter traceable to methodology doc entry.

---

# Phase P8 — Learn Loop: Retrain + Drift Controller (Tier-2, Days 9–10)

Nightly job: append recent outcomes to training pool → train candidate model → publish as
NEW `model_versions` row (immutable) → **shadow-score next day** (proposals computed on
candidate, executed on incumbent) → promote if holdout metrics ≥ incumbent.

Drift check: rolling window of realized outcomes vs predicted rates.
Rules: eval only when window n≥30 · CONTRACT after 2 consecutive breaches (predicted−realized gap > τ) ·
EXPAND back only after 5 consecutive OK windows (asymmetric hysteresis) · contraction = tighten
envelope (lower amount cap, remove classes) + ledger `drift_checks` row + banner in UI.

## Bugs that occur here

| # | Symptom | Root cause | Fix | Prevention |
|---|---|---|---|---|
| P8-B1 | Historical decisions' explanations change overnight | Weights mutated in place | Immutability (already structural); narratives resolve their own model_version | I-3 |
| P8-B2 | Drift flaps hourly, envelope oscillates | Tiny windows, symmetric thresholds | n≥30 + asymmetric hysteresis (2-in/5-out) | Hysteresis unit tests |
| P8-B3 | Promotion of worse model on noise | Single-window comparison | Promotion requires ≥ incumbent on TWO consecutive evals | — |
| P8-B4 | Two nightly jobs overlap after manual run | No lock | Lockfile + skip-if-running | — |
| P8-B5 | Shadow candidates leak into executions | Env flag mishap | Candidate scoring writes to shadow table only; barrier reads incumbent pointer | Pointer indirection test |

**Gate (if built):** forced-drift drill (tamper realized rates) ⇒ envelope contracts, logged, UI banners;
restore ⇒ expands only after hysteresis satisfied.

---

# Phase P9 — Chaos & Resilience Drill (Day 9)

Scripted scenarios, each with expected ledger end-state:
1. Kill process during EXECUTE (post-claim, pre-response) → restart → sweep reconciles; ≤1 charge.
2. Kill during batch approval → per-item integrity; no half-batch ghosts.
3. Claude unreachable → numeric pipeline completes; narratives show fallback; zero crashes.
4. Razorpay 5xx burst → FAILED with honest statuses; no invented successes; breaker logs.
5. Duplicate webhook storm (same event ×5) → one event row, four swallow-notes.
6. Clock tamper across quiet-hour boundary → boundary util holds.

Record every surprise in `docs/what-broke.md` (symptom → cause → fix → lesson). These become
video material and panel gold.

**Gate:** all six scripted scenarios produce their documented end-states.

---

# Phase P10 — Docs, Video, Submission (Days 10–11)

Docs set: README (GIF, 2-command quickstart, headline table, **bar-traceability table**,
positioning paragraph, defense-script link) · ARCHITECTURE.md (this doc §2–§3 distilled +
tradeoffs) · docs/policy-model.md (rule catalogue + DND/TRAI/RBI-conduct acknowledgment;
sends simulated—say exactly that) · docs/metrics-methodology.md (every constant cited) ·
docs/what-broke.md (≥5 real entries) · OPENAPI.yaml (service posture).

Video beat-sheet (≤5:00, captioned):
`0:00 leak problem → 0:40 architecture + "humans sign every rupee" → 1:10 live: seed→queue→batch approve→execute → 2:40 recovered-₹ ranges + calibration + uplift → 3:30 guardrail theater: force out-of-policy → REFUSED logged; outage moment → breaker → 4:20 drift contracts autonomy → 4:40 what broke + roadmap`.

Every on-screen number must be regenerable by a listed command.

**Gate:** stranger-laptop clone→demo <5 min · video uploaded+linked · secrets scanned
(`git log -p | grep -i key` style sweep + gitleaks) · form submitted before recorded deadline.

---

# 16. Master Bug Taxonomy

Cross-cutting classes with standing defenses:

| Class | Example members | Standing defense |
|---|---|---|
| **Money corruption** | P1-B3, P3-B1, P5-B2 | `Paise` type, integer-only, idem-keys-before-network, barrier asserts |
| **Time travel** | P1-B4, P5-B7 | UTC storage, single IST util, boundary tests |
| **Silent duplication** | P1-B8, P5-B2, P4-B1 | Unique constraints + optimistic locks + claim-before-side-effect |
| **Leakage/peeking** | P2-B1/B2/B6, P7-B6 | Customer-split, decision-time features, holdout-only metrics |
| **Nondeterminism** | P1-B1, P2-B5, P3-B2, P7-B2 | Injected rng/now, sequential loops, stable comparators, sha tests |
| **Fail-open configs** | P3-B7, P4-B3 | Strict Zod, deny-by-default, boot-time validation |
| **LLM in the money path** | P2-B9, P2-B10 | Numeric-only pipeline dependency; narrative decorative; validator on prose |
| **Honesty erosion** | P5-B4, P7-B4/B7 | Never invent outcomes; ranges mandatory; costs reported |

---

# 17. Testing Strategy

- **Unit:** policy transitions, EV math properties (`EV≤amount`, totality), money utils,
  boundary clock tests, logreg finiteness + determinism (sha), feature sentinels.
- **Golden cases:** five taxonomy classes each pin (chosen action, refusal rules, narrative shape).
- **Integration:** webhook→…→ledger chain on replay corpus; barrier refusal at every entrypoint;
  idempotency under restart.
- **Property-based (fast-check):** state machine legality, EV bounds, formatter round-trips.
- **Chaos:** P9 suite as executable scripts.
- **CI-lite:** `pnpm verify` = lint + typecheck + unit + golden + seed-hash; run before every commit.

---

# 18. Risk Register, Cut Order, Never-Cut List

| Risk | L×I | Mitigation |
|---|---|---|
| Scope implosion under 36–44h budget | H×H | Tiers below; gates per phase; cut order pre-agreed |
| Metric credibility attack | M×H | Cited assumptions, ranges, control-arm honesty framing |
| Test-webhook flakiness in recording | H×M | Replay mode is canonical demo path |
| Razorpay test-mode behavior gaps | M×M | Status-matrix tests; SDK-first; document quirks in what-broke |
| Solo-builder illness/life | M×H | Buffer Day 9→10; never-cut list protects submission floor |

**Cut order (when behind):** NL-policy compiler → voice → drift EXPAND branch (keep CONTRACT) →
shadow-promotion (keep manual publish) → dashboard polish → calibration chart (keep AUC+Brier text).
**NEVER CUT:** provenance ledger · measured recovery vs control · approval-gate moment ·
determinism section · what-broke.md.

---

# 19. Security & Compliance Notes

Test-mode keys only; rotate-on-leak playbook written before needed. `.env` ignored pre-commit;
gitleaks sweep pre-submission. No PAN/card data ever (SDK tokenization only). Synthetic PII
watermarked. Outbound sends SIMULATED and labeled in ledger. Compliance paragraph in
policy-model maps design (consent flags, caps, stopping rules, quiet hours) to DND/TRAI norms
and RBI conduct guidance — explicitly framed as mirroring, not claiming certification.

---

# 20. Panel Defense Script

> **"Isn't smart-retry commoditized?"** Yes — Stripe ships it. We didn't rebuild dunning; we
> built the missing governance layer for merchant-side money agents: plain-English bounds,
> human signatures per rupee, per-action provenance (model+policy versions), measured uplift
> vs control, and autonomy that contracts itself on drift. Netflix automated the retry; nobody
> ships the accountability.
>
> **"What if the model is wrong?"** Wrong predictions can't move money alone — they propose;
> a human or a versioned envelope approves. And drift detection measurably tightens that
> envelope — wrongness has a designed consequence.
>
> **"Why hand-rolled regression?"** 150 auditable lines vs a black box: coefficients are the
> explanation layer; determinism is provable; zero deps.
>
> **"Production gaps?"** Named: real channels + DLT registration, multi-tenant hardening,
> queue-backed scheduling, consent ledger, observability export. Knowing the gap list is the point.

---

# 21. Project Definition of Done

1. Stranger-laptop: clone → `pnpm install && pnpm seed && pnpm dev` → working queue demo <5 min.
2. Full provenance chain (event→features→model_version→proposal→approval→execution receipt) for ≥95% of replayed events; exceptions surfaced, never swallowed.
3. Measurement page: recovered-₹ ranges (P10/P50/P90), calibration, uplift-by-segment; parameters sourced.
4. Chaos suite green; on-camera approval-gate + refusal moment captured.
5. Docs complete incl. determinism contract, defense script, what-broke ≥5 genuine entries.
6. Repo public, secrets swept, `.env.example` accurate, deadline met per form-recorded date.

---

*Maintainer rule unchanged: any addition must name the cut it replaces.*
