# Revised Implementation Plan — Track 03: AI Revenue Recovery

> Scoped strictly against the official Track 3 brief:
> *"Build an agent that detects revenue at risk, determines the right intervention, and executes a bounded recovery workflow: from payment failures and checkout abandonment to overdue receivables."*
> Example directions given: Payment degradation → root cause → recovery action · Checkout drop-off recovery · Failed-subscription recovery · B2B receivables chaser · Mandate retry sequencer · Hinglish voice recovery · Promise-to-pay tracker.

**Chosen sub-scope:** Payment-failure recovery for recurring/subscription payments (covers *"Payment degradation → root cause → recovery action,"* *"Failed-subscription recovery,"* *"Mandate retry sequencer,"* and *"Promise-to-pay tracker"* — 4 of the 7 listed example directions). Checkout drop-off recovery and B2B receivables chasing are **not** built; this is a deliberate depth-over-breadth choice, not an omission, and should be stated explicitly in the README (see T12).

**Note on "the bar" — RESOLVED, verified against the live page (Aug 25, 2026):** The live buildathon page (razorpay.com/buildathon) states Track 03's bar verbatim: *"Don't just identify the problem. Show measured money recovered across a batch, with compliant escalation, stopping rules, and an audit trail."* The local `tracks.md` copy omits it — it is stale/truncated (every other track has a bar block in that file). Treat this as a **hard grading criterion**, not folklore. All Required tasks below already satisfy it (T7 → stopping rules / compliant escalation, T9 → audit trail, T11 → measured money recovered); additionally, the README must carry a short **bar → artifact traceability table** so judges can tick the rubric directly (see T12).

---

## 1. Required Track 3 Work

Tasks are ordered for implementation; each names its dependency so you can see what blocks what.

### T1 — Environment & Credentials Setup
- **Purpose:** Unblock every downstream task that touches a real API.
- **Files/Components:** `.env`, `.env.example`
- **Required changes:** Generate Razorpay **test-mode** keys; verify with one API call (e.g., create a UPI payment link); generate an Anthropic API key; locate the Buildathon application Google Form and **record the exact deadline and team-size rules** (third-party listings suggest ~Sept 5, 2026 — verify against the form itself).
- **Dependencies:** None.
- **Validation:** A test-mode API call succeeds from the command line; `.env.example` lists every required variable with no real secrets committed; exact deadline recorded in this document.

### T2 — Repo & Monorepo Scaffold
- **Purpose:** Shared types across dashboard, pipeline, and simulator; one place for a solo builder to lose the least time.
- **Files/Components:** `pnpm-workspace.yaml`, `app/`, `packages/core/`, `packages/simulator/`, `packages/seed/`, `tests/`
- **Required changes:** Next.js (App Router) init; pnpm workspaces; SQLite + Drizzle ORM wired with an initial migration.
- **Dependencies:** None (can run in parallel with T1).
- **Validation:** `pnpm install && pnpm dev` boots an empty dashboard with no errors.

### T3 — Data Model & Migrations
- **Purpose:** Persistent structure for every stage of the recovery loop.
- **Files/Components:** `packages/core/db/schema.ts`, migrations
- **Required changes:** Tables for `customers`, `payment_events`, `diagnoses`, `policy_decisions`, `actions`, `audit_log`, `promises_to_pay`, `metrics_runs`, `idempotency_keys`. Money stored as integer paise; timestamps in UTC.
- **Dependencies:** T2.
- **Validation:** Migration runs clean on a fresh DB; a basic insert/query round-trip passes for each table.

### T4 — Seed Data Generator
- **Purpose:** Reproducible synthetic "revenue at risk" input — this *is* the detection target the agent works on.
- **Files/Components:** `packages/seed/`
- **Required changes:** Deterministic RNG-seeded generator producing customers plus failed-payment events across a failure taxonomy (`SOFT_RETRYABLE`, `HARD_METHOD_DEAD`, `NETWORK_TIMEOUT`, `RISK_FLAGGED`, `UNKNOWN`) with per-customer behavior params (`payday_affinity`, `channel_responsiveness`). **Volume: ~60 customers × ~4 events each ≈ 220–240 events.** Do not cut event count without proportionally cutting customers: diagnosis quality (T6) depends on per-customer history depth (≥3 prior data points), so a pure event-count trim would thin history below usable levels. This size keeps statistical legibility without solo-builder verification overhead.
- **Dependencies:** T3.
- **Validation:** `pnpm seed` is byte-identical across runs; failure-class shares fall within **±5 percentage points** of the configured distribution per class (asserted with tolerance bands — exact-equality assertions fail spuriously under random sampling).

### T5 — Ingestion Layer (Webhook + Replay)
- **Purpose:** Directly implements "detects revenue at risk" for the failed-payment case.
- **Files/Components:** `app/api/webhooks/razorpay/route.ts`, `packages/core/ingestion/replay.ts`
- **Required changes:** HMAC signature verification on the webhook; idempotency on `event.id`; a replay path that feeds seed fixtures through the same pipeline entrypoint used by the webhook.
- **Dependencies:** T3, T4.
- **Validation:** A duplicate webhook delivery produces exactly one row; an unsigned request is rejected and logged; replay processes the full seed batch without error.

### T6 — Diagnosis Engine
- **Purpose:** Implements "root cause" and "determines the right intervention" from the brief.
- **Files/Components:** `packages/core/diagnosis/`
- **Required changes:** Deterministic fact-sheet summarizer (history → compact JSON) fed to a Claude call with JSON-schema-constrained output (temperature 0); a confidence field; a static rule-table fallback for when the API is unreachable; caching keyed on (event hash, prompt version).
- **Dependencies:** T5, T1.
- **Validation:** Golden-case tests pass for all 5 failure classes; forcing the API call to fail still returns a valid diagnosis via the fallback; identical input produces identical output on rerun.

### T7 — Policy Engine
- **Purpose:** Implements "bounded" from the brief — the single mechanism that keeps the LLM's output from becoming unsupervised money-adjacent authority.
- **Files/Components:** `packages/core/policy/`, `policy.yaml`
- **Required changes:** Pure, synchronous evaluator with rules for max attempts, minimum interval, quiet hours (IST), an exposure cap, opt-out enforcement, promise-to-pay pause, and confidence/risk-based routing to human review.
- **Dependencies:** T6.
- **Validation:** Each rule fires correctly in isolation (unit-tested); a deliberately out-of-policy scenario returns `REFUSE` with the matched rule ID.

### T8 — Action Executors
- **Purpose:** Implements "executes a...recovery workflow" — the actual recovery mechanics, covering the "Mandate retry sequencer" and "Payment degradation → recovery action" directions.
- **Files/Components:** `packages/core/actions/`
- **Required changes:** Three idempotent executors: sequenced retry (via saved token), alternate-method UPI payment link, promise-to-pay tracker. All customer-facing sends are marked `SIMULATED`.
- **Dependencies:** T7, T1.
- **Validation:** Re-invoking an executor with the same idempotency key produces no duplicate API call or customer contact.

### T9 — Audit Ledger
- **Purpose:** The explainability/audit-trail requirement implied directly by "bounded" and consistent with every other track's stated bar.
- **Files/Components:** `packages/core/audit/`
- **Required changes:** Append-only writer for the full `trigger → diagnosis → policy → action → outcome` chain, including refusals; stamp `config_version` and `prompt_version` on every write.
- **Dependencies:** T6, T7, T8.
- **Validation:** ≥95% of replayed events have a complete chain (trigger→outcome or trigger→refusal); at least one seeded scenario produces a queryable `REFUSE` entry.

### T10 — Dashboard (Core Views Only)
- **Purpose:** The human-visible proof surface for the video and for judges re-running the demo.
- **Files/Components:** `app/` — inbox view, customer timeline view, batch-run trigger
- **Required changes:** Failed-payments inbox (class + confidence), timeline view rendering the audit ledger per customer, a button to trigger a replay batch.
- **Dependencies:** T5–T9.
- **Validation:** Dashboard reflects real diagnosis/policy/action data, not mocked UI; timeline matches `audit_log` rows exactly.

### T11 — Batch Result Reporting (Control vs. Agent)
- **Purpose:** Quantified evidence that the agent actually "wins back" revenue, directly answering "find revenue that's slipping away and win it back."
- **Files/Components:** `packages/simulator/`
- **Required changes:** Replay the seed batch through **two** conditions: no-intervention control, and the full pipeline. Run **≥100 Monte Carlo iterations per arm** over the same seeded batch, reporting ranges rather than single-run point estimates. Report recovered ₹, recovery rate, and contacts made, using a documented, cited probability model per failure class.
- **Dependencies:** T4–T9.
- **Validation:** Report renders for both conditions on the same seed with iteration ranges; the full-pipeline condition shows measurably higher recovered ₹ than the control; every probability parameter is documented with its rationale in `docs/metrics-methodology.md`.

### T12 — Core Documentation
- **Purpose:** Required submission artifacts; also the place to record the deliberate sub-scope decision.
- **Files/Components:** `README.md`, `ARCHITECTURE.md`, `docs/policy-model.md`, `docs/metrics-methodology.md`, `docs/what-broke.md`
- **Required changes:** Write each doc. Explicitly state in the README/ARCHITECTURE that checkout-abandonment and B2B-receivables directions were consciously out of scope for this build. Include in the README a short **Track 03 bar → artifact traceability table** mapping each phrase of the confirmed bar to its artifact: *measured money recovered across a batch* → T11 report · *compliant escalation, stopping rules* → T7 policy engine + refusal records · *audit trail* → T9 ledger. Include in `docs/policy-model.md` one paragraph acknowledging real-deployment consent norms (DND/TRAI, RBI conduct guidance on recovery outreach) and how the policy rules mirror them — sends are simulated; say exactly that. Start `what-broke.md` on day one, update as issues actually occur.
- **Dependencies:** Ongoing; finalized after T11.
- **Validation:** Fresh clone → quickstart works in under 5 minutes; every numeric assumption in the methodology doc has a stated source or rationale.

### T13 — Resilience/Chaos Check
- **Purpose:** Proves the failure-handling expectation shared across tracks and guards the one failure mode that would actually be disqualifying — duplicated money actions.
- **Files/Components:** test scripts / manual test procedure
- **Required changes:** Kill the process mid-batch-replay, restart, confirm the ledger shows no duplicate actions; force a Claude API failure and confirm the rule-fallback path engages.
- **Dependencies:** T5–T9.
- **Validation:** No duplicate rows in `actions` or `idempotency_keys` after a crash/restart; fallback diagnosis produced when the API is unreachable.

### T14 — Demo Video
- **Purpose:** Standard submission requirement across all tracks, and the only way judges see the guardrail behavior on camera.
- **Files/Components:** recording, linked from README
- **Required changes:** Record: seed → run → inbox → timeline → results table → one deliberate policy refusal shown live.
- **Dependencies:** T10, T11, T13.
- **Validation:** ≤5 minutes, captioned, every on-screen claim traceable to a command a viewer could re-run themselves.

---

## 2. Day-by-Day Schedule & Effort Budget

Core work (T1–T14) estimates at **36–49 hours** against **33–44 available** (~11 days × 3–4 hrs). Feasible only if Days 10–11 are protected for docs/video — the artifacts reviewers see first. Each day's gate reuses the matching task validation from Section 1.

| Day | Tasks | Gate |
|---|---|---|
| D0 | T1 — credentials + **record exact deadline from the form** | test-mode API call succeeds; deadline noted |
| D1 | T2, T3 | empty dashboard boots; migrations round-trip |
| D2 | T4 | seed byte-identical; class shares within ±5pp bands |
| D3 | T5 | duplicate webhook → one row; unsigned rejected; replay clean |
| D4 | T6 | 5/5 golden classes pass; forced API-failure fallback works |
| D5 | T7, start T8 | every rule fires in isolation; out-of-policy REFUSE logged |
| D6 | finish T8, T9 | idempotency proof; ≥95% complete audit chains |
| D7 | T10 | dashboard shows real data; timeline ≡ ledger rows |
| D8 | T11 | A/B report with ranges; pipeline > control on recovered ₹ |
| D9 | T13 + buffer | kill/restart drill → zero duplicate actions |
| D10–11 | T12 finalize, T14 video | fresh clone <5 min; video ≤5:00, captioned |

**Never cut, under any circumstances:** T9 (audit ledger) · T11 (batch measurement) · the on-camera guardrail-refusal moment.
**Cut order when behind** (see Section 3): MCP Q&A surface → voice follow-up → dashboard polish → second-module expansion.

---

## 3. Optional Improvements (only if core work finishes early)

| Improvement | Why it's optional, not required |
|---|---|
| **Naive-retry baseline as a third condition** (blind retry-all, no diagnosis) | Strengthens the argument that *diagnosis* — not just automation — is what recovers revenue efficiently. Adds real value but isn't needed to satisfy the brief; the two-condition version in T11 already proves the core claim. |
| **Policy editor UI** (YAML form in the dashboard) | The brief requires the workflow to be *bounded*, not that the bound be editable through a UI. Direct YAML file editing already satisfies this. |
| **Hinglish voice follow-up** | This is a listed Track 3 example direction, so it's legitimately in-scope — but ElevenLabs/Twilio integration is a multi-day detour for uncertain demo payoff. Keep as a true stretch, attempted only after every Required task above is done. |
| **Read-only Razorpay MCP diagnostic Q&A surface** | Interesting technical showcase, but doesn't advance detection, diagnosis, intervention, or the audit trail — the four things the brief actually asks for. Cut first under time pressure. |
| **Checkout drop-off recovery / B2B receivables chaser modules** | Both are legitimate Track 3 directions not yet covered. Worth adding only as a second module if the payment-failure loop (T1–T14) is fully working with time to spare — don't start these before the core loop is solid. |

---

## 4. Work Removed (out of Track 3's implementation scope)

| Removed item | Reason |
|---|---|
| **Section 1 competitive analysis** — comparing Track 3 against Tracks 1, 2, 4, and the Open Track, plus the weighted-scoring justification for picking Track 3 | This is track-*selection* reasoning, not Track 3 *implementation* work. It doesn't build anything the brief asks for. Keep it as a personal note or pitch preamble if you like, but it isn't a build task and shouldn't consume plan/schedule time. |
| **"Hiring filter" / recruiting narrative framing and rehearsed panel Q&A** (Section 16) | Interview preparation, not implementation. Useful to have ready separately, but out of scope for an implementation plan. |
| **"Confirm Bangalore relocation viability" checklist item** | Personal logistics, unrelated to any technical requirement of Track 3. |
| **Any Dispute/RTO, fraud-scoring, or UPI-Reserve-Pay/agentic-checkout features** | Your own research correctly identifies these as Track 2 and Track 1 territory respectively. None appear in the plan's actual build tasks, but flagging this explicitly so scope doesn't drift toward them later — a "risk flag → route to human" field in the diagnosis output (T6) is fine and stays in scope; building an actual fraud/risk-scoring model would not be. |

---

## Summary of What Changed

- Kept: the four-stage pipeline (diagnose → policy → act → audit), the seed/replay approach, idempotency discipline, the audit ledger, and the documentation set — all directly traceable to the brief's own language ("detects," "determines," "executes," "bounded").
- Trimmed: seed volume (400 → ~150–200 events), simulator scope (three arms → two required, third made optional), dashboard scope (policy-editor UI made optional), voice/MCP stretch goals confirmed as non-required.
- Removed: track-comparison narrative, hiring/panel-prep content, and one personal-logistics checklist item — none of these build anything Track 3 asks for.
- Added: an explicit instruction to state your chosen sub-scope (payment-failure recovery) in the README, since the brief's directions span a wider surface (checkout abandonment, receivables) than this build covers.

---

## Project-Level Definition of Done

All must hold before submission:

1. Fresh clone → `pnpm install && pnpm seed && pnpm dev` → working demo in <5 minutes (verified on a machine other than the dev machine).
2. ≥95% of replayed events carry a complete trigger→outcome/refusal chain in the audit ledger.
3. Batch report shows measured recovered ₹ with Monte Carlo ranges; every parameter sourced in `docs/metrics-methodology.md`.
4. Chaos drill passed: process killed mid-replay and restarted → no duplicate actions, no corrupted rows.
5. One deliberate policy refusal demonstrated on camera in the video.
6. Docs complete: README (incl. bar→artifact traceability table), ARCHITECTURE, policy-model (incl. compliance paragraph), metrics-methodology, what-broke with ≥5 genuine entries.
7. Repo public, secrets scanned, `.env.example` accurate, no real PII anywhere.

---

## Amendment Log

- **Aug 25, 2026 — post-review amendments:** Verified Track 03's "THE BAR" verbatim against the live buildathon page and rewrote the bar note accordingly (was flagged unverified; local `tracks.md` is the stale copy). Reinstated exact-deadline confirmation in T1. Rebalanced seed volume to ~60 customers × ~4 events (~220–240) to preserve per-customer history depth for T6 diagnosis; added ±5pp tolerance bands to T4's share validation and ≥100 Monte Carlo iterations with range reporting to T11. Added README bar→artifact traceability table and compliance-paragraph requirements to T12. Restored day-by-day schedule with effort budget (Section 2), never-cut list, cut order, and a project-level Definition of Done.
