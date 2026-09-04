/**
 * Decoupled Asynchronous Webhook Queue (Phase 2)
 *
 * Provides a high-throughput, in-memory asynchronous worker pool to decouple
 * inbound webhook ingestion from heavy database queries and outbound outreach.
 *
 * Guarantees:
 * - Immediate enqueue and acknowledgment (<15ms response to Razorpay)
 * - Worker pool concurrency controls to prevent SQLite / socket contention
 * - Jittered exponential backoff retries for transient lock/busy errors
 * - Dead Letter Queue (DLQ) tracking for persistently failed events
 * - Complete stats and drain/waitForIdle helpers for testing and graceful shutdown
 */
import { logger } from "@arbiter/shared";

export interface WebhookJob {
  id: string;
  receivedAtMs: number;
  eventType: string;
  payload: Record<string, any>;
  rawBody?: Buffer | string;
  signature?: string;
  metadata?: Record<string, unknown>;
  retryCount?: number;
}

export type WebhookJobHandler = (job: WebhookJob) => Promise<void>;

export interface WebhookQueueOptions {
  concurrency?: number;
  maxQueueSize?: number;
  maxRetries?: number;
  retryBackoffBaseMs?: number;
  name?: string;
}

export interface WebhookQueueStats {
  enqueued: number;
  processed: number;
  failed: number;
  inFlight: number;
  queued: number;
  deadLetterCount: number;
  avgProcessingLatencyMs: number;
}

export class WebhookQueue {
  readonly concurrency: number;
  readonly maxQueueSize: number;
  readonly maxRetries: number;
  readonly retryBackoffBaseMs: number;
  readonly name: string;

  private queue: WebhookJob[] = [];
  private inFlight = 0;
  private scheduledRetries = 0;
  private enqueuedCount = 0;
  private processedCount = 0;
  private failedCount = 0;
  private totalProcessingTimeMs = 0;
  private deadLetterQueue: Array<{ job: WebhookJob; error: string; failedAtMs: number }> = [];
  private handler?: WebhookJobHandler;
  private idleResolvers: Array<() => void> = [];
  private isProcessing = false;

  constructor(options: WebhookQueueOptions = {}) {
    this.concurrency = options.concurrency ?? 10;
    this.maxQueueSize = options.maxQueueSize ?? 20000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBackoffBaseMs = options.retryBackoffBaseMs ?? 50;
    this.name = options.name || "razorpay_webhook_queue";
  }

  /**
   * Registers the background processor function for enqueued jobs.
   */
  setHandler(handler: WebhookJobHandler): void {
    this.handler = handler;
    this.triggerWorkers();
  }

  /**
   * Enqueues a webhook job for asynchronous background processing.
   * Returns immediately with enqueue metrics.
   */
  enqueue(job: Omit<WebhookJob, "receivedAtMs"> & { receivedAtMs?: number }): {
    enqueued: boolean;
    queueDepth: number;
    error?: string;
  } {
    if (this.queue.length >= this.maxQueueSize) {
      logger.error({
        msg: `[WebhookQueue:${this.name}] Queue capacity overflow! Dropping job`,
        queueDepth: this.queue.length,
        jobId: job.id,
      });
      return { enqueued: false, queueDepth: this.queue.length, error: "Queue capacity exceeded" };
    }

    const fullJob: WebhookJob = {
      ...job,
      receivedAtMs: job.receivedAtMs || Date.now(),
      retryCount: job.retryCount || 0,
    };

    this.queue.push(fullJob);
    this.enqueuedCount++;

    // Trigger worker tick asynchronously without blocking the caller
    setImmediate(() => this.triggerWorkers());

    return { enqueued: true, queueDepth: this.queue.length };
  }

  /**
   * Triggers worker tasks up to the concurrency ceiling.
   */
  private triggerWorkers(): void {
    if (!this.handler) return;

    while (this.inFlight < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) break;

      this.inFlight++;
      this.executeJob(job).finally(() => {
        this.inFlight--;
        this.triggerWorkers();
        this.checkIdle();
      });
    }
  }

  /**
   * Executes a single job with transient error retry logic.
   */
  private async executeJob(job: WebhookJob): Promise<void> {
    const startTime = Date.now();
    try {
      if (this.handler) {
        await this.handler(job);
      }
      const durationMs = Date.now() - startTime;
      this.processedCount++;
      this.totalProcessingTimeMs += durationMs;
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      const errorMsg = err?.message || String(err);
      const isTransient = /busy|locked|timeout|connection reset|econnreset/i.test(errorMsg);

      if (isTransient && (job.retryCount || 0) < this.maxRetries) {
        job.retryCount = (job.retryCount || 0) + 1;
        this.scheduledRetries++;
        const jitter = Math.floor(Math.random() * 20);
        const backoffMs = this.retryBackoffBaseMs * Math.pow(2, job.retryCount - 1) + jitter;

        logger.warn({
          msg: `[WebhookQueue:${this.name}] Transient error processing job. Retrying in ${backoffMs}ms`,
          jobId: job.id,
          attempt: job.retryCount,
          error: errorMsg,
        });

        setTimeout(() => {
          this.scheduledRetries--;
          this.queue.unshift(job); // Prioritize retries at head of queue
          this.triggerWorkers();
          this.checkIdle();
        }, backoffMs);
      } else {
        this.failedCount++;
        this.deadLetterQueue.push({
          job,
          error: errorMsg,
          failedAtMs: Date.now(),
        });
        logger.error({
          msg: `[WebhookQueue:${this.name}] Job failed permanently and moved to DLQ`,
          jobId: job.id,
          error: errorMsg,
          attempts: job.retryCount,
        });
      }
    }
  }

  /**
   * Checks if the queue is completely drained and idle.
   */
  private checkIdle(): void {
    if (this.queue.length === 0 && this.inFlight === 0 && this.scheduledRetries === 0) {
      while (this.idleResolvers.length > 0) {
        const resolve = this.idleResolvers.shift();
        if (resolve) resolve();
      }
    }
  }

  /**
   * Awaits until all queued and in-flight jobs have completed execution.
   */
  async drain(timeoutMs: number = 10000): Promise<void> {
    if (this.queue.length === 0 && this.inFlight === 0 && this.scheduledRetries === 0) {
      return;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`[WebhookQueue:${this.name}] drain() timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.idleResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Alias for drain() */
  async waitForIdle(timeoutMs: number = 10000): Promise<void> {
    return this.drain(timeoutMs);
  }

  /**
   * Returns real-time metrics and telemetry.
   */
  getStats(): WebhookQueueStats {
    const avgLatency =
      this.processedCount > 0 ? Math.round(this.totalProcessingTimeMs / this.processedCount) : 0;
    return {
      enqueued: this.enqueuedCount,
      processed: this.processedCount,
      failed: this.failedCount,
      inFlight: this.inFlight,
      queued: this.queue.length,
      deadLetterCount: this.deadLetterQueue.length,
      avgProcessingLatencyMs: avgLatency,
    };
  }

  /**
   * Returns a copy of the dead-letter queue.
   */
  getDeadLetterQueue() {
    return [...this.deadLetterQueue];
  }

  /**
   * Clears the queue and resets state (useful for tests).
   */
  clear(): void {
    this.queue = [];
    this.deadLetterQueue = [];
    this.inFlight = 0;
    this.scheduledRetries = 0;
    this.enqueuedCount = 0;
    this.processedCount = 0;
    this.failedCount = 0;
    this.totalProcessingTimeMs = 0;
  }
}

/** Global default Razorpay webhook queue */
export const defaultWebhookQueue = new WebhookQueue({
  name: "razorpay_default",
  concurrency: 10,
  maxRetries: 3,
});
