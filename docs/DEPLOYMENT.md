# Deploying to Vercel

Roughly fifteen minutes end to end. You need a Postgres database Vercel can reach — Neon and Supabase both have free tiers and both work.

---

## Before you start: two things about Vercel's free plan

**Project count is not the constraint.** Hobby has no per-project limit, so this can sit alongside your existing project. The limits are on usage — bandwidth, function execution and build minutes.

**Cron frequency is the constraint.** Hobby allows a small number of cron jobs invoked once per day. That is fine here, and the reason is worth understanding: the app drains its own job queue inline whenever someone does something — running discovery, ending a call, selecting a match. So interactive work never waits on a scheduler. The cron only handles the unattended daily sweep (discovery across all sources, overdue follow-ups, rescoring, the operating plan, caller metrics). If you later want the queue drained every few minutes, see [More frequent processing](#more-frequent-processing).

**Hobby is licensed for non-commercial use.** This is an internal business platform. If you run your actual operation on it, Vercel's terms require Pro. Not my call to make — just so it isn't a surprise later.

---

## 1. Create the database

**Neon** (recommended — its pooled endpoint is exactly what serverless needs):

1. Create a project at neon.tech.
2. From the dashboard, copy **two** connection strings:
   - The **pooled** one (host contains `-pooler`) → this becomes `DATABASE_URL`
   - The **direct** one (no `-pooler`) → this becomes `DIRECT_URL`

**Supabase:** use the connection string on port `6543` for `DATABASE_URL` and port `5432` for `DIRECT_URL`.

Why both: every serverless invocation opens its own connection, so runtime queries must go through a pooler or you exhaust the connection limit under mild load. Poolers can't run DDL, so migrations need the direct connection. Prisma is configured to use each in the right place.

## 2. Import the project

In Vercel: **Add New → Project → Import** your repository, and set the production branch to `claude/ai-deal-dispatch-system-xmr2cz` (or merge it to `main` first).

Leave the build settings alone. `vercel.json` already sets the build command to run migrations before building.

## 3. Set environment variables

**Settings → Environment Variables.** Generate the secrets first:

```bash
openssl rand -base64 48   # SESSION_SECRET
openssl rand -hex 32      # CRON_SECRET
```

| Variable | Value |
|---|---|
| `DATABASE_URL` | Pooled connection string |
| `DIRECT_URL` | Direct connection string |
| `SESSION_SECRET` | 48-byte random string (min 32 chars) |
| `CRON_SECRET` | 32-byte random hex |
| `APP_URL` | `https://your-project.vercel.app` |

That is everything required. Every external provider defaults to its mock, so the full loop works without another key. Add `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` later if you want the LLM layer — see `docs/INTEGRATIONS.md`.

Set all five for **Production**, and for **Preview** too if you want preview deployments to work.

## 4. Deploy

Push, or hit **Deploy**. The build runs `prisma generate && prisma migrate deploy && next build`, so the schema is created on first deploy.

Expect a working site with an empty database — a login page you cannot get past yet, because no users exist.

## 5. Seed it

**Easiest — from your browser.** Visit this once, with your `CRON_SECRET`:

```
https://your-project.vercel.app/api/admin/seed?secret=YOUR_CRON_SECRET
```

**You can sign in as soon as that returns.** The response contains a link to
the next step; each one is optional and each returns the link to the one after
it.

| Step | Creates | Local timing |
|---|---|---|
| `core` (default) | Organisation, roles, users, taxonomy, sources, lanes, supply-side companies | ~0.6s |
| `&step=demo` | Discovery, signals, opportunities, matching, scoring | ~1.9s |
| `&step=calls` | Recorded conversations, extracted facts, deals, escalations, approvals | ~3.1s |

It is split because the whole seed runs past a serverless function's 60-second
limit against a remote database — a round trip that costs microseconds locally
costs milliseconds to Neon, and the seed makes thousands of them. Each phase
now has well over ten times the headroom it needs.

This route uses `CRON_SECRET` rather than a login, because a fresh deployment
has no account to authorise with yet. Phase one refuses to run against an
organisation already holding real work unless you add `&confirm=reset`.

**Alternative — from your machine**, pointed at the production database:

```bash
git clone <your repo> && cd V4
git checkout claude/ai-deal-dispatch-system-xmr2cz
npm install

DATABASE_URL="<your pooled url>" \
DIRECT_URL="<your direct url>" \
npm run db:seed
```

This creates the organisation, roles, users, taxonomy, data sources and deal lanes, then runs the real engines: discovery across six sources, signal promotion, scoring, matching, seven demonstration conversations through the transcript pipeline, and the first operating plan.

Then sign in at `https://your-project.vercel.app/login` as `owner@dealdispatch.test` / `demo-password-123`.

> **The seed is destructive.** It deletes and rebuilds its organisation, so never run it against a database holding real work. In production it refuses outright unless you pass `SEED_CONFIRM_RESET=yes` (CLI) or `&confirm=reset` (browser), which exists so you have to mean it.

**Windows note:** the `VAR="value" npm run ...` prefix is bash syntax and does
nothing in PowerShell. Use the browser method above, or set the variables first:
> ```powershell
> $env:DATABASE_URL="<pooled url>"; $env:DIRECT_URL="<direct url>"; npm run db:seed
> ```

## 6. Change the demo passwords

Every seeded account shares a published password. Before the URL reaches anyone else, either delete the accounts you don't need or change their passwords:

```bash
DATABASE_URL="<your pooled url>" DIRECT_URL="<your direct url>" npx tsx -e "
import { PrismaClient } from '@prisma/client';
import { hashPassword } from './lib/auth/password';
const prisma = new PrismaClient();
const passwordHash = await hashPassword('<your new password>');
await prisma.user.update({ where: { id: (await prisma.user.findFirstOrThrow({ where: { email: 'owner@dealdispatch.test' } })).id }, data: { passwordHash } });
await prisma.user.updateMany({ where: { email: { not: 'owner@dealdispatch.test' } }, data: { isActive: false } });
console.log('done');
await prisma.\$disconnect();
"
```

---

## The scheduler

`vercel.json` registers one cron:

```json
{ "path": "/api/cron?mode=daily", "schedule": "0 11 * * *" }
```

11:00 UTC daily. Vercel sends `Authorization: Bearer $CRON_SECRET`, which `/api/cron` verifies in constant time — it is the one route that doesn't use a session, and it can only run the operating loop. It cannot approve, send or decide anything a human must.

Verify it by hand:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://your-project.vercel.app/api/cron?mode=daily"
```

You should get back the queued and processed job counts. Running it twice in one day queues nothing the second time — the jobs are keyed by date.

Two modes:

| Mode | Does |
|---|---|
| `?mode=tick` | Drains the queue only. Cheap; safe to call often. |
| `?mode=daily` | Queues discovery, follow-ups, planning and metrics, then drains. |

### More frequent processing

If you want the queue drained every few minutes:

- **Upgrade to Pro** and add a second cron on `?mode=tick` at your preferred interval, or
- **Use an external scheduler** (cron-job.org, GitHub Actions, EasyCron) hitting `/api/cron?mode=tick` with the `x-cron-secret` header, or
- **Run a worker elsewhere** — `npm run worker` on any host with a persistent process, pointed at the same database.

None of this is needed to use the app. Inline draining covers interactive work.

---

## Notes on running serverless

**Function timeouts.** `/api/cron` is capped at 60 seconds (`maxDuration`) and budgets its own draining to finish inside that. A large backlog is processed across several invocations rather than in one.

**No background worker.** `npm run worker` needs a persistent process, which Vercel functions are not. The inline draining and the cron replace it.

**Connection limits.** This is what `DATABASE_URL` vs `DIRECT_URL` is for. If you see `too many connections`, confirm `DATABASE_URL` really is the pooled endpoint.

**Migrations run at build time.** A failed migration fails the build, so a broken schema change never reaches production. It also means two simultaneous deploys could race — deploy one at a time.

---

## Alternative: a host with a persistent process

Railway, Render and Fly run the app as a normal Node process, which means the background worker works properly and there are no function timeouts.

```
Web:    npm run build && npm run start
Worker: npm run worker
```

Same environment variables. When you have your own Postgres rather than a pooler, set `DIRECT_URL` to the same value as `DATABASE_URL`.

---

## Troubleshooting

**Build fails on `prisma migrate deploy`.** `DIRECT_URL` is missing or points at the pooled endpoint. Migrations need the direct connection.

**`Invalid environment configuration — SESSION_SECRET: String must contain at least 32 character(s)`.** Exactly what it says; regenerate with `openssl rand -base64 48`.

**Login page loads but no account works.** The seed hasn't run. See step 5.

**`/api/admin/seed` returns 409.** The database already holds real work and the guard is refusing to wipe it. Add `&confirm=reset` if replacing it is what you want. An organisation with no opportunities and no calls is treated as leftovers from a failed run and replaced without asking.

**`/api/admin/seed` returns 504 GATEWAY_TIMEOUT.** A phase exceeded the function limit. Re-run that phase; it is safe to repeat. If it keeps timing out, your database is far from your Vercel region — moving them to the same region removes most of the latency.

**`/api/cron` returns 503.** `CRON_SECRET` isn't set in Vercel. Scheduled runs are disabled rather than left open.

**`/api/cron` returns 401.** The secret presented doesn't match. Check for a trailing newline in the Vercel value.

**Dashboard is empty after seeding.** Confirm the seed ran against the same database Vercel is using — it is easy to seed local by accident.
