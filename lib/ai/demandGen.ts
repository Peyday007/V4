import type { OpportunityType } from '@prisma/client';
import { num0, prisma } from '@/lib/db';
import { getOrgConfig, type OrgConfig } from '@/lib/config';
import { clamp01, round } from './decisions';

export const DEMAND_GEN_VERSION = 'demand_gen@1';

/**
 * Advertising recommendations.
 *
 * The governing rule: never buy demand you cannot fulfil. An ad that generates
 * a lead nobody can service costs money twice — once for the click, and again
 * in the reputation damage of quoting work you then cannot deliver. So every
 * recommendation is gated on confirmed fulfillment capacity in that specific
 * territory, and states exactly what has to happen before a dollar is spent.
 */

export type AdPlatform =
  | 'GOOGLE_SEARCH'
  | 'GOOGLE_LOCAL_SERVICES'
  | 'META'
  | 'LINKEDIN'
  | 'TRADE_PUBLICATION'
  | 'DIRECT_OUTREACH';

export type Verdict = 'RUN' | 'PREPARE_FIRST' | 'DO_NOT_RUN';

export type Prerequisite = {
  action: string;
  why: string;
  /** Where in the app this gets done. */
  link?: string;
  done: boolean;
};

export type AdRecommendation = {
  key: string;
  service: string;
  territory: string;
  opportunityType: OpportunityType;
  platform: AdPlatform;
  platformReason: string;
  secondaryPlatform?: AdPlatform;
  secondaryReason?: string;
  verdict: Verdict;
  verdictReason: string;
  priority: number;
  demand: {
    buyerNeeds: number;
    signals: number;
    wonDeals: number;
    evidence: string[];
  };
  fulfillment: {
    readyProviders: number;
    unverifiedProviders: number;
    providersNeeded: number;
    gaps: string[];
  };
  economics: {
    grossProfitPerDeal: number | null;
    basis: string;
    leadToDealRate: number;
    maxCostPerLead: number | null;
    monthlyDealCapacity: number;
    suggestedMonthlyBudget: number | null;
    budgetReason: string;
  };
  prerequisites: Prerequisite[];
  keywords: string[];
};

/**
 * How buyers of each kind of work actually arrive.
 *
 * The split that matters is whether the buyer searches (they have a problem
 * now, and intent-based platforms reach them at that moment) or has to be
 * found (a small, known universe, where interruption advertising wastes money
 * and direct contact does not).
 */
const PLATFORM_RULES: Array<{
  match: RegExp;
  platform: AdPlatform;
  reason: string;
  secondary?: AdPlatform;
  secondaryReason?: string;
  keywords: (service: string, place: string) => string[];
}> = [
  {
    match: /emergency|restoration|water damage|24.?hour|urgent/i,
    platform: 'GOOGLE_SEARCH',
    reason:
      'Emergency work is searched for at the moment it happens, and the first company to answer usually wins it. Run call-only ads, bid aggressively, and keep them on 24/7 — an emergency ad that runs business hours only is buying leads you cannot answer.',
    secondary: 'GOOGLE_LOCAL_SERVICES',
    secondaryReason: 'Pay-per-lead rather than per-click, and the Google Guaranteed badge matters most when someone is picking in a hurry.',
    keywords: (service, place) => [
      `emergency ${service.toLowerCase()} ${place}`,
      `24 hour ${service.toLowerCase()} ${place}`,
      `same day ${service.toLowerCase()} near me`,
    ],
  },
  {
    match: /clean|janitorial|custodial|porter|maintenance|landscap|security|pest/i,
    platform: 'GOOGLE_SEARCH',
    reason:
      'Facility and property managers search for these when their current vendor disappoints them. That is a narrow, high-intent window — search ads catch it, and nothing else does.',
    secondary: 'GOOGLE_LOCAL_SERVICES',
    secondaryReason:
      'Charges per lead instead of per click, so an unfilled budget costs nothing. Requires license and insurance verification before it will run — worth checking eligibility early.',
    keywords: (service, place) => [
      `commercial ${service.toLowerCase()} ${place}`,
      `${service.toLowerCase()} companies ${place}`,
      `office ${service.toLowerCase()} services ${place}`,
      `commercial ${service.toLowerCase()} contract ${place}`,
    ],
  },
  {
    match: /electrical|mechanical|hvac|plumbing|drywall|flooring|sitework|grading|concrete|roofing/i,
    platform: 'DIRECT_OUTREACH',
    reason:
      'The buyers here are general contractors — a small, nameable universe. Ads reach mostly homeowners and tyre-kickers, which is the wrong traffic at trade prices. Public award notices tell you exactly who just won work and needs subs; calling them costs nothing and converts far better.',
    secondary: 'LINKEDIN',
    secondaryReason: 'Useful only to stay visible with preconstruction and estimating staff you are already calling. Treat it as support, not lead generation.',
    keywords: (service, place) => [`${service.toLowerCase()} subcontractor ${place}`, `commercial ${service.toLowerCase()} contractor ${place}`],
  },
  {
    match: /aggregate|stone|material|lumber|steel|concrete supply|gravel/i,
    platform: 'GOOGLE_SEARCH',
    reason:
      'Buyers search by specification and quantity when they need a source. Low volume, high value per click — bid on exact gradations and product codes, not broad terms.',
    secondary: 'TRADE_PUBLICATION',
    secondaryReason: 'Regional contractor associations and bid boards reach the same buyers with less competition on price.',
    keywords: (service, place) => [
      `${service.toLowerCase()} delivered ${place}`,
      `${service.toLowerCase()} supplier ${place}`,
      `bulk ${service.toLowerCase()} ${place}`,
    ],
  },
  {
    match: /suppl(y|ies)|consumable|packaging|safety|industrial|paper|chemical/i,
    platform: 'GOOGLE_SEARCH',
    reason:
      'Recurring supply is comparison-shopped by purchasing staff. Search catches the switch moment; the real money is in the reorder, so optimise for accounts opened rather than first-order value.',
    secondary: 'META',
    secondaryReason: 'Cheap retargeting only — bring back people who priced you and did not buy. Poor as a cold channel here.',
    keywords: (service, place) => [
      `${service.toLowerCase()} distributor ${place}`,
      `bulk ${service.toLowerCase()} supplier ${place}`,
      `commercial ${service.toLowerCase()} delivery ${place}`,
    ],
  },
  {
    match: /it |technology|cabling|network|field service|smart hands/i,
    platform: 'LINKEDIN',
    reason:
      'The buyer is a named role at a managed service provider, not someone typing into Google. Targeting by job title reaches them; keyword targeting does not.',
    secondary: 'GOOGLE_SEARCH',
    secondaryReason: 'A small exact-match campaign on "field service partner" style terms catches the few who do search.',
    keywords: (service, place) => [`${service.toLowerCase()} partner ${place}`, `onsite ${service.toLowerCase()} ${place}`],
  },
];

const DEFAULT_RULE = {
  platform: 'GOOGLE_SEARCH' as AdPlatform,
  reason:
    'No specific channel pattern matched this service, so start with search: it is the only channel where you pay to meet demand that already exists rather than trying to create it. Learn from the search terms report before spending anywhere else.',
  keywords: (service: string, place: string) => [`${service.toLowerCase()} ${place}`, `commercial ${service.toLowerCase()} ${place}`],
};

export function choosePlatform(service: string) {
  const rule = PLATFORM_RULES.find((r) => r.match.test(service));
  if (!rule) return { ...DEFAULT_RULE, secondary: undefined, secondaryReason: undefined };
  return {
    platform: rule.platform,
    reason: rule.reason,
    secondary: rule.secondary,
    secondaryReason: rule.secondaryReason,
    keywords: rule.keywords,
  };
}

/**
 * Decides whether spending is justified yet.
 *
 * Pure so it can be tested directly, and so the reasoning is inspectable
 * rather than buried in a query.
 */
export function decideVerdict(input: {
  readyProviders: number;
  unverifiedProviders: number;
  demandEvidence: number;
  grossProfitPerDeal: number | null;
  minimumProviders: number;
}): { verdict: Verdict; reason: string; providersNeeded: number } {
  const { readyProviders, unverifiedProviders, demandEvidence, grossProfitPerDeal, minimumProviders } = input;
  const providersNeeded = Math.max(0, minimumProviders - readyProviders);

  if (readyProviders === 0 && unverifiedProviders === 0) {
    return {
      verdict: 'DO_NOT_RUN',
      reason:
        'Nobody in the graph can deliver this here. Every lead this generates would be one you have to turn down, which costs the click and the reputation. Source providers first — that is a phone problem, not an advertising problem.',
      providersNeeded: minimumProviders,
    };
  }

  if (readyProviders < minimumProviders) {
    return {
      verdict: 'PREPARE_FIRST',
      reason:
        `Only ${readyProviders} of the ${minimumProviders} providers needed are confirmed for this territory` +
        (unverifiedProviders > 0 ? `, with ${unverifiedProviders} more claiming coverage but unverified` : '') +
        '. One provider is not coverage — if they are busy or decline, the lead is dead. Confirm capacity before spending.',
      providersNeeded,
    };
  }

  if (grossProfitPerDeal !== null && grossProfitPerDeal < 500) {
    return {
      verdict: 'DO_NOT_RUN',
      reason:
        `Modelled gross profit is only $${grossProfitPerDeal.toFixed(0)} per deal. Paid acquisition cannot pay for itself at that margin — ` +
        'raise the price, sell a bigger scope, or reach these buyers by phone instead.',
      providersNeeded: 0,
    };
  }

  if (demandEvidence === 0) {
    return {
      verdict: 'RUN',
      reason:
        `Fulfillment is ready (${readyProviders} confirmed providers) but there is no demand evidence here yet — which is exactly what advertising is for. ` +
        'Start small and treat the first month as buying information about whether demand exists, not as a growth channel.',
      providersNeeded: 0,
    };
  }

  return {
    verdict: 'RUN',
    reason:
      `${readyProviders} confirmed providers cover this territory and there are ${demandEvidence} pieces of demand evidence on file. ` +
      'Capacity and demand both exist — this is the case where paid acquisition earns its keep.',
    providersNeeded: 0,
  };
}

/**
 * What you can afford to pay for a lead.
 *
 * Worked backwards from gross profit rather than picked from an industry
 * benchmark: an acceptable cost per lead is entirely a function of your margin
 * and your close rate, and both are already known here.
 */
export function computeEconomics(input: {
  grossProfitPerDeal: number | null;
  leadToDealRate: number;
  monthlyDealCapacity: number;
  acquisitionShare: number;
}): { maxCostPerLead: number | null; suggestedMonthlyBudget: number | null; budgetReason: string } {
  const { grossProfitPerDeal, leadToDealRate, monthlyDealCapacity, acquisitionShare } = input;

  if (grossProfitPerDeal === null || grossProfitPerDeal <= 0) {
    return {
      maxCostPerLead: null,
      suggestedMonthlyBudget: null,
      budgetReason: 'No gross profit figure on file for this work, so there is no honest way to set a bid. Close one deal manually first, then the numbers here become real.',
    };
  }

  const maxCostPerLead = round(grossProfitPerDeal * leadToDealRate * acquisitionShare);
  const leadsNeeded = monthlyDealCapacity > 0 ? Math.ceil(monthlyDealCapacity / Math.max(leadToDealRate, 0.01)) : 0;
  const suggestedMonthlyBudget = leadsNeeded > 0 ? round(maxCostPerLead * leadsNeeded) : 0;

  return {
    maxCostPerLead,
    suggestedMonthlyBudget,
    budgetReason:
      `$${grossProfitPerDeal.toFixed(0)} gross profit per deal × ${(leadToDealRate * 100).toFixed(0)}% lead-to-deal rate ` +
      `× ${(acquisitionShare * 100).toFixed(0)}% of margin allowed for acquisition = $${maxCostPerLead.toFixed(0)} per lead. ` +
      `Current fulfillment absorbs about ${monthlyDealCapacity} deal(s) a month, needing roughly ${leadsNeeded} lead(s), ` +
      `so cap spend near $${suggestedMonthlyBudget.toFixed(0)}/month. Buying past your capacity buys refusals.`,
  };
}

/** Builds every recommendation from current coverage and demand data. */
export async function buildAdRecommendations(orgId: string): Promise<AdRecommendation[]> {
  const config = await getOrgConfig(orgId);
  const acquisitionShare = 0.3;
  const minimumProviders = 3;

  const [capabilities, territories, companies, needs, opportunities, signals] = await Promise.all([
    prisma.capability.findMany({ where: { orgId } }),
    prisma.territory.findMany({ where: { orgId } }),
    prisma.company.findMany({
      where: { orgId, companyRole: { in: ['SUBCONTRACTOR', 'SUPPLIER', 'DISTRIBUTOR', 'MANUFACTURER', 'HYBRID'] } },
      include: { subCapacity: true, supplyOffers: true, capabilities: { include: { capability: true } } },
    }),
    prisma.buyerNeed.findMany({ where: { orgId } }),
    prisma.opportunity.findMany({
      where: { orgId },
      include: { deal: true, parties: { include: { company: true } } },
    }),
    prisma.discoverySignal.findMany({ where: { orgId } }),
  ]);

  const places = territories.length > 0 ? territories.map((t) => t.name) : ['your service area'];
  const recommendations: AdRecommendation[] = [];

  for (const capability of capabilities) {
    for (const placeName of places) {
      const placeKey = placeName.toLowerCase();
      const capabilityKey = capability.name.toLowerCase();

      // --- Fulfillment coverage in this specific territory -----------------
      const covering = companies.filter((company) => {
        const hasCapability =
          company.capabilities.some((c) => c.capability.id === capability.id) ||
          company.subCapacity.some((c) => c.capabilities.some((k) => k.toLowerCase().includes(capabilityKey) || capabilityKey.includes(k.toLowerCase()))) ||
          company.supplyOffers.some((s) => s.description.toLowerCase().includes(capabilityKey));
        if (!hasCapability) return false;

        const territoryText = [...company.serviceTerritories, ...company.subCapacity.flatMap((c) => c.territories)]
          .join(' ')
          .toLowerCase();
        return territories.length === 0 || territoryText.includes(placeKey.split(',')[0].split(' ')[0]);
      });

      const ready = covering.filter((company) => {
        const capacity = company.subCapacity[0];
        const supply = company.supplyOffers[0];
        const confirmedCapability = company.capabilities.some((c) => c.capability.id === capability.id && c.status === 'CONFIRMED');
        const confirmedCapacity = capacity?.status === 'CONFIRMED' || supply?.status === 'CONFIRMED';
        const insured = Object.keys((capacity?.insuranceLimits ?? company.insurance ?? {}) as object).length > 0;
        return (confirmedCapability || confirmedCapacity) && insured;
      });
      const unverified = covering.length - ready.length;

      const gaps: string[] = [];
      for (const company of covering) {
        if (ready.includes(company)) continue;
        const capacity = company.subCapacity[0];
        if (!capacity && company.supplyOffers.length === 0) gaps.push(`${company.legalName}: no capacity on record`);
        else if (Object.keys((capacity?.insuranceLimits ?? company.insurance ?? {}) as object).length === 0) {
          gaps.push(`${company.legalName}: insurance not verified`);
        } else gaps.push(`${company.legalName}: capacity claimed but not confirmed`);
      }

      // --- Demand evidence in this territory -------------------------------
      const matchingNeeds = needs.filter(
        (n) =>
          (n.requiredCapabilities.some((c) => c.toLowerCase().includes(capabilityKey) || capabilityKey.includes(c.toLowerCase())) ||
            n.scope.toLowerCase().includes(capabilityKey)) &&
          (territories.length === 0 || (n.location ?? '').toLowerCase().includes(placeKey.split(',')[0].split(' ')[0])),
      );
      const matchingSignals = signals.filter(
        (s) =>
          s.detail.toLowerCase().includes(capabilityKey) &&
          (territories.length === 0 || (s.location ?? '').toLowerCase().includes(placeKey.split(',')[0].split(' ')[0])),
      );
      const wonHere = opportunities.filter(
        (o) =>
          o.status === 'WON' &&
          (o.name.toLowerCase().includes(capabilityKey) || o.summary.toLowerCase().includes(capabilityKey)),
      );

      const demandEvidence = matchingNeeds.length + matchingSignals.length + wonHere.length;

      // Skip combinations with neither demand nor any provider at all — there
      // is nothing to say about them, and listing every empty pair is noise.
      if (demandEvidence === 0 && covering.length === 0) continue;

      // --- Economics --------------------------------------------------------
      const wonProfits = wonHere.map((o) => num0(o.deal?.grossProfit ?? o.estimatedGrossProfit)).filter((v) => v > 0);
      const modelled = matchingNeeds.map((n) => num0(n.estimatedValue)).filter((v) => v > 0);
      let grossProfitPerDeal: number | null = null;
      let basis = '';

      if (wonProfits.length > 0) {
        grossProfitPerDeal = round(wonProfits.reduce((a, b) => a + b, 0) / wonProfits.length);
        basis = `Average of ${wonProfits.length} won deal(s) in this service.`;
      } else if (modelled.length > 0) {
        const averageValue = modelled.reduce((a, b) => a + b, 0) / modelled.length;
        grossProfitPerDeal = round((averageValue * config.marginRules.targetGrossMarginPct) / 100);
        basis = `Modelled: average recorded need value $${averageValue.toFixed(0)} at the ${config.marginRules.targetGrossMarginPct}% target margin. No won deals yet, so treat this as an estimate.`;
      } else {
        basis = 'No deal value on record for this service yet.';
      }

      // Conservative until real data exists: roughly a third of leads qualify,
      // roughly a third of those close.
      const leadToDealRate = wonHere.length > 0 ? 0.15 : 0.1;
      const monthlyDealCapacity = ready.length * 2;

      const economics = computeEconomics({ grossProfitPerDeal, leadToDealRate, monthlyDealCapacity, acquisitionShare });
      const { verdict, reason, providersNeeded } = decideVerdict({
        readyProviders: ready.length,
        unverifiedProviders: unverified,
        demandEvidence,
        grossProfitPerDeal,
        minimumProviders,
      });

      const platform = choosePlatform(capability.name);

      // --- What has to happen before money is spent ------------------------
      const prerequisites: Prerequisite[] = [];
      if (providersNeeded > 0) {
        prerequisites.push({
          action: `Call and confirm ${providersNeeded} more ${capability.name.toLowerCase()} provider(s) covering ${placeName}`,
          why: 'A lead you cannot fulfil costs the click and the relationship. Three confirmed providers means one can decline and you still deliver.',
          link: '/companies?movability=movable',
          done: false,
        });
      }
      for (const gap of gaps.slice(0, 3)) {
        prerequisites.push({
          action: `Resolve: ${gap}`,
          why: 'Unverified capacity is not capacity. Confirm it before it sits behind a paid campaign.',
          link: '/companies',
          done: false,
        });
      }
      if (grossProfitPerDeal === null) {
        prerequisites.push({
          action: 'Close one deal in this service manually',
          why: 'Without a real gross profit figure there is no honest way to set a bid — any budget would be a guess.',
          link: '/board',
          done: false,
        });
      }
      if (platform.secondary === 'GOOGLE_LOCAL_SERVICES') {
        prerequisites.push({
          action: 'Check Local Services Ads eligibility (licence and insurance verification)',
          why: 'Google verifies licensing and insurance before it will run these. Worth checking early — it takes days, not minutes.',
          done: false,
        });
      }
      if (verdict === 'RUN') {
        prerequisites.push({
          action: 'Set up call tracking and log every enquiry as an opportunity',
          why: 'Without it you cannot tell which keyword produced a deal, and the second month of spend is as blind as the first.',
          link: '/opportunities',
          done: false,
        });
      }

      const priority =
        (verdict === 'RUN' ? 100 : verdict === 'PREPARE_FIRST' ? 50 : 0) +
        Math.min(30, demandEvidence * 5) +
        Math.min(20, ready.length * 5) +
        (grossProfitPerDeal ? Math.min(30, grossProfitPerDeal / 500) : 0);

      recommendations.push({
        key: `${capability.key}:${placeName}`,
        service: capability.name,
        territory: placeName,
        opportunityType: inferType(capability.category),
        platform: platform.platform,
        platformReason: platform.reason,
        secondaryPlatform: platform.secondary,
        secondaryReason: platform.secondaryReason,
        verdict,
        verdictReason: reason,
        priority: round(priority, 1),
        demand: {
          buyerNeeds: matchingNeeds.length,
          signals: matchingSignals.length,
          wonDeals: wonHere.length,
          evidence: [
            ...matchingNeeds.slice(0, 3).map((n) => `Need: ${n.scope.slice(0, 110)}`),
            ...matchingSignals.slice(0, 2).map((s) => `Signal: ${s.headline}`),
            ...wonHere.slice(0, 2).map((o) => `Won: ${o.name}`),
          ],
        },
        fulfillment: {
          readyProviders: ready.length,
          unverifiedProviders: unverified,
          providersNeeded,
          gaps,
        },
        economics: {
          grossProfitPerDeal,
          basis,
          leadToDealRate,
          maxCostPerLead: economics.maxCostPerLead,
          monthlyDealCapacity,
          suggestedMonthlyBudget: economics.suggestedMonthlyBudget,
          budgetReason: economics.budgetReason,
        },
        prerequisites,
        keywords: platform.keywords(capability.name, placeName),
      });
    }
  }

  recommendations.sort((a, b) => b.priority - a.priority);
  return recommendations;
}

function inferType(category: string): OpportunityType {
  if (/material|supplies/i.test(category)) return 'DISTRIBUTION';
  if (/logistics/i.test(category)) return 'BROKERAGE';
  return 'SUBCONTRACTING';
}

export const PLATFORM_LABELS: Record<AdPlatform, string> = {
  GOOGLE_SEARCH: 'Google Search Ads',
  GOOGLE_LOCAL_SERVICES: 'Google Local Services Ads',
  META: 'Meta (Facebook / Instagram)',
  LINKEDIN: 'LinkedIn Ads',
  TRADE_PUBLICATION: 'Trade publications & associations',
  DIRECT_OUTREACH: 'Direct outreach (not paid ads)',
};

export { clamp01 };
