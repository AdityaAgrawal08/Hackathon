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

export interface MSG91Config {
  authKey?: string;
  senderId?: string; // e.g. "ARBITR"
  webhookSecret?: string;
  dltTemplateId?: string;
  templateId?: string;
  flowId?: string;
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

  constructor(private config: MSG91Config = {}) {
    const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
    const rawKey = config.authKey || (!isTest ? process.env.MSG91_AUTH_KEY : undefined);
    this.config.authKey = (rawKey && !rawKey.includes("xxxxxx")) ? rawKey : undefined;
    this.config.senderId = config.senderId || process.env.MSG91_SENDER_ID || "ARBITR";
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
    });
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
