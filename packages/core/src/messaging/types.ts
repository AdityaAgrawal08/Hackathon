/**
 * Unified Provider Abstraction Types (Task 2.1)
 *
 * Defines the polymorphic contract for all outreach communication channels
 * (Brevo Email, MSG91 SMS, Twilio Voice IVR, Gupshup WhatsApp).
 */
import type { FailureClassId } from "../decide/catalog.js";

export type OutreachChannel = "EMAIL" | "SMS" | "VOICE" | "WHATSAPP";

export interface RecipientProfile {
  customerId: string;
  name: string;
  email?: string;
  phone?: string; // E.164 format (+91...)
  language: "EN" | "HI";
}

export interface OutreachPayload {
  tenantId: string;
  proposalId: string;
  idempotencyKey: string;
  recipient: RecipientProfile;
  amountPaise: number;
  failureClass: FailureClassId;
  instrumentDescription: string;
  recoveryUrl: string;
  scheduledForUtc?: string;
}

export type DispatchStatus =
  | "QUEUED"
  | "SENT"
  | "DELIVERED"
  | "FAILED"
  | "SUPPRESSED_DND"
  | "SUPPRESSED_QUIET_HOURS";

export interface ProviderDispatchResult {
  providerName: string;
  channel: OutreachChannel;
  externalMessageId: string;
  status: DispatchStatus;
  costPaise: number;
  dispatchedAtUtc: string;
  rawResponse?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
}

export interface OutreachProvider {
  readonly name: string;
  readonly channel: OutreachChannel;
  send(payload: OutreachPayload): Promise<ProviderDispatchResult>;
  verifyWebhookSignature(rawBody: string | Buffer, signatureHeader: string): boolean;
}
