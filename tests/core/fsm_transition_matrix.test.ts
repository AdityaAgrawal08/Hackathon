/**
 * Automated Tests for Task 6.11 / FSM-12: Deterministic Finite State Machine
 */
import { describe, it, expect } from "vitest";
import {
  transitionFSM,
  IllegalStateTransitionError,
  GuardEvaluationError,
  type FSMState,
  type FSMEvent,
} from "../../packages/core/src/agent/index.js";

describe("Task 6.11 / FSM-12: Deterministic Finite State Machine", () => {
  it("transitions legally through the standard recovery happy path", () => {
    // 1. DETECTED -> DIAGNOSED
    let res = transitionFSM("DETECTED", "WEBHOOK_INGESTED");
    expect(res.toState).toBe("DIAGNOSED");

    // 2. DIAGNOSED -> CHANNEL_DISPATCHED
    res = transitionFSM("DIAGNOSED", "DISPATCH_PACED");
    expect(res.toState).toBe("CHANNEL_DISPATCHED");

    // 3. CHANNEL_DISPATCHED -> MESSAGE_DELIVERED
    res = transitionFSM("CHANNEL_DISPATCHED", "DELIVERY_CONFIRMED");
    expect(res.toState).toBe("MESSAGE_DELIVERED");

    // 4. MESSAGE_DELIVERED -> INTERACTION_SEEN
    res = transitionFSM("MESSAGE_DELIVERED", "CUSTOMER_CLICKED");
    expect(res.toState).toBe("INTERACTION_SEEN");

    // 5. INTERACTION_SEEN -> CONCESSION_OFFERED
    res = transitionFSM("INTERACTION_SEEN", "CONCESSION_TRIGGERED");
    expect(res.toState).toBe("CONCESSION_OFFERED");

    // 6. CONCESSION_OFFERED -> RECOVERED_SUCCESS
    res = transitionFSM("CONCESSION_OFFERED", "PAYMENT_COMPLETED");
    expect(res.toState).toBe("RECOVERED_SUCCESS");
  });

  it("strictly rejects illegal state transitions fail-closed with IllegalStateTransitionError", () => {
    // Cannot jump from DETECTED directly to CHANNEL_DISPATCHED without diagnosis
    expect(() => transitionFSM("DETECTED", "DISPATCH_PACED")).toThrow(IllegalStateTransitionError);

    // Cannot jump from MESSAGE_DELIVERED to CONCESSION_OFFERED without customer interaction
    expect(() => transitionFSM("MESSAGE_DELIVERED", "CONCESSION_TRIGGERED")).toThrow(IllegalStateTransitionError);

    // Cannot make any transitions once terminal RECOVERED_SUCCESS is reached
    expect(() => transitionFSM("RECOVERED_SUCCESS", "DISPATCH_PACED")).toThrow(IllegalStateTransitionError);
  });

  it("enforces mathematical stopping guards before permitting transition to outreach", () => {
    const activeCooldownCtx = {
      touchCount: 1,
      lastTouchAtUtc: new Date(Date.now() - 1 * 3600 * 1000).toISOString(), // 1h ago (< 4h)
      isOptedOut: false,
      createdAtUtc: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      domain: "D2C_CHECKOUT" as const,
    };

    expect(() => transitionFSM("DIAGNOSED", "DISPATCH_PACED", activeCooldownCtx)).toThrow(GuardEvaluationError);
  });

  it("permits universal transition to TERMINATED_STOP_RULE on customer opt-out or limit breach", () => {
    const res = transitionFSM("CHANNEL_DISPATCHED", "STOP_RULE_BREACHED", undefined, "Customer requested STOP");
    expect(res.toState).toBe("TERMINATED_STOP_RULE");
    expect(res.rationale).toBe("Customer requested STOP");
  });
});
