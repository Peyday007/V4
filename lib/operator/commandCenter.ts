import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { grossProfitOf } from '@/lib/evidence/economics';
import type { CompetitionResult } from '@/lib/demand/competition';

/**
 * The owner's landing page, organised by distance from money.
 *
 * The dashboard used to open with record counts and a plan of "priorities"
 * ranked by an expected value built on a closing probability nobody had set.
 * An owner reading it learned how much the system had done, which is the one
 * thing that does not matter — activity and progress are different, and a
 * product that leads with the first teaches its operator to confuse them.
 *
 * So the work is banded by how far it is from collected profit, nearest first.
 * The bands are not a score and not a ranking: they are a question each piece
 * of work is asked, and the answers are mutually exclusive by construction, so
 * one deal appears in exactly one band and the counts add up to the truth.
 *
 * The last band is the important one and the one no dashboard usually has:
 * events the engine looked at and could not make a case for. Without it, an
 * empty board is indistinguishable from a broken engine, and the honest answer
 * — "we read 40 records this week and none of them supported a deal" — is
 * invisible.
 */

export type BandKey =
  | 'money_ready'
  | 'fulfilment_at_risk'
  | 'decisions'
  | 'qualified'
  | 'contact_needed'
  | 'research_needed'
  | 'supply_needed'
  | 'market_development'
  | 'no_credible_thesis';

export type BandItem = {
  id: string;
  /** The organisation this concerns, or the campaign name. */
  subject: string;
  /** One line: what this is and why it is in this band. */
  line: string;
  /** Where to go to act on it. */
  href: string;
  /** Money, only where it survives the evidence rule. */
  amount: number | null;
  /** How long it has been sitting here. */
  ageDays: number | null;
};

export type Band = {
  key: BandKey;
  label: string;
  /** Why this band is where it is in the order. */
  meaning: string;
  /** The single thing an owner does with this band. */
  whatToDo: string;
  count: number;
  items: BandItem[];
  /** Money attached to the band, where it is defensible. Null where it is not. */
  money: number | null;
};

export type CommandCentre = {
  bands: Band[];
  /** The sentence at the top. Never a count of records. */
  headline: string;
  /** True when nothing anywhere needs an owner. */
  quiet: boolean;
};

const DAY = 86_400_000;
const daysSince = (from: Date | null | undefined, now: Date) =>
  from ? Math.max(0, Math.floor((now.getTime() - from.getTime()) / DAY)) : null;

export async function commandCentre(params: {
  orgId: string;
  dataMode?: 'PRODUCTION' | 'TEST';
  now?: Date;
  limitPerBand?: number;
}): Promise<CommandCentre> {
  const dataMode = params.dataMode ?? 'PRODUCTION';
  const now = params.now ?? new Date();
  const take = params.limitPerBand ?? 8;
  const where = { orgId: params.orgId, dataMode };

  const [deals, approvals, routes, campaigns, refusedEvents] = await Promise.all([
    prisma.routeDeal.findMany({
      where,
      select: {
        id: true, stage: true, routeId: true,
        deliveryCompletedAt: true, deliveryStartedAt: true, buyerCommittedAt: true,
        contractedValue: true, contractedCost: true,
        providerCandidateId: true, providerCommittedAt: true,
        payments: { select: { direction: true, settledAt: true, amount: true } },
        route: { select: { headline: true, company: { select: { legalName: true } } } },
      },
    }),
    prisma.approval.findMany({
      where: { orgId: params.orgId, status: 'PENDING' },
      select: {
        id: true, summary: true, createdAt: true, amount: true,
        route: { select: { id: true, company: { select: { legalName: true } } } },
      },
      take: 40,
    }),
    prisma.routeHypothesis.findMany({
      where: { ...where, status: { notIn: ['EXPIRED', 'REJECTED'] } },
      select: {
        id: true, headline: true, providerCount: true, fulfilmentStatus: true,
        createdAt: true, requiredCapability: true,
        company: { select: { legalName: true, phone: true, contacts: { select: { phone: true }, take: 1 } } },
        requirements: { where: { state: 'CURRENT' }, select: { confirmedFields: true }, take: 1 },
        quotes: { where: { state: { in: ['DRAFT', 'SENT', 'ACCEPTED'] } }, select: { id: true }, take: 1 },
      },
      take: 400,
    }),
    prisma.campaign.findMany({
      where: { orgId: params.orgId, dataMode, state: { in: ['RUNNING', 'EXPANDED'] } },
      select: { id: true, name: true, startedAt: true, thesis: true },
    }),
    // The band nobody builds. Events the engine read and could not make a case
    // for, so an empty board can be told apart from a broken engine.
    prisma.demandEvent.findMany({
      where: { ...where, competition: { not: Prisma.DbNull }, routes: { none: {} } },
      select: { id: true, headline: true, competition: true, discoveredAt: true },
      orderBy: { discoveredAt: 'desc' },
      take: 40,
    }),
  ]);

  // --- 1. money ready to collect ------------------------------------------
  // Work that is done and unpaid. Nothing in this product is closer to money.
  const readyToCollect = deals.filter(
    (d) => d.deliveryCompletedAt !== null && !d.payments.some((p) => p.direction === 'INBOUND' && p.settledAt),
  );

  // --- 2. fulfilment at risk ----------------------------------------------
  // Committed to a buyer without a committed provider. The most expensive
  // state in the business, and the one that is invisible until it is a crisis.
  const atRisk = deals.filter(
    (d) => d.deliveryCompletedAt === null && d.stage !== 'CANCELLED' && d.providerCommittedAt === null,
  );

  // --- 4-7. routes, banded by what is missing ------------------------------
  // Checked in dependency order and assigned once, so a route with no provider
  // and no contact appears under contact — the earlier blocker — rather than
  // twice.
  const quoted = new Set(routes.filter((r) => r.quotes.length > 0).map((r) => r.id));
  const banded = { qualified: [] as typeof routes, contact: [] as typeof routes, research: [] as typeof routes, supply: [] as typeof routes };

  for (const route of routes) {
    if (quoted.has(route.id)) continue; // it is a deal or a decision, not a route band
    const reachable = Boolean(route.company.phone || route.company.contacts[0]?.phone);
    const confirmed = Array.isArray(route.requirements[0]?.confirmedFields)
      && (route.requirements[0]!.confirmedFields as string[]).length > 0;

    if (!reachable) banded.contact.push(route);
    else if (!confirmed) banded.research.push(route);
    else if (route.providerCount === 0) banded.supply.push(route);
    else banded.qualified.push(route);
  }

  const bands: Band[] = [
    {
      key: 'money_ready',
      label: 'Money ready to collect',
      meaning: 'Delivered and unpaid. Nothing is closer to money than work already done.',
      whatToDo: 'Invoice it, or chase the invoice.',
      count: readyToCollect.length,
      money: sumDefensible(readyToCollect),
      items: readyToCollect.slice(0, take).map((d) => ({
        id: d.id,
        subject: d.route?.company.legalName ?? 'unknown account',
        line: `Delivered ${d.deliveryCompletedAt?.toISOString().slice(0, 10)} and no inbound payment has settled.`,
        href: `/demand/opportunity/${d.routeId}`,
        amount: defensibleGp(d),
        ageDays: daysSince(d.deliveryCompletedAt, now),
      })),
    },
    {
      key: 'fulfilment_at_risk',
      label: 'Fulfilment at risk',
      meaning: 'Committed to a buyer with nobody committed to deliver it. The most expensive state there is.',
      whatToDo: 'Get a provider committed, or tell the buyer before they find out.',
      count: atRisk.length,
      money: null,
      items: atRisk.slice(0, take).map((d) => ({
        id: d.id,
        subject: d.route?.company.legalName ?? 'unknown account',
        line: 'A buyer is committed and no provider is. If this is not closed, it becomes a failure to deliver.',
        href: `/demand/opportunity/${d.routeId}`,
        amount: null,
        ageDays: daysSince(d.buyerCommittedAt, now),
      })),
    },
    {
      key: 'decisions',
      label: 'Waiting on your decision',
      meaning: 'The system has stopped deliberately, because these commit money or leave the building.',
      whatToDo: 'Decide. Nothing behind these moves until you do.',
      count: approvals.length,
      money: null,
      items: approvals.slice(0, take).map((a) => ({
        id: a.id,
        subject: a.route?.company.legalName ?? 'this account',
        line: a.summary,
        href: '/approvals',
        amount: a.amount === null ? null : Number(a.amount),
        ageDays: daysSince(a.createdAt, now),
      })),
    },
    {
      key: 'qualified',
      label: 'Qualified and ready to quote',
      meaning: 'A confirmed requirement, a reachable buyer and somebody who could deliver. Everything is present.',
      whatToDo: 'Price it and send it.',
      count: banded.qualified.length,
      money: null,
      items: banded.qualified.slice(0, take).map((r) => routeItem(r, now, 'Nothing is missing. This can be quoted.')),
    },
    {
      key: 'contact_needed',
      label: 'Nobody to ring',
      meaning: 'A live opportunity with no published number and no contact resolved. It cannot start.',
      whatToDo: 'Let the resolver run, and only send a person after it has failed.',
      count: banded.contact.length,
      money: null,
      items: banded.contact.slice(0, take).map((r) => routeItem(r, now, 'No published number and no resolved contact.')),
    },
    {
      key: 'research_needed',
      label: 'Nothing confirmed yet',
      meaning: 'Reachable, but everything about the requirement is still our reading rather than theirs.',
      whatToDo: 'One call with the playbook questions turns this into a qualified opportunity or kills it.',
      count: banded.research.length,
      money: null,
      items: banded.research.slice(0, take).map((r) => routeItem(r, now, 'Reachable, with nothing confirmed by the buyer.')),
    },
    {
      key: 'supply_needed',
      label: 'No one to deliver it',
      meaning: 'A confirmed requirement with no provider who holds the capability. Half a deal.',
      whatToDo: 'Source or recruit a provider. Until then this cannot be quoted however well the call went.',
      count: banded.supply.length,
      money: null,
      items: banded.supply.slice(0, take).map((r) =>
        routeItem(r, now, `Nobody in the catalogue holds ${r.requiredCapability ?? 'the capability'}.`)),
    },
    {
      key: 'market_development',
      label: 'Markets being developed',
      meaning: 'Deliberate spend on finding out whether a market exists. Not demand, and never shown as it.',
      whatToDo: 'Check what came back, and kill the ones that have not earned their next week.',
      count: campaigns.length,
      money: null,
      items: campaigns.slice(0, take).map((c) => ({
        id: c.id,
        subject: c.name,
        line: c.thesis.slice(0, 140),
        href: `/campaigns/${c.id}`,
        amount: null,
        ageDays: daysSince(c.startedAt, now),
      })),
    },
    {
      key: 'no_credible_thesis',
      label: 'Read, and no case made',
      meaning:
        'Events the engine examined and could not build a commercial case from. This band is why an empty board '
        + 'is not the same as a broken engine.',
      whatToDo: 'Nothing, usually. Read it when the board is emptier than expected.',
      count: refusedEvents.length,
      money: null,
      items: refusedEvents.slice(0, take).map((e) => {
        const competition = e.competition as unknown as CompetitionResult | null;
        return {
          id: e.id,
          subject: e.headline,
          line: competition?.verdict ?? 'No competition was recorded for this event.',
          href: '/demand',
          amount: null,
          ageDays: daysSince(e.discoveredAt, now),
        };
      }),
    },
  ];

  const collectable = bands[0];
  const risk = bands[1];
  const decisions = bands[2];

  const headline =
    collectable.count > 0
      ? `${collectable.count} piece(s) of delivered work are unpaid. That is the nearest money in the business.`
      : risk.count > 0
        ? `${risk.count} committed deal(s) have no provider committed to deliver them. Close that before anything else.`
        : decisions.count > 0
          ? `${decisions.count} decision(s) are waiting on you, and nothing behind them moves until you make them.`
          : bands[3].count > 0
            ? `${bands[3].count} opportunit(y/ies) have everything needed to be quoted.`
            : bands.slice(4, 7).some((b) => b.count > 0)
              ? 'Nothing is ready to quote. The work in front of you is establishing what these buyers actually need.'
              : 'Nothing is waiting on you. If that is a surprise, the last band says what the engine read and rejected.';

  return {
    bands,
    headline,
    quiet: bands.slice(0, 4).every((b) => b.count === 0),
  };
}

function routeItem(
  route: { id: string; headline: string; createdAt: Date; company: { legalName: string } },
  now: Date,
  line: string,
): BandItem {
  return {
    id: route.id,
    subject: route.company.legalName,
    line,
    href: `/demand/opportunity/${route.id}`,
    amount: null,
    ageDays: daysSince(route.createdAt, now),
  };
}

/**
 * Gross profit on a deal, only where both sides are real.
 *
 * A contracted value with no contracted cost is a price, not a margin, and
 * summing those into a headline is how a pipeline figure becomes a number
 * somebody repeats out loud as though it were profit.
 */
function defensibleGp(deal: { contractedValue: unknown; contractedCost: unknown }): number | null {
  if (deal.contractedValue === null || deal.contractedCost === null) return null;
  const graded = grossProfitOf({
    basis: 'COMMITMENT',
    buyerPrice: Number(deal.contractedValue),
    providerCost: Number(deal.contractedCost),
    costSideMissing: false,
  });
  return graded.value;
}

function sumDefensible(deals: Array<{ contractedValue: unknown; contractedCost: unknown }>): number | null {
  const values = deals.map(defensibleGp).filter((v): v is number => v !== null);
  return values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0);
}
