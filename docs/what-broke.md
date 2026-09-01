# What Broke — ARBITER Engineering Log

> Every surprise that produced a fix, a revert, or a lesson. No entry is skipped.
> All demo numbers are measured from MockRazorpayProvider and labeled `[SIMULATED - MOCK PROVIDER]`.

---

## 1. LLM for root-cause diagnosis — zero delta

- **Symptom:** Tested LLM classification of `failure_code → root_cause` vs rule-based taxonomy. Accuracy identical on synthetic corpus (both ~100% on 70+ codes).
- **Cause:** Synthetic error codes are already normalized; LLM added latency (2s) and cost ($0.02/event) with no signal gain. Matches Reflex's public admission of LLM zero-delta on structured codes.
- **Fix:** Removed LLM from pipeline; kept deterministic `error-catalog.ts` + `diagnosis.ts`.
- **Lesson:** LLM for structured classification is overhead without messy free-text errors.

## 2. Rail health signal — too noisy to be actionable

- **Symptom:** Added `bank_rail_health_norm` feature (simulated score 0..1, deferred retries when <0.4). Batch experiments showed no measurable impact on recovery timing or rate.
- **Cause:** Simulated health is uncorrelated with actual issuer outages; signal-to-noise too low to threshold.
- **Fix:** Removed from default 22-D vector (kept as opt-in `features.ts` flag, not in policy). See `features.ts:306` history.
- **Lesson:** Don't ship a feature that can't be measured to move the metric.

## 3. Federated learning — random silo weights

- **Symptom:** Implemented FedAvg with DP noise across merchant silos (`federation.ts:123` `(rng.next() - 0.5) * 0.2` as fake local weights). Aggregated model was random.
- **Cause:** Simulated local training has no real gradients — weights are noise, aggregation amplifies variance.
- **Fix:** Documented as simulation for demo; removed from production pitch and closed the silo-variance narrative in README.
- **Lesson:** A simulation is not a moat — it must use real local SGD to claim privacy-preserving learning.

## 4. WhatsApp / voice outreach — DLT & opt-in blocked

- **Symptom:** Gupshup (WhatsApp) and Twilio (voice) provider tests passed in unit, but end-to-end requires live customer opt-in and DLT template approval (India).
- **Cause:** Without live merchant data, template approval and opt-in cannot be demonstrated.
- **Fix:** Kept provider abstraction (`packages/core/src/messaging/providers/*`) but scoped primary channels to SMS (MSG91) + Email (Brevo) only.
- **Lesson:** A channel that can't be demo'd end-to-end should not be the hero of the pitch.

## 5. Hardcoded batch rates were fabricated

- **Symptom:** Initial `app/recovery.ts:893` used `amount * 0.22` (control) and `amount * expectedRecoveryRate` (arbiter) — pure arithmetic, not provider outcomes. Demo showed lift but numbers were not measured.
- **Cause:** No provider execution in the batch harness; metrics were arithmetic, not settlement results.
- **Fix:** Wired `MockRazorpayProvider` (A-001/C-001) into batch loop; every event executes `provider.charge()` and `outcomeFromStatus()` is recorded. Reports now show measured money.
- **Lesson:** "Measured money recovered" must come from a provider execution path, not `mult * amount`.

## 6. QUIET_HOURS blocked every contact action in batch

- **Symptom:** Batch report had `contactsAvoidedInQuietHours = 0` and all contact actions blocked by policy `QUIET_HOURS` constraint.
- **Cause:** Synthetic event timestamp `1735689600000` was 05:30 IST — inside 21:00–09:00 quiet window. All contact actions refused.
- **Fix:** Shifted deterministic `nowMs` to `1735740000000` (19:30 IST, outside quiet hours). See `recovery.ts:880`.
- **Lesson:** Fixed synthetic timestamps must be outside guardrail windows, or every benchmark is silently suppressed.

## 7. `editProposal` frozen-vector check failed on version bump

- **Symptom:** After `FEATURE_VERSION` bump `feat-v1` → 23D→22D, editing old proposals failed: frozen vector `a` had 23 dims, recomputed `b` had 22.
- **Cause:** Strict `vectorJson` equality check in `features_store.ts` compared arrays of different lengths without version gate.
- **Fix:** Added `prop.feature_version === FEATURE_VERSION` guard in `pipeline.ts:402`; mismatched versions skip comparison and re-save.
- **Lesson:** Feature-versioning must be explicit in the persistence layer, not just in the model artifact.

---

*Updated 2026-09-01 — covers Sections A through I.*
