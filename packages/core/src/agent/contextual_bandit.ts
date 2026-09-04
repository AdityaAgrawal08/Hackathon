/**
 * Deterministic LinUCB Contextual Multi-Armed Bandit (Phase 4 / BDT-16)
 *
 * Implements a disjoint linear contextual bandit (Li et al., WWW 2010).
 * Replaces hardcoded heuristics with a closed-form online reinforcement learning policy
 * that balances exploration of uncertain channels against exploitation of high net margin.
 *
 * Key Guarantees:
 * - 100% Deterministic: Exact closed-form matrix math (Gauss-Jordan elimination with partial pivoting).
 * - Zero stochastic drift, zero random sampling, zero external dependencies.
 * - Sub-millisecond: Inversion of 4x4 or 5x5 positive-definite design matrix executes in <0.05ms.
 * - Regret-bounded: Theoretical cumulative regret is O(sqrt(d T ln(T/delta))).
 * - Zero-Slop Architecture: No LLMs on the critical payment decision path.
 */

import { clamp01, clamp } from "@arbiter/shared";

// ============================================================================
// Bandit Actions (Enterprise Track 3 & Legacy Compatibility)
// ============================================================================

export type EnterpriseBanditAction =
  | "SMS_1TAP_UPI"
  | "EMAIL_1TAP_UPI"
  | "IN_FLIGHT_CASCADE"
  | "B2B_EARLY_SETTLEMENT"
  | "SPLIT_PAY_3X";

export const ENTERPRISE_BANDIT_ACTIONS: readonly EnterpriseBanditAction[] = [
  "SMS_1TAP_UPI",
  "EMAIL_1TAP_UPI",
  "IN_FLIGHT_CASCADE",
  "B2B_EARLY_SETTLEMENT",
  "SPLIT_PAY_3X",
] as const;

/** Legacy 4-arm actions for backward compatibility */
export type BanditActionId =
  | "SWITCH_TO_1TAP_UPI"
  | "SWITCH_TO_WHATSAPP"
  | "TRIGGER_SPLIT_PAY_3X"
  | "TRIGGER_DOWNSELL_5PCT"
  | EnterpriseBanditAction;

export const BANDIT_ACTIONS: readonly BanditActionId[] = [
  "SWITCH_TO_1TAP_UPI",
  "SWITCH_TO_WHATSAPP",
  "TRIGGER_SPLIT_PAY_3X",
  "TRIGGER_DOWNSELL_5PCT",
] as const;

export const CONTEXT_DIM = 4;
export const ENTERPRISE_CONTEXT_DIM = 5;

/**
 * 4-dimensional normalized context vector (Legacy):
 * [0] normalized ticket size (Paise / 10,000,00)
 * [1] historical failure count (Failures / 5)
 * [2] portal dwell time (DwellSeconds / 60)
 * [3] historical channel responsiveness [0, 1]
 */
export type ContextVector = [number, number, number, number];

/**
 * 5-dimensional enterprise context vector:
 * [0] normalized ticket size (Paise / 10,000,00)
 * [1] portal dwell time (DwellSeconds / 60)
 * [2] longitudinal open latency (min(LatencyMins, 240) / 240)
 * [3] prior failure count (Failures / 5)
 * [4] channel responsiveness [0, 1]
 */
export type EnterpriseContextVector = [number, number, number, number, number];

export interface BanditArmState {
  A: number[]; // Flattened d x d row-major design matrix
  b: number[]; // d-dim reward vector
  pullCount: number;
  totalReward: number;
}

export interface ArmSelectionResult<TAction = BanditActionId> {
  action: TAction;
  estimatedReward: number;
  confidenceBound: number;
  ucbScore: number;
  context: number[];
}

// ============================================================================
// Generalized Linear Algebra Utilities
// ============================================================================

/**
 * Generalized Gauss-Jordan elimination with partial pivoting for any n x n positive-definite matrix.
 * Executes in O(n^3) time (for n=4 or n=5, runtime is < 0.05ms).
 */
export function invertMatrixN(A: readonly number[], n: number): number[] {
  // Augmented matrix [A | I_n]
  const M: number[][] = Array.from({ length: n }, (_, i) => {
    const row = new Array(2 * n).fill(0);
    for (let j = 0; j < n; j++) {
      row[j] = A[i * n + j] ?? 0;
    }
    row[n + i] = 1;
    return row;
  });

  for (let i = 0; i < n; i++) {
    // Partial pivoting
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(M[k]![i]!) > Math.abs(M[maxRow]![i]!)) {
        maxRow = k;
      }
    }
    const temp = M[i]!;
    M[i] = M[maxRow]!;
    M[maxRow] = temp;

    const rowI = M[i]!;
    const pivot = rowI[i] ?? 1;
    if (Math.abs(pivot) < 1e-12) {
      throw new Error(`invertMatrixN: Matrix is singular or near-singular (pivot: ${pivot})`);
    }

    // Scale pivot row
    for (let j = 0; j < 2 * n; j++) {
      rowI[j] = (rowI[j] ?? 0) / pivot;
    }

    // Eliminate non-pivot rows
    for (let k = 0; k < n; k++) {
      if (k !== i) {
        const rowK = M[k]!;
        const factor = rowK[i] ?? 0;
        for (let j = 0; j < 2 * n; j++) {
          rowK[j] = (rowK[j] ?? 0) - factor * (rowI[j] ?? 0);
        }
      }
    }
  }

  // Extract right half
  const inv = new Array(n * n);
  for (let i = 0; i < n; i++) {
    const rowI = M[i]!;
    for (let j = 0; j < n; j++) {
      inv[i * n + j] = rowI[n + j] ?? 0;
    }
  }
  return inv;
}

/** Inverts a 4x4 positive-definite matrix (backward compatibility wrapper) */
export function invertMatrix4(A: readonly number[]): number[] {
  return invertMatrixN(A, 4);
}

/** Matrix-vector product: y = M * v for dimension n */
export function matVecMulN(M: readonly number[], v: readonly number[], n: number): number[] {
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) {
      sum += (M[i * n + j] ?? 0) * (v[j] ?? 0);
    }
    out[i] = sum;
  }
  return out;
}

/** 4-dim matrix-vector multiplication */
export function matVecMul4(M: readonly number[], v: readonly number[]): number[] {
  return matVecMulN(M, v, 4);
}

/** Vector dot product: x^T * y for dimension n */
export function dotProductN(x: readonly number[], y: readonly number[], n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += (x[i] ?? 0) * (y[i] ?? 0);
  }
  return sum;
}

/** 4-dim vector dot product */
export function dotProduct4(x: readonly number[], y: readonly number[]): number {
  return dotProductN(x, y, 4);
}

// ============================================================================
// Deterministic LinUCB Multi-Armed Bandit Implementation
// ============================================================================

export class LinUCBBandit<TAction extends string = BanditActionId> {
  readonly alpha: number;
  readonly dimension: number;
  readonly actionList: readonly TAction[];
  private arms: Map<TAction, BanditArmState>;

  constructor(
    alpha: number = 0.2,
    initialPriors?: Partial<Record<TAction, BanditArmState>>,
    actionList?: readonly TAction[],
    dimension: number = 4
  ) {
    this.alpha = alpha;
    this.dimension = dimension;
    this.actionList = actionList ?? (BANDIT_ACTIONS as readonly TAction[]);
    this.arms = new Map();

    const identityN = this.createIdentityMatrix(this.dimension);

    for (const action of this.actionList) {
      if (initialPriors && initialPriors[action]) {
        this.arms.set(action, initialPriors[action]!);
      } else {
        this.arms.set(action, {
          A: [...identityN],
          b: new Array(this.dimension).fill(0),
          pullCount: 0,
          totalReward: 0,
        });
      }
    }
  }

  private createIdentityMatrix(n: number): number[] {
    const I = new Array(n * n).fill(0);
    for (let i = 0; i < n; i++) {
      I[i * n + i] = 1;
    }
    return I;
  }

  /**
   * Constructs the 4-dim context vector from raw transaction attributes (legacy).
   */
  static buildContext(
    ticketAmountPaise: number,
    priorFailureCount: number = 0,
    dwellTimeSeconds: number = 0,
    channelResponsiveness: number = 0.5
  ): ContextVector {
    return [
      clamp01(ticketAmountPaise / 10_000_00), // Scaled to ₹10,000
      clamp01(priorFailureCount / 5),
      clamp01(dwellTimeSeconds / 60),
      clamp01(channelResponsiveness),
    ];
  }

  /**
   * Constructs the 5-dim enterprise context vector incorporating longitudinal latency.
   */
  static buildEnterpriseContext(
    ticketAmountPaise: number,
    dwellTimeSeconds: number = 0,
    openLatencyMins: number = 30,
    priorFailureCount: number = 0,
    channelResponsiveness: number = 0.5
  ): EnterpriseContextVector {
    return [
      clamp01(ticketAmountPaise / 10_000_00),
      clamp01(dwellTimeSeconds / 60),
      clamp01(Math.min(240, openLatencyMins) / 240),
      clamp01(priorFailureCount / 5),
      clamp01(channelResponsiveness),
    ];
  }

  /**
   * Evaluates UCB scores across all candidate arms for context x and selects optimal arm.
   * Deterministic tie-breaking by stable index ordering.
   */
  selectArm(context: number[]): ArmSelectionResult<TAction> {
    const d = this.dimension;
    let bestAction = this.actionList[0]!;
    let bestScore = -Infinity;
    let bestEst = 0;
    let bestConfidence = 0;

    for (const action of this.actionList) {
      const arm = this.arms.get(action)!;
      let invA: number[];
      try {
        invA = invertMatrixN(arm.A, d);
      } catch {
        invA = this.createIdentityMatrix(d);
      }

      // theta = A^-1 * b
      const theta = matVecMulN(invA, arm.b, d);

      // Estimated expected reward = x^T * theta
      const rawEst = dotProductN(context, theta, d);
      const estimatedReward = Number.isFinite(rawEst) ? rawEst : 0;

      // Variance = x^T * A^-1 * x
      const invAx = matVecMulN(invA, context, d);
      const variance = Math.max(0, dotProductN(context, invAx, d));
      const confidenceBound = Number.isFinite(variance)
        ? this.alpha * Math.sqrt(variance)
        : 0;

      // Upper Confidence Bound
      const ucbScore = estimatedReward + confidenceBound;

      if (Number.isFinite(ucbScore) && ucbScore > bestScore) {
        bestScore = ucbScore;
        bestAction = action;
        bestEst = estimatedReward;
        bestConfidence = confidenceBound;
      }
    }

    return {
      action: bestAction,
      estimatedReward: Number(bestEst.toFixed(4)),
      confidenceBound: Number(bestConfidence.toFixed(4)),
      ucbScore: Number(bestScore.toFixed(4)),
      context,
    };
  }

  /**
   * Updates the selected arm with observed normalized reward in [0, 1].
   *   A_a <- A_a + x * x^T
   *   b_a <- b_a + r * x
   */
  updateArm(action: TAction, context: number[], reward: number): void {
    const arm = this.arms.get(action);
    if (!arm) return;

    const r = clamp01(reward);
    const d = this.dimension;

    // Update A: A += x * x^T
    for (let i = 0; i < d; i++) {
      for (let j = 0; j < d; j++) {
        arm.A[i * d + j] = (arm.A[i * d + j] ?? 0) + (context[i] ?? 0) * (context[j] ?? 0);
      }
    }

    // Update b: b += r * x
    for (let i = 0; i < d; i++) {
      arm.b[i] = (arm.b[i] ?? 0) + r * (context[i] ?? 0);
    }

    arm.pullCount++;
    arm.totalReward += r;
  }

  /**
   * Returns current snapshot of all arm states.
   */
  getState(): Record<TAction, BanditArmState> {
    const out = {} as Record<TAction, BanditArmState>;
    for (const [k, v] of this.arms.entries()) {
      out[k] = {
        A: [...v.A],
        b: [...v.b],
        pullCount: v.pullCount,
        totalReward: v.totalReward,
      };
    }
    return out;
  }

  /** Factory method for 5-Arm Enterprise Track 3 Bandit */
  static createEnterpriseBandit(alpha: number = 0.2): LinUCBBandit<EnterpriseBanditAction> {
    return new LinUCBBandit<EnterpriseBanditAction>(
      alpha,
      undefined,
      ENTERPRISE_BANDIT_ACTIONS,
      ENTERPRISE_CONTEXT_DIM
    );
  }
}

/** Default singleton instance for instant cold-start capability (legacy 4-arm) */
export const defaultRecoveryBandit = new LinUCBBandit(0.2);

/** Default singleton instance for Enterprise Track 3 recovery */
export const defaultEnterpriseBandit = LinUCBBandit.createEnterpriseBandit(0.2);
