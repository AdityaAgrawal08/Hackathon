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
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
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
