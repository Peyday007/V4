import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HANDLERS } from '@/lib/jobs/handlers';
import { deliveryHash, toDelivery } from '@/lib/brain/map';

/**
 * The connector, without a database.
 *
 * Three questions this file answers, and each one is a failure the site has had
 * before in another form:
 *
 *   * does the mapping send what Brain needs and *only* that — a connector that
 *     quietly replicated the margin would be the second master this design
 *     exists to prevent;
 *   * does the client fail honestly — a timeout must not arrive at the panel
 *     looking like "Brain says there is nothing";
 *   * is any of it actually reached — `productionWiring.test.ts`'s lesson,
 *     which cost this codebase two working features that nothing called.
 */

const ORIGINAL_ENV = { ...process.env };
const CREDENTIAL = 'brnw_test_credential_value_0123456789';

/**
 * `lib/env.ts` memoises its parsed environment on first read, deliberately —
 * a server that re-parsed on every call would re-parse on every request. These
 * tests change the environment on purpose, so they reset the module registry
 * and import through it, which is the only honest way to exercise both the
 * connected and the unconnected path in one file.
 */
async function load(connected: boolean) {
  process.env.DATABASE_URL = 'postgresql://unused/in-these-tests';
  process.env.SESSION_SECRET = 'a-session-secret-long-enough-for-the-schema';
  if (connected) {
    process.env.BRAIN_URL = 'https://brain.example';
    process.env.BRAIN_TOKEN = CREDENTIAL;
    process.env.BRAIN_PROJECT_ID = 'prj_test';
  } else {
    delete process.env.BRAIN_URL;
    delete process.env.BRAIN_TOKEN;
    delete process.env.BRAIN_PROJECT_ID;
  }
  vi.resetModules();
  const config = await import('@/lib/brain/config');
  const client = await import('@/lib/brain/client');
  return { ...config, ...client };
}

const OPPORTUNITY = {
  id: 'opp_alpha',
  orgId: 'org_1',
  name: 'Roof replacement across 40 units',
  summary: 'A property manager needs 40 roofs replaced before winter.',
  type: 'SUBCONTRACTING',
  stage: 'QUALIFYING',
  status: 'ACTIVE',
  priority: 'HIGH',
  state: 'MI',
  location: 'Oakland County',
  estimatedValue: 240000,
  estimatedGrossProfit: 61000,
  expectedValue: 96000,
  closingProbability: 0.4,
  primaryBlocker: 'no confirmed roofing capacity in the county',
  missingInformation: ['crew availability', 'permit lead time'],
  wedgeStrategy: 'lead with the permit timetable',
  aiExplanation: 'internal reasoning nobody outside should read',
  createdAt: new Date('2026-08-01T09:00:00.000Z'),
  updatedAt: new Date('2026-09-01T10:00:00.000Z'),
  lane: { name: 'Roofing — Michigan' },
} as never;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('what crosses to Brain', () => {
  it('sends what Brain needs to identify, reason about and prioritise the record', () => {
    const delivery = toDelivery(OPPORTUNITY);
    expect(delivery.sourceRecordId).toBe('opp_alpha');
    expect(delivery.sourceRecordType).toBe('OPPORTUNITY');
    expect(delivery.sourceVersion).toBe('2026-09-01T10:00:00.000Z');
    expect(delivery.sourceRef).toBe('/opportunities/opp_alpha');
    expect(delivery.title).toBe('Roof replacement across 40 units');
    expect(delivery.attributes.primaryBlocker).toContain('roofing capacity');
    expect(delivery.attributes.missingInformation).toEqual([
      'crew availability',
      'permit lead time',
    ]);
    expect(delivery.attributes.lane).toBe('Roofing — Michigan');
  });

  it('never sends the margin, the wedge or the internal reasoning', () => {
    const serialized = JSON.stringify(toDelivery(OPPORTUNITY));
    expect(serialized).not.toContain('61000');
    expect(serialized).not.toContain('estimatedGrossProfit');
    expect(serialized).not.toContain('wedgeStrategy');
    expect(serialized).not.toContain('internal reasoning');
  });

  it('sends a site-relative reference, so nothing downstream can make it a URL', () => {
    expect(toDelivery(OPPORTUNITY).sourceRef.startsWith('/')).toBe(true);
    expect(toDelivery(OPPORTUNITY).sourceRef).not.toContain('://');
  });

  it('hashes the delivery so an unchanged record is never re-sent', () => {
    const a = deliveryHash(toDelivery(OPPORTUNITY));
    const b = deliveryHash(toDelivery({ ...(OPPORTUNITY as object) } as never));
    expect(a).toBe(b);

    const moved = deliveryHash(
      toDelivery({ ...(OPPORTUNITY as object), name: 'Roof replacement across 44 units' } as never),
    );
    expect(moved).not.toBe(a);
  });

  it('moves the version with the row, so Brain can order two deliveries', () => {
    const later = toDelivery({
      ...(OPPORTUNITY as object),
      updatedAt: new Date('2026-09-02T10:00:00.000Z'),
    } as never);
    expect(later.sourceVersion > toDelivery(OPPORTUNITY).sourceVersion).toBe(true);
  });
});

describe('being connected, or not', () => {
  it('is off unless all three settings are present', async () => {
    const brain = await load(false);
    expect(brain.brainConfig()).toBeNull();
    expect(brain.isConnected()).toBe(false);
    expect(brain.describeBrain()).toBeNull();
  });

  it('names the Brain by host and project, and never by credential', async () => {
    const brain = await load(true);
    const described = brain.describeBrain();
    expect(described).toContain('brain.example');
    expect(described).toContain('prj_test');
    expect(described).not.toContain('brnw_');
  });
});

describe('failing honestly', () => {
  it('reports a timeout as a timeout, not as an empty answer', async () => {
    const brain = await load(true);
    vi.stubGlobal('fetch', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      return Promise.reject(error);
    });
    const result = await brain.readProjection('opp_alpha');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('TIMEOUT');
    expect(brain.describeFailure(result.failure)).toBe('Brain did not answer in time.');
  });

  it('reports Brain’s own 404 as NOT_FOUND rather than as an error', async () => {
    const brain = await load(true);
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response('{"error":"No record with that id."}', { status: 404 })),
    );
    const result = await brain.readProjection('opp_alpha');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('NOT_FOUND');
  });

  it('reports a refusal with Brain’s own words and its status', async () => {
    const brain = await load(true);
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response(JSON.stringify({ error: 'records must be an array.' }), { status: 400 })),
    );
    const result = await brain.pushRecords([]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('REFUSED');
    expect(brain.describeFailure(result.failure)).toContain('must be an array');
  });

  it('never puts the credential into a failure it reports', async () => {
    const brain = await load(true);
    vi.stubGlobal('fetch', () =>
      Promise.reject(new Error('connect ECONNREFUSED to the configured host')),
    );
    const result = await brain.pushRecords([]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const rendered = JSON.stringify(result.failure) + brain.describeFailure(result.failure);
    expect(rendered).not.toContain(CREDENTIAL);
    expect(rendered).not.toContain('Bearer');
  });

  it('redacts a Brain credential that some other layer put into a log line', async () => {
    const { redactForLogs } = await import('@/lib/audit');
    const line = `fetch failed: authorization: Bearer ${CREDENTIAL}`;
    expect(redactForLogs(line)).not.toContain(CREDENTIAL);
  });

  it('does nothing at all when the site is not connected', async () => {
    const brain = await load(false);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await brain.readProjection('opp_alpha');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('NOT_CONNECTED');
  });
});

describe('the command', () => {
  it('sends no idempotency key, because Brain derives its own', async () => {
    const brain = await load(true);
    let seen: Record<string, string> = {};
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      seen = (init.headers ?? {}) as Record<string, string>;
      return Promise.resolve(
        new Response(JSON.stringify({ record: {}, replayed: false, operationId: 'op' }), {
          status: 200,
        }),
      );
    });
    await brain.sendCommand({
      sourceRecordId: 'opp_alpha',
      command: 'RESEARCH_FURTHER',
      actorLabel: 'Dana Reyes (Deal Manager)',
    });
    const keys = Object.keys(seen).map((key) => key.toLowerCase());
    expect(keys).not.toContain('idempotency-key');
    expect(keys).toContain('authorization');
  });

  it('carries the person as attribution, in the body, never as identity', async () => {
    const brain = await load(true);
    let body = '';
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      body = String(init.body);
      return Promise.resolve(
        new Response(JSON.stringify({ record: {}, replayed: false, operationId: 'op' }), {
          status: 200,
        }),
      );
    });
    await brain.sendCommand({
      sourceRecordId: 'opp_alpha',
      command: 'RESEARCH_FURTHER',
      actorLabel: 'Dana Reyes (Deal Manager)',
    });
    const parsed = JSON.parse(body) as { command: string; actor: { label: string } };
    expect(parsed.command).toBe('RESEARCH_FURTHER');
    expect(parsed.actor.label).toBe('Dana Reyes (Deal Manager)');
    // No user id, no session, no role key: Brain has no use for any of them and
    // a name it could mistake for an identity is the thing to avoid.
    expect(body).not.toContain('userId');
    expect(body).not.toContain('sessionId');
  });
});

/**
 * The wiring guard. Written the way `productionWiring.test.ts` is, and for the
 * reason it gives: a connector nothing calls is the failure mode this codebase
 * has actually had, twice, and no behavioural test would have caught it.
 */
describe('the connector is reached by the production path', () => {
  const read = (path: string) => readFileSync(path, 'utf8');

  it('registers both halves as job handlers', () => {
    expect(Object.keys(HANDLERS)).toContain('brain.push');
    expect(Object.keys(HANDLERS)).toContain('brain.pull');
  });

  it('is enqueued from the cron tick, not only from the daily sweep', () => {
    const cron = read('lib/jobs/cron.ts');
    const push = cron.indexOf("kind: 'brain.push'");
    const daily = cron.indexOf("if (mode === 'daily')");
    expect(push).toBeGreaterThan(-1);
    expect(cron).toContain("kind: 'brain.pull'");
    // Before the daily branch: a window onto Brain that refreshed once a day
    // would not be a window.
    expect(push).toBeLessThan(daily);
  });

  it('renders the panel on the opportunity page', () => {
    const page = read('app/(app)/opportunities/[id]/page.tsx');
    expect(page).toContain('brainViewOf(');
    expect(page).toMatch(/<BrainPanel\b/);
  });

  /*
   * The production walkthrough reads the panel through these hooks rather than
   * through its English labels, so that the six states are asserted as
   * themselves. A rename here would make that check quietly stop looking at
   * anything, which is the way a green run comes to mean nothing.
   */
  it('leaves the walkthrough something stable to read the panel by', () => {
    const panel = read('components/BrainPanel.tsx');
    for (const hook of [
      'data-testid="brain-panel"',
      'data-brain-state=',
      'data-brain-freshness=',
      'data-testid="brain-state"',
      'data-testid="brain-state-reason"',
      'data-testid="brain-freshness"',
      'data-testid="brain-command"',
      'data-testid="brain-identity"',
    ]) {
      expect(panel).toContain(hook);
    }
    const check = read('scripts/brainGoldenLoopCheck.mjs');
    expect(check).toContain('data-testid="brain-panel"');
    expect(check).toContain('data-brain-state');
    // The one button is found by the words a person reads, so the two must agree.
    expect(panel).toContain('Ask Brain to research this');
    expect(check).toContain('Ask Brain to research this');
  });

  it('never lets the walkthrough print what it is checking for', () => {
    const check = read('scripts/brainGoldenLoopCheck.mjs');
    // It asserts no credential is in the page. It must not log one either.
    expect(check).not.toMatch(/console\.log\([^)]*BRAIN_TOKEN/);
    expect(check).not.toContain('process.env.BRAIN_TOKEN');
    expect(check).toContain('/brnw_/');
  });

  it('exposes the command on a route a person’s session authenticates', () => {
    const route = read('app/api/opportunities/[id]/brain/route.ts');
    expect(route).toContain('requireAny(');
    expect(route).toContain('orgId: user.orgId');
    expect(route).toContain('sendCommand(');
    // The tenant guard and the refusal that does not distinguish absent from
    // forbidden. Both are load-bearing and both are one line away from being
    // dropped by a refactor.
    expect(route).toContain("json({ error: 'Opportunity not found' }, 404)");
  });

  it('reports the connection on the site’s own health check, without the credential', () => {
    const health = read('app/api/health/route.ts');
    // Two facts, separately: configured, and answering. Having the variables
    // set is not the same fact as the other end replying.
    expect(health).toContain('isConnected()');
    expect(health).toContain('readProjectionsSince(');
    expect(health).toContain('describeBrain()');
    /*
     * Naming the *variable* is the point — it is the instruction an operator
     * needs. What must never appear is the value, so the assertion is that this
     * route never reads the credential out of the config at all: it goes
     * through `describeBrain()`, which is host and project, and through the
     * client, which puts the bearer in a header and nowhere else.
     */
    expect(health).toContain('missingBrainSettings()');
    // And the names it reports come from one place, which is the module that
    // holds the values and deliberately returns none of them.
    const config = read('lib/brain/config.ts');
    for (const name of ['BRAIN_URL', 'BRAIN_TOKEN', 'BRAIN_PROJECT_ID']) {
      expect(config).toContain(`'${name}'`);
    }
    expect(config).not.toMatch(/missing\.push\(config\./);
    expect(health).not.toMatch(/\.token/);
    expect(health).not.toContain('brainConfig(');
    // And an unreachable Brain is never a reason to call the whole site down.
    expect(health).toMatch(/checks\.brain = \{\s*\n?\s*ok: true/);
  });

  it('registers a record Brain has never been told about, when somebody opens it', () => {
    const view = read('lib/brain/view.ts');
    // Without this a freshly connected site reads "not sent to Brain yet" on
    // every record until a scheduled push runs.
    expect(view).toContain("result.failure.kind === 'NOT_FOUND'");
    expect(view).toContain('pushOne(');
    // One record, not a page: a read path must not make one page load pay for
    // the whole organisation.
    const sync = read('lib/brain/sync.ts');
    expect(sync).toMatch(/export async function pushOne\(/);
    // And it must not move the sweep's cursor.
    const pushOneBody = sync.slice(sync.indexOf('export async function pushOne('), sync.indexOf('async function markPushed('));
    expect(pushOneBody).not.toContain('pushCursor');
  });

  it('never writes Brain’s opinion back onto the opportunity row', () => {
    const sync = read('lib/brain/sync.ts');
    expect(sync).not.toMatch(/prisma\.opportunity\.update/);
    expect(sync).not.toMatch(/prisma\.opportunity\.updateMany/);
    const route = read('app/api/opportunities/[id]/brain/route.ts');
    expect(route).not.toMatch(/prisma\.opportunity\.update/);
  });

  it('adds no paid provider, key or service', () => {
    const files = [
      'lib/brain/client.ts',
      'lib/brain/sync.ts',
      'lib/brain/view.ts',
      'lib/brain/map.ts',
      'app/api/opportunities/[id]/brain/route.ts',
    ].map(read).join('\n');
    expect(files).not.toMatch(/ANTHROPIC_API_KEY|OPENAI_API_KEY|api\.openai\.com|api\.anthropic\.com/);
    expect(files).not.toMatch(/LLM_PROVIDER/);
  });
});
