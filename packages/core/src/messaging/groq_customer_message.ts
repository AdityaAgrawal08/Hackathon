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

const GROQ_MODEL = process.env.GROQ_MODEL ?? "llama3-8b-8192";
const GROQ_TIMEOUT_MS = 3000; // Never stall the payment flow — 3s max
const cache = new Map<string, string>();
const CACHE_MAX = 256;

function promptFor(failureCode: string, failureDescription: string): string {
  return [
    `Rewrite this payment failure reason into ONE simple sentence for a customer.`,
    `Use plain language, no jargon, no codes. Mention that no money was deducted if applicable.`,
    `Max 30 words. Plain text only, no preamble.`,
    ``,
    `Failure code: ${failureCode}`,
    `Description: ${failureDescription || "(none)"}`,
  ].join("\n");
}

function fallback(failureCode: string, failureDescription: string): string {
  return getCustomerMessage(failureCode, failureDescription);
}

/**
 * Returns a GROQ-polished customer message. Never throws — always returns
 * the catalog fallback on any failure. Cached per code+description.
 *
 * PII: Only code+description are sent. Customer name/email/phone/amount are NEVER included.
 */
export async function getGroqCustomerMessage(
  failureCode: string,
  failureDescription: string,
  opts: { apiKey?: string; timeoutMs?: number; noCache?: boolean } = {},
): Promise<string> {
  const key = `${failureCode}::${failureDescription}`;
  if (!opts.noCache && cache.has(key)) return cache.get(key)!;

  const apiKey = opts.apiKey ?? process.env.GROQ_API_KEY;
  if (!apiKey) {
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
              "You rewrite payment failure reasons into ONE customer-friendly sentence. Plain language, no codes, no jargon. Mention no money deducted when true. Max 30 words.",
          },
          { role: "user", content: promptFor(failureCode, failureDescription) },
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
