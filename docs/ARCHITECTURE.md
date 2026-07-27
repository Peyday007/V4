# Architecture

## Layers

```
app/                    Next.js App Router — server components read, route handlers write
  (app)/                Authenticated shell: dashboard, board, workspace, call console, admin
  api/                  Route handlers. Every one starts with a permission check.
components/             Client components (dialer, action buttons, config editor) + shared UI
lib/
  auth/                 Sessions, scrypt passwords, RBAC matrix, page guards
  providers/            LLM, telephony, transcription, email, storage — interface + mock + real
  discovery/            Connector framework, signal catalogue, ingestion, promotion
  ai/                   The engines: classify, score, match, next action, deal config,
                        transcript intelligence, escalation, planner, lanes, analytics, documents
  jobs/                 Durable Postgres-backed queue, handlers, worker loop
  config.ts             Org operating rules — every AI threshold lives here, not in code
  compliance.ts         Suppression, consent, calling hours, recording jurisdiction
  calling.ts            Place and log calls; hands off to the analysis pipeline
prisma/                 Schema (60+ models), initial migration, seed
scripts/                worker.ts (long-running), tick.ts (cron one-shot)
tests/                  70 unit tests over the pure engine functions
```

## Request lifecycle

**Reads** are React Server Components. They call `requirePagePermission(...)`, which redirects to `/no-access` when the role lacks the permission, then query Prisma directly with `orgId` scoping. Financial fields are omitted from the rendered output for roles without `finance.margin.read` — the data never reaches the client.

**Writes** go through route handlers in `app/api/`. Each one:

1. `requirePermission(...)` / `requireAny(...)` — throws `AuthError`, mapped to 401/403.
2. Validates the body with Zod.
3. Verifies the target record belongs to the caller's org.
4. Performs the work, usually by calling an engine in `lib/ai/`.
5. Writes an `AuditEvent` and, for AI actions, an `AIDecision`.
6. Returns JSON; the client calls `router.refresh()` to re-render the server components.

## Data model

Sixty-one Prisma models. The shapes that matter:

**The graph.** `Company` ← `Contact`, `CompanyLocation`, `CompanyCapability`, `CompanyProduct`, `CompanyIndustry`, and `Relationship` (company → company, typed by `RelationshipKind`). Companies carry their role in a deal (`CompanyRole`), movability classification, and account stage.

**Evidence and signals.** `DataSource` → `SourceEvidence` → `DiscoverySignal`. Evidence is content-hashed so re-running a source updates `lastCheckedAt` instead of duplicating. Signals are deduplicated on `(signalKey, company, externalId)`.

**Demand and supply.** `BuyerNeed`, `SupplierAvailability`, `SubcontractorCapacity` — each with a `FactStatus`, a confidence, and a staleness date after which the figure must be re-verified rather than reused.

**The deal.** `Opportunity` → `OpportunityParty`, `Match`, `Deal` (→ `Cost`, `Margin`), `Quote` → `QuoteLineItem`. Scores are written to `OpportunityScore`, never updated.

**Work.** `CallAssignment` → `Call` → `CallRecording` / `Transcript` → `ExtractedFact`, `Commitment`, `Objection`. Plus `Task`, `NextAction`, `Escalation`, `Approval`, `Document`, `Message`, `Notification`.

**Governance.** `AIDecision`, `AIOverride`, `AuditEvent`, `ActivityEvent`, `DealStatusHistory` — all append-only.

### Append-only tables

`DealStatusHistory`, `ActivityEvent`, `AuditEvent`, `AIDecision`, `AIOverride` and `OpportunityScore` are never updated or deleted. A stage change writes a new history row; a rescore writes a new score row and the latest wins. This is what makes "why is this deal here?" answerable months later.

### Fact reconciliation

When a new fact arrives with the same key as an existing one but a different value:

- If the prior fact was `CONFIRMED`, both are marked `CONTRADICTED` and an escalation is raised — two sources disagree and a person must adjudicate.
- Otherwise the prior is marked `STALE` and superseded, with `supersededById` linking the chain.

Fact keys are specific enough not to collide: insurance limits are keyed by coverage type (`capacity.insurance_limit.workers_comp`), because "$2M general liability and $1M workers comp" is two limits, not a contradiction.

## The engines

Each engine is a module in `lib/ai/` exporting pure functions plus a persisting wrapper. The pure functions are what the tests exercise.

| Engine | Pure core | What it decides |
|---|---|---|
| `classify.ts` | `classifyTextDeterministic`, `classifyCompanyRole`, `classifySide` | Deal model, company role, demand vs supply |
| `scoring.ts` | `expectedOpportunityValue`, `compositeFromDimensions`, `derivePriority` | 17 dimensions → composite + expected value |
| `matching.ts` | `evaluateCandidate` | Ranked candidates with factors, gaps and calls needed |
| `nextAction.ts` | `planNextAction` | The single next action, as an ordered decision table |
| `dealConfig.ts` | per-model builders | Deal terms, or the exact list of what is missing |
| `extractors.ts` | `extractFacts`, `extractCommitments`, `extractObjections` | Structured facts from raw conversation |
| `vulnerability.ts` | `recommendWedge`, `recommendExpansion` | Movability class and the cheapest way in |
| `lanes.ts` | `recommendLane` | Scale / test / fix / pause / abandon |
| `analytics.ts` | `recommendCoaching` | Caller coaching from outcomes |

### Next-action decision table

`planNextAction` runs rules in dependency order and the first match wins, which keeps "one primary next action" literally true:

0. Open escalation → `RESOLVE_BLOCKER` (the AI stops advancing by design)
1. No company → `RESEARCH_COMPANY`
2. No reachable contact → `FIND_DECISION_MAKER`
3. Supply-side with no buyer → `CONFIRM_AVAILABILITY`, then `RESEARCH_COMPANY` to find demand
4. No buyer need → `QUALIFY_BUYER_NEED` (call)
5. Need unconfirmed or incomplete → `QUALIFY_SCOPE` / `CONFIRM_TIMELINE` (call)
6. No fulfillment candidate → `FIND_SUBCONTRACTORS` / `FIND_SUPPLIERS` (status `BLOCKED`)
7. Candidate claims unverified → `VERIFY_LICENSING_INSURANCE` / `CONFIRM_CAPACITY` (call)
8. No cost basis → `REQUEST_PRICING` (call)
9. Several priced candidates → `BUILD_COMPARISON`
10. Deal not configurable → `CONFIRM_SPECIFICATIONS`
11. Over the approval limit → `OBTAIN_APPROVAL`
12. Quote lifecycle → `PREPARE_QUOTE` → `SEND_QUOTE` → `FOLLOW_UP_QUOTE` → `SCHEDULE_FULFILLMENT` / `REQUEST_BACKUP_STATUS`
13. Neglected over 7 days → `CHECK_ACTIVE_WORK`
14. Nothing safe → `ESCALATE`

Every action carries a reason, owner role, due date, required inputs, expected result, completion criteria, fallback action and escalation condition.

## Background jobs

`Job` rows in Postgres. Claiming uses a conditional `updateMany` guarded on `status = 'QUEUED'`, so a losing worker updates zero rows and moves on — no advisory locks, no external broker.

- Retries use exponential backoff, capped at 5 minutes; exhausted jobs become `DEAD`.
- Jobs stuck `RUNNING` past a timeout are reclaimed, so a killed worker does not strand work.
- `idempotencyKey` guarantees at most one queued job per logical unit of work.

Handlers chain: `discovery.run_all` → `promote_signals` → `scoring.run` → `matching.run` → `deal.configure` → `next_action.determine`. `planning.daily` runs the whole sweep and writes the operating plan.

Two ways to drive it: `npm run worker` (long-running) or `POST /api/jobs/tick` / `npm run ops:tick` (scheduler-driven). The demo UI drains the queue inline so a discovery run shows results immediately.

## Providers

Every external service sits behind an interface in `lib/providers/` with a mock that fully exercises the dependent code path:

| Interface | Mock behaviour | Real implementation |
|---|---|---|
| `LLMProvider` | Returns the caller's deterministic fallback | Anthropic Messages API with tool-use schema constraint |
| `TelephonyProvider` | Stable synthetic call ids | Twilio, with HMAC webhook verification |
| `TranscriptionProvider` | Segments supplied text by speaker turns | Deepgram with diarization |
| `EmailProvider` | Captures to an in-memory outbox | SMTP (transport left to wire) |
| `StorageProvider` | Local disk, hashed paths, mode 0600 | S3 (SDK left to wire) |

Swapping a provider is one environment variable. Nothing above the interface changes.

## Security

- Sessions are opaque random tokens; only a SHA-256 hash is stored. Cookies are `httpOnly`, `sameSite=lax`, and `secure` in production.
- Passwords use scrypt with a per-password salt and constant-time comparison.
- Authorisation is server-side on every page and route. Hidden UI is never the control.
- Multi-tenancy: every query filters by `orgId`, and route handlers re-verify the target record's org before acting.
- Files are never publicly readable — `/api/files` authenticates, checks org ownership, honours link expiry and audits the download.
- Rate limiting on login, discovery runs, calls and job ticks.
- Transcripts are scanned for sensitive data (SSN, card, bank, credential patterns) and flagged; log output is redacted via `redactForLogs`.
- Security headers set in `next.config.mjs`.
