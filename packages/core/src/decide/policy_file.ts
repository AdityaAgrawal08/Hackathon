import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { policySchema, type PolicyPack } from "./policy.js";

export function policyFromYaml(text: string): PolicyPack {
  const raw: unknown = parseYaml(text);
  if (raw === null || raw === undefined || typeof raw !== "object") {
    throw new Error("policy file empty or not a mapping");
  }
  return policySchema.parse(raw);
}

export function loadPolicyFile(path: string): PolicyPack {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`policy file unreadable at ${path}: ${(err as Error).message}`);
  }
  return policyFromYaml(text);
}

export function resolvePolicyPath(): string {
  return process.env.ARBITER_POLICY_PATH ?? "config/policy.yaml";
}
