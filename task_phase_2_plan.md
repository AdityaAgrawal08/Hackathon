# Phase 2: SMS Provider Overhaul (MSG91 Flow + Brevo Multi-Rail Fallback) — Implementation Plan

**Objective:** Deliver an enterprise-grade, 100% reliable SMS messaging pipeline for ARBITER by fixing critical MSG91 Flow API bugs, injecting dual variable dictionaries (positional + semantic), implementing a native Brevo Transactional SMS fallback provider, and wiring automatic multi-rail cascading in `OutreachRouter`.

---

## 1. Problem Statement & Root Cause Analysis

### The Critical Bugs in MSG91 Today
1. **Silent False-Positive Bug (`msg91.ts:141`)**:
   ```typescript
   const isSuccess = data.type === "success" || res.ok;
   ```
   When MSG91 returns HTTP 200 with `{"type": "error", "message": "Invalid template id"}` or `{"errors": [...]}`:
   `res.ok` is `true`, causing the application to falsely record the SMS as `SENT` when the carrier never dispatched it!
2. **Missing Sender Header in Flow API**:
   The MSG91 Flow API v5 requires `"sender": "ARBITR"` in the request JSON root. Its absence leads to fallback to default promotional headers or rejection in strict DLT routing.
3. **Flow ID vs DLT ID Mismatch**:
   `.env.example` specified `MSG91_FLOW_ID`, but `msg91.ts` only read `MSG91_TEMPLATE_ID`. If a 19-digit DLT numerical ID was passed to the Flow endpoint instead of the 24-char hex Flow ID, the call failed with `400: Template not found`.
4. **Variable Placeholder Mismatch**:
   Indian DLT Flow templates often register variables as positional tokens (`##var1##`, `##var2##`, `##1##`) rather than semantic tokens (`##name##`, `##amount##`).
5. **Lack of SMS Multi-Rail Redundancy**:
   If MSG91 fails (insufficient credits, DND rejection, carrier switch downtime), there was no secondary SMS rail, causing immediate communication loss.

---

## 2. Architectural Solution

### Pillar 1: Hardened MSG91 Flow Provider
- Support `MSG91_FLOW_ID` (with fallback to `MSG91_TEMPLATE_ID`).
- Root level `"sender": this.config.senderId || "ARBITR"`.
- Dual variable dictionary injecting both semantic (`name`, `amount`, `url`, `merchant`) and positional tokens (`VAR1`..`VAR4`, `var1`..`var4`, `1`..`4`).
- Strict validation: `const isSuccess = res.ok && data.type !== "error" && !data.errors;`.

### Pillar 2: Brevo Transactional SMS Provider (`BrevoSmsProvider`)
- Native integration with Brevo SMS API:
  - `POST https://api.brevo.com/v3/transactionalSMS/send`
  - Headers: `api-key: process.env.BREVO_API_KEY`, `Content-Type: application/json`
  - Body:
    ```json
    {
      "sender": "ARBITER",
      "recipient": "919876543210",
      "content": "Payment of ₹1,999.00 failed due to low balance. Switch bank account or complete here: https://arbiter.live/r/tok123",
      "type": "transactional"
    }
    ```
- Simulated dry-run mode when `BREVO_API_KEY` is not present in local test environments.

### Pillar 3: Multi-Rail Cascading Router
- Primary: `MSG91` (Flow SMS).
- Secondary: `Brevo SMS` (Transactional SMS fallback).
- Tertiary: `Brevo Email` (Direct cascade if SMS is completely unreachable or blocked by DND).

---

## 3. Step-by-Step Implementation TODO List

- [ ] **Step 1: Refactor `packages/core/src/messaging/providers/msg91.ts`**
  - Fix `isSuccess` condition.
  - Add `MSG91_FLOW_ID` support and root `sender`.
  - Inject positional `VAR1`..`VAR4` + semantic keys.
- [ ] **Step 2: Implement `packages/core/src/messaging/providers/brevo_sms.ts`**
  - Implement `BrevoSmsProvider` with `OutreachProvider` interface.
  - Normalization of Indian mobile numbers.
  - Robust error handling and simulation fallback.
- [ ] **Step 3: Update `OutreachRouter` (`packages/core/src/messaging/router.ts`)**
  - Add `brevo_sms` provider registration.
  - Implement `dispatchWithCascade(channel, payload)` to automatically attempt secondary SMS before failing.
- [ ] **Step 4: Export Brevo SMS Provider from Core Index**
  - Re-export `BrevoSmsProvider` from `packages/core/src/messaging/index.ts`.
- [ ] **Step 5: Write Comprehensive Test Suites**
  - `tests/core/msg91_provider_hardened.test.ts`: Verify false-positive fix, variable injection, and Flow ID resolution.
  - `tests/core/brevo_sms_provider.test.ts`: Verify Brevo SMS payload, header formatting, and simulation mode.
  - `tests/core/outreach_cascading.test.ts`: Verify multi-rail failover from MSG91 to Brevo SMS to Email.
- [ ] **Step 6: CLI & Invariant Verification**
  - Run `pnpm -r typecheck`.
  - Run `pnpm test` across all suites to ensure 100% green status.
