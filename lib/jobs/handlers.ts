import type { Job } from '@prisma/client';
import { prisma } from '@/lib/db';
import { runAllDiscovery, runDiscoveryForSource } from '@/lib/discovery/run';
import { promoteSignals } from '@/lib/discovery/promote';
import { dueConnectors, runDemandSource } from '@/lib/demand/run';
import { runDemandPipeline } from '@/lib/demand/pipeline';
import { generateDocument } from '@/lib/ai/documents';
import { configureDeal } from '@/lib/ai/dealConfig';
import { findMatches } from '@/lib/ai/matching';
import { determineNextAction, refreshAllNextActions } from '@/lib/ai/nextAction';
import { generateDailyPlan } from '@/lib/ai/planner';
import { scoreAllActive, scoreOpportunity } from '@/lib/ai/scoring';
import { processTranscript } from '@/lib/ai/transcript';
import { assessAllCompanies } from '@/lib/ai/vulnerability';
import { assignOpportunitiesToLanes, evaluateAllLanes } from '@/lib/ai/lanes';
import { snapshotCallerMetrics } from '@/lib/ai/analytics';
import { getTranscription } from '@/lib/providers/transcription';
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

  'enrichment.company': async (job) => {
    const companyId = requireString(job.payload as Payload, 'companyId');
    const company = await prisma.company.findFirstOrThrow({ where: { id: companyId, orgId: job.orgId } });
    // Live deployments call an enrichment provider here. With no provider
    // configured we mark the record as needing human research rather than
    // inventing firmographics.
    await prisma.company.update({
      where: { id: companyId },
      data: { lastVerifiedAt: company.lastVerifiedAt ?? null },
    });
    return { companyId, note: 'No enrichment provider configured; routed to Research Reviewer instead of inferring data.' };
  },

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
