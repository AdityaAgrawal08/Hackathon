import { hashSeed, clamp01 } from "@arbiter/shared";
import { RAIL_HEALTH_THRESHOLD } from "../decide/window.js";

export type RailId = "upi" | "imps" | "neft" | "cards" | "autopay";

export interface RailHealth {
  rail: RailId;
  score: number;
  degraded: boolean;
}

export interface RailHealthSnapshot {
  overall: number;
  rails: RailHealth[];
  asOfUtc: string;
}

export interface BankDowntimeEvent {
  bank: string;
  status: "UP" | "DEGRADED" | "DOWN";
  severity: "LOW" | "HIGH";
  instrument?: "upi" | "card" | "netbanking" | "all";
  updatedAtUtc: string;
}

const activeBankDowntimes = new Map<string, BankDowntimeEvent>();

export function recordBankDowntime(
  bank: string,
  status: "UP" | "DEGRADED" | "DOWN",
  severity: "LOW" | "HIGH" = "HIGH",
  instrument: "upi" | "card" | "netbanking" | "all" = "all",
): void {
  const normBank = bank.trim().toUpperCase();
  if (status === "UP") {
    activeBankDowntimes.delete(normBank);
  } else {
    activeBankDowntimes.set(normBank, {
      bank: normBank,
      status,
      severity,
      instrument,
      updatedAtUtc: new Date().toISOString(),
    });
  }
}

export function getBankHealth(bank: string): { bank: string; status: "UP" | "DEGRADED" | "DOWN"; degraded: boolean } {
  const normBank = bank.trim().toUpperCase();
  const event = activeBankDowntimes.get(normBank);
  if (!event || event.status === "UP") {
    return { bank: normBank, status: "UP", degraded: false };
  }
  return { bank: normBank, status: event.status, degraded: true };
}

export function getAllBankDowntimes(): BankDowntimeEvent[] {
  return Array.from(activeBankDowntimes.values());
}

export function clearBankDowntimes(): void {
  activeBankDowntimes.clear();
}

export function simulatedRailHealth(nowMs: number): RailHealthSnapshot {
  if (!Number.isFinite(nowMs)) throw new Error("simulatedRailHealth: non-finite clock");

  const istMs = nowMs + 330 * 60_000;
  const istHour = (istMs % 86_400_000) / 3_600_000;
  const upiStress = Math.max(0, 1 - Math.abs(istHour - 21) / 6);
  const seed = hashSeed(`rail:${Math.floor(nowMs / 60_000)}`);
  const jitter = ((seed % 1000) / 1000 - 0.5) * 0.1;

  const upi = clamp01(0.95 - upiStress * 0.55 + jitter);
  const imps = clamp01(0.97 - upiStress * 0.2 + jitter * 0.5);
  const neft = clamp01(0.99 + jitter * 0.3);
  const cards = clamp01(0.9 - upiStress * 0.35 + jitter * 0.5);
  const autopay = clamp01(0.92 - upiStress * 0.3 + jitter * 0.4);

  const rails: RailHealth[] = [
    { rail: "upi", score: upi, degraded: upi < RAIL_HEALTH_THRESHOLD },
    { rail: "imps", score: imps, degraded: imps < RAIL_HEALTH_THRESHOLD },
    { rail: "neft", score: neft, degraded: neft < RAIL_HEALTH_THRESHOLD },
    { rail: "cards", score: cards, degraded: cards < RAIL_HEALTH_THRESHOLD },
    { rail: "autopay", score: autopay, degraded: autopay < RAIL_HEALTH_THRESHOLD },
  ];
  const overall = rails.reduce((s, r) => s + r.score, 0) / rails.length;
  return { overall, rails, asOfUtc: new Date(nowMs).toISOString() };
}

export function isRailHealthy(nowMs: number): boolean {
  return simulatedRailHealth(nowMs).overall >= RAIL_HEALTH_THRESHOLD;
}
