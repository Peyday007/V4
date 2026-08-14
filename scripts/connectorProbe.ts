/**
 * What the sources actually answer.
 *
 * Every dataset identifier, column name and filter in the demand connectors was
 * written from documentation and has never been checked against a live portal,
 * because the machines this project is developed on sit behind an egress
 * allowlist that does not include a single one of them. The connectors say so
 * in their own comments. That is an honest admission and it is not a substitute
 * for knowing.
 *
 * This probe closes that gap. It runs from a job with open egress, issues the
 * exact request each connector would issue — built by the connector's own URL
 * builder, so what is tested is the shipped configuration rather than a copy of
 * it that can drift — and reports:
 *
 *   the HTTP status, which separates a moved dataset from a blocked client
 *   the number of rows, which separates an empty window from an empty portal
 *   the field names actually returned
 *   which configured columns are present, missing, or always null
 *   how many rows survive each filter, using the connector's own mapper
 *
 * It writes nothing, to the database or anywhere else. It reads public records
 * from documented APIs within their published terms, at their documented rate,
 * and it is the only way this project can honestly claim to know whether its
 * demand sources work.
 *
 *   npx tsx scripts/connectorProbe.ts            # everything
 *   npx tsx scripts/connectorProbe.ts --json     # machine-readable as well
 */

import {
  DEFAULT_JURISDICTIONS,
  buildQueryUrl,
  toDemandEvent,
  type JurisdictionDataset,
} from '@/lib/demand/connectors/municipalOpenData';
import {
  DEFAULT_SOLICITATION_DATASETS,
  buildSolicitationUrl,
  toSolicitationEvent,
  type SolicitationDataset,
} from '@/lib/demand/connectors/municipalSolicitations';
import { toAwardEvent } from '@/lib/demand/connectors/contractAwards';
import { DropTally } from '@/lib/demand/connector';

const LOOKBACK_DAYS = 45;
const SAMPLE = 200;
const USASPENDING_ENDPOINT = 'https://api.usaspending.gov/api/v2/search/spending_by_award/';
const CLEANING_NAICS = ['561720', '561790', '561210'];
const USER_AGENT =
  process.env.DISCOVERY_USER_AGENT?.trim()
  || 'DealDispatch/1.0 (automated lead discovery for a facility-services operator)';

type ColumnVerdict = 'present' | 'missing' | 'always null';

type Probe = {
  connector: string;
  scope: string;
  url: string;
  method: string;
  status: number | null;
  transportError: string | null;
  rows: number | null;
  /** Field names the source actually returned, unioned across rows. */
  fields: string[];
  /** Every column the shipped configuration names, and whether it is really there. */
  columns: Array<{ role: string; column: string; verdict: ColumnVerdict }>;
  accepted: number | null;
  drops: Array<{ reason: string; count: number; example: string | null }>;
  /**
   * When the configured query failed, the columns the dataset really has —
   * fetched unfiltered, because a 400 that says "no such column: issued_date"
   * tells you what is wrong and not what is right.
   */
  actualColumns?: string[];
  /**
   * When the dataset is gone, what the portal's own catalogue offers instead.
   * Suggestions to check, never something to adopt unread: a plausible name is
   * not evidence that a dataset holds what this connector needs.
   */
  candidates?: Array<{ id: string; name: string; updatedAt: string | null }>;
  /** What this means and what to do, in one sentence. */
  verdict: string;
};

const probes: Probe[] = [];

async function getJson(url: string): Promise<{ status: number; body: unknown; text: string }> {
  // Two attempts. The first run of this probe reported Chicago as unreachable
  // on a single `fetch failed`, which is a transient answer being read as a
  // permanent one — the opposite of the mistake this whole exercise exists to
  // correct.
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json',
          'user-agent': USER_AGENT,
          ...(process.env.SOCRATA_APP_TOKEN ? { 'X-App-Token': process.env.SOCRATA_APP_TOKEN } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      });
      const text = await response.text();
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      return { status: response.status, body, text };
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastError;
}

/**
 * Everything a broken scope can be asked after the fact.
 *
 * Run for any scope that did not come back as a row array, because those are
 * precisely the ones whose diagnosis is incomplete without a second question.
 */
async function followUp(domain: string, datasetId: string, label: string) {
  const [columns, candidates] = await Promise.all([
    actualColumns(domain, datasetId),
    catalogueCandidates(domain, label),
  ]);
  return { actualColumns: columns, candidates };
}

/**
 * The columns a dataset really has, asked without any predicate.
 *
 * The reason the first run of this probe could not finish the diagnosis: a 400
 * naming a column that does not exist leaves you knowing one wrong name and no
 * right ones. One unfiltered row answers it.
 */
async function actualColumns(domain: string, datasetId: string): Promise<string[]> {
  try {
    const { status, body } = await getJson(`https://${domain}/resource/${datasetId}.json?$limit=1`);
    if (status !== 200 || !Array.isArray(body) || body.length === 0) return [];
    return Object.keys(body[0] as Record<string, unknown>).sort();
  } catch {
    return [];
  }
}

/**
 * What the portal publishes now, from Socrata's own catalogue.
 *
 * A dataset identifier changes when a city republishes, and hunting for the
 * new one by hand is how a source stays broken for months. The discovery API
 * is public and documented; this asks it and prints what it says. Nothing is
 * adopted automatically — a dataset whose title matches is not proof that its
 * columns do, and picking one unread is exactly the kind of guess that put
 * fixture data in the portfolio.
 */
async function catalogueCandidates(domain: string, query: string): Promise<Probe['candidates']> {
  try {
    const url =
      'https://api.us.socrata.com/api/catalog/v1'
      + `?domains=${encodeURIComponent(domain)}&q=${encodeURIComponent(query)}&only=dataset&limit=8`;
    const { status, body } = await getJson(url);
    if (status !== 200) return [];
    const results = (body as { results?: Array<Record<string, unknown>> } | null)?.results ?? [];
    return results.map((r) => {
      const resource = (r.resource ?? {}) as Record<string, unknown>;
      return {
        id: String(resource.id ?? ''),
        name: String(resource.name ?? '').slice(0, 70),
        updatedAt: typeof resource.updatedAt === 'string' ? resource.updatedAt.slice(0, 10) : null,
      };
    });
  } catch {
    return [];
  }
}

/** Field names across the sample, and which of them are never populated. */
function fieldReport(rows: Array<Record<string, unknown>>): { fields: string[]; nonNull: Set<string> } {
  const fields = new Set<string>();
  const nonNull = new Set<string>();
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      fields.add(key);
      if (value !== null && value !== undefined && String(value).trim() !== '') nonNull.add(key);
    }
  }
  return { fields: [...fields].sort(), nonNull };
}

function judgeColumns(
  configured: Array<[string, string | undefined]>,
  fields: Set<string>,
  nonNull: Set<string>,
): Probe['columns'] {
  const out: Probe['columns'] = [];
  for (const [role, column] of configured) {
    if (!column) continue;
    out.push({
      role,
      column,
      // "Present but always null" is its own answer: the column survived a
      // republish in name only, and a mapper reading it drops every row while
      // a schema check would say everything is fine.
      verdict: !fields.has(column) ? 'missing' : nonNull.has(column) ? 'present' : 'always null',
    });
  }
  return out;
}

function verdictFor(p: Omit<Probe, 'verdict'>): string {
  if (p.transportError) {
    return `Could not reach the host at all: ${p.transportError}. `
      + 'That is a network or DNS answer, not a query answer.';
  }
  if (p.status === 403 || p.status === 401) {
    return `The host answered ${p.status}. The request never reached the dataset, so nothing here says `
      + 'whether the query or the columns are right. Check whether this client is being filtered.';
  }
  if (p.status === 404) {
    return 'The dataset is not at this identifier any more. It has been republished; find its new '
      + 'four-by-four and update the configuration.';
  }
  if (p.status === 400) {
    return 'The dataset exists but rejected the query. A column named in the predicate or the sort no '
      + 'longer exists — the response body names which.';
  }
  if (p.status === 500 && p.drops.some((d) => /Web Page Blocked|attack_ID/i.test(d.example ?? ''))) {
    return 'A filtering appliance answered instead of the API, and told this client so. The request never '
      + 'reached USAspending, so nothing here says whether the query is right. This is an egress or '
      + 'reputation problem to solve where the requests come from, not in the connector.';
  }
  if (p.status !== 200) return `Unexpected status ${p.status}.`;

  // A 200 that is not an array of rows is the case that read as healthy in the
  // first run of this probe and was not: Baltimore's open-data host answers 200
  // with an ArcGIS Hub page, because the city moved off Socrata and left the
  // domain up. Every other check downstream of `rows` is meaningless here, so
  // it has to be caught before them rather than falling through.
  if (p.rows === null) {
    const body = p.drops.find((d) => d.reason === 'response body')?.example ?? '';
    const title = /<title[^>]*>([^<]{1,80})/i.exec(body)?.[1]?.trim();
    return 'The host answered 200 with something that is not a row array'
      + (title ? ` — an HTML page titled "${title}"` : '')
      + '. The domain is up but is no longer serving this dataset through the SODA API; the city has '
      + 'usually moved to a different platform.';
  }

  const missing = p.columns.filter((c) => c.verdict === 'missing');
  const empty = p.columns.filter((c) => c.verdict === 'always null');

  if (p.rows === 0) {
    return 'The query succeeded and matched nothing. Either the window and predicate genuinely exclude '
      + 'everything the portal currently holds, or the predicate references a value the source has '
      + 'stopped using.';
  }
  if (missing.length > 0) {
    return `${p.rows} row(s) came back, but the configuration names ${missing.length} column(s) the source `
      + `no longer returns: ${missing.map((c) => `${c.column} (${c.role})`).join(', ')}. `
      + 'Every row that depends on them is being discarded.';
  }
  if (p.accepted === 0) {
    return `${p.rows} row(s) came back and every configured column is present, yet none became an event. `
      + 'The loss is in the filters, and the drop reasons below say which.';
  }
  if (empty.length > 0) {
    return `${p.accepted} of ${p.rows} row(s) map to events. Present but never populated in this sample: `
      + `${empty.map((c) => c.column).join(', ')}.`;
  }
  return `${p.accepted} of ${p.rows} row(s) map to events. This source works.`;
}

function record(p: Omit<Probe, 'verdict'>) {
  probes.push({ ...p, verdict: verdictFor(p) });
}

// ---------------------------------------------------------------------------
// Socrata: licences, permits, solicitations
// ---------------------------------------------------------------------------

async function probeJurisdiction(dataset: JurisdictionDataset, since: Date) {
  const url = buildQueryUrl(dataset, since, SAMPLE);
  const base = {
    connector: 'municipal_open_data',
    scope: `${dataset.label} (${dataset.domain}/${dataset.datasetId})`,
    url,
    method: 'GET',
  };

  let status: number | null = null;
  let body: unknown = null;
  let text = '';
  try {
    ({ status, body, text } = await getJson(url));
  } catch (error) {
    record({
      ...base, status: null, transportError: String(error).slice(0, 200), rows: null, fields: [],
      columns: [], accepted: null, drops: [],
      ...(await followUp(dataset.domain, dataset.datasetId, dataset.label)),
    });
    return;
  }

  if (status !== 200 || !Array.isArray(body)) {
    record({
      ...base,
      status,
      transportError: null,
      rows: null,
      fields: [],
      columns: [],
      accepted: null,
      // The portal's own error text is the fastest route to the fix, so it is
      // carried through rather than replaced with a summary of it.
      drops: [{ reason: 'response body', count: 1, example: text.slice(0, 300) }],
      // And when the configured query fails, the columns it should have named,
      // plus what the portal publishes under this name now.
      ...(await followUp(dataset.domain, dataset.datasetId, dataset.label)),
    });
    return;
  }

  const rows = body as Array<Record<string, unknown>>;
  const { fields, nonNull } = fieldReport(rows);
  const tally = new DropTally();
  let accepted = 0;
  for (const row of rows) if (toDemandEvent(row, dataset, tally)) accepted += 1;

  // A successful query returning nothing is the case that reads as "a quiet
  // week" and most needs a second question: does the dataset hold anything at
  // all, and does it still have the columns this expects?
  const followUpOnEmpty =
    rows.length === 0 ? await followUp(dataset.domain, dataset.datasetId, dataset.label) : {};

  record({
    ...base,
    status,
    transportError: null,
    rows: rows.length,
    fields,
    ...followUpOnEmpty,
    columns: judgeColumns(
      [
        ['date', dataset.dateColumn],
        ['name', dataset.columns.name],
        ['doing business as', dataset.columns.doingBusinessAs],
        ['address', dataset.columns.address],
        ['city', dataset.columns.city],
        ['zip', dataset.columns.zip],
        ['description', dataset.columns.description],
        ['natural key', dataset.columns.naturalKey],
        ['status', dataset.columns.status],
        ['scale', dataset.columns.scale],
        ['applicant', dataset.columns.applicant],
      ],
      new Set(fields),
      nonNull,
    ),
    accepted,
    drops: tally.entries(),
  });
}

async function probeSolicitation(dataset: SolicitationDataset, since: Date) {
  const url = buildSolicitationUrl(dataset, since, SAMPLE);
  const base = {
    connector: 'municipal_solicitations',
    scope: `${dataset.label} (${dataset.domain}/${dataset.datasetId})`,
    url,
    method: 'GET',
  };

  let status: number | null = null;
  let body: unknown = null;
  let text = '';
  try {
    ({ status, body, text } = await getJson(url));
  } catch (error) {
    record({
      ...base, status: null, transportError: String(error).slice(0, 200), rows: null, fields: [],
      columns: [], accepted: null, drops: [],
      ...(await followUp(dataset.domain, dataset.datasetId, dataset.label)),
    });
    return;
  }

  if (status !== 200 || !Array.isArray(body)) {
    record({
      ...base, status, transportError: null, rows: null, fields: [], columns: [], accepted: null,
      drops: [{ reason: 'response body', count: 1, example: text.slice(0, 300) }],
      ...(await followUp(dataset.domain, dataset.datasetId, dataset.label)),
    });
    return;
  }

  const rows = body as Array<Record<string, unknown>>;
  const { fields, nonNull } = fieldReport(rows);
  const tally = new DropTally();
  let accepted = 0;
  for (const row of rows) if (toSolicitationEvent(row, dataset, tally)) accepted += 1;

  const followUpOnEmpty =
    rows.length === 0 ? await followUp(dataset.domain, dataset.datasetId, dataset.label) : {};

  record({
    ...base,
    status,
    transportError: null,
    rows: rows.length,
    fields,
    ...followUpOnEmpty,
    columns: judgeColumns(
      [
        ['date', dataset.dateColumn],
        ['title', dataset.columns.title],
        ['description', dataset.columns.description],
        ['agency', dataset.columns.agency],
        ['awardee', dataset.columns.awardee],
        ['close date', dataset.columns.closeDate],
        ['natural key', dataset.columns.naturalKey],
        ['notice type', dataset.columns.noticeType],
        ['status', dataset.columns.status],
        ['estimated value', dataset.columns.estimatedValue],
      ],
      new Set(fields),
      nonNull,
    ),
    accepted,
    drops: tally.entries(),
  });
}

// ---------------------------------------------------------------------------
// USAspending
// ---------------------------------------------------------------------------

/**
 * The award search, in both filter dialects.
 *
 * `naics_codes` has been a bare list of strings and an object with `require`
 * and `exclude` arrays at different points in this API's life. The connector
 * sends the list. Rather than guess which one is current, the probe sends both
 * and reports which the server accepts — that is a fact about the world, and it
 * is the difference between fixing the connector and changing it at random.
 */
async function probeAwards(since: Date) {
  const fields = [
    'Award ID', 'Recipient Name', 'Start Date', 'End Date', 'Award Amount', 'Awarding Agency',
    'Place of Performance State Code', 'Place of Performance City Code', 'Place of Performance Zip5',
    'Recipient Location State Code', 'Description', 'recipient_id', 'generated_internal_id',
  ];
  const timePeriod = [
    { start_date: since.toISOString().slice(0, 10), end_date: new Date().toISOString().slice(0, 10) },
  ];

  const dialects: Array<{ label: string; naics: unknown }> = [
    { label: 'naics_codes as a list (what the connector sends)', naics: CLEANING_NAICS },
    { label: 'naics_codes as require/exclude', naics: { require: CLEANING_NAICS, exclude: [] } },
  ];

  for (const dialect of dialects) {
    const payload = {
      filters: { award_type_codes: ['A', 'B', 'C', 'D'], naics_codes: dialect.naics, time_period: timePeriod },
      fields,
      page: 1,
      limit: 100,
      sort: 'Start Date',
      order: 'desc',
    };
    const base = {
      connector: 'contract_awards',
      scope: `USAspending — ${dialect.label}`,
      url: USASPENDING_ENDPOINT,
      method: 'POST',
    };

    let status: number;
    let text: string;
    let body: unknown;
    try {
      const response = await fetch(USASPENDING_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': USER_AGENT },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(45_000),
      });
      status = response.status;
      text = await response.text();
      try { body = JSON.parse(text); } catch { body = null; }
    } catch (error) {
      record({ ...base, status: null, transportError: String(error).slice(0, 200), rows: null, fields: [], columns: [], accepted: null, drops: [] });
      continue;
    }

    const results = (body as { results?: Array<Record<string, unknown>> } | null)?.results;
    if (status !== 200 || !Array.isArray(results)) {
      record({
        ...base, status, transportError: null, rows: null, fields: [], columns: [], accepted: null,
        drops: [{ reason: 'response body', count: 1, example: text.slice(0, 400) }],
      });
      continue;
    }

    const report = fieldReport(results);
    const tally = new DropTally();
    let accepted = 0;
    for (const row of results) if (toAwardEvent(row, tally)) accepted += 1;

    record({
      ...base,
      status,
      transportError: null,
      rows: results.length,
      fields: report.fields,
      // Every requested display name is a column the mapper depends on, so all
      // of them are judged rather than a chosen few.
      columns: judgeColumns(fields.map((f) => [f, f]), new Set(report.fields), report.nonNull),
      accepted,
      drops: tally.entries(),
    });
  }
}

// ---------------------------------------------------------------------------

function print() {
  const line = '='.repeat(76);
  console.log(line);
  console.log('DEMAND CONNECTOR PROBE — what the sources actually answer');
  console.log(line);
  console.log(`\nRun at ${new Date().toISOString()} with a ${LOOKBACK_DAYS}-day window.\n`);

  for (const p of probes) {
    console.log('-'.repeat(76));
    console.log(`${p.connector} — ${p.scope}`);
    console.log(`  ${p.method} ${p.url.slice(0, 200)}`);
    console.log(
      `  status ${p.status ?? 'no response'}`
      + (p.rows === null ? '' : `   rows ${p.rows}`)
      + (p.accepted === null ? '' : `   became events ${p.accepted}`),
    );
    if (p.columns.length > 0) {
      const bad = p.columns.filter((c) => c.verdict !== 'present');
      console.log(
        `  configured columns: ${p.columns.length - bad.length}/${p.columns.length} present`
        + (bad.length > 0 ? ` — ${bad.map((c) => `${c.column}: ${c.verdict}`).join(', ')}` : ''),
      );
    }
    if (p.fields.length > 0) console.log(`  fields returned: ${p.fields.join(', ').slice(0, 400)}`);
    for (const d of p.drops.slice(0, 6)) {
      console.log(`  dropped ${String(d.count).padStart(4)} × ${d.reason}${d.example ? ` — e.g. ${d.example}` : ''}`);
    }
    if (p.actualColumns && p.actualColumns.length > 0) {
      console.log(`  the dataset's real columns: ${p.actualColumns.join(', ').slice(0, 500)}`);
    }
    if (p.candidates && p.candidates.length > 0) {
      console.log('  the portal publishes these under a similar name — check before adopting any:');
      for (const c of p.candidates.slice(0, 6)) {
        console.log(`     ${c.id}  ${c.updatedAt ?? '          '}  ${c.name}`);
      }
    }
    console.log(`  → ${p.verdict}`);
  }

  console.log(`\n${line}`);
  console.log('SUMMARY');
  console.log(line);
  const working = probes.filter((p) => p.status === 200 && (p.accepted ?? 0) > 0);
  const reachableButEmpty = probes.filter((p) => p.status === 200 && (p.accepted ?? 0) === 0);
  const broken = probes.filter((p) => p.status !== 200);
  console.log(`  producing events        ${working.length}`);
  console.log(`  reachable, no events    ${reachableButEmpty.length}`);
  console.log(`  did not answer 200      ${broken.length}`);
  for (const p of broken) console.log(`     ${p.scope}: ${p.status ?? p.transportError}`);
  console.log(
    '\n  This probe writes nothing. It is evidence about the sources, not demand:\n'
    + '  no event it observed has been ingested, and production stays exactly as\n'
    + '  it was.',
  );
}

async function main() {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);

  for (const dataset of DEFAULT_JURISDICTIONS) await probeJurisdiction(dataset, since);
  for (const dataset of DEFAULT_SOLICITATION_DATASETS) await probeSolicitation(dataset, since);
  await probeAwards(since);

  print();
  if (process.argv.includes('--json')) {
    console.log('\n<<<PROBE_JSON>>>');
    console.log(JSON.stringify(probes, null, 2));
  }

  // Deliberately exits 0 even when sources are broken. Its job is to report the
  // state of the world; a red job would tempt somebody to make it green by
  // deleting the source that told the truth.
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
