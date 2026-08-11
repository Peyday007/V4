import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { handleRouteError, json, rateLimit } from '@/lib/api';
import { contentHash } from '@/lib/discovery/connector';
import { runDemandSource } from '@/lib/demand/run';
import { runDemandPipeline } from '@/lib/demand/pipeline';

export const dynamic = 'force-dynamic';

/**
 * Recording an event a person learned about.
 *
 * An inbound enquiry, a forwarded email, a tip from a provider, a unit being
 * fitted out next door. This is the highest-quality demand the system can
 * hold — somebody actually asked, or somebody actually saw it — and it needs
 * no external API, which is why the engine does not depend on one.
 *
 * The entry point is deliberately thin. It stages the record as ordinary
 * evidence and then runs the same connector, the same verification and the
 * same routing as everything else. A hand-entered event gets no shortcut past
 * the rules: without a date it cannot reach Tier A any more than a scraped
 * record can.
 */

const IntakeSchema = z.object({
  organisation: z.string().min(2).max(200),
  /** The date the thing happens or happened, per whoever told us. */
  eventDate: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  type: z
    .enum([
      'INBOUND_REQUEST',
      'ACTIVE_RFQ',
      'ACTIVE_RFP',
      'VENDOR_REQUEST',
      'SUBCONTRACTOR_REQUEST',
      'FACILITY_OPENING',
      'NEW_LOCATION',
      'PROPERTY_TURNOVER',
      'RENOVATION_OR_CONSTRUCTION',
      'EXPANSION',
      'CONTRACT_EXPIRATION',
      'VENDOR_FAILURE_OR_COMPLAINT',
      'STAFFING_OR_CAPACITY_GAP',
    ])
    .default('INBOUND_REQUEST'),
  summary: z.string().min(5).max(4000),
  headline: z.string().max(300).optional(),
  deadline: z.string().optional(),
  address: z.string().max(300).optional(),
  city: z.string().max(120).optional(),
  state: z.string().max(2).optional(),
  postalCode: z.string().max(10).optional(),
  contactName: z.string().max(160).optional(),
  incumbent: z.string().max(200).optional(),
  capabilities: z.array(z.string().max(120)).max(10).optional(),
  sourceUrl: z.string().url().optional(),
});

export async function POST(request: Request) {
  try {
    const user = await requirePermission('discovery.run');

    if (!rateLimit(`demand-intake:${user.orgId}`, 60, 60_000)) {
      return json({ error: 'Too many intake submissions. Slow down.' }, 429);
    }

    const parsed = IntakeSchema.safeParse(await request.json());
    if (!parsed.success) {
      return json({ error: 'Invalid intake record', details: parsed.error.flatten() }, 400);
    }
    const input = parsed.data;

    // Same-record submissions collapse rather than stacking. Two people
    // reporting one opening is corroboration, not two openings.
    const hash = contentHash([input.organisation, input.eventDate, input.type, input.summary.slice(0, 200)]);

    const existing = await prisma.sourceEvidence.findFirst({
      where: { orgId: user.orgId, contentHash: hash },
      select: { id: true },
    });
    if (existing) {
      return json({ staged: false, reason: 'This event has already been recorded.', evidenceId: existing.id });
    }

    const evidence = await prisma.sourceEvidence.create({
      data: {
        orgId: user.orgId,
        sourceType: 'MANUAL_ENTRY',
        sourceUrl: input.sourceUrl ?? null,
        title: input.headline ?? `${input.organisation} — ${input.type.toLowerCase().replace(/_/g, ' ')}`,
        excerpt: input.summary,
        rawPayload: input as unknown as object,
        // Stated by a person who was there. Not an inference.
        status: 'CONFIRMED',
        confidence: 0.95,
        origin: 'MANUAL',
        createdByProcess: 'demand.intake',
        contentHash: hash,
      },
    });

    // Run it through immediately: an inbound request is the one kind of demand
    // where waiting for the next poll costs the opportunity.
    const run = await runDemandSource({ orgId: user.orgId, connectorKey: 'inbound_intake', maxRecords: 50 });
    const pipeline = await runDemandPipeline({ orgId: user.orgId, userId: user.id });

    return json({
      staged: true,
      evidenceId: evidence.id,
      ingest: { created: run.eventsCreated, updated: run.eventsUpdated, warnings: run.warnings },
      routes: {
        created: pipeline.routes.routesCreated,
        byRoute: pipeline.routes.byRoute,
        byTier: pipeline.routes.byTier,
        byFriction: pipeline.routes.byFriction,
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
