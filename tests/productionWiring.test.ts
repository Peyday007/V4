import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HANDLERS } from '@/lib/jobs/handlers';

/**
 * Does the production path actually call the thing?
 *
 * The single most expensive failure in this codebase, twice over: logic written
 * correctly, tested in isolation, and reached by nothing real. Contact
 * resolution was enqueued as a job that no invocation ever had budget to claim,
 * and the cron returned 200 every morning while a hundred and fifty
 * opportunities sat untouched. Unit tests all passed. They were testing the
 * implementation, and the implementation was never the problem.
 *
 * So these read the deployed files as text and assert the call site exists.
 * That is a blunt instrument and it is the right one: it fails when somebody
 * refactors the caller away, which is exactly the event no behavioural test in
 * this repository would have noticed.
 *
 * Every assertion here has been mutation-checked — the call site was removed
 * and the test confirmed to fail — because a wiring guard that passes against
 * broken wiring is worse than none.
 */

const read = (path: string) => readFileSync(path, 'utf8');

describe('the scheduler reaches the contact backlog', () => {
  const cron = read('lib/jobs/cron.ts');

  it('runs the backlog from the cron handler itself, not via a queued job', () => {
    // The original bug in one line: as a job at priority 35 it sat behind
    // discovery and was never claimed inside the function's lifetime.
    expect(cron).toMatch(/drainContactResolution\(/);
    expect(cron).toMatch(/import .*drainContactResolution.* from '@\/lib\/enrichment\/schedule'/);
  });

  it('gives the backlog its budget before draining the rest of the queue', () => {
    const backlogAt = cron.indexOf('drainContactResolution(');
    const drainAt = cron.indexOf('processJobs(');
    expect(backlogAt).toBeGreaterThan(-1);
    expect(drainAt).toBeGreaterThan(-1);
    // Ordering is the guarantee. Behind the queue drain it is starvable again.
    expect(backlogAt).toBeLessThan(drainAt);
  });

  it('stops the queue drain claiming work it cannot finish', () => {
    expect(cron).toMatch(/processJobs\(\s*10\s*,\s*undefined\s*,\s*deadline\s*\)/);
  });

  it('re-matches supply when the provider catalogue changes', () => {
    expect(cron).toMatch(/resolveSupplyIfCatalogueChanged\(/);
  });

  it('reports the outstanding backlog on every response', () => {
    // `unscheduled` above zero is the one number that says the tick is not
    // reaching the backlog. A response without it cannot be diagnosed.
    expect(cron).toMatch(/unscheduled:\s*backlog\.unscheduledRemaining/);
  });
});

describe('the deployed routes exist and carry the mode in the path', () => {
  it('exposes an explicit tick and daily route', () => {
    expect(read('app/api/cron/tick/route.ts')).toMatch(/runCron\(request,\s*'tick'\)/);
    expect(read('app/api/cron/daily/route.ts')).toMatch(/runCron\(request,\s*'daily'\)/);
  });

  it('schedules the daily sweep in vercel.json, by path', () => {
    const vercel = JSON.parse(read('vercel.json')) as { crons?: Array<{ path: string; schedule: string }> };
    const paths = (vercel.crons ?? []).map((c) => c.path);
    expect(paths).toContain('/api/cron/daily');
    // A query string is the thing a scheduler is most likely to drop, and
    // dropping it silently downgrades `daily` to `tick`.
    for (const path of paths) expect(path).not.toContain('?');
  });

  it('drives the tick more often than once a day, from somewhere', () => {
    // Deliberately not "from vercel.json". This assertion used to require the
    // ten-minute entry there, and that requirement was wrong in a way that cost
    // ten commits: the Hobby plan rejects any cron firing more than once a day
    // *at deploy time*, so the entry did not schedule a tick — it stopped the
    // application being deployed at all. The real invariant is that something
    // drives the loop.
    const vercel = JSON.parse(read('vercel.json')) as { crons?: Array<{ path: string; schedule: string }> };
    const tick = (vercel.crons ?? []).find((c) => c.path === '/api/cron/tick');
    const daily = /^\d+\s+\d+\s+\*\s+\*\s+\*$/;

    if (tick) {
      // A deployment on Pro may schedule it directly, and then it must be
      // more often than daily or it is not a tick.
      expect(tick.schedule).not.toMatch(daily);
      return;
    }

    // Otherwise the GitHub Actions workflow is the scheduler, and it has to be
    // both present and frequent.
    const workflow = read('.github/workflows/cron-tick.yml');
    const cron = workflow.match(/cron:\s*'([^']+)'/)?.[1];
    expect(cron, 'no tick in vercel.json and no schedule in the workflow').toBeDefined();
    expect(cron!).not.toMatch(daily);
  });

  it('ships a plan-independent trigger for deployments that cannot run it', () => {
    const workflow = read('.github/workflows/cron-tick.yml');
    expect(workflow).toMatch(/\/api\/cron\/tick/);
    expect(workflow).toMatch(/Authorization: Bearer/);
    // --fail-with-body, so a rejected call fails the run loudly rather than
    // reporting success while being turned away.
    expect(workflow).toMatch(/--fail-with-body/);
  });
});

describe('routing schedules contact resolution as its last step', () => {
  const pipeline = read('lib/demand/pipeline.ts');

  it('calls the shared scheduler', () => {
    expect(pipeline).toMatch(/scheduleContactResolution\(/);
  });

  it('reports what it left unscheduled rather than inferring it', () => {
    expect(pipeline).toMatch(/contactResolution/);
  });
});

describe('resolution writes where the calling queue reads', () => {
  it('writes the phone onto the company record', () => {
    // The queue's contactability is COALESCE(correctedPhone, company.phone, …).
    // Writing anywhere else resolves a contact that never becomes callable.
    expect(read('lib/enrichment/resolve.ts')).toMatch(/prisma\.company\.update\([\s\S]*?phone:\s*candidate\.phone/);
  });

  it('recomputes eligibility with the queue’s own clause, not a copy', () => {
    const resolve = read('lib/enrichment/resolve.ts');
    expect(resolve).toMatch(/from '@\/lib\/demand\/queue'/);
    // Twice, and both matter: once before the attempt and once after, because
    // "this attempt released work" is the difference between them. Asserting
    // the symbol merely appears passes when one of the two is deleted, which a
    // mutation run caught.
    const calls = [...resolve.matchAll(/callableRouteCount\(/g)];
    expect(calls.length, 'expected a before and an after measurement').toBeGreaterThanOrEqual(2);
  });

  it('reopens resolution when a caller reports a wrong number', () => {
    expect(read('lib/demand/outreach.ts')).toMatch(/rejectContactValue\(/);
  });
});

describe('the caller workspace is wired, not merely written', () => {
  it('serves work through the guard, scoped to the signed-in caller', () => {
    const route = read('app/api/work/next/route.ts');
    expect(route).toMatch(/requireWorkspace\(\)/);
    expect(route).toMatch(/scopeFor\(user\)/);
    // A caller id taken from the request would turn one authorisation check
    // into one per call site, and the forgotten one is the leak.
    expect(route).not.toMatch(/callerId:\s*(?:body|params|input|parsed)/);
  });

  it('checks the gate on the server before serving, not in the browser', () => {
    const packets = read('lib/caller/packets.ts');
    const gateAt = packets.indexOf('await afterCallGate(');
    const serveAt = packets.indexOf('servableRows({');
    expect(gateAt).toBeGreaterThan(-1);
    expect(serveAt).toBeGreaterThan(-1);
    // Ordering is the guarantee: checked before the work is chosen.
    expect(gateAt).toBeLessThan(serveAt);
  });

  it('validates the outcome on the server, with the same rule the form shows', () => {
    const save = read('lib/caller/save.ts');
    expect(save).toMatch(/validateDisposition\(/);
    expect(save).toMatch(/from '\.\/discovery'/);
    // Ownership is asked of the database before anything is written.
    expect(save.indexOf('packetItem.findFirst')).toBeLessThan(save.indexOf('validateDisposition('));
  });

  it('raises an incident when a save fails, rather than blaming the caller', () => {
    const save = read('lib/caller/save.ts');
    expect(save).toMatch(/workIncident\.create\(/);
    expect(save).toMatch(/kind:\s*'SAVE_FAILURE'/);
    // What they typed is kept with the failure.
    expect(save).toMatch(/preserved:/);
  });

  it('holds a caller on an open save failure and says it is ours', () => {
    const packets = read('lib/caller/packets.ts');
    expect(packets).toMatch(/workIncident\.findFirst\(/);
    expect(packets).toMatch(/systemFault:\s*true/);
  });

  it('goes through the canonical save rather than writing attempts itself', () => {
    const save = read('lib/caller/save.ts');
    expect(save).toMatch(/saveDisposition\(/);
    expect(save).not.toMatch(/outreachAttempt\.create\(/);
  });

  it('keeps the ownership invariants in the database, not in a convention', () => {
    const migrations = [
      read('prisma/migrations/20260812160000_caller_execution/migration.sql'),
      read('prisma/migrations/20260812170000_one_live_record_per_caller/migration.sql'),
    ].join('\n');
    // One caller per route, and one live record per caller. Application checks
    // lose both races.
    expect(migrations).toMatch(/CREATE UNIQUE INDEX "PacketItem_active_owner_key"/);
    expect(migrations).toMatch(/CREATE UNIQUE INDEX "PacketItem_one_live_per_caller_key"/);
    expect(migrations).toMatch(/WHERE "status" IN \('PENDING', 'IN_PROGRESS'\)/);
    expect(migrations).toMatch(/WHERE "status" = 'IN_PROGRESS'/);
  });

  it('never stores a PIN in the clear', () => {
    const identity = read('lib/caller/identity.ts');
    expect(identity).toMatch(/hashSecret\(/);
    expect(identity).not.toMatch(/pinHash:\s*pin\b/);
    // And no endpoint reads one back.
    expect(read('app/api/work/pin/route.ts')).not.toMatch(/findFirst[\s\S]{0,200}pinHash/);
  });
});

describe('every job kind is either reachable or declared dormant', () => {
  /**
   * Handlers with no enqueue site anywhere.
   *
   * Listed explicitly rather than tolerated silently. Each of these is a
   * capability that exists in code and cannot currently be triggered by
   * anything — which is worth knowing and is not worth pretending is wired.
   * Removing a name from this list without adding an enqueue site fails the
   * test below.
   */
  const DORMANT: Record<string, string> = {
    'scoring.run_all': 'Bulk rescoring. Reached only through planning.daily, which calls the function directly.',
    'next_action.refresh_all': 'Same — planning.daily calls refreshAllNextActions directly.',
    'vulnerability.assess_all': 'Same — planning.daily calls assessAllCompanies directly.',
    'lanes.evaluate_all': 'Same — planning.daily calls evaluateAllLanes directly.',
    'document.generate': 'Document generation has no trigger yet; documents are produced on request.',
    'notification.send': 'No notification channel is configured, so nothing raises one.',
  };

  /**
   * Every file that can put a job on the queue, with handler *declarations*
   * stripped out.
   *
   * The strip matters. `handlers.ts` names each kind twice — once as the key
   * of the handler and once, sometimes, in an `enqueue` call that chains the
   * next step. Counting the key as a call site makes every handler look wired
   * to itself, which is precisely the illusion this file exists to break.
   */
  const enqueueSites = [
    'lib/jobs/cron.ts',
    'lib/jobs/handlers.ts',
    'lib/demand/pipeline.ts',
    'scripts/tick.ts',
    'lib/calling.ts',
    'app/api/discovery/run/route.ts',
    // Call transcription is enqueued from the route that ends a call, because
    // that is the moment it becomes known whether there is any audio to work
    // from. Queuing it earlier would fill the queue with work that can only
    // fail. This list is the whole reason the guard below can be trusted, so a
    // new enqueue site outside lib/ has to be added here — the alternative,
    // scanning everything, would let `kind:` on an unrelated record count as a
    // job and quietly make every handler look wired.
    'app/api/calls/session/route.ts',
  ]
    .map((path) => {
      let src: string;
      try {
        src = read(path);
      } catch {
        return '';
      }
      // Drop `'some.kind': async (job) => {` — the declaration, not a call.
      return src.replace(/^\s*'[a-z_.]+':\s*async\b.*$/gm, '');
    })
    .join('\n');

  /**
   * Kinds named in an `enqueue({ kind: … })`, including the ternary form.
   *
   * Filtered against the declared handlers, because `kind:` is an ordinary
   * field name elsewhere — an audit row and a task both have one — and a
   * `kind: 'system'` has no business being read as a job.
   */
  const enqueued = new Set(
    [...enqueueSites.matchAll(/kind:\s*(?:[^,;{}]*?\?\s*)?'([a-z_.]+)'(?:\s*:\s*'([a-z_.]+)')?/g)]
      .flatMap((m) => [m[1], m[2]])
      .filter((k): k is string => Boolean(k) && k in HANDLERS),
  );

  it('has a handler for nothing that cannot be enqueued, unless declared', () => {
    const unreachable = Object.keys(HANDLERS).filter((kind) => !enqueued.has(kind));
    const undeclared = unreachable.filter((kind) => !(kind in DORMANT));
    expect(undeclared, `job kinds with a handler and no enqueue site: ${undeclared.join(', ')}`).toEqual([]);
  });

  it('declares nothing dormant that is actually wired', () => {
    // The other direction, so the list cannot rot into a lie once somebody
    // wires one of these up.
    const wiredButDeclared = Object.keys(DORMANT).filter((kind) => enqueued.has(kind));
    expect(wiredButDeclared, `declared dormant but enqueued somewhere: ${wiredButDeclared.join(', ')}`).toEqual([]);
  });

  it('has a handler for every kind anything enqueues', () => {
    expect(enqueued.size).toBeGreaterThan(0);
    for (const kind of enqueued) {
      expect(HANDLERS[kind], `enqueued with no handler: "${kind}"`).toBeTypeOf('function');
    }
  });
});
