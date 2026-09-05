/**
 * GROQ-powered customer failure explanation (P2-B9/B10 compliant).
 *
 * Takes a raw payment failure (code + description) and returns a simple,
 * customer-friendly sentence. No PII is ever sent to GROQ — only the
 * technical error code and its description.
 *
 * Usage: await getGroqCustomerMessage(failureCode, failureDescription)
 * Fallback: getCustomerMessage() from error-catalog (deterministic, no network).
 */

import { getCustomerMessage } from "../error-catalog.js";
import { groqLlmLimiter } from "./rate_limiter.js";

const GROQ_MODEL = process.env.GROQ_MODEL ?? "llama3-8b-8192";
const GROQ_TIMEOUT_MS = 300; // Never stall the payment flow — 300ms max
const cache = new Map<string, string>();
const CACHE_MAX = 256;

export interface CustomerMessageContext {
  amountPaise?: number;
  productName?: string;
  paymentMethod?: string;
  cardIssuer?: string;
  cardLast4?: string;
  bankCode?: string;
  vpa?: string;
  customerName?: string;
  isHinglish?: boolean;
}

function promptFor(failureCode: string, failureDescription: string, context?: CustomerMessageContext): string {
  const methodDetail = context?.paymentMethod
    ? `Method: ${context.paymentMethod}${context.cardIssuer ? ` (${context.cardIssuer})` : ""}${context.cardLast4 ? ` ending in ${context.cardLast4}` : ""}`
    : "";
  const amountDetail = context?.amountPaise ? `Amount: ₹${(context.amountPaise / 100).toFixed(2)}` : "";
  const languageDirective = context?.isHinglish
    ? `Language: Conversational Hinglish (e.g., 'Fikr mat kijiye, aapke paise safe hain...').`
    : `Language: English.`;

  return [
    `Rewrite this payment failure reason into ONE simple, empathetic, reassuring sentence for a customer.`,
    `Use plain language, no technical codes. Explicitly mention that no money was deducted if applicable.`,
    methodDetail,
    amountDetail,
    languageDirective,
    `Max 35 words. Plain text only, no preamble.`,
    ``,
    `Failure code: ${failureCode}`,
    `Description: ${failureDescription || "(none)"}`,
  ].filter(Boolean).join("\n");
}

function fallback(failureCode: string, failureDescription: string): string {
  return getCustomerMessage(failureCode, failureDescription);
}

/**
 * Returns a GROQ-polished customer message. Never throws — always returns
 * the catalog fallback on any failure. Cached per code+description+context.
 *
 * PII: Customer name/email/phone are NEVER sent. Only generic payment method/bank details.
 */
export async function getGroqCustomerMessage(
  failureCode: string,
  failureDescription: string,
  opts: { apiKey?: string; timeoutMs?: number; noCache?: boolean; context?: CustomerMessageContext } = {},
): Promise<string> {
  const ctxKey = opts.context
    ? `::${opts.context.paymentMethod || ""}:${opts.context.cardIssuer || ""}:${opts.context.isHinglish ? "hi" : "en"}`
    : "";
  const key = `${failureCode}::${failureDescription}${ctxKey}`;
  if (!opts.noCache && cache.has(key)) return cache.get(key)!;

  const apiKey = opts.apiKey ?? process.env.GROQ_API_KEY;
  if (!apiKey) {
    const msg = fallback(failureCode, failureDescription);
    if (!opts.noCache) { if (cache.size >= CACHE_MAX) cache.clear(); cache.set(key, msg); }
    return msg;
  }

  // Rate Limiting (Phase 2): Guard against Groq 30 req/min rate limit.
  // If rate limit is reached, fall back immediately to local catalog without network delay.
  if (!groqLlmLimiter.tryAcquire()) {
    const msg = fallback(failureCode, failureDescription);
    if (!opts.noCache) { if (cache.size >= CACHE_MAX) cache.clear(); cache.set(key, msg); }
    return msg;
  }

  const timeoutMs = opts.timeoutMs ?? GROQ_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        max_tokens: 80,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "You rewrite payment failure reasons into ONE empathetic customer-friendly sentence. Plain language, no codes, no jargon. Mention no money deducted when true. Max 35 words.",
          },
          { role: "user", content: promptFor(failureCode, failureDescription, opts.context) },
        ],
      }),
    });

    if (!res.ok) throw new Error(`groq http ${res.status}`);
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = (body.choices?.[0]?.message?.content ?? "").trim();
    if (!text) throw new Error("groq empty");

    // Strip any echoed code
    const cleaned = text.replace(/^[A-Z0-9_]+\s*:\s*/i, "").trim();
    const finalText = cleaned.length > 5 && cleaned.length < 300 ? cleaned : fallback(failureCode, failureDescription);

    if (!opts.noCache) { if (cache.size >= CACHE_MAX) cache.clear(); cache.set(key, finalText); }
    return finalText;
  } catch {
    const msg = fallback(failureCode, failureDescription);
    if (!opts.noCache) { if (cache.size >= CACHE_MAX) cache.clear(); cache.set(key, msg); }
    return msg;
  } finally {
    clearTimeout(timer);
  }
}

export function clearGroqCustomerCache(): void {
  cache.clear();
}
