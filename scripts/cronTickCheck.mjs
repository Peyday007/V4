/**
 * The cron-tick workflow, run against a real HTTPS server.
 *
 * The script under test is not a copy: it is extracted from
 * `.github/workflows/cron-tick.yml` by parsing the YAML and pulling out the
 * step's `run:` block, so an edit to the workflow that breaks the shell or the
 * embedded Python fails here rather than on the sixth minute of a production
 * run.
 *
 * The scenarios are the ones that actually happen to this workflow:
 *
 *   A redirect. Vercel answers the wrong path or scheme with a 307/308 and an
 *   HTML "Redirecting..." body. Before the fix, curl returned that page with a
 *   3xx status, `--fail-with-body` did not treat it as an error, and the run
 *   went green having fired no tick at all.
 *
 *   A cross-host redirect. curl drops the Authorization header rather than
 *   handing a bearer token to whatever answered, which produces a 401. That is
 *   the correct outcome and the run must fail loudly, not silently.
 *
 *   Malformed JSON, HTML, an empty body. All arrive with a 200 and all mean no
 *   tick happened.
 *
 *   A 401 and a 500, which must keep failing exactly as they did.
 *
 * Every scenario also asserts that the secret appears nowhere in stdout,
 * stderr, or the job summary.
 *
 *   node scripts/cronTickCheck.mjs
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:https';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORKFLOW = '.github/workflows/cron-tick.yml';
const STEP = 'Fire the tick';
/** Stands in for a real token. Must never appear in any output. */
const SECRET = 'test-cron-secret-3f9a2c7b1d';

let failures = 0;
let checks = 0;

function check(label, passed, detail = '') {
  checks += 1;
  if (!passed) failures += 1;
  console.log(`${passed ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
}

const work = mkdtempSync(join(tmpdir(), 'cron-tick-check-'));

// ---------------------------------------------------------------------------
// The script under test, taken from the workflow itself
// ---------------------------------------------------------------------------
const script = execFileSync('python3', ['-c', `
import yaml, sys
document = yaml.safe_load(open(${JSON.stringify(WORKFLOW)}))
steps = document['jobs']['tick']['steps']
matching = [s for s in steps if s.get('name') == ${JSON.stringify(STEP)}]
if not matching:
    sys.exit('No step named ${STEP} in ${WORKFLOW}')
sys.stdout.write(matching[0]['run'])
`], { encoding: 'utf8' });

const scriptPath = join(work, 'tick.sh');
writeFileSync(scriptPath, script);
check('the workflow parses and the step script is extractable', script.length > 0, `${script.split('\n').length} lines`);

const syntax = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' });
check('the extracted shell is syntactically valid', syntax.status === 0, syntax.stderr.trim().slice(0, 120));

// ---------------------------------------------------------------------------
// A certificate the local server can present and curl can trust
// ---------------------------------------------------------------------------
const keyPath = join(work, 'key.pem');
const certPath = join(work, 'cert.pem');
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', keyPath, '-out', certPath, '-days', '1',
  '-subj', '/CN=localhost',
  '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
], { stdio: 'pipe' });

const tls = { key: readFileSync(keyPath), cert: readFileSync(certPath) };

/** A representative body from the real route. */
const GOOD = JSON.stringify({
  ok: true,
  mode: 'tick',
  durationMs: 4210,
  results: [{ org: 'Ironside Facilities', queued: 3, processed: 7, failed: 0 }],
  enrichment: [{
    org: 'Ironside Facilities',
    scheduled: 12, attempted: 12, resolved: 5, released: 4,
    stillQueued: 7, unscheduled: 31,
  }],
});

/**
 * Runs the workflow's script and waits for it, without blocking the event loop.
 *
 * Asynchronous on purpose. `spawnSync` would hold the only thread this process
 * has, so the HTTPS server below could never accept the connection and every
 * scenario would sit until curl's own timeout — a test that hangs rather than
 * one that fails.
 */
function runScript(env) {
  return new Promise((resolve) => {
    const child = spawn('bash', [scriptPath], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

/**
 * Runs the workflow's script against a one-shot server.
 *
 * `handler` receives every request; the port is fixed per scenario so a
 * redirect can point back at the same server.
 */
async function run(handler) {
  const requests = [];
  const server = createServer(tls, (req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization ?? null });
    handler(req, res, server.address().port);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const result = await runScript({
    ...process.env,
    CRON_SECRET: SECRET,
    APP_BASE_URL: `https://localhost:${port}`,
    // curl reads both of these natively, so the workflow itself needs no
    // test-only branch: the certificate is trusted and the local server is
    // exempted from any outbound proxy this machine happens to configure.
    CURL_CA_BUNDLE: certPath,
    NO_PROXY: 'localhost,127.0.0.1',
    no_proxy: 'localhost,127.0.0.1',
    GITHUB_STEP_SUMMARY: join(work, 'summary.md'),
  });

  await new Promise((resolve) => server.close(resolve));

  let summary = '';
  try { summary = readFileSync(join(work, 'summary.md'), 'utf8'); } catch { summary = ''; }
  rmSync(join(work, 'summary.md'), { force: true });

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    all: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    summary,
    requests,
    port,
  };
}

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(body);
};

try {
  // -------------------------------------------------------------------------
  console.log('\n--- a healthy tick ------------------------------------------------');
  {
    const r = await run((req, res) => json(res, 200, GOOD));
    check('a valid JSON tick succeeds', r.status === 0, `exit ${r.status}: ${r.stderr.slice(0, 120)}`);
    check('and the Authorization header reached the endpoint',
      r.requests[0]?.auth === `Bearer ${SECRET}`, r.requests[0]?.auth ? 'header present' : 'no header');
    check('and a summary is written', /Tick: tick/.test(r.summary), r.summary.split('\n')[0] ?? 'empty');
    check('with the numbers from the response',
      r.summary.includes('Ironside Facilities') && r.summary.includes('| 12 | 12 | 5 | 4 | 31 |'),
      r.summary.split('\n').filter((l) => l.startsWith('| Ironside')).join(' ').slice(0, 90));
    check('and the still-unscheduled backlog is explained rather than left as a number',
      /Still unscheduled` above zero/.test(r.summary));
  }

  // -------------------------------------------------------------------------
  console.log('\n--- the reported failure: a redirect -------------------------------');
  {
    // Same host, different path — exactly what a trailing slash or a scheme
    // correction produces on Vercel.
    const r = await run((req, res, port) => {
      if (req.url === '/api/cron/tick') {
        res.writeHead(308, { location: `https://localhost:${port}/api/cron/tick/` });
        res.end('Redirecting...');
        return;
      }
      json(res, 200, GOOD);
    });
    check('a same-host redirect is followed to the real endpoint', r.status === 0,
      `exit ${r.status}: ${r.stderr.slice(0, 140)}`);
    check('and the run says it followed one', /Followed 1 redirect/.test(r.stdout),
      r.stdout.split('\n')[0] ?? '');
    check('and the Authorization header survived the redirect',
      r.requests.length === 2 && r.requests[1].auth === `Bearer ${SECRET}`,
      `${r.requests.length} request(s), final header ${r.requests.at(-1)?.auth ? 'present' : 'missing'}`);
    check('and the summary is produced from the endpoint, not the redirect page',
      /Tick: tick/.test(r.summary) && !/Redirecting/.test(r.summary));
  }

  // -------------------------------------------------------------------------
  console.log('\n--- a redirect page that is never followed --------------------------');
  {
    // The pre-fix symptom, reproduced: a 200 whose body is the redirect page.
    // No status code makes this fail, so only the body check can.
    const r = await run((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><meta http-equiv="refresh" content="0"></head><body>Redirecting...</body></html>');
    });
    check('a redirect page returned with a 200 fails the run', r.status !== 0, `exit ${r.status}`);
    check('and is named as a redirect page rather than as bad JSON',
      /redirect page/i.test(r.all), firstError(r.all));
    check('and no summary is written from it', !/Tick:/.test(r.summary), r.summary.slice(0, 60));
  }

  // -------------------------------------------------------------------------
  console.log('\n--- malformed JSON --------------------------------------------------');
  {
    const r = await run((req, res) => json(res, 200, '{"ok": true, "mode": "tick", "results": ['));
    check('a truncated body fails the run', r.status !== 0, `exit ${r.status}`);
    check('and says it is not valid JSON', /not valid JSON/i.test(r.all), firstError(r.all));
    check('and writes no summary', r.summary === '', r.summary.slice(0, 60));
  }

  // -------------------------------------------------------------------------
  console.log('\n--- an empty body and a wrong shape ---------------------------------');
  {
    const empty = await run((req, res) => json(res, 200, ''));
    check('an empty 200 fails the run', empty.status !== 0 && /empty body/i.test(empty.all),
      firstError(empty.all));

    const wrong = await run((req, res) => json(res, 200, '{"status":"fine"}'));
    check('valid JSON that is not a tick result fails the run',
      wrong.status !== 0 && /not a tick result/i.test(wrong.all), firstError(wrong.all));

    const reported = await run((req, res) => json(res, 200, '{"ok":false,"error":"nothing ran"}'));
    check('a tick that reports its own failure fails the run',
      reported.status !== 0 && /reported failure/i.test(reported.all), firstError(reported.all));
  }

  // -------------------------------------------------------------------------
  console.log('\n--- a 401 -----------------------------------------------------------');
  {
    const r = await run((req, res) => json(res, 401, '{"error":"Unauthorised"}'));
    check('a 401 fails the run', r.status !== 0, `exit ${r.status}`);
    check('and the body is shown so somebody can see what the server said',
      /Unauthorised/.test(r.all), firstError(r.all));
    check('and the status is reported', /HTTP 401/.test(r.all));
  }

  // -------------------------------------------------------------------------
  console.log('\n--- a 500 -----------------------------------------------------------');
  {
    const r = await run((req, res) => json(res, 500, '{"error":"boom"}'));
    check('a 500 fails the run', r.status !== 0, `exit ${r.status}`);
    check('and the body is shown', /boom/.test(r.all), firstError(r.all));
    check('and no summary is written', r.summary === '');
  }

  // -------------------------------------------------------------------------
  console.log('\n--- a redirect to a different host ----------------------------------');
  {
    // 127.0.0.1 and localhost are the same machine and different hosts to curl,
    // which is the point: the token must not follow.
    const r = await run((req, res, port) => {
      // Keyed on Host, not path: redirecting on the path alone sends the
      // second host straight back round and the run fails as a redirect loop
      // rather than as the dropped-header 401 this is meant to prove.
      if ((req.headers.host ?? '').startsWith('localhost')) {
        res.writeHead(307, { location: `https://127.0.0.1:${port}/api/cron/tick` });
        res.end('Redirecting...');
        return;
      }
      if (!req.headers.authorization) { json(res, 401, '{"error":"Unauthorised"}'); return; }
      json(res, 200, GOOD);
    });
    check('a cross-host redirect fails the run rather than succeeding quietly', r.status !== 0,
      `exit ${r.status}`);
    check('and the token was not handed to the other host',
      r.requests.length === 2 && r.requests[1].auth === null,
      `final header ${r.requests.at(-1)?.auth ? 'PRESENT — the token leaked' : 'absent'}`);
    check('and the run explains why the 401 happened',
      /dropped the Authorization header/.test(r.all), firstError(r.all));
  }

  // -------------------------------------------------------------------------
  console.log('\n--- a redirect that downgrades to cleartext --------------------------');
  {
    const r = await run((req, res, port) => {
      res.writeHead(307, { location: `http://localhost:${port}/api/cron/tick` });
      res.end('Redirecting...');
    });
    check('an https-to-http redirect is refused', r.status !== 0, `exit ${r.status}`);
    check('and the token was never sent in cleartext',
      r.requests.length === 1, `${r.requests.length} request(s)`);
  }

  // -------------------------------------------------------------------------
  console.log('\n--- a token that would break naive quoting ---------------------------');
  {
    // curl's config parser mis-reads `header = Authorization: Bearer x`, and
    // its quoted form needs backslashes and quotes escaped. A secret store can
    // hold either character, and a silently dropped auth header is the worst
    // way to find that out.
    const hostile = 'ab"c\\d e/+=';
    const requests = [];
    const server = createServer(tls, (req, res) => {
      requests.push({ auth: req.headers.authorization ?? null });
      json(res, 200, GOOD);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const r = await runScript({
      ...process.env,
      CRON_SECRET: hostile,
      APP_BASE_URL: `https://localhost:${port}`,
      CURL_CA_BUNDLE: certPath,
      NO_PROXY: 'localhost,127.0.0.1',
      no_proxy: 'localhost,127.0.0.1',
      GITHUB_STEP_SUMMARY: join(work, 'summary.md'),
    });
    await new Promise((resolve) => server.close(resolve));
    rmSync(join(work, 'summary.md'), { force: true });

    check('a token containing a quote, a backslash and a space arrives intact',
      requests[0]?.auth === `Bearer ${hostile}`,
      requests[0]?.auth === null ? 'no header sent at all' : `got ${JSON.stringify(requests[0]?.auth)}`);
    check('and the run still succeeds', r.status === 0, `exit ${r.status}`);
    check('and that token is not printed either',
      !`${r.stdout}${r.stderr}`.includes(hostile));
  }

  // -------------------------------------------------------------------------
  console.log('\n--- configuration guards --------------------------------------------');
  {
    const missing = await runScript({
      ...process.env, CRON_SECRET: '', APP_BASE_URL: '',
      GITHUB_STEP_SUMMARY: join(work, 'summary.md'),
    });
    check('a missing secret fails before any request is made',
      missing.status !== 0 && /must both be set/.test(missing.stderr), (missing.stderr ?? '').trim().slice(0, 90));

    const cleartext = await runScript({
      ...process.env, CRON_SECRET: SECRET, APP_BASE_URL: 'http://example.test',
      GITHUB_STEP_SUMMARY: join(work, 'summary.md'),
    });
    check('a cleartext APP_BASE_URL is refused before the token is sent',
      cleartext.status !== 0 && /https:\/\/ URL/.test(cleartext.stderr),
      (cleartext.stderr ?? '').trim().slice(0, 90));
    check('and that refusal does not print the token',
      !`${cleartext.stdout}${cleartext.stderr}`.includes(SECRET));
  }

  // -------------------------------------------------------------------------
  console.log('\n--- the token never appears in any output ----------------------------');
  {
    // Re-run every scenario's output through one check rather than trusting
    // each block above to have remembered.
    const scenarios = [
      ['healthy', (req, res) => json(res, 200, GOOD)],
      ['401', (req, res) => json(res, 401, '{"error":"Unauthorised"}')],
      ['500', (req, res) => json(res, 500, '{"error":"boom"}')],
      ['html', (req, res) => { res.writeHead(200); res.end('<html>Redirecting...</html>'); }],
      ['malformed', (req, res) => json(res, 200, '{"ok":')],
    ];
    let leaked = [];
    for (const [name, handler] of scenarios) {
      const r = await run(handler);
      if (r.all.includes(SECRET) || r.summary.includes(SECRET)) leaked.push(name);
      // The header itself must not be echoed either, with or without the value.
      if (/Authorization: Bearer/.test(r.all)) leaked.push(`${name} (header echoed)`);
    }
    check('no scenario prints the secret or the Authorization header',
      leaked.length === 0, leaked.join(', '));
  }

  console.log(`\n${checks - failures}/${checks} checks passed.`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

/** The first line of a failure message, for the check's detail column. */
function firstError(output) {
  const line = output
    .split('\n')
    .find((l) => /The tick |Expected a 2xx|must both be set/.test(l));
  return (line ?? output.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 130);
}

process.exitCode = failures > 0 ? 1 : 0;
