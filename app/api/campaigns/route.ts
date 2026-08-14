import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { handleRouteError, json } from '@/lib/api';
import { campaignReadiness } from '@/lib/campaign/model';
import { campaignOutcome } from '@/lib/campaign/outcomes';
import { configuredCoverage } from '@/lib/portfolio/concentration';

export const dynamic = 'force-dynamic';

/**
 * Commercial campaigns.
 *
 * A campaign is created as a draft and stays one until somebody with authority
 * starts it. Nothing here can put a campaign into RUNNING — that is a separate
 * endpoint with a separate permission, because drafting a thesis and committing
 * money to it are different acts and were being conflated by every product
 * that ever had a "save and launch" button.
 */
export async function GET() {
  try {
    const user = await requirePermission('campaign.read');
    const campaigns = await prisma.campaign.findMany({
      where: { orgId: user.orgId },
      orderBy: [{ state: 'asc' }, { createdAt: 'desc' }],
      include: { evidence: true, channels: true, conditions: true },
    });

    const reachable = configuredCoverage().reachable;

    return json({
      campaigns: await Promise.all(
        campaigns.map(async (c) => ({
          id: c.id,
          name: c.name,
          state: c.state,
          route: c.route,
          thesis: c.thesis,
          whyNow: c.whyNow,
          targetStates: c.targetStates,
          requiredCapability: c.requiredCapability,
          dataMode: c.dataMode,
          supporting: c.evidence.filter((e) => e.kind === 'SUPPORTING').length,
          contrary: c.evidence.filter((e) => e.kind === 'CONTRARY').length,
          // Outcomes through to collected gross profit, on every row, because
          // a campaign list that shows activity and not money is how a
          // campaign that quotes well and collects nothing survives.
          outcome: await campaignOutcome({ orgId: user.orgId, campaignId: c.id }),
          readiness: campaignReadiness({
            draft: {
              name: c.name, thesis: c.thesis, whyNow: c.whyNow, route: c.route,
              targetStates: c.targetStates, buyerProfile: c.buyerProfile,
              providerProfile: c.providerProfile, requiredCapability: c.requiredCapability,
              testingHours: c.testingHours, testingCostCents: c.testingCostCents,
              testingCostBasis: c.testingCostBasis, budgetCents: c.budgetCents,
              authorityGrantedById: c.authorityGrantedById,
              evidence: c.evidence.map((e) => ({
                kind: e.kind as 'SUPPORTING' | 'CONTRARY',
                claim: e.claim, evidenceClass: e.evidenceClass, sourceUrl: e.sourceUrl,
              })),
              channels: c.channels.map((ch) => ({
                kind: ch.kind, enabled: ch.enabled, budgetCents: ch.budgetCents,
                authorisedById: ch.authorisedById, outcomeMetric: ch.outcomeMetric,
              })),
              conditions: c.conditions.map((cd) => ({
                kind: cd.kind, metric: cd.metric, comparator: cd.comparator,
                threshold: cd.threshold, afterDays: cd.afterDays, statement: cd.statement,
              })),
            },
            reachableStates: reachable,
          }),
        })),
      ),
      reachableStates: reachable,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

const Evidence = z.object({
  kind: z.enum(['SUPPORTING', 'CONTRARY']),
  claim: z.string().min(5).max(600),
  evidenceClass: z.enum([
    'CONFIRMED_BY_PERSON', 'EXTERNALLY_OBSERVED', 'CALCULATED_FROM_CONFIRMED_INPUTS', 'INFERRED', 'UNKNOWN',
  ]),
  sourceUrl: z.string().url().nullable().optional(),
  observedAt: z.string().datetime().nullable().optional(),
});

const Channel = z.object({
  kind: z.enum(['CALLING', 'EMAIL', 'ADVERTISING', 'DIRECT_MAIL', 'PARTNER_REFERRAL', 'VENDOR_REGISTRATION']),
  enabled: z.boolean(),
  budgetCents: z.number().int().min(0).nullable().optional(),
  outcomeMetric: z.enum([
    'ROUTES_GENERATED', 'CONVERSATIONS_HELD', 'REQUIREMENTS_CONFIRMED', 'PROVIDERS_VERIFIED',
    'QUOTES_SENT', 'COMMITMENTS_WON', 'COLLECTED_GROSS_PROFIT', 'SPEND', 'DAYS_RUNNING', 'RETURN_ON_SPEND',
  ]).nullable().optional(),
});

const Condition = z.object({
  kind: z.enum(['KILL', 'EXPAND']),
  metric: z.enum([
    'ROUTES_GENERATED', 'CONVERSATIONS_HELD', 'REQUIREMENTS_CONFIRMED', 'PROVIDERS_VERIFIED',
    'QUOTES_SENT', 'COMMITMENTS_WON', 'COLLECTED_GROSS_PROFIT', 'SPEND', 'DAYS_RUNNING', 'RETURN_ON_SPEND',
  ]),
  comparator: z.enum(['BELOW', 'AT_OR_BELOW', 'ABOVE', 'AT_OR_ABOVE']),
  threshold: z.number(),
  afterDays: z.number().int().min(0).default(0),
  statement: z.string().min(10).max(300),
});

const Body = z.object({
  name: z.string().min(3).max(120),
  thesis: z.string().min(1).max(4000),
  whyNow: z.string().min(1).max(2000),
  route: z.enum([
    'SUBCONTRACTING', 'BROKERAGE', 'DISTRIBUTION', 'DIRECT_SERVICE',
    'SUPPLIER_DEVELOPMENT', 'PROVIDER_RECRUITMENT', 'GENERAL',
  ]),
  targetStates: z.array(z.string().length(2)).default([]),
  targetCities: z.array(z.string().max(80)).default([]),
  buyerProfile: z.string().min(1).max(2000),
  providerProfile: z.string().min(1).max(2000),
  requiredCapability: z.string().min(1).max(120),
  testingHours: z.number().min(0),
  testingCostCents: z.number().int().min(0).default(0),
  testingCostBasis: z.string().min(1).max(1000),
  budgetCents: z.number().int().min(0).nullable().default(null),
  dataMode: z.enum(['PRODUCTION', 'TEST']).default('PRODUCTION'),
  evidence: z.array(Evidence).default([]),
  channels: z.array(Channel).default([]),
  conditions: z.array(Condition).default([]),
});

export async function POST(request: Request) {
  try {
    const user = await requirePermission('campaign.write');
    const parsed = Body.safeParse(await request.json());
    if (!parsed.success) {
      return json({ error: 'That campaign is missing required fields.', detail: parsed.error.flatten() }, 400);
    }
    const input = parsed.data;

    // Created as a draft, always. Readiness is returned so the writer sees
    // every refusal at once rather than one per save.
    const created = await prisma.campaign.create({
      data: {
        orgId: user.orgId,
        dataMode: input.dataMode,
        name: input.name,
        state: 'DRAFT',
        thesis: input.thesis,
        whyNow: input.whyNow,
        route: input.route,
        targetStates: input.targetStates.map((s) => s.toUpperCase()),
        targetCities: input.targetCities,
        buyerProfile: input.buyerProfile,
        providerProfile: input.providerProfile,
        requiredCapability: input.requiredCapability,
        testingHours: input.testingHours,
        testingCostCents: input.testingCostCents,
        testingCostBasis: input.testingCostBasis,
        budgetCents: input.budgetCents,
        createdById: user.id,
        evidence: {
          create: input.evidence.map((e) => ({
            orgId: user.orgId,
            kind: e.kind,
            claim: e.claim,
            evidenceClass: e.evidenceClass,
            sourceUrl: e.sourceUrl ?? null,
            observedAt: e.observedAt ? new Date(e.observedAt) : null,
            createdById: user.id,
          })),
        },
        channels: {
          create: input.channels.map((c) => ({
            orgId: user.orgId,
            kind: c.kind,
            enabled: c.enabled,
            budgetCents: c.budgetCents ?? null,
            outcomeMetric: c.outcomeMetric ?? null,
          })),
        },
        conditions: {
          create: input.conditions.map((c) => ({
            orgId: user.orgId,
            kind: c.kind,
            metric: c.metric,
            comparator: c.comparator,
            threshold: c.threshold,
            afterDays: c.afterDays,
            statement: c.statement,
          })),
        },
      },
      include: { evidence: true, channels: true, conditions: true },
    });

    const readiness = campaignReadiness({
      draft: {
        ...input,
        authorityGrantedById: null,
        evidence: input.evidence.map((e) => ({ ...e, sourceUrl: e.sourceUrl ?? null })),
        channels: input.channels.map((c) => ({
          ...c,
          budgetCents: c.budgetCents ?? null,
          authorisedById: null,
          outcomeMetric: c.outcomeMetric ?? null,
        })),
      },
      reachableStates: configuredCoverage().reachable,
    });

    return json({ id: created.id, state: created.state, readiness }, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
