/**
 * ARBITER schema v2 — canonical data model.
 * Invariants encoded here:
 *   I-4 audit_log is append-only (app layer never UPDATE/DELETEs; no FK cascades into it)
 *   I-5 money columns are INTEGER paise
 *   I-6 timestamps are ISO-8601 UTC strings
 * Provenance: proposals reference model_versions + policy_version; approvals are
 * first-class rows; actions carry idempotency keys (I-2).
 */
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/* ── tenants & customers ─────────────────────────────────────────── */

export const tenants = sqliteTable("tenants", {
  id: text("id").primaryKey(), // e.g. "demo"
  name: text("name").notNull(),
  /** Versioned auto-approve envelope JSON (fail-closed parse, P4-B3) */
  autonomyEnvelopeJson: text("autonomy_envelope_json").notNull().default("{}"),
  policyVersion: text("policy_version").notNull().default("v1"),
  createdAtUtc: text("created_at_utc").notNull(),
});

export const customers = sqliteTable(
  "customers",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    pseudoName: text("pseudo_name").notNull(),
    phoneFake: text("phone_fake").notNull(),
    emailFake: text("email_fake").notNull(),
    /** Histogram JSON of successful debit day-of-month (payday inference input) */
    paydayPatternJson: text("payday_pattern_json").notNull().default("{}"),
    /** Generator ground-truth salary day (eval target for inference, TRAINING seeds) */
    paydayTrueDay: integer("payday_true_day"),
    /** Successful debits preceding first failure — diagnosis context depth */
    priorSuccessCount: integer("prior_success_count").notNull().default(0),
    channelResponsiveness: real("channel_responsiveness").notNull().default(0.5),
    optedOut: integer("opted_out", { mode: "boolean" }).notNull().default(false),
    joinedAtUtc: text("joined_at_utc").notNull(),
  },
  (t) => [index("idx_customers_tenant").on(t.tenantId)],
);

/* ── events & frozen features ───────────────────────────────────── */

export const paymentEvents = sqliteTable(
  "payment_events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    /**
     * NULL = not yet enriched (webhook arrived, merchant identity unresolved).
     * Enrichment (pipeline entry) backfills it. SQLite partial indexes treat
     * NULLs as distinct, so the one-open-proposal rule applies only to
     * resolved customers — exactly the intended semantics.
     */
    customerId: text("customer_id").references(() => customers.id),
    rzpPaymentId: text("rzp_payment_id"),
    subscriptionId: text("subscription_id"),
    amountPaise: integer("amount_paise").notNull(),
    failureCode: text("failure_code").notNull(),
    failureClassHint: text("failure_class_hint"), // seed hint, NOT trusted by pipeline
    source: text("source", { enum: ["WEBHOOK", "SEED", "TRAINING"] }).notNull(),
    trueOutcomeSeed: real("true_outcome_seed"), // generator truth, TRAINING only
    occurredAtUtc: text("occurred_at_utc").notNull(),
    ingestedAtUtc: text("ingested_at_utc").notNull(),
  },
  (t) => [
    index("idx_events_customer").on(t.customerId),
    index("idx_events_tenant_time").on(t.tenantId, t.occurredAtUtc),
  ],
);

/** Provider event-id dedupe (bug P1-B8): one provider event ⇒ one row. */
export const webhookDedupe = sqliteTable(
  "webhook_dedupe",
  {
    providerEventId: text("provider_event_id").primaryKey(),
    firstSeenUtc: text("first_seen_utc").notNull(),
    swallowCount: integer("swallow_count").notNull().default(0),
  },
);

export const features = sqliteTable(
  "features",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => paymentEvents.id),
    featureVersion: text("feature_version").notNull(),
    vectorJson: text("vector_json").notNull(),
    computedAtUtc: text("computed_at_utc").notNull(),
  },
  (t) => [uniqueIndex("uq_features_event_version").on(t.eventId, t.featureVersion)],
);

/* ── model registry (immutable, P8-B1 prevention) ──────────────── */

export const modelVersions = sqliteTable("model_versions", {
  id: text("id").primaryKey(), // "logreg@1.0.0"
  kind: text("kind").notNull().default("logreg"),
  weightsJson: text("weights_json").notNull(),
  weightsSha256: text("weights_sha256").notNull(),
  datasetSha256: text("dataset_sha256").notNull(),
  featureNamesJson: text("feature_names_json").notNull(),
  metricsJson: text("metrics_json").notNull(), // {auc,brier,calibration:[...]}
  trainedAtUtc: text("trained_at_utc").notNull(),
  status: text("status", { enum: ["CANDIDATE", "INCUMBENT", "RETIRED"] })
    .notNull()
    .default("CANDIDATE"),
});

/* ── proposals & approvals (HITL core) ─────────────────────────── */

export const PROPOSAL_STATES = [
  "PROPOSED",
  "AWAITING_APPROVAL",
  "AUTO_APPROVED",
  "APPROVED",
  "EDITED",
  "REJECTED",
  "CANCELLED",
  "EXECUTING",
  "EXECUTED",
  "FAILED",
] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];

export const proposals = sqliteTable(
  "proposals",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => paymentEvents.id),
    /** Denormalized for the partial unique index below (P5-B8). */
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
    modelVersionId: text("model_version_id")
      .notNull()
      .references(() => modelVersions.id),
    policyVersion: text("policy_version").notNull(),
    actionJson: text("action_json").notNull(),
    evPaise: integer("ev_paise").notNull(),
    confidence: real("confidence").notNull(),
    attributionsJson: text("attributions_json").notNull().default("[]"),
    narrative: text("narrative"),
    state: text("state", { enum: PROPOSAL_STATES }).notNull().default("PROPOSED"),
    stateVersion: integer("state_version").notNull().default(0),
    dedupeKey: text("dedupe_key").notNull(), // event+model+policy (P4-B7)
    featureVersion: text("feature_version").notNull().default("feat-v1"),
    createdAtUtc: text("created_at_utc").notNull(),
    updatedAtUtc: text("updated_at_utc").notNull(),
  },
  (t) => [
    uniqueIndex("uq_proposals_dedupe").on(t.dedupeKey),
    index("idx_proposals_state_ev").on(t.state, t.evPaise),
    /**
     * P5-B8: at most ONE open proposal per customer. Partial unique index on
     * customerId ALONE (not composite with eventId — different events must
     * still collide while both are open); terminal states exempt.
     */
    uniqueIndex("uq_one_open_per_customer").on(t.customerId).where(sql`
      state IN ('PROPOSED','AWAITING_APPROVAL','AUTO_APPROVED','APPROVED','EXECUTING')
    `),
  ],
);

export const approvalRecords = sqliteTable("approval_records", {
  id: text("id").primaryKey(),
  proposalId: text("proposal_id")
    .notNull()
    .references(() => proposals.id),
  actor: text("actor").notNull(), // honest label, demo: merchant@demo
  decision: text("decision", { enum: ["APPROVE", "EDIT", "REJECT"] }).notNull(),
  note: text("note"),
  decidedAtUtc: text("decided_at_utc").notNull(),
});

/* ── execution & ledger ─────────────────────────────────────────── */

export const actions = sqliteTable(
  "actions",
  {
    id: text("id").primaryKey(),
    proposalId: text("proposal_id")
      .notNull()
      .references(() => proposals.id),
    idempotencyKey: text("idempotency_key").notNull(),
    executor: text("executor").notNull(),
    payloadJson: text("payload_json").notNull(),
    rzpRequestRef: text("rzp_request_ref"),
    outcome: text("outcome", { enum: ["PENDING", "SUCCEEDED", "FAILED", "AMBIGUOUS"] })
      .notNull()
      .default("PENDING"),
    executedAtUtc: text("executed_at_utc"),
  },
  (t) => [uniqueIndex("uq_actions_idem").on(t.idempotencyKey)],
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    tsUtc: text("ts_utc").notNull(),
    tenantId: text("tenant_id").notNull(),
    eventId: text("event_id"),
    actor: text("actor").notNull(), // PIPELINE | POLICY | EXECUTOR | MERCHANT | SYSTEM
    entryType: text("entry_type", {
      enum: [
        "TRIGGER",
        "DIAGNOSIS",
        "DECISION",
        "ACTION",
        "OUTCOME",
        "REFUSAL",
        "APPROVAL",
        "DRIFT",
      ],
    }).notNull(),
    payloadJson: text("payload_json").notNull(),
  },
  (t) => [index("idx_audit_event").on(t.eventId), index("idx_audit_type").on(t.entryType)],
);

/* ── promise-to-pay behavioral loop (§4.7) ───────────────────────── */
/** Merchant-scoped promise-to-pay tracking; feeds `promise_kept_rate` feature. */
export const promiseToPay = sqliteTable(
  "promise_to_pay",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
    proposalId: text("proposal_id").notNull(), // originating proposal (no FK: may be an edit)
    eventId: text("event_id")
      .notNull()
      .references(() => paymentEvents.id),
    amountPaise: integer("amount_paise").notNull(),
    promisedAtUtc: text("promised_at_utc").notNull(),
    status: text("status", { enum: ["PENDING", "KEPT", "BROKEN"] })
      .notNull()
      .default("PENDING"),
    resolvedAtUtc: text("resolved_at_utc"),
    createdAtUtc: text("created_at_utc").notNull(),
  },
  (t) => [index("idx_promise_customer").on(t.customerId)],
);

/* ── learning loop ──────────────────────────────────────────────── */

export const driftChecks = sqliteTable("drift_checks", {
  id: text("id").primaryKey(),
  windowStartUtc: text("window_start_utc").notNull(),
  windowEndUtc: text("window_end_utc").notNull(),
  sampleSize: integer("sample_size").notNull(),
  predictedRate: real("predicted_rate").notNull(),
  realizedRate: real("realized_rate").notNull(),
  verdict: text("verdict", { enum: ["OK", "CONTRACTED"] }).notNull(),
  envelopeBeforeJson: text("envelope_before_json").notNull(),
  envelopeAfterJson: text("envelope_after_json").notNull(),
  checkedAtUtc: text("checked_at_utc").notNull(),
});

/* ── measurement runs ───────────────────────────────────────────── */

export const metricsRuns = sqliteTable("metrics_runs", {
  id: text("id").primaryKey(),
  corpusSha: text("corpus_sha").notNull(),
  arm: text("arm", { enum: ["CONTROL", "PIPELINE"] }).notNull(),
  mcIteration: integer("mc_iteration").notNull(),
  recoveredPaise: integer("recovered_paise").notNull(),
  contactsMade: integer("contacts_made").notNull(),
  wastedAttempts: integer("wasted_attempts").notNull(),
  policyRefusals: integer("policy_refusals").notNull(),
  paramsJson: text("params_json").notNull(),
  ranAtUtc: text("ran_at_utc").notNull(),
});

/** Generic single-flight lock for cron jobs (P8-B4). */
export const jobLocks = sqliteTable("job_locks", {
  name: text("name").primaryKey(),
  holder: text("holder").notNull(),
  acquiredAtUtc: text("acquired_at_utc").notNull(),
});

/* ── payment intents (idempotency registry) ─────────────────────── */
/**
 * The critical double-charge guard. A *payment intent* is the stable identity of
 * one customer-initiated collection attempt, independent of how many times the
 * client retries or how many proposals the engine emits. Keyed by the
 * client-supplied idempotency key so a retry (incl. the "provider charged but
 * response lost" case) resolves to the SAME charge — never a second one.
 */
export const PAYMENT_INTENT_STATES = [
  "PROCESSING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "UNKNOWN",
] as const;
export type PaymentIntentState = (typeof PAYMENT_INTENT_STATES)[number];

export const paymentIntents = sqliteTable(
  "payment_intents",
  {
    id: text("id").primaryKey(),
    clientIdemKey: text("client_idem_key").notNull().unique(),
    proposalId: text("proposal_id"),
    customerId: text("customer_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    orderId: text("order_id"),
    checkoutToken: text("checkout_token"),
    amountPaise: integer("amount_paise").notNull(),
    status: text("status", { enum: PAYMENT_INTENT_STATES }).notNull().default("PROCESSING"),
    chargeId: text("charge_id"),
    /** What the CLIENT should see, preserved across idempotent replays. */
    clientVisible: text("client_visible", {
      enum: ["SUCCEEDED", "FAILED", "UNKNOWN", "ALREADY_SUBMITTED", "CANCELLED", "PROCESSING"],
    }).notNull().default("UNKNOWN"),
    scenario: text("scenario"),
    workerClaimId: text("worker_claim_id"),
    claimedAtUtc: text("claimed_at_utc"),
    createdAtUtc: text("created_at_utc").notNull(),
    resolvedAtUtc: text("resolved_at_utc"),
  },
  (t) => [
    index("idx_intent_customer").on(t.customerId),
    index("idx_intent_order").on(t.orderId),
    index("idx_intent_status").on(t.status),
  ],
);

/* ── mock ledger (sandbox balance) ──────────────────────────────── */
/**
 * Sandbox account balance for the trial environment. Debits are idempotent per
 * idempotency key so a retried collection never reduces the balance twice.
 */
export const ledgerEntries = sqliteTable(
  "ledger_entries",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id").notNull(),
    idemKey: text("idem_key").notNull(),
    kind: text("kind", { enum: ["DEBIT", "CREDIT", "HOLD"] }).notNull(),
    amountPaise: integer("amount_paise").notNull(),
    balanceAfterPaise: integer("balance_after_paise").notNull(),
    atUtc: text("at_utc").notNull(),
  },
  (t) => [uniqueIndex("uq_ledger_idem").on(t.idemKey, t.kind), index("idx_ledger_customer").on(t.customerId)],
);

/** Current sandbox balance per customer (denormalized, reconciled from ledger). */
export const accountBalances = sqliteTable("account_balances", {
  customerId: text("customer_id").primaryKey(),
  balancePaise: integer("balance_paise").notNull().default(0),
  updatedAtUtc: text("updated_at_utc").notNull(),
});

/* ── notifications (sandbox outbox) ──────────────────────────────── */
/**
 * Customer-facing messages generated by the recovery flow. Messages are computed
 * from the *simulated* failure (never internal errors / stack traces), so the
 * UI shows a personalized, safe explanation.
 */
export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id").notNull(),
    channel: text("channel", { enum: ["SMS", "WHATSAPP", "VOICE", "EMAIL", "IN_APP"] }).notNull(),
    scenario: text("scenario"),
    message: text("message").notNull(),
    atUtc: text("at_utc").notNull(),
    delivered: integer("delivered", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [index("idx_notif_customer").on(t.customerId)],
);

/* ── checkout sessions (opaque expiring access tokens) ────────────── */
export const checkoutSessions = sqliteTable(
  "checkout_sessions",
  {
    token: text("token").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    orderId: text("order_id").notNull(),
    amountPaise: integer("amount_paise").notNull(),
    currency: text("currency").notNull().default("INR"),
    paymentMode: text("payment_mode").notNull().default("LOCAL_SANDBOX"),
    expiresAtUtc: text("expires_at_utc").notNull(),
    revokedAtUtc: text("revoked_at_utc"),
    createdAtUtc: text("created_at_utc").notNull(),
  },
  (t) => [
    index("idx_checkout_order").on(t.orderId),
    index("idx_checkout_expires").on(t.expiresAtUtc),
  ],
);

/* ── payment attempts (concrete execution attempts) ───────────────── */
export const paymentAttempts = sqliteTable(
  "payment_attempts",
  {
    id: text("id").primaryKey(),
    paymentIntentId: text("payment_intent_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    clientIdemKey: text("client_idem_key").notNull(),
    payloadHash: text("payload_hash").notNull(),
    attemptNumber: integer("attempt_number").notNull().default(1),
    status: text("status").notNull().default("PENDING"),
    scenario: text("scenario"),
    providerPaymentId: text("provider_payment_id"),
    startedAtUtc: text("started_at_utc").notNull(),
    completedAtUtc: text("completed_at_utc"),
  },
  (t) => [
    uniqueIndex("uq_attempt_tenant_idem").on(t.tenantId, t.clientIdemKey),
    index("idx_attempt_intent").on(t.paymentIntentId),
    index("idx_attempt_idem").on(t.clientIdemKey),
  ],
);


/* ── provider payments (durable gateway payment projection) ───────── */
export const providerPayments = sqliteTable(
  "provider_payments",
  {
    id: text("id").primaryKey(),
    providerOrderId: text("provider_order_id").notNull(),
    provider: text("provider").notNull(),
    status: text("status").notNull(),
    amountPaise: integer("amount_paise").notNull(),
    currency: text("currency").notNull().default("INR"),
    errorCode: text("error_code"),
    errorDescription: text("error_description"),
    capturedAtUtc: text("captured_at_utc"),
    createdAtUtc: text("created_at_utc").notNull(),
  },
  (t) => [index("idx_provider_order").on(t.providerOrderId)],
);

/* ── local settlements (single settlement projection) ─────────────── */
export const localSettlements = sqliteTable(
  "local_settlements",
  {
    id: text("id").primaryKey(),
    paymentIntentId: text("payment_intent_id").notNull(),
    idemKey: text("idem_key").notNull(),
    providerPaymentId: text("provider_payment_id").notNull(),
    amountPaise: integer("amount_paise").notNull(),
    currency: text("currency").notNull().default("INR"),
    settledAtUtc: text("settled_at_utc").notNull(),
  },
  (t) => [
    uniqueIndex("uq_settlement_intent").on(t.paymentIntentId),
    uniqueIndex("uq_settlement_idem").on(t.idemKey),
  ],
);

/* ── webhook inbox events (async webhook buffer) ─────────────────── */
export const inboxEvents = sqliteTable(
  "inbox_events",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    eventType: text("event_type").notNull(),
    payloadJson: text("payload_json").notNull(),
    payloadHash: text("payload_hash").notNull(),
    status: text("status").notNull().default("PENDING"),
    receivedAtUtc: text("received_at_utc").notNull(),
    processedAtUtc: text("processed_at_utc"),
  },
  (t) => [index("idx_inbox_status").on(t.status)],
);

/* ── live customer profiles (real payment workflow) ──────────────── */
/**
 * Persistent customer profiles for the real payment workflow.
 * Tracks payment history, risk scores, and vendor decisions across sessions.
 */
export const customerProfiles = sqliteTable(
  "customer_profiles",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    phone: text("phone").notNull().unique(),
    email: text("email").notNull(),
    createdAtUtc: text("created_at_utc").notNull(),
    totalAttempts: integer("total_attempts").notNull().default(0),
    totalSuccesses: integer("total_successes").notNull().default(0),
    totalFailures: integer("total_failures").notNull().default(0),
    lastFailureCode: text("last_failure_code"),
    lastFailureAtUtc: text("last_failure_at_utc"),
    flaggedAsSuspicious: integer("flagged_as_suspicious", { mode: "boolean" }).notNull().default(false),
    vendorDecision: text("vendor_decision", { enum: ["approved", "rejected"] }),
    riskScoreBp: integer("risk_score_bp").notNull().default(0),
    totalAmountPaise: integer("total_amount_paise").notNull().default(0),
    optedOut: integer("opted_out", { mode: "boolean" }).notNull().default(false),
    // Longitudinal Behavioral Intelligence columns (Migration 0022)
    preferredChannel: text("preferred_channel", { enum: ["EMAIL", "SMS", "AUTO"] }).default("AUTO"),
    emailOpenLatencyMins: real("email_open_latency_mins"),
    historicalOpenRate: real("historical_open_rate").notNull().default(0.0),
    historicalClickRate: real("historical_click_rate").notNull().default(0.0),
    paymentMethodAffinity: text("payment_method_affinity").default("upi"),
    ticketSensitivityScore: real("ticket_sensitivity_score").notNull().default(0.0),
    alternateAccountConverted: integer("alternate_account_converted", { mode: "boolean" }).notNull().default(false),
    avgRecoveryLatencyHours: real("avg_recovery_latency_hours"),
    totalRecoveredPaise: integer("total_recovered_paise").notNull().default(0),
    patienceScore: real("patience_score").notNull().default(0.5),
    lastEngagedChannel: text("last_engaged_channel"),
    lastEngagedAtUtc: text("last_engaged_at_utc"),
  },
  (t) => [
    index("idx_custprofile_phone").on(t.phone),
    index("idx_custprofile_suspicious").on(t.flaggedAsSuspicious),
    index("idx_custprofile_channel").on(t.preferredChannel),
    index("idx_custprofile_velocity").on(t.emailOpenLatencyMins),
  ],
);

/* ── merchant domain configuration (business context engine) ────── */
export const DOMAIN_TYPES = [
  "D2C_ECOMMERCE",
  "SAAS_MANDATES",
  "B2B_INVOICES",
  "HIGH_TICKET",
] as const;
export type DomainType = (typeof DOMAIN_TYPES)[number];

export const merchantDomainConfigs = sqliteTable(
  "merchant_domain_configs",
  {
    tenantId: text("tenant_id").primaryKey(),
    domainType: text("domain_type", { enum: DOMAIN_TYPES }).notNull().default("D2C_ECOMMERCE"),
    cartReservationMins: integer("cart_reservation_mins").notNull().default(15),
    maxDiscountConcessionBp: integer("max_discount_concession_bp").notNull().default(500),
    softLockGraceDays: integer("soft_lock_grace_days").notNull().default(3),
    createdAtUtc: text("created_at_utc").notNull(),
    updatedAtUtc: text("updated_at_utc").notNull(),
  },
  (t) => [
    index("idx_domain_type").on(t.domainType),
  ],
);

/* ── live payment events (real payment workflow) ─────────────────── */
/**
 * Every real payment attempt (success or failure) logged with full Razorpay error envelope.
 * Source of truth for ML analysis, outreach scheduling, and benchmark metrics.
 */
export const livePaymentEvents = sqliteTable(
  "live_payment_events",
  {
    id: text("id").primaryKey(),
    razorpayPaymentId: text("razorpay_payment_id"),
    razorpayOrderId: text("razorpay_order_id"),
    customerProfileId: text("customer_profile_id")
      .notNull()
      .references(() => customerProfiles.id),
    productName: text("product_name").notNull(),
    amountPaise: integer("amount_paise").notNull(),
    status: text("status", { enum: ["authorized", "captured", "failed", "refunded", "pending"] }).notNull(),
    failureCode: text("failure_code"),
    failureDescription: text("failure_description"),
    failureStep: text("failure_step"),
    failureSource: text("failure_source"),
    failureReason: text("failure_reason"),
    failureClass: text("failure_class", {
      enum: ["SOFT_RETRYABLE", "HARD_METHOD_DEAD", "NETWORK_TIMEOUT", "RISK_FLAGGED", "UNKNOWN"],
    }),
    mlProbability: real("ml_probability"),
    mlAction: text("ml_action"),
    banditAction: text("bandit_action"),
    banditContextJson: text("bandit_context_json"),
    banditUcbScore: real("bandit_ucb_score"),
    outreachDispatched: integer("outreach_dispatched", { mode: "boolean" }).notNull().default(false),
    vendorNotified: integer("vendor_notified", { mode: "boolean" }).notNull().default(false),
    vendorDecision: text("vendor_decision", { enum: ["approved", "rejected"] }),
    recoveredAtUtc: text("recovered_at_utc"),
    createdAtUtc: text("created_at_utc").notNull(),
  },
  (t) => [
    index("idx_liveevt_customer").on(t.customerProfileId),
    index("idx_liveevt_status").on(t.status),
    index("idx_liveevt_failure_class").on(t.failureClass),
    index("idx_liveevt_created").on(t.createdAtUtc),
    index("idx_liveevt_vendor_notified").on(t.vendorNotified),
    index("idx_liveevt_bandit_action").on(t.banditAction),
  ],
);

/* ── scheduled outreach (timed follow-up queue) ──────────────────── */
/**
 * Outreach messages scheduled for future dispatch.
 * Background sweeper checks for due entries and dispatches via Brevo/MSG91.
 */
export const scheduledOutreach = sqliteTable(
  "scheduled_outreach",
  {
    id: text("id").primaryKey(),
    livePaymentEventId: text("live_payment_event_id")
      .notNull()
      .references(() => livePaymentEvents.id),
    customerProfileId: text("customer_profile_id")
      .notNull()
      .references(() => customerProfiles.id),
    channel: text("channel", { enum: ["EMAIL", "SMS"] }).notNull(),
    scheduledAtUtc: text("scheduled_at_utc").notNull(),
    executed: integer("executed", { mode: "boolean" }).notNull().default(false),
    executedAtUtc: text("executed_at_utc"),
    status: text("status", { enum: ["SENT", "FAILED", "SUPPRESSED"] }),
  },
  (t) => [
    index("idx_scheduled_due").on(t.executed, t.scheduledAtUtc),
    index("idx_scheduled_event").on(t.livePaymentEventId),
  ],
);

/* ── bandit state (persistent LinUCB weights) ───────────────────── */
/**
 * Persistent storage for LinUCB contextual bandit covariance matrix A and reward vector b.
 * Guarantees online reinforcement learning survives server restarts.
 */
export const banditState = sqliteTable(
  "bandit_state",
  {
    armType: text("arm_type").notNull(),
    action: text("action").notNull(),
    dimension: integer("dimension").notNull(),
    matrixAJson: text("matrix_a_json").notNull(),
    vectorBJson: text("vector_b_json").notNull(),
    pullCount: integer("pull_count").notNull().default(0),
    totalReward: real("total_reward").notNull().default(0.0),
    updatedAtUtc: text("updated_at_utc").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.armType, t.action] }),
    index("idx_bandit_state_arm").on(t.armType, t.action),
  ],
);

