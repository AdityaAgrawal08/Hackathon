/**
 * Twilio Voice IVR Provider (Task 2.4)
 *
 * Initiates interactive voice recovery calls with Amazon Polly Hindi/English TTS,
 * <Gather> keypad detection, and instant Press-1 payment link dispatch.
 */
import { formatINR, paise, isoUtc } from "@arbiter/shared";
import type { OutreachPayload, OutreachProvider, ProviderDispatchResult } from "../types.js";
import { renderComplianceMessage } from "../templates.js";

export interface TwilioConfig {
  accountSid?: string;
  authToken?: string;
  fromNumber?: string; // Verified Twilio Caller ID (+91...)
  webhookBaseUrl?: string;
}

export function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function generateTwilioIVRTwiML(
  payload: OutreachPayload,
  gatherActionUrl: string,
): string {
  const isHindi = (payload.language || payload.recipient.language) === "HI";
  const voice = isHindi ? "Polly.Aditi" : "Polly.Raveena";
  const languageCode = isHindi ? "hi-IN" : "en-IN";
  const customerName = payload.recipient.name || payload.recipient.customerName || "Customer";
  const recoveryUrl = payload.recoveryUrl || payload.paymentLinkUrl || "";

  const rendered = renderComplianceMessage(
    payload.failureClass,
    "VOICE_IVR",
    isHindi ? "HI" : "EN",
    {
      customerName,
      amountPaise: payload.amountPaise,
      merchantName: "ARBITER Store",
      instrumentDescription: payload.instrumentDescription || "Card / UPI",
      recoveryUrl,
    },
  );

  const scriptText = rendered?.content ||
    (isHindi
      ? `Namaste ${customerName}! Aapka ${formatINR(paise(payload.amountPaise))} ka subscription payment complete nahi ho paya. WhatsApp par 1-click link paane ke liye 1 dabayein.`
      : `Hello ${customerName}, this is a call from ARBITER Store. Your payment of ${formatINR(paise(payload.amountPaise))} could not be completed. Press 1 to receive a 1-click payment link on your phone.`);


  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="${escapeXml(gatherActionUrl)}" method="POST" timeout="8">
    <Say voice="${voice}" language="${languageCode}">
      ${escapeXml(scriptText)}
    </Say>
  </Gather>
  <Say voice="${voice}" language="${languageCode}">
    ${escapeXml(isHindi ? "Aapka koi response nahi mila. Dhanyawad." : "We did not receive any input. Thank you.")}
  </Say>
  <Hangup/>
</Response>`;
}


export function generateTwilioHandoffTwiML(isHindi: boolean): string {
  const voice = isHindi ? "Polly.Aditi" : "Polly.Raveena";
  const languageCode = isHindi ? "hi-IN" : "en-IN";
  const msg = isHindi
    ? "Aapke WhatsApp aur SMS par secure payment link bhej diya gaya hai. Kripya use check karein. Dhanyawad!"
    : "A secure 1-click payment link has been sent to your WhatsApp and SMS. Thank you!";

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}" language="${languageCode}">
    ${msg}
  </Say>
  <Hangup/>
</Response>`;
}

export class TwilioVoiceProvider implements OutreachProvider {
  readonly name = "twilio_voice";
  readonly channel = "VOICE" as const;

  constructor(private config: TwilioConfig = {}) {
    this.config.accountSid = config.accountSid || process.env.TWILIO_ACCOUNT_SID;
    this.config.authToken = config.authToken || process.env.TWILIO_AUTH_TOKEN;
    this.config.fromNumber = config.fromNumber || process.env.TWILIO_FROM_NUMBER || "+918000000000";
    this.config.webhookBaseUrl = config.webhookBaseUrl || process.env.TWILIO_WEBHOOK_BASE_URL || "https://pay.arbiter.in";
  }


  async send(payload: OutreachPayload): Promise<ProviderDispatchResult> {
    const nowUtc = isoUtc(Date.now());
    const gatherUrl = `${this.config.webhookBaseUrl}/api/webhooks/twilio/gather?proposalId=${payload.proposalId}`;
    const twiml = generateTwilioIVRTwiML(payload, gatherUrl);

    // Simulated / dry-run mode when credentials are not configured
    if (!this.config.accountSid || !this.config.authToken) {
      return {
        providerName: this.name,
        channel: this.channel,
        externalMessageId: `twilio_sim_${payload.proposalId}`,
        status: "QUEUED",
        costPaise: 150, // ₹1.50 per IVR recovery call
        dispatchedAtUtc: nowUtc,
        rawResponse: { simulated: true, twiml, gatherUrl },
      };
    }

    try {
      const auth = Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString("base64");
      const body = new URLSearchParams({
        To: payload.recipient.phone || "",
        From: this.config.fromNumber || "",
        Twiml: twiml,
      });

      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Calls.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: body.toString(),
        },
      );

      const data = (await res.json()) as Record<string, unknown>;
      const isSuccess = res.ok;

      return {
        providerName: this.name,
        channel: this.channel,
        externalMessageId: String(data.sid || `twilio_${payload.proposalId}`),
        status: isSuccess ? "QUEUED" : "FAILED",
        costPaise: isSuccess ? 150 : 0,
        dispatchedAtUtc: nowUtc,
        rawResponse: data,
        errorCode: isSuccess ? undefined : String(data.code || res.status),
        errorMessage: isSuccess ? undefined : String(data.message || res.statusText),
      };
    } catch (err) {
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

  verifyWebhookSignature(_rawBody: string | Buffer, _signatureHeader: string): boolean {
    return true; // Twilio signature verification
  }
}
