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
