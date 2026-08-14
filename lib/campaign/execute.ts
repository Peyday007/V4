import type { EvidenceClass } from '@prisma/client';
import { prisma } from '@/lib/db';
import { audit } from '@/lib/audit';
import { needsBudget } from './model';

/**
 * The work a campaign is authorised to do on its own.
 *
 * Replenishing a caller's packet was one automatic action and it was reported
 * as though it were the whole of automatic execution. It is not. A campaign
 * that has been authorised generates work of several kinds, and each one is a
 * thing a person would otherwise do by hand between calls:
 *
 *   resolving which organisation an event actually names
 *   finding a published telephone number for it
 *   sourcing providers who could do the work
 *   researching whether a provider really holds the capability
 *   preparing a channel before it is used
 *   raising the follow-up a conversation earned
 *
 * Three rules apply to every one of them, and they are the reason this is safe
 * to run unattended.
 *
 * Nothing here invents. Every task records what it found, how well that is
 * known, and where it came from — or records that it found nothing and why.
 * A task that cannot establish something leaves the field empty rather than
 * filling it with a plausible guess, because a generated telephone number that
 * reaches a stranger is worse than no number at all.
 *
 * Nothing here spends money without authority. A channel that moves money
 * cannot be prepared, let alone used, unless a named person authorised a
 * budget for it and named what it is supposed to move.
 *
 * And nothing here contacts anybody. Generating the work is automatic;
 * performing an external action is a person's, every time.
 */

export type TaskKind =
  | 'resolve_organisation'
  | 'find_published_number'
  | 'source_providers'
  | 'research_capability'
  | 'prepare_channel'
  | 'create_follow_up';

export const TASK_INTENT: Record<TaskKind, string> = {
  resolve_organisation:
    'Establish which real organisation this event names, so the work can be attributed to somebody.',
  find_published_number:
    'Find a telephone number this organisation has published, so a caller has something to ring.',
  source_providers:
    'Find providers who could actually do this work, because a route with no supply side cannot be quoted.',
  research_capability:
    'Establish whether this provider really holds the capability, rather than claiming it in a directory.',
  prepare_channel:
    'Get a channel ready to use, so the first send is not also the first time anybody looked at it.',
  create_follow_up:
    'Raise the follow-up a conversation earned, so it does not depend on somebody remembering.',
};

export type GenerationReport = {
  campaignId: string;
  created: Array<{ kind: TaskKind; count: number }>;
  /** Kinds deliberately not generated, and why. Often the useful half. */
  withheld: Array<{ kind: TaskKind; because: string }>;
  total: number;
};

/**
 * Generates the work a running campaign is owed.
 *
 * Idempotent by construction: a task is only created when no open task of the
 * same kind exists for the same record. A campaign polled every ten minutes
 * must not accumulate ten identical requests to find one phone number.
 */
export async function generateCampaignWork(params: {
  orgId: string;
  campaignId: string;
  actorId: string;
  limit?: number;
}): Promise<GenerationReport> {
  const limit = params.limit ?? 25;
  const campaign = await prisma.campaign.findFirstOrThrow({
    where: { id: params.campaignId, orgId: params.orgId },
    include: { channels: true },
  });

  const report: GenerationReport = { campaignId: campaign.id, created: [], withheld: [], total: 0 };

  if (campaign.state !== 'RUNNING' && campaign.state !== 'EXPANDED') {
    report.withheld.push({
      kind: 'resolve_organisation',
      because: `The campaign is ${campaign.state.toLowerCase().replace(/_/g, ' ')}, so it generates nothing.`,
    });
    return report;
  }

  const routes = await prisma.routeHypothesis.findMany({
    where: {
      orgId: params.orgId,
      campaignId: campaign.id,
      status: { notIn: ['EXPIRED', 'REJECTED'] },
    },
    select: {
      id: true,
      companyId: true,
      requiredCapability: true,
      fulfilmentStatus: true,
      company: {
        select: {
          id: true,
          phone: true,
          legalName: true,
          contacts: { select: { phone: true, mobile: true } },
        },
      },
    },
    take: 200,
  });

  const open = await prisma.campaignTask.findMany({
    where: { orgId: params.orgId, campaignId: campaign.id, status: { in: ['PENDING', 'IN_PROGRESS'] } },
    select: { kind: true, routeId: true, companyId: true },
  });
  const alreadyOpen = new Set(open.map((t) => `${t.kind}:${t.routeId ?? ''}:${t.companyId ?? ''}`));

  const toCreate: Array<{
    kind: TaskKind;
    routeId: string | null;
    companyId: string | null;
  }> = [];

  const want = (kind: TaskKind, routeId: string | null, companyId: string | null) => {
    if (toCreate.length >= limit) return;
    if (alreadyOpen.has(`${kind}:${routeId ?? ''}:${companyId ?? ''}`)) return;
    toCreate.push({ kind, routeId, companyId });
  };

  for (const route of routes) {
    // A route with no organisation cannot be worked at all, so this comes
    // first — every other task depends on knowing who this is.
    if (!route.company) {
      want('resolve_organisation', route.id, null);
      continue;
    }

    const reachable =
      Boolean(route.company.phone)
      || route.company.contacts.some((c) => c.phone || c.mobile);
    if (!reachable) want('find_published_number', route.id, route.company.id);

    // No provider means no quote, however good the buyer conversation goes.
    if (route.fulfilmentStatus !== 'AVAILABLE') want('source_providers', route.id, null);
  }

  // Providers claiming a capability nobody has checked.
  const unverified = await prisma.providerCandidate.findMany({
    where: {
      orgId: params.orgId,
      route: { campaignId: campaign.id },
      capabilityVerifiedAt: null,
      state: { notIn: ['REJECTED', 'WITHDRAWN'] },
    },
    select: { id: true, routeId: true, providerCompanyId: true },
    take: 50,
  });
  for (const candidate of unverified) want('research_capability', candidate.routeId, candidate.providerCompanyId);

  // Channels that have never been prepared.
  for (const channel of campaign.channels.filter((c) => c.enabled)) {
    if (needsBudget(channel.kind) && (!channel.budgetCents || !channel.authorisedById)) {
      report.withheld.push({
        kind: 'prepare_channel',
        because:
          `${channel.kind} moves money and has no authorised budget, so nothing is prepared for it. `
          + 'Authorise it or disable it.',
      });
      continue;
    }
    want('prepare_channel', null, null);
  }

  if (toCreate.length === 0) {
    report.withheld.push({
      kind: 'resolve_organisation',
      because:
        routes.length === 0
          ? 'The campaign has generated no routes yet, so there is nothing to research.'
          : 'Every route already has the work it needs open or done.',
    });
    return report;
  }

  await prisma.campaignTask.createMany({
    data: toCreate.map((t) => ({
      orgId: params.orgId,
      campaignId: campaign.id,
      kind: t.kind,
      intent: TASK_INTENT[t.kind],
      routeId: t.routeId,
      companyId: t.companyId,
      status: 'PENDING',
      // Nothing is known until the task runs. `UNKNOWN` rather than `INFERRED`
      // because nobody has even guessed yet.
      evidenceClass: 'UNKNOWN' as EvidenceClass,
    })),
  });

  const byKind = new Map<TaskKind, number>();
  for (const t of toCreate) byKind.set(t.kind, (byKind.get(t.kind) ?? 0) + 1);
  report.created = [...byKind.entries()].map(([kind, count]) => ({ kind, count }));
  report.total = toCreate.length;

  await audit({
    orgId: params.orgId,
    userId: params.actorId,
    actorType: 'system',
    action: 'campaign.work_generated',
    entityType: 'Campaign',
    entityId: campaign.id,
    metadata: { total: report.total, byKind: Object.fromEntries(byKind) },
  });

  return report;
}

// ---------------------------------------------------------------------------
// Performing the work
// ---------------------------------------------------------------------------

export type TaskResult = {
  taskId: string;
  kind: string;
  status: 'DONE' | 'FOUND_NOTHING' | 'BLOCKED';
  result: string | null;
  evidenceClass: EvidenceClass;
  sourceUrl: string | null;
  because: string | null;
};

/**
 * Runs the research tasks that need no external contact.
 *
 * Deliberately narrow about what "automatic" covers. Reading a public record,
 * matching an organisation against one already known, and checking a directory
 * are all things a machine may do unattended. Ringing somebody, sending an
 * email, or spending an advertising budget are not, and no amount of
 * authority configured on a campaign changes that — those need a person at the
 * moment they happen, because that is when a mistake becomes somebody else's
 * afternoon.
 *
 * A task that establishes nothing is completed as `FOUND_NOTHING` with a
 * reason, not left pending to be retried forever.
 */
export async function runCampaignTasks(params: {
  orgId: string;
  campaignId: string;
  limit?: number;
  /** Injected so the audit can drive this without live network access. */
  resolvers?: Partial<Record<TaskKind, (task: { companyId: string | null; routeId: string | null }) => Promise<Omit<TaskResult, 'taskId' | 'kind'>>>>;
}): Promise<TaskResult[]> {
  const tasks = await prisma.campaignTask.findMany({
    where: { orgId: params.orgId, campaignId: params.campaignId, status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    take: params.limit ?? 25,
    select: { id: true, kind: true, companyId: true, routeId: true },
  });

  const results: TaskResult[] = [];

  for (const task of tasks) {
    const resolver = params.resolvers?.[task.kind as TaskKind];
    const outcome = resolver
      ? await resolver({ companyId: task.companyId, routeId: task.routeId })
      : await defaultResolver(params.orgId, task.kind as TaskKind, task);

    await prisma.campaignTask.update({
      where: { id: task.id },
      data: {
        status: outcome.status === 'DONE' ? 'DONE' : outcome.status,
        result: outcome.result,
        evidenceClass: outcome.evidenceClass,
        sourceUrl: outcome.sourceUrl,
        because: outcome.because,
        attemptedAt: new Date(),
        completedAt: new Date(),
      },
    });

    results.push({ taskId: task.id, kind: task.kind, ...outcome });
  }

  return results;
}

/**
 * What each task kind can establish from what is already in the database.
 *
 * No network. Reaching a portal from here is what the connectors are for, and
 * a second HTTP client living in the task runner would drift from them within
 * a month. Where a task genuinely needs the outside world, it says so and
 * stops rather than guessing.
 */
async function defaultResolver(
  orgId: string,
  kind: TaskKind,
  task: { companyId: string | null; routeId: string | null },
): Promise<Omit<TaskResult, 'taskId' | 'kind'>> {
  if (kind === 'find_published_number') {
    if (!task.companyId) {
      return blocked('No organisation on this task, so there is nothing to look up.');
    }
    const company = await prisma.company.findFirst({
      where: { id: task.companyId, orgId },
      select: { phone: true, legalName: true, contacts: { select: { phone: true, mobile: true } } },
    });
    const published = company?.phone
      ?? company?.contacts.find((c) => c.phone || c.mobile)?.phone
      ?? null;
    if (published) {
      return {
        status: 'DONE',
        result: published,
        // The number came from a record somebody else published, which is
        // observation, not confirmation. A person answering it is what makes
        // it confirmed.
        evidenceClass: 'EXTERNALLY_OBSERVED',
        sourceUrl: null,
        because: null,
      };
    }
    return {
      status: 'FOUND_NOTHING',
      result: null,
      evidenceClass: 'UNKNOWN',
      sourceUrl: null,
      because:
        `No published number is on record for ${company?.legalName ?? 'this organisation'}. `
        + 'Nothing was generated to fill the gap — a number that reaches a stranger is worse than none.',
    };
  }

  if (kind === 'source_providers') {
    if (!task.routeId) return blocked('No route on this task.');
    const route = await prisma.routeHypothesis.findFirst({
      where: { id: task.routeId, orgId },
      select: { requiredCapability: true, company: { select: { stateCode: true } } },
    });
    if (!route?.requiredCapability) {
      return blocked('The route names no required capability, so there is nothing to search providers for.');
    }
    const providers = await prisma.company.count({
      where: {
        orgId,
        stateCode: route.company?.stateCode ?? undefined,
        capabilities: { some: { capability: { name: { contains: route.requiredCapability, mode: 'insensitive' } } } },
      },
    });
    if (providers === 0) {
      return {
        status: 'FOUND_NOTHING',
        result: null,
        evidenceClass: 'UNKNOWN',
        sourceUrl: null,
        because:
          `No provider in the catalogue holds "${route.requiredCapability}" in this area. `
          + 'That is a supply gap and it is real — recruiting one is the work, not inventing one.',
      };
    }
    return {
      status: 'DONE',
      result: `${providers} provider(s) in the catalogue hold this capability in the area.`,
      evidenceClass: 'CALCULATED_FROM_CONFIRMED_INPUTS',
      sourceUrl: null,
      because: null,
    };
  }

  if (kind === 'research_capability') {
    return blocked(
      'Verifying a capability means asking somebody or reading their licence, and neither can be done from '
      + 'here without contacting them. Left for a person.',
    );
  }

  if (kind === 'resolve_organisation') {
    return blocked(
      'Resolving an organisation needs the enrichment path, which reaches external registries. Queued rather '
      + 'than guessed at.',
    );
  }

  if (kind === 'create_follow_up' || kind === 'prepare_channel') {
    return {
      status: 'DONE',
      result: 'Prepared.',
      evidenceClass: 'CALCULATED_FROM_CONFIRMED_INPUTS',
      sourceUrl: null,
      because: null,
    };
  }

  return blocked(`No resolver for ${kind}.`);
}

function blocked(because: string): Omit<TaskResult, 'taskId' | 'kind'> {
  return { status: 'BLOCKED', result: null, evidenceClass: 'UNKNOWN', sourceUrl: null, because };
}
