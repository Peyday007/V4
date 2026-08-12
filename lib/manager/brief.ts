import type { BriefPeriod, ManagerBrief } from '@prisma/client';
import { prisma } from '@/lib/db';
import { chainHealth } from '@/lib/health/chain';
import { callerScorecards } from '@/lib/measure/analytics';
import { findStrengths } from './strengths';
import { openBreakers } from './breakers';
import { CAPABILITY_LABELS, PRODUCED_BY, RULE_VERSION, RUNG_LABELS } from './rules';

/**
 * The brief an owner reads instead of eleven screens.
 *
 * Ordered by what it costs to be wrong about, not by what is easiest to count.
 * The first broken stage comes first because everything downstream of it is a
 * consequence; the owner's own decisions come second because nobody else can
 * make them and they are the things that stall silently; the numbers come last,
 * with what could not be concluded stated explicitly rather than left as an
 * empty section that reads like a zero.
 *
 * "Manager by exception" means this is mostly short. A brief that lists
 * everything that happened is a log, and a log is what nobody reads.
 */

export type BriefSection = {
  key: string;
  title: string;
  /** The one line. */
  headline: string;
  items: Array<{ what: string; detail?: string; href?: string }>;
};

export type OwnerDecision = {
  what: string;
  why: string;
  href?: string;
  /** How long it has been sitting there. */
  waitingSince?: string;
};

export type BriefContent = {
  headline: string;
  sections: BriefSection[];
  ownerDecisions: OwnerDecision[];
  strengths: Array<{ what: string; evidence: string; suggestion: string; callerName: string }>;
  withheld: string[];
};

export async function buildBrief(params: {
  orgId: string;
  period: BriefPeriod;
  now?: Date;
}): Promise<BriefContent> {
  const now = params.now ?? new Date();
  const days = params.period === 'WEEKLY' ? 7 : 1;
  const since = new Date(now.getTime() - days * 86_400_000);

  const [chain, breakers, cases, proposals, incidents, approvals, scorecards, restrictions] =
    await Promise.all([
      chainHealth(params.orgId),
      openBreakers(params.orgId),
      prisma.consistencyCase.findMany({
        where: { orgId: params.orgId, state: 'OPEN', createdAt: { gte: since } },
        select: { id: true, kind: true, observed: true, callerId: true, caller: { select: { name: true } } },
        take: 25,
      }),
      prisma.intervention.findMany({
        where: { orgId: params.orgId, state: 'PROPOSED' },
        select: {
          id: true, rung: true, capability: true, reason: true, createdAt: true,
          caller: { select: { name: true } },
        },
        orderBy: { createdAt: 'asc' },
        take: 25,
      }),
      prisma.workIncident.findMany({
        where: { orgId: params.orgId, status: 'OPEN' },
        select: { id: true, kind: true, detail: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
        take: 10,
      }),
      prisma.approval.findMany({
        where: { orgId: params.orgId, status: 'PENDING' },
        select: { id: true, type: true, summary: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
        take: 25,
      }),
      callerScorecards({ orgId: params.orgId, since, until: now }),
      prisma.intervention.findMany({
        where: { orgId: params.orgId, state: 'ACTIVE', shadow: false, capability: { not: null } },
        select: { id: true, rung: true, capability: true, restorationRule: true, caller: { select: { name: true } } },
      }),
    ]);

  const sections: BriefSection[] = [];
  const withheld: string[] = [];

  // --- 1. where the chain is broken --------------------------------------
  const firstBreak = chain.firstBreak ?? chain.supplyBreak;
  const moneyBreak = chain.stages.find((s) => s.track === 'money' && s.status === 'BLOCKED') ?? null;
  sections.push({
    key: 'chain',
    title: 'First broken stage',
    headline: firstBreak
      ? `${firstBreak.label}: ${firstBreak.detail}`
      : moneyBreak
        ? `${moneyBreak.label}: ${moneyBreak.detail}`
        : chain.flowing
          ? 'Work is passing through every stage and money has arrived.'
          : 'No stage is blocked. Nothing has yet reached a settled payment, so the chain is not flowing end to end.',
    items: chain.stages
      .filter((s) => s.status === 'BLOCKED' || s.status === 'DEGRADED')
      .map((s) => ({ what: `${s.label} — ${s.status.toLowerCase()}`, detail: s.remedy ?? s.detail, href: s.href ?? undefined })),
  });

  // --- 2. what is stopped -------------------------------------------------
  sections.push({
    key: 'stopped',
    title: 'Capabilities stopped',
    headline: breakers.length === 0
      ? 'Nothing is stopped.'
      : `${breakers.length} capabilit${breakers.length === 1 ? 'y is' : 'ies are'} stopped automatically.`,
    items: breakers.map((b) => ({
      what: CAPABILITY_LABELS[b.capability],
      detail: b.openedBecause ?? undefined,
    })),
  });

  // --- 3. incidents -------------------------------------------------------
  sections.push({
    key: 'incidents',
    title: 'Ours to fix',
    headline: incidents.length === 0
      ? 'No open incidents.'
      : `${incidents.length} open incident(s), oldest ${ago(incidents[0].createdAt, now)}.`,
    items: incidents.map((i) => ({
      what: i.kind.toLowerCase().replace(/_/g, ' '),
      detail: i.detail.slice(0, 200),
    })),
  });

  // --- 4. questions waiting on people ------------------------------------
  sections.push({
    key: 'cases',
    title: 'Open questions',
    headline: cases.length === 0
      ? 'No open evidence questions.'
      : `${cases.length} question(s) about records that do not line up. None of these is a finding yet.`,
    items: cases.slice(0, 10).map((c) => ({
      what: `${c.kind.toLowerCase().replace(/_/g, ' ')}${c.caller ? ` — ${c.caller.name}` : ''}`,
      detail: c.observed,
      href: '/manager',
    })),
  });

  // --- 5. restrictions in force ------------------------------------------
  sections.push({
    key: 'restrictions',
    title: 'Restrictions in force',
    headline: restrictions.length === 0
      ? 'Nobody is restricted.'
      : `${restrictions.length} restriction(s) in force. Each one has its own way out.`,
    items: restrictions.map((r) => ({
      what: `${r.caller?.name ?? 'somebody'} — ${r.capability ? CAPABILITY_LABELS[r.capability] : 'a capability'}`,
      detail: r.restorationRule ?? undefined,
      href: '/manager',
    })),
  });

  // --- owner decisions ----------------------------------------------------
  const ownerDecisions: OwnerDecision[] = [
    ...approvals.map((a) => ({
      what: `Approval: ${a.type.toLowerCase().replace(/_/g, ' ')}`,
      why: a.summary,
      href: '/approvals',
      waitingSince: ago(a.createdAt, now),
    })),
    ...proposals.map((p) => ({
      what: `${RUNG_LABELS[p.rung]}${p.caller ? ` for ${p.caller.name}` : ''}`,
      why: `${p.reason} It is doing nothing until you decide.`,
      href: '/manager',
      waitingSince: ago(p.createdAt, now),
    })),
  ];

  // --- strengths ----------------------------------------------------------
  const found = findStrengths(scorecards);
  withheld.push(...found.withheld);

  const weakCallers = scorecards.filter((s) => s.insufficientEvidence);
  if (weakCallers.length > 0 && weakCallers.length === scorecards.length) {
    withheld.push(
      `No caller comparison at all this period: every caller's sample is below the floor. ${weakCallers[0].insufficientEvidence}`,
    );
  }

  const moneyStage = chain.stages.find((s) => s.key === 'payment');
  if (moneyStage && moneyStage.status !== 'OK') {
    withheld.push(
      'No source, route or caller is credited with profit in this brief, because no payment has settled. Anything else would be an estimate wearing the word "collected".',
    );
  }

  return {
    headline: briefHeadline({ chain: firstBreak?.label ?? moneyBreak?.label ?? null, breakers: breakers.length, decisions: ownerDecisions.length, cases: cases.length }),
    sections,
    ownerDecisions,
    strengths: found.strengths.map((s) => ({
      what: s.what, evidence: s.evidence, suggestion: s.suggestion, callerName: s.callerName,
    })),
    withheld,
  };
}

function briefHeadline(input: {
  chain: string | null;
  breakers: number;
  decisions: number;
  cases: number;
}): string {
  if (input.breakers > 0) {
    return `${input.breakers} capabilit${input.breakers === 1 ? 'y is' : 'ies are'} stopped. Start there.`;
  }
  if (input.chain) return `The chain stops at: ${input.chain}.`;
  if (input.decisions > 0) {
    return `${input.decisions} thing(s) waiting on your authority. Nothing else is blocked.`;
  }
  if (input.cases > 0) return `${input.cases} open question(s) about records. Nothing is blocked.`;
  return 'Nothing needs you.';
}

/**
 * Generate and store one brief.
 *
 * Unique on `(orgId, period, periodStart)`, so the daily job running twice
 * refreshes the brief rather than producing a second one with different numbers
 * next to it.
 */
export async function generateBrief(params: {
  orgId: string;
  period: BriefPeriod;
  now?: Date;
}): Promise<ManagerBrief> {
  const now = params.now ?? new Date();
  const days = params.period === 'WEEKLY' ? 7 : 1;
  const periodEnd = now;
  const periodStart = startOf(params.period, now);

  const content = await buildBrief({ orgId: params.orgId, period: params.period, now });

  return prisma.managerBrief.upsert({
    where: {
      orgId_period_periodStart: { orgId: params.orgId, period: params.period, periodStart },
    },
    create: {
      orgId: params.orgId,
      period: params.period,
      periodStart,
      periodEnd: periodEnd > periodStart ? periodEnd : new Date(periodStart.getTime() + days * 86_400_000),
      headline: content.headline,
      sections: content.sections as object,
      ownerDecisions: content.ownerDecisions as object,
      strengths: content.strengths as object,
      withheld: content.withheld as object,
      producedBy: PRODUCED_BY,
      ruleVersion: RULE_VERSION,
      generatedAt: now,
    },
    update: {
      periodEnd: periodEnd > periodStart ? periodEnd : new Date(periodStart.getTime() + days * 86_400_000),
      headline: content.headline,
      sections: content.sections as object,
      ownerDecisions: content.ownerDecisions as object,
      strengths: content.strengths as object,
      withheld: content.withheld as object,
      generatedAt: now,
    },
  });
}

/** Midnight UTC of the day, or of the week's Monday. */
function startOf(period: BriefPeriod, now: Date): Date {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === 'DAILY') return day;
  const weekday = day.getUTCDay();
  const backToMonday = (weekday + 6) % 7;
  return new Date(day.getTime() - backToMonday * 86_400_000);
}

function ago(date: Date, now: Date): string {
  const ms = now.getTime() - date.getTime();
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}
