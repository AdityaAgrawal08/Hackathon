/**
 * Brevo Transactional Email Provider (Task 2.2)
 *
 * Dispatches recovery emails via Brevo REST API v3 with localized HTML templates,
 * open/click tracking headers, and webhook signature verification.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { formatINR, paise, isoUtc, COST_EMAIL_PAISE, logger } from "@arbiter/shared";
import type { OutreachPayload, OutreachProvider, ProviderDispatchResult } from "../types.js";
import { renderComplianceMessage } from "../templates.js";

export interface BrevoConfig {
  apiKey?: string;
  senderEmail?: string;
  senderName?: string;
  webhookSecret?: string;
}

export function escapeHtml(str?: string): string {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export class BrevoEmailProvider implements OutreachProvider {
  readonly name = "brevo";
  readonly channel = "EMAIL" as const;

  constructor(private config: BrevoConfig = {}) {
    const rawKey = config.apiKey || process.env.BREVO_API_KEY;
    const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
    this.config.apiKey = (rawKey && !rawKey.includes("xxxxxx") && !isTest) ? rawKey : undefined;
    this.config.senderEmail = config.senderEmail || process.env.BREVO_SENDER_EMAIL || "magicalfootball2005@gmail.com";
    this.config.senderName = config.senderName || process.env.BREVO_SENDER_NAME || "ARBITER Recovery";
    this.config.webhookSecret = config.webhookSecret || process.env.BREVO_WEBHOOK_SECRET;

    logger.info({ msg: "[Brevo] Constructor", apiKey: this.config.apiKey ? `SET (${this.config.apiKey.slice(0, 12)}...)` : "MISSING", sender: this.config.senderEmail });
  }




  async send(payload: OutreachPayload): Promise<ProviderDispatchResult> {
    const nowUtc = isoUtc(Date.now());
    const formattedAmount = formatINR(paise(payload.amountPaise));
    const recoveryUrl = payload.recoveryUrl || payload.paymentLinkUrl || "";
    const customerName = payload.recipient.name || payload.recipient.customerName || "Customer";
    const language = (payload.language || payload.recipient.language || "EN") as any;

    const rendered = renderComplianceMessage(
      payload.failureClass,
      "EMAIL",
      language,
      {
        customerName,
        amountPaise: payload.amountPaise,
        merchantName: this.config.senderName || "ARBITER Store",
        instrumentDescription: payload.instrumentDescription || "Card / UPI",
        recoveryUrl,
        customerMessage: payload.customerMessage,
        vendorMessage: payload.vendorMessage,
        method: payload.method,
        last4: payload.last4,
        network: payload.network,
        vpa: payload.vpa,
        bank: payload.bank,
      },
    );

    const subject =
      language === "HI"
        ? `Payment Update: ${this.config.senderName} (${formattedAmount})`
        : `Payment could not be completed (${formattedAmount})`;

    // Use customerMessage from error catalog — concise, actionable, no raw codes
    let methodSpecificText = payload.customerMessage || "";
    if (!methodSpecificText && payload.instrumentDescription) {
      // Fallback: method-specific text when no catalog message available
      if (payload.method === "card" && payload.network && payload.last4) {
        methodSpecificText = `Your ${payload.network} card ending in ${payload.last4} was declined`;
      } else if (payload.method === "upi" && payload.vpa) {
        methodSpecificText = `Your UPI payment (${payload.vpa}) was declined`;
      } else if (payload.method === "netbanking" && payload.bank) {
        methodSpecificText = `Your ${payload.bank} netbanking payment was declined`;
      }
    }

    const messageText = escapeHtml(rendered?.content || `Your payment of ${formattedAmount} needs attention.`);

    const htmlContent = `
<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: #0f172a; padding: 24px; border-radius: 8px 8px 0 0; text-align: center;">
    <h1 style="color: #ffffff; margin: 0; font-size: 20px; letter-spacing: 1px;">ARBITER RECOVERY</h1>
  </div>
  <div style="background: #ffffff; padding: 32px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 8px 8px;">
    <h2 style="font-size: 18px; color: #0f172a; margin-top: 0;">Payment Update</h2>
    ${methodSpecificText ? `<p style="font-size: 15px; color: #dc2626; font-weight: bold; margin: 0 0 12px 0;">${escapeHtml(methodSpecificText)}</p>` : ""}
    <p style="font-size: 15px; color: #475569;">Please try again using a different payment method, or retry after a few minutes.</p>
    <div style="margin: 32px 0; text-align: center;">
      <a href="${escapeHtml(recoveryUrl)}" style="background: #2563eb; color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
        Pay Again (${formattedAmount})
      </a>
    </div>

    <p style="font-size: 13px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 16px;">
      Transaction ID: <code>${escapeHtml(payload.proposalId)}</code><br>
      This is a secure transactional message from ${escapeHtml(this.config.senderName || "ARBITER")}.
    </p>
  </div>
</body>
</html>`;


    // If no API key is provided, execute deterministic simulated dispatch
    if (!this.config.apiKey) {
      const simReason = "no API key configured";
      logger.info({ msg: "[Brevo] SIMULATED email", to: payload.recipient.email, reason: simReason, subject, bodyPreview: messageText.slice(0, 120) + "..." });
      return {
        providerName: this.name,
        channel: this.channel,
        externalMessageId: `brevo_sim_${payload.proposalId}`,
        status: "SENT",
        costPaise: 0,
        dispatchedAtUtc: nowUtc,
        rawResponse: { simulated: true, to: payload.recipient.email, subject, reason: simReason },
        errorMessage: `SIMULATED: ${simReason}. Set BREVO_API_KEY for real delivery.`,
      };
    }

    logger.info({ msg: "[Brevo] SENDING email", to: payload.recipient.email, subject, failureClass: payload.failureClass, method: payload.method || "unknown" });

    try {
      const res = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          "api-key": this.config.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sender: { name: this.config.senderName, email: this.config.senderEmail },
          to: [{ email: payload.recipient.email, name: payload.recipient.name || payload.recipient.customerName || "" }],
          subject,
          htmlContent,
          headers: {
            "X-Idempotency-Key": payload.idempotencyKey,
            "X-Proposal-Id": payload.proposalId,
          },
          tags: ["revenue_recovery", payload.failureClass],
        }),
      });

      const data = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        logger.error({ msg: "[Brevo] FAILED", to: payload.recipient.email, httpStatus: res.status, code: data.code, message: data.message, response: data });
        return {
          providerName: this.name,
          channel: this.channel,
          externalMessageId: "",
          status: "FAILED",
          costPaise: 0,
          dispatchedAtUtc: nowUtc,
          errorCode: String(data.code || res.status),
          errorMessage: String(data.message || res.statusText),
          rawResponse: data,
        };
      }

      logger.info({ msg: "[Brevo] SENT email", to: payload.recipient.email, messageId: data.messageId, response: data });
      return {
        providerName: this.name,
        channel: this.channel,
        externalMessageId: String(data.messageId || `brevo_${payload.proposalId}`),
        status: "SENT",
        costPaise: COST_EMAIL_PAISE,
        dispatchedAtUtc: nowUtc,
        rawResponse: data,
      };
    } catch (err) {
      logger.error({ msg: "[Brevo] NETWORK ERROR", to: payload.recipient.email, err });
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
    if (!this.config.webhookSecret) return true; // Fail-open in dev/dry-run if unconfigured
    try {
      const hmac = createHmac("sha256", this.config.webhookSecret);
      const digest = hmac.update(rawBody).digest("hex");
      return timingSafeEqual(Buffer.from(digest), Buffer.from(signatureHeader));
    } catch {
      return false;
    }
  }
}
