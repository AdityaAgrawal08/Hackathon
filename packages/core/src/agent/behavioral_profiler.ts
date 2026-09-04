/**
 * ARBITER Customer Behavioral Profiler & Merchant Domain Context Engine.
 *
 * Implements longitudinal behavioral intelligence:
 * 1. Tracks customer open/click latencies and channel affinity in SQLite.
 * 2. Learns responsiveness velocity (fast responders get priority queue dispatch).
 * 3. Handles low-balance failures with ZERO PAYDAY ASSUMPTION:
 *    recommends switching to an alternate bank account, secondary UPI app, or retry later.
 * 4. Customizes recovery urgency and concession thresholds per merchant business model
 *    (D2C E-Commerce, SaaS Mandates, B2B Invoices, High-Ticket EdTech).
 */

import type { Client } from "@libsql/client";
import { paise, type Paise } from "@arbiter/shared";
import type { DomainType } from "../db/schema.js";

export type PreferredChannel = "EMAIL" | "SMS" | "AUTO";
export type PriorityTier = "TIER_1_CRITICAL" | "TIER_2_HIGH" | "TIER_3_SCHEDULED" | "TIER_4_SUPPRESSED";
export type { DomainType };

export interface CustomerBehavioralProfile {
  id: string;
  name: string;
  phone: string;
  email: string;
  preferredChannel: PreferredChannel;
  emailOpenLatencyMins: number | null;
  historicalOpenRate: number;
  historicalClickRate: number;
  paymentMethodAffinity: string;
  ticketSensitivityScore: number;
  alternateAccountConverted: boolean;
  avgRecoveryLatencyHours: number | null;
  totalRecoveredPaise: number;
  patienceScore: number;
  lastEngagedChannel: string | null;
  lastEngagedAtUtc: string | null;
  optedOut: boolean;
  totalAttempts: number;
  totalSuccesses: number;
  totalFailures: number;
}

export interface MerchantDomainConfig {
  tenantId: string;
  domainType: DomainType;
  cartReservationMins: number;
  maxDiscountConcessionBp: number;
  softLockGraceDays: number;
  createdAtUtc: string;
  updatedAtUtc: string;
}

export interface PriorityScoreOutput {
  priorityScore: number;
  priorityTier: PriorityTier;
  engagementVelocity: number;
  urgencyWeight: number;
  retentionFactor: number;
  rationale: string;
}

export interface LowBalanceActionGuidance {
  actionId: "SWITCH_ACCOUNT_OR_RETRY";
  customerMessageSms: string;
  customerMessageEmail: {
    subject: string;
    headline: string;
    body: string;
    ctaText: string;
  };
  recommendedRails: string[];
  historicalAlternateConversion: boolean;
}

/** Default merchant domain configuration fallback */
export const DEFAULT_MERCHANT_DOMAIN_CONFIG: MerchantDomainConfig = {
  tenantId: "demo",
  domainType: "D2C_ECOMMERCE",
  cartReservationMins: 15,
  maxDiscountConcessionBp: 500, // 5% max discount concession
  softLockGraceDays: 3,
  createdAtUtc: new Date().toISOString(),
  updatedAtUtc: new Date().toISOString(),
};

/**
 * Computes Exponential Moving Average (EMA) with decay factor alpha.
 */
export function updateEma(currentEma: number | null, newValue: number, alpha = 0.3): number {
  if (typeof newValue !== "number" || isNaN(newValue) || newValue < 0) {
    return currentEma ?? 0;
  }
  if (currentEma === null || isNaN(currentEma)) {
    return Math.round(newValue * 100) / 100;
  }
  return Math.round((alpha * newValue + (1 - alpha) * currentEma) * 100) / 100;
}

/**
 * Mathematical dynamic Priority Score formulation:
 * Priority = EV * EngagementVelocity * UrgencyWeight * (1.0 - ChurnRisk)
 */
export function computeCustomerPriority(
  profile: CustomerBehavioralProfile,
  amountPaise: number,
  domainType: DomainType = "D2C_ECOMMERCE",
  churnRiskBp = 1000
): PriorityScoreOutput {
  const safeAmount = typeof amountPaise === "number" && !isNaN(amountPaise) && amountPaise > 0 ? amountPaise : 0;
  // 1. Guard against opted-out customers
  if (profile.optedOut) {
    return {
      priorityScore: 0,
      priorityTier: "TIER_4_SUPPRESSED",
      engagementVelocity: 0,
      urgencyWeight: 0,
      retentionFactor: 0,
      rationale: "Customer has opted out of communication (TRAI compliance)",
    };
  }

  // 2. Engagement Velocity calculation (speed of opening / acting)
  let velocity = 1.0;
  let velocityRationale = "Default baseline response velocity";

  if (profile.emailOpenLatencyMins !== null) {
    if (profile.emailOpenLatencyMins <= 15) {
      velocity = 1.6; // Rapid opener: jump to front of queue
      velocityRationale = `Rapid email opener (~${Math.round(profile.emailOpenLatencyMins)} mins latency)`;
    } else if (profile.emailOpenLatencyMins <= 60) {
      velocity = 1.3;
      velocityRationale = `Fast email opener (~${Math.round(profile.emailOpenLatencyMins)} mins latency)`;
    } else if (profile.emailOpenLatencyMins <= 240) {
      velocity = 1.0;
      velocityRationale = `Moderate response latency (~${Math.round(profile.emailOpenLatencyMins)} mins)`;
    } else {
      velocity = 0.75; // Slow opener: defer to scheduled batch
      velocityRationale = `Delayed response pattern (>4 hours latency)`;
    }
  } else if (profile.historicalOpenRate >= 0.6) {
    velocity = 1.3;
    velocityRationale = `High historical open rate (${Math.round(profile.historicalOpenRate * 100)}%)`;
  } else if (profile.totalAttempts >= 3 && profile.historicalOpenRate < 0.15) {
    velocity = 0.7;
    velocityRationale = `Low historical responsiveness (${Math.round(profile.historicalOpenRate * 100)}%)`;
  }

  // 3. Domain Urgency Weight
  let urgencyWeight = 1.0;
  switch (domainType) {
    case "D2C_ECOMMERCE":
      // D2C cart abandonment is highly time-sensitive (impulse purchase drops off exponentially)
      urgencyWeight = 1.45;
      break;
    case "B2B_INVOICES":
      // B2B high ticket DSO impact
      urgencyWeight = 1.35;
      break;
    case "SAAS_MANDATES":
      // Subscription churn mitigation
      urgencyWeight = 1.15;
      break;
    case "HIGH_TICKET":
      urgencyWeight = 1.0;
      break;
  }

  // 4. Expected Value in Rupees
  const expectedValueRupees = Math.max(1, amountPaise / 100);

  // 5. Churn risk discount factor (0.0 to 1.0)
  const churnFactor = Math.max(0.1, 1.0 - churnRiskBp / 10000);

  // Raw Priority Score
  const rawScore = expectedValueRupees * velocity * urgencyWeight * churnFactor;
  const priorityScore = Math.round(rawScore * 100) / 100;

  // 6. Assign Priority Tiers
  let priorityTier: PriorityTier = "TIER_3_SCHEDULED";
  if (priorityScore >= 3000 || (velocity >= 1.5 && expectedValueRupees >= 1000) || (domainType === "D2C_ECOMMERCE" && velocity >= 1.3)) {
    priorityTier = "TIER_1_CRITICAL";
  } else if (priorityScore >= 800 || velocity >= 1.2) {
    priorityTier = "TIER_2_HIGH";
  } else {
    priorityTier = "TIER_3_SCHEDULED";
  }

  return {
    priorityScore,
    priorityTier,
    engagementVelocity: velocity,
    urgencyWeight,
    retentionFactor: churnFactor,
    rationale: `${velocityRationale}; Domain=${domainType} (weight ${urgencyWeight}); Score=${priorityScore}`,
  };
}

/**
 * Generate compliant, zero-payday guidance when account balance is insufficient.
 * Recommends switching to an alternate bank account, secondary UPI app, or retry later.
 */
export function getLowBalanceGuidance(
  customerName: string,
  amountPaise: number,
  recoveryUrl: string,
  profile?: CustomerBehavioralProfile | null
): LowBalanceActionGuidance {
  const formattedAmount = `₹${(amountPaise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
  const hasAlternateHistory = Boolean(profile?.alternateAccountConverted);

  return {
    actionId: "SWITCH_ACCOUNT_OR_RETRY",
    customerMessageSms: `Payment of ${formattedAmount} could not be processed due to low balance. Please complete using an alternate bank account/UPI app or try again later: ${recoveryUrl}`,
    customerMessageEmail: {
      subject: `Payment update: Please use an alternate account for ${formattedAmount}`,
      headline: `Payment Incomplete — Insufficient Account Balance`,
      body: `Hi ${customerName},\n\nYour transaction of ${formattedAmount} could not be processed because your bank reported insufficient funds in the selected account.\n\nTo ensure your order is not cancelled, please complete your payment using an alternate bank account, secondary UPI app (Google Pay, PhonePe, Paytm), or try again when convenient.`,
      ctaText: "Switch Account & Pay Now",
    },
    recommendedRails: ["upi_intent_alternate_vpa", "secondary_bank_account", "card_fallback"],
    historicalAlternateConversion: hasAlternateHistory,
  };
}

/**
 * Fetch a customer's behavioral profile by ID from the database.
 */
export async function fetchBehavioralProfile(
  profileId: string,
  client: Client
): Promise<CustomerBehavioralProfile | null> {
  const result = await client.execute({
    sql: `SELECT * FROM customer_profiles WHERE id = ?`,
    args: [profileId],
  });
  if (!result.rows.length) return null;
  const r = result.rows[0] as any;
  return mapRowToProfile(r);
}

/**
 * Record an email open event and update latency moving average.
 */
export async function recordEmailOpened(
  profileId: string,
  openLatencyMins: number,
  client: Client
): Promise<void> {
  const existing = await fetchBehavioralProfile(profileId, client);
  if (!existing) return;

  const newLatency = updateEma(existing.emailOpenLatencyMins, openLatencyMins, 0.35);
  const totalEngagements = existing.totalAttempts + 1;
  const newOpenRate = Math.min(1.0, (existing.historicalOpenRate * existing.totalAttempts + 1) / totalEngagements);
  const nowUtc = new Date().toISOString();

  await client.execute({
    sql: `
      UPDATE customer_profiles
      SET email_open_latency_mins = ?,
          historical_open_rate = ?,
          last_engaged_channel = 'EMAIL',
          last_engaged_at_utc = ?
      WHERE id = ?
    `,
    args: [newLatency, Math.round(newOpenRate * 1000) / 1000, nowUtc, profileId],
  });
}

/**
 * Record a link click event (customer engaged with recovery portal).
 */
export async function recordLinkClicked(
  profileId: string,
  channel: "EMAIL" | "SMS",
  client: Client
): Promise<void> {
  const existing = await fetchBehavioralProfile(profileId, client);
  if (!existing) return;

  const totalEngagements = existing.totalAttempts + 1;
  const newClickRate = Math.min(1.0, (existing.historicalClickRate * existing.totalAttempts + 1) / totalEngagements);
  const nowUtc = new Date().toISOString();

  await client.execute({
    sql: `
      UPDATE customer_profiles
      SET historical_click_rate = ?,
          last_engaged_channel = ?,
          last_engaged_at_utc = ?
      WHERE id = ?
    `,
    args: [Math.round(newClickRate * 1000) / 1000, channel, nowUtc, profileId],
  });
}

/**
 * Record provider delivery status (e.g. DLR from MSG91 or Brevo bounce).
 * Automatically adapts channel routing if a channel fails or returns DND.
 */
export async function recordDeliveryStatus(
  profileId: string,
  channel: "EMAIL" | "SMS",
  status: "DELIVERED" | "FAILED" | "DND",
  client: Client
): Promise<void> {
  if (status === "FAILED" || status === "DND") {
    // If SMS fails or is blocked by TRAI DND, adapt preferred channel to EMAIL
    const fallbackChannel: PreferredChannel = channel === "SMS" ? "EMAIL" : "SMS";
    await client.execute({
      sql: `UPDATE customer_profiles SET preferred_channel = ? WHERE id = ?`,
      args: [fallbackChannel, profileId],
    });
  }
}

/**
 * Record completed recovery with payment telemetry.
 */
export async function recordRecoveryCompleted(
  profileId: string,
  amountPaise: number,
  latencyHours: number,
  usedAlternateAccount: boolean,
  client: Client
): Promise<void> {
  const existing = await fetchBehavioralProfile(profileId, client);
  if (!existing) return;

  const newTotalSuccesses = existing.totalSuccesses + 1;
  const newTotalRecovered = existing.totalRecoveredPaise + amountPaise;
  const newLatencyHours = updateEma(existing.avgRecoveryLatencyHours, latencyHours, 0.3);
  const alternateConvertedFlag = usedAlternateAccount || existing.alternateAccountConverted ? 1 : 0;

  await client.execute({
    sql: `
      UPDATE customer_profiles
      SET total_successes = ?,
          total_recovered_paise = ?,
          avg_recovery_latency_hours = ?,
          alternate_account_converted = ?
      WHERE id = ?
    `,
    args: [newTotalSuccesses, newTotalRecovered, newLatencyHours, alternateConvertedFlag, profileId],
  });
}

/**
 * Fetch or create merchant domain configuration.
 */
export async function fetchMerchantDomainConfig(
  tenantId: string,
  client: Client
): Promise<MerchantDomainConfig> {
  const res = await client.execute({
    sql: `SELECT * FROM merchant_domain_configs WHERE tenant_id = ?`,
    args: [tenantId],
  });
  if (res.rows.length > 0) {
    const r = res.rows[0] as any;
    return {
      tenantId: String(r.tenant_id),
      domainType: r.domain_type as DomainType,
      cartReservationMins: Number(r.cart_reservation_mins),
      maxDiscountConcessionBp: Number(r.max_discount_concession_bp),
      softLockGraceDays: Number(r.soft_lock_grace_days),
      createdAtUtc: String(r.created_at_utc),
      updatedAtUtc: String(r.updated_at_utc),
    };
  }

  const nowUtc = new Date().toISOString();
  const defConfig: MerchantDomainConfig = {
    ...DEFAULT_MERCHANT_DOMAIN_CONFIG,
    tenantId,
    createdAtUtc: nowUtc,
    updatedAtUtc: nowUtc,
  };

  await client.execute({
    sql: `
      INSERT INTO merchant_domain_configs (
        tenant_id, domain_type, cart_reservation_mins, max_discount_concession_bp, soft_lock_grace_days, created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      defConfig.tenantId,
      defConfig.domainType,
      defConfig.cartReservationMins,
      defConfig.maxDiscountConcessionBp,
      defConfig.softLockGraceDays,
      defConfig.createdAtUtc,
      defConfig.updatedAtUtc,
    ],
  });

  return defConfig;
}

/**
 * Helper to map database rows to strongly typed profile.
 */
function mapRowToProfile(r: any): CustomerBehavioralProfile {
  return {
    id: String(r.id),
    name: String(r.name),
    phone: String(r.phone),
    email: String(r.email),
    preferredChannel: (r.preferred_channel as PreferredChannel) || "AUTO",
    emailOpenLatencyMins: r.email_open_latency_mins !== null ? Number(r.email_open_latency_mins) : null,
    historicalOpenRate: Number(r.historical_open_rate ?? 0),
    historicalClickRate: Number(r.historical_click_rate ?? 0),
    paymentMethodAffinity: String(r.payment_method_affinity ?? "upi"),
    ticketSensitivityScore: Number(r.ticket_sensitivity_score ?? 0),
    alternateAccountConverted: Boolean(r.alternate_account_converted),
    avgRecoveryLatencyHours: r.avg_recovery_latency_hours !== null ? Number(r.avg_recovery_latency_hours) : null,
    totalRecoveredPaise: Number(r.total_recovered_paise ?? 0),
    patienceScore: Number(r.patience_score ?? 0.5),
    lastEngagedChannel: r.last_engaged_channel ? String(r.last_engaged_channel) : null,
    lastEngagedAtUtc: r.last_engaged_at_utc ? String(r.last_engaged_at_utc) : null,
    optedOut: Boolean(r.opted_out),
    totalAttempts: Number(r.total_attempts ?? 0),
    totalSuccesses: Number(r.total_successes ?? 0),
    totalFailures: Number(r.total_failures ?? 0),
  };
}
