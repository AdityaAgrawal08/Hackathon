/**
 * Training dataset builder (P2) — turns the TRAINING corpus into labeled
 * feature rows with PROVENANCE and LEAKAGE discipline:
 *
 *  - Decision-time information only (P2-B2): each row's history inputs are
 *    that customer's STRICTLY PRIOR failures (row index within the
 *    customer's time-sorted failure sequence). Nothing post-outcome exists.
 *  - Labels are a pure function of (eventId, trueOutcomeSeed) via seeded
 *    Bernoulli — reproducible forever, no Math.random (see labels.ts).
 *  - Rows are sorted by eventId before hashing/training so floating-point
 *    summation order is fixed forever (P2-B5).
 *  - The dataset sha256 pins the exact training/holdout content into the
 *    model artifact (invariant I-3 provenance chain).
 */
import { createHash } from "node:crypto";
import { computeFeatures, FEATURE_COUNT } from "./features.js";
import { deriveLabel } from "./labels.js";

export interface CorpusLike {
  customers: ReadonlyArray<{
    id: string;
    paydayPattern: Record<string, number>;
    channelResponsiveness: number;
    priorSuccessCount: number;
    joinedAtUtc: string;
  }>;
  events: ReadonlyArray<{
    id: string;
    customerId: string;
    amountPaise: number;
    failureCode: string;
    occurredAtUtc: string;
    trueOutcomeSeed: number | null;
  }>;
}

export interface DatasetRow {
  eventId: string;
  customerId: string;
  failureClass: string; // code-derived class (hint is NEVER trusted)
  values: number[];
  label: 0 | 1;
}

export interface Dataset {
  rows: DatasetRow[]; // sorted by eventId — fixed reduction order
  skipped: number; // events without truth (fail-closed count, must be 0 for TRAINING)
  sha256: string;
}

/**
 * Canonical dataset fingerprint: newline-joined row records with values
 * quantized to 10 decimals so the hash is engine-independent.
 */
export function datasetSha(rows: readonly DatasetRow[]): string {
  const h = createHash("sha256");
  for (const r of rows) {
    h.update(
      `${r.eventId}|${r.customerId}|${r.failureClass}|${r.label}|${r.values
        .map((v) => v.toFixed(10))
        .join(",")}\n`,
    );
  }
  return h.digest("hex");
}

export function buildTrainingDataset(corpus: CorpusLike): Dataset {
  const customersById = new Map<string, CorpusLike["customers"][number]>();
  for (const c of corpus.customers) customersById.set(c.id, c);

  // Group failures per customer in total order (time asc, then id).
  const failuresByCustomer = new Map<string, Array<(typeof corpus.events)[number]>>();
  for (const e of corpus.events) {
    let list = failuresByCustomer.get(e.customerId);
    if (!list) {
      list = [];
      failuresByCustomer.set(e.customerId, list);
    }
    list.push(e);
  }
  for (const list of failuresByCustomer.values()) {
    list.sort((a, b) => Date.parse(a.occurredAtUtc) - Date.parse(b.occurredAtUtc) || (a.id < b.id ? -1 : 1));
  }

  const rows: DatasetRow[] = [];
  let skipped = 0;

  for (const seq of failuresByCustomer.values()) {
    for (let idx = 0; idx < seq.length; idx++) {
      const e = seq[idx] as (typeof corpus.events)[number];
      if (e.trueOutcomeSeed === null || e.trueOutcomeSeed === undefined) {
        skipped++; // demo-corpus rows carry no truth — never silently trained on
        continue;
      }
      const cust = customersById.get(e.customerId);
      if (!cust) throw new Error(`buildTrainingDataset: orphan event ${e.id}`);

      // Strictly-prior failures only (decision-time safe).
      const prior = seq.slice(0, idx);

      const computed = computeFeatures({
        failureCode: e.failureCode,
        amountPaise: e.amountPaise,
        occurredAtUtc: e.occurredAtUtc,
        priorFailureAmountsPaise: prior.map((p) => p.amountPaise),
        priorFailureCount: prior.length,
        customer: {
          paydayPattern: cust.paydayPattern,
          channelResponsiveness: cust.channelResponsiveness,
          priorSuccessCount: cust.priorSuccessCount,
          joinedAtUtc: cust.joinedAtUtc,
        },
      });

      if (computed.values.length !== FEATURE_COUNT) {
        throw new Error(`buildTrainingDataset: feature count drift on ${e.id}`);
      }

      rows.push({
        eventId: e.id,
        customerId: e.customerId,
        failureClass: computed.raw.failureClass,
        values: computed.values,
        label: deriveLabel(e.id, e.trueOutcomeSeed),
      });
    }
  }

  if (rows.length === 0) throw new Error("buildTrainingDataset: zero labeled rows");
  rows.sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));

  return { rows, skipped, sha256: datasetSha(rows) };
}
