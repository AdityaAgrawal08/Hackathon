/**
 * Narrative layer (P2) — turns score + attributions into the human case-brief.
 *
 * Compliance posture (plan §3.3, bugs P2-B9/P2-B10):
 *  - GenAI NEVER computes monetary figures; it narrates pre-computed numbers
 *    under a pinned prompt at temperature 0.
 *  - Output passes a validator that strips/flags absolute claims
 *    ("guaranteed", "will recover", "100%", …) before storage.
 *  - The numeric pipeline NEVER depends on this module: narratives are
 *    lazy/decorative, API-down ⇒ deterministic fallback template.
 *  - Cached by (prompt_version, case key); identical case ⇒ identical text.
 */
import { createHash } from "node:crypto";
import { formatINR, paise } from "@arbiter/shared";

export const PROMPT_VERSION = "narrative-v1";
export const NARRATIVE_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514";

export interface CaseBriefInput {
  eventId: string;
  failureClass: string;
  action: string;
  probability: number;
  amountPaise: number;
  attributions: ReadonlyArray<{ feature: string; contribution: number }>;
}

export interface NarrativeResult {
  text: string;
  source: "claude" | "fallback";
  /** True if the validator removed or softened absolute claims. */
  flagged: boolean;
  promptVersion: string;
}

/** Absolute-claim patterns — compliance copy pass (P2-B9). */
const CLAIM_PATTERNS: RegExp[] = [
  /\bguarantee(?:d|s)?\b/i,
  /\bpromise[sd]?\b/i,
  /\bwill\s+(?:recover|succeed|be\s+recovered)\b/i,
  /\bcertain(?:ly)?\b/i,
  /\bassure[d]?\b/i,
  /\brisk[-\s]?free\b/i,
  /\b100%\s*(?:chance|guarantee|success)\b/i,
  /\bdefinitely\b/i,
];

/**
 * Strip sentences containing absolute claims; returns cleaned text + flag.
 * Deterministic: sentence split on [.!?] boundaries, fixed scan order.
 */
export function validateNarrative(text: string): { text: string; flagged: boolean } {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const kept: string[] = [];
  let flagged = false;
  for (const s of sentences) {
    if (CLAIM_PATTERNS.some((re) => re.test(s))) {
      flagged = true;
      continue;
    }
    kept.push(s.trim());
  }
  return { text: kept.join(" "), flagged };
}

/** Deterministic fallback — used when Claude is unreachable/unconfigured. */
export function fallbackNarrative(input: CaseBriefInput): string {
  const pct = (input.probability * 100).toFixed(1);
  const top = input.attributions
    .slice()
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, 2)
    .map((a) => a.feature)
    .join(", ");
  return (
    `${input.failureClass} failure of ${formatINR(paise(Math.trunc(input.amountPaise)))} ` +
    `(event ${input.eventId}): model estimates ${pct}% recovery probability. ` +
    `Main drivers: ${top || "n/a"}. Proposed action: ${input.action}. ` +
    `Estimate, not assurance — approval required before any customer contact.`
  );
}

function caseKey(input: CaseBriefInput): string {
  const h = createHash("sha256")
    .update(
      JSON.stringify({
        pv: PROMPT_VERSION,
        eventId: input.eventId,
        cls: input.failureClass,
        action: input.action,
        p: Math.round(input.probability * 1e6),
        amt: input.amountPaise,
        att: input.attributions.map((a) => [a.feature, Math.round(a.contribution * 1e9)]),
      }),
    )
    .digest("hex");
  return h;
}

function buildPrompt(input: CaseBriefInput): string {
  const attLines = input.attributions
    .slice(0, 5)
    .map((a) => `- ${a.feature}: ${a.contribution.toFixed(4)}`)
    .join("\n");
  return [
    `Write ONE sentence (max 40 words) summarizing this recovery case for a merchant approver.`,
    `Event: ${input.eventId} | Failure class: ${input.failureClass} | Proposed action: ${input.action}`,
    `Estimated recovery probability: ${(input.probability * 100).toFixed(1)}%`,
    `Amount: ${formatINR(paise(Math.trunc(input.amountPaise)))}`,
    `Top model drivers (logistic contributions):`,
    attLines,
    ``,
    `Rules: cite ONLY the numbers above verbatim. Never promise or guarantee recovery.`,
    `Never use "will recover", "guaranteed", "certain", or any absolute claim.`,
    `Output plain text only — no markdown, no preamble.`,
  ].join("\n");
}

interface FetchLike {
  (url: string, init: unknown): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

const cache = new Map<string, NarrativeResult>();
const CACHE_MAX = 512;

async function callClaude(
  input: CaseBriefInput,
  apiKey: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: NARRATIVE_MODEL,
        max_tokens: 120,
        temperature: 0, // determinism contract §3.3
        system:
          "You write terse, compliant recovery case briefs for payment merchants. " +
          "You never make promises about outcomes and never invent numbers.",
        messages: [{ role: "user", content: buildPrompt(input) }],
      }),
    });
    if (!res.ok) throw new Error(`claude http ${res.status}`);
    const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = (body.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
      .trim();
    if (!text) throw new Error("claude empty response");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export interface NarrateOptions {
  apiKey?: string; // default env ANTHROPIC_API_KEY
  fetchImpl?: FetchLike; // injectable for tests
  timeoutMs?: number; // default 8000 — narrative never stalls the pipeline
  noCache?: boolean;
}

/**
 * Produce the case brief. Order: cache → Claude(temp 0) → validator → store;
 * any failure ⇒ deterministic fallback. Total function: never throws.
 */
export async function narrateCase(
  input: CaseBriefInput,
  opts: NarrateOptions = {},
): Promise<NarrativeResult> {
  const key = caseKey(input);
  if (!opts.noCache) {
    const hit = cache.get(key);
    if (hit) return hit;
  }

  let result: NarrativeResult;
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    result = { text: fallbackNarrative(input), source: "fallback", flagged: false, promptVersion: PROMPT_VERSION };
  } else {
    try {
      const raw = await callClaude(
        input,
        apiKey,
        opts.fetchImpl ?? (fetch as unknown as FetchLike),
        opts.timeoutMs ?? 8000,
      );
      const v = validateNarrative(raw);
      result = {
        text: v.text || fallbackNarrative(input),
        source: "claude",
        flagged: v.flagged,
        promptVersion: PROMPT_VERSION,
      };
    } catch {
      result = { text: fallbackNarrative(input), source: "fallback", flagged: false, promptVersion: PROMPT_VERSION };
    }
  }

  if (cache.size >= CACHE_MAX) cache.clear(); // bounded, deterministic reset
  cache.set(key, result);
  return result;
}

/** Test/ops hook — empties the memo cache. */
export function clearNarrativeCache(): void {
  cache.clear();
}
