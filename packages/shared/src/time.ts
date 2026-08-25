/**
 * Time primitives — Invariant I-6: store UTC, convert to IST in exactly
 * one function. India has no DST, so IST = UTC+05:30 always.
 * Bug coverage: P1-B4 (quiet hours at wrong hour), P5-B7 (boundary off-by-one).
 *
 * Boundary semantics: quiet window is [startMinute, endMinute) in IST
 * minute-of-day. 22:00:00 IST IS quiet; 08:00:00 IST is NOT quiet.
 */

export const IST_OFFSET_MIN = 330; // 5h30m

/** Quiet hours default: 22:00–08:00 IST (ARBITER policy pack). */
export const QUIET_START_MIN = 22 * 60; // 1320
export const QUIET_END_MIN = 8 * 60; // 480

/** Minute-of-day (0..1439) in IST for a UTC epoch-milliseconds timestamp. */
export function istMinuteOfDay(tsMs: number): number {
  if (!Number.isFinite(tsMs)) throw new Error(`istMinuteOfDay: non-finite ${tsMs}`);
  const totalMin = Math.floor(tsMs / 60_000) + IST_OFFSET_MIN;
  return ((totalMin % 1440) + 1440) % 1440;
}

/** ISO-8601 UTC string — the ONLY format timestamps are persisted in. */
export function isoUtc(tsMs: number): string {
  return new Date(tsMs).toISOString();
}

export function parseIsoMs(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`parseIsoMs: invalid ${iso}`);
  return ms;
}

function inWindow(minuteOfDay: number, startMin: number, endMin: number): boolean {
  if (startMin === endMin) return false; // zero-length window = never quiet
  if (startMin < endMin) {
    // same-day window e.g. 13:00–14:00
    return minuteOfDay >= startMin && minuteOfDay < endMin;
  }
  // midnight-crossing window e.g. 22:00–08:00
  return minuteOfDay >= startMin || minuteOfDay < endMin;
}

/** True if ts falls inside the quiet window (default 22:00–08:00 IST). */
export function isWithinQuietHours(
  tsMs: number,
  startMin: number = QUIET_START_MIN,
  endMin: number = QUIET_END_MIN,
): boolean {
  return inWindow(istMinuteOfDay(tsMs), startMin, endMin);
}

/** Human label used in ledger rows: "2026-08-25T12:41:09Z [18:11 IST]" */
export function ledgerTimestamp(tsMs: number): string {
  const m = istMinuteOfDay(tsMs);
  const hh = String(Math.floor(m / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return `${isoUtc(tsMs)} [${hh}:${mm} IST]`;
}
