# Assumptions and deliberate limits

The brief asked for the MVP loop (§32) to be built completely before expanding. This document records the assumptions that shaped the build, what was deliberately left out, and the known limits of what is here.

---

## Starting point

The repository was empty. Everything is new: no existing schema, conventions or stack to inherit. The preferred stack from the brief (Next.js, TypeScript, React, PostgreSQL, Prisma) was followed exactly.

---

## Assumptions made

**Single organisation per deployment, multi-tenant schema.** Every tenant-scoped row carries `orgId` and every query filters by it, so a second organisation can be added without a migration. The seed creates one.

**Roles are fixed; permissions within them are data.** The six roles from the brief are seeded as system roles with a permission matrix in `lib/auth/rbac.ts`. Adding a permission is a code change; reassigning a user is not. A fully dynamic role editor was not built — it is administration, not the operating loop.

**Callers work a queue, not a CRM.** The caller UI has no record editing at all. Everything a caller learns reaches the database through transcript extraction. This is the strongest interpretation of "the caller should not manage the CRM manually", and it is why extraction quality is treated as a first-class concern with its own test suite.

**Transcripts arrive as speaker-labelled text.** With a real carrier and transcription provider this comes from diarization. Without one, the caller pastes the conversation into the console. Both paths run identical extraction — no separate "manual entry" mode exists.

**Money is `Decimal(14,2)`, single currency.** Multi-currency was not built. `Quote.currency` exists for later; nothing converts.

**Deterministic engines are the product.** Every AI process has a rule-based implementation that runs with no credentials. The LLM layer is additive. This makes the system testable, auditable and explainable — a reviewer can see exactly which lexicon entry or threshold produced a decision. It also means classification recall is bounded by the phrase banks in `lib/discovery/signals.ts` and `lib/ai/classify.ts`, which is the trade accepted for that transparency.

**Fixture-backed discovery.** The six non-CSV connectors read a fixture corpus written to look like real source records — same fields, same ambiguity. Live sources need credentials, terms review and per-source parsing, so the connector framework is the deliverable and the fixtures prove it works end to end. The CSV connector is real.

**Estimated values come only from stated figures.** Where a source states a subcontracting goal, that percentage of the award is the opportunity value. Where it does not, no value is asserted and "Budget or estimated value" appears in the missing list. Booking a $2.85M award as a $2.85M opportunity would inflate the pipeline with a number nobody said.

---

## Not built

These are outside the MVP loop the brief asked to complete first.

**Inbound telephony webhook handlers.** The outbound path, the provider abstraction, signature verification and the recording-consent logic are all implemented. The three inbound receiver routes are specified in `docs/INTEGRATIONS.md` but not written, because they cannot be tested without a carrier account.

**Live email and SMS sending.** The `EmailProvider` interface, the mock, the draft generation and the approval gate are complete. The SMTP transport is a stub that throws with a pointer. SMS is modelled (`MessageChannel.SMS`, suppression scopes) but has no provider.

**Calendar scheduling and call transfers.** Modelled in the schema; no provider.

**Search index.** Listing pages use indexed Postgres queries with filters. At the current scale this is correct; a dedicated search index would be premature.

**Real enrichment.** `enrichment.company` deliberately does *not* invent firmographics when no provider is configured — it routes the record to a Research Reviewer instead. Fabricating company data would violate the governance rules the rest of the system enforces.

**Dynamic taxonomy editor.** Industries, services, capabilities, products, territories, scripts and qualification questions are all database-driven and read by the engines at runtime; the admin UI exposes the operating rules (margins, approval limits, staleness, scoring weights) for editing and displays the rest read-only. Full CRUD for each taxonomy is mechanical work that does not exercise the loop.

**Export and deletion request workflows.** Retention fields (`CallRecording.retentionUntil`, `ExtractedFact.reverifyAfter`), suppression and audit logging exist. The subject-request workflow on top of them is not built.

---

## Known limits

**Classification recall is lexicon-bound.** A signal phrased outside the phrase banks will not fire. This fails safe: unmatched text returns `UNCLASSIFIED` with low confidence and goes to human triage rather than being force-fitted into a deal model. Enabling the LLM provider raises recall.

**Company resolution is conservative.** Exact name, then website host, then normalised name. It will produce occasional duplicates rather than risk a false merge — a duplicate is a reviewer's five-minute fix, a bad merge corrupts the graph.

**Discovery produces weak opportunities alongside strong ones.** Signals below the promotion threshold are held for triage, but grouping is per company and category, so a company appearing in several unrelated records can open more than one thin opportunity. They surface correctly in `QUALIFICATION_REQUIRED` with their gaps listed. Tightening this needs real-world signal distributions to tune against.

**Rate limiting is in-process.** Fine for a single instance; a multi-instance deployment needs a shared store.

**Job claiming is polling-based.** Correct and durable, but a busy deployment would benefit from `LISTEN/NOTIFY` or a dedicated broker.

**Caller analytics need volume.** The metrics and coaching rules are implemented and tested, but recommendations gated on sample size stay quiet until enough calls exist — by design, and visible in the seeded data.

---

## Things deliberately made harder

**No next action is allowed to be absent.** Every active opportunity gets one, and when no safe action can be determined the system escalates rather than inventing a step. The dispatch board has a filter specifically for "no next action" so a gap is visible rather than silent.

**Compliance failures cap match scores.** A candidate with insufficient insurance or missing licensure cannot rank highly no matter how well it scores elsewhere. It would have been easier to let the weighted average absorb it.

**Unauthorised caller commitments raise a CRITICAL escalation.** The detector fires on guarantees, price locks, exclusivity and competitor-beating promises. The system flags evidence for a manager and never acts against a worker — the brief was explicit and the code comments say so where a future change might weaken it.

**Documents mark unknowns rather than filling them.** A quote with an unconfirmed freight cost prints `[Freight — NOT CONFIRMED, obtain before sending]`. A plausible number would look more finished and be considerably more dangerous.
