/**
 * Deterministic Finite State Machine (Task 6.11 / FSM-12)
 *
 * Implements a formal transition matrix S x E -> S' with 5 non-negotiable hard guards.
 * Prohibits illegal transitions and guarantees that unconstrained AI/LLM logic
 * cannot violate merchant policies, regulatory windows, or financial invariants.
 */
import { evaluateStoppingRules, type StoppingRuleContext } from "./stopping_rules.js";

export type FSMState =
  | "DETECTED"
  | "DIAGNOSED"
  | "CHANNEL_DISPATCHED"
  | "MESSAGE_DELIVERED"
  | "INTERACTION_SEEN"
  | "CONCESSION_OFFERED"
  | "ESCALATE_OR_RETRY"
  | "RECOVERED_SUCCESS"
  | "TERMINATED_STOP_RULE";

export type FSMEvent =
  | "WEBHOOK_INGESTED"
  | "DISPATCH_PACED"
  | "DELIVERY_CONFIRMED"
  | "CUSTOMER_CLICKED"
  | "CONCESSION_TRIGGERED"
  | "PAYMENT_COMPLETED"
  | "RETRY_TIMEOUT"
  | "STOP_RULE_BREACHED";

export class IllegalStateTransitionError extends Error {
  constructor(currentState: FSMState, event: FSMEvent, rationale?: string) {
    super(
      `Illegal FSM State Transition: Cannot transition from state '${currentState}' via event '${event}'. ${rationale || ""}`.trim(),
    );
    this.name = "IllegalStateTransitionError";
  }
}

export class GuardEvaluationError extends Error {
  constructor(guardReason: string) {
    super(`FSM Guard Blocked Transition: ${guardReason}`);
    this.name = "GuardEvaluationError";
  }
}

export interface FSMTransitionResult {
  fromState: FSMState;
  toState: FSMState;
  event: FSMEvent;
  occurredAtUtc: string;
  rationale: string;
}

/**
 * Formal Transition Matrix: S x E -> S'
 */
export function transitionFSM(
  currentState: FSMState,
  event: FSMEvent,
  stoppingCtx?: StoppingRuleContext,
  rationale: string = "Standard state progression",
): FSMTransitionResult {
  const nowUtc = new Date().toISOString();

  // Universal terminal states
  if (currentState === "RECOVERED_SUCCESS") {
    throw new IllegalStateTransitionError(
      currentState,
      event,
      "Transaction is already successfully recovered and settled. Dunning permanently pruned.",
    );
  }
  if (currentState === "TERMINATED_STOP_RULE") {
    throw new IllegalStateTransitionError(
      currentState,
      event,
      "Transaction lifecycle has reached terminal stop rule (opt-out / lifetime exceeded).",
    );
  }

  // Universal payment completion
  if (event === "PAYMENT_COMPLETED") {
    return {
      fromState: currentState,
      toState: "RECOVERED_SUCCESS",
      event,
      occurredAtUtc: nowUtc,
      rationale: "Payment settlement detected. Immediate transition to terminal RECOVERED_SUCCESS.",
    };
  }

  // Universal stop rule breach
  if (event === "STOP_RULE_BREACHED") {
    return {
      fromState: currentState,
      toState: "TERMINATED_STOP_RULE",
      event,
      occurredAtUtc: nowUtc,
      rationale: rationale || "Stopping rule violated or customer opt-out received.",
    };
  }

  let nextState: FSMState;

  switch (currentState) {
    case "DETECTED":
      if (event === "WEBHOOK_INGESTED") {
        nextState = "DIAGNOSED";
      } else {
        throw new IllegalStateTransitionError(currentState, event);
      }
      break;

    case "DIAGNOSED":
      if (event === "DISPATCH_PACED") {
        // Enforce 5 stopping rules before allowing outreach dispatch
        if (stoppingCtx) {
          const evalResult = evaluateStoppingRules(stoppingCtx);
          if (!evalResult.allowed) {
            throw new GuardEvaluationError(
              evalResult.reason || "Outreach dispatch forbidden by compliance guards.",
            );
          }
        }
        nextState = "CHANNEL_DISPATCHED";
      } else {
        throw new IllegalStateTransitionError(currentState, event);
      }
      break;

    case "CHANNEL_DISPATCHED":
      if (event === "DELIVERY_CONFIRMED") {
        nextState = "MESSAGE_DELIVERED";
      } else if (event === "CUSTOMER_CLICKED") {
        nextState = "INTERACTION_SEEN";
      } else if (event === "RETRY_TIMEOUT") {
        nextState = "ESCALATE_OR_RETRY";
      } else {
        throw new IllegalStateTransitionError(currentState, event);
      }
      break;

    case "MESSAGE_DELIVERED":
      if (event === "CUSTOMER_CLICKED") {
        nextState = "INTERACTION_SEEN";
      } else if (event === "RETRY_TIMEOUT") {
        nextState = "ESCALATE_OR_RETRY";
      } else {
        throw new IllegalStateTransitionError(currentState, event);
      }
      break;

    case "INTERACTION_SEEN":
      if (event === "CONCESSION_TRIGGERED") {
        nextState = "CONCESSION_OFFERED";
      } else if (event === "RETRY_TIMEOUT") {
        nextState = "ESCALATE_OR_RETRY";
      } else {
        throw new IllegalStateTransitionError(currentState, event);
      }
      break;

    case "CONCESSION_OFFERED":
      if (event === "RETRY_TIMEOUT") {
        nextState = "ESCALATE_OR_RETRY";
      } else {
        throw new IllegalStateTransitionError(currentState, event);
      }
      break;

    case "ESCALATE_OR_RETRY":
      if (event === "DISPATCH_PACED") {
        if (stoppingCtx) {
          const evalResult = evaluateStoppingRules(stoppingCtx);
          if (!evalResult.allowed) {
            throw new GuardEvaluationError(
              evalResult.reason || "Re-attempt dispatch forbidden by compliance guards.",
            );
          }
        }
        nextState = "CHANNEL_DISPATCHED";
      } else {
        throw new IllegalStateTransitionError(currentState, event);
      }
      break;

    default:
      throw new IllegalStateTransitionError(currentState, event);
  }

  return {
    fromState: currentState,
    toState: nextState,
    event,
    occurredAtUtc: nowUtc,
    rationale,
  };
}
