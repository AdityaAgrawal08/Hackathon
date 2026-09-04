# Phase 1: Customer Behavioral Memory & Schema Migration — Implementation Plan

**Objective:** Implement longitudinal customer behavioral memory in SQLite (`customer_profiles`) and the `BehavioralProfiler` module to transform recovery routing into an intelligent, adaptive engine. Completely eliminate the "payday" assumption on low balance, replacing it with smart alternate account and retry-later recommendations.

---

## 1. Context & Problem Statement

### The Problem
Traditional recovery bots treat every payment failure identically:
- If an email is sent, they don't know whether the customer reads emails in 2 minutes or 14 hours.
- If a customer fails due to low balance, naive systems either blast generic retries or assume a salary date.
- There is no persistent memory across transactions of customer payment instrument affinity (UPI vs Card), price sensitivity, or channel conversion history.

### The Solution: ARBITER Behavioral Memory
We upgrade the customer memory layer so ARBITER learns:
1. **Responsiveness Velocity**: Moving average open latency ($t_{\text{open}}$). High velocity customers get priority queue slots.
2. **Channel Affinity**: Track `historical_open_rate` and `historical_click_rate` across Email and SMS.
3. **Alternate Account Conversion**: Track if the customer successfully converted via an alternate bank account or secondary UPI app when hit with `INSUFFICIENT_FUNDS`.
4. **Merchant Domain Configuration**: Store per-merchant business context (`D2C_ECOMMERCE`, `SAAS_MANDATES`, `B2B_INVOICES`, `HIGH_TICKET`) with tailored cart reservations and concession limits.

---

## 2. Detailed Architecture & Database Schema

### A. SQLite Migration: `0022_behavioral_intelligence.sql`
```sql
-- Migration 0022: Customer Behavioral Memory & Merchant Domain Context
ALTER TABLE customer_profiles ADD COLUMN preferred_channel TEXT DEFAULT 'AUTO' CHECK(preferred_channel IN ('EMAIL', 'SMS', 'AUTO'));
ALTER TABLE customer_profiles ADD COLUMN email_open_latency_mins REAL DEFAULT NULL;
ALTER TABLE customer_profiles ADD COLUMN historical_open_rate REAL NOT NULL DEFAULT 0.0;
ALTER TABLE customer_profiles ADD COLUMN historical_click_rate REAL NOT NULL DEFAULT 0.0;
ALTER TABLE customer_profiles ADD COLUMN payment_method_affinity TEXT DEFAULT 'upi';
ALTER TABLE customer_profiles ADD COLUMN ticket_sensitivity_score REAL NOT NULL DEFAULT 0.0;
ALTER TABLE customer_profiles ADD COLUMN alternate_account_converted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customer_profiles ADD COLUMN avg_recovery_latency_hours REAL DEFAULT NULL;
ALTER TABLE customer_profiles ADD COLUMN total_recovered_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customer_profiles ADD COLUMN patience_score REAL NOT NULL DEFAULT 0.5;
ALTER TABLE customer_profiles ADD COLUMN last_engaged_channel TEXT DEFAULT NULL;
ALTER TABLE customer_profiles ADD COLUMN last_engaged_at_utc TEXT DEFAULT NULL;

CREATE TABLE IF NOT EXISTS merchant_domain_configs (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  domain_type TEXT NOT NULL DEFAULT 'D2C_ECOMMERCE' CHECK(domain_type IN ('D2C_ECOMMERCE', 'SAAS_MANDATES', 'B2B_INVOICES', 'HIGH_TICKET')),
  cart_reservation_mins INTEGER NOT NULL DEFAULT 15,
  max_discount_concession_bp INTEGER NOT NULL DEFAULT 500,
  soft_lock_grace_days INTEGER NOT NULL DEFAULT 3,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_custprofile_channel ON customer_profiles(preferred_channel);
CREATE INDEX IF NOT EXISTS idx_custprofile_velocity ON customer_profiles(email_open_latency_mins);
```

### B. Drizzle Schema Updates (`packages/core/src/db/schema.ts`)
- Update `customerProfiles` table definition with the 12 new behavioral columns.
- Export `merchantDomainConfigs` table definition with type safety.

### C. Behavioral Profiler Module (`packages/core/src/agent/behavioral_profiler.ts`)
Exposes:
- `recordEmailOpened(profileId, openLatencyMins, client)`: Updates moving average latency, increments open count, updates `historical_open_rate`.
- `recordLinkClicked(profileId, channel, client)`: Elevates click rate, sets `last_engaged_channel` and `last_engaged_at_utc`.
- `recordDeliveryStatus(profileId, channel, status, client)`: If SMS returns DND/failed, adjusts `preferred_channel = 'EMAIL'`.
- `recordRecoveryCompleted(profileId, amountPaise, latencyHours, usedAlternateAccount, client)`: Updates `total_recovered_paise`, `avg_recovery_latency_hours`, and `alternate_account_converted`.
- `computeCustomerPriority(profile, amountPaise, domainType)`: Calculates dynamic priority score and priority tier (`TIER_1_CRITICAL`, `TIER_2_HIGH`, `TIER_3_SCHEDULED`, `TIER_4_SUPPRESSED`).

---

## 3. Step-by-Step Implementation TODO List

- [ ] **Step 1: Write Migration `0022_behavioral_intelligence.sql`**
  - Define all ALTER TABLE statements and table creation with strict SQLite constraints.
- [ ] **Step 2: Update Drizzle ORM Schema (`packages/core/src/db/schema.ts`)**
  - Add behavioral fields to `customerProfiles` and define `merchantDomainConfigs`.
- [ ] **Step 3: Implement `packages/core/src/agent/behavioral_profiler.ts`**
  - Implement full mathematical EMA (exponential moving average) for open latency.
  - Implement dynamic priority score formula:
    $$\text{Score} = \text{EV} \times \omega_{\text{velocity}} \times \omega_{\text{domain}} \times (1.0 - \text{ChurnRisk})$$
  - Add explicit handling for `INSUFFICIENT_FUNDS` recommending alternate account / switch UPI, zero payday logic.
- [ ] **Step 4: Export from `packages/core/src/index.ts`**
  - Re-export the new types and functions.
- [ ] **Step 5: Write Comprehensive Unit & Integration Tests**
  - `tests/core/customer_behavioral_profiler.test.ts`: Test EMA latency calculation, priority tier assignment, alternate account conversion, and channel fallback.
  - `tests/core/merchant_domain_config.test.ts`: Test tenant configuration CRUD and domain-specific rules.
- [ ] **Step 6: CLI & Web Invariant Verification**
  - Run `pnpm -r typecheck` to guarantee zero compilation errors.
  - Run `pnpm test` across all 118+ test suites to verify zero regressions.
  - Test SQLite migration idempotent execution on test database.
