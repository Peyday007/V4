/**
 * A sandbox record cannot reach the outside world.
 *
 * The isolation triggers keep test and production data from mixing inside the
 * database. This audit tests the other boundary — the one where a row becomes
 * something that cannot be undone: a phone ringing, an email arriving, a
 * directory being billed, a deal room landing in somebody's inbox, a number
 * moving in the reports the business is steered by.
 *
 * Every check calls the real entry point with real sandbox fixtures. Nothing is
 * mocked and no provider is stubbed for the occasion: if the guard were removed
 * from any of these functions, the corresponding check would place the call or
 * send the message rather than fail. That is the point — a test that proves the
 * guard by asserting the guard exists proves nothing.
 *
 * Each refusal is checked twice: that it threw, and that it left nothing
 * behind. "Blocked but recorded as sent" is its own kind of lie.
 *
 *   npx tsx scripts/sandboxBoundaryAudit.ts
 */

import { prisma } from '@/lib/db';
import { ensureSandbox, resetSandbox } from '@/lib/caller/sandbox';
import { SandboxBlockedError } from '@/lib/safety/outbound';
import { startCall } from '@/lib/calling';
import { startSession } from '@/lib/calls/recording';
import { sendSms, sendEmailMessage } from '@/lib/messaging';
import { resolveCompanyContact } from '@/lib/enrichment/resolve';
import { sendRoomEmail } from '@/lib/room/email';
import { recordStage, funnelReport } from '@/lib/measure/funnel';
import { sourceScorecards, funnelTotals } from '@/lib/demand/performance';

let failures = 0;
let checks = 0;

function check(label: string, passed: boolean, detail = '') {
  checks += 1;
  if (!passed) failures += 1;
  console.log(`${passed ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
}

/** How many checks a complete run produces. */
const EXPECTED_CHECKS = 27;

let skipped = 0;
/**
 * A check that could not be run, and why.
 *
 * Neither a pass nor a failure. Reporting an untested condition as green is how
 * a suite stops meaning anything; failing on it would be worse here, because
 * the reason is usually that the production world is legitimately empty.
 */
function skip(label: string, reason: string) {
  skipped += 1;
  console.log(` skip  ${label} — ${reason}`);
}

/**
 * Runs an outbound action that must be refused, and reports how.
 *
 * A thrown `SandboxBlockedError` is the pass. Any other error is a fail even
 * though nothing was sent, because "it happened to break first" is not a
 * boundary — the next refactor moves the break and the action goes out.
 */
async function refused(action: () => Promise<unknown>): Promise<
  { refused: true; message: string } | { refused: false; how: string }
> {
  try {
    await action();
    return { refused: false, how: 'it completed' };
  } catch (error) {
    if (error instanceof SandboxBlockedError) return { refused: true, message: error.message };
    return { refused: false, how: `a different error: ${String(error).slice(0, 140)}` };
  }
}

/**
 * The counters, scoped to the production world.
 *
 * Deliberately not "everything in the org". A previous crashed run can leave
 * sandbox rows behind, and the reset at the end of this audit removes them —
 * so an unscoped before/after pair reports the cleanup as a production change
 * and fails an audit that actually passed.
 */
const productionMessages = (orgId: string) =>
  prisma.message.count({ where: { orgId, company: { dataMode: 'PRODUCTION' } } });
const productionCalls = (orgId: string) =>
  prisma.call.count({ where: { orgId, assignment: { company: { dataMode: 'PRODUCTION' } } } });
const productionSessions = (orgId: string) =>
  prisma.callSession.count({ where: { orgId, route: { dataMode: 'PRODUCTION' } } });

async function counts(orgId: string) {
  const [messages, calls, sessions, provenance, outcomes] = await Promise.all([
    productionMessages(orgId),
    productionCalls(orgId),
    productionSessions(orgId),
    prisma.contactProvenance.count({ where: { orgId, company: { dataMode: 'PRODUCTION' } } }),
    prisma.demandOutcome.count({ where: { orgId, dataMode: 'PRODUCTION' } }),
  ]);
  return { messages, calls, sessions, provenance, outcomes };
}

async function main() {
  const org = await prisma.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  const owner = await prisma.user.findFirstOrThrow({
    where: { orgId: org.id, email: 'owner@dealdispatch.test' }, select: { id: true },
  });

  await ensureSandbox({ orgId: org.id, actorId: owner.id });

  const route = await prisma.routeHypothesis.findFirstOrThrow({
    where: { orgId: org.id, dataMode: 'TEST' },
    select: { id: true, companyId: true },
  });
  const contact = await prisma.contact.findFirstOrThrow({
    where: { companyId: route.companyId }, select: { id: true },
  });

  // A sandbox contact is given the things each sender needs, so nothing is
  // refused for the boring reason that a field was empty. The guard has to be
  // what stops it.
  await prisma.contact.update({
    where: { id: contact.id },
    data: {
      email: 'sandbox-practice@dealdispatch.test',
      mobile: '+1 555 0100',
      consentToEmail: true,
      consentToCall: true,
    },
  });

  const before = await counts(org.id);

  // -----------------------------------------------------------------------
  console.log('--- telephony ------------------------------------------------');
  const assignment = await prisma.callAssignment.create({
    data: {
      orgId: org.id,
      companyId: route.companyId,
      contactId: contact.id,
      assignedToId: owner.id,
      status: 'PENDING',
      callType: 'BUYER_QUALIFICATION',
      reason: 'Sandbox boundary audit: proving the dialler refuses practice records.',
      objective: 'Establish that no call is placed.',
      desiredCommitment: 'None. This assignment exists only to be refused.',
    },
    select: { id: true },
  });

  const dialled = await refused(() => startCall({
    orgId: org.id, assignmentId: assignment.id, callerId: owner.id,
  }));
  check('the dialler refuses a sandbox company', dialled.refused,
    dialled.refused ? dialled.message.slice(0, 80) : dialled.how);
  check('and no call was recorded as placed',
    (await productionCalls(org.id)) === before.calls);

  const recorded = await refused(() => startSession({
    orgId: org.id, routeId: route.id, callerId: owner.id,
    provider: 'twilio', intendedCapture: 'PROVIDER_RECORDING',
  }));
  check('provider-recorded calling refuses a sandbox opportunity', recorded.refused,
    recorded.refused ? recorded.message.slice(0, 80) : recorded.how);
  check('and no call session exists to transcribe',
    (await productionSessions(org.id)) === before.sessions);

  // The manual path stays open on purpose: an owner practising the workspace
  // needs a session row, and a manual session places no call and records no
  // audio. Asserting it here stops a later "tighten everything" change from
  // closing the sandbox by accident.
  const manual = await startSession({
    orgId: org.id, routeId: route.id, callerId: owner.id, intendedCapture: 'NONE',
  });
  check('but a manual practice session is still allowed', manual !== null,
    manual ? 'session opened, nothing captured' : 'refused');
  if (manual) {
    check('and it captures nothing', manual.mayRecord === false || manual.session.captureMode === 'NONE',
      `${manual.session.captureMode}`);
    await prisma.callSession.delete({ where: { id: manual.session.id } });
  }

  // -----------------------------------------------------------------------
  console.log('\n--- messaging ------------------------------------------------');
  const texted = await refused(() => sendSms({
    orgId: org.id, contactId: contact.id, body: 'Practice message.', purpose: 'BUYER_QUALIFICATION',
  }));
  check('SMS refuses a contact at a sandbox company', texted.refused,
    texted.refused ? texted.message.slice(0, 80) : texted.how);

  const emailed = await refused(() => sendEmailMessage({
    orgId: org.id, contactId: contact.id, subject: 'Practice', body: 'Practice.', purpose: 'BUYER_QUALIFICATION',
  }));
  check('email refuses a contact at a sandbox company', emailed.refused,
    emailed.refused ? emailed.message.slice(0, 80) : emailed.how);

  check('and nothing was recorded as sent',
    (await productionMessages(org.id)) === before.messages,
    `${before.messages} messages before and after`);

  // -----------------------------------------------------------------------
  console.log('\n--- paid external lookups ------------------------------------');
  const looked = await refused(() => resolveCompanyContact({
    orgId: org.id, companyId: route.companyId, force: true,
  }));
  check('contact resolution refuses a sandbox company', looked.refused,
    looked.refused ? looked.message.slice(0, 80) : looked.how);
  check('and no provenance was written from a lookup that never happened',
    (await prisma.contactProvenance.count({ where: { orgId: org.id, company: { dataMode: 'PRODUCTION' } } })) === before.provenance);

  // -----------------------------------------------------------------------
  console.log('\n--- deal room delivery ---------------------------------------');
  // A run that failed partway leaves its room behind, and the point of this
  // audit is the boundary rather than the fixture bookkeeping.
  await prisma.dealRoomEvent.deleteMany({ where: { room: { routeId: route.id } } });
  await prisma.dealRoom.deleteMany({ where: { routeId: route.id } });
  const room = await prisma.dealRoom.create({
    data: {
      orgId: org.id,
      routeId: route.id,
      token: `sandbox-boundary-audit-token-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      state: 'SENT',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
    select: { id: true },
  });
  const delivered = await refused(() => sendRoomEmail({
    orgId: org.id, roomId: room.id, contactId: contact.id,
  }));
  check('a deal room for a sandbox opportunity is not delivered', delivered.refused,
    delivered.refused ? delivered.message.slice(0, 80) : delivered.how);
  check('and no room email was recorded',
    (await productionMessages(org.id)) === before.messages);

  // -----------------------------------------------------------------------
  console.log('\n--- production measurement -----------------------------------');
  // Not a refusal: a practice call still records its own milestones, because a
  // sandbox that silently drops writes stops resembling the product. The rule
  // is that those milestones live in the test world and no report can see them.
  const wrote = await recordStage({ routeId: route.id, stage: 'CONTACTED' });
  check('a practice milestone is recorded rather than dropped', wrote === true);

  const stored = await prisma.demandOutcome.findFirst({
    where: { routeId: route.id, stage: 'CONTACTED' },
    select: { dataMode: true },
  });
  check('and it is stored as test work', stored?.dataMode === 'TEST', `${stored?.dataMode}`);

  check('production milestone count did not move',
    (await prisma.demandOutcome.count({ where: { orgId: org.id, dataMode: 'PRODUCTION' } })) === before.outcomes,
    `${before.outcomes} before and after`);

  const report = await funnelReport({ orgId: org.id });
  const contacted = report.rows.find((s) => s.stage === 'CONTACTED');
  const testContacted = await prisma.demandOutcome.count({
    where: { orgId: org.id, dataMode: 'TEST', stage: 'CONTACTED' },
  });
  const productionContacted = await prisma.demandOutcome.count({
    where: { orgId: org.id, dataMode: 'PRODUCTION', stage: 'CONTACTED' },
  });
  check('the funnel report counts only production milestones',
    (contacted?.count ?? 0) === productionContacted && testContacted > 0,
    `report ${contacted?.count ?? 0}, production ${productionContacted}, test ${testContacted}`);

  const totals = await funnelTotals(org.id);
  check('the funnel totals agree',
    (totals.find((t) => t.stage === 'CONTACTED')?.count ?? 0) === productionContacted);

  const scorecards = await sourceScorecards(org.id);
  check('no scorecard is attributed to the sandbox connector',
    !scorecards.some((s) => s.connector === 'sandbox'),
    scorecards.map((s) => s.connector).join(', ') || 'none');

  // The database refuses a mismatch outright, so a future write path that
  // forgets to pass the mode cannot quietly land practice in the numbers.
  let triggerHeld = false;
  let triggerMessage = '';
  try {
    // fixture-connector-guard: expected-to-fail — this create is the assertion.
    await prisma.demandOutcome.create({
      data: {
        orgId: org.id, connector: 'sandbox', routeId: route.id,
        stage: 'RESPONDED', dataMode: 'PRODUCTION',
      },
    });
  } catch (error) {
    triggerHeld = /outcome_data_mode/.test(String(error));
    triggerMessage = String(error).replace(/\s+/g, ' ').slice(0, 90);
  }
  check('the database refuses a production milestone on a test opportunity',
    triggerHeld, triggerMessage || 'the insert was accepted');

  // -----------------------------------------------------------------------
  console.log('\n--- the same paths still work for real records ---------------');
  // The boundary is only worth having if it is not simply "everything is
  // refused". A production route must still be able to record a milestone.
  const realRoute = await prisma.routeHypothesis.findFirst({
    where: { orgId: org.id, dataMode: 'PRODUCTION' },
    select: { id: true },
  });
  if (!realRoute) {
    // Nothing to check against, and inventing a production route to satisfy a
    // test would put fixture demand back into the world this audit exists to
    // keep clean.
    skip('a production milestone still records',
      'no production route exists yet — the demand engine has not collected any');
  } else {
    const existing = await prisma.demandOutcome.findFirst({
      where: { routeId: realRoute.id, stage: 'CONTACTED' }, select: { id: true },
    });
    const realWrote = await recordStage({ routeId: realRoute.id, stage: 'CONTACTED' });
    const realStored = await prisma.demandOutcome.findFirst({
      where: { routeId: realRoute.id, stage: 'CONTACTED' }, select: { id: true, dataMode: true },
    });
    check('a production milestone still records', realWrote && realStored?.dataMode === 'PRODUCTION',
      `${realStored?.dataMode}`);
    if (!existing && realStored) {
      await prisma.demandOutcome.delete({ where: { id: realStored.id } });
    }
  }

  // -----------------------------------------------------------------------
  console.log('\n--- cleaning up ----------------------------------------------');
  await prisma.dealRoom.delete({ where: { id: room.id } });
  await prisma.callAssignment.delete({ where: { id: assignment.id } });
  await resetSandbox({ orgId: org.id, actorId: owner.id });

  const after = await counts(org.id);
  for (const key of ['messages', 'calls', 'sessions', 'provenance', 'outcomes'] as const) {
    check(`production ${key} unchanged by the whole run`, before[key] === after[key],
      `${before[key]} then ${after[key]}`);
  }
  check('the reset took the practice milestones with it',
    (await prisma.demandOutcome.count({ where: { orgId: org.id, dataMode: 'TEST' } })) === 0);
}

main()
  .then(() => {
    if (checks + skipped !== EXPECTED_CHECKS) {
      console.log(` FAIL  the audit accounted for ${checks + skipped} checks, not the ${EXPECTED_CHECKS} a complete run produces.`);
      failures += 1;
    }
    console.log(`\n${checks - failures}/${checks} checks passed${skipped > 0 ? `, ${skipped} skipped` : ''}.`);
    process.exit(failures > 0 ? 1 : 0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
