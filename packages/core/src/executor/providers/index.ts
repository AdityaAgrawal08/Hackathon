/**
 * Provider factory — picks the action provider based on environment.
 *
 * REAL_EXECUTION_MODE:
 *   - unset / "simulation" → razorpay dry-run (default, zero deps)
 *   - "razorpay" / "dry-run" / "live" → razorpayProvider
 */
import { ActionProvider } from "./types.js";
import { razorpayProvider } from "./razorpay.js";

function getProviderName(): string {
  const mode = process.env.REAL_EXECUTION_MODE?.toLowerCase() ?? "simulation";
  if (mode === "simulation" || mode === "false" || mode === "0" || mode === "") {
    return "simulation";
  }
  return "razorpay";
}

export function getProvider(): ActionProvider {
  return razorpayProvider;
}

export function listProviders(): string[] {
  return ["simulation", "razorpay"];
}
