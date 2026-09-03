/**
 * CFO Merchant Unit Economics & P&L Engine
 *
 * Provides mathematically sound calculations for:
 * 1. Granular Channel COGS Accounting
 * 2. Payment Rail MDR Fee Arbitrage (Card 2.0% vs UPI 0.0%)
 * 3. Counterfactual Attribution (True Incremental Lift over Natural Return)
 * 4. Net Margin Preserved
 */

/** Granular channel COGS in paise */
export const CHANNEL_COGS_PAISE = {
  EMAIL_BREVO: 8,       // ₹0.08
  SMS_MSG91: 18,        // ₹0.18
  WHATSAPP_META: 72,    // ₹0.72
  VOICE_MINUTE: 140,    // ₹1.40
  GATEWAY_RETRY: 25,    // ₹0.25 (gateway processing fee per failed retry)
} as const;

/** Standard India Payment Rail MDR Fees (Basis Points) */
export const MDR_RATES_BPS = {
  CREDIT_CARD: 200,     // 2.00% + GST
  DEBIT_CARD: 90,       // 0.90%
  UPI_P2M: 0,           // 0.00%
  NETBANKING: 150,      // 1.50%
} as const;

/** Natural organic return rate without intervention (Counterfactual Baseline) */
export const NATURAL_ORGANIC_RETURN_RATE = 0.182; // 18.2%

/**
 * Computes direct MDR fee savings when routing a customer from a high-fee rail (Card)
 * to a zero-fee rail (1-Tap UPI).
 */
export function computeMdrSavingsPaise(
  amountPaise: number,
  originalMethod: string = "card",
  recoveredMethod: string = "upi",
): number {
  if (amountPaise <= 0) return 0;
  const orig = originalMethod.toLowerCase();
  const rec = recoveredMethod.toLowerCase();

  // If originally Card and recovered via UPI
  if ((orig.includes("card") || orig === "credit_card") && (rec.includes("upi") || rec === "vpa")) {
    // 200 bps = 2.0%
    return Math.round((amountPaise * MDR_RATES_BPS.CREDIT_CARD) / 10000);
  }

  // If originally Netbanking and recovered via UPI
  if (orig.includes("netbanking") && rec.includes("upi")) {
    return Math.round((amountPaise * MDR_RATES_BPS.NETBANKING) / 10000);
  }

  return 0;
}

/**
 * Computes True Incremental Lift over the counterfactual natural return baseline.
 */
export function computeIncrementalLift(
  recoveredPaise: number,
  totalAtRiskPaise: number,
  organicRate: number = NATURAL_ORGANIC_RETURN_RATE,
): {
  organicBaselinePaise: number;
  trueLiftPaise: number;
  liftPercentage: number;
} {
  const organicBaselinePaise = Math.round(totalAtRiskPaise * organicRate);
  const trueLiftPaise = Math.max(0, recoveredPaise - organicBaselinePaise);
  const liftPercentage = totalAtRiskPaise > 0 ? (trueLiftPaise / totalAtRiskPaise) * 100 : 0;

  return {
    organicBaselinePaise,
    trueLiftPaise,
    liftPercentage: Number(liftPercentage.toFixed(2)),
  };
}

/**
 * Computes Net Recovered Margin (₹):
 * Net = Gross Recovered - Channel COGS - Concessions/Discounts + MDR Savings
 */
export function computeNetMarginPreservedPaise(
  grossRecoveredPaise: number,
  channelCostPaise: number,
  discountPaise: number = 0,
  mdrSavingsPaise: number = 0,
): number {
  return grossRecoveredPaise - channelCostPaise - discountPaise + mdrSavingsPaise;
}

/**
 * Computes Unit Cost of Recovery per ₹100 won.
 */
export function computeUnitCostPer100Won(
  totalCostPaise: number,
  grossRecoveredPaise: number,
): number {
  if (grossRecoveredPaise <= 0) return 0;
  return Number(((totalCostPaise / grossRecoveredPaise) * 100).toFixed(2));
}
