# Brain

Deal Dispatch is a window onto Brain for the one thing Brain is better at than
this site: deciding whether an opportunity is worth researching, doing the
research, and saying what it found.

This site stays the master of everything it was already master of. Nothing in
`lib/brain/` writes to `Opportunity`, and a test asserts that nothing ever will.

---

## What you see

On an opportunity, a **Brain** panel:

| | |
|---|---|
| **Not evaluated** | Brain holds the record and has not been asked to form a view |
| **On Brain's list** | asked for, waiting its turn |
| **Being researched** | a mission for it is running |
| **Needs a person** | something is waiting on a human decision, and it says which |
| **Finished** | with what was concluded, and the layer it was filed under |
| **Stopped** | with the reason that was actually recorded |

Every sentence on that panel came from Brain and is rendered as Brain wrote it.
The panel also says how fresh it is: *read from Brain just now*, or the age of
the last thing heard. A stored opinion is never rendered as a live one.

The opportunity board carries the same state as a column, read from the local
cache the connector keeps current — a board of three hundred records does not
ask Brain three hundred times.

## What you can do

One button, and only while Brain itself offers it: **Ask Brain to research
this**. It needs `opportunity.write` or `deal.write`.

Pressing it twice is one command. Brain derives the idempotency key from the
record and the command, so a second press, a retried request, a refresh
mid-flight and a restart of either service all resolve to the same operation.

It does not spend anything by itself. It puts the opportunity on Brain's list;
what happens next is Brain's own loop, which checks its archive first and only
starts research inside a standing authority a person granted there.

## Connecting it

Three environment variables, all three or none:

```
BRAIN_URL=https://<your brain>
BRAIN_TOKEN=<a worker credential Brain issued to this site>
BRAIN_PROJECT_ID=prj_…
```

With any of them missing the connector is **off**: the panel does not render,
the board column disappears, both background jobs return immediately, and every
page behaves exactly as it did before. That is deliberate — a half-configured
connector that retried on every tick would be a background loop nobody asked
for.

The credential is issued in Brain, in **Connected sites**: press **Connect Deal
Dispatch**. Brain makes or reuses this site's identity, applies the fixed
project-scoped permissions, revokes anything it held before and shows one
secret — once. There is no worker to name and no scope to choose; the choice
that used to be there had a wrong answer that failed silently.

Pressing it again rotates: the previous secret stops working immediately, so
the site is down until the new one is in place here.

The credential is scoped to one project and two verbs, and is never logged on
this side — the `brnw_` pattern is in `lib/audit.ts`'s redaction list and the
client never interpolates it into anything it throws.

## How it stays current

Two jobs on the ordinary tick, both bounded and both free when nothing changed:

- `brain.push` walks opportunities in `updatedAt` order from a stored cursor and
  sends the ones that moved. A record whose content digest has not changed is
  not sent at all, so re-running the whole backfill makes no request.
- `brain.pull` asks Brain what has changed *there* since a watermark and writes
  the answers into `BrainLink`.

The detail page reads Brain live and writes through to the cache, so the page
you are looking at is never behind.

A one-off backfill, safe to repeat:

```
npm run brain:backfill            # every organisation
npm run brain:backfill -- --dry-run
```

## Rollback

`prisma/migrations/20260910120000_brain_connector` creates `BrainLink` and
`BrainSyncState` and alters no existing table. Unsetting `BRAIN_URL` turns
everything off; dropping those two tables removes it entirely. Neither touches
an opportunity.
