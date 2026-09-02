export const IST_OFFSET_MS = 5.5 * 3_600_000;
const DAY_MS = 86_400_000;

export const RETRY_HOUR_EST = 10;
const MAX_LOOKAHEAD_DAYS = 60;

function startOfIstDay(ms: number): number {
  return Math.floor((ms + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
}

export function istDayOfMonth(ms: number): number {
  return new Date(ms + IST_OFFSET_MS).getUTCDate();
}

/**
 * TRAI quiet hours evaluation in Indian Standard Time (UTC+5:30).
 * Compliance window: 21:00 (9:00 PM) to 09:00 (9:00 AM) IST.
 */
export function isQuietHoursIST(epochMs: number): boolean {
  if (!Number.isFinite(epochMs)) return false;
  const istDate = new Date(epochMs + IST_OFFSET_MS);
  const istHour = istDate.getUTCHours();
  return istHour >= 21 || istHour < 9;
}

export function circularDayDistance(a: number, b: number, modulus = 31): number {
  const d = Math.abs(((a - b) % modulus + modulus) % modulus);
  return Math.min(d, modulus - d);
}

export function nextPaydayWindowMs(paydayDay: number, nowMs: number): number {
  if (!Number.isInteger(paydayDay) || paydayDay < 1 || paydayDay > 31) {
    throw new Error(`nextPaydayWindowMs: invalid payday day ${paydayDay}`);
  }
  if (!Number.isFinite(nowMs)) throw new Error("nextPaydayWindowMs: non-finite clock");
  const dayStart = startOfIstDay(nowMs);
  for (let i = 1; i <= MAX_LOOKAHEAD_DAYS; i++) {
    const candidate = dayStart + i * DAY_MS + RETRY_HOUR_EST * 3_600_000;
    if (candidate <= nowMs) continue;
    if (circularDayDistance(istDayOfMonth(candidate), paydayDay) <= 2) {
      return candidate;
    }
  }
  throw new Error("nextPaydayWindowMs: no window within lookahead");
}

/* ── real-time payment-rail health (§4.5) ───────────────────────── */

/**
 * Rail-health gate. UPI/IMPS outages are routine in India; retrying a recovery
 * on a degraded rail burns an attempt and loses the customer. Below this
 * overall score we defer rail-dependent recovery to the next healthy window.
 */
export const RAIL_HEALTH_THRESHOLD = 0.5;

/**
 * Next window at which the rail is considered healthy enough to attempt a
 * recovery. Deterministic: a degraded rail is retried after a fixed,
 * jurisdiction-aware offset (not a random backoff). Healthy rail → now.
 */
export function nextRailHealthyWindowMs(
  railHealthScore: number,
  nowMs: number,
): number {
  if (!Number.isFinite(railHealthScore)) throw new Error("nextRailHealthyWindowMs: non-finite score");
  if (!Number.isFinite(nowMs)) throw new Error("nextRailHealthyWindowMs: non-finite clock");
  if (railHealthScore >= RAIL_HEALTH_THRESHOLD) return nowMs;
  // Degraded rail: wait a deterministic 30-minute slot (IST-aligned) before retry.
  const slot = 30 * 60_000;
  return nowMs + slot;
}

/** Rail-dependent actions — retrying them on a dead rail is wasted effort.
 *  Voice/WhatsApp recovery also needs a healthy network ("call only when
 *  network healthy", §4.6), so they defer with the same gate. */
export const RAIL_DEPENDENT_ACTIONS = new Set([
  "RETRY_NOW",
  "ALTERNATE_UPI_LINK",
  "RECOVER_VIA_RAIL",
  "RECOVER_VOICE_HI",
  "RECOVER_WHATSAPP",
]);
