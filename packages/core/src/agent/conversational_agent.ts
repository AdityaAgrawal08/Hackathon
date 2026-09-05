import type { Client } from "@libsql/client";
import { formatINR, paise, isoUtc } from "@arbiter/shared";
import { appendAuditLedger } from "../ledger/audit_ledger.js";
import { getCustomerMessage } from "../error-catalog.js";
import {
  executeAgentTool,
  AGENT_TOOL_DEFINITIONS,
  type ToolExecutionContext,
  type ToolExecutionRecord,
} from "./agent_tools.js";
import {
  checkDndOptOut,
  validateDiscountGuardrail,
  validateRescheduleGuardrail,
} from "./agent_guardrails.js";
import { groqLlmLimiter } from "../messaging/rate_limiter.js";

export type ConversationalIntent =
  | "RESCHEDULE_REQUEST"
  | "PRICE_OBJECTION"
  | "FAILURE_INQUIRY"
  | "OPT_OUT"
  | "HELP_RETRY"
  | "HUMAN_DISPUTE"
  | "UNKNOWN";

export interface InboundMessage {
  from: string;
  channel?: "SMS" | "WHATSAPP" | "EMAIL";
  text: string;
  orderId?: string;
  paymentEventId?: string;
  timestampUtc?: string;
}

export interface IntentClassificationResult {
  intent: ConversationalIntent;
  confidence: number;
  extractedDateUtc?: string;
  extractedReason?: string;
}

export interface GuardrailAuditCheck {
  rule: string;
  allowed: boolean;
  action: string;
  notes?: string;
}

export interface ConversationalAgentReply {
  success: boolean;
  intent: ConversationalIntent;
  replyText: string;
  customerPhone?: string;
  customerEmail?: string;
  rescheduledAtUtc?: string;
  discountOfferedPercent?: number;
  recoveryUrl?: string;
  auditEntryId?: string;
  toolCalls?: ToolExecutionRecord[];
  chainOfThought?: string;
  guardrailChecks?: GuardrailAuditCheck[];
}

export function detectHinglish(text: string): boolean {
  if (!text) return false;
  const upper = text.toUpperCase();
  const markers = [
    "PAISE", "KAT", "GAYE", "BHAI", "BHAIYA", "KYA", "HUA", "KAREIN", "HAI", "NAHI", "MERI",
    "MERA", "KAL", "PAY", "KARUNGA", "DEKH", "BATAIYE", "KAB", "HO", "DISCOUNT",
    "MILEGA", "KITNA", "CHAHIYE", "YAAR", "KUCH", "KAM", "KARO", "ROK", "DO", "SHIKAYAT",
    "DOKHA", "MEHNGA", "AGLE", "HAFTE"
  ];
  let matches = 0;
  for (const m of markers) {
    if (upper.includes(m)) matches++;
  }
  return matches >= 2 || (matches >= 1 && (upper.includes("BHAI") || upper.includes("PAISE") || upper.includes("KYA")));
}

export function classifyConversationalIntent(text: string, nowMs: number = Date.now()): IntentClassificationResult {
  if (!text || !text.trim()) {
    return { intent: "UNKNOWN", confidence: 0.0 };
  }

  const raw = text.trim();
  const upper = raw.toUpperCase();

  if (checkDndOptOut(raw)) {
    return { intent: "OPT_OUT", confidence: 1.0 };
  }

  if (
    upper.includes("DISPUTE") ||
    upper.includes("FRAUD") ||
    upper.includes("SCAM") ||
    upper.includes("CHEAT") ||
    upper.includes("LEGAL") ||
    upper.includes("COMPLAINT") ||
    upper.includes("TALK TO HUMAN") ||
    upper.includes("AGENT") ||
    upper.includes("SHIKAYAT") ||
    upper.includes("DOKHA") ||
    upper.includes("FROD")
  ) {
    return { intent: "HUMAN_DISPUTE", confidence: 0.95 };
  }

  if (
    upper.includes("EXPENSIVE") ||
    upper.includes("DISCOUNT") ||
    upper.includes("COUPON") ||
    upper.includes("OFFER") ||
    upper.includes("COSTLY") ||
    upper.includes("CANNOT AFFORD") ||
    upper.includes("CANT AFFORD") ||
    upper.includes("CAN'T AFFORD") ||
    upper.includes("TOO HIGH") ||
    upper.includes("CHEAPER") ||
    upper.includes("REDUCE PRICE") ||
    upper.includes("MEHNGA") ||
    upper.includes("KAM KARO") ||
    upper.includes("PAISE KAM") ||
    upper.includes("DISCOUNT MILEGA") ||
    upper.includes("DISCOUNT DO")
  ) {
    return { intent: "PRICE_OBJECTION", confidence: 0.92 };
  }

  if (
    upper.includes("PAY LATER") ||
    upper.includes("REMIND LATER") ||
    upper.includes("REMIND ME") ||
    upper.includes("TOMORROW") ||
    upper.includes("NEXT WEEK") ||
    upper.includes("PAYDAY") ||
    upper.includes("SALARY") ||
    upper.includes("AFTER 2 DAYS") ||
    upper.includes("ON 5TH") ||
    upper.includes("ON 1ST") ||
    upper.includes("AFTER 5TH") ||
    upper.includes("NEXT MONTH") ||
    upper.includes("KAL PAY") ||
    upper.includes("PARSO") ||
    upper.includes("AGLE HAFTE") ||
    upper.includes("BAAD ME")
  ) {
    const guardrail = validateRescheduleGuardrail(upper, nowMs);
    return {
      intent: "RESCHEDULE_REQUEST",
      confidence: 0.95,
      extractedDateUtc: guardrail.scheduledAtUtc,
    };
  }

  if (
    upper.includes("FAIL") ||
    upper.includes("DEDUCT") ||
    upper.includes("DECLIN") ||
    upper.includes("ERROR") ||
    upper.includes("WHAT HAPPENED") ||
    upper.includes("REASON") ||
    upper.includes("ISSUE") ||
    upper.includes("WHY") ||
    upper.includes("PAISE KAT") ||
    upper.includes("KYA HUA") ||
    upper.includes("KYU FAIL")
  ) {
    return { intent: "FAILURE_INQUIRY", confidence: 0.88 };
  }

  if (
    upper.includes("PAY NOW") ||
    upper.includes("HOW TO PAY") ||
    upper.includes("SEND LINK") ||
    upper.includes("LINK") ||
    upper.includes("RETRY") ||
    upper.includes("PAY") ||
    upper.includes("LINK BHEJO") ||
    upper.includes("PAY KARNA")
  ) {
    return { intent: "HELP_RETRY", confidence: 0.85 };
  }

  return { intent: "UNKNOWN", confidence: 0.3 };
}

export async function callGroqAgentLoop(
  userText: string,
  context: ToolExecutionContext,
  recentEvent: any,
  options: { apiKey?: string; timeoutMs?: number; nowMs?: number; baseUrl?: string } = {},
): Promise<{
  replyText: string;
  intent: ConversationalIntent;
  toolCalls: ToolExecutionRecord[];
  chainOfThought: string;
  guardrailChecks: GuardrailAuditCheck[];
  rescheduledAtUtc?: string;
  discountOfferedPercent?: number;
  recoveryUrl?: string;
} | null> {
  const apiKey = options.apiKey ?? process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  if (!groqLlmLimiter.tryAcquire()) {
    return null;
  }

  const isHinglish = detectHinglish(userText);
  const model = process.env.GROQ_MODEL ?? "llama3-8b-8192";
  const timeoutMs = options.timeoutMs ?? 1500;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const amountPaise = context.originalAmountPaise;
  const formattedAmount = formatINR(paise(amountPaise));
  const failureCode = recentEvent?.failure_code || "PAYMENT_FAILED";
  const failureDescription = recentEvent?.failure_description || "Transaction declined";

  const systemPrompt = [
    `You are ARBITER's autonomous Revenue Recovery Agent for Indian digital commerce.`,
    `A customer's payment of ${formattedAmount} for order ${context.eventId} failed (${failureCode}: ${failureDescription}).`,
    `You have access to 5 strictly gated financial tools:`,
    `- check_issuer_rail_health: Checks bank switch health (UPI, Cards, Netbanking)`,
    `- evaluate_margin_discount: Checks if courtesy discount is allowed (up to 10%, min cart ₹1,000)`,
    `- generate_1tap_upi_deep_link: Generates instant 1-Tap UPI recovery payment link`,
    `- schedule_trai_compliant_touch: Reschedules reminders strictly between 09:00 and 21:00 IST`,
    `- escalate_to_human_support: Routes disputes or severe dissatisfaction to VIP operations`,
    `Instructions:`,
    `1. If customer asks for discount, invoke evaluate_margin_discount and generate_1tap_upi_deep_link.`,
    `2. If customer asks to pay later, invoke schedule_trai_compliant_touch and generate_1tap_upi_deep_link.`,
    `3. If customer asks why payment failed, invoke check_issuer_rail_health and generate_1tap_upi_deep_link.`,
    `4. If customer claims scam/fraud/dispute, invoke escalate_to_human_support.`,
    `5. If customer wants to pay/retry, invoke check_issuer_rail_health and generate_1tap_upi_deep_link.`,
    isHinglish
      ? `6. Customer is communicating in Hinglish. You MUST reply warmly in natural conversational Hinglish.`
      : `6. Reply in English clearly and empathetically. Under 40 words.`,
  ].join("\n");

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userText },
        ],
        tools: AGENT_TOOL_DEFINITIONS,
        tool_choice: "auto",
        temperature: 0.1,
        max_tokens: 300,
      }),
    });

    if (!res.ok) throw new Error(`Groq agent http ${res.status}`);
    const data: any = await res.json();
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error("Empty Groq response");

    const toolCalls: ToolExecutionRecord[] = [];
    const guardrailChecks: GuardrailAuditCheck[] = [];
    let chainOfThought = message.content ? String(message.content).trim() : "Autonomous LLM reasoning with dynamic tool selection";
    let discountOfferedPercent: number | undefined;
    let rescheduledAtUtc: string | undefined;
    let recoveryUrl: string | undefined;
    let inferredIntent: ConversationalIntent = "HELP_RETRY";

    const calls = message.tool_calls || [];
    if (calls.length === 0) {
      return {
        replyText: message.content?.trim() || `You can complete your payment securely with 1-Tap UPI: ${context.baseUrl}/recover/${context.eventId}`,
        intent: classifyConversationalIntent(userText, context.nowMs).intent,
        toolCalls: [],
        chainOfThought: "Direct response from Groq LLM without additional tool execution",
        guardrailChecks: [],
      };
    }

    for (const call of calls) {
      const toolName = call.function?.name;
      let args: any = {};
      try {
        args = JSON.parse(call.function?.arguments || "{}");
      } catch {}

      if (toolName === "evaluate_margin_discount") inferredIntent = "PRICE_OBJECTION";
      else if (toolName === "schedule_trai_compliant_touch") inferredIntent = "RESCHEDULE_REQUEST";
      else if (toolName === "escalate_to_human_support") inferredIntent = "HUMAN_DISPUTE";
      else if (toolName === "check_issuer_rail_health" && inferredIntent !== "PRICE_OBJECTION" && inferredIntent !== "RESCHEDULE_REQUEST") inferredIntent = "FAILURE_INQUIRY";

      const record = await executeAgentTool(toolName, args, context);
      toolCalls.push(record);

      if (toolName === "evaluate_margin_discount") {
        guardrailChecks.push({
          rule: "MAX_DISCOUNT_BOUND",
          allowed: record.guardrailPassed,
          action: record.guardrailPassed ? "APPROVE_DISCOUNT" : "REJECT_EXCESSIVE_DISCOUNT",
          notes: record.output.reason,
        });
        if (record.output.allowed) {
          discountOfferedPercent = record.output.approvedDiscountPercent;
        }
      } else if (toolName === "schedule_trai_compliant_touch") {
        guardrailChecks.push({
          rule: "TRAI_QUIET_HOURS",
          allowed: record.guardrailPassed,
          action: "ENFORCE_09_TO_21_IST",
          notes: record.output.guardrailReason,
        });
        rescheduledAtUtc = record.output.scheduledAtUtc;
      } else if (toolName === "generate_1tap_upi_deep_link") {
        recoveryUrl = record.output.recoveryUrl;
      }
    }

    let replyText = "";
    if (inferredIntent === "PRICE_OBJECTION") {
      if (discountOfferedPercent) {
        replyText = isHinglish
          ? `Aap hamare khaas customer hain! Humne aapke order par ${discountOfferedPercent}% ki courtesy chhoot apply kar di hai. 1-Tap UPI se payment karein: ${recoveryUrl || `${context.baseUrl}/recover/${context.eventId}`}`
          : `We value having you with us! We've applied a courtesy ${discountOfferedPercent}% discount. Complete your order now with 1-Tap UPI: ${recoveryUrl || `${context.baseUrl}/recover/${context.eventId}`}`;
      } else {
        replyText = isHinglish
          ? `Hamare rates pehle se hi best direct rate par hain (${formattedAmount}). Aap 1-Tap UPI se safely order complete kar sakte hain: ${recoveryUrl || `${context.baseUrl}/recover/${context.eventId}`}`
          : `Our pricing is already set to the lowest direct merchant rate for ${formattedAmount}. You can securely complete your purchase using 1-Tap UPI here: ${recoveryUrl || `${context.baseUrl}/recover/${context.eventId}`}`;
      }
    } else if (inferredIntent === "RESCHEDULE_REQUEST") {
      const scheduledDisplay = toolCalls.find(t => t.toolName === "schedule_trai_compliant_touch")?.output?.scheduledAtIstDisplay || "tomorrow at 10:00 AM";
      replyText = isHinglish
        ? `Theek hai! Humne aapka payment reminder ${scheduledDisplay} IST ke liye schedule kar diya hai. Tayyar hone par yahan se payment karein: ${recoveryUrl || `${context.baseUrl}/recover/${context.eventId}`}`
        : `Got it! We've rescheduled your payment reminder for ${scheduledDisplay} IST. Whenever you're ready, complete your order here: ${recoveryUrl || `${context.baseUrl}/recover/${context.eventId}`}`;
    } else if (inferredIntent === "HUMAN_DISPUTE") {
      const ticketId = toolCalls.find(t => t.toolName === "escalate_to_human_support")?.output?.ticketId || `esc_${context.eventId}`;
      replyText = isHinglish
        ? `Hum samajhte hain. Aapke order ke liye humne ek dedicated specialist assign kar diya hai (Ticket: ${ticketId}). Aapka koi paisa nahi dooba hai, hamari team 2 ghante me check karegi.`
        : `We understand your concern regarding this payment. A dedicated support specialist has been assigned to your order (Ticket: ${ticketId}). No funds have been lost, and our team will review the bank settlement within 2 hours.`;
    } else if (inferredIntent === "FAILURE_INQUIRY") {
      const humanMessage = getCustomerMessage(failureCode, failureDescription);
      replyText = isHinglish
        ? `Aapke ${formattedAmount} ka payment fail hua: "${humanMessage}". Fikr mat kijiye, koi paise nahi kate hain. 1-Tap UPI se retry karein: ${recoveryUrl || `${context.baseUrl}/recover/${context.eventId}`}`
        : `Your payment of ${formattedAmount} couldn't be processed: "${humanMessage}". No money was lost. You can retry safely using 1-Tap UPI here: ${recoveryUrl || `${context.baseUrl}/recover/${context.eventId}`}`;
    } else {
      replyText = isHinglish
        ? `Yeh raha aapka direct 1-Tap UPI recovery link (${formattedAmount}): ${recoveryUrl || `${context.baseUrl}/recover/${context.eventId}`}`
        : `Here is your direct 1-Tap UPI recovery link for your order (${formattedAmount}): ${recoveryUrl || `${context.baseUrl}/recover/${context.eventId}`}`;
    }

    return {
      replyText,
      intent: inferredIntent,
      toolCalls,
      chainOfThought,
      guardrailChecks,
      rescheduledAtUtc,
      discountOfferedPercent,
      recoveryUrl,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function processInboundCustomerMessage(
  client: Client,
  message: InboundMessage,
  options: { baseUrl?: string; nowMs?: number } = {},
): Promise<ConversationalAgentReply> {
  const nowMs = options.nowMs ?? Date.now();
  const from = message.from.trim();
  const isPhone = !from.includes("@");
  const phone = isPhone ? from : undefined;
  const email = !isPhone ? from : undefined;

  const baseUrl = (
    options.baseUrl ||
    process.env.PUBLIC_BASE_URL ||
    process.env.BASE_URL ||
    `http://localhost:${process.env.PORT || 3000}`
  ).replace(/\/$/, "");

  let recentEvent: any = null;
  try {
    const res = await client.execute({
      sql: `SELECT lpe.*, cp.id as profile_id, cp.name as customer_name
            FROM live_payment_events lpe
            JOIN customer_profiles cp ON cp.id = lpe.customer_profile_id
            WHERE (cp.phone = ? OR cp.email = ?)
            ORDER BY lpe.created_at_utc DESC LIMIT 1`,
      args: [from, from],
    });
    if (res.rows.length > 0) {
      recentEvent = res.rows[0];
    }
  } catch {}

  const eventId = recentEvent ? String(recentEvent.id) : (message.paymentEventId || `evt_${nowMs}`);
  const customerProfileId = recentEvent ? String(recentEvent.profile_id) : `prof_${nowMs}`;
  const amountPaise = recentEvent ? Number(recentEvent.amount_paise) : 250000;
  const formattedAmount = formatINR(paise(amountPaise));

  const context: ToolExecutionContext = {
    client,
    eventId,
    customerProfileId,
    originalAmountPaise: amountPaise,
    baseUrl,
    nowMs,
  };

  // 1. Immediate regulatory compliance bypass: customer requested DND opt-out
  if (checkDndOptOut(message.text)) {
    if (phone) {
      try {
        await client.execute({
          sql: `UPDATE customer_profiles SET opted_out = 1 WHERE phone = ?`,
          args: [phone],
        });
      } catch {}
    }
    if (email) {
      try {
        await client.execute({
          sql: `UPDATE customer_profiles SET opted_out = 1 WHERE email = ?`,
          args: [email],
        });
      } catch {}
    }

    try {
      await client.execute({
        sql: `UPDATE scheduled_outreach
              SET executed = 1, status = 'SUPPRESSED', error_message = 'OPTED_OUT_VIA_MESSAGE'
              WHERE (customer_profile_id = ? OR live_payment_event_id = ?) AND executed = 0`,
        args: [customerProfileId, eventId],
      });
    } catch {}

    const audit = await appendAuditLedger(client, {
      eventType: "CUSTOMER_OPT_OUT",
      entityId: from,
      customerId: customerProfileId,
      actor: "conversational_agent",
      nowMs,
      payload: { channel: message.channel || "SMS", reason: message.text },
    });

    return {
      success: true,
      intent: "OPT_OUT",
      customerPhone: phone,
      customerEmail: email,
      replyText: "You have been unsubscribed. No further payment reminders will be sent for this order.",
      auditEntryId: audit.id,
      toolCalls: [],
      chainOfThought: "Immediate regulatory compliance bypass: customer requested DND opt-out. Outbound messaging suppressed fail-closed.",
      guardrailChecks: [{ rule: "TRAI_DND_MANDATE", allowed: true, action: "SUPPRESS_ALL_OUTREACH" }],
    };
  }

  // 2. Real Groq LLM Agent Loop (Tool calling, reasoning & Hinglish adaptation)
  const llmResult = await callGroqAgentLoop(message.text, context, recentEvent, {
    nowMs,
    baseUrl,
  });

  if (llmResult) {
    const audit = await appendAuditLedger(client, {
      eventType: "CONVERSATIONAL_AGENT_TURN",
      entityId: eventId,
      customerId: customerProfileId,
      actor: "conversational_agent_llm",
      nowMs,
      payload: {
        inboundText: message.text,
        intent: llmResult.intent,
        replyText: llmResult.replyText,
        chainOfThought: llmResult.chainOfThought,
        toolCallsCount: llmResult.toolCalls.length,
        toolsInvoked: llmResult.toolCalls.map((t) => t.toolName),
        model: process.env.GROQ_MODEL || "llama3-8b-8192",
      },
    });

    return {
      success: true,
      intent: llmResult.intent,
      customerPhone: phone,
      customerEmail: email,
      replyText: llmResult.replyText,
      rescheduledAtUtc: llmResult.rescheduledAtUtc,
      discountOfferedPercent: llmResult.discountOfferedPercent,
      recoveryUrl: llmResult.recoveryUrl,
      auditEntryId: audit.id,
      toolCalls: llmResult.toolCalls,
      chainOfThought: llmResult.chainOfThought,
      guardrailChecks: llmResult.guardrailChecks,
    };
  }

  // 3. Deterministic Fallback Pipeline (Zero-latency offline & test resilience)
  const isHinglish = detectHinglish(message.text);
  const classification = classifyConversationalIntent(message.text, nowMs);
  const intent = classification.intent;

  const toolCalls: ToolExecutionRecord[] = [];
  const guardrailChecks: GuardrailAuditCheck[] = [];
  let chainOfThought = "";
  let replyText = "";
  let discountOfferedPercent: number | undefined;
  let rescheduledAtUtc: string | undefined;
  let recoveryUrl: string | undefined;

  switch (intent) {
    case "PRICE_OBJECTION": {
      chainOfThought = `Customer raised price resistance for cart (${formattedAmount}). Evaluating merchant MarginGuard policy bounds (ceiling: 10%, minCart: ₹1,000).`;

      const discountEval = await executeAgentTool(
        "evaluate_margin_discount",
        { originalAmountPaise: amountPaise, requestedDiscountPercent: 10 },
        context,
      );
      toolCalls.push(discountEval);

      guardrailChecks.push({
        rule: "MAX_DISCOUNT_BOUND",
        allowed: discountEval.guardrailPassed,
        action: discountEval.guardrailPassed ? "APPROVE_10_PCT" : "REJECT_EXCESSIVE_DISCOUNT",
        notes: discountEval.output.reason,
      });

      if (discountEval.output.allowed) {
        discountOfferedPercent = discountEval.output.approvedDiscountPercent;
        const upiLinkTool = await executeAgentTool(
          "generate_1tap_upi_deep_link",
          { eventId, amountPaise, discountPercent: discountOfferedPercent },
          context,
        );
        toolCalls.push(upiLinkTool);
        recoveryUrl = upiLinkTool.output.recoveryUrl;

        replyText = isHinglish
          ? `Aap hamare khaas customer hain! Humne aapke order par ${discountOfferedPercent}% ki courtesy chhoot apply kar di hai. 1-Tap UPI se sirf ${discountEval.output.discountedAmountFormatted} me order complete karein: ${recoveryUrl}`
          : `We value having you with us! We've applied a courtesy ${discountOfferedPercent}% discount. Complete your order now for ${discountEval.output.discountedAmountFormatted} (was ${discountEval.output.originalAmountFormatted}) with 1-Tap UPI: ${recoveryUrl}`;
      } else {
        const upiLinkTool = await executeAgentTool(
          "generate_1tap_upi_deep_link",
          { eventId, amountPaise, discountPercent: 0 },
          context,
        );
        toolCalls.push(upiLinkTool);
        recoveryUrl = upiLinkTool.output.recoveryUrl;

        replyText = isHinglish
          ? `Hamare rates pehle se hi best direct rate par hain (${formattedAmount}). Aap 1-Tap UPI se safely order complete kar sakte hain: ${recoveryUrl}`
          : `Our pricing is already set to the lowest direct merchant rate for ${formattedAmount}. You can securely complete your purchase using 1-Tap UPI here: ${recoveryUrl}`;
      }
      break;
    }

    case "RESCHEDULE_REQUEST": {
      chainOfThought = `Customer requested payment deferral ('${message.text}'). Clamping execution time to TRAI 09:00 - 21:00 IST window and 7-day policy horizon.`;

      const rescheduleTool = await executeAgentTool(
        "schedule_trai_compliant_touch",
        { requestedDateOrRelative: message.text, channel: message.channel || "SMS" },
        context,
      );
      toolCalls.push(rescheduleTool);
      rescheduledAtUtc = rescheduleTool.output.scheduledAtUtc;

      guardrailChecks.push({
        rule: "TRAI_QUIET_HOURS",
        allowed: rescheduleTool.guardrailPassed,
        action: "ENFORCE_09_TO_21_IST",
        notes: rescheduleTool.output.guardrailReason,
      });

      const upiLinkTool = await executeAgentTool(
        "generate_1tap_upi_deep_link",
        { eventId, amountPaise },
        context,
      );
      toolCalls.push(upiLinkTool);
      recoveryUrl = upiLinkTool.output.recoveryUrl;

      replyText = isHinglish
        ? `Got it! Humne aapka payment reminder ${rescheduleTool.output.scheduledAtIstDisplay} IST ke liye schedule kar diya hai. Tayyar hone par yahan se payment karein: ${recoveryUrl}`
        : `Got it! We've rescheduled your payment reminder for ${rescheduleTool.output.scheduledAtIstDisplay} IST. Whenever you're ready, complete your order here: ${recoveryUrl}`;
      break;
    }

    case "FAILURE_INQUIRY": {
      chainOfThought = `Customer inquiring why payment failed. Checking real-time bank switch health and translating error catalog code into plain empathetic language.`;

      const railTool = await executeAgentTool("check_issuer_rail_health", { rail: "upi" }, context);
      toolCalls.push(railTool);

      const code = recentEvent?.failure_code || "PAYMENT_FAILED";
      const desc = recentEvent?.failure_description || "Transaction declined by issuing bank";
      const humanMessage = getCustomerMessage(code, desc);

      const upiLinkTool = await executeAgentTool(
        "generate_1tap_upi_deep_link",
        { eventId, amountPaise },
        context,
      );
      toolCalls.push(upiLinkTool);
      recoveryUrl = upiLinkTool.output.recoveryUrl;

      replyText = isHinglish
        ? `Aapke ${formattedAmount} ka payment fail hua: "${humanMessage}". Fikr mat kijiye, koi paise nahi kate hain. 1-Tap UPI se retry karein: ${recoveryUrl}`
        : `Your payment of ${formattedAmount} couldn't be processed: "${humanMessage}". No money was lost. You can retry safely using 1-Tap UPI here: ${recoveryUrl}`;
      break;
    }

    case "HUMAN_DISPUTE": {
      chainOfThought = `Customer expressed high-frustration or payment dispute. Bypassing autonomous negotiation and escalating immediately to VIP merchant queue.`;

      const escTool = await executeAgentTool(
        "escalate_to_human_support",
        { reason: message.text, priority: "URGENT" },
        context,
      );
      toolCalls.push(escTool);

      guardrailChecks.push({
        rule: "CUSTOMER_DISPUTE_ESCALATION",
        allowed: true,
        action: "ROUTED_TO_VIP_SUPPORT",
        notes: `Assigned ticket ${escTool.output.ticketId}`,
      });

      replyText = isHinglish
        ? `Hum samajhte hain. Aapke order ke liye humne ek dedicated specialist assign kar diya hai (Ticket: ${escTool.output.ticketId}). Aapka koi paisa nahi dooba hai, hamari team 2 ghante me check karegi.`
        : `We understand your concern regarding this payment. A dedicated support specialist has been assigned to your order (Ticket: ${escTool.output.ticketId}). No funds have been lost, and our team will review the bank settlement within 2 hours.`;
      break;
    }

    case "HELP_RETRY":
    default: {
      chainOfThought = `Customer requested payment link or assistance. Verifying UPI rail health and issuing 1-Tap payment intent.`;

      const railTool = await executeAgentTool("check_issuer_rail_health", { rail: "upi" }, context);
      toolCalls.push(railTool);

      const upiLinkTool = await executeAgentTool(
        "generate_1tap_upi_deep_link",
        { eventId, amountPaise },
        context,
      );
      toolCalls.push(upiLinkTool);
      recoveryUrl = upiLinkTool.output.recoveryUrl;

      replyText = isHinglish
        ? `Yeh raha aapka direct 1-Tap UPI recovery link (${formattedAmount}): ${recoveryUrl}`
        : `Here is your direct 1-Tap UPI recovery link for your order (${formattedAmount}): ${recoveryUrl}`;
      break;
    }
  }

  const audit = await appendAuditLedger(client, {
    eventType: "CONVERSATIONAL_AGENT_TURN",
    entityId: eventId,
    customerId: customerProfileId,
    actor: "conversational_agent",
    nowMs,
    payload: {
      inboundText: message.text,
      intent,
      replyText,
      chainOfThought,
      toolCallsCount: toolCalls.length,
      toolsInvoked: toolCalls.map((t) => t.toolName),
    },
  });

  return {
    success: true,
    intent,
    customerPhone: phone,
    customerEmail: email,
    replyText,
    rescheduledAtUtc,
    discountOfferedPercent,
    recoveryUrl,
    auditEntryId: audit.id,
    toolCalls,
    chainOfThought,
    guardrailChecks,
  };
}
