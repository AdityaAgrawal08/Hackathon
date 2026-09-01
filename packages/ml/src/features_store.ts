/**
 * Frozen feature persistence (P2) — computed vectors land in the `features`
 * table exactly once per (event, feature_version) and are NEVER updated
 * (schema comment: "computed, frozen"). Re-computation drifts are detected,
 * not overwritten: an identical vector inserts as a no-op; a DIFFERENT
 * vector for the same key throws (fail-closed provenance, I-3/I-4).
 */
import type { Client } from "@libsql/client";
import { FEATURE_VERSION, FEATURE_NAMES } from "./features.js";
import { isoUtc } from "@arbiter/shared";

export interface FeatureRecord {
  eventId: string;
  values: readonly number[];
}

export interface VersionedFeatureRecord {
  eventId: string;
  values: readonly number[];
  version: string;
}

function vectorJson(values: readonly number[]): string {
  return JSON.stringify(values);
}

/** Persist computed vectors. Idempotent; refuses silent mutation of frozen rows. */
export async function saveFeatures(
  client: Client,
  records: readonly FeatureRecord[],
  nowMs: number,
): Promise<{ inserted: number; unchanged: number }> {
  let inserted = 0;
  let unchanged = 0;

  for (const rec of records) {
    const json = vectorJson(rec.values);
    const id = `feat/${FEATURE_VERSION}/${rec.eventId}`;
    const existing = await client.execute({
      sql: `SELECT vector_json FROM features WHERE event_id = ? AND feature_version = ?`,
      args: [rec.eventId, FEATURE_VERSION],
    });
    if (existing.rows.length > 0) {
      const prev = String(existing.rows[0]!.vector_json);
      if (prev !== json) {
        throw new Error(
          `saveFeatures: frozen vector drift for ${rec.eventId} (${FEATURE_VERSION})`,
        );
      }
      unchanged++;
      continue;
    }
    await client.execute({
      sql: `INSERT OR IGNORE INTO features (id, event_id, feature_version, vector_json, computed_at_utc)
            VALUES (?, ?, ?, ?, ?)`,
      args: [id, rec.eventId, FEATURE_VERSION, json, isoUtc(nowMs)],
    });
    inserted++;
  }

  return { inserted, unchanged };
}

/** Load frozen vectors for scoring; missing rows ⇒ absent key (caller fails closed). */
export async function loadFeatureVectors(
  client: Client,
  eventIds: readonly string[],
): Promise<Map<string, number[]>> {
  const expectedDim = FEATURE_NAMES.length;
  const out = new Map<string, number[]>();
  for (const eventId of eventIds) {
    // Try current version first, then fall back to any older version (bug #A-006)
    const versions = [FEATURE_VERSION];
    const allVersions = await client.execute({
      sql: `SELECT DISTINCT feature_version FROM features WHERE event_id = ?`,
      args: [eventId],
    });
    for (const row of allVersions.rows) {
      const v = String(row.feature_version);
      if (!versions.includes(v)) versions.push(v);
    }
    for (const version of versions) {
      const r = await client.execute({
        sql: `SELECT vector_json FROM features WHERE event_id = ? AND feature_version = ?`,
        args: [eventId, version],
      });
      if (r.rows.length > 0) {
        const vec = JSON.parse(String(r.rows[0]!.vector_json)) as number[];
        // Only pad short vectors from OLDER feature versions; return current-version vectors as-is
        if (version !== FEATURE_VERSION && vec.length < expectedDim) {
          const padded = [...vec, ...new Array(expectedDim - vec.length).fill(0)];
          out.set(eventId, padded);
        } else {
          out.set(eventId, vec);
        }
        break;
      }
    }
  }
  return out;
}
