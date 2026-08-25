/**
 * Deterministic label derivation (P2 training).
 *
 * The generator stores the TRUE probability per TRAINING event
 * (`true_outcome_seed`). Binary labels are sampled from it with a per-event
 * seeded Bernoulli — same event id ⇒ same label, forever. No Math.random,
 * no wall-clock: retraining five years from now sees identical labels.
 */
import { Rng } from "@arbiter/shared";

export function deriveLabel(eventId: string, trueOutcomeSeed: number): 0 | 1 {
  if (!Number.isFinite(trueOutcomeSeed) || trueOutcomeSeed < 0 || trueOutcomeSeed > 1) {
    throw new Error(`deriveLabel: invalid probability for ${eventId}: ${trueOutcomeSeed}`);
  }
  const rng = new Rng(`label/${eventId}`);
  return rng.bernoulli(trueOutcomeSeed) ? 1 : 0;
}
