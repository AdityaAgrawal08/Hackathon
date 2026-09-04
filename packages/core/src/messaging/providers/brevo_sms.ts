/**
 * Brevo Transactional SMS Provider (Multi-Rail SMS Fallback)
 *
 * Implements secondary SMS delivery rail via Brevo REST API v3:
 * POST https://api.brevo.com/v3/transactionalSMS/send
 *
 * Features:
 * - GSM-compliant 11-char alphanumeric sender ("ARBITER").
 * - Zero-payday messaging for low-balance soft failures.
 * - E.164 phone normalization with +91 country code.
 * - Simulated dry-run execution when BREVO_API_KEY is not configured.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { formatINR, paise, isoUtc, logger } from "@arbiter/shared";
import type { OutreachPayload, OutreachProvider, ProviderDispatchResult } from "../types.js";
import { normalizeIndianPhone } from "./msg91.js";

export interface BrevoSmsConfig {
  apiKey?: string;
  sender?: string; // 11 alphanumeric characters max
  webUrl?: string; // Webhook callback URL for delivery status
  webhookSecret?: string;
}

export class BrevoSmsProvider implements OutreachProvider {
  readonly name = "brevo_sms";
  readonly channel = "SMS" as const;

  constructor(private config: BrevoSmsConfig = {}) {
    const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
    const rawKey = config.apiKey || (!isTest ? process.env.BREVO_API_KEY : undefined);
    this.config.apiKey = (rawKey && !rawKey.includes("xxxxxx")) ? rawKey : undefined;
    this.config.sender = (config.sender || process.env.BREVO_SMS_SENDER || "ARBITER").slice(0, 11);
    this.config.webUrl = config.webUrl || process.env.BREVO_SMS_WEBHOOK_URL;

    logger.info({
      msg: "[Brevo SMS] Constructor",
      apiKey: this.config.apiKey ? `SET (${this.config.apiKey.slice(0, 12)}...)` : "MISSING",
      sender: this.config.sender,
    });
  }

  async send(payload: OutreachPayload): Promise<ProviderDispatchResult> {
    const nowUtc = isoUtc(Date.now());
    const formattedAmount = formatINR(paise(payload.amountPaise));
    const phone = normalizeIndianPhone(payload.recipient.phone || "");
    const customerName = payload.recipient.name || payload.recipient.customerName || "Customer";
    const recoveryUrl = payload.recoveryUrl || payload.paymentLinkUrl || "";

    // Generate compliant SMS text with ZERO payday assumption
    let content: string;
    if (payload.failureClass === "SOFT_RETRYABLE") {
      content = `Payment of ${formattedAmount} could not be processed due to low balance. Please complete using an alternate bank account/UPI app or try again later: ${recoveryUrl}`;
    } else if (payload.failureClass === "HARD_METHOD_DEAD") {
      content = `Your payment method for ${formattedAmount} is expired or invalid. Please update details and complete payment: ${recoveryUrl}`;
    } else {
      content = `Your payment of ${formattedAmount} for ARBITER Store could not be completed. Please complete here: ${recoveryUrl}`;
    }

    if (!this.config.apiKey) {
      logger.info({
        msg: "[Brevo SMS] SIMULATED SMS",
        phone,
        reason: "no apiKey",
        failureClass: payload.failureClass,
        amount: formattedAmount,
        recoveryUrl,
      });

      return {
        providerName: this.name,
        channel: this.channel,
        externalMessageId: `brevo_sms_sim_${payload.proposalId}`,
        status: "SENT",
        costPaise: 0,
        dispatchedAtUtc: nowUtc,
        rawResponse: { simulated: true, sender: this.config.sender, phone, content },
        errorMessage: "SIMULATED: no BREVO_API_KEY configured. Set BREVO_API_KEY for real delivery.",
      };
    }

    const requestBody = {
      sender: this.config.sender || "ARBITER",
      recipient: phone,
      content,
      type: "transactional",
      ...(this.config.webUrl ? { webUrl: this.config.webUrl } : {}),
    };

    logger.info({ msg: "[Brevo SMS] SENDING SMS", phone, sender: this.config.sender });

    try {
      const res = await fetch("https://api.brevo.com/v3/transactionalSMS/send", {
        method: "POST",
        headers: {
          "api-key": this.config.apiKey,
          "Content-Type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      const contentType = res.headers.get("content-type") || "";
      let data: Record<string, unknown> = {};
      if (contentType.includes("application/json")) {
        data = (await res.json()) as Record<string, unknown>;
      } else {
        const text = await res.text();
        data = { message: text.slice(0, 200), raw: text };
      }

      const isSuccess = res.ok && !data.code;

      if (!isSuccess) {
        logger.error({ msg: "[Brevo SMS] FAILED", phone, httpStatus: res.status, response: data });
      } else {
        logger.info({ msg: "[Brevo SMS] SENT SMS", phone, messageId: data.messageId, response: data });
      }

      return {
        providerName: this.name,
        channel: this.channel,
        externalMessageId: String(data.messageId || data.reference || `brevo_sms_${payload.proposalId}`),
        status: isSuccess ? "SENT" : "FAILED",
        costPaise: isSuccess ? 35 : 0,
        dispatchedAtUtc: nowUtc,
        rawResponse: data,
        errorCode: isSuccess ? undefined : String(data.code || "BREVO_SMS_ERROR"),
        errorMessage: isSuccess ? undefined : String(data.message || "Failed to dispatch Brevo SMS"),
      };
    } catch (err) {
      const errorMsg = (err as Error).message;
      logger.error({ msg: "[Brevo SMS] NETWORK ERROR", phone, err: errorMsg });

      return {
        providerName: this.name,
        channel: this.channel,
        externalMessageId: `brevo_sms_err_${payload.proposalId}`,
        status: "FAILED",
        costPaise: 0,
        dispatchedAtUtc: nowUtc,
        rawResponse: { error: errorMsg },
        errorCode: "NETWORK_ERROR",
        errorMessage: errorMsg,
      };
    }
  }

  verifyWebhookSignature(rawBody: string | Buffer, signatureHeader: string): boolean {
    const secret = this.config.webhookSecret || this.config.apiKey;
    if (!secret) return false;
    const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
    const expected = createHmac("sha256", secret).update(body).digest("hex");
    try {
      return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signatureHeader, "hex"));
    } catch {
      return false;
    }
  }
}
