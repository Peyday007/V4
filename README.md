# Deal Dispatch

An AI-operated deal discovery and execution platform for three connected business models: **subcontracting**, **brokerage** and **distribution**.

This is not a marketplace, a CRM or a lead database. It is a dispatch board for business opportunities: the AI finds signals, decides which deserve attention, works out who must be called and why, prepares the caller, analyses the conversation, updates every affected record, configures the deal, and escalates only what requires human judgement.

**AI runs the operation. Callers execute conversations. Management handles approvals, exceptions and high-value decisions.**

---

## Quick start

```bash
# 1. Postgres
createdb dealdispatch

# 2. Configure
cp .env.example .env
#    Fill in the Required block: DATABASE_URL, DIRECT_URL, SESSION_SECRET.
#    (Running your own Postgres? DIRECT_URL is just the same value.)
#    Nothing else is needed — every external provider ships with a working mock.

# 3. Install and set up
npm install
npm run db:push          # or: npm run db:deploy  (applies the migration)
npm run db:seed          # runs the real engines against seeded inputs

# 4. Run
npm run dev              # http://localhost:3000
npm run worker           # optional: background job worker in a second shell
```

Sign in at `/login`. Every seeded account uses the password `demo-password-123`:

| Account | Role | What they see |
|---|---|---|
| `owner@dealdispatch.test` | Owner | Everything |
| `manager@dealdispatch.test` | Deal Manager | Pipeline, approvals, negotiations |
| `dana@dealdispatch.test` | Caller | Only their own call queue |
| `marcus@dealdispatch.test` | Caller | Only their own call queue |
| `research@dealdispatch.test` | Research Reviewer | Signals, companies, enrichment |
| `finance@dealdispatch.test` | Finance & Compliance | Pricing, margin, risk, documents |
| `admin@dealdispatch.test` | Administrator | Configuration, integrations, audit |

Sign in as the Caller to see the difference: no dashboard, no margins, no other callers' work — just the next conversation and everything needed to have it.

**Deploying it?** See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — Vercel + Neon, about fifteen minutes.

---

## The operating loop

Every stage below is implemented and runs on seeded data:

```
Discover signals                     lib/discovery/run.ts, connectors/
   ↓
Classify: subcontracting/brokerage/distribution/hybrid   lib/ai/classify.ts
   ↓
Group, qualify, promote to opportunity                   lib/discovery/promote.ts
   ↓
Score across 17 dimensions                               lib/ai/scoring.ts
   ↓
Match buyers to fulfillment partners                     lib/ai/matching.ts
   ↓
Decide the single next action                            lib/ai/nextAction.ts
   ↓
Build a call assignment and route it to a caller         lib/ai/callAssignment.ts
   ↓
Caller dials from the platform                           lib/calling.ts
   ↓
Transcribe, extract facts, update the graph              lib/ai/transcript.ts
   ↓
Configure the deal from confirmed data only              lib/ai/dealConfig.ts
   ↓
Escalate what needs judgement, request approval          lib/ai/escalation.ts
   ↓
Move the opportunity, plan the day, score the lane       lib/ai/planner.ts, lanes.ts
```

### Seeing it work

The seed does not hand-write finished deals. It seeds *inputs* — companies, contacts, capabilities, data sources — then runs the real engines. Discovery finds 37 signals across 6 sources, promotes them into 14 opportunities, and 7 demonstration conversations run through the actual transcript pipeline. Records update from what was said, not from fixtures.

To watch a full cycle yourself:

1. **Dashboard** → *Run discovery*. Sources are polled, signals detected, opportunities opened, scored, matched and given next actions.
2. **Dispatch board** → filter by *One fact away* or *No next action*.
3. **Call queue** (as `dana@`) → open a call, press *Start call*, paste a speaker-labelled transcript, press *End call*.
4. Watch the opportunity: facts appear in the ledger with their source quotes, the buyer need fills in, matching re-runs, the deal reconfigures, and a new next action is set — with no manual data entry.

---

## Design decisions worth knowing

**Every AI process has a deterministic path.** The rule engines are the product; the LLM improves phrasing and extraction recall on top of them. With `LLM_PROVIDER=mock` (the default) everything works and results are repeatable — which is also what makes the engines unit-testable. When an LLM is configured and a call fails, the system falls back to the rules rather than stalling the board.

**Inference is never confirmation.** Every fact carries a status (`CONFIRMED`, `CLAIMED`, `ESTIMATED`, `INFERRED`, `CONTRADICTED`, `STALE`, `MISSING`), a confidence, and the literal source quote it came from. A licence number read out on a call is `CLAIMED` until verified with the issuing authority — treating it as confirmed is how unlicensed work gets let.

**Missing terms are reported, never invented.** If a deal cannot be configured, `lib/ai/dealConfig.ts` returns the exact list of what is unknown and the next-action engine creates the calls to go get it. Documents write `[Freight — NOT CONFIRMED, obtain before sending]` rather than a plausible number.

**Role comes from record structure, not keywords.** An award notice describing "prime contractor is expected to subcontract" is about a transaction — the words describe other parties, not the subject. Connectors declare the subject's role explicitly; keyword inference is reserved for records where a company describes itself. Getting this wrong files buyers as suppliers, which then poisons matching.

**A match score is an argument, not a verdict.** Every candidate carries the factors actually confirmed, the ones that look wrong, the questions outstanding, and the specific calls needed before they can be shown to a buyer. Compliance failures cap the score regardless of other merits.

**Value the opportunity, not the record.** A $2.85M award is not a $2.85M subcontracting opportunity. Where the record states a subcontracting goal, that is the basis; where it does not, no value is asserted and it is reported as missing.

**Below the sample size, the system says nothing.** Deal-lane recommendations refuse to make a strategic call below the configured minimum sample. Three wins in a row is noise, and telling an operator to scale on noise is worse than staying silent.

**Callers are measured on outcomes.** Confirmed needs, pricing obtained, matches enabled, gross profit influenced — not dials. Coaching recommendations are advisory only; the system flags evidence for a manager and never takes action against a worker.

---

## Documentation

| Document | Contents |
|---|---|
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Deploying to Vercel + Neon, the scheduler, and serverless caveats |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System layers, data model, engines, job queue, request lifecycle |
| [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) | Provider interfaces, wiring Twilio / Deepgram / SMTP / S3 / Anthropic, webhooks |
| [`docs/ASSUMPTIONS.md`](docs/ASSUMPTIONS.md) | Assumptions made, deliberate limits, what is not built |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | Running the loop, scheduling, configuration, security posture |

---

## Commands

```bash
npm run dev            # development server
npm run build          # production build
npm run start          # production server
npm run worker         # background job worker
npm run ops:tick       # one-shot job drain (for cron)
npm run ops:tick -- --plan   # discovery + follow-ups + daily plan + analytics

npm run test           # 70 unit tests over the engines
npm run typecheck      # strict TypeScript, no errors
npm run db:push        # sync schema (development)
npm run db:deploy      # apply migrations (production)
npm run db:seed        # seed the demonstration
npm run db:reset       # wipe and re-seed
```

---

## Stack

Next.js 14 (App Router) · TypeScript (strict) · React 18 · PostgreSQL · Prisma · Zod
Session auth with scrypt-hashed passwords · role-based access control enforced server-side
Postgres-backed durable job queue · provider abstraction for LLM, telephony, transcription, email and storage

## Data collection

Discovery connectors declare an `accessBasis` — the documented reason the access is permitted — which is shown in the UI next to every source. Connectors must respect robots directives, rate limits, authentication boundaries, contractual restrictions and applicable law. Nothing in this codebase bypasses access controls, logs into a portal on a user's behalf, or scrapes anything behind authentication. The built-in connectors run against a fixture corpus; the CSV connector handles first-party data. Before enabling a live source, confirm its terms permit the intended access and use.
