/**
 * Token-Bucket Outbound Rate Limiter (Phase 2)
 *
 * Implements a mathematical token-bucket algorithm to rate-limit outbound
 * requests to external APIs (Brevo, MSG91, Groq).
 *
 * Guarantees:
 * - Deterministic burst handling up to bucket capacity
 * - Continuous refill based on elapsed milliseconds
 * - Non-blocking tryAcquire() for zero-latency checks
 * - Async acquire() with bounded timeout and exponential/linear wait
 * - Zero external dependencies
 */

export interface TokenBucketOptions {
  capacity: number;
  refillRate: number; // tokens per second
  name?: string;
  initialTokens?: number;
}

export class TokenBucket {
  readonly capacity: number;
  readonly refillRate: number;
  readonly name: string;
  private tokens: number;
  private lastRefillMs: number;

  constructor(options: TokenBucketOptions) {
    if (options.capacity <= 0) throw new Error("Bucket capacity must be > 0");
    if (options.refillRate <= 0) throw new Error("Bucket refillRate must be > 0");

    this.capacity = options.capacity;
    this.refillRate = options.refillRate;
    this.name = options.name || "token_bucket";
    this.tokens = options.initialTokens !== undefined ? Math.min(options.capacity, options.initialTokens) : options.capacity;
    this.lastRefillMs = Date.now();
  }

  /**
   * Refills tokens according to elapsed wall-clock time.
   */
  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefillMs) / 1000;
    if (elapsedSec > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillRate);
      this.lastRefillMs = now;
    }
  }

  /**
   * Non-blocking attempt to acquire tokens.
   * Returns true if acquired, false if insufficient tokens available.
   */
  tryAcquire(tokens: number = 1): boolean {
    if (tokens <= 0) return true;
    this.refill();
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return true;
    }
    return false;
  }

  /**
   * Asynchronous wait to acquire tokens with a deadline timeout.
   * If tokens are not available within timeoutMs, returns false.
   */
  async acquire(tokens: number = 1, timeoutMs: number = 5000): Promise<boolean> {
    if (tokens <= 0) return true;
    const start = Date.now();

    while (true) {
      if (this.tryAcquire(tokens)) {
        return true;
      }
      const elapsed = Date.now() - start;
      if (elapsed >= timeoutMs) {
        return false;
      }

      // Calculate time needed to refill remaining tokens
      const remainingNeeded = tokens - this.tokens;
      const msNeeded = Math.ceil((remainingNeeded / this.refillRate) * 1000);
      const sleepMs = Math.min(timeoutMs - elapsed, Math.max(10, msNeeded));

      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
  }

  /**
   * Returns current available token balance.
   */
  getAvailableTokens(): number {
    this.refill();
    return this.tokens;
  }

  /**
   * Resets bucket to maximum capacity.
   */
  reset(): void {
    this.tokens = this.capacity;
    this.lastRefillMs = Date.now();
  }
}

// ── Standard Pre-Configured Rate Limiters ──────────────────────────

/**
 * Brevo Email API Rate Limiter
 * - Max: 50 requests / second
 * - Capacity: 50
 * - Refill: 50 tokens / second
 */
export const brevoEmailLimiter = new TokenBucket({
  name: "brevo_email",
  capacity: 50,
  refillRate: 50,
});

/**
 * MSG91 SMS Flow API Rate Limiter
 * - Max: 50 requests / second
 * - Capacity: 50
 * - Refill: 50 tokens / second
 */
export const msg91SmsLimiter = new TokenBucket({
  name: "msg91_sms",
  capacity: 50,
  refillRate: 50,
});

/**
 * Groq LLM API Rate Limiter
 * - Max: 30 requests / minute (0.5 tokens/sec)
 * - Capacity: 5 (burst allowance)
 * - Refill: 0.5 tokens / second
 */
export const groqLlmLimiter = new TokenBucket({
  name: "groq_llm",
  capacity: 5,
  refillRate: 0.5,
});
