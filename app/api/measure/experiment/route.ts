import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requirePermission, requireUser } from '@/lib/auth/session';
import { handleRouteError, json, rateLimit } from '@/lib/api';
import { startExperiment, concludeExperiment, readOut } from '@/lib/measure/experiments';
import { audit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/**
 * Experiments.
 *
 * Everything here needs `admin.config`: an experiment changes how work is done
 * for a share of every caller's queue, which is a configuration decision rather
 * than a deal one. Authentication happens before the body is parsed, so an
 * anonymous request cannot learn the route exists from a validation error.
 */
const Create = z.object({
  action: z.literal('create'),
  name: z.string().min(1).max(200),
  hypothesis: z.string().min(1).max(4000),
  subject: z.enum(['CALL_SCRIPT', 'PROOF_STEP', 'OUTREACH_COPY', 'QUEUE_ORDER', 'AUDIENCE_ORDER']),
  primaryOutcome: z.enum([
    'CONTACTED', 'RESPONDED', 'RELEVANT_PERSON', 'NEED_CONFIRMED', 'QUALIFIED_CONVERSATION',
    'QUOTE_REQUESTED', 'QUOTED', 'PROOF_STEP_ACCEPTED', 'WON', 'COMPLETED', 'PAID',
  ]),
  guardrails: z.array(z.enum([
    'CONTACTED', 'RESPONDED', 'RELEVANT_PERSON', 'NEED_CONFIRMED', 'QUALIFIED_CONVERSATION',
    'QUOTE_REQUESTED', 'QUOTED', 'PROOF_STEP_ACCEPTED', 'WON', 'COMPLETED', 'PAID', 'LOST',
  ])).max(6).default([]),
  minimumSamplePerArm: z.number().int().min(1).max(100_000).default(30),
  tiers: z.array(z.enum(['ACTIVE_DEMAND', 'STRONG_TRIGGER', 'PREDICTED_NEED', 'DIRECTORY_PROSPECT'])).default([]),
  routes: z.array(z.enum(['BROKERAGE', 'SUBCONTRACTING', 'DISTRIBUTION', 'GENERAL'])).default([]),
  markets: z.array(z.string().max(80)).max(20).default([]),
  arms: z.array(z.object({
    key: z.string().min(1).max(40),
    label: z.string().min(1).max(200),
    isControl: z.boolean().default(false),
    weight: z.number().min(0).max(1),
    processVersionId: z.string().optional(),
  })).min(2).max(4),
});

const Start = z.object({ action: z.literal('start'), experimentId: z.string().min(1) });

const Conclude = z.object({
  action: z.literal('conclude'),
  experimentId: z.string().min(1),
  conclusion: z.string().min(1).max(4000),
  winningArmId: z.string().optional(),
  halted: z.boolean().optional(),
});

const Read = z.object({ action: z.literal('read'), experimentId: z.string().min(1) });

const Schema = z.discriminatedUnion('action', [Create, Start, Conclude, Read]);

export async function POST(request: Request) {
  try {
    await requireUser();
    const body = Schema.parse(await request.json());
    const user = await requirePermission('admin.config');
    await rateLimit(`measure.experiment:${user.id}`, 60, 60_000);

    if (body.action === 'create') {
      const { action, arms, ...rest } = body;
      void action;
      const created = await prisma.experiment.create({
        data: {
          ...rest,
          orgId: user.orgId,
          createdById: user.id,
          arms: { create: arms },
        },
        include: { arms: true },
      });
      await audit({
        orgId: user.orgId, userId: user.id, action: 'experiment.created',
        entityType: 'Experiment', entityId: created.id,
        metadata: { subject: body.subject, primaryOutcome: body.primaryOutcome },
      });
      return json({ ok: true, experiment: created });
    }

    if (body.action === 'start') {
      const result = await startExperiment({
        orgId: user.orgId, experimentId: body.experimentId, actorId: user.id,
      });
      if (!result.ok) return json({ error: result.message, detail: result.detail }, 409);
      await audit({
        orgId: user.orgId, userId: user.id, action: 'experiment.started',
        entityType: 'Experiment', entityId: body.experimentId,
      });
      return json({ ok: true, experiment: result.experiment });
    }

    if (body.action === 'conclude') {
      const result = await concludeExperiment({
        orgId: user.orgId,
        experimentId: body.experimentId,
        conclusion: body.conclusion,
        winningArmId: body.winningArmId,
        halted: body.halted,
      });
      // 409 rather than 400: the request is well-formed and the evidence does
      // not support it, which is a different thing and a different fix.
      if (!result.ok) return json({ error: result.message }, 409);
      await audit({
        orgId: user.orgId, userId: user.id,
        action: body.halted ? 'experiment.halted' : 'experiment.concluded',
        entityType: 'Experiment', entityId: body.experimentId,
      });
      return json({ ok: true });
    }

    const readout = await readOut({ orgId: user.orgId, experimentId: body.experimentId });
    if (!readout) return json({ error: 'That experiment is not on this account.' }, 404);
    return json({ ok: true, readout });
  } catch (error) {
    return handleRouteError(error);
  }
}
