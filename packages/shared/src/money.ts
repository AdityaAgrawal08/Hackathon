/**
 * Money primitives — Invariant I-5: integer paise only.
 * Floats may never touch an amount. All arithmetic lives here so it can be
 * audited in one place (ARBITER plan §16 "Money corruption").
 */

declare const PaiseBrand: unique symbol;
/** Integer amount in paise (₹1 = 100 paise). Branded to prevent float mixing. */
export type Paise = number & { readonly [PaiseBrand]: true };

export function isInt(n: number): boolean {
  return Number.isSafeInteger(n);
}

/** Construct a branded Paise from an integer. Truncation is a bug — we throw. */
export function paise(n: number): Paise {
  if (!isInt(n)) throw new Error(`paise() requires an integer, got ${n}`);
  return n as Paise;
}

/** ₹ (float, e.g. from a UI or API) → integer paise via round-half-up on abs. */
export function rupeesToPaise(rupees: number): Paise {
  if (!Number.isFinite(rupees)) throw new Error(`rupeesToPaise: non-finite ${rupees}`);
  const scaled = rupees * 100;
  const rounded = scaled >= 0 ? Math.round(scaled) : -Math.round(-scaled);
  return paise(rounded);
}

export function addP(a: Paise, b: Paise): Paise {
  const s = a + b;
  if (!isInt(s)) throw new Error("addP overflow");
  return s as Paise;
}

export function subP(a: Paise, b: Paise): Paise {
  const s = a - b;
  if (!isInt(s)) throw new Error("subP overflow");
  return s as Paise;
}

/** Multiply by a pure integer quantity (e.g. attempt count). */
export function mulQty(a: Paise, qty: number): Paise {
  if (!isInt(qty)) throw new Error(`mulQty requires integer qty, got ${qty}`);
  const r = a * qty;
  if (!isInt(r)) throw new Error("mulQty overflow");
  return r as Paise;
}

/**
 * Integer percentage in basis points (10000 bp = 100%).
 * Round-half-up on magnitude so fee math is symmetric and auditable.
 */
export function percentBp(a: Paise, bp: number): Paise {
  if (!isInt(bp)) throw new Error(`percentBp requires integer bp`);
  const raw = a * bp;
  if (!Number.isSafeInteger(raw)) {
    throw new Error(`percentBp: ${a}×${bp} overflows safe integer range`);
  }
  const div = Math.trunc(raw / 10000);
  const rem = raw - div * 10000;
  const bump =
    rem >= 5000 ? 1 : rem <= -5000 ? -1 : 0;
  return paise(div + bump);
}

function groupIndian(intStr: string): string {
  // Indian grouping: last 3, then pairs. 1234567 -> 12,34,567
  if (intStr.length <= 3) return intStr;
  const last3 = intStr.slice(-3);
  let rest = intStr.slice(0, -3);
  const parts: string[] = [];
  while (rest.length > 2) {
    parts.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest.length > 0) parts.unshift(rest);
  return `${parts.join(",")},${last3}`;
}

/**
 * Deterministic INR formatting (no Intl/ICU — identical output on every machine).
 * formatINR(paise(123456789)) === "₹12,34,567.89"
 */
export function formatINR(amount: Paise): string {
  const negative = amount < 0;
  const abs = Math.abs(amount);
  const rupeePart = Math.trunc(abs / 100);
  const paisePart = abs % 100;
  const sign = negative ? "-" : "";
  return `${sign}₹${groupIndian(String(rupeePart))}.${String(paisePart).padStart(2, "0")}`;
}
