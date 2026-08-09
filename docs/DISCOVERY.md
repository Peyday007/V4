# Lead discovery

How the platform finds real leads, which sources it uses and why, and what is
still unproven.

---

## The distinction that matters

Six of the original seven connectors read a file of sixteen hand-written sample
records committed to this repository. A run against them reported
"37 signals discovered" in exactly the same words as a run against a real
municipal permit portal. That is the failure this subsystem exists to correct.

Every record now carries a `DataOrigin`:

| Origin | Meaning |
|---|---|
| `LIVE_DISCOVERY` | Retrieved from a real external source by a live connector |
| `IMPORTED` | Supplied by the operator via CSV |
| `MANUAL` | Entered by hand |
| `SEED_DEMO` | Created by the demonstration seed. Fabricated. |

`DataSource.isLive` says the same thing about the source. `/leads` filters on
it by default, the nav counts only live leads, and the lead score gives a
fixture-backed record a source-reliability value of 0.1 so it cannot outrank
anything real. Fixture data can no longer be presented as discovery.

---

## Business paths are configuration

Distribution, brokerage and subcontracting are rows in `BusinessPath`, not
branches in code. A path defines its lead roles, segments, source keys,
qualification rules, scoring weights, required fields, recommended actions,
revenue model and expected cycle length.

The three original paths carry a `legacyCategory` mapping them onto the
`SignalCategory` enum, which is what lets the existing classifier, scorer and
matcher keep working unchanged. **A path added later carries no legacy category
and is driven entirely by its JSON rules.** Nothing is ever added to the enum
again — that is the seam that keeps a fourth path from being a rewrite.

Defaults live in `lib/paths.ts` and are installed by `ensureDefaultPaths()`,
which is idempotent and runs from the seed and from `npm run discovery:setup`.

Ranking between paths is deliberate rather than alphabetical. Distribution runs
first (priority 10) because a consumables order can ship and invoice in days;
subcontracting last (30) because vendor onboarding takes weeks.

---

## Markets are configuration

`Market` answers the question discovery actually needs: *where are we looking*.
`Territory` answers a different one — where a company can serve — and using it
for both is why discovery previously had nowhere to point.

A market carries a centre point and radius for place APIs, plus city, county
and postcode lists for sources that key on names. `sourceConfig` holds the
per-source settings: which Socrata portal and datasets, which NAICS codes,
which place queries.

**Dallas–Fort Worth is a seeded starter row, not a constant.** Adding Houston
or Chicago is a `Market` row with its own portal configuration. Sources bound
to one market run only there; unbound sources run once per enabled market.

---

## Source selection

Sources were compared on data relevance, coverage, freshness, cost, terms risk
and implementation effort. What shipped, and what did not:

### Shipped

| Source | Path | Cost | Terms | Why |
|---|---|---|---|---|
| **Socrata / SODA** municipal open data | Brokerage, distribution | Free, no key | Public records, documented API intended for programmatic access, no retention limit | Highest-signal free buyer source that exists. A commercial tenant finish-out permit is a named, dated building that will need construction cleaning on completion and recurring janitorial after. 200+ US portals expose the same query language. |
| **Google Places (New)** Text Search | All three | Paid per request | Licensed API. **Place ID storable indefinitely; other place content is not.** Coordinates cacheable 30 days | The only source that populates both sides of a market: providers who can fulfil, and the clinics, gyms, offices and property managers that buy. Default queries cover all three paths and are replaceable per market. |
| **SAM.gov** opportunities | Subcontracting | Free | Official federal public API | Ships **disabled**. Long award and payment cycles make it a poor primary path; it earns inclusion because primes winning facility-services awards need local fulfilment partners immediately. |

### Rejected, with reasons

| Source | Why not |
|---|---|
| **Adzuna** jobs API | Commercial use is a 14-day trial only; ongoing use needs a negotiated licence. Cannot ship as a free source. |
| **Shovels** permits API | Genuinely good nationwide permit coverage with contractor grouping, but starts around $599/month. Not justified before the free Socrata path is exhausted. |
| **Indeed / LinkedIn / Yelp** scraping | Terms prohibit it. Not implemented at any price. |
| **Foursquare OS Places** | Apache 2.0, 100M+ POIs, storable without restriction — genuinely attractive and the right answer to the Places retention limit. Deferred only because it ships as bulk Parquet on S3 and needs a loader, which does not fit a serverless request. Best candidate for the next phase. |

---

## What a lead carries

Every `DiscoverySignal` produced by a live connector carries: business path,
lead role, segment, market, required service, source name, clickable source
URL, observed date, last-seen date, contact hint, confidence, strength,
classification evidence, a plain-language relevance explanation, and a
recommended next action.

`/leads` ranks with `lib/discovery/leadScore.ts`, which returns a component
breakdown rather than a bare number:

| Component | What it measures |
|---|---|
| Freshness | Age **from source publication**, not from ingestion. A permit filed in March discovered today is three months old to the buyer. |
| Contactability | Phone beats email beats nothing. A perfect lead nobody can reach costs research time first. |
| Segment fit | Whether the segment is one the path works. |
| Source reliability | Live source with a verifiable link scores 1.0; a fixture scores 0.1. |
| Signal strength | Rule strength and confidence combined. |

Weights come from the path, so distribution and subcontracting rank
differently. Every component's reason string is rendered on the card.

---

## Compliance

Discovered contact details are **not** consent to contact. Contacts created by
discovery get `consentToSms: false` and `hasMobile: false`; a directory number
is a business line, and the SMS gate is stricter than the calling gate. Calling
hours, suppression, frequency caps and recording-consent rules apply at the
point a call or message is placed, unchanged by where the contact came from.

Every live source declares an `accessBasis` and a `termsUrl`, both shown in the
interface. No connector parses HTML, drives a browser, or touches anything
behind authentication.

---

## Running it

```bash
npm run discovery:setup    # install paths, starter market, live sources (idempotent)
npm run discovery:probe    # check each live source actually responds
npm run discovery:probe socrata   # one source
```

Scheduled runs go through the existing cron (`/api/cron?mode=daily`), which
enqueues `discovery.run_all`. That now calls `runDiscoveryAcrossMarkets`, so
every enabled source runs once per enabled market.

Sources whose credential is missing install **disabled** rather than failing on
every scheduled run and filling the health view with noise.

---

## Verification status

Being precise about this, because "the tests pass" is not the same claim as
"it finds real leads".

| Capability | Status |
|---|---|
| Business paths, markets, provenance schema | **Working and verified** — migrations applied, seeded and queried against Postgres |
| Socrata connector parsing, filtering, query building, failure handling | **Working and verified** against recorded responses; SoQL injection guard tested |
| Google Places parsing, role assignment, retention rule, credential handling | **Working and verified** against recorded responses |
| SAM.gov parsing, state filtering, NAICS fallback | **Working and verified** against recorded responses |
| Full pipeline: fetch → evidence → company → contact → signal → path → score → dedupe | **Working and verified** against Postgres with a stubbed transport. All three paths produced leads; re-running produced 0 new and 20 duplicate signals; residential permits filtered out |
| `/leads` page, live/imported/demo separation, filters | **Working and verified** — renders 200, live view shows only live records |
| **Live HTTP against the real Socrata, Places and SAM.gov endpoints** | **Implemented but unverified.** The build sandbox blocks outbound connections to these hosts, so no request has ever reached them. Contract tests prove the connectors handle the documented response shape; they cannot prove the endpoints still return it. |
| Dallas Socrata dataset ID `e7gq-4sah` and its column names | **Unverified.** Taken from the portal's published catalogue, not confirmed against a live response. A retired dataset returns 404, not wrong data — the probe will say so immediately. |
| Buyer↔provider matching on live data | **Partially implemented.** The matching engine is unchanged and works; it has only been exercised against seeded and stub data, not live discovered records. |
| Notifications for strong new leads | **Not implemented.** |
| Foursquare OS Places loader | **Not implemented.** |

**Run `npm run discovery:probe` before trusting any of this in production.** It
is the only thing that closes the gap between "parses correctly" and "works".
