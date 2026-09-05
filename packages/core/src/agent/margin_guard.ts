/**
 * Financial Invariant Guardrail — Discount Margin Protection (Track 3)
 *
 * Guarantees that no automated intervention (such as behavioral downsell on recovery portal,
 * or 2/10 Net 30 B2B early settlement discount) violates merchant profitability invariants.
 *
 * Invariants:
 * - I-MARGIN-1: Max discount percentage cannot exceed merchant ceiling (default 15%).
 * - I-MARGIN-2: Downsell amount cannot fall below configured product floor price.
 * - I-MARGIN-3: All discount calculations are deterministic integer paise arithmetic.
 */

export interface MarginGuardConfig {
  maxDiscountBps: number; // Basis points (e.g. 1500 = 15.00%)
  minAbsoluteMarginPaise?: number;
  productFloorPaiseMap?: Record<string, number>;
}

export const DEFAULT_MARGIN_CONFIG: MarginGuardConfig = {
  maxDiscountBps: 1500, // Max 15% discount
  minAbsoluteMarginPaise: 10000, // Min ₹100 merchant margin
};

export interface DiscountValidationResult {
  allowed: boolean;
  originalAmountPaise: number;
  proposedAmountPaise: number;
  discountPaise: number;
  discountBps: number;
  discountPercent: number;
  reason: string;
}

export class MarginGuard {
  private config: MarginGuardConfig;

  constructor(config: Partial<MarginGuardConfig> = {}) {
    this.config = {
      ...DEFAULT_MARGIN_CONFIG,
      ...config,
    };
  }

  /**
   * Validates whether a proposed discounted amount is compliant with merchant margin rules.
   */
  validateDiscount(
    originalAmountPaise: number,
    proposedAmountPaise: number,
    productId?: string
  ): DiscountValidationResult {
    if (originalAmountPaise <= 0) {
      return {
        allowed: false,
        originalAmountPaise,
        proposedAmountPaise,
        discountPaise: 0,
        discountBps: 0,
        discountPercent: 0,
        reason: "Invalid original amount: must be positive paise integer",
      };
    }

    if (proposedAmountPaise > originalAmountPaise) {
      return {
        allowed: false,
        originalAmountPaise,
        proposedAmountPaise,
        discountPaise: 0,
        discountBps: 0,
        discountPercent: 0,
        reason: "Proposed amount exceeds original amount",
      };
    }

    const discountPaise = originalAmountPaise - proposedAmountPaise;
    const discountBps = Math.round((discountPaise / originalAmountPaise) * 10000);
    const discountPercent = Number((discountBps / 100).toFixed(2));

    // Check maximum basis points cap
    if (discountBps > this.config.maxDiscountBps) {
      return {
        allowed: false,
        originalAmountPaise,
        proposedAmountPaise,
        discountPaise,
        discountBps,
        discountPercent,
        reason: `Discount of ${discountPercent}% (${discountBps} bps) exceeds maximum allowable ceiling of ${this.config.maxDiscountBps / 100}%`,
      };
    }

    // Check product floor map if defined
    if (productId && this.config.productFloorPaiseMap && this.config.productFloorPaiseMap[productId]) {
      const floor = this.config.productFloorPaiseMap[productId]!;
      if (proposedAmountPaise < floor) {
        return {
          allowed: false,
          originalAmountPaise,
          proposedAmountPaise,
          discountPaise,
          discountBps,
          discountPercent,
          reason: `Proposed amount ₹${(proposedAmountPaise / 100).toFixed(2)} is below product floor of ₹${(floor / 100).toFixed(2)}`,
        };
      }
    }

    return {
      allowed: true,
      originalAmountPaise,
      proposedAmountPaise,
      discountPaise,
      discountBps,
      discountPercent,
      reason: "Discount within approved merchant margin bounds",
    };
  }

  /**
   * Computes safe downsell amount clamped to the maximum allowed discount.
   */
  computeSafeDownsellPaise(originalAmountPaise: number, requestedDiscountBps: number = 1000): number {
    const effectiveBps = Math.min(this.config.maxDiscountBps, Math.max(0, requestedDiscountBps));
    const discountPaise = Math.round((originalAmountPaise * effectiveBps) / 10000);
    return Math.max(0, originalAmountPaise - discountPaise);
  }
}

export const defaultMarginGuard = new MarginGuard();
