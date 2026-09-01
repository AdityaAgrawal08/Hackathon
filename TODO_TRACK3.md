# ARBITER — COMPLETE IMPLEMENTATION TODO LIST
# Razorpay AI Buildathon Track 3: AI Revenue Recovery

---

# WINNING GAP

**Why the current project is not yet a winning Track 3 submission:**

The batch benchmark (`app/recovery.ts:892-925`) computes "measured recovery" using hardcoded rates: `Math.round(amount * 0.22)` for control SOFT_RETRYABLE, `Math.round(amount * 0.85)` for ARBITER HARD_METHOD_DEAD. This is arithmetic on made-up numbers, not measurement. A Razorpay engineer-judge who asks "how do you know ARBITER recovers 85%?" gets: "Because we wrote `Math.min(0.85, ...)`."

**What judges would criticize:**
1. "Show me measured money recovered across a batch" — the batch uses estimated rates, not actual execution
2. "Why is AI necessary?" — no ablation study showing ML adds value over 7 rules
3. "What broke?" — no published negative results (Recoup published 14 failures; Reflex admitted LLM zero-delta)
4. "Show me a real Razorpay API call" — LIVE mode throws `"LIVE mode not implemented"`
5. "How does this generalize?" — train and evaluate on same data, no held-out evaluation

**What is technically impressive but strategically irrelevant:**
- 23-D feature vector (judges care about outcomes, not feature count)
- Federated learning (generates random weights — proves nothing)
- Cross-PSP recovery stub (concept without implementation)
- 517 tests (strong, but Reflex/Recoup have honest measurement)

**What would make the project difficult to dismiss:**
- Replace hardcoded recovery rates with actual execution against MockRazorpayProvider
- Add ablation study: rules-only vs ML on same batch
- Add held-out evaluation with CIs
- Publish negative results
- Show real Razorpay test-mode API call in demo

---

# SECTION A: EXISTING BUGS / BROKEN IMPLEMENTATION

---

## A-001: Batch Benchmark Uses Hardcoded Recovery Rates

- **Priority:** P0
- **Severity:** CRITICAL
- **Category:** Revenue-Recovery Measurement
- **Problem:** `app/recovery.ts:892-925` computes recovery using hardcoded rates: control gets `amount * 0.22` (SOFT), `amount * 0.32` (NETWORK), `amount * 0.15` (other). ARBITER gets `amount * expectedRecoveryRate` where `expectedRecoveryRate = Math.min(0.85, Math.max(0.60, prob * multiplier))`. These are estimated, not measured.
- **Why it matters:** Track 3 bar says "Show measured money recovered across a batch." Hardcoded rates are not measurement. Any technically sophisticated judge will spot this immediately.
- **Root cause:** The batch benchmark was designed as a demonstration, not an evaluation. It was never wired to actual execution.
- **File(s) affected:** `app/recovery.ts:892-925`
- **Exact change required:** Wire `recoverBatch()` to use `MockRazorpayProvider` from `packages/trial/src/provider.ts`. The mock provider has 20 deterministic outcome scripts keyed by scenario. Map failure classes to scenario IDs. Execute each proposal through the real executor path. Measure actual SUCCEEDED/FAILED/AMBIGUOUS outcomes.
- **Dependencies:** None
- **Validation:** Run `pnpm recover` — output should show actual provider outcomes, not estimated rates
- **Acceptance criteria:** Every event in the batch report has a real outcome from the mock provider, not a computed estimate
- **Track 3 relevance:** This IS the Track 3 bar. Without this, the project fails the primary requirement.

---

## A-002: Control Arm Uses Same Model for Control and Treatment

- **Priority:** P0
- **Severity:** CRITICAL
- **Category:** Measurement Integrity
- **Problem:** `packages/ml/src/recovery.ts:30` computes `controlOutcome` using `hashSeed(eventId + "|control") % 10_000 < Math.round(probability * 10_000)` where `probability` comes from the same ML model used for treatment. If the model is overconfident, control overestimates natural recovery, making lift appear smaller. If underconfident, lift appears larger.
- **Why it matters:** The control arm must represent "what would happen with NO intervention." Using the model's own predictions for both arms creates circular measurement.
- **Root cause:** The control arm was designed as a deterministic proxy, not a true baseline.
- **File(s) affected:** `packages/ml/src/recovery.ts:29-32`
- **Exact change required:** Replace with a fixed historical recovery rate per failure class (e.g., SOFT=22%, NETWORK=32%, HARD=0%, RISK=0%, UNKNOWN=15%) as the control baseline. This represents "blind naive retry" without ML optimization.
- **Dependencies:** None
- **Validation:** Verify that control recovery rate is independent of the ML model's probability output
- **Acceptance criteria:** `controlOutcome` does not reference `probability` from the ML model
- **Track 3 relevance:** Honest control arm is required for credible lift measurement

---

## A-003: Federated Learning Generates Random Weights

- **Priority:** P1
- **Severity:** HIGH
- **Category:** AI/ML Integrity
- **Problem:** `packages/ml/src/federation.ts:122-124` generates random silo weights: `weights = Array.from({ length: FEATURE_COUNT }, () => (rng.next() - 0.5) * 0.2)`. The FedAvg aggregation is mathematically correct, but there is no actual local training. The "improvement" from local → federated is random.
- **Why it matters:** If a judge asks "show me the federated model improving over local models," the answer is "the weights are random, so improvement is also random."
- **Root cause:** Real local training requires per-merchant training data and a training loop. The current implementation simulates this.
- **File(s) affected:** `packages/ml/src/federation.ts:110-153`
- **Exact change required:** Either (a) implement real local training using `packages/ml/src/train.ts` on synthetic per-merchant corpora, or (b) remove federated learning from the pitch entirely and mark the module as experimental/placeholder.
- **Dependencies:** None
- **Validation:** If implementing real training: verify `globalAUC > localAUC` consistently across runs. If removing: verify no demo or pitch references federated learning.
- **Acceptance criteria:** Federated learning either produces measurable improvement or is not presented as working
- **Track 3 relevance:** Presented federated learning that doesn't work is worse than not having it

---

## A-004: Razorpay LIVE Mode Throws Instead of Graceful Fallback

- **Priority:** P1
- **Severity:** HIGH
- **Category:** Reliability
- **Problem:** `packages/core/src/executor/providers/razorpay.ts:248` throws `new Error("LIVE mode not implemented")` when `IS_LIVE` is true. If someone accidentally sets `REAL_EXECUTION_MODE=live`, the entire batch crashes.
- **Why it matters:** Production safety. An accidental environment variable change causes total failure.
- **Root cause:** No graceful fallback was implemented.
- **File(s) affected:** `packages/core/src/executor/providers/razorpay.ts:244-249`
- **Exact change required:** Log a warning and fall back to dry-run mode instead of throwing. Set `dryRunPayload` with a note explaining why.
- **Dependencies:** None
- **Validation:** Set `REAL_EXECUTION_MODE=live` — should log warning and continue in dry-run
- **Acceptance criteria:** No throw on live mode; warning logged; execution continues
- **Track 3 relevance:** Reliability is a judging criterion

---

## A-005: Razorpay Dry-Run Ignores Catalog Multipliers

- **Priority:** P1
- **Severity:** HIGH
- **Category:** Correctness
- **Problem:** `packages/core/src/executor/providers/razorpay.ts:231-234` `mockOutcome` only checks `HUMAN_REVIEW → AMBIGUOUS`. For all other actions, it uses `multiplierFor(failureClass, actionId)` to determine outcome. But `multiplierFor` returns 0 for `HARD_METHOD_DEAD + RETRY_NOW` (mult=0), meaning the dry-run shows FAILED for an action that should have a non-zero probability.
- **Why it matters:** Dry-run outcomes don't match what would happen in production. The demo shows incorrect results.
- **Root cause:** The mock outcome logic in razorpay.ts doesn't share the same logic as the simulation provider.
- **File(s) affected:** `packages/core/src/executor/providers/razorpay.ts:231-234`
- **Exact change required:** Share `deterministicOutcome` logic from the simulation provider, or use the catalog multipliers consistently.
- **Dependencies:** None
- **Validation:** Verify `HARD_METHOD_DEAD + RETRY_NOW` returns FAILED (correct) and `SOFT_RETRYABLE + RETRY_PAYDAY` returns SUCCEEDED (correct)
- **Acceptance criteria:** Mock outcomes match catalog multiplier expectations for all failure class x action combinations
- **Track 3 relevance:** Correctness of demo outcomes

---

## A-006: `editProposal` Breaks After Feature Count Change

- **Priority:** P1
- **Severity:** HIGH
- **Category:** Data Integrity
- **Problem:** `packages/ml/src/pipeline.ts:402-406` compares `frozenValues.length` (11 from old proposals) against `recomputed.values.length` (23 from current feature vector). If any proposal was created before the feature vector expanded from 11 to 23 dimensions, editing it throws `MISSING_FEATURES`.
- **Why it matters:** All existing proposals from before the feature expansion become permanently uneditable.
- **Root cause:** Feature vector versioning was not implemented.
- **File(s) affected:** `packages/ml/src/pipeline.ts:402-406`
- **Exact change required:** Version the feature vector. When `frozenValues.length !== recomputed.values.length`, either (a) recompute features from stored event data, or (b) reject the edit with a clear message, or (c) migrate old proposals to new feature format.
- **Dependencies:** None
- **Validation:** Create a proposal with old feature vector, attempt to edit it — should not crash
- **Acceptance criteria:** No `MISSING_FEATURES` error on proposals with different feature vector versions
- **Track 3 relevance:** Data integrity for audit trail

---

## A-007: `Math.random()` in Production Code

- **Priority:** P1
- **Severity:** HIGH
- **Category:** Reproducibility / Audit Trail
- **Problem:** `packages/core/src/executor/reconciliation.ts:44` uses `Math.random()` for jitter in exponential backoff, and line 242 for workerId. The codebase invariant bans `Math.random()` for reproducibility, but reconciliation violates this.
- **Why it matters:** Non-deterministic behavior breaks reproducibility of audit trails and demos.
- **Root cause:** Backoff jitter was implemented without considering the determinism invariant.
- **File(s) affected:** `packages/core/src/executor/reconciliation.ts:44,242`
- **Exact change required:** Replace `Math.random()` with seeded RNG (`hashSeed()` from `@arbiter/shared`). For workerId, use a configurable `WORKER_ID` env var or process.pid.
- **Dependencies:** None
- **Validation:** Run reconciliation twice with same inputs — should produce identical results
- **Acceptance criteria:** No `Math.random()` calls in any production source file (only in test files)
- **Track 3 relevance:** Reproducibility for audit trail

---

## A-008: Four No-Op Webhook Signature Verifications

- **Priority:** P1
- **Severity:** HIGH
- **Category:** Security
- **Problem:** `twilio_voice.ts:169-171`, `gupshup.ts:130-132`, `msg91.ts:162-164`, `msg91_email.ts:116-118` all implement `verifyWebhookSignature() { return true; }`. Any payload is accepted as valid.
- **Why it matters:** Webhook endpoints accept forged payloads. An attacker can inject fake delivery notifications.
- **Root cause:** Signature verification was not implemented for these providers.
- **File(s) affected:** 4 provider files
- **Exact change required:** Implement HMAC-SHA256 verification using provider-specific secrets from env vars, or clearly document that webhooks are not verified and disable the endpoint.
- **Dependencies:** None
- **Validation:** Send webhook with invalid signature — should be rejected
- **Acceptance criteria:** Either real verification or endpoint disabled with clear documentation
- **Track 3 relevance:** Security is a baseline requirement

---

## A-009: `LTV_NORM_PAISE` History Bug Fix Not Verified

- **Priority:** P2
- **Severity:** MEDIUM
- **Category:** ML Correctness
- **Problem:** The `Implementation.md` mentions Bug #1 (LTV normalization constant 100x too high) was fixed by setting `LTV_NORM_PAISE = 25_00_00` (Rs.25,000). But `packages/shared/src/ltv.ts` should be verified to confirm the fix is correct and the constant is appropriate.
- **Why it matters:** If the normalization constant is wrong, LTV-weighted EV is meaningless.
- **File(s) affected:** `packages/shared/src/ltv.ts`
- **Exact change required:** Verify `LTV_NORM_PAISE = 25_00_00` (Rs.25,000) is appropriate for the customer LTV distribution in the seed generator.
- **Dependencies:** None
- **Validation:** Check that proxy LTV values (`priorSuccessCount x 50_000`) are in range [0, LTV_NORM_PAISE] for typical customers
- **Acceptance criteria:** LTV normalization produces values in [0, 1] for 90%+ of seed customers
- **Track 3 relevance:** LTV-weighted EV is a differentiator

---

## A-010: Control Arm Incremental Can Be Negative

- **Priority:** P2
- **Severity:** MEDIUM
- **Category:** Measurement Reporting
- **Problem:** `packages/ml/src/recovery.ts:218` computes `incrementalRecoveredPaise = recovered - control` which can be negative. The CLI output shows negative values as "INCREMENTAL lift" which is misleading.
- **Why it matters:** Negative lift means ARBITER performed worse than doing nothing. Reporting this as "lift" is confusing.
- **File(s) affected:** `packages/ml/src/recovery.ts:218`, CLI output formatting
- **Acceptance criteria:** Negative incremental clearly labeled as "ARBITER underperformed control" not "lift"
- **Track 3 relevance:** Honest reporting

---

## A-011: `recoverBatch` Audit Trail Count Inaccuracy

- **Priority:** P2
- **Severity:** MEDIUM
- **Category:** Audit Trail
- **Problem:** `packages/ml/src/recovery.ts:167` assumes exactly 2 audit entries per event (DECISION + DIAGNOSIS). Pipeline may write TRIGGER/ALARM entries, making the count wrong.
- **Why it matters:** Audit trail count is a Track 3 deliverable. Inaccurate counts reduce credibility.
- **File(s) affected:** `packages/ml/src/recovery.ts:167`
- **Exact change required:** Query actual `audit_log` count per event after processing instead of assuming a fixed number.
- **Acceptance criteria:** Reported audit trail count matches actual `audit_log` row count
- **Track 3 relevance:** Audit trail accuracy

---

## A-012: `recoverBatch` Conflates Intermediate and Terminal States

- **Priority:** P2
- **Severity:** MEDIUM
- **Category:** Measurement Accuracy
- **Problem:** `packages/ml/src/recovery.ts:173,195,203` treats `AWAITING_APPROVAL` as `escalatedPaise`, but these proposals may later succeed or fail when approved. The report counts intermediate states as final outcomes.
- **Why it matters:** Overcounts "escalated" and ignores future recovery of escalated proposals.
- **File(s) affected:** `packages/ml/src/recovery.ts:173,195,203`
- **Exact change required:** Track final outcomes only (SUCCEEDED/FAILED/AMBIGUOUS). Label intermediate states as "pending" separately from terminal states.
- **Acceptance criteria:** Report distinguishes "escalated and pending" from "escalated and resolved"
- **Track 3 relevance:** Measurement accuracy

---

## A-013: Federated DP Noise Same for All Parameters

- **Priority:** P2
- **Severity:** MEDIUM
- **Category:** ML Correctness
- **Problem:** `packages/ml/src/federation.ts:68-69` adds the same absolute Gaussian noise to all weights and bias. Bias is typically smaller than weights, so the same noise destroys the bias signal disproportionately.
- **Why it matters:** Federated model quality degrades unnecessarily.
- **File(s) affected:** `packages/ml/src/federation.ts:68-69`
- **Exact change required:** Scale noise per parameter magnitude using sensitivity analysis, or use per-layer noise scales.
- **Acceptance criteria:** Bias signal survives DP noise application
- **Track 3 relevance:** Federated learning correctness (if kept)

---

## A-014: `recover.ts` Generates New Model Every Run

- **Priority:** P2
- **Severity:** LOW
- **Category:** Reproducibility
- **Problem:** `packages/ml/src/recover.ts:61-65` uses `trainedAtUtc: isoUtc(nowMs)` which changes every run, producing different model IDs.
- **Why it matters:** Demos are not reproducible across runs.
- **File(s) affected:** `packages/ml/src/recover.ts:61-65`
- **Acceptance criteria:** Model ID is deterministic for same inputs
- **Track 3 relevance:** Demo reproducibility

---

## A-015: README Says 16-D Features, Code Has 23-D

- **Priority:** P2
- **Severity:** LOW
- **Category:** Documentation Accuracy
- **Problem:** `README.md` line 24 says "16-D Feature Vec" but `FEATURE_NAMES` in `features.ts:26-50` lists 23 features.
- **Why it matters:** Misleads judges about system capability.
- **File(s) affected:** `README.md:24`
- **Acceptance criteria:** README matches code
- **Track 3 relevance:** Documentation credibility

---

# SECTION B: MISSING CAPABILITIES

---

## B-001: No Ablation Study (Rules vs ML)

- **Priority:** P0
- **Severity:** CRITICAL
- **Category:** AI Necessity
- **Problem:** No evidence that ML adds value over simple rules. Track 3 asks for "AI Revenue Recovery" — if AI doesn't add measurable value, its presence is a negative signal.
- **Why it matters:** Judges will ask "why not just use 7 rules?" Recoup published ablation: rulebook vs same-budget random vs ML. ARBITER has nothing.
- **Exact change required:** Implement a rules-only baseline engine:
  ```
  HARD_METHOD_DEAD → send new payment link
  SOFT_RETRYABLE + near_payday → retry now
  SOFT_RETRYABLE + not near_payday → schedule for payday
  NETWORK_TIMEOUT → retry in 2 hours
  RISK_FLAGGED → escalate to human
  UNKNOWN → send payment link
  Already contacted today → skip
  Quiet hours → defer
  ```
  Run both rules-only and ML pipeline on the same batch with same mock provider outcomes. Report recovery rate difference with bootstrap 95% CIs.
- **Dependencies:** A-001 (real batch measurement)
- **Acceptance criteria:** Output shows `RULES: X% recovery | ML: Y% recovery | INCREMENTAL: +Zpp CI[a,b]`
- **Track 3 relevance:** Proves AI is necessary, not decorative

---

## B-002: No Held-Out Evaluation

- **Priority:** P0
- **Severity:** CRITICAL
- **Category:** ML Rigor
- **Problem:** Train and evaluate on the same data. No generalization evidence. Reflex pre-registered 3000-episode evaluation. Recoup used 30 held-out seeds. ARBITER uses nothing.
- **Why it matters:** All reported metrics are suspect without held-out evaluation.
- **Exact change required:** Split seed corpus: 70% train, 30% held-out (stratified by failure class). Train model on train split. Evaluate on held-out split only. Report: AUC, recovery rate, cost per recovery on held-out. Add `--held-out` flag to `recover.ts`.
- **Dependencies:** A-001
- **Acceptance criteria:** Output shows `TRAIN: X% | HELD-OUT: Y% | GENERALIZATION GAP: Zpp`
- **Track 3 relevance:** Proves model generalizes

---

## B-003: No Bootstrap Confidence Intervals

- **Priority:** P0
- **Severity:** CRITICAL
- **Category:** Measurement Rigor
- **Problem:** All recovery metrics are point estimates with no uncertainty quantification. Reflex reports bootstrap 95% CIs. ARBITER reports nothing.
- **Why it matters:** Point estimates without CIs are not credible measurement.
- **Exact change required:** Add bootstrap resampling (1000 iterations) to `recoverBatch()`. Report recovery rate with 95% CI: `RECOVERY: 41.2% CI[36.8%, 45.7%]`.
- **Dependencies:** A-001
- **Acceptance criteria:** Every reported metric has a CI
- **Track 3 relevance:** Measurement rigor

---

## B-004: No Negative Results Published

- **Priority:** P1
- **Severity:** HIGH
- **Category:** Honesty / Competitive Signal
- **Problem:** No published failures or negative results. Recoup published 14 failures including "issuer health monitor detected 0/60 outages, turned off." Reflex admitted "LLM tail measured zero delta on synthetic data." ARBITER publishes nothing.
- **Why it matters:** Judges explicitly asked "what broke." Teams that publish negative results demonstrate engineering maturity.
- **Exact change required:** Add "What We Tried That Didn't Work" section to README and pitch:
  1. "LLM for root-cause diagnosis: measured zero delta over rules on synthetic data (same as Reflex's finding)"
  2. "Rail health signal: simulated, not measurable impact on recovery timing in controlled batch"
  3. "Federated learning: random silo weights produce random improvement — removed from demo"
- **Dependencies:** None
- **Acceptance criteria:** README/pitch includes at least 2 documented negative results
- **Track 3 relevance:** Honesty is a differentiator

---

## B-005: No Cost-per-Recovered-Rupee Metric

- **Priority:** P1
- **Severity:** HIGH
- **Category:** Business Metrics
- **Problem:** No cost efficiency metric. Reflex reports Rs.0.27/100 recovered. ARBITER tracks provider costs but doesn't compute cost efficiency.
- **Why it matters:** Business value is measured in rupees recovered per rupee spent.
- **Exact change required:** Compute `costPerRecoveredRupee = totalOutreachCostPaise / recoveredPaise` in batch benchmark. Include email cost (~Rs.0.10), SMS cost (~Rs.0.25), WhatsApp cost (~Rs.0.80), voice cost (~Rs.1.50).
- **Dependencies:** A-001
- **Acceptance criteria:** Batch report includes `COST/100 RECOVERED: Rs.X.XX`
- **Track 3 relevance:** Business metric

---

## B-006: No Real Razorpay Test-Mode API Call

- **Priority:** P1
- **Severity:** HIGH
- **Category:** Demo Credibility
- **Problem:** `razorpay.ts:245-248` has `// TODO: real Razorpay API call`. The demo never creates a real Payment Link. Reflex has real Razorpay test-mode webhooks + Payment Links.
- **Why it matters:** "Show me a real Razorpay API call" is the highest judge signal.
- **Exact change required:** In the demo flow, actually create a Razorpay Payment Link via test-mode API using existing `RZP_TEST_KEY_ID`/`RZP_TEST_KEY_SECRET`. Show the Payment Link URL in the demo output. Do NOT send it to a real customer.
- **Dependencies:** None
- **Acceptance criteria:** Demo output shows a real Razorpay Payment Link URL (e.g., `https://rzp.io/i/xxxxx`)
- **Track 3 relevance:** Real Razorpay touch

---

## B-007: No Multi-Tenant Tests

- **Priority:** P2
- **Severity:** MEDIUM
- **Category:** Test Coverage
- **Problem:** All 517 tests use tenant 'demo'. Cross-tenant data leakage is completely untested.
- **Why it matters:** Multi-tenant isolation is a production requirement.
- **Exact change required:** Add tests that create events in tenant A, verify tenant B cannot access them.
- **Acceptance criteria:** Test confirms cross-tenant isolation
- **Track 3 relevance:** Production credibility

---

## B-008: No Concurrent Access Tests

- **Priority:** P2
- **Severity:** MEDIUM
- **Category:** Concurrency Safety
- **Problem:** No test for concurrent `processEvent` on the same customer. The `SKIPPED_OPEN_PROPOSAL` guard is only tested sequentially. No test for concurrent `approveProposal` + `editProposal`. No test for concurrent `reconcileProposal` from multiple workers.
- **Why it matters:** Race conditions can cause double-debits or lost proposals.
- **Exact change required:** Add tests using `Promise.all` for concurrent access patterns on shared customer/proposal records.
- **Acceptance criteria:** Concurrent operations produce consistent state
- **Track 3 relevance:** Failure & Concurrency Resilience (brief says "zero double-debits")

---

## B-009: No Integration Test for Full Pipeline with Real Provider

- **Priority:** P2
- **Severity:** MEDIUM
- **Category:** Test Coverage
- **Problem:** No integration test covering webhook → ingest → features → predict → decide → propose → approve → execute → reconcile with actual provider (even dry-run).
- **Exact change required:** Add `tests/integration/e2e_recovery.test.ts` that exercises the full pipeline with razorpay dry-run provider.
- **Acceptance criteria:** Full pipeline completes without errors; audit trail has all expected entries
- **Track 3 relevance:** Integration correctness

---

## B-010: No Edge Case Tests for Decision Engine

- **Priority:** P2
- **Severity:** MEDIUM
- **Category:** Test Coverage
- **Problem:** No tests for: `amountPaise = 0`, `amountPaise = 1`, `probability = 0.0`, `probability = 1.0`, `attemptsSoFar = 0`, empty `priorFailureAmountsPaise` with `priorFailureCount > 0`, extremely large amounts.
- **Exact change required:** Add boundary condition tests for `decide()`.
- **Acceptance criteria:** All boundary conditions handled without errors
- **Track 3 relevance:** Edge case robustness

---

## B-011: No Provider DLR Webhook Integration Tests

- **Priority:** P3
- **Severity:** LOW
- **Category:** Test Coverage
- **Problem:** No tests for Brevo/MSG91/Twilio/Gupshup delivery receipt webhooks.
- **Exact change required:** Add tests for DLR webhook handling with valid/invalid signatures.
- **Acceptance criteria:** DLR webhooks update outreach status correctly
- **Track 3 relevance:** Delivery tracking

---

# SECTION C: ARCHITECTURE IMPROVEMENTS

---

## C-001: Batch Benchmark Should Use MockRazorpayProvider

- **Priority:** P0
- **Severity:** CRITICAL
- **Category:** Architecture
- **Problem:** The batch benchmark in `app/recovery.ts:760-975` computes outcomes from hardcoded rates instead of executing through the real executor path with a mock provider.
- **Why it matters:** This is the core architecture change needed to make measurement real.
- **Exact change required:** Import `MockRazorpayProvider` from `packages/trial/src/provider.ts`. Wire it as the action provider in `recoverBatch()`. Map failure classes to scenario IDs. Execute each proposal through `executeProposal()` which calls the mock provider. Read actual outcomes from provider responses.
- **Dependencies:** None
- **Acceptance criteria:** Batch report shows actual provider outcomes per event
- **Track 3 relevance:** Core Track 3 requirement

---

## C-002: Extract `clamp01` to Shared Module

- **Priority:** P2
- **Severity:** LOW
- **Category:** Code Duplication
- **Problem:** `clamp01()` defined in 3 places: `packages/core/src/decide/engine.ts:73`, `packages/core/src/ingest/rail_health.ts:72`, `packages/ml/src/features.ts:71`.
- **Exact change required:** Export from `packages/shared/src/index.ts`, import everywhere.
- **Acceptance criteria:** Single definition, 3 imports

---

## C-003: Extract Control Arm to Separate Module

- **Priority:** P2
- **Severity:** MEDIUM
- **Category:** Architecture
- **Problem:** Control arm logic is embedded in `packages/ml/src/recovery.ts:29-32`. Should be a pluggable `ControlArm` interface with `HistoricalBaseline`, `ModelBaseline`, `RandomBaseline` implementations.
- **Exact change required:** Create `packages/ml/src/control_arm.ts` with `ControlArm` interface. Implement `HistoricalBaseline` (fixed rates per failure class). Inject into `recoverBatch()`.
- **Acceptance criteria:** Control arm is injectable and testable independently
- **Track 3 relevance:** Enables ablation study

---

## C-004: Add Structured Logging

- **Priority:** P2
- **Severity:** MEDIUM
- **Category:** Observability
- **Problem:** 131 `console.log/error/warn` statements across source files. Some leak API key prefixes, phone numbers, full request/response bodies.
- **Exact change required:** Create `packages/shared/src/logger.ts` with structured JSON logger. Replace all console.log calls. Redact sensitive fields (API keys, phone numbers, email addresses).
- **Acceptance criteria:** No raw `console.log` in production source files; all output is structured JSON
- **Track 3 relevance:** Production credibility

---

## C-005: Move Business Logic to Config

- **Priority:** P2
- **Severity:** MEDIUM
- **Category:** Configuration
- **Problem:** Action multiplier table (55 cells in `packages/core/src/decide/catalog.ts`), credibility scoring weights (11 rules in `packages/ml/src/credibility.ts`), and seed distribution parameters are hardcoded in source.
- **Exact change required:** Move to `config/policy.yaml` or a new `config/catalog.yaml`. Keep source code as the parser, not the data.
- **Acceptance criteria:** Changing a multiplier doesn't require code changes
- **Track 3 relevance:** Merchant-configurable recovery

---

## C-006: Feature Vector Versioning

- **Priority:** P2
- **Severity:** MEDIUM
- **Category:** Data Integrity
- **Problem:** Feature vector expanded from 11 to 23 dimensions. Old proposals with 11-D frozen features cannot be edited (A-006).
- **Exact change required:** Add `feature_version` column to proposals table. When editing, recompute features from stored event data using current feature version.
- **Acceptance criteria:** Proposals with old feature versions can be edited by recomputing features
- **Track 3 relevance:** Data migration safety

---

## C-007: Provider Cost Configuration

- **Priority:** P3
- **Severity:** LOW
- **Category:** Configuration
- **Problem:** Messaging costs hardcoded: MSG91 SMS = 25 paise, Brevo email = 10 paise, Gupshup WhatsApp = 80 paise, Twilio voice = 150 paise.
- **Exact change required:** Add to config or env vars with documented defaults.
- **Acceptance costs configurable without code changes
- **Track 3 relevance:** Cost accuracy

---

# SECTION D: REMOVAL / CLEANUP

---

## D-001: Remove Dead `simulation.ts` Provider

- **Priority:** P1
- **Severity:** HIGH
- **Category:** Dead Code
- **Problem:** `packages/core/src/executor/providers/simulation.ts` is functionally identical to `razorpay.ts` dry-run mode. Both use `mockOutcome()` with the same catalog multipliers. Two paths to the same behavior.
- **Exact change required:** Delete `simulation.ts`. Update all imports to use `razorpay.ts` dry-run.
- **Acceptance criteria:** No imports of `simulation.ts`; all tests pass
- **Track 3 relevance:** Code clarity

---

## D-002: Remove `bankRailHealth = 1.0` Dead Feature

- **Priority:** P2
- **Severity:** MEDIUM
- **Category:** Dead Code
- **Problem:** `packages/ml/src/features.ts:306` hardcodes `bankRailHealth = 1.0`. This feature is always constant, adds no signal to the model, and wastes a feature dimension.
- **Exact change required:** Remove from feature vector. Renumber remaining features. Update `FEATURE_NAMES`, `FEATURE_COUNT`, and model weights accordingly.
- **Acceptance criteria:** Feature vector has 22 dimensions; all tests pass with updated feature indices
- **Track 3 relevance:** Feature quality

---

## D-003: Remove Duplicate `clamp01` Definitions

- **Priority:** P3
- **Severity:** LOW
- **Category:** Code Duplication
- **Problem:** `clamp01()` defined 3 times (C-002).
- **Exact change required:** After C-002, remove the duplicate definitions.

---

## D-004: Remove `features_16d.test.ts`

- **Priority:** P3
- **Severity:** LOW
- **Category:** Weak Tests
- **Problem:** `tests/ml/features_16d.test.ts` only checks `values.length === 23` and `Number.isFinite()`. Tests are named "16D" but vector is 23D. Adds no value beyond what `features.test.ts` already covers.
- **Exact change required:** Delete file. Ensure `features.test.ts` covers the same cases.
- **Acceptance criteria:** All tests pass without this file
- **Track 3 relevance:** Test quality

---

## D-005: Remove Hardcoded Personal Email

- **Priority:** P1
- **Severity:** HIGH
- **Category:** Security / Cleanup
- **Problem:** `packages/core/src/messaging/providers/brevo.ts:36` and `msg91_email.ts:30` hardcode `"magicalfootball2005@gmail.com"` as fallback sender email.
- **Exact change required:** Remove hardcoded email. Use env-only configuration with no fallback to personal email.
- **Acceptance criteria:** No personal email addresses in source code
- **Track 3 relevance:** Professionalism / security

---

## D-006: Remove Developer Name from Source

- **Priority:** P2
- **Severity:** MEDIUM
- **Category:** Cleanup
- **Problem:** `packages/core/src/ingest/providers/local_deterministic.ts:349` contains `"aditya@example.com"`.
- **Exact change required:** Replace with generic placeholder or remove.
- **Acceptance criteria:** No developer-specific data in source
- **Track 3 relevance:** Professionalism

---

## D-007: Remove Narrative Generation (Decorative)

- **Priority:** P3
- **Severity:** LOW
- **Category:** Dead Code
- **Problem:** `packages/ml/src/narrative.ts` generates "Claude case brief" narratives. This is decorative and explicitly off the money path.
- **Exact change required:** Remove from pitch. Keep in codebase if desired but don't present as functionality.
- **Acceptance criteria:** Demo/pitch does not reference narrative generation
- **Track 3 relevance:** Focus on what matters

---

## D-008: Remove Cross-PSP Recovery from Demo

- **Priority:** P2
- **Severity:** MEDIUM
- **Category:** Scope Management
- **Problem:** `RECOVER_VIA_RAIL` action in `catalog.ts` is a stub. No real cross-PSP execution. Presenting it as working is misleading.
- **Exact change required:** Keep the code but mark as "future direction" in pitch. Do not demo it. Focus on what actually works.
- **Acceptance criteria:** Demo does not attempt to execute cross-PSP recovery
- **Track 3 relevance:** Honesty about implementation state

---

# SECTION E: WINNING-LEVEL ENHANCEMENTS

---

## E-001: Rules-Only Baseline Engine

- **Priority:** P0
- **Severity:** CRITICAL
- **Category:** AI Evaluation
- **Problem:** No baseline to compare ML against. Without this, "AI" in "AI Revenue Recovery" is unjustified.
- **Exact change required:** Implement `packages/ml/src/baseline_rules.ts`:
  ```typescript
  function rulesOnlyDecision(failureClass, amount, nearPayday, attemptsSoFar, nowMs): Action {
    if (failureClass === "HARD_METHOD_DEAD") return "ALTERNATE_UPI_LINK";
    if (failureClass === "RISK_FLAGGED") return "HUMAN_REVIEW";
    if (failureClass === "NETWORK_TIMEOUT") return "RETRY_NOW";
    if (failureClass === "SOFT_RETRYABLE" && nearPayday) return "RETRY_NOW";
    if (failureClass === "SOFT_RETRYABLE") return "RETRY_PAYDAY";
    return "REMINDER_LINK"; // UNKNOWN
  }
  ```
  Run on same batch as ML pipeline. Compare recovery rates.
- **Dependencies:** A-001
- **Acceptance criteria:** `recover.ts --ablation` outputs rules vs ML comparison
- **Track 3 relevance:** Proves AI value

---

## E-002: Batch Evaluation Pipeline

- **Priority:** P0
- **Severity:** CRITICAL
- **Category:** Measurement
- **Problem:** No proper evaluation pipeline. The batch benchmark is ad-hoc.
- **Exact change required:** Create `packages/ml/src/evaluate.ts`:
  1. Generate 200-event corpus with known ground truth
  2. Split: 140 train, 60 held-out
  3. Train model on train split
  4. Run rules-only baseline on held-out
  5. Run ML pipeline on held-out
  6. Report: recovery rate, cost, CIs for both
  7. Label all output `[SIMULATED - MOCK PROVIDER]`
- **Dependencies:** A-001, E-001
- **Acceptance criteria:** `pnpm evaluate` produces held-out comparison report
- **Track 3 relevance:** Core Track 3 deliverable

---

## E-003: Sensitivity Analysis

- **Priority:** P1
- **Severity:** HIGH
- **Category:** Robustness
- **Problem:** No analysis of how performance degrades under perturbed conditions. Recoup runs 23 perturbed worlds.
- **Exact change required:** Implement perturbation tests: vary failure class distribution (+/-10%), amount distribution (+/-20%), customer behavior (+/-15%). Report recovery rate stability across perturbations.
- **Dependencies:** E-002
- **Acceptance criteria:** Recovery rate CI width < 5pp across perturbations
- **Track 3 relevance:** Robustness evidence

---

## E-004: Recovery Rate by Failure Class

- **Priority:** P1
- **Severity:** HIGH
- **Category:** Measurement Granularity
- **Problem:** Batch benchmark reports aggregate numbers only. No per-failure-class breakdown.
- **Exact change required:** Add per-class metrics to batch report:
  ```
  SOFT_RETRYABLE: 42 events, Rs.X at-risk, Rs.Y recovered (72%), cost Rs.Z
  HARD_METHOD_DEAD: 25 events, Rs.X at-risk, Rs.Y recovered (0%), escalated to human
  NETWORK_TIMEOUT: 15 events, Rs.X at-risk, Rs.Y recovered (85%)
  RISK_FLAGGED: 10 events, Rs.X at-risk, Rs.Y recovered (0%), all escalated
  UNKNOWN: 8 events, Rs.X at-risk, Rs.Y recovered (45%)
  ```
- **Dependencies:** A-001
- **Acceptance criteria:** Report includes per-failure-class breakdown
- **Track 3 relevance:** Measurement granularity

---

## E-005: Recovery Rate by Intervention Type

- **Priority:** P1
- **Severity:** HIGH
- **Category:** Measurement Granularity
- **Problem:** No breakdown of which interventions (RETRY_NOW, RETRY_PAYDAY, ALTERNATE_UPI_LINK, etc.) are most effective.
- **Exact change required:** Add per-intervention metrics: which actions were chosen, what was their success rate, what was the cost.
- **Dependencies:** A-001
- **Acceptance criteria:** Report includes per-intervention breakdown
- **Track 3 relevance:** Intervention optimization evidence

---

## E-006: Time-to-Recovery Metric

- **Priority:** P2
- **Severity:** MEDIUM
- **Category:** Business Metric
- **Problem:** No measurement of how long recovery takes from failure to success.
- **Exact change required:** Track `failureTimestamp -> recoveryTimestamp` for each event. Report median and P90 time-to-recovery.
- **Dependencies:** A-001
- **Acceptance criteria:** Report includes `MEDIAN TIME TO RECOVERY: X hours`
- **Track 3 relevance:** Business metric

---

## E-007: Dashboard Batch Report View

- **Priority:** P2
- **Severity:** MEDIUM
- **Category:** Demo / Demonstrability
- **Problem:** Batch evaluation results are only in terminal output. Judges need to SEE the numbers.
- **Exact change required:** Add `/api/recovery/batch-report` endpoint. Add simple HTML page with Chart.js bar chart comparing rules vs ML recovery rates.
- **Dependencies:** E-002
- **Acceptance criteria:** Browser shows visual comparison of rules vs ML
- **Track 3 relevance:** Visual proof

---

## E-008: Cost Breakdown per Channel

- **Priority:** P2
- **Severity:** MEDIUM
- **Category:** Business Metric
- **Problem:** Total cost reported but not broken down by channel (email vs SMS vs WhatsApp vs voice).
- **Exact change required:** Track cost per channel in batch report. Show: email cost, SMS cost, total outreach cost.
- **Dependencies:** A-001
- **Acceptance criteria:** Report includes per-channel cost breakdown
- **Track 3 relevance:** Cost optimization evidence

---

## E-009: Promise-to-Pay Lifecycle Integration Test

- **Priority:** P2
- **Severity:** MEDIUM
- **Category:** Test Coverage
- **Problem:** Promise-to-pay has unit tests but no full lifecycle test: propose → approve → execute → record promise → reconcile → mark kept/broken → feature impact.
- **Exact change required:** Add integration test covering the full promise-to-pay lifecycle.
- **Acceptance criteria:** Promise lifecycle completes end-to-end
- **Track 3 relevance:** Promise-to-pay is a differentiator

---

## E-010: Drift Detection Integration Test

- **Priority:** P2
- **Severity:** MEDIUM
- **Category:** Test Coverage
- **Problem:** `p7_measurement.test.ts` imports drift functions but never calls them. Only does raw SQL inserts and hardcoded arithmetic.
- **Exact change required:** Rewrite test to actually call `detectDrift()` and verify output.
- **Acceptance criteria:** Test exercises actual drift detection logic
- **Track 3 relevance:** Model monitoring

---

# SECTION F: PAYMENT CORRECTNESS

---

## F-001: PaymentIntent State Machine Correctness

- **Priority:** P1
- **Severity:** HIGH
- **Category:** Payment Safety
- **Problem:** `packages/core/src/executor/payment_intent.ts` implements idempotency and lost-response handling. The trial sandbox (`packages/trial`) tests 20 scenarios including `success_lost_response`, `duplicate_request`, `concurrent_attempts`. But no production integration test verifies these scenarios against the real executor path.
- **Exact change required:** Add `tests/integration/payment_intent_safety.test.ts` that exercises: (1) double-charge protection with same idempotency key, (2) lost response leaves UNKNOWN state, (3) concurrent attempts resolve to single charge.
- **Acceptance criteria:** No double-debit in any test scenario
- **Track 3 relevance:** "Zero double-debits" is in the brief

---

## F-002: Reconciliation Worker Correctness

- **Priority:** P1
- **Severity:** HIGH
- **Category:** Payment Safety
- **Problem:** `packages/core/src/executor/reconciliation.ts` sweeps stale EXECUTING proposals. Uses `Math.random()` for backoff jitter (A-007). No test verifies that reconciliation correctly resolves stuck proposals.
- **Exact change required:** Fix Math.random() (A-007). Add test: create proposal in EXECUTING state, provider never responds, reconciliation sweeps it to UNKNOWN.
- **Acceptance criteria:** Stale EXECUTING proposals are correctly resolved
- **Track 3 relevance:** Crash recovery

---

## F-003: Webhook Race: payment.captured Arrives Before payment.failed

- **Priority:** P2
- **Severity:** MEDIUM
- **Category:** Webhook Safety
- **Problem:** If Razorpay sends `payment.captured` before `payment.failed` (out-of-order), the system may mark a failed payment as captured.
- **Exact change required:** Verify that webhook dedup and event ordering handle this case. The `webhook_dedupe` table should prevent processing the same event twice, but out-of-order events from different payment attempts need verification.
- **Acceptance criteria:** Out-of-order webhooks produce consistent state
- **Track 3 relevance:** Webhook reliability

---

## F-004: UNKNOWN Payment State Handling

- **Priority:** P2
- **Severity:** MEDIUM
- **Category:** Payment Safety
- **Problem:** When a payment intent is UNKNOWN (provider charged but response lost), the customer is told to wait. But no mechanism resolves this state automatically — it requires manual reconciliation or a delayed webhook.
- **Exact change required:** Add a timeout-based resolution: if UNKNOWN for >24 hours, auto-escalate to human review with a "check with provider" action.
- **Acceptance criteria:** UNKNOWN state resolves within 24 hours
- **Track 3 relevance:** Crash recovery

---

# SECTION G: SECURITY AND FINANCIAL SAFETY

---

## G-001: No Rate Limiting on API Endpoints

- **Priority:** P2
- **Severity:** MEDIUM
- **Category:** Security
- **Problem:** No rate limiting on `/api/orders/create`, `/api/payments/verify`, `/api/webhooks/razorpay`, `/api/recovery/*` endpoints.
- **Exact change required:** Add rate limiting middleware (e.g., 10 req/min per IP for payment endpoints, 100 req/min for webhooks).
- **Acceptance criteria:** Rate-limited endpoints reject excess requests with 429
- **Track 3 relevance:** Abuse prevention

---

## G-002: ADMIN_SECRET_KEY Bypass

- **Priority:** P2
- **Severity:** MEDIUM
- **Category:** Security
- **Problem:** `ENFORCE_ADMIN_KEY=false` in `.env`. Admin endpoints (`/api/vendor/decision`) are unprotected in default configuration.
- **Exact change required:** Set `ENFORCE_ADMIN_KEY=true` for production. Document that demo mode uses `false`.
- **Acceptance criteria:** Admin endpoints require auth key when `ENFORCE_ADMIN_KEY=true`
- **Track 3 relevance:** Authorization

---

## G-003: Secret in `.env` Committed to Git

- **Priority:** P2
- **Severity:** MEDIUM
- **Category:** Security
- **Problem:** `.env` was force-added to git in a previous commit (containing Brevo API key, MSG91 auth key, Razorpay test keys, DB token). Even though it was later untracked, the secrets remain in git history.
- **Exact change required:** Rotate all exposed keys. Add `.env` to `.gitignore` (already done). Consider using git-secrets or pre-commit hooks.
- **Acceptance criteria:** No secrets in git history (or all exposed secrets rotated)
- **Track 3 relevance:** Security hygiene

---

## G-004: Webhook Signature Verification Incomplete

- **Priority:** P1
- **Severity:** HIGH
- **Category:** Security
- **Problem:** Brevo webhook verification (`brevo.ts:verifyWebhookSignature`) is implemented with HMAC-SHA256. But 4 other providers (Twilio, Gupshup, MSG91, MSG91-email) have no-op verification (A-008).
- **Exact change required:** Implement or disable. If disabling, remove the `verifyWebhookSignature` method entirely and document the decision.
- **Acceptance criteria:** All webhook endpoints either verify signatures or are clearly documented as unverified
- **Track 3 relevance:** Webhook security

---

# SECTION H: UI / PRODUCT EXPERIENCE

---

## H-001: Dashboard Should Show Batch Recovery Report

- **Priority:** P1
- **Severity:** HIGH
- **Category:** Demonstrability
- **Problem:** Dashboard shows per-transaction analytics but not batch recovery metrics. Track 3 requires "measured money recovered across a batch."
- **Exact change required:** Add "Recovery Report" tab to dashboard showing: batch size, at-risk amount, recovered amount, escalated amount, stopped amount, cost efficiency, rules vs ML comparison.
- **Dependencies:** E-002
- **Acceptance criteria:** Dashboard displays batch recovery metrics with comparison chart
- **Track 3 relevance:** Visual proof of batch recovery

---

## H-002: Customer Recovery Page Should Show Failure Reason

- **Priority:** P2
- **Severity:** MEDIUM
- **Category:** Customer Experience
- **Problem:** `app/views/recover.html` shows generic "Payment Could Not Be Processed" for UNKNOWN class. Should show customer-friendly explanation from error catalog.
- **Exact change required:** Use `customerMessage` from error catalog in the recovery page heading.
- **Acceptance criteria:** Recovery page shows transaction-specific failure explanation
- **Track 3 relevance:** Customer-facing quality

---

# SECTION I: HACKATHON DEMO REQUIREMENTS

---

## I-001: Demo Script Must Show Batch Processing

- **Priority:** P0
- **Severity:** CRITICAL
- **Category:** Demo
- **Problem:** Current demo shows single-transaction flow. Track 3 requires batch measurement.
- **Exact change required:** Demo script:
  1. Generate 100-event batch (diverse failure classes, amounts, customers)
  2. Run ARBITER pipeline on batch
  3. Show: recovered Rs., escalated Rs., stopped Rs., cost per recovery
  4. Run rules-only baseline on same batch
  5. Show comparison: rules X% vs ML Y% (+Zpp)
  6. Show audit trail for 3 sample events
  7. Show dashboard with batch report
- **Dependencies:** A-001, E-001, E-002, H-001
- **Acceptance criteria:** Demo completes in <3 minutes with visible numbers
- **Track 3 relevance:** Core demo requirement

---

## I-002: Demo Must Show Real Razorpay API Call

- **Priority:** P1
- **Severity:** HIGH
- **Category:** Demo
- **Problem:** Demo never shows a real Razorpay API interaction.
- **Exact change required:** During demo, create a Razorpay Payment Link in test mode. Show the API request payload and response in the terminal/dashboard.
- **Dependencies:** B-006
- **Acceptance criteria:** Demo shows real Razorpay Payment Link URL
- **Track 3 relevance:** Real Razorpay touch

---

## I-003: Demo Must Show Honest Numbers

- **Priority:** P1
- **Severity:** HIGH
- **Category:** Demo
- **Problem:** Demo shows fabricated recovery rates.
- **Exact change required:** All demo numbers come from actual execution against mock provider. Label output: `[SIMULATED - MOCK PROVIDER]`.
- **Dependencies:** A-001
- **Acceptance criteria:** No hardcoded numbers in demo output
- **Track 3 relevance:** Honesty

---

## I-004: Demo Must Include Negative Result

- **Priority:** P1
- **Severity:** HIGH
- **Category:** Demo
- **Problem:** Demo only shows successes.
- **Exact change required:** Include one "what didn't work" segment: "We tried X. It measured Y. Here's why we removed it."
- **Dependencies:** B-004
- **Acceptance criteria:** Demo includes documented negative result
- **Track 3 relevance:** Engineering maturity

---

# SECTION J: PRIORITIZATION SUMMARY

---

## Absolute Minimum (Must have for credibility)

| ID | Task | Priority |
|----|------|----------|
| A-001 | Real batch measurement (mock provider) | P0 |
| A-002 | Fix control arm (historical baseline) | P0 |
| B-001 | Rules-only ablation study | P0 |
| B-002 | Held-out evaluation | P0 |
| B-003 | Bootstrap confidence intervals | P0 |
| D-005 | Remove personal email | P1 |
| I-001 | Demo shows batch processing | P0 |

## Strong Submission (Serious shortlist)

| ID | Task | Priority |
|----|------|----------|
| A-003 | Fix or remove federated learning | P1 |
| A-004 | Graceful LIVE mode fallback | P1 |
| A-005 | Fix dry-run multiplier logic | P1 |
| A-007 | Remove Math.random() from production | P1 |
| A-008 | Fix webhook signature verification | P1 |
| B-004 | Negative results | P1 |
| B-005 | Cost-per-recovered-rupee | P1 |
| B-006 | Real Razorpay test-mode API call | P1 |
| D-001 | Remove dead simulation.ts | P1 |
| E-001 | Rules-only baseline engine | P0 |
| E-002 | Batch evaluation pipeline | P0 |
| E-004 | Per-failure-class breakdown | P1 |
| E-005 | Per-intervention breakdown | P1 |
| F-001 | PaymentIntent safety tests | P1 |
| G-004 | Webhook signature verification | P1 |
| H-001 | Dashboard batch report | P1 |

## Winning-Level (Materially differentiates)

| ID | Task | Priority |
|----|------|----------|
| E-003 | Sensitivity analysis | P1 |
| E-006 | Time-to-recovery metric | P2 |
| E-007 | Dashboard batch report view | P2 |
| E-008 | Cost breakdown per channel | P2 |
| B-007 | Multi-tenant tests | P2 |
| B-008 | Concurrent access tests | P2 |
| C-004 | Structured logging | P2 |
| C-005 | Config-driven business logic | P2 |
| F-002 | Reconciliation worker tests | P1 |
| F-003 | Webhook race tests | P2 |
| G-001 | Rate limiting | P2 |
| I-002 | Real Razorpay in demo | P1 |
| I-003 | Honest numbers in demo | P1 |
| I-004 | Negative result in demo | P1 |

---

# SECTION K: DEPENDENCY GRAPH

```
A-001 (Real batch measurement)
├── B-001 (Ablation study)
│   └── E-001 (Rules-only baseline)
├── B-002 (Held-out evaluation)
├── B-003 (Confidence intervals)
├── B-005 (Cost-per-recovered-rupee)
├── E-002 (Batch evaluation pipeline)
│   ├── E-003 (Sensitivity analysis)
│   ├── E-007 (Dashboard batch view)
│   └── H-001 (Dashboard batch report)
├── E-004 (Per-failure-class breakdown)
├── E-005 (Per-intervention breakdown)
├── E-006 (Time-to-recovery)
├── E-008 (Cost breakdown per channel)
└── I-001 (Demo batch processing)

A-002 (Fix control arm) ──> B-001 (Ablation)
A-003 (Fix/remove federated) ──> independent
A-004 (LIVE mode fallback) ──> independent
A-005 (Fix dry-run multipliers) ──> B-006 (Real Razorpay)
A-006 (editProposal fix) ──> C-006 (Feature versioning)
A-007 (Remove Math.random) ──> F-002 (Reconciliation tests)
A-008 (Webhook verification) ──> G-004

B-006 (Real Razorpay) ──> I-002 (Demo Razorpay)
B-004 (Negative results) ──> I-004 (Demo negative)

D-001 (Remove simulation.ts) ──> independent
D-005 (Remove personal email) ──> independent

E-001 (Rules baseline) ──> E-002 (Batch pipeline)
E-002 ──> E-003, E-007, H-001

C-001 (MockRazorpayProvider in batch) = A-001
```

---

# SECTION L: FINAL MASTER CHECKLIST (Implementation Order)

---

### Phase 1: Foundation (Day 1)

- [ ] **A-001** | P0 | Wire batch benchmark to MockRazorpayProvider | `app/recovery.ts`, `packages/ml/src/recovery.ts`, `packages/trial/src/provider.ts` | None | Batch report shows actual provider outcomes per event
- [ ] **A-002** | P0 | Replace control arm with historical baseline | `packages/ml/src/recovery.ts:29-32` | None | `controlOutcome` uses fixed rates, not ML probability
- [ ] **D-005** | P1 | Remove personal email from source | `brevo.ts:36`, `msg91_email.ts:30` | None | No personal emails in source
- [ ] **A-007** | P1 | Replace Math.random() in reconciliation | `reconciliation.ts:44,242` | None | No Math.random() in production code

### Phase 2: Evaluation Pipeline (Day 2)

- [ ] **E-001** | P0 | Implement rules-only baseline engine | `packages/ml/src/baseline_rules.ts` (new) | A-001 | `rulesOnlyDecision()` returns action based on 7 rules
- [ ] **E-002** | P0 | Implement batch evaluation pipeline | `packages/ml/src/evaluate.ts` (new) | A-001, E-001 | `pnpm evaluate` produces held-out comparison report
- [ ] **B-001** | P0 | Add ablation flag to recover.ts | `packages/ml/src/recover.ts` | A-001, E-001 | `--ablation` outputs rules vs ML comparison
- [ ] **B-002** | P0 | Add held-out evaluation | `packages/ml/src/evaluate.ts` | E-002 | Train/test split with stratification
- [ ] **B-003** | P0 | Add bootstrap CIs | `packages/ml/src/recovery.ts`, `evaluate.ts` | E-002 | Every metric has 95% CI

### Phase 3: Honest Reporting (Day 3)

- [ ] **B-004** | P1 | Document negative results | `README.md`, pitch deck | None | At least 2 documented failures
- [ ] **B-005** | P1 | Add cost-per-recovered-rupee | `packages/ml/src/recovery.ts` | A-001 | `COST/100 RECOVERED: Rs.X.XX`
- [ ] **E-004** | P1 | Add per-failure-class breakdown | `packages/ml/src/recovery.ts` | A-001 | Report shows per-class metrics
- [ ] **E-005** | P1 | Add per-intervention breakdown | `packages/ml/src/recovery.ts` | A-001 | Report shows per-intervention metrics
- [ ] **A-003** | P1 | Remove federated learning from pitch | `packages/ml/src/federation.ts` | None | Demo/pitch does not reference federated
- [ ] **D-008** | P2 | Mark cross-PSP as future direction | pitch deck | None | Demo does not execute cross-PSP

### Phase 4: Demo Prep (Day 4)

- [ ] **I-001** | P0 | Write demo script for batch processing | Demo script | Phases 1-3 | Demo completes in <3 minutes
- [ ] **I-002** | P1 | Add real Razorpay test-mode API call to demo | `packages/core/src/executor/providers/razorpay.ts` | B-006 | Demo shows real Payment Link URL
- [ ] **I-003** | P1 | Ensure all demo numbers from real execution | Demo script | A-001 | No hardcoded numbers in demo
- [ ] **I-004** | P1 | Include negative result in demo | Demo script | B-004 | Demo shows what didn't work
- [ ] **H-001** | P1 | Add batch report to dashboard | `app/views/dashboard.html`, `app/server.ts` | E-002 | Dashboard shows batch recovery metrics

### Phase 5: Cleanup (Day 4, if time)

- [ ] **D-001** | P1 | Remove dead simulation.ts | `packages/core/src/executor/providers/simulation.ts` | None | No imports of simulation.ts
- [ ] **A-004** | P1 | Graceful LIVE mode fallback | `razorpay.ts:244-249` | None | Warning instead of throw
- [ ] **A-005** | P1 | Fix dry-run multiplier logic | `razorpay.ts:231-234` | None | Mock outcomes match catalog
- [ ] **A-008** | P1 | Fix or disable no-op webhook verification | 4 provider files | None | All webhooks verified or documented
- [ ] **A-006** | P1 | Fix editProposal feature version mismatch | `pipeline.ts:402-406` | None | Old proposals editable
- [ ] **D-002** | P2 | Remove bankRailHealth = 1.0 dead feature | `features.ts:306` | None | Feature vector has 22 dimensions
- [ ] **A-015** | P2 | Fix README 16D to 23D | `README.md:24` | None | README matches code

### Phase 6: Hardening (If time permits)

- [ ] **B-007** | P2 | Add multi-tenant tests | `tests/integration/` | None | Cross-tenant isolation verified
- [ ] **B-008** | P2 | Add concurrent access tests | `tests/integration/` | None | Race conditions handled
- [ ] **F-001** | P1 | Add PaymentIntent safety integration tests | `tests/integration/` | None | No double-debit in any scenario
- [ ] **F-002** | P1 | Add reconciliation worker tests | `tests/integration/` | A-007 | Stale EXECUTING resolved correctly
- [ ] **G-001** | P2 | Add rate limiting | `app/server.ts` | None | 429 on excess requests
- [ ] **C-004** | P2 | Add structured logging | `packages/shared/src/logger.ts` (new) | None | No raw console.log
- [ ] **E-003** | P1 | Add sensitivity analysis | `packages/ml/src/evaluate.ts` | E-002 | Recovery stable across perturbations

---

**Total tasks: 68**
**P0 (Must fix): 8**
**P1 (Major improvement): 27**
**P2 (Useful improvement): 25**
**P3 (Optional): 8**

**Estimated time for Absolute Minimum (P0 only): 3-4 days**
**Estimated time for Strong Submission (P0 + P1): 5-7 days**
**Estimated time for Winning-Level (P0 + P1 + P2): 8-10 days**

---

# SECTION M: EXECUTIVE CODEBASE & STRUCTURAL AUDIT

---

A comprehensive code and architecture audit of the ARBITER codebase reveals a stark contrast: **The core payment lifecycle, SQLite ledger, 23-D feature extraction, error taxonomy (70+ codes), and regulatory policy guardrails are rigorously constructed, but the top-level evaluation and measurement layer relies on synthetic hardcoded arithmetic and stubbed providers.**

```
                                 CURRENT STATE ARCHITECTURE
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ REAL & PRODUCTION-GRADE                                                                │
│ • Razorpay Webhook Ingestion + HMAC Validation (app/server.ts)                        │
│ • 23-D Feature Extractor (packages/ml/src/features.ts)                                 │
│ • Decision Engine & Regulatory Guardrails (packages/core/src/decide/)                 │
│ • SQLite State Machine & Audit Hash Chain (packages/core/src/db/)                     │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ FAKE, STUBBED, OR FABRICATED (FATAL AUDIT RISKS)                                       │
│ ❌ Batch Measurement: Hardcoded Math (app/recovery.ts:893-928)                         │
│ ❌ Executor Determinism: Viable mult > 0 unconditionally SUCCEEDED (executor/index.ts) │
│ ❌ Federated Learning: Random Noise as Local Model Weights (ml/src/federation.ts:123) │
│ ❌ Razorpay Provider: Throws "LIVE mode not implemented" (providers/razorpay.ts:248)  │
│ ❌ TRAI Compliance Counter: Hardcoded Modulo `i % 4 === 0` (app/recovery.ts:928)       │
│ ❌ No Held-out Eval / No Ablation Study / No 95% Bootstrap Confidence Intervals        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

# SECTION N: HARDCODED VS. DYNAMIC LOGIC AUDIT

---

| File & Line Reference | Item Description | Current Value | Verdict | Required Remediation |
| :--- | :--- | :--- | :--- | :--- |
| `app/recovery.ts:897` | Control arm recovery rate | `amount * 0.22` | **REMOVE** | Replace with `MockRazorpayProvider` scenario execution. |
| `app/recovery.ts:913` | ARBITER recovery rate | `amount * expectedRecoveryRate` | **REMOVE** | Replace with actual proposal execution and scenario response. |
| `app/recovery.ts:928` | Quiet hours avoidance counter | `i % 4 === 0` | **REMOVE** | Evaluate `occurred_at_utc` against IST quiet window (21:00–09:00). |
| `packages/ml/src/federation.ts:123` | Silo local model weights | `(rng.next() - 0.5) * 0.2` | **ISOLATE** | Replace with local dataset SGD training or isolate as simulation. |
| `packages/core/src/executor/index.ts:98` | Deterministic action success | `mult > 0 -> SUCCEEDED` | **GENERALIZE** | Execute through `ActionProvider` with probabilistic/scenario outcomes. |
| `packages/core/src/executor/providers/razorpay.ts:248` | Live execution check | Throws Error | **CONFIGURE** | Connect to Razorpay test-mode API using `RZP_TEST_KEY_ID`. |
| `app/server.ts:77` | Public base URL fallback | `http://localhost:3000` | **CONFIGURE** | Validate against `process.env.PUBLIC_BASE_URL` with deployment warning. |
| `packages/core/src/decide/catalog.ts:45-75` | Action multiplier lookup table | Static float matrix | **KEEP** | Essential domain knowledge representation for EV engine. |

---

# SECTION O: DEAD CODE AND SUPERFLUOUS COMPONENTS

---

1. **`packages/ml/src/narrative.ts`**: Generates synthetic LLM-like explanations for decisions. Redundant because the decision engine already provides deterministic `rationale` strings in `decide/engine.ts`. **Action:** Delete file.
2. **Unused Test Scripts in Root**: Old temporary test scripts (`p7_harness.mjs` in `packages/measurement/`) that are not wired into Vitest. **Action:** Integrate into Vitest or remove.
3. **Simulated Gupshup Voice Integration**: `packages/core/src/messaging/` contains voice payload formatters that do not connect to telephony gateways. **Action:** Clearly re-label as "Multimodal Payload Formatter" and remove claims of live voice telephony.

---

# SECTION P: PAYMENT STATE MACHINE & FINANCIAL CORRECTNESS

---

```
                        PAYMENT RECOVERY STATE TRANSITIONS

       [ PAYMENT_FAILED ] ── (Webhook / Ingestion)
               │
               ▼
       [ DIAGNOSED ] ──────── (Error Taxonomy / 23-D Features)
               │
               ▼
       [ DECISION_MADE ] ───── (EV Optimization + Regulatory Policy)
               │
       ┌───────┴──────────────────────────────┐
       ▼                                      ▼
[ AUTO_APPROVED ]                     [ AWAITING_APPROVAL ]
       │                                      │ (Human Review)
       ▼                                      ▼
[ EXECUTING ] ── (Idempotency Claim)    [ APPROVED / REJECTED ]
       │
       ├──────────────────────────────────────┬─────────────────────────┐
       ▼                                      ▼                         ▼
[ SUCCEEDED ]                           [ UNCERTAIN ]             [ FAILED ]
(Settlement Ledger Updated)             (Reconciliation Poller)   (Stopping Rules Applied)
                                              │
                                              ▼
                                    [ RECONCILED_SUCCESS ]
```

### Safety Rules Enforced in State Machine:
1. **Single Settlement Invariant:** Once an intent reaches `SUCCEEDED`, no further retries or link dispatches can be scheduled under any circumstance.
2. **Idempotency Guard:** `idempotencyKey = SHA256(proposalId + modelVersion + policyVersion + actionJson)`. Any duplicate execution attempt with identical key returns cached outcome without provider touch.
3. **Uncertain / Lost-Response Handling:** Network timeouts transition state to `UNCERTAIN`. A background reconciler queries the gateway status before triggering any secondary collection.

---

# SECTION Q: AI / ML JUSTIFICATION & ABLATION ARCHITECTURE

---

To conclusively prove the necessity of the AI pipeline to judges, the system must benchmark three distinct decision architectures on the exact same dataset:

```
                                 3-ARM EVALUATION MATRIX

   Input Event Batch (200 Failed Transactions: Cards, UPI, Netbanking, Mandates)
                                        │
             ┌──────────────────────────┼──────────────────────────┐
             ▼                          ▼                          ▼
     [ ARM 0: CONTROL ]       [ ARM 1: RULEBOOK ]        [ ARM 2: ARBITER ML ]
     • Zero intervention       • 7 Static Rules           • 23-D Feature Vector
     • Natural recovery only   • Immediate retries        • Logistic Regression Scorer
     • No outreach             • Fixed channel map        • LTV-Weighted EV Maximizer
             │                          │                          │
             ▼                          ▼                          ▼
   [ Measured Recovery ]      [ Measured Recovery ]      [ Measured Recovery ]
        ~15 - 22%                  ~30 - 36%                  ~42 - 51%
             │                          │                          │
             └──────────────────────────┴──────────────────────────┘
                                        │
                                        ▼
                   [ Statistical Significance & Lift Analysis ]
                   • Delta Lift: +X.X pp over Rules
                   • Bootstrap 95% Confidence Intervals
                   • Cost-per-Recovered-Rupee: ₹Y / ₹100
```

### The 7-Rule Baseline Definition (`rules_baseline.ts`):
1. `HARD_METHOD_DEAD` → Dispatch Alternate Payment Link immediately.
2. `SOFT_RETRYABLE` + Current Day ∈ [28, 5] → Retry payment immediately.
3. `SOFT_RETRYABLE` + Current Day ∉ [28, 5] → Schedule retry for upcoming 1st of month.
4. `NETWORK_TIMEOUT` → Retry in 2 hours.
5. `RISK_FLAGGED` → Escalate to human review.
6. Prior Attempts ≥ 3 → Terminate workflow (Stopping Rule).
7. Current Time in Quiet Hours (21:00–09:00 IST) → Defer outreach.

---

# SECTION R: FINAL LIVE DEMONSTRATION FLOW

---

The live evaluation demo must execute seamlessly within a 5-minute judge review window:

```
                               5-MINUTE JUDGE DEMO FLOW

0:00 ── 0:45    [ THE PROBLEM & ARCHITECTURE ]
                • Show live failure event arriving via Razorpay Webhook.
                • Display error classification (70+ catalog taxonomy).
                • Highlight 23-D feature extraction & regulatory guardrails.


0:45 ── 2:30    [ BATCH RECOVERY BENCHMARK (THE CENTERPIECE) ]
                • Trigger 100-payment batch across Arm 0 (Control), Arm 1 (Rules), Arm 2 (ML).
                • Live visual update: Recovered ₹, Escalated ₹, Stopped ₹.
                • Highlight statistically verified lift (+X.X pp) and 95% CIs.


2:30 ── 3:30    [ REGULATORY & SAFETY GATES ]
                • Demonstrate policy refusal on quiet-hour violation (IST 22:30).
                • Demonstrate human escalation on high-risk fraud failure.
                • Inspect SHA-256 hash-chained audit ledger.


3:30 ── 4:15    [ REAL TEST-MODE PAYMENT RECOVERY ]
                • Generate real Razorpay test-mode Payment Link.
                • Complete payment in test mode; show webhook settlement update on dashboard.


4:15 ── 5:00    [ HONESTY & NEGATIVE RESULTS ]
                • Present "What We Tried That Did Not Work" (LLM zero-delta, issuer health).
                • Summarize unit economics: ₹0.XX cost per ₹100 recovered.
```

---

# SECTION S: IMPLEMENTATION DEPENDENCY GRAPH (UPDATED)

---

```
                            DEPENDENCY ORDERING

    [ Phase 1: Core Grounding & Gateway ]
    ├── P0-BAT-01 (Wire MockRazorpayProvider to Batch Engine)
    └── P0-RZP-03 (Implement Real Test-Mode Payment Link API)
              │
              ▼
    [ Phase 2: Regulatory & Baseline Engines ]
    ├── P0-TRA-05 (Fix IST Quiet Hours Evaluation)
    └── P0-ABL-02 (Implement 7-Rule Baseline & Ablation Harness)
              │
              ▼
    [ Phase 3: Statistical Rigor & Data Splits ]
    ├── P1-EVAL-06 (70/30 Train/Test Split & 95% Bootstrap CIs)
    └── P1-COST-07 (Unit Economics & Cost Tracking)
              │
              ▼
    [ Phase 4: UI Telemetry & Hygiene ]
    ├── P0-FED-04 (Isolate/Purge Fake Federated Learning)
    ├── P2-UI-09 (Interactive Dashboard Benchmark Console)
    ├── P1-NEG-08 (Document Negative Results in README)
    └── P3-CLN-10 (Clean Dead Code & Unused Modules)
```

---

# SECTION T: CONSOLIDATED MASTER IMPLEMENTATION CHECKLIST (UPDATED)

---

- [ ] **`[P0-BAT-01]` Wire Deterministic Provider to Batch Evaluator**
  - **Files:** `app/recovery.ts`, `packages/ml/src/recovery.ts`, `packages/trial/src/provider.ts`
  - **Dependency:** None
  - **Acceptance Criteria:** Remove all hardcoded recovery multipliers (`0.22`, `0.85`). Execute all batch proposals through `MockRazorpayProvider` and record actual outcomes in the SQLite ledger.

- [ ] **`[P0-ABL-02]` Implement 3-Arm Ablation Harness**
  - **Files:** `packages/core/src/decide/rules_baseline.ts`, `packages/ml/src/recover.ts`, `app/recovery.ts`
  - **Dependency:** `P0-BAT-01`
  - **Acceptance Criteria:** Implement 7-rule deterministic engine. Output side-by-side recovery metrics for Control, Rules, and ARBITER ML with bootstrap 95% CIs.

- [ ] **`[P0-RZP-03]` Implement Razorpay Test-Mode Payment Links API**
  - **Files:** `packages/core/src/executor/providers/razorpay.ts`
  - **Dependency:** None
  - **Acceptance Criteria:** Replace `throw Error` with live HTTP POST to `/v1/payment_links` using `RZP_TEST_KEY_ID`. Store returned `plink_xxx` in proposal record.

- [ ] **`[P0-TRA-05]` Real IST Quiet-Hours Time Evaluation**
  - **Files:** `app/recovery.ts`, `packages/core/src/decide/policy.ts`, `packages/core/src/decide/window.ts`
  - **Dependency:** None
  - **Acceptance Criteria:** Remove `i % 4 === 0`. Parse event timestamps in Asia/Kolkata timezone and enforce policy suppression between 21:00 and 09:00 IST.

- [ ] **`[P0-FED-04]` Isolate or Purge Random Federated Learning**
  - **Files:** `packages/ml/src/federation.ts`, `packages/ml/src/federate.ts`, `README.md`
  - **Dependency:** None
  - **Acceptance Criteria:** Eliminate claims of live privacy-preserving federated learning or implement real local gradient descent. Remove random weight generation from pitch.

- [ ] **`[P1-EVAL-06]` Implement 70/30 Stratified Held-Out Evaluation**
  - **Files:** `packages/ml/src/train.ts`, `packages/ml/src/metrics.ts`, `packages/ml/src/dataset.ts`
  - **Dependency:** `P0-BAT-01`
  - **Acceptance Criteria:** Partition training corpus into 70% train and 30% held-out test split. Compute AUC, Brier score, and recovery generalization metrics on unseen data.

- [ ] **`[P1-COST-07]` Unit Economics & Cost-per-Recovered-Rupee Engine**
  - **Files:** `packages/ml/src/recovery.ts`, `app/recovery.ts`, `app/views/dashboard.html`
  - **Dependency:** `P0-BAT-01`
  - **Acceptance Criteria:** Track communication expenses (SMS @ ₹0.25, Email @ ₹0.10) and compute net recovery yield per ₹100 recovered.

- [ ] **`[P1-NEG-08]` Publish "What We Tried That Did Not Work"**
  - **Files:** `docs/what-broke.md`, `README.md`
  - **Dependency:** None
  - **Acceptance Criteria:** Document empirical findings on LLM zero-delta for classification, uncalibrated issuer health monitoring, and local silo variance.

- [ ] **`[P2-UI-09]` Add Interactive Batch Benchmark Panel to Dashboard**
  - **Files:** `app/views/dashboard.html`, `app/server.ts`
  - **Dependency:** `P0-BAT-01`, `P0-ABL-02`
  - **Acceptance Criteria:** Dashboard includes a 1-click button triggering the 100-payment benchmark with real-time comparative bar charts.

- [ ] **`[P3-CLN-10]` Remove Dead Code and Narrative Generator**
  - **Files:** `packages/ml/src/narrative.ts`, `packages/ml/src/index.ts`
  - **Dependency:** None
  - **Acceptance Criteria:** Delete unused narrative generator and verify clean `pnpm typecheck` and `pnpm test` passes across the workspace.
