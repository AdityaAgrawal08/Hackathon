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
