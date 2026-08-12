# Operations

## Running the loop

The operating loop is a chain of durable jobs. There are three ways to drive it.

**A dedicated worker (recommended).**

```bash
npm run worker
```

Polls for queued jobs, processes them with retry and backoff, and reclaims work stranded by a killed worker. Run one or more; claiming is atomic.

**A scheduler.** For deployments without a long-running process:

```bash
*/2 * * * *  cd /app && npm run ops:tick            # drain the queue
0 6 * * *    cd /app && npm run ops:tick -- --plan  # daily sweep
```

`--plan` enqueues discovery across every source, regenerates overdue follow-ups, rescores everything, re-runs vulnerability and lane analysis, writes the operating plan, and snapshots caller metrics.

`POST /api/jobs/tick?max=25` does the same on demand (requires `admin.jobs`).

**Inline.** `POST /api/discovery/run` with `inline: true` drains enough of the queue to carry a fresh signal all the way through promotion, scoring, matching, deal configuration and next-action selection. This is what the *Run discovery* button uses, so results appear immediately.

## Daily rhythm

| When | What | Job |
|---|---|---|
| Every few minutes | Process queued work | `processJobs` |
| Hourly | Regenerate overdue next actions | `followup.generate` |
| Daily, early | Discovery across all sources | `discovery.run_all` |
| Daily | Rescore, reassess movability, re-evaluate lanes, write the plan | `planning.daily` |
| Daily | Caller metric snapshots | `analytics.snapshot` |

The dashboard generates today's plan on first view if it does not exist, so it is never stale even without a scheduler.

## Configuration

Everything the AI uses as a threshold lives in the `ConfigSetting` row keyed `operating_rules`, editable at **Administration → Operating rules**. Defaults are in `lib/config.ts`.

| Group | Drives |
|---|---|
| `scoringWeights` | Relative weight of each scoring dimension; negatives penalise |
| `marginRules` | Margin floor and target, plus the modelled fee/spread/margin per deal model |
| `approvalLimits` | Deal value, gross profit and cash exposure above which a human decides |
| `stalenessRules` | Days before pricing, availability, capacity or verification must be re-confirmed |
| `riskRules` | Insurance minimums, trades requiring licensure, neglect thresholds |
| `callingRules` | Calling hours and days, attempt limits, all-party-consent jurisdictions |
| `planning` | Caller daily capacity, escalation cap, minimum lane sample size |

Changes apply on the next evaluation — no deploy, no restart. Raising `minimumGrossMarginPct` immediately changes what escalates; changing `dealValueRequiringApproval` changes what needs sign-off.

## Compliance controls

Every outbound call passes `checkContactability()` before dialling:

- **Suppression.** Do-not-call and do-not-contact entries, matched on the contact and on a normalised phone number, so formatting cannot defeat the check.
- **Consent.** A contact who withdraws call consent is blocked, and any queued assignments move to `BLOCKED_BY_COMPLIANCE`.
- **Calling hours.** Evaluated in the contact's local timezone against configured hours and weekdays. Outside hours reschedules rather than blocks.
- **Recording consent.** In configured all-party-consent jurisdictions, recording requires explicit recorded consent from the contact. Elsewhere an announcement is required and the script is shown on the call screen. The basis for the decision is stored on the `Call` row.
- **Attempt limits.** After the configured attempts with no contact, the assignment is cancelled and the decision recorded — further dialling is wasted effort and a nuisance.

A do-not-call request detected in a transcript is acted on automatically: the contact is suppressed, consent is revoked, queued assignments are blocked and the call outcome is set to `DO_NOT_CALL`.

## Security posture

- Sessions are opaque tokens; only a SHA-256 hash is stored. `httpOnly`, `sameSite=lax`, `secure` in production, 12-hour expiry.
- Passwords use scrypt with per-password salt and constant-time comparison.
- Authorisation is enforced server-side on every page and route handler. Hidden navigation is never the control.
- Financial fields are omitted server-side for roles without `finance.margin.read` — margins never reach a caller's browser.
- Files are served only through `/api/files`, which authenticates, verifies org ownership, honours expiry and audits the access.
- Transcripts are scanned for SSN, payment card, bank and credential patterns and flagged for review; log output is redacted.
- Rate limits on login, discovery, calls and job ticks.

## Auditing a decision

Every autonomous action writes an `AIDecision` with its decision, reason, inputs, outputs, confidence, the rules applied, and the model and prompt version. Human overrides write an `AIOverride` linked to the decision they replaced.

To reconstruct why a deal is where it is:

1. **Administration → AI decision ledger** — filter by process (`scoring`, `matching`, `next_action`, `deal_configuration`, `escalation`).
2. **Opportunity workspace → Stage history** — every transition with its reason and actor.
3. **Opportunity workspace → Fact ledger** — every fact with its status, confidence and the sentence it came from.
4. **Administration → Audit log** — who did what, when, from where.

None of these tables are ever updated or deleted.

## Backups and retention

Back up Postgres and the object store together — recordings and documents are referenced by key from the database.

Retention fields exist and are populated: `CallRecording.retentionUntil` (one year by default) and `ExtractedFact.reverifyAfter` (from the staleness rules). The sweep job that enforces them is not implemented; see `docs/ASSUMPTIONS.md`.

## Troubleshooting

**Jobs are not running.** Check **Administration → Background jobs**. `DEAD` rows show `lastError`. Confirm a worker is running or the scheduler is hitting `ops:tick`.

**Discovery finds nothing.** Sources deduplicate on content hash — re-running an unchanged source correctly produces no new evidence. Signals below the promotion threshold appear under **Signals** as `TRIAGED` for human review.

**An opportunity has no next action.** Filter the board by *No next action*, then use *Re-run AI loop* on the workspace. If it persists, the escalation rule fired and the reason is on the opportunity.

**A deal will not configure.** The workspace lists the exact missing terms. This is intended: the system reports what is unknown rather than assuming it. The next-action engine will have created the calls to obtain them.

## The caller workspace

A separate surface at `/work`, with its own permission boundary. Callers sign in with a personal PIN — one per person, never one shared code — which resolves to the same `Session` every other user gets, so every read and write is attributable.

**The flow.** Sign in → readiness check → one opportunity → call → outcome and route-specific discovery → save → the next one. Never a board: a caller choosing from a list of two hundred is doing the routing engine's job badly.

**What decides the order**, at serve time, every time:

1. A promised callback that is due
2. Tier A, then the nearest buying window, then Tier B the same way
3. A verified contact and a named decision-maker
4. Lower friction, then supply readiness, then attempt fatigue

**Local business hours are a hard exclusion, not a ranking factor.** A record outside 8:00–18:00 on a weekday *in the prospect's timezone* is removed from the servable set, because a bonus large enough to outrank everything else is exactly how a 4 a.m. call happens. An unknown timezone lowers preference rather than being assumed. Set `CALLING_WINDOW_START` / `CALLING_WINDOW_END` to change it.

**Ownership is a database invariant, twice over.** Two partial unique indexes: one route may be actively owned by one packet, and one caller may hold one live record. Application checks lose both races — two browser tabs each asking for "next" is a real event, not a hypothetical.

**The after-call gate** requires the caller's *last* worked record to carry its outcome's minimum before another is served. Enforced server-side, so a refresh does not walk past it. It is narrow on purpose: one incomplete record blocks new work and nothing else does.

**A failed save is ours.** It raises a `WorkIncident`, preserves everything the caller typed, does not mark the record worked, and holds them with a message that says whose fault it is. System health is evaluated before caller compliance — always.

**Two outcomes are never gated:** do-not-contact and wrong number. Making either harder to record than to ignore is the one requirement that would cause harm.

**Owner side:** `/callers` issues PINs (shown once, never readable again), assigns packets, and lists any system failure blocking somebody. `/demand/opportunity/<routeId>` is the canonical record — assembled from existing rows, with what the source said, what a person said, what was calculated, what we inferred and what is still unknown kept structurally apart.

**Verifying it.** `npm run audit:workspace` drives the real HTTP routes with real cookies. `node scripts/browserCallerWorkspaceCheck.mjs` drives the whole flow through a browser.

## Contact resolution

Demand sources publish licences, permits and solicitations; almost none of them publish a phone number. Contact resolution is the step that turns a routed opportunity into one somebody can ring, and it runs on its own.

**How it is triggered.** Two entry points, one implementation (`lib/enrichment/schedule.ts` → `resolveCompanyContact`):

- **Immediately after routing.** `runDemandPipeline` schedules every organisation behind a live route and enqueues `enrichment.resolve_contacts`. This runs whenever a source run creates or updates events, so a licence found at nine is callable by nine-fifteen rather than tomorrow.
- **Every cron tick.** `/api/cron/tick` runs the backlog **inline, first, with a reserved slice of the invocation** — it does not enqueue a job and hope one gets claimed. It discovers organisations with live demand and no resolution state at all, schedules them in bounded batches, and works them. This is the path that covers demand routed before the workflow existed, which no source run will ever touch again.

  It is reserved rather than merely prioritised. As a job at priority 35 it sat behind `discovery.run_all` and `demand.poll_sources`, both of which do live HTTP with retries and 20-second timeouts inside a 60-second function — so the invocation was killed before the enrichment job was ever claimed, every day, while the cron reported success. Reordering would only have moved the starvation onto whatever ended up last.

Scheduling is keyed by organisation, not by route: four routes off one gym opening share one phone number and one attempt to find it. Claims are conditional updates with `FOR UPDATE SKIP LOCKED`, so several workers — or a redeploy mid-run — produce one attempt rather than duplicates.

**Where it looks.** In order, stopping as soon as the answer is settled:

1. **Records we already hold** — other company rows that are the same business reached by a different route, their contacts, and the contact hints discovery connectors stored beside their signals. Free, and it includes what our own callers have confirmed.
2. **Google Places** — one text-search lookup per organisation, by name and street address. Needs `GOOGLE_PLACES_API_KEY`. Without it the workflow still runs on held data and says so on every affected record.

**What the states mean.** Six outcomes, counted separately on **Demand → Source health → Contact resolution**, because they call for different responses:

| State | Meaning | What happens next |
| --- | --- | --- |
| Resolved | A defensible contact was found and written | Re-checked at the source's freshness horizon (30 days for Places) |
| Ambiguous | Competing candidates the evidence cannot separate | **No automatic retry** — it needs a person; retrying returns the same candidates |
| Nothing published | Every available source searched, no contact exists to find | Re-checked in 14 days |
| Failed | Our lookup broke: outage, timeout, or missing configuration | Widening backoff from 5 minutes, then daily; configuration re-checked every 6 hours with the fix named |
| Waiting / In progress | Scheduled, or being worked now | The next worker pass |
| Stale | Past the age its source can be relied on | Re-resolved automatically |

A failure is never presented as "this business has no phone number". That distinction is the point of the enum.

**Scheduling order.** Tier A first, then by the nearest buying window, then Tier B the same way, then the account with the most routes riding on one number. Applied twice on purpose: once when choosing which organisations to claim, and again to the claimed batch — `UPDATE ... RETURNING` emits rows in whatever order it touched them, so without the second sort a batch is *selected* by priority and *worked* in an arbitrary one.

**Running the backlog by hand.** `npm run enrich:backfill` calls the same sweep the cron calls, with progress output. Safe to stop, restart, and run alongside the cron.

**Verifying it.** `npm run audit:enrichment` drives the production path against Postgres. `npm run audit:cron` starts from a backlog nothing has scheduled and drives the real authenticated HTTP route — that is the one that would have caught the production failure. `node scripts/browserEnrichmentCheck.mjs` drives the flow through a browser against a built server.

## Where the machine is stopped

**Demand → Source health** opens with the whole chain in the order work moves through it, and names only the *first* stage that is not passing work along.

It exists because every other panel in this application reports on its own stage honestly, and that is exactly why none of them can answer "why is nothing happening" — the break is always upstream of wherever you are looking. Fixing stage six while stage two is dry is how a fortnight goes by.

Three rules keep it honest:

- **Downstream stages are not given a verdict.** An empty calling queue below a dry demand source is not a calling problem, and saying so sends somebody to the wrong screen.
- **Supply is a parallel track, not a chain link.** A route with no verified provider is a real gap whether or not the phone rang today, so it keeps its own verdict and is never masked by a demand-side break.
- **Unbuilt stages say `not built`, never `OK`.** Buyer requirements, quotes, delivery and payment do not exist yet. Reporting them green is how a system claims to be finished having moved no money — and it is why no source, route or caller can currently be credited with profit.

## Scheduling in production

The loop only runs if something calls it. Two endpoints, both authenticated with `CRON_SECRET` as either `Authorization: Bearer <secret>` or `x-cron-secret`:

| Endpoint | What it does | Cadence |
| --- | --- | --- |
| `/api/cron/tick` | Contact backlog, then drain the job queue | As often as the scheduler allows |
| `/api/cron/daily` | The above, plus discovery, follow-ups, supply re-match, plan, metrics | Once a day |

`/api/cron?mode=tick|daily` still works and is equivalent. Prefer the path form: a scheduler that drops the query string silently runs `tick` forever and reports success.

**Vercel plan matters.** Hobby refuses any cron expression that fires more than once a day — the deployment fails rather than degrading. `vercel.json` schedules the tick every ten minutes, which requires **Pro or above**.

If the deployment is on Hobby, do one of these:

1. **Upgrade to Pro.** `vercel.json` then works as written.
2. **Use the bundled GitHub Actions workflow.** `.github/workflows/cron-tick.yml` calls `/api/cron/tick` every ten minutes from GitHub's scheduler, which has no plan limit. It needs two repository secrets — `CRON_SECRET` (matching the Vercel environment variable) and `APP_BASE_URL`. Remove the tick entry from `vercel.json` so the deployment builds. GitHub's schedules are best-effort and are disabled after 60 days of repository inactivity, so this is the fallback rather than the better option.
3. **Any external scheduler.** Anything that can issue an authenticated GET on a timer works: Supabase `pg_cron` with `pg_net`, Cloud Scheduler, cron-job.org.

**Checking it is actually running.** Every response carries an `enrichment` block per organisation:

```json
{"org":"...","scheduled":8,"attempted":10,"resolved":4,"released":8,"stillQueued":0,"unscheduled":0}
```

`unscheduled` is the number that matters. Above zero means organisations with live demand still have no resolution state and the board still shows rows reading "Not scheduled"; the next invocation will bring in the next batch. If it stays above zero across several invocations, the tick is not running — check the scheduler before looking at anything else.

### Troubleshooting contact resolution

**Research needed is still full.** Open **Demand → Source health → Contact resolution**. Every record has a stored result; the panel groups them by blocker and names any configuration that is narrowing the search. If *Not scheduled* is above zero, scheduling is not reaching those accounts — that should never happen and is a bug.

**A number turned out to be wrong.** Save the call with *Wrong number*. The value comes off the account, is recorded as rejected so no later attempt proposes it again, and the route leaves Call now until another route is found.

**Nothing overwrites a caller's correction.** Operator-entered values outrank every source, permanently. A provider outage cannot downgrade or erase a verified contact — failed attempts write a failure, never a deletion.
