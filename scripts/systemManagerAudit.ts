/**
 * The System Manager against a real database.
 *
 * The unit tests check that the rules decide the right thing. This checks the
 * things the rules are not trusted with — the guarantees that have to hold even
 * when a future caller of these functions gets it wrong, and which therefore
 * live in Postgres:
 *
 *   A row that attributes a failure to the system cannot carry a person's id.
 *   A restriction cannot exist without the conditions for lifting it.
 *   A case cannot exist without an innocent explanation for the same facts.
 *   Two live restrictions on one capability for one person cannot coexist.
 *   A shadow row cannot be enforced.
 *
 * Every one of these is attempted directly against the client, bypassing the
 * library, because the library is exactly what a future change might break.
 *
 *   npx tsx scripts/systemManagerAudit.ts
 */

import { prisma } from '@/lib/db';
import { attribute } from '@/lib/manager/attribution';
import { openCase, resolveCase, sweepConsistency } from '@/lib/manager/cases';
import { applyForCase, enforceIntervention, liftIntervention, activeRestrictions } from '@/lib/manager/interventions';
import { capabilityGate } from '@/lib/manager/gate';
import { evaluateBreakers, readHealth, closeBreaker } from '@/lib/manager/breakers';
import { assessReadiness, recordReadiness } from '@/lib/manager/readiness';
import { generateBrief } from '@/lib/manager/brief';
import { setOrgConfig, getOrgConfig, DEFAULT_CONFIG } from '@/lib/config';
import { RESTORATION } from '@/lib/manager/ladder';
import { RUNG_ORDER, restrictsWork } from '@/lib/manager/rules';
import type { Finding } from '@/lib/manager/consistency';

let failures = 0;
let checks = 0;

function check(label: string, passed: boolean, detail = '') {
  checks += 1;
  if (!passed) failures += 1;
  console.log(`${passed ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
}

/** Runs a write that must be refused, and reports the refusal as the pass. */
async function refuses(label: string, run: () => Promise<unknown>, expect: RegExp) {
  try {
    await run();
    check(label, false, 'the write was accepted');
  } catch (error) {
    const message = String(error);
    check(label, expect.test(message), message.slice(0, 160).replace(/\s+/g, ' '));
  }
}

const finding = (over: Partial<Finding> = {}): Finding => ({
  kind: 'ATTEMPT_WITHOUT_EVIDENCE',
  dedupeKey: `audit:${Math.random().toString(36).slice(2)}`,
  callerId: null,
  routeId: null,
  attemptId: null,
  sessionId: null,
  capability: 'CALL_PLACING',
  at: new Date(),
  observed: 'Audit fixture: a call with nothing recorded.',
  expected: 'Audit fixture: something recorded.',
  evidence: [{ label: 'fixture', ref: 'Audit:1' }],
  benignAlternatives: ['The save dropped it.'],
  confidence: 0.9,
  question: 'Audit fixture question.',
  ...over,
});

async function main() {
  const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!org) throw new Error('No organisation. Seed the database first.');

  const caller = await prisma.user.findFirst({
    where: { orgId: org.id, callerProfile: { isNot: null } },
    orderBy: { createdAt: 'asc' },
  });
  const owner = await prisma.user.findFirst({ where: { orgId: org.id }, orderBy: { createdAt: 'asc' } });
  if (!caller || !owner) throw new Error('No caller or owner. Run the seed first.');

  const route = await prisma.routeHypothesis.findFirst({
    where: { orgId: org.id }, orderBy: { createdAt: 'asc' }, select: { id: true },
  });
  if (!route) throw new Error('No route. Run scripts/dealProgressionAudit.ts first.');

  await cleanUp(org.id);

  // =========================================================================
  console.log('--- a system failure can never name a person --------------------');

  await refuses(
    'the database refuses a system-attributed row that names a caller',
    () => prisma.intervention.create({
      data: {
        orgId: org.id, callerId: caller.id, rung: 'WARNING', attribution: 'SYSTEM_FAULT',
        reason: 'Audit: this must not be possible.',
        evidence: [{ label: 'fixture', ref: 'Audit:1' }],
        producedBy: 'audit', ruleVersion: 'audit@1',
      },
    }),
    /system_faults_are_never_a_persons_fault/,
  );

  const ours = await openCase({
    orgId: org.id,
    finding: finding({ callerId: caller.id, routeId: route.id }),
    incidents: [{
      id: 'fixture-incident', kind: 'SAVE_FAILURE', createdAt: new Date(),
      resolvedAt: null, callerId: caller.id, routeId: route.id,
      detail: 'The save failed on our side.',
    }],
  });
  check('a case covered by an incident is attributed to the system', ours.attribution === 'SYSTEM_FAULT');
  check('and its caller id is cleared, so it is not a question about them',
    ours.case.callerId === null, String(ours.case.callerId));
  check('and it is closed on arrival rather than left in somebody\'s queue',
    ours.case.state === 'SYSTEM_FAULT' && ours.case.resolvedAt !== null, ours.case.state);
  check('and no question is put to anybody', ours.case.question === null);

  const theirs = await openCase({
    orgId: org.id,
    finding: finding({ callerId: caller.id, routeId: route.id }),
    incidents: [],
  });
  check('a case with no outage behind it is undetermined, never "theirs"',
    theirs.case.attribution === 'UNDETERMINED' && theirs.case.state === 'OPEN', theirs.case.attribution);
  check('and it carries a question rather than a finding', Boolean(theirs.case.question));

  // =========================================================================
  console.log('\n--- a case cannot exist without an innocent explanation ---------');

  await refuses(
    'the database refuses a case with no benign alternative',
    () => prisma.consistencyCase.create({
      data: {
        orgId: org.id, kind: 'DUPLICATE_ATTEMPT', dedupeKey: `audit-no-benign-${Date.now()}`,
        observed: 'x', expected: 'y',
        evidence: [{ label: 'fixture', ref: 'Audit:1' }],
        benignAlternatives: [],
        producedBy: 'audit', ruleVersion: 'audit@1', confidence: 0.5,
      },
    }),
    /offers_a_benign_explanation/,
  );

  await refuses(
    'and one with no evidence at all',
    () => prisma.consistencyCase.create({
      data: {
        orgId: org.id, kind: 'DUPLICATE_ATTEMPT', dedupeKey: `audit-no-evidence-${Date.now()}`,
        observed: 'x', expected: 'y', evidence: [],
        benignAlternatives: ['A redial.'],
        producedBy: 'audit', ruleVersion: 'audit@1', confidence: 0.5,
      },
    }),
    /names_its_evidence/,
  );

  await refuses(
    'and an answer recorded against a question nobody asked',
    () => prisma.consistencyCase.create({
      data: {
        orgId: org.id, kind: 'DUPLICATE_ATTEMPT', dedupeKey: `audit-answer-${Date.now()}`,
        observed: 'x', expected: 'y',
        evidence: [{ label: 'fixture', ref: 'Audit:1' }],
        benignAlternatives: ['A redial.'],
        producedBy: 'audit', ruleVersion: 'audit@1', confidence: 0.5,
        answer: 'I never saw a question.',
      },
    }),
    /an_answer_needs_a_question/,
  );

  const duplicateKey = `audit-dedupe-${Date.now()}`;
  const first = await openCase({ orgId: org.id, finding: finding({ dedupeKey: duplicateKey, callerId: caller.id }) });
  const second = await openCase({ orgId: org.id, finding: finding({ dedupeKey: duplicateKey, callerId: caller.id }) });
  check('the same finding twice does not put the same question to somebody twice',
    first.created && !second.created && first.case.id === second.case.id);

  // =========================================================================
  console.log('\n--- a restriction cannot exist without its way out ---------------');

  for (const rung of RUNG_ORDER.filter(restrictsWork)) {
    await refuses(
      `the database refuses ${rung.toLowerCase().replace(/_/g, ' ')} with no restoration rule`,
      () => prisma.intervention.create({
        data: {
          orgId: org.id, callerId: caller.id, rung, capability: 'CALL_PLACING',
          attribution: 'OPERATOR', reason: 'Audit fixture.',
          evidence: [{ label: 'fixture', ref: 'Audit:1' }],
          producedBy: 'audit', ruleVersion: 'audit@1',
        },
      }),
      /restrictions_define_their_own_end/,
    );
  }

  await refuses(
    'and a restriction that does not name what it restricts',
    () => prisma.intervention.create({
      data: {
        orgId: org.id, callerId: caller.id, rung: 'CAPABILITY_PAUSE',
        attribution: 'OPERATOR', reason: 'Audit fixture.',
        restorationRule: 'Something.',
        evidence: [{ label: 'fixture', ref: 'Audit:1' }],
        producedBy: 'audit', ruleVersion: 'audit@1',
      },
    }),
    /a_stop_names_what_it_stops/,
  );

  await refuses(
    'a warning with no records behind it',
    () => prisma.intervention.create({
      data: {
        orgId: org.id, callerId: caller.id, rung: 'WARNING',
        attribution: 'OPERATOR', reason: 'Audit fixture.', evidence: [],
        producedBy: 'audit', ruleVersion: 'audit@1',
      },
    }),
    /serious_rungs_name_their_records/,
  );

  await refuses(
    'a shadow row that claims to have been enforced',
    () => prisma.intervention.create({
      data: {
        orgId: org.id, callerId: caller.id, rung: 'MICRO_COACHING',
        attribution: 'OPERATOR', reason: 'Audit fixture.',
        producedBy: 'audit', ruleVersion: 'audit@1',
        shadow: true, enforcedAt: new Date(), state: 'ACTIVE',
      },
    }),
    /shadow_never_enforces/,
  );

  await refuses(
    'and a lifting with no sentence saying what changed',
    () => prisma.intervention.create({
      data: {
        orgId: org.id, callerId: caller.id, rung: 'MICRO_COACHING',
        attribution: 'OPERATOR', reason: 'Audit fixture.',
        producedBy: 'audit', ruleVersion: 'audit@1',
        state: 'LIFTED', liftedAt: new Date(),
      },
    }),
    /lifting_is_explained/,
  );

  // =========================================================================
  console.log('\n--- the ladder, end to end ---------------------------------------');

  // A case a person confirms is the only thing that produces an intervention.
  const unconfirmed = await applyForCase({ orgId: org.id, caseId: theirs.case.id, actorId: owner.id });
  check('an open case produces no intervention at all',
    !unconfirmed.applied, unconfirmed.message.slice(0, 90));

  await resolveCase({
    orgId: org.id, caseId: theirs.case.id, resolvedById: owner.id,
    state: 'CONFIRMED', resolution: 'Audit: confirmed against the caller after asking.',
  });
  const confirmedCase = await prisma.consistencyCase.findUniqueOrThrow({ where: { id: theirs.case.id } });
  check('a person confirming a case is the only path to OPERATOR',
    confirmedCase.attribution === 'OPERATOR', confirmedCase.attribution);

  // The caller needs enough work behind them before anything is read as a
  // habit, so the floor is lowered for the fixture rather than faking calls.
  await setOrgConfig(org.id, {
    managerRules: { ...DEFAULT_CONFIG.managerRules, minAttemptsForCoaching: 0 },
  }, owner.id);

  const applied = await applyForCase({ orgId: org.id, caseId: theirs.case.id, actorId: owner.id });
  check('a confirmed case produces the smallest sufficient rung',
    applied.applied && applied.intervention?.rung === 'REQUIRED_CORRECTION',
    applied.intervention?.rung ?? applied.message.slice(0, 90));

  // A restriction, applied by hand, which is the only way one ever goes live.
  const restriction = await prisma.intervention.create({
    data: {
      orgId: org.id, callerId: caller.id, rung: 'RESTRICTED_MODE', capability: 'QUOTE_DRAFTING',
      attribution: 'OPERATOR', reason: 'Audit fixture: a restriction to test the gate.',
      evidence: [{ label: 'fixture', ref: 'Audit:1' }],
      restorationRule: RESTORATION.QUOTE_DRAFTING,
      producedBy: 'audit', ruleVersion: 'audit@1', state: 'PROPOSED', shadow: true,
    },
  });

  const beforeEnforcing = await capabilityGate({
    orgId: org.id, userId: caller.id, capability: 'QUOTE_DRAFTING',
  });
  check('a proposed restriction stops nobody', beforeEnforcing.allowed, beforeEnforcing.message.slice(0, 80));

  // A row that is ACTIVE and still marked shadow is calibration, and must stop
  // nobody. The database permits it (there is no enforcedAt), so the gate is
  // the only thing standing between a calibration run and a real restriction.
  const shadowActive = await prisma.intervention.create({
    data: {
      orgId: org.id, callerId: caller.id, rung: 'CAPABILITY_PAUSE', capability: 'CALL_PLACING',
      attribution: 'OPERATOR', reason: 'Audit fixture: active in shadow, which is not active.',
      evidence: [{ label: 'fixture', ref: 'Audit:1' }],
      restorationRule: RESTORATION.CALL_PLACING,
      producedBy: 'audit', ruleVersion: 'audit@1', state: 'ACTIVE', shadow: true,
    },
  });
  const shadowGate = await capabilityGate({
    orgId: org.id, userId: caller.id, capability: 'CALL_PLACING',
  });
  check('a decision recorded in shadow stops nobody, even in an active state',
    shadowGate.allowed, shadowGate.message.slice(0, 90));
  await prisma.intervention.delete({ where: { id: shadowActive.id } });

  const managerTry = await enforceIntervention({
    orgId: org.id, interventionId: restriction.id, actorId: owner.id, authority: 'manager',
  });
  check('a manager may apply a restricted mode', managerTry.ok, managerTry.message);

  // ...but not the two rungs that touch somebody's standing.
  const ownerOnly = await prisma.intervention.create({
    data: {
      orgId: org.id, callerId: caller.id, rung: 'SECURITY_RESTRICTION', capability: 'CALL_PLACING',
      attribution: 'OPERATOR', reason: 'Audit fixture: the owner\'s to apply.',
      evidence: [{ label: 'fixture', ref: 'Audit:1' }],
      restorationRule: RESTORATION.CALL_PLACING,
      producedBy: 'audit', ruleVersion: 'audit@1', state: 'PROPOSED', shadow: true,
    },
  });
  const managerOverreach = await enforceIntervention({
    orgId: org.id, interventionId: ownerOnly.id, actorId: owner.id, authority: 'manager',
  });
  check('a manager cannot apply a security restriction',
    !managerOverreach.ok && /owner/i.test(managerOverreach.message), managerOverreach.message.slice(0, 90));

  const ownerApplies = await enforceIntervention({
    orgId: org.id, interventionId: ownerOnly.id, actorId: owner.id, authority: 'owner',
  });
  check('and an owner can', ownerApplies.ok, ownerApplies.message);
  await prisma.intervention.update({
    where: { id: ownerOnly.id },
    data: {
      state: 'LIFTED', liftedAt: new Date(), liftedById: owner.id,
      liftedBecause: 'Audit fixture teardown.',
    },
  });

  const afterEnforcing = await capabilityGate({
    orgId: org.id, userId: caller.id, capability: 'QUOTE_DRAFTING',
  });
  check('and then it actually stops them', !afterEnforcing.allowed, afterEnforcing.kind);
  check('with the way out in the same sentence',
    afterEnforcing.message.includes('It ends when:'), afterEnforcing.message.slice(0, 120));
  check('and nothing else is touched',
    (await capabilityGate({ orgId: org.id, userId: caller.id, capability: 'CALL_PLACING' })).allowed);

  const second_ = await prisma.intervention.create({
    data: {
      orgId: org.id, callerId: caller.id, rung: 'CAPABILITY_PAUSE', capability: 'QUOTE_DRAFTING',
      attribution: 'OPERATOR', reason: 'Audit fixture: a second restriction.',
      evidence: [{ label: 'fixture', ref: 'Audit:1' }],
      restorationRule: RESTORATION.QUOTE_DRAFTING,
      producedBy: 'audit', ruleVersion: 'audit@1', state: 'PROPOSED', shadow: true,
    },
  });
  const clash = await enforceIntervention({
    orgId: org.id, interventionId: second_.id, actorId: owner.id, authority: 'owner',
  });
  check('a second live restriction on the same capability is refused with a reason',
    !clash.ok && /already restricted/.test(clash.message), clash.message.slice(0, 90));

  await refuses(
    'and the database refuses it too, whatever the library does',
    () => prisma.intervention.update({
      where: { id: second_.id },
      data: { state: 'ACTIVE', shadow: false, enforcedAt: new Date() },
    }),
    // Prisma reports a unique-index violation by the fields rather than by the
    // index name, so the assertion matches what it actually says.
    /Unique constraint failed.*callerId.*capability/s,
  );

  const liftedWithoutEvidence = await liftIntervention({
    orgId: org.id, interventionId: restriction.id, actorId: owner.id,
    because: 'They seem better.',
  });
  check('lifting a restriction on a feeling is refused',
    !liftedWithoutEvidence.ok && /restoration conditions/.test(liftedWithoutEvidence.message),
    liftedWithoutEvidence.message.slice(0, 90));

  const lifted = await liftIntervention({
    orgId: org.id, interventionId: restriction.id, actorId: owner.id,
    because: 'Three quotes drafted under review with no correction needed.',
    evidence: [{ label: 'the reviewed quotes', ref: 'RouteQuote:audit-fixture' }],
  });
  check('lifting on evidence is accepted', lifted.ok, lifted.message);

  const liftedRow = await prisma.intervention.findUniqueOrThrow({ where: { id: restriction.id } });
  check('and the evidence is on the record afterwards',
    Array.isArray(liftedRow.restorationEvidence) && (liftedRow.restorationEvidence as unknown[]).length > 0);
  check('and the capability comes back',
    (await capabilityGate({ orgId: org.id, userId: caller.id, capability: 'QUOTE_DRAFTING' })).allowed);
  check('and the person has no live restrictions left',
    (await activeRestrictions({ orgId: org.id, callerId: caller.id })).length === 0);

  // =========================================================================
  console.log('\n--- circuit breakers ----------------------------------------------');

  const readings = await readHealth({ orgId: org.id });
  check('every reading names its window and its floor', readings.length > 0
    && readings.every((r) => r.verdict.length > 20));
  check('a reading below the observation floor never trips',
    readings.filter((r) => r.observed < DEFAULT_CONFIG.managerRules.breakerMinimumObservations)
      .every((r) => !r.shouldOpen));

  // Force one open by hand: the sweep's own thresholds depend on ambient data.
  const breaker = await prisma.circuitBreaker.create({
    data: {
      orgId: org.id, capability: 'CALL_RECORDING', state: 'OPEN',
      openedAt: new Date(), openedBecause: 'Audit fixture: 9 of 10 captures produced nothing.',
      evidence: [{ label: 'fixture', ref: 'Audit:1' }],
      failureCount: 9, observedCount: 10, windowMinutes: 60,
      retryAt: new Date(Date.now() + 30 * 60_000),
      producedBy: 'audit', ruleVersion: 'audit@1',
    },
  });

  const stopped = await capabilityGate({ orgId: org.id, userId: caller.id, capability: 'CALL_RECORDING' });
  check('an open breaker stops the capability', !stopped.allowed && stopped.kind === 'system', stopped.kind);
  check('and the message says it is ours, in plain words',
    /not yours/.test(stopped.message) && /counts against you/.test(stopped.message),
    stopped.message.slice(0, 120));

  const covered = attribute({
    at: new Date(),
    callerId: caller.id,
    capability: 'CALL_RECORDING',
    breakers: [{
      id: breaker.id, capability: 'CALL_RECORDING', openedAt: breaker.openedAt,
      closedAt: null, openedBecause: breaker.openedBecause,
    }],
  });
  check('and work attempted during it is attributed to the system',
    covered.attribution === 'SYSTEM_FAULT', covered.attribution);

  await refuses(
    'a breaker cannot report more failures than observations',
    () => prisma.circuitBreaker.create({
      data: {
        orgId: org.id, capability: 'AUTONOMOUS_SENDING', state: 'CLOSED',
        failureCount: 12, observedCount: 3,
        producedBy: 'audit', ruleVersion: 'audit@1',
      },
    }),
    /failures_fit_inside_observations/,
  );

  await refuses(
    'and an open one cannot exist without saying why',
    () => prisma.circuitBreaker.create({
      data: {
        orgId: org.id, capability: 'AUTONOMOUS_SENDING', state: 'OPEN', openedAt: new Date(),
        producedBy: 'audit', ruleVersion: 'audit@1',
      },
    }),
    /open_states_its_reason/,
  );

  await refuses(
    'two open breakers on one capability cannot coexist',
    () => prisma.circuitBreaker.create({
      data: {
        orgId: org.id, capability: 'CALL_RECORDING', state: 'OPEN', openedAt: new Date(),
        openedBecause: 'Audit fixture: a second one.',
        producedBy: 'audit', ruleVersion: 'audit@1',
      },
    }),
    /Unique constraint failed.*orgId.*capability/s,
  );

  const closedWithoutReason = await closeBreaker({
    orgId: org.id, breakerId: breaker.id, actorId: owner.id, because: '   ',
  });
  check('closing a breaker without saying what was fixed is refused',
    !closedWithoutReason.ok, closedWithoutReason.message.slice(0, 90));

  const closed = await closeBreaker({
    orgId: org.id, breakerId: breaker.id, actorId: owner.id,
    because: 'Audit fixture: the provider credentials were rotated.',
  });
  check('and closing it with one works', closed.ok, closed.message);
  check('and the capability comes back',
    (await capabilityGate({ orgId: org.id, userId: caller.id, capability: 'CALL_RECORDING' })).allowed);

  const evaluated = await evaluateBreakers({ orgId: org.id });
  check('the evaluation runs and reports every capability it watches',
    evaluated.readings.length >= 3, `${evaluated.readings.length} readings`);

  // =========================================================================
  console.log('\n--- readiness ------------------------------------------------------');

  const readiness = await assessReadiness({ orgId: org.id, callerId: caller.id });
  check('a readiness check produces a state and a headline',
    Boolean(readiness.state) && readiness.headline.length > 20, readiness.state);
  check('every blocker says whose problem it is',
    readiness.blockers.every((b) => b.whose === 'ours' || b.whose === 'yours'));

  const { row } = await recordReadiness({ orgId: org.id, callerId: caller.id });
  const again = await recordReadiness({ orgId: org.id, callerId: caller.id });
  check('running it twice in a day updates one row rather than stacking two',
    row.id === again.row.id);

  // A system-blocked shift must say so in those words, not as a restriction.
  const outage = await prisma.circuitBreaker.create({
    data: {
      orgId: org.id, capability: 'CALL_PLACING', state: 'OPEN',
      openedAt: new Date(), openedBecause: 'Audit fixture: the dialer is down.',
      evidence: [{ label: 'fixture', ref: 'Audit:1' }],
      failureCount: 9, observedCount: 10, windowMinutes: 60,
      retryAt: new Date(Date.now() + 30 * 60_000),
      producedBy: 'audit', ruleVersion: 'audit@1',
    },
  });
  const blocked = await assessReadiness({ orgId: org.id, callerId: caller.id });
  check('an outage blocks the shift as the system\'s fault, not the caller\'s',
    blocked.state === 'BLOCKED_BY_SYSTEM', blocked.state);
  check('and the headline says so before anything else',
    /not your fault/.test(blocked.headline), blocked.headline.slice(0, 90));
  await prisma.circuitBreaker.update({
    where: { id: outage.id },
    data: { state: 'CLOSED', closedAt: new Date(), closedBecause: 'Audit fixture teardown.' },
  });

  await refuses(
    'a blocked shift cannot exist without naming a blocker',
    () => prisma.shiftReadiness.create({
      data: {
        orgId: org.id, callerId: owner.id,
        shiftDate: new Date(Date.UTC(2001, 0, 1)),
        state: 'BLOCKED_BY_SYSTEM', blockers: [],
        producedBy: 'audit', ruleVersion: 'audit@1',
      },
    }),
    /blocked_says_why/,
  );

  // =========================================================================
  console.log('\n--- the sweep and the brief ----------------------------------------');

  const swept = await sweepConsistency({ orgId: org.id, lookbackDays: 30 });
  check('the sweep runs and reports what it examined', swept.examined >= 0, JSON.stringify(swept.byKind));

  const sweptAgain = await sweepConsistency({ orgId: org.id, lookbackDays: 30 });
  check('running it twice opens nothing new', sweptAgain.opened === 0,
    `${sweptAgain.opened} opened, ${sweptAgain.alreadyOpen} already there`);

  const openCases = await prisma.consistencyCase.findMany({
    where: { orgId: org.id, state: 'OPEN' },
    select: { benignAlternatives: true, evidence: true, question: true, attribution: true },
  });
  check('every open case the sweep wrote offers an innocent explanation',
    openCases.every((c) => (c.benignAlternatives as unknown[]).length > 0), `${openCases.length} cases`);
  check('and none of them concludes anybody was at fault',
    openCases.every((c) => c.attribution !== 'OPERATOR'));

  const brief = await generateBrief({ orgId: org.id, period: 'DAILY' });
  check('the brief generates with a headline', brief.headline.length > 5, brief.headline.slice(0, 90));
  const withheld = brief.withheld as string[];
  check('and states what it could not conclude rather than leaving a blank',
    withheld.length > 0, withheld[0]?.slice(0, 110) ?? 'nothing withheld');

  const rerun = await generateBrief({ orgId: org.id, period: 'DAILY' });
  check('generating it twice refreshes one brief rather than making two', rerun.id === brief.id);

  // The chain's money stages must never read OK on an empty database.
  const { chainHealth } = await import('@/lib/health/chain');
  const chain = await chainHealth(org.id);
  const moneyStages = chain.stages.filter((s) => s.track === 'money');
  check('the four money stages are measured rather than reported as unbuilt',
    moneyStages.length === 4 && moneyStages.every((s) => s.status !== 'NOT_BUILT'),
    moneyStages.map((s) => `${s.key}=${s.status}`).join(' '));

  const collected = await prisma.dealPayment.aggregate({
    where: { orgId: org.id, direction: 'INBOUND', settledAt: { not: null } },
    _sum: { amount: true },
  });
  const anyMoney = Number(collected._sum.amount ?? 0) > 0;
  check('the chain reports itself flowing only when money has actually arrived',
    chain.flowing === false || anyMoney,
    `flowing=${chain.flowing}, collected=${Number(collected._sum.amount ?? 0)}`);

  // =========================================================================
  await setOrgConfig(org.id, { managerRules: DEFAULT_CONFIG.managerRules }, owner.id);
  const restored = await getOrgConfig(org.id);
  check('the audit puts the operating rules back as it found them',
    restored.managerRules.minAttemptsForCoaching === DEFAULT_CONFIG.managerRules.minAttemptsForCoaching);

  await cleanUp(org.id);

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  if (failures > 0) process.exitCode = 1;
}

async function cleanUp(orgId: string) {
  await prisma.intervention.deleteMany({ where: { orgId } });
  await prisma.consistencyCase.deleteMany({ where: { orgId } });
  await prisma.circuitBreaker.deleteMany({ where: { orgId } });
  await prisma.shiftReadiness.deleteMany({ where: { orgId } });
  await prisma.managerBrief.deleteMany({ where: { orgId } });
  await prisma.workIncident.deleteMany({ where: { orgId, detail: { contains: 'Audit fixture' } } });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
