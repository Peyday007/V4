import { z } from 'zod';
import { requirePermission } from '@/lib/auth/session';
import { handleRouteError, json, rateLimit } from '@/lib/api';
import { addCandidate, advanceCandidate, syncCandidatesFromMatching } from '@/lib/deal/provider';
import { audit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/** Adding a provider candidate, and moving one along the ladder. */
const Add = z.object({
  action: z.literal('add'),
  routeId: z.string().min(1),
  providerCompanyId: z.string().min(1),
  matchBasis: z.string().min(1).max(2000),
});

const Sync = z.object({
  action: z.literal('sync'),
  routeId: z.string().min(1),
});

const Advance = z.object({
  action: z.literal('advance'),
  candidateId: z.string().min(1),
  to: z.enum([
    'CONTACTED', 'CAPABILITY_VERIFIED', 'AVAILABILITY_VERIFIED',
    'COST_RECEIVED', 'SELECTED', 'COMMITTED', 'REJECTED', 'WITHDRAWN',
  ]),
  reason: z.string().min(1).max(2000),
  capabilityNotes: z.string().max(2000).optional(),
  geographyNotes: z.string().max(2000).optional(),
  capabilityEvidence: z.string().max(2000).optional(),
  credentialsEvidence: z.string().max(2000).optional(),
  availableFrom: z.string().optional(),
  availableUntil: z.string().optional(),
  capacityNotes: z.string().max(2000).optional(),
  costAmount: z.number().min(0).optional(),
  costUnit: z.string().max(60).optional(),
  costBasis: z.string().max(1000).optional(),
  costTerms: z.string().max(200).optional(),
  costExpiresAt: z.string().optional(),
  promiseText: z.string().max(2000).optional(),
  promiseDueAt: z.string().optional(),
  rejectedReason: z.string().max(2000).optional(),
});

const Schema = z.discriminatedUnion('action', [Add, Sync, Advance]);

export async function POST(request: Request) {
  try {
    const user = await requirePermission('deal.write');
    await rateLimit(`deal.provider:${user.id}`, 120, 60_000);
    const body = Schema.parse(await request.json());

    if (body.action === 'add') {
      const candidate = await addCandidate({
        orgId: user.orgId,
        routeId: body.routeId,
        providerCompanyId: body.providerCompanyId,
        matchBasis: body.matchBasis,
        actorId: user.id,
        actorType: 'user',
      });
      await audit({
        orgId: user.orgId, userId: user.id, action: 'deal.provider.added',
        entityType: 'ProviderCandidate', entityId: candidate.id,
      });
      return json({ ok: true, candidate });
    }

    if (body.action === 'sync') {
      const result = await syncCandidatesFromMatching({ orgId: user.orgId, routeId: body.routeId });
      return json({ ok: true, ...result });
    }

    const { action, candidateId, to, reason, availableFrom, availableUntil, costExpiresAt, promiseDueAt, ...fields } = body;
    void action;

    const result = await advanceCandidate({
      orgId: user.orgId,
      candidateId,
      to,
      reason,
      fields: {
        ...fields,
        availableFrom: availableFrom ? new Date(availableFrom) : undefined,
        availableUntil: availableUntil ? new Date(availableUntil) : undefined,
        costExpiresAt: costExpiresAt ? new Date(costExpiresAt) : undefined,
        promiseDueAt: promiseDueAt ? new Date(promiseDueAt) : undefined,
      },
      actorId: user.id,
      actorType: 'user',
    });

    if (!result.ok) {
      // 409 rather than 400: the request is well-formed, the record is not in a
      // state that allows it. The operator gets the specific missing evidence
      // rather than "invalid".
      return json({ error: result.message, kind: result.kind, missing: result.missing }, result.kind === 'not_found' ? 404 : 409);
    }

    await audit({
      orgId: user.orgId, userId: user.id, action: `deal.provider.${to.toLowerCase()}`,
      entityType: 'ProviderCandidate', entityId: result.candidate.id,
    });
    return json({ ok: true, candidate: result.candidate });
  } catch (error) {
    return handleRouteError(error);
  }
}
