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
}

// DLT template IDs for reference (kept for backward compatibility)
export const MSG91_DLT_TEMPLATES: Record<FailureClassId, { dltId: string }> = {
  SOFT_RETRYABLE: { dltId: "1407168923450011" },
  HARD_METHOD_DEAD: { dltId: "1407168923450012" },
  NETWORK_TIMEOUT: { dltId: "1407168923450013" },
  RISK_FLAGGED: { dltId: "1407168923450014" },
  UNKNOWN: { dltId: "1407168923450015" },
};

export class MSG91SmsProvider implements OutreachProvider {
  readonly name = "msg91";
  readonly channel = "SMS" as const;

  constructor(private config: MSG91Config = {}) {
    const rawKey = config.authKey || process.env.MSG91_AUTH_KEY;
    const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
    this.config.authKey = (rawKey && !rawKey.includes("xxxxxx") && !isTest) ? rawKey : undefined;
    this.config.senderId = config.senderId || process.env.MSG91_SENDER_ID || "ARBITR";
    // template_id: use MSG91_TEMPLATE_ID env, fallback to MSG91_DLT_TEMPLATE_ID
    this.config.templateId = config.templateId || process.env.MSG91_TEMPLATE_ID || process.env.MSG91_DLT_TEMPLATE_ID;

    logger.info({ msg: "[MSG91] Constructor — config loaded", authKey: this.config.authKey ? 'SET (' + this.config.authKey.slice(0, 8) + '...)' : 'MISSING', templateId: this.config.templateId || 'MISSING' });
  }

  async send(payload: OutreachPayload): Promise<ProviderDispatchResult> {
    const nowUtc = isoUtc(Date.now());
    const formattedAmount = formatINR(paise(payload.amountPaise));

    // Phone: must be 91XXXXXXXXXX format (country code + 10 digits)
    // User types only 10 digits, we prepend 91
    const rawPhone = (payload.recipient.phone || "").replace(/[^0-9]/g, "");
    const phone = rawPhone.length === 10 ? `91${rawPhone}` : rawPhone;

    const customerName = payload.recipient.name || payload.recipient.customerName || "Customer";
    const recoveryUrl = payload.recoveryUrl || payload.paymentLinkUrl || "";

    // Check if we can send for real
    const hasAuthKey = !!this.config.authKey;
    const hasTemplateId = !!this.config.templateId;

    if (!hasAuthKey || !hasTemplateId) {
      const reason = !hasAuthKey ? "no authKey" : `no templateId`;
      logger.info({ msg: "[MSG91] SIMULATED SMS", phone, reason, failureClass: payload.failureClass, amount: formattedAmount, recoveryUrl });
      return {
        providerName: this.name,
        channel: this.channel,
        externalMessageId: `msg91_sim_${payload.proposalId}`,
        status: "SENT",
        costPaise: 0,
        dispatchedAtUtc: nowUtc,
        rawResponse: { simulated: true, templateId: this.config.templateId, phone, reason },
        errorMessage: `SIMULATED: ${reason}. Set MSG91_AUTH_KEY and MSG91_TEMPLATE_ID for real delivery.`,
      };
    }

    // Build MSG91 Flow API v5 request
    // Variables MUST match what's configured in the MSG91 flow template (case-sensitive)
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
    };

    const flowBody = {
      template_id: this.config.templateId,
      short_url: "1",
      recipients: [recipientObj],
    };

    logger.info({ msg: "[MSG91] SENDING SMS", phone, templateId: this.config.templateId, body: flowBody });

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

      const data = (await res.json()) as Record<string, unknown>;
      const isSuccess = data.type === "success" || res.ok;

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
