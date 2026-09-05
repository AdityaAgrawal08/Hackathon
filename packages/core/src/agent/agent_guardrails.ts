import { formatINR, paise, isoUtc } from "@arbiter/shared";

export interface GuardrailCheckResult<T = any> {
  allowed: boolean;
  reason?: string;
  sanitizedValue?: T;
}

export interface DiscountGuardrailResult {
  allowed: boolean;
  reason: string;
  approvedDiscountPercent: number;
  discountedAmountPaise: number;
  discountPaise: number;
}

export interface RescheduleGuardrailResult {
  allowed: boolean;
  reason: string;
  scheduledAtUtc: string;
  scheduledAtIstDisplay: string;
}

const DND_KEYWORDS = [
  "STOP",
  "UNSUBSCRIBE",
  "OPT OUT",
  "OPTOUT",
  "DND",
  "DO NOT MESSAGE",
  "DONT MESSAGE",
  "DON'T MESSAGE",
  "STOP REMINDERS",
  "CANCEL SUBSCRIPTION",
  "BLOCK",
  "REMOVE ME",
  "LEAVE ME ALONE",
];

export function checkDndOptOut(text: string): boolean {
  if (!text || !text.trim()) return false;
  const upper = text.trim().toUpperCase();
  return DND_KEYWORDS.some((kw) => upper === kw || upper.includes(kw));
}

export function validateDiscountGuardrail(
  originalAmountPaise: number,
  requestedDiscountPercent: number,
): DiscountGuardrailResult {
  if (!Number.isFinite(originalAmountPaise) || originalAmountPaise <= 0) {
    return {
      allowed: false,
      reason: "Invalid cart value: must be positive amount",
      approvedDiscountPercent: 0,
      discountedAmountPaise: originalAmountPaise,
      discountPaise: 0,
    };
  }

  const MIN_CART_PAISE = 100_000; // ₹1,000
  const MAX_DISCOUNT_PERCENT = 10;

  if (originalAmountPaise < MIN_CART_PAISE) {
    return {
      allowed: false,
      reason: `Cart value (${formatINR(paise(originalAmountPaise))}) is below minimum eligible threshold of ₹1,000 for conversational discounts`,
      approvedDiscountPercent: 0,
      discountedAmountPaise: originalAmountPaise,
      discountPaise: 0,
    };
  }

  if (requestedDiscountPercent <= 0) {
    return {
      allowed: false,
      reason: "Requested discount must be greater than 0%",
      approvedDiscountPercent: 0,
      discountedAmountPaise: originalAmountPaise,
      discountPaise: 0,
    };
  }

  const boundedPercent = Math.min(requestedDiscountPercent, MAX_DISCOUNT_PERCENT);
  const discountPaise = Math.round(originalAmountPaise * (boundedPercent / 100));
  const discountedAmountPaise = originalAmountPaise - discountPaise;

  const allowed = requestedDiscountPercent <= MAX_DISCOUNT_PERCENT;
  const reason = allowed
    ? `Approved ${boundedPercent}% courtesy discount`
    : `Requested discount ${requestedDiscountPercent}% exceeds strict 10% ceiling; clamped to 10%`;

  return {
    allowed,
    reason,
    approvedDiscountPercent: boundedPercent,
    discountedAmountPaise,
    discountPaise,
  };
}

export function validateRescheduleGuardrail(
  requestedDateOrRelative: string,
  nowMs: number = Date.now(),
): RescheduleGuardrailResult {
  const upper = (requestedDateOrRelative || "").trim().toUpperCase();
  const MAX_HORIZON_MS = 7 * 24 * 3600 * 1000; // 7 days max
  const IST_OFFSET_MS = 5.5 * 3600 * 1000;

  let targetMs = nowMs + 24 * 3600 * 1000;

  if (upper.includes("NEXT WEEK") || upper.includes("7 DAYS")) {
    targetMs = nowMs + 7 * 24 * 3600 * 1000;
  } else if (upper.includes("AFTER 2 DAYS") || upper.includes("2 DAYS")) {
    targetMs = nowMs + 2 * 24 * 3600 * 1000;
  } else if (upper.includes("AFTER 3 DAYS") || upper.includes("3 DAYS")) {
    targetMs = nowMs + 3 * 24 * 3600 * 1000;
  } else {
    const parsed = Date.parse(requestedDateOrRelative);
    if (!Number.isNaN(parsed) && parsed > nowMs) {
      targetMs = parsed;
    }
  }

  let allowed = true;
  let reason = "TRAI compliant scheduling within allowable window";

  if (targetMs > nowMs + MAX_HORIZON_MS) {
    targetMs = nowMs + MAX_HORIZON_MS;
    allowed = false;
    reason = "Reschedule requested beyond 7-day maximum policy; clamped to 7 days";
  }

  const istDate = new Date(targetMs + IST_OFFSET_MS);
  const istHour = istDate.getUTCHours();

  if (istHour < 9 || istHour >= 21) {
    istDate.setUTCHours(10, 0, 0, 0);
    targetMs = istDate.getTime() - IST_OFFSET_MS;
    if (allowed) {
      reason = "Scheduled time clamped to 10:00 AM IST to strictly observe TRAI quiet hours (09:00 - 21:00 IST)";
    }
  }

  const scheduledAtUtc = isoUtc(targetMs);
  const scheduledAtIstDisplay = new Date(targetMs).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  });

  return {
    allowed,
    reason,
    scheduledAtUtc,
    scheduledAtIstDisplay,
  };
}
