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
    const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
    const rawKey = config.apiKey || (!isTest ? process.env.BREVO_API_KEY : undefined);
    this.config.apiKey = (rawKey && !rawKey.includes("xxxxxx")) ? rawKey : undefined;
    this.config.senderEmail = config.senderEmail || process.env.BREVO_SENDER_EMAIL || undefined;
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
        customerEmail: payload.recipient.email || "",
        customerPhone: payload.recipient.phone || "",
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

    // Build professional customer details + GROQ-polished reason for email body
    const customerDetailsHtml = `
    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 16px; margin: 0 0 16px 0;">
      <p style="font-size: 13px; color: #64748b; margin: 0 0 10px 0; text-transform: uppercase; letter-spacing: 0.5px;">Transaction Details</p>
      <table style="font-size: 13px; color: #334155; width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 4px 8px; color: #64748b; width: 110px;">Customer</td><td style="padding: 4px 8px;"><strong>${escapeHtml(customerName)}</strong></td></tr>
        ${payload.recipient.email ? `<tr><td style="padding: 4px 8px; color: #64748b;">Email</td><td style="padding: 4px 8px;">${escapeHtml(payload.recipient.email)}</td></tr>` : ""}
        ${payload.recipient.phone ? `<tr><td style="padding: 4px 8px; color: #64748b;">Phone</td><td style="padding: 4px 8px;">${escapeHtml(payload.recipient.phone)}</td></tr>` : ""}
        <tr><td style="padding: 4px 8px; color: #64748b;">Amount</td><td style="padding: 4px 8px;"><strong>${formattedAmount}</strong></td></tr>
        <tr><td style="padding: 4px 8px; color: #64748b;">Transaction ID</td><td style="padding: 4px 8px;"><code style="background: #f1f5f9; padding: 2px 6px; border-radius: 3px;">${escapeHtml(payload.proposalId)}</code></td></tr>
        ${payload.instrumentDescription ? `<tr><td style="padding: 4px 8px; color: #64748b;">Payment</td><td style="padding: 4px 8px;">${escapeHtml(payload.instrumentDescription)}</td></tr>` : ""}
      </table>
    </div>`.trim();

    const groqReasonHtml = methodSpecificText
      ? `<div style="background: #fef2f2; border-left: 4px solid #dc2626; padding: 12px 16px; border-radius: 0 6px 6px 0; margin: 0 0 16px 0;">
           <p style="font-size: 14px; color: #991b1b; font-weight: 600; margin: 0 0 4px 0;">Why your payment failed:</p>
           <p style="font-size: 14px; color: #475569; margin: 0;">${escapeHtml(methodSpecificText)}</p>
         </div>`
      : "";

    const htmlContent = `
<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: #0f172a; padding: 24px; border-radius: 8px 8px 0 0; text-align: center;">
    <h1 style="color: #ffffff; margin: 0; font-size: 20px; letter-spacing: 1px;">ARBITER RECOVERY</h1>
    <p style="color: #94a3b8; margin: 8px 0 0 0; font-size: 13px;">Hi ${escapeHtml(customerName)} — your payment needs attention</p>
  </div>
  <div style="background: #ffffff; padding: 32px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 8px 8px;">
    ${customerDetailsHtml}
    ${groqReasonHtml}
    <div style="background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 6px; padding: 16px; margin: 0 0 24px 0;">
      <p style="font-size: 14px; color: #0c4a6e; margin: 0 0 12px 0; font-weight: 600;">What to do:</p>
      <p style="font-size: 13px; color: #475569; margin: 0;">Click the secure link below to retry. This link is unique to your transaction — if you've already paid, it will show your payment confirmation.</p>
    </div>
    <div style="margin: 0 0 24px 0; text-align: center;">
      <a href="${escapeHtml(recoveryUrl)}" style="background: #2563eb; color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
        Retry Payment — ${formattedAmount}
      </a>
      <p style="font-size: 11px; color: #94a3b8; margin: 8px 0 0 0;">Secure link for transaction ${escapeHtml(payload.proposalId.slice(0, 8))}…</p>
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
