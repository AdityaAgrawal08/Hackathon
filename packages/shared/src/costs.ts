/**
 * Provider cost configuration — extracted from hardcoded values (C-007).
 *
 * Costs are read from environment variables with documented defaults.
 * All values are in integer paise (Invariant I-5).
 *
 * Env vars:
 *   COST_SMS_Paise        — per SMS message (default: 250 = ₹2.50)
 *   COST_EMAIL_Paise      — per email (default: 150 = ₹1.50)
 *   COST_VOICE_Paise      — per voice minute (default: 800 = ₹8.00)
 *   COST_WHATSAPP_Paise   — per WhatsApp message (default: 120 = ₹1.20)
 *   COST_CONTROL_RETRY_Paise — per naive retry in control arm (default: 1500 = ₹15.00)
 */

/** Per-SMS cost in paise. Default: 250 (₹2.50) */
export const COST_SMS_PAISE: number = parseCost("COST_SMS_PAISE", 250);

/** Per-email cost in paise. Default: 150 (₹1.50) */
export const COST_EMAIL_PAISE: number = parseCost("COST_EMAIL_PAISE", 150);

/** Per-voice-minute cost in paise. Default: 800 (₹8.00) */
export const COST_VOICE_PAISE: number = parseCost("COST_VOICE_PAISE", 800);

/** Per-WhatsApp message cost in paise. Default: 120 (₹1.20) */
export const COST_WHATSAPP_PAISE: number = parseCost("COST_WHATSAPP_PAISE", 120);

/** Per naive retry in control arm (paise). Default: 1500 (₹15.00) */
export const COST_CONTROL_RETRY_PAISE: number = parseCost("COST_CONTROL_RETRY_PAISE", 1500);

/** Per automated outreach in ARBITER arm (paise). Default: 25 (₹0.25) */
export const COST_ARBITER_OUTREACH_PAISE: number = parseCost("COST_ARBITER_OUTREACH_PAISE", 25);

function parseCost(envKey: string, defaultPaise: number): number {
  const raw = process.env[envKey];
  if (raw === undefined || raw === "") return defaultPaise;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return defaultPaise;
  return Math.round(n);
}
