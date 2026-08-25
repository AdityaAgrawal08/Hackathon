/**
 * Two-corpus deterministic generator (T4).
 *
 *   TRAINING corpus — ~1,200 customers / ~5,000 events, carries generator
 *   ground-truth (trueOutcomeSeed, paydayTrueDay) for supervised learning.
 *   DEMO corpus    — ~60 customers × ~4 events (~230), NO truth leaked.
 *
 * Determinism (bug P1-B1): single mulberry32 stream per corpus, injected
 * clock, canonical JSON key order. Same seed ⇒ byte-identical fixtures.
 * Isolation (P1-B9): disjoint id prefixes trn_/demo_.
 */
import { Rng, isoUtc } from "@arbiter/shared";
import {
  CLASS_SHARES,
  CODES_BY_CLASS,
  FAILURE_CLASSES,
  type FailureClass,
} from "./taxonomy.js";

export interface SeedCustomer {
  id: string;
  tenantId: string;
  pseudoName: string;
  phoneFake: string;
  emailFake: string;
  /** Salary day ground truth (25..29 or 1..3) */
  paydayTrueDay: number;
  /** Noisy success-day observations the inference will actually see */
  paydayPattern: Record<string, number>;
  channelResponsiveness: number;
  priorSuccessCount: number;
  optedOut: boolean;
  joinedAtUtc: string;
}

export interface SeedEvent {
  id: string;
  tenantId: string;
  customerId: string;
  rzpPaymentId: string | null;
  subscriptionId: string;
  amountPaise: number;
  failureCode: string;
  failureClassHint: FailureClass; // seed hint only; pipeline must not trust it
  source: "TRAINING" | "SEED";
  trueOutcomeSeed: number | null; // null for demo corpus (no truth leak)
  occurredAtUtc: string;
  ingestedAtUtc: string;
}

export interface CorpusMeta {
  name: string;
  customerCount: number;
  eventCount: number;
  classCounts: Record<FailureClass, number>;
  sha256: string;
  seedLabel: string;
}

export interface Corpus {
  meta: CorpusMeta;
  customers: SeedCustomer[];
  events: SeedEvent[];
}

const FIRST_NAMES = [
  "Asha", "Rohan", "Meera", "Vikram", "Priya", "Arjun", "Neha", "Karthik",
  "Divya", "Sanjay", "Anita", "Rahul", "Kavya", "Amit", "Pooja", "Nikhil",
];
const LAST_INITIALS = "ABCDEFGHIKLMNOPRSV".split("");
/** Typical Indian D2C subscription price points (₹). */
const PRICE_POINTS = [199, 249, 299, 399, 499, 699, 999];

const SALARY_DAYS = [1, 2, 3, 25, 26, 27, 28, 29, 30] as const;

function pickPaydayDay(rng: Rng): number {
  // Weighted toward month-end salary credits common in India
  const roll = rng.next();
  if (roll < 0.55) return rng.pick([28, 29, 30]);
  if (roll < 0.8) return rng.pick([25, 26, 27]);
  return rng.pick([1, 2, 3]);
}

export function generateCorpus(
  name: "training" | "demo",
  opts: { customerCount: number; targetEvents: number },
): Corpus {
  const seedLabel = `arbiter/corpus/${name}/v1`;
  const rng = new Rng(seedLabel);
  const customers: SeedCustomer[] = [];
  const events: SeedEvent[] = [];
  const classCounts = Object.fromEntries(
    FAILURE_CLASSES.map((c) => [c, 0]),
  ) as Record<FailureClass, number>;

  // Fixed epoch: billing cycle window Jan–Feb 2026. Injected clock, no Date.now().
  const epochMs = Date.UTC(2026, 0, 10, 9, 0, 0);

  const prefix = name === "training" ? "trn" : "demo";

  for (let c = 0; c < opts.customerCount; c++) {
    const custId = `${prefix}_cust_${String(c + 1).padStart(5, "0")}`;
    const paydayTrueDay = pickPaydayDay(rng);
    const responsiveness = Math.round((0.2 + rng.next() * 0.7) * 100) / 100;
    const priorSuccessCount = rng.int(2, 8);
    const tenureDays = rng.int(60, 400);

    // Build noisy payday histogram from prior successes around true day.
    const pattern: Record<string, number> = {};
    for (let s = 0; s < priorSuccessCount; s++) {
      const jitter = rng.int(-2, 3); // ±2 days around true day
      const day = ((paydayTrueDay - 1 + jitter + 31) % 31) + 1;
      pattern[String(day)] = (pattern[String(day)] ?? 0) + 1;
    }

    const firstName = rng.pick(FIRST_NAMES);
    const lastInitial = rng.pick(LAST_INITIALS);
    const serial = String(c + 1).padStart(4, "0");

    customers.push({
      id: custId,
      tenantId: "demo",
      pseudoName: `${firstName} ${lastInitial}.`,
      phoneFake: `+919${serial}${serial.slice(0, 2)}${String(rng.int(0, 100)).padStart(2, "0")}`,
      emailFake: `${prefix}_${custId}@example.test`,
      paydayTrueDay,
      paydayPattern: pattern,
      channelResponsiveness: responsiveness,
      priorSuccessCount,
      optedOut: rng.next() < 0.02, // small opt-out cohort exercises I-7 routing
      joinedAtUtc: isoUtc(epochMs - tenureDays * 86_400_000),
    });
  }

  // Events: distribute across customers, ≥1 each until target reached.
  const totalNeeded = Math.max(opts.targetEvents, customers.length);
  let made = 0;
  while (made < totalNeeded) {
    for (const cust of customers) {
      if (made >= totalNeeded) break;
      const failuresHere = rng.int(1, 3);
      for (let k = 0; k < failuresHere && made < totalNeeded; k++, made++) {
        // Class by shares (single uniform draw against cumulative bands)
        const u = rng.next();
        let acc = 0;
        let cls: FailureClass = "UNKNOWN";
        for (const fc of FAILURE_CLASSES) {
          acc += CLASS_SHARES[fc];
          if (u < acc) {
            cls = fc;
            break;
          }
        }
        classCounts[cls] += 1;

        const code = rng.pick(CODES_BY_CLASS[cls]);
        const baseRupees = rng.pick(PRICE_POINTS);
        const amountPaise = baseRupees * 100;
        const dayOffset = made % 45; // spread over ~1.5 cycles
        const hourJitter = rng.int(0, 12);
        const occurredMs =
          epochMs + dayOffset * 86_400_000 + hourJitter * 3_600_000;

        events.push({
          id: `${prefix}_evt_${String(made + 1).padStart(6, "0")}`,
          tenantId: "demo",
          customerId: cust.id,
          rzpPaymentId: `pay_${prefix}${String(made + 1).padStart(9, "0")}`,
          subscriptionId: `sub_${prefix}${String((made % 500) + 1).padStart(5, "0")}`,
          amountPaise,
          failureCode: code,
          failureClassHint: cls,
          source: name === "training" ? "TRAINING" : "SEED",
          trueOutcomeSeed:
            name === "training"
              ? Math.round(baseRecoveryProb(cls, cust, occurredMs) * 1000) / 1000
              : null,
          occurredAtUtc: isoUtc(occurredMs),
          ingestedAtUtc: isoUtc(occurredMs + 60_000),
        });
      }
    }
  }

  const bodyJson = JSON.stringify({ customers, events });
  return {
    meta: {
      name,
      customerCount: customers.length,
      eventCount: events.length,
      classCounts,
      sha256: "", // filled by caller (crypto) to keep this module pure-ish
      seedLabel,
    },
    customers,
    events,
  };
}

/**
 * Ground-truth recovery probability used to label TRAINING outcomes.
 * Deliberately structured so a logistic model CAN find signal:
 * payday proximity × responsiveness drive soft-failure recovery;
 * dead methods never recover via retry; timeouts recover on immediate retry.
 */
export function baseRecoveryProb(
  cls: FailureClass,
  cust: SeedCustomer,
  occurredAtMs: number,
): number {
  const d = new Date(occurredAtMs);
  const dom = d.getUTCDate();
  const distToPayday = Math.min(
    Math.abs(dom - cust.paydayTrueDay),
    Math.abs(dom - cust.paydayTrueDay + 31),
    Math.abs(dom - cust.paydayTrueDay - 31),
  );
  const nearPayday = distToPayday <= 2 ? 1 : 0;
  const resp = cust.channelResponsiveness;

  switch (cls) {
    case "SOFT_RETRYABLE":
      return clamp01(0.08 + nearPayday * 0.35 + resp * 0.15);
    case "HARD_METHOD_DEAD":
      return 0.0;
    case "NETWORK_TIMEOUT":
      return clamp01(0.55 + resp * 0.25);
    case "RISK_FLAGGED":
      return 0.05;
    case "UNKNOWN":
      return 0.04;
  }
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
