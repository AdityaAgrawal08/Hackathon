/**
 * Model registry — DB persistence for immutable model versions.
 * Statuses: CANDIDATE → INCUMBENT (at most ONE) → RETIRED.
 * Promotion demotes the previous incumbent in the same transaction-ish
 * sequence; decisions always reference the version they used, so history
 * never rewrites itself (P8-B1 prevention lives here).
 */
import type { Client } from "@libsql/client";
import { isoUtc } from "@arbiter/shared";
import type { ModelArtifact } from "./artifact.js";

export async function saveModel(
  client: Client,
  artifact: ModelArtifact,
  status: "CANDIDATE" | "INCUMBENT",
): Promise<void> {
  const insertStmt = {
    sql: `INSERT INTO model_versions
            (id, kind, weights_json, weights_sha256, dataset_sha256,
             feature_names_json, metrics_json, trained_at_utc, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            status=excluded.status`,
    args: [
      artifact.id,
      artifact.kind,
      JSON.stringify({
        featureVersion: artifact.featureVersion,
        weights: artifact.weights,
        bias: artifact.bias,
        mu: artifact.mu,
        sigma: artifact.sigma,
      }),
      artifact.weightsSha256,
      artifact.datasetSha256,
      JSON.stringify(artifact.featureNames),
      artifact.metricsJson,
      artifact.trainedAtUtc || isoUtc(Date.now()),
      status,
    ],
  };

  if (status === "INCUMBENT") {
    await client.batch(
      [
        { sql: `UPDATE model_versions SET status='RETIRED' WHERE status='INCUMBENT'`, args: [] },
        insertStmt,
      ],
      "write",
    );
  } else {
    await client.batch([insertStmt], "write");
  }
}

function rowToArtifact(row: Record<string, unknown>): ModelArtifact {
  const inner = JSON.parse(String(row.weights_json)) as {
    featureVersion: string;
    weights: number[];
    bias: number;
    mu: number[];
    sigma: number[];
  };
  return {
    id: String(row.id),
    kind: "logreg",
    featureVersion: inner.featureVersion,
    featureNames: JSON.parse(String(row.feature_names_json)) as string[],
    weights: inner.weights,
    bias: inner.bias,
    mu: inner.mu,
    sigma: inner.sigma,
    metricsJson: String(row.metrics_json),
    datasetSha256: String(row.dataset_sha256),
    weightsSha256: String(row.weights_sha256),
    trainedAtUtc: String(row.trained_at_utc),
  };
}

export async function getModelById(
  client: Client,
  id: string,
): Promise<ModelArtifact | null> {
  const r = await client.execute({
    sql: `SELECT * FROM model_versions WHERE id = ?`,
    args: [id],
  });
  const row = r.rows[0];
  return row ? rowToArtifact(row as unknown as Record<string, unknown>) : null;
}

export async function getIncumbent(client: Client): Promise<ModelArtifact | null> {
  const r = await client.execute(
    `SELECT * FROM model_versions WHERE status='INCUMBENT'
     ORDER BY trained_at_utc DESC, id DESC LIMIT 1`,
  );
  const row = r.rows[0];
  if (!row) return null;
  return rowToArtifact(row as unknown as Record<string, unknown>);
}
