import type { Job } from '@prisma/client';
import { prisma } from '@/lib/db';
import { runAllDiscovery, runDiscoveryForSource } from '@/lib/discovery/run';
import { promoteSignals } from '@/lib/discovery/promote';
import { dueConnectors, runDemandSource } from '@/lib/demand/run';
import { replenishFloor } from '@/lib/caller/replenish';
import { evaluateCampaignConditions } from '@/lib/campaign/service';
import { generateCampaignWork, runCampaignTasks } from '@/lib/campaign/execute';
import { prisma as db } from '@/lib/db';
import { runDemandPipeline } from '@/lib/demand/pipeline';
import { generateDocument } from '@/lib/ai/documents';
import { configureDeal } from '@/lib/ai/dealConfig';
import { transcribeSession, analyseSession } from '@/lib/calls/analysis';
import { openReviewIfNeeded } from '@/lib/calls/review';
import { expireRecordings } from '@/lib/calls/recording';
import { findMatches } from '@/lib/ai/matching';
import { determineNextAction, refreshAllNextActions } from '@/lib/ai/nextAction';
import { generateDailyPlan } from '@/lib/ai/planner';
import { scoreAllActive, scoreOpportunity } from '@/lib/ai/scoring';
import { processTranscript } from '@/lib/ai/transcript';
import { assessAllCompanies } from '@/lib/ai/vulnerability';
import { assignOpportunitiesToLanes, evaluateAllLanes } from '@/lib/ai/lanes';
import { snapshotCallerMetrics } from '@/lib/ai/analytics';
import { getTranscription } from '@/lib/providers/transcription';
import { resolveCompanyContact } from '@/lib/enrichment/resolve';
import { sweepContactResolution } from '@/lib/enrichment/schedule';
import { resolveSupply } from '@/lib/enrichment/supply';
import { sweepConsistency } from '@/lib/manager/cases';
import { generateBrief } from '@/lib/manager/brief';
import { pullProjections, pushChanges } from '@/lib/brain/sync';
import { enqueue } from './queue';

export type JobHandler = (job: Job) => Promise<unknown>;

type Payload = Record<string, unknown>;

function requireString(payload: Payload, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !value) throw new Error(`Job payload missing "${key}"`);
  return value;
}

/**
 * Job handlers. Each one is idempotent enough to be retried: they re-derive
 * state from the database rather than assuming what a previous attempt did.
 */
export const HANDLERS: Record<string, JobHandler> = {
  /*
   * The Brain connector.
   *
   * Both halves are bounded to one page and both re-enqueue themselves when
   * there is more, rather than looping inside one invocation: a backfill of
   * every opportunity this site holds is however many pages it takes, and a
   * platform function timeout in the middle of one costs a page rather than
   * the run. Nothing here is a full-table scan — the push walks an indexed
   * `updatedAt` range from a stored cursor and the pull asks Brain's own delta
   * feed for what has changed since a watermark.
   *
   * With no Brain configured both return immediately having done nothing, so
   * an unconnected site pays one cheap call per tick and writes no failures.
   */
  'brain.push': async (job) => {
    const result = await pushChanges({ orgId: job.orgId });
    if (result.connected && result.more && !result.error) {
      await enqueue({ orgId: job.orgId, kind: 'brain.push', priority: 45 });
    }
    return result;
  },

  'brain.pull': async (job) => {
    const result = await pullProjections({ orgId: job.orgId });
    if (result.connected && result.more && !result.error) {
      await enqueue({ orgId: job.orgId, kind: 'brain.pull', priority: 45 });
    }
    return result;
  },

  'discovery.run_source': async (job) => {
    const payload = job.payload as Payload;
    const result = await runDiscoveryForSource({
      orgId: job.orgId,
      dataSourceId: requireString(payload, 'dataSourceId'),
      maxRecords: typeof payload.maxRecords === 'number' ? payload.maxRecords : undefined,
      configOverride: (payload.configOverride as Payload) ?? undefined,
    });
    if (result.signalsCreated > 0) {
      await enqueue({ orgId: job.orgId, kind: 'discovery.promote_signals', priority: 40 });
    }
    return result;
  },

  'discovery.run_all': async (job) => {
    const results = await runAllDiscovery(job.orgId);
    await enqueue({ orgId: job.orgId, kind: 'discovery.promote_signals', priority: 40 });
    return { sources: results.length, results };
  },

  /**
   * Polls the demand sources whose interval has elapsed.
   *
   * Only the due ones: each connector declares how often its source actually
   * changes, and a licence portal republished daily gains nothing from being
   * asked every fifteen minutes. The pipeline is queued separately so that one
   * slow source cannot stop the others' events being routed.
   */
  'demand.poll_sources': async (job) => {
    const due = await dueConnectors(job.orgId);
    const results = [];
    for (const connector of due) {
      results.push(await runDemandSource({ orgId: job.orgId, connectorKey: connector.key }));
    }
    if (results.some((r) => r.eventsCreated > 0 || r.eventsUpdated > 0)) {
      await enqueue({ orgId: job.orgId, kind: 'demand.run_pipeline', priority: 30 });
    }
    return { polled: due.length, results };
  },

  /**
   * Verifies, resolves and routes. Also the revalidation pass: it re-checks
   * every live event's window, so a solicitation whose deadline passed
   * overnight stops being work without anybody touching it.
   */
  /**
   * Tops up any caller who is about to run out of work.
   *
   * On the tick rather than the daily sweep, because running dry is a
   * mid-morning problem and a daily top-up would leave somebody idle until
   * tomorrow. It assigns nothing that a person assigning by hand would have
   * been refused — same eligibility query, same calling window, same
   * one-route-per-organisation rule — and when there is nothing callable it
   * leaves the floor short and says so.
   */
  'callers.replenish': async (job) => {
    const [production, practice] = await Promise.all([
      replenishFloor({ orgId: job.orgId, actorId: job.orgId, dataMode: 'PRODUCTION' }),
      replenishFloor({ orgId: job.orgId, actorId: job.orgId, dataMode: 'TEST' }),
    ]);
    return {
      production: { toppedUp: production.toppedUp, itemsAdded: production.itemsAdded, stillShort: production.stillShort.length },
      practice: { toppedUp: practice.toppedUp, itemsAdded: practice.itemsAdded, stillShort: practice.stillShort.length },
    };
  },

  /**
   * Campaigns, on the tick.
   *
   * Three things in order, and the order is the point. Conditions are
   * evaluated first, so a campaign that should have stopped does not generate
   * another morning of work on its way out. Then the survivors generate the
   * research they are owed. Then the tasks that need no external contact are
   * run.
   */
  'campaigns.tick': async (job) => {
    const evaluated = await evaluateCampaignConditions({ orgId: job.orgId, actorId: job.orgId });

    const running = await db.campaign.findMany({
      where: { orgId: job.orgId, state: { in: ['RUNNING', 'EXPANDED'] } },
      select: { id: true },
    });

    let generated = 0;
    let ran = 0;
    for (const campaign of running) {
      const report = await generateCampaignWork({
        orgId: job.orgId, campaignId: campaign.id, actorId: job.orgId,
      });
      generated += report.total;
      const results = await runCampaignTasks({ orgId: job.orgId, campaignId: campaign.id, limit: 25 });
      ran += results.length;
    }

    return {
      evaluated: evaluated.length,
      fired: evaluated.filter((e) => e.fired.length > 0).map((e) => ({ name: e.name, fired: e.fired, newState: e.newState })),
      running: running.length,
      tasksGenerated: generated,
      tasksRun: ran,
    };
  },

  'demand.run_pipeline': async (job) => {
    return runDemandPipeline({ orgId: job.orgId });
  },

  'discovery.promote_signals': async (job) => {
    const result = await promoteSignals({ orgId: job.orgId });
    // Each new opportunity immediately gets scored, matched and given an action.
    for (const opportunityId of result.opportunityIds) {
      await enqueue({
        orgId: job.orgId,
        kind: 'scoring.run',
        payload: { opportunityId },
        priority: 50,
        idempotencyKey: `score:${opportunityId}:${Date.now()}`,
      });
    }
    return result;
  },

  'scoring.run': async (job) => {
    const opportunityId = requireString(job.payload as Payload, 'opportunityId');
    const score = await scoreOpportunity(opportunityId);
    await enqueue({ orgId: job.orgId, kind: 'matching.run', payload: { opportunityId }, priority: 55 });
    return { compositeScore: score.compositeScore, expectedValue: score.expectedValue };
  },

  'scoring.run_all': async (job) => ({ scored: await scoreAllActive(job.orgId) }),

  'matching.run': async (job) => {
    const opportunityId = requireString(job.payload as Payload, 'opportunityId');
    const matches = await findMatches(opportunityId);
    await enqueue({ orgId: job.orgId, kind: 'deal.configure', payload: { opportunityId }, priority: 60 });
    return { candidates: matches.length, best: matches[0]?.companyName ?? null };
  },

  'deal.configure': async (job) => {
    const opportunityId = requireString(job.payload as Payload, 'opportunityId');
    const result = await configureDeal(opportunityId);
    await enqueue({ orgId: job.orgId, kind: 'next_action.determine', payload: { opportunityId }, priority: 65 });
    return { isConfigurable: result.isConfigurable, missingTerms: result.missingTerms };
  },

  'next_action.determine': async (job) => {
    const opportunityId = requireString(job.payload as Payload, 'opportunityId');
    const plan = await determineNextAction(opportunityId);
    return { type: plan.type, targetStage: plan.targetStage };
  },

  'next_action.refresh_all': async (job) => ({ refreshed: await refreshAllNextActions(job.orgId) }),

  'transcription.process': async (job) => {
    const payload = job.payload as Payload;
    const callId = requireString(payload, 'callId');
    const call = await prisma.call.findFirstOrThrow({
      where: { id: callId, orgId: job.orgId },
      include: { recording: true, transcript: true },
    });
    if (call.transcript) return { transcriptId: call.transcript.id, skipped: 'already transcribed' };

    const provider = getTranscription();
    const transcription = await provider.transcribe({
      audioRef: call.recording?.storageKey ?? `call:${callId}`,
      syntheticText: typeof payload.syntheticText === 'string' ? payload.syntheticText : undefined,
    });

    const transcript = await prisma.transcript.create({
      data: {
        callId,
        provider: transcription.provider,
        language: transcription.language,
        text: transcription.text,
        segments: transcription.segments as object,
      },
    });

    await enqueue({
      orgId: job.orgId,
      kind: 'transcript.analyze',
      payload: { transcriptId: transcript.id },
      priority: 30,
      idempotencyKey: `analyze:${transcript.id}`,
    });
    return { transcriptId: transcript.id, segments: transcription.segments.length };
  },

  'transcript.analyze': async (job) => {
    const transcriptId = requireString(job.payload as Payload, 'transcriptId');
    return processTranscript(transcriptId);
  },

  'planning.daily': async (job) => {
    await scoreAllActive(job.orgId);
    await refreshAllNextActions(job.orgId);
    await assessAllCompanies(job.orgId);
    await assignOpportunitiesToLanes(job.orgId);
    await evaluateAllLanes(job.orgId);
    const plan = await generateDailyPlan(job.orgId);
    return { priorities: plan.priorities.length, narrative: plan.narrative.slice(0, 300) };
  },

  'vulnerability.assess_all': async (job) => ({ assessed: await assessAllCompanies(job.orgId) }),

  'lanes.evaluate_all': async (job) => {
    const assigned = await assignOpportunitiesToLanes(job.orgId);
    const evaluated = await evaluateAllLanes(job.orgId);
    return { assigned, evaluated };
  },

  // --- the live call path ---------------------------------------------------
  //
  // Transcription and analysis are separate jobs rather than one, because they
  // fail for different reasons and at different costs. A transcription that
  // failed should be retried; an analysis that failed should not re-run the
  // transcription to find out.
  'call.transcribe': async (job) => {
    const sessionId = String((job.payload as { sessionId?: string }).sessionId ?? '');
    if (!sessionId) return { skipped: 'no session id' };

    const result = await transcribeSession({ orgId: job.orgId, sessionId });
    if (!result.ok) return { transcribed: false, reason: result.message };

    // Analysis is queued only once there is something to analyse.
    await enqueue({
      orgId: job.orgId,
      kind: 'call.analyse',
      payload: { sessionId },
      priority: 60,
      idempotencyKey: `call.analyse:${sessionId}`,
      skipIfCompleted: true,
    });
    return { transcribed: true };
  },

  'call.analyse': async (job) => {
    const sessionId = String((job.payload as { sessionId?: string }).sessionId ?? '');
    if (!sessionId) return { skipped: 'no session id' };

    const session = await prisma.callSession.findFirst({
      where: { id: sessionId, orgId: job.orgId },
      select: { attempt: { select: { disposition: true } } },
    });

    const analysis = await analyseSession({
      orgId: job.orgId,
      sessionId,
      callerDisposition: session?.attempt?.disposition ?? null,
    });
    if (!analysis.ok) return { analysed: false, reason: analysis.message };

    const review = await openReviewIfNeeded({
      orgId: job.orgId,
      sessionId,
      callerDisposition: session?.attempt?.disposition ?? null,
    });

    return {
      analysed: true,
      insights: analysis.insights,
      autoApplied: analysis.autoApplied,
      reviewOpened: review.opened,
      reviewReason: review.reason,
    };
  },

  'call.expire_recordings': async (job) => {
    // No storage remover passed: deleting the object is the storage layer's
    // job and is wired where a real bucket exists. Without one the sweep still
    // clears the key and marks the row expired, which is the part that stops a
    // screen offering audio nobody should still have.
    return expireRecordings({ orgId: job.orgId });
  },

  'manager.sweep': async (job) => {
    // Reads records against each other and opens questions. It cannot conclude
    // anything about a person: everything it writes is either a question or,
    // where our own logs explain it, a case already closed against the system.
    return sweepConsistency({ orgId: job.orgId });
  },

  'manager.brief': async (job) => {
    const period = (job.payload as { period?: 'DAILY' | 'WEEKLY' })?.period ?? 'DAILY';
    const brief = await generateBrief({ orgId: job.orgId, period });
    return { briefId: brief.id, headline: brief.headline };
  },

  'analytics.snapshot': async (job) => {
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 86_400_000);
    return { callers: await snapshotCallerMetrics(job.orgId, start, end) };
  },

  'followup.generate': async (job) => {
    // Anything sitting past its due date gets a fresh decision rather than
    // silently ageing on the board.
    const overdue = await prisma.nextAction.findMany({
      where: { orgId: job.orgId, isCurrent: true, completedAt: null, dueDate: { lt: new Date() } },
      select: { opportunityId: true },
      take: 200,
    });
    for (const action of overdue) {
      await enqueue({
        orgId: job.orgId,
        kind: 'next_action.determine',
        payload: { opportunityId: action.opportunityId },
        priority: 70,
      });
    }
    return { requeued: overdue.length };
  },

  'document.generate': async (job) => {
    const payload = job.payload as Payload;
    return generateDocument({
      orgId: job.orgId,
      opportunityId: requireString(payload, 'opportunityId'),
      kind: requireString(payload, 'kind') as never,
    });
  },

  /**
   * The recurring contact-resolution worker.
   *
   * Schedules any organisation with live demand that is not yet in the
   * workflow, then works the next batch in priority order. Running it twice
   * concurrently is safe — claims are conditional updates — and running it when
   * there is nothing to do costs two queries.
   *
   * The same function the immediate trigger and the backfill call. There is no
   * separate backfill code path, because one that behaved differently would
   * eventually enrich the same organisation twice.
   */
  'enrichment.resolve_contacts': async (job) => {
    const payload = job.payload as Payload;
    const limit = typeof payload.limit === 'number' ? payload.limit : undefined;
    const outcome = await sweepContactResolution({ orgId: job.orgId, limit });

    // More waiting than one batch could take. Queue the next one rather than
    // holding the worker, so a backlog drains across ticks instead of timing
    // out a single invocation.
    if (outcome.remaining > 0 && outcome.attempted > 0) {
      await enqueue({
        orgId: job.orgId,
        kind: 'enrichment.resolve_contacts',
        priority: 35,
        idempotencyKey: `enrichment.resolve_contacts:continue`,
      });
    }
    return outcome;
  },

  /**
   * Re-checks supply against the current provider catalogue.
   *
   * Separate from the demand pipeline because the two change for different
   * reasons: an event arriving is not the same as a provider being recruited,
   * and a route blocked on supply should stop being blocked the day somebody
   * who can do the work is added.
   */
  'supply.match_routes': async (job) => resolveSupply({ orgId: job.orgId }),

  'notification.send': async (job) => {
    const payload = job.payload as Payload;
    await prisma.notification.create({
      data: {
        orgId: job.orgId,
        userId: requireString(payload, 'userId'),
        kind: String(payload.kind ?? 'system'),
        title: String(payload.title ?? 'Notification'),
        body: String(payload.body ?? ''),
        link: typeof payload.link === 'string' ? payload.link : null,
      },
    });
    return { sent: true };
  },
};

export function getHandler(kind: string): JobHandler | undefined {
  return HANDLERS[kind];
}
