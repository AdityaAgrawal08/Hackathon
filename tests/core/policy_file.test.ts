import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  policyFromYaml,
  loadPolicyFile,
  resolvePolicyPath,
} from "../../packages/core/src/decide/policy_file.js";
import { defaultPolicy } from "../../packages/core/src/decide/policy.js";

const CONFIG = resolvePolicyPath();

describe("policy file loading (P3-B7)", () => {
  it("committed config parses to the canonical defaults", () => {
    const pack = loadPolicyFile(join(process.cwd(), CONFIG));
    expect(pack).toEqual(defaultPolicy());
  });

  it("parses valid yaml", () => {
    const pack = policyFromYaml(`
policy_version: policy-v1
confidence_floor_bp: 3500
max_attempts_per_cycle: 1
min_interval_hours: 12
quiet_hours:
  start_minute: 1300
  end_minute: 500
exposure_cap_paise: 250000
human_review_classes:
  - UNKNOWN
regulatory_profile:
  jurisdiction: IN
  mandate_type: NONE
  dpdp_consent_status: GRANTED
  autopay_retry_ceiling: 3
  pre_debit_notice_hours: 24
  trai_dlt_template_id: rzp_recovery_dl
`);
    expect(pack.confidence_floor_bp).toBe(3500);
    expect(pack.quiet_hours.start_minute).toBe(1300);
    expect(pack.human_review_classes).toEqual(["UNKNOWN"]);
    expect(pack.regulatory_profile.autopay_retry_ceiling).toBe(3);
  });

  it("rejects unknown keys as boot errors", () => {
    expect(() =>
      policyFromYaml(`
policy_version: policy-v1
confidence_floor_bp: 2000
max_attempts_per_cycle: 2
min_interval_hours: 24
quiet_hors:
  start_minute: 1320
  end_minute: 480
exposure_cap_paise: 10000000
human_review_classes: []
`),
    ).toThrow();
  });

  it("rejects wrong version, bad types, and empty files", () => {
    expect(() => policyFromYaml("policy_version: v9\n")).toThrow();
    expect(() => policyFromYaml("confidence_floor_bp: lots\n")).toThrow();
    expect(() => policyFromYaml("")).toThrow();
    expect(() => policyFromYaml("- just\n- a list\n")).toThrow();
  });

  it("fails closed when the file is missing", () => {
    expect(() => loadPolicyFile("/nonexistent/policy.yaml")).toThrow(/unreadable/);
  });
});
