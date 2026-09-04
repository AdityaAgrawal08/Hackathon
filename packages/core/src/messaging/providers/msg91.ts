/**
 * MSG91 Indian DLT SMS Provider (Task 2.3)
 *
 * Dispatches recovery SMS notifications through MSG91 Flow API using
 * registered TRAI DLT templates.
 *
 * API Format (v5/flow):
 * POST https://control.msg91.com/api/v5/flow
 * {
 *   "template_id": "your_template_id",
 *   "short_url": "1",
 *   "recipients": [
 *     {
 *       "mobiles": "919XXXXXXXXX",
 *       "VAR1": "value",
 *       "VAR2": "value"
 *     }
 *   ]
 * }
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { formatINR, paise, isoUtc, logger } from "@arbiter/shared";
import type { FailureClassId } from "../../decide/catalog.js";
import type { OutreachPayload, OutreachProvider, ProviderDispatchResult } from "../types.js";
import { msg91SmsLimiter } from "../rate_limiter.js";

export interface MSG91Config {
  authKey?: string;
  senderId?: string; // e.g. "ARBITR"
  webhookSecret?: string;
  dltTemplateId?: string;
  templateId?: string;
  flowId?: string;
  batchWindowMs?: number; // micro-batching window in ms (default 250ms in prod, 0 in test)
  maxBatchSize?: number;  // maximum recipients per micro-batch (default 50)
}

// DLT template IDs for reference (kept for backward compatibility)
export const MSG91_DLT_TEMPLATES: Record<FailureClassId, { dltId: string }> = {
  SOFT_RETRYABLE: { dltId: "1407168923450011" },
  HARD_METHOD_DEAD: { dltId: "1407168923450012" },
  NETWORK_TIMEOUT: { dltId: "1407168923450013" },
  RISK_FLAGGED: { dltId: "1407168923450014" },
  UNKNOWN: { dltId: "1407168923450015" },
};

/**
 * Normalizes any Indian phone representation into canonical E.164 without leading plus (91XXXXXXXXXX).
 * Handles 10-digit, 11-digit with leading 0, and 12-digit with 91 country code.
 */
export function normalizeIndianPhone(raw: string): string {
  const digits = (raw || "").replace(/[^0-9]/g, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `91${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  return digits;
}

export class MSG91SmsProvider implements OutreachProvider {
  readonly name = "msg91";
  readonly channel = "SMS" as const;

  private pendingBatch: Array<{
    payload: OutreachPayload;
    recipientObj: Record<string, string>;
    isSimulated: boolean;
    isPlaceholderTemplate: boolean;
    simReason?: string;
    resolve: (result: ProviderDispatchResult) => void;
    reject: (err: any) => void;
  }> = [];
  private batchTimer: NodeJS.Timeout | null = null;

  constructor(private config: MSG91Config = {}) {
    const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
    const rawKey = config.authKey || (!isTest ? process.env.MSG91_AUTH_KEY : undefined);
    this.config.authKey = (rawKey && !rawKey.includes("xxxxxx")) ? rawKey : undefined;
    this.config.senderId = config.senderId || process.env.MSG91_SENDER_ID || "ARBITR";
    this.config.batchWindowMs = config.batchWindowMs !== undefined ? config.batchWindowMs : (isTest ? 0 : 250);
    this.config.maxBatchSize = config.maxBatchSize || 50;

    // template_id: support MSG91_FLOW_ID, MSG91_TEMPLATE_ID, or MSG91_DLT_TEMPLATE_ID
    this.config.templateId =
      config.flowId ||
      config.templateId ||
      process.env.MSG91_FLOW_ID ||
      process.env.MSG91_TEMPLATE_ID ||
      process.env.MSG91_DLT_TEMPLATE_ID;

    logger.info({
      msg: "[MSG91] Constructor — config loaded",
      authKey: this.config.authKey ? "SET (" + this.config.authKey.slice(0, 8) + "...)" : "MISSING",
      templateId: this.config.templateId || "MISSING",
      sender: this.config.senderId,
      batchWindowMs: this.config.batchWindowMs,
      maxBatchSize: this.config.maxBatchSize,
    });
  }

  getPendingBatchSize(): number {
    return this.pendingBatch.length;
  }

  async send(payload: OutreachPayload): Promise<ProviderDispatchResult> {
    const nowUtc = isoUtc(Date.now());
    const formattedAmount = formatINR(paise(payload.amountPaise));
    const phone = normalizeIndianPhone(payload.recipient.phone || "");

    const customerName = payload.recipient.name || payload.recipient.customerName || "Customer";
    const recoveryUrl = payload.recoveryUrl || payload.paymentLinkUrl || "";

    // Check if we can send for real
    const hasAuthKey = !!this.config.authKey;
    const hasTemplateId = !!this.config.templateId;
    const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
    const isPlaceholderTemplate =
      !isTest &&
      hasTemplateId &&
      (this.config.templateId === "flow_insufficient_01" ||
       this.config.templateId === "1407168923450011");

    if (!hasAuthKey || !hasTemplateId || isPlaceholderTemplate) {
      const reason = !hasAuthKey
        ? "no authKey"
        : (!hasTemplateId ? "no templateId" : `placeholder templateId (${this.config.templateId})`);
      logger.info({ msg: "[MSG91] SIMULATED SMS", phone, reason, failureClass: payload.failureClass, amount: formattedAmount, recoveryUrl });
      
      // If batching is enabled, enqueue into batch even in simulation mode so tests can verify aggregation
      if (this.config.batchWindowMs && this.config.batchWindowMs > 0) {
        return new Promise<ProviderDispatchResult>((resolve, reject) => {
          this.pendingBatch.push({
            payload,
            recipientObj: {
              mobiles: phone,
              name: customerName,
              amount: formattedAmount,
              url: recoveryUrl,
              VAR1: customerName,
              VAR2: formattedAmount,
              VAR3: recoveryUrl,
              VAR4: "ARBITER Store",
            },
            isSimulated: true,
            isPlaceholderTemplate: !!isPlaceholderTemplate,
            simReason: reason,
            resolve,
            reject,
          });

          if (this.pendingBatch.length >= (this.config.maxBatchSize || 50)) {
            this.flushBatch();
          } else if (!this.batchTimer) {
            this.batchTimer = setTimeout(() => this.flushBatch(), this.config.batchWindowMs);
          }
        });
      }

      return {
        providerName: this.name,
        channel: this.channel,
        externalMessageId: `msg91_sim_${payload.proposalId}`,
        status: isPlaceholderTemplate ? "FAILED" : "SENT",
        costPaise: 0,
        dispatchedAtUtc: nowUtc,
        rawResponse: { simulated: true, templateId: this.config.templateId, phone, reason },
        errorMessage: isPlaceholderTemplate
          ? `FAILED: templateId is a placeholder (${this.config.templateId}). Configure an approved Flow ID from MSG91 dashboard for live delivery.`
          : `SIMULATED: ${reason}. Configure an approved 24-character MSG91_FLOW_ID for live delivery.`,
      };
    }

    // Build MSG91 Flow API v5 request with dual semantic + positional dictionaries
    const recipientObj: Record<string, string> = {
      mobiles: phone,
      name: customerName,
      amount: formattedAmount,
      merchant: "ARBITER Store",
      method: payload.instrumentDescription || "Card / UPI",
      url: recoveryUrl,
      failure_reason: payload.rawErrorReason || "Payment failed",
      method_type: payload.method || "",
      last4: payload.last4 || "",
      network: payload.network || "",
      vpa: payload.vpa || "",
      bank: payload.bank || "",
      // Positional token fallbacks for DLT Flow templates
      VAR1: customerName,
      VAR2: formattedAmount,
      VAR3: recoveryUrl,
      VAR4: "ARBITER Store",
      var1: customerName,
      var2: formattedAmount,
      var3: recoveryUrl,
      var4: "ARBITER Store",
      "1": customerName,
      "2": formattedAmount,
      "3": recoveryUrl,
      "4": "ARBITER Store",
    };

    // Micro-Batching Aggregator (Phase 2)
    if (this.config.batchWindowMs && this.config.batchWindowMs > 0) {
      return new Promise<ProviderDispatchResult>((resolve, reject) => {
        this.pendingBatch.push({
          payload,
          recipientObj,
          isSimulated: false,
          isPlaceholderTemplate: false,
          resolve,
          reject,
        });

        if (this.pendingBatch.length >= (this.config.maxBatchSize || 50)) {
          this.flushBatch();
        } else if (!this.batchTimer) {
          this.batchTimer = setTimeout(() => this.flushBatch(), this.config.batchWindowMs);
        }
      });
    }

    // Direct single send (when batchWindowMs is 0)
    // Rate limit outbound SMS to MSG91 Flow API (50 req/sec)
    const acquired = await msg91SmsLimiter.acquire(1, 2000);
    if (!acquired) {
      logger.warn({ msg: "[MSG91] Rate limit timeout (50 req/sec) reached. Failing safely", phone });
      return {
        providerName: this.name,
        channel: this.channel,
        externalMessageId: "",
        status: "FAILED",
        costPaise: 0,
        dispatchedAtUtc: nowUtc,
        errorCode: "RATE_LIMIT_EXCEEDED",
        errorMessage: "MSG91 outbound rate limit (50 req/sec) exceeded",
      };
    }

    const flowBody = {
      template_id: this.config.templateId,
      sender: this.config.senderId || "ARBITR",
      short_url: "0",
      recipients: [recipientObj],
    };

    logger.info({ msg: "[MSG91] SENDING SMS", phone, templateId: this.config.templateId, sender: this.config.senderId, body: flowBody });

    try {
      const res = await fetch("https://control.msg91.com/api/v5/flow", {
        method: "POST",
        headers: {
          authkey: this.config.authKey!,
          "Content-Type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(flowBody),
      });

      const contentType = res.headers.get("content-type") || "";
      let data: Record<string, unknown> = {};
      if (contentType.includes("application/json")) {
        data = (await res.json()) as Record<string, unknown>;
      } else {
        const text = await res.text();
        data = { message: text.slice(0, 200), raw: text };
      }

      // Hardened check: HTTP 200 with {"type":"error"} must be marked FAILED
      const hasErrorType = data.type === "error" || data.status === "error";
      const hasErrorsList = Array.isArray(data.errors) && data.errors.length > 0;
      const isSuccess = res.ok && !hasErrorType && !hasErrorsList;

      if (!isSuccess) {
        logger.error({ msg: "[MSG91] FAILED", phone, httpStatus: res.status, response: data });
      } else {
        logger.info({ msg: "[MSG91] SENT SMS", phone, requestId: data.request_id, response: data });
      }

      return {
        providerName: this.name,
        channel: this.channel,
        externalMessageId: String(data.message || data.request_id || `msg91_${payload.proposalId}`),
        status: isSuccess ? "SENT" : "FAILED",
        costPaise: isSuccess ? 25 : 0,
        dispatchedAtUtc: nowUtc,
        rawResponse: data,
        errorCode: isSuccess ? undefined : String(data.code || "MSG91_ERROR"),
        errorMessage: isSuccess ? undefined : String(data.message || "Failed to dispatch SMS"),
      };
    } catch (err) {
      logger.error({ msg: "[MSG91] NETWORK ERROR", phone, err });
      return {
        providerName: this.name,
        channel: this.channel,
        externalMessageId: "",
        status: "FAILED",
        costPaise: 0,
        dispatchedAtUtc: nowUtc,
        errorMessage: (err as Error).message,
      };
    }
  }

  /**
   * Flushes all pending buffered recipients immediately.
   */
  async flush(): Promise<void> {
    while (this.pendingBatch.length > 0) {
      await this.flushBatch();
    }
  }

  /**
   * Dispatches up to maxBatchSize buffered SMS messages in a single HTTP request.
   */
  private async flushBatch(): Promise<void> {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    if (this.pendingBatch.length === 0) return;

    const batch = this.pendingBatch.splice(0, this.config.maxBatchSize || 50);
    const nowUtc = isoUtc(Date.now());

    // Check if entire batch is simulated
    const allSimulated = batch.every((item) => item.isSimulated);
    if (allSimulated) {
      for (const item of batch) {
        const formattedAmount = formatINR(paise(item.payload.amountPaise));
        const phone = normalizeIndianPhone(item.payload.recipient.phone || "");
        const recoveryUrl = item.payload.recoveryUrl || item.payload.paymentLinkUrl || "";
        logger.info({
          msg: "[MSG91] SIMULATED BATCH SMS",
          phone,
          reason: item.simReason,
          failureClass: item.payload.failureClass,
          amount: formattedAmount,
          recoveryUrl,
          batchSize: batch.length,
        });
        item.resolve({
          providerName: this.name,
          channel: this.channel,
          externalMessageId: `msg91_sim_batch_${item.payload.proposalId}`,
          status: item.isPlaceholderTemplate ? "FAILED" : "SENT",
          costPaise: 0,
          dispatchedAtUtc: nowUtc,
          rawResponse: { simulated: true, batchSize: batch.length, templateId: this.config.templateId, phone, reason: item.simReason },
          errorMessage: item.isPlaceholderTemplate
            ? `FAILED: templateId is a placeholder (${this.config.templateId}). Configure an approved Flow ID from MSG91 dashboard for live delivery.`
            : `SIMULATED: ${item.simReason}. Configure an approved 24-character MSG91_FLOW_ID for live delivery.`,
        });
      }
      return;
    }

    // Rate limit outbound batch to MSG91 Flow API
    const acquired = await msg91SmsLimiter.acquire(1, 2000);
    if (!acquired) {
      logger.warn({ msg: "[MSG91] Rate limit timeout (50 req/sec) reached on batch dispatch", batchSize: batch.length });
      for (const item of batch) {
        item.resolve({
          providerName: this.name,
          channel: this.channel,
          externalMessageId: "",
          status: "FAILED",
          costPaise: 0,
          dispatchedAtUtc: nowUtc,
          errorCode: "RATE_LIMIT_EXCEEDED",
          errorMessage: "MSG91 outbound rate limit (50 req/sec) exceeded",
        });
      }
      return;
    }

    const flowBody = {
      template_id: this.config.templateId,
      sender: this.config.senderId || "ARBITR",
      short_url: "0",
      recipients: batch.map((item) => item.recipientObj),
    };

    logger.info({
      msg: "[MSG91] SENDING BATCH SMS",
      batchSize: batch.length,
      templateId: this.config.templateId,
      sender: this.config.senderId,
    });

    try {
      const res = await fetch("https://control.msg91.com/api/v5/flow", {
        method: "POST",
        headers: {
          authkey: this.config.authKey!,
          "Content-Type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(flowBody),
      });

      const contentType = res.headers.get("content-type") || "";
      let data: Record<string, unknown> = {};
      if (contentType.includes("application/json")) {
        data = (await res.json()) as Record<string, unknown>;
      } else {
        const text = await res.text();
        data = { message: text.slice(0, 200), raw: text };
      }

      const hasErrorType = data.type === "error" || data.status === "error";
      const hasErrorsList = Array.isArray(data.errors) && data.errors.length > 0;
      const isSuccess = res.ok && !hasErrorType && !hasErrorsList;

      for (const item of batch) {
        item.resolve({
          providerName: this.name,
          channel: this.channel,
          externalMessageId: String(data.message || data.request_id || `msg91_b_${item.payload.proposalId}`),
          status: isSuccess ? "SENT" : "FAILED",
          costPaise: isSuccess ? 25 : 0,
          dispatchedAtUtc: nowUtc,
          rawResponse: data,
          errorCode: isSuccess ? undefined : String(data.code || "MSG91_ERROR"),
          errorMessage: isSuccess ? undefined : String(data.message || "Failed to dispatch batch SMS"),
        });
      }
    } catch (err: any) {
      logger.error({ msg: "[MSG91] BATCH NETWORK ERROR", err });
      for (const item of batch) {
        item.resolve({
          providerName: this.name,
          channel: this.channel,
          externalMessageId: "",
          status: "FAILED",
          costPaise: 0,
          dispatchedAtUtc: nowUtc,
          errorMessage: err.message || String(err),
        });
      }
    }
  }

  verifyWebhookSignature(rawBody: string | Buffer, signatureHeader: string): boolean {
    // MSG91 webhooks are verified via authkey-based HMAC
    const authKey = this.config.authKey;
    if (!authKey) {
      logger.warn({ msg: "[MSG91] No auth key configured — webhook verification skipped (insecure)" });
      return false;
    }
    const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
    const expected = createHmac("sha256", authKey).update(body).digest("hex");
    try {
      return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signatureHeader, "hex"));
    } catch {
      return false;
    }
  }
}
