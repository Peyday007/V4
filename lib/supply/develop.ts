import type { SignalCategory } from '@prisma/client';
import { prisma } from '@/lib/db';
import { audit } from '@/lib/audit';
import { MINI_PATHS } from '@/lib/universe/registry';
import type { DemandDevelopmentBrief, SupplyPosition } from './reverse';

/**
 * Turning a demand-development brief into work somebody can actually do.
 *
 * A brief on a screen is a thought. What makes reverse search worth having is
 * that the thought becomes a campaign with a budget, a kill condition and a
 * list of calls — the same object the demand-first engine produces, so it is
 * measured by the same rule and dies by the same rule.
 *
 * Three things are deliberately *not* filled in, and the draft is unstartable
 * until a person fills them:
 *
 *   Supporting evidence. The engine has none. It knows a provider can do
 *   something; it knows nothing about whether anybody wants it, and inventing an
 *   observation to make a draft look complete is the single worst thing this
 *   file could do.
 *
 *   The budget. Committing money is an act of authority, not a side effect of
 *   pressing a button.
 *
 *   The testing cost. How many hours this is worth is the owner's judgement
 *   about their own week.
 *
 * What *is* filled in is everything the engine genuinely knows: the provider,
 * the geography, the buyer types, the questions, and the falsifier — written as
 * a real kill condition rather than as a paragraph nobody re-reads.
 */

/** The commercial model, mapped onto the campaign's own route vocabulary. */
const ROUTE_BY_MODEL: Record<string, SignalCategory> = {
  brokerage: 'BROKERAGE',
  capacity_arbitrage: 'BROKERAGE',
  distribution: 'DISTRIBUTION',
  subcontracting: 'SUBCONTRACTING',
  direct_service: 'DIRECT_SERVICE',
  supplier_development: 'SUPPLIER_DEVELOPMENT',
  provider_recruitment: 'PROVIDER_RECRUITMENT',
};

export type DevelopmentDraft = {
  campaignId: string;
  name: string;
  /** Tasks written, each one a call somebody makes. */
  tasks: number;
  /** What a person still has to supply before this can be started. */
  youMustAdd: string[];
};

export async function campaignFromBrief(params: {
  orgId: string;
  userId: string;
  position: SupplyPosition;
  brief: DemandDevelopmentBrief;
  dataMode?: 'PRODUCTION' | 'TEST';
}): Promise<DevelopmentDraft> {
  const path = MINI_PATHS.find((p) => p.key === params.brief.miniPathKey);
  if (!path) throw new Error(`No commercial path called ${params.brief.miniPathKey}.`);

  const { position, brief } = params;
  const name = `${brief.label} — from ${position.name}`;

  const campaign = await prisma.campaign.create({
    data: {
      orgId: params.orgId,
      dataMode: params.dataMode ?? 'PRODUCTION',
      name: name.slice(0, 120),
      state: 'DRAFT',
      thesis:
        `${position.name} can deliver ${brief.label.toLowerCase()} in ${brief.geography}, and that capacity has `
        + `been verified rather than taken from a listing. The claim being tested is that `
        + `${brief.buyerTypes.slice(0, 3).join(', ').toLowerCase()} in ${brief.geography} have this problem often `
        + `enough to buy a solution to it, and would buy it from an intermediary. Nobody has said so yet — this `
        + `campaign exists to find out, not to sell against a demand we have established.`,
      whyNow:
        `The supply side exists now and verified capacity does not stay verified. `
        + `${brief.becauseThisProvider}`,
      route: ROUTE_BY_MODEL[path.model] ?? 'GENERAL',
      targetStates: position.stateCode ? [position.stateCode.toUpperCase()] : [],
      targetCities: position.location ? [position.location.split(',')[0].trim()] : [],
      buyerProfile:
        `${brief.buyerTypes.join(', ')} in ${brief.geography}. Types rather than names: nobody on this list has `
        + `been looked at, and a caller should expect to disqualify most of them.`,
      providerProfile:
        `${position.name}, with ${position.verifiedCapabilities.map((c) => c.name).join(', ')} verified. `
        + `The campaign is built on this one provider; a second would make it a market rather than a favour.`,
      requiredCapability: position.verifiedCapabilities[0]?.name.slice(0, 120) ?? path.label.slice(0, 120),
      // Left at zero for the owner to set. A generated number here would be an
      // invented budget for somebody else's week.
      testingHours: 0,
      testingCostCents: 0,
      testingCostBasis:
        'Not yet costed. How many hours this is worth is a judgement about your own week, and the engine has '
        + 'no business making it.',
      budgetCents: null,
      createdById: params.userId,
      evidence: {
        create: [
          {
            orgId: params.orgId,
            kind: 'SUPPORTING',
            claim:
              `${position.name}'s capability was verified by a person, not read off a directory: `
              + `${position.verifiedCapabilities.map((c) => `${c.name} (${c.how})`).join('; ')}`,
            // The one thing here that is genuinely established.
            evidenceClass: 'CONFIRMED_BY_PERSON',
            sourceUrl: null,
            observedAt: position.verifiedCapabilities[0]?.verifiedAt ?? null,
            createdById: params.userId,
          },
          {
            orgId: params.orgId,
            kind: 'CONTRARY',
            claim:
              'No buyer has said they need this. The entire demand side of this campaign is a hypothesis about '
              + 'a category, and the engine has produced no event, no trigger and no named buyer.',
            evidenceClass: 'UNKNOWN',
            sourceUrl: null,
            createdById: params.userId,
          },
          {
            orgId: params.orgId,
            kind: 'CONTRARY',
            claim: brief.wouldFalsifyIt,
            evidenceClass: 'UNKNOWN',
            sourceUrl: null,
            createdById: params.userId,
          },
        ],
      },
      channels: {
        // Calling only. Everything else costs money, and money is authorised
        // rather than defaulted.
        create: [
          {
            orgId: params.orgId,
            kind: 'CALLING',
            enabled: true,
            budgetCents: null,
            outcomeMetric: 'REQUIREMENTS_CONFIRMED',
          },
        ],
      },
      conditions: {
        create: [
          {
            orgId: params.orgId,
            kind: 'KILL',
            // The falsifier, as an actual threshold rather than a paragraph.
            // A market-development campaign with no arithmetic kill condition
            // runs until somebody loses interest, which is not the same as
            // being wrong.
            metric: 'REQUIREMENTS_CONFIRMED',
            comparator: 'AT_OR_BELOW',
            threshold: 0,
            afterDays: 21,
            statement:
              'Three weeks of calling with nobody confirming a requirement means the demand is not there, or '
              + 'not there at this price. Stop rather than widening the target.',
          },
          {
            orgId: params.orgId,
            kind: 'EXPAND',
            metric: 'REQUIREMENTS_CONFIRMED',
            comparator: 'AT_OR_ABOVE',
            threshold: 3,
            afterDays: 21,
            statement:
              'Three buyers stating the same requirement is a market rather than a coincidence. Find a second '
              + 'provider before taking on more of it.',
          },
        ],
      },
    },
    select: { id: true },
  });

  // The questions, as work. One row per call, so the campaign's progress is
  // countable and its silence is visible.
  await prisma.campaignTask.createMany({
    data: brief.toEstablish.map((question) => ({
      orgId: params.orgId,
      campaignId: campaign.id,
      dataMode: params.dataMode ?? 'PRODUCTION',
      kind: 'BUYER_RESEARCH',
      intent: question.slice(0, 1000),
      status: 'PENDING',
      companyId: null,
    })),
  });

  await prisma.campaignTask.create({
    data: {
      orgId: params.orgId,
      campaignId: campaign.id,
      dataMode: params.dataMode ?? 'PRODUCTION',
      kind: 'SUPPLY_CONFIRMATION',
      intent:
        `Ring ${position.name} and confirm they still have this capacity and would quote against it. Verified `
        + 'three months ago is not verified now, and a campaign built on stale capacity wastes the buyer calls '
        + 'as well as the provider one.',
      status: 'PENDING',
      companyId: position.companyId,
    },
  });

  await audit({
    orgId: params.orgId,
    userId: params.userId,
    action: 'campaign.drafted_from_supply',
    entityType: 'Campaign',
    entityId: campaign.id,
    metadata: { provider: position.name, miniPath: brief.miniPathKey },
  });

  return {
    campaignId: campaign.id,
    name,
    tasks: brief.toEstablish.length + 1,
    youMustAdd: [
      'One observation that supports the demand side, with a source and a date. The engine has none, and a '
      + 'campaign resting only on the fact that a provider exists is a campaign about a provider.',
      'How many hours this is worth, and what that costs. Both are judgements about your own week.',
      'A budget, if any channel other than calling is to be used.',
    ],
  };
}
