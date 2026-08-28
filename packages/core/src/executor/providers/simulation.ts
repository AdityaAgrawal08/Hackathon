/**
 * Simulation provider — current deterministic behavior.
 * No network calls; outcome derived from catalog multipliers.
 * This is the DEFAULT when no REAL_EXECUTION env var is set.
 */
import { ActionProvider, ProviderContext, ProviderResult, ExecutionOutcome } from "./types.js";
import { multiplierFor, type ActionId, type FailureClassId } from "../../decide/catalog.js";

export const simulationProvider: ActionProvider = {
  name: "simulation",
  isLive: false,

  async execute(ctx: ProviderContext): Promise<ProviderResult> {
    const mult = multiplierFor(ctx.failureClass as FailureClassId, ctx.actionId as ActionId);
    if (ctx.actionId === "HUMAN_REVIEW") return { outcome: "AMBIGUOUS" };
    if (mult === 0) return { outcome: "FAILED" };
    return { outcome: "SUCCEEDED" };
  },
};