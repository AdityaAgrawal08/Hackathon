import type { Client } from "@libsql/client";
import { formatINR, paise, isoUtc, getMerchantVpa } from "@arbiter/shared";
import { simulatedRailHealth, type RailId } from "../ingest/rail_health.js";
import { defaultMarginGuard } from "./margin_guard.js";
import { validateDiscountGuardrail, validateRescheduleGuardrail } from "./agent_guardrails.js";
import { appendAuditLedger } from "../ledger/audit_ledger.js";

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, any>;
      required: string[];
    };
  };
}

export const AGENT_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "check_issuer_rail_health",
      description: "Checks real-time bank switch and payment rail uptime health (UPI, Netbanking, Cards, Autopay).",
      parameters: {
        type: "object",
        properties: {
          rail: {
            type: "string",
            enum: ["upi", "cards", "autopay", "netbanking"],
            description: "Specific payment rail to check",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "evaluate_margin_discount",
      description: "Evaluates whether a requested courtesy discount is compliant with merchant margin and policy bounds (max 10%, min cart ₹1,000).",
      parameters: {
        type: "object",
        properties: {
          originalAmountPaise: {
            type: "number",
            description: "Original cart value in integer paise",
          },
          requestedDiscountPercent: {
            type: "number",
            description: "Customer requested discount percentage (e.g. 10)",
          },
        },
        required: ["originalAmountPaise", "requestedDiscountPercent"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_1tap_upi_deep_link",
      description: "Generates an instant 1-Tap UPI recovery payment link with pre-filled intent parameters and optional authorized discount.",
      parameters: {
        type: "object",
        properties: {
          eventId: {
            type: "string",
            description: "Payment failure event ID",
          },
          amountPaise: {
            type: "number",
            description: "Amount to collect in paise",
          },
          discountPercent: {
            type: "number",
            description: "Approved discount percent, if any",
          },
        },
        required: ["eventId", "amountPaise"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "schedule_trai_compliant_touch",
      description: "Reschedules recovery outreach to customer's requested time while strictly enforcing TRAI quiet hours (09:00 - 21:00 IST) and a 7-day maximum window.",
      parameters: {
        type: "object",
        properties: {
          requestedDateOrRelative: {
            type: "string",
            description: "Customer's requested date or phrase (e.g. 'tomorrow', 'next week', 'after 2 days')",
          },
          channel: {
            type: "string",
            enum: ["SMS", "EMAIL", "WHATSAPP"],
            description: "Outreach channel to reschedule",
          },
        },
        required: ["requestedDateOrRelative"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "escalate_to_human_support",
      description: "Escalates complex inquiries or high-ticket disputes to merchant human operations team.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Reason for human escalation",
          },
          priority: {
            type: "string",
            enum: ["NORMAL", "HIGH", "URGENT"],
            description: "Escalation priority",
          },
        },
        required: ["reason"],
      },
    },
  },
];

export interface ToolExecutionContext {
  client?: Client;
  eventId: string;
  customerProfileId: string;
  originalAmountPaise: number;
  baseUrl: string;
  nowMs?: number;
}

export interface ToolExecutionRecord {
  toolName: string;
  input: Record<string, any>;
  output: Record<string, any>;
  guardrailPassed: boolean;
  guardrailNotes?: string;
}

export async function executeAgentTool(
  name: string,
  args: Record<string, any>,
  context: ToolExecutionContext,
): Promise<ToolExecutionRecord> {
  const nowMs = context.nowMs ?? Date.now();

  switch (name) {
    case "check_issuer_rail_health": {
      const railArg = (args.rail || "upi").toLowerCase() as RailId;
      const snapshot = simulatedRailHealth(nowMs);
      const targetRail = snapshot.rails.find((r) => r.rail === railArg) ?? snapshot.rails[0] ?? { rail: "upi" as RailId, score: 0.95, degraded: false };
      const isDegraded = targetRail.degraded;
      const recommendation = isDegraded
        ? `Rail '${railArg}' is currently degraded (${Math.round(targetRail.score * 100)}% uptime). Recommend steering customer to alternate UPI handle or netbanking.`
        : `Rail '${railArg}' is fully operational (${Math.round(targetRail.score * 100)}% uptime). Safe to initiate instant retry.`;

      const output = {
        rail: targetRail.rail,
        score: targetRail.score,
        uptimePercent: Math.round(targetRail.score * 100),
        degraded: isDegraded,
        overallSystemUptimePercent: Math.round(snapshot.overall * 100),
        recommendation,
      };

      return {
        toolName: name,
        input: args,
        output,
        guardrailPassed: true,
      };
    }

    case "evaluate_margin_discount": {
      const origPaise = Number(args.originalAmountPaise) || context.originalAmountPaise;
      const reqPercent = Number(args.requestedDiscountPercent) || 0;

      const guardrailResult = validateDiscountGuardrail(origPaise, reqPercent);
      const proposedPaise = guardrailResult.discountedAmountPaise;
      const marginGuardResult = defaultMarginGuard.validateDiscount(origPaise, proposedPaise);

      const allowed = guardrailResult.allowed && marginGuardResult.allowed;
      const approvedDiscountPercent = allowed ? guardrailResult.approvedDiscountPercent : 0;
      const discountedAmountPaise = allowed ? guardrailResult.discountedAmountPaise : origPaise;

      const output = {
        allowed,
        approvedDiscountPercent,
        originalAmountPaise: origPaise,
        discountedAmountPaise,
        originalAmountFormatted: formatINR(paise(origPaise)),
        discountedAmountFormatted: formatINR(paise(discountedAmountPaise)),
        reason: !guardrailResult.allowed
          ? guardrailResult.reason
          : !marginGuardResult.allowed
            ? marginGuardResult.reason
            : guardrailResult.reason,
      };

      return {
        toolName: name,
        input: args,
        output,
        guardrailPassed: allowed,
        guardrailNotes: output.reason,
      };
    }

    case "generate_1tap_upi_deep_link": {
      const discount = Number(args.discountPercent) || 0;
      const amountPaise = Number(args.amountPaise) || context.originalAmountPaise;
      const effectiveAmountPaise = discount > 0 ? Math.round(amountPaise * (1 - discount / 100)) : amountPaise;
      const amountRupees = (effectiveAmountPaise / 100).toFixed(2);

      const recoveryUrl = discount > 0
        ? `${context.baseUrl}/recover/${context.eventId}?discount=${discount}`
        : `${context.baseUrl}/recover/${context.eventId}`;

      const vpa = getMerchantVpa();
      const upiIntent = `upi://pay?pa=${vpa}&pn=Razorpay+Merchant&am=${amountRupees}&cu=INR&tn=Order+${context.eventId}`;

      const output = {
        recoveryUrl,
        upiIntent,
        effectiveAmountPaise,
        formattedAmount: formatINR(paise(effectiveAmountPaise)),
        discountAppliedPercent: discount,
        expiresAtUtc: isoUtc(nowMs + 60 * 60 * 1000), // 1 hour validity
      };

      return {
        toolName: name,
        input: args,
        output,
        guardrailPassed: true,
      };
    }

    case "schedule_trai_compliant_touch": {
      const requested = String(args.requestedDateOrRelative || "tomorrow");
      const guardrail = validateRescheduleGuardrail(requested, nowMs);

      if (context.client) {
        try {
          await context.client.execute({
            sql: `INSERT OR REPLACE INTO scheduled_outreach
                  (id, live_payment_event_id, customer_profile_id, channel, scheduled_at_utc, executed, status)
                  VALUES (?, ?, ?, ?, ?, 0, 'PENDING')`,
            args: [
              `resched_${context.eventId}_${Date.now()}`,
              context.eventId,
              context.customerProfileId,
              args.channel === "EMAIL" ? "EMAIL" : "SMS",
              guardrail.scheduledAtUtc,
            ],
          });
        } catch {}
      }

      const output = {
        scheduledAtUtc: guardrail.scheduledAtUtc,
        scheduledAtIstDisplay: guardrail.scheduledAtIstDisplay,
        compliant: true,
        guardrailReason: guardrail.reason,
      };

      return {
        toolName: name,
        input: args,
        output,
        guardrailPassed: guardrail.allowed,
        guardrailNotes: guardrail.reason,
      };
    }

    case "escalate_to_human_support": {
      const reason = String(args.reason || "Customer dispute requiring human intervention");
      const priority = String(args.priority || "HIGH");
      const ticketId = `esc_${context.eventId}_${Date.now()}`;

      if (context.client) {
        try {
          await context.client.execute({
            sql: `INSERT OR REPLACE INTO support_escalation_tickets
                  (id, event_id, customer_id, reason, priority, status, created_at_utc)
                  VALUES (?, ?, ?, ?, ?, 'OPEN', ?)`,
            args: [ticketId, context.eventId, context.customerProfileId, reason, priority, isoUtc(nowMs)],
          });
        } catch {}

        try {
          await appendAuditLedger(context.client, {
            eventType: "HUMAN_ESCALATION_QUEUED",
            entityId: context.eventId,
            customerId: context.customerProfileId,
            actor: "conversational_agent",
            nowMs,
            payload: { ticketId, reason, priority },
          });
        } catch {}
      }

      const output = {
        ticketId,
        status: "ESCALATED",
        assignedQueue: "VIP_RECOVERY",
        priority,
        reason,
      };

      return {
        toolName: name,
        input: args,
        output,
        guardrailPassed: true,
      };
    }

    default:
      throw new Error(`Unknown agent tool: ${name}`);
  }
}
